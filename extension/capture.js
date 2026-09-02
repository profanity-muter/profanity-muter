// capture.js - MAIN world, document_start.
// Intercepts YouTube's MSE audio SourceBuffer appends (see
// ../spike-capture/SPIKE_NOTES.md) and forwards raw bytes + timing metadata
// to content.js (isolated world) via window.postMessage. Always calls the
// original appendBuffer FIRST so playback is never affected by this hook.
(function () {
  var TAG = '[PM-CAPTURE]';
  var MSG_SOURCE = 'PM_CAPTURE';
  var CHAIN_LOG_CROSS_CHECK_SLACK_S = 1.0; // [PM-CHAIN] log-collapse disagreement threshold (0.1.15) - matches offscreen-src.js's CHECK_SLACK_S

  function currentVideoId() {
    try {
      var params = new URLSearchParams(location.search);
      return params.get('v') || location.pathname;
    } catch (e) {
      return location.href;
    }
  }

  // YouTube pages routinely contain MULTIPLE <video> elements (inline-preview
  // player from SPA nav, miniplayer remnants, ad-player variants) -
  // document.querySelector('video') grabs the FIRST in DOM order, which can
  // be a dormant one (readyState 0) while the real player plays elsewhere.
  // Prefer the known real-player selector; fall back to the largest rendered
  // element with data, then largest overall.
  function getRealVideo() {
    var preferred = document.querySelector('#movie_player video.html5-main-video');
    if (preferred) return preferred;
    var vids = Array.prototype.slice.call(document.querySelectorAll('video'));
    if (vids.length === 0) return null;
    if (vids.length === 1) return vids[0];
    var withData = vids.filter(function (v) { return v.readyState > 0; });
    var pool = withData.length ? withData : vids;
    var best = pool[0];
    var bestArea = -1;
    for (var i = 0; i < pool.length; i++) {
      var r = pool[i].getBoundingClientRect();
      var area = r.width * r.height;
      if (area > bestArea) {
        best = pool[i];
        bestArea = area;
      }
    }
    return best;
  }

  // ---- minimal EBML scanner --------------------------------------------
  // Parses the segment's own container timestamp directly from the bytes
  // (Segment>Info>TimecodeScale, once, from the init segment; the first
  // Cluster>Timecode in each appended chunk after that). As of 0.1.10 this
  // is used ONLY as a logged cross-check against the buffered-range growth
  // below (do they roughly agree?) - offscreen trusts mediabunny's own
  // decoded timestamps directly as video time (the container IS the media
  // presentation timeline; see offscreen-src.js's header for why), so
  // nothing here feeds into any word timestamp. See PIPELINE_NOTES "0.1.10".
  var EBML_SEGMENT = 0x18538067, EBML_INFO = 0x1549A966, EBML_TIMECODE_SCALE = 0x2ad7b1;
  var EBML_CLUSTER = 0x1f43b675, EBML_TIMECODE = 0xe7;
  var EBML_HEADER = 0x1A45DFA3, EBML_SEEKHEAD = 0x114D9B74, EBML_TRACKS = 0x1654AE6B;
  var EBML_CUES = 0x1C53BB6B, EBML_TAGS = 0x1254C367, EBML_CHAPTERS = 0x1043A770, EBML_ATTACHMENTS = 0x1941A469;
  var EBML_BLOCKGROUP = 0xA0, EBML_VOID = 0xEC, EBML_CRC32 = 0xBF, EBML_SIMPLEBLOCK = 0xA3;
  var EBML_POSITION = 0xA7, EBML_PREVSIZE = 0xAB;
  var MASTER_IDS = [
    EBML_SEGMENT, EBML_INFO, EBML_CLUSTER, EBML_HEADER, EBML_SEEKHEAD, EBML_TRACKS,
    EBML_CUES, EBML_TAGS, EBML_CHAPTERS, EBML_ATTACHMENTS, EBML_BLOCKGROUP
  ];
  // Leaf elements we recognize but don't otherwise need - required so the
  // well-formedness gate below (KNOWN ids only) doesn't reject legitimate
  // real structure it just has no other interest in.
  var KNOWN_LEAF_IDS = [EBML_TIMECODE_SCALE, EBML_TIMECODE, EBML_VOID, EBML_CRC32, EBML_SIMPLEBLOCK, EBML_POSITION, EBML_PREVSIZE];
  // EBML "unsigned integer" element types are capped at 8 octets by spec -
  // both ids we actually read (TimecodeScale, Timecode) are this type.
  var UINT_IDS = [EBML_TIMECODE_SCALE, EBML_TIMECODE];
  function isKnownId(id) {
    return MASTER_IDS.indexOf(id) !== -1 || KNOWN_LEAF_IDS.indexOf(id) !== -1;
  }

  function readVint(bytes, offset, stripMarker) {
    if (offset >= bytes.length) return null;
    var first = bytes[offset];
    if (first === 0) return null; // invalid/corrupt lead byte
    var length = 1, mask = 0x80;
    while (mask && !(first & mask)) {
      mask >>= 1;
      length++;
    }
    if (length > 8 || offset + length > bytes.length) return null;
    var value = stripMarker ? first & (mask - 1) : first;
    for (var i = 1; i < length; i++) value = value * 256 + bytes[offset + i];
    return { value: value, length: length };
  }

  function readUint(bytes, start, size) {
    var v = 0;
    for (var i = 0; i < size; i++) v = v * 256 + bytes[start + i];
    return v;
  }

  // Walks the EBML tree looking for Info>TimecodeScale (updates
  // scaleState.value when found) and the FIRST Cluster>Timecode (returned in
  // raw ticks, or null if none present in this chunk - continuation appends
  // that are pure lacing/blocks without their own new Cluster would have
  // none, which is fine, the caller just skips that segment for offset math).
  var CLUSTER_ID_BYTES = [0x1f, 0x43, 0xb6, 0x75];
  function indexOfClusterId(bytes, fromIndex) {
    var limit = bytes.length - CLUSTER_ID_BYTES.length;
    for (var i = fromIndex; i <= limit; i++) {
      if (
        bytes[i] === CLUSTER_ID_BYTES[0] && bytes[i + 1] === CLUSTER_ID_BYTES[1] &&
        bytes[i + 2] === CLUSTER_ID_BYTES[2] && bytes[i + 3] === CLUSTER_ID_BYTES[3]
      ) {
        return i;
      }
    }
    return -1;
  }

  function scanForTimecode(bytes, scaleState) {
    // Runs the well-formedness-gated walk starting at a given top-level
    // offset, returning both what it found AND whether it hit a
    // malformed/unrecognized element before reaching `bytes.length` (the
    // caller uses `malformed` to decide whether it's worth re-syncing
    // further into the buffer - see below).
    function tryFrom(startPos) {
      var result = null;
      var malformed = false;
      function walk(start, end) {
        var p = start;
        while (p < end && result === null && !malformed) {
          var idInfo = readVint(bytes, p, false);
          if (!idInfo) return; // clean end of available bytes -> not malformed, just nothing more to read
          var id = idInfo.value;
          var sizeInfo = readVint(bytes, p + idInfo.length, true);
          if (!sizeInfo) return;
          var size = sizeInfo.value;
          var contentStart = p + idInfo.length + sizeInfo.length;
          var maxVal = Math.pow(2, 7 * sizeInfo.length) - 1;
          var unknownSize = size === maxVal; // Matroska's "unbounded element" sentinel

          // BUG FIXED (0.1.11): a Cluster>Timecode must only be trusted when
          // parsed from a well-formed element context. A mid-cluster
          // CONTINUATION chunk (raw Block/SimpleBlock payload bytes, not a
          // fresh element boundary) has no real element header at offset 0 -
          // its bytes are arbitrary, and the old scanner would still walk
          // them as if they were legitimate EBML, occasionally matching e.g.
          // byte 0xE7 (Timecode's own id) by pure coincidence and then
          // reading a garbage vint as that element's SIZE, producing values
          // like 1.45e259 seconds. That garbage then fed a plausibility-drop
          // guard that DROPPED REAL AUDIO. Fix: gate every element on (1) a
          // recognized id and (2) size consistency - a known-size element's
          // content must actually fit inside its enclosing scope, and the
          // two uint-typed ids we read (TimecodeScale, Timecode) can never
          // legitimately exceed 8 octets per the EBML spec. UNKNOWN-size
          // elements are exempt from the bounds check entirely (there is
          // nothing to bound-check - that's the whole point of the
          // sentinel), which matters a lot here: a live-streamed Cluster's
          // size is *always* the unknown-size sentinel in practice, and that
          // must remain a normal, valid, well-formed context to descend
          // into, not something this gate rejects.
          if (!isKnownId(id)) { malformed = true; return; }
          if (!unknownSize && contentStart + size > end) { malformed = true; return; }
          if (UINT_IDS.indexOf(id) !== -1 && !unknownSize && size > 8) { malformed = true; return; }

          if (id === EBML_TIMECODE_SCALE && !unknownSize) {
            scaleState.value = readUint(bytes, contentStart, size);
          } else if (id === EBML_TIMECODE && !unknownSize) {
            result = readUint(bytes, contentStart, size);
            return;
          }
          // Descend into ANY master element regardless of known/unknown size
          // - streamed/live Clusters commonly use EBML's "unknown size"
          // sentinel (the encoder doesn't know the cluster's total byte
          // length ahead of time), which is exactly the element containing
          // the Timecode we're looking for (see 0.1.10 history below this
          // file for the original fix of the "return before descending"
          // bug).
          if (MASTER_IDS.indexOf(id) !== -1) {
            var childEnd = unknownSize ? end : contentStart + size;
            walk(contentStart, childEnd);
            if (result !== null || malformed) return;
            if (unknownSize) return; // can't know where this element truly ends -> can't safely continue past it
            p = contentStart + size;
          } else if (!unknownSize) {
            p = contentStart + size;
          } else {
            return; // unknown size on a non-master leaf -> can't safely skip past it, but not proof of malformity either
          }
        }
      }
      walk(startPos, bytes.length);
      return { result: result, malformed: malformed };
    }

    var first = tryFrom(0);
    if (first.result !== null) return first.result;
    if (!first.malformed) return null; // cleanly ran out of well-formed data with nothing found -> nothing more to look for

    // RESYNC (0.1.12): position 0 hit unrecognized/inconsistent bytes before
    // reaching the end of this append - e.g. the tail of a still-open
    // Cluster's SimpleBlock stream carried over from a PREVIOUS append
    // (possibly a block whose declared size spans past this buffer
    // entirely). appendBuffer chunk boundaries do not follow EBML element
    // boundaries, so this same append may ALSO contain a genuine fresh
    // Cluster later on. Search for the Cluster element's own 4-byte id - a
    // near-zero false-positive-rate pattern (unlike matching a single byte
    // like Timecode's own 0xE7, which is what caused the original 1e259
    // bug) - and re-validate full well-formedness from each candidate
    // position via the SAME gated walk. A coincidental 4-byte match still
    // has to pass the whitelist/bounds/8-octet checks above to be trusted,
    // so this does not reopen the original vulnerability.
    var searchFrom = 1;
    var attempts = 0;
    while (attempts < 20) {
      var idx = indexOfClusterId(bytes, searchFrom);
      if (idx === -1) break;
      attempts++;
      var candidate = tryFrom(idx);
      if (candidate.result !== null) return candidate.result;
      searchFrom = idx + 4;
    }
    return null;
  }

  // ---- buffered-range growth detection -----------------------------------
  function snapshotRanges(buffered) {
    var ranges = [];
    try {
      for (var i = 0; i < buffered.length; i++) ranges.push({ start: buffered.start(i), end: buffered.end(i) });
    } catch (e) {
      // buffered can throw while updating; return whatever we got.
    }
    return ranges;
  }

  // Finds the absolute video-time span this append's bytes landed at.
  //
  // BUG FIXED (0.1.24): the old version matched an after-range to a before-
  // range by comparing STARTS within 0.5s - correct for the common case
  // (a range that only ever grows forward from a fixed start), but wrong
  // for ordinary long-video BUFFER EVICTION: YouTube continuously trims a
  // SourceBuffer's trailing edge while extending the front once the video
  // is long enough, on EVERY append (observed live:
  // rangesBefore=[135.40,808.64] -> rangesAfter=[136.54,809.50] - ~1.14s
  // trimmed off the START, ~0.86s appended at the END). The start no longer
  // matches within 0.5s, so the old code fell through to "no existing range
  // matched" and reported the WHOLE after-range as growth - wrong both in
  // WHAT counts as new audio (nearly all of it was already fed and
  // transcribed earlier) and in isNewRange (flagged a genuine disjoint
  // seek, when this is ordinary continuous playback) - which fired the
  // 0.1.20 run-boundary logic on every single segment: hundreds of demux
  // runs per minute, each superseded before it could ever transcribe
  // anything, on any video long enough to trigger eviction. See
  // PIPELINE_NOTES "0.1.24".
  //
  // Fix: a REAL interval set-difference (after minus before), matching an
  // after-range to a before-range by OVERLAP (not exact start proximity) -
  // trim at the front is invisible to growth by construction (the trimmed
  // span simply isn't part of the after-range at all), and only the
  // genuinely new portion (typically the extended tail) is reported.
  // isNewRange is now determined by whether the after-range overlaps ANY
  // before-range at all - true "no overlap with anything we already had"
  // (a genuine backward/forward seek jump) vs. false for "same underlying
  // range, just trimmed and/or extended" (ordinary continuous playback,
  // eviction included). `trimmedS` reports how much was evicted off the
  // front of the matched range, for the [PM-TRIM] debug note below (0, not
  // present, when nothing was trimmed).
  function findGrowth(before, after) {
    var bestSpan = null; // {start,end} of the winning new-audio span across all after-ranges
    var bestIsNewRange = true;
    var bestTrimmedS = 0;
    for (var i = 0; i < after.length; i++) {
      var a = after[i];
      // Subtract every overlapping before-range from `a`, leaving only the
      // genuinely new portion(s). Track the before-range with the largest
      // overlap too - that's "the same underlying range" for trim
      // detection (has its own start moved forward, i.e. been evicted?).
      var spans = [{ start: a.start, end: a.end }];
      var matchedBefore = null;
      var matchedOverlapLen = 0;
      for (var j = 0; j < before.length; j++) {
        var b = before[j];
        var overlapStart = Math.max(a.start, b.start);
        var overlapEnd = Math.min(a.end, b.end);
        if (overlapEnd > overlapStart) {
          var overlapLen = overlapEnd - overlapStart;
          if (overlapLen > matchedOverlapLen) {
            matchedOverlapLen = overlapLen;
            matchedBefore = b;
          }
        }
        var next = [];
        for (var k = 0; k < spans.length; k++) {
          var seg = spans[k];
          if (b.end <= seg.start || b.start >= seg.end) {
            next.push(seg); // no overlap with this before-range -- unaffected
            continue;
          }
          if (b.start > seg.start) next.push({ start: seg.start, end: Math.min(b.start, seg.end) });
          if (b.end < seg.end) next.push({ start: Math.max(b.end, seg.start), end: seg.end });
        }
        spans = next;
      }
      for (var m = 0; m < spans.length; m++) {
        var span = spans[m];
        if (span.end - span.start <= 0.001) continue; // negligible, floating-point noise
        // Prefer the span closest to the tail if an after-range somehow
        // yields more than one new piece (not expected in practice - a
        // single before-range overlap leaves at most one remaining piece,
        // the extended tail).
        if (!bestSpan || span.end > bestSpan.end) {
          bestSpan = span;
          bestIsNewRange = !matchedBefore;
          bestTrimmedS = matchedBefore && a.start > matchedBefore.start + 0.001 ? a.start - matchedBefore.start : 0;
        }
      }
    }
    if (!bestSpan) return null;
    return { absStart: bestSpan.start, absEnd: bestSpan.end, isNewRange: bestIsNewRange, trimmedS: bestTrimmedS };
  }

  // ---- capture-miss eviction (0.1.12) ------------------------------------
  // Deadlock class found by the user: (a) YouTube pre-buffers audio BEFORE
  // our hook attaches (initial page load buffering, or a "continue
  // watching" resume jumping straight into an already-fetched region) -
  // that audio sits in the SourceBuffer's `.buffered` ranges but our
  // appendBuffer hook never saw those bytes and never will passively (the
  // player has no reason to re-fetch data it already has); (b) pause-catchup
  // mode makes this WORSE - pausing stops the player from fetching/
  // appending ANYTHING further, so a capture-miss region right at the
  // playhead becomes a permanent deadlock: paused forever, waiting for
  // coverage that can structurally never arrive.
  //
  // Fix: track which spans of the buffered timeline we've actually CAPTURED
  // (every non-ad append's own growth span - capture.js sees every append,
  // so this is ground truth, no cross-context plumbing needed), and
  // periodically compare against the SourceBuffer's actual `.buffered`
  // ranges near the playhead. A buffered-but-uncaptured span there can never
  // be covered no matter what content.js/offscreen do - the only fix is to
  // EVICT it (`sourceBuffer.remove(start,end)`), which the player treats
  // exactly like a normal quota-driven eviction: it notices the hole and
  // re-fetches/re-appends that span, and THIS TIME our hook is attached and
  // captures it for real.
  // REDESIGNED 0.1.13: the 0.1.12 version scanned blindly every 3s across a
  // 45s lookahead and evicted up to 30s at a time, guarded only 2s from the
  // playhead - live evidence showed this actively CAUSING player stalls: 5
  // evictions in 70s, one starting only 2.98s ahead of currentTime (inside
  // the danger zone in practice - the remove()-to-refetch round trip isn't
  // instant), and a PERSISTENT HOLE that was evicted but never refilled
  // (visible in every later rangesBefore), which the player then stalled on
  // when the playhead reached it. Per the minimal-footprint design
  // principle (see PIPELINE_NOTES.md) - anything that mutates player/
  // network state is a LAST RESORT, tightly rate-limited, only when the
  // user's experience is actually blocked, and this should be tried only
  // after content.js's own fallback ladder (muted playback, no player
  // mutation at all) has already had its chance. Redesigned as:
  // - on-demand only (no blind periodic timer) - see the trigger call sites
  //   below (an appendBuffer's own activity, or an explicit check request
  //   from content.js's STALL watchdog, which only fires after 15s of zero
  //   coverage progress - i.e. genuinely last-resort, already naturally
  //   downstream of the 8s pause->mute fallback).
  // - only within EVICT_LOOKAHEAD_S of the playhead (was 45s, now 10s) -
  //   "is or will soon be blocking", not "might matter eventually".
  // - a much wider guard band (5s, not 2s) that applies regardless of
  //   paused/playing - simplicity and safety over squeezing a few extra
  //   seconds.
  // - a smaller target chunk (10-15s, not up to 30s).
  // - a MUCH tighter rate limit (a "few per minute" per the minimal-
  //   footprint principle, not 4).
  // - explicit refill verification + a single micro-seek nudge if the
  //   removed span hasn't come back within EVICT_REFILL_CHECK_MS, plus a
  //   loud, purely-informational alarm if it's still missing as the
  //   playhead approaches (see reconcilePendingEvictions) - this is what
  //   actually prevents a hole from silently persisting like the 0.1.12 one
  //   did.
  var EVICT_LOOKAHEAD_S = 10; // last-resort: only a gap at/about to reach the playhead is worth evicting
  var EVICT_TARGET_CHUNK_S = 12; // smallest-useful span (10-15s)
  var EVICT_MAX_CHUNK_S = 15;
  var EVICT_MAX_PER_MINUTE = 3; // tight, per the minimal-footprint principle
  var EVICT_GUARD_S = 5; // never within currentTime+5s, playing or paused
  var EVICT_REFILL_CHECK_MS = 4000; // how long to wait before checking whether an eviction actually got refilled
  var EVICT_STUCK_HORIZON_S = 30; // how close the playhead can get to a still-unrefilled eviction before we escalate to a loud alarm

  function mergeRangeIntoList(list, start, end) {
    list.push({ start: start, end: end });
    list.sort(function (a, b) { return a.start - b.start; });
    var merged = [];
    for (var i = 0; i < list.length; i++) {
      var cur = list[i];
      var last = merged[merged.length - 1];
      if (last && cur.start <= last.end + 0.05) last.end = Math.max(last.end, cur.end);
      else merged.push({ start: cur.start, end: cur.end });
    }
    list.length = 0;
    for (var j = 0; j < merged.length; j++) list.push(merged[j]);
  }

  // Spans present in `bufferedList` that are NOT covered by `capturedList`.
  function subtractRanges(bufferedList, capturedList) {
    var gaps = [];
    for (var i = 0; i < bufferedList.length; i++) {
      var segStart = bufferedList[i].start, segEnd = bufferedList[i].end;
      var cursor = segStart;
      var overlapping = capturedList
        .filter(function (c) { return c.end > segStart && c.start < segEnd; })
        .sort(function (a, b) { return a.start - b.start; });
      for (var j = 0; j < overlapping.length; j++) {
        var c = overlapping[j];
        if (c.start > cursor) gaps.push({ start: cursor, end: Math.min(c.start, segEnd) });
        cursor = Math.max(cursor, c.end);
        if (cursor >= segEnd) break;
      }
      if (cursor < segEnd) gaps.push({ start: cursor, end: segEnd });
    }
    return gaps;
  }

  function pumpEvictionQueue(sb, evictionState) {
    if (sb.updating) return; // will be retried on the next 'updateend'
    var next = evictionState.queue.shift();
    if (!next) return;
    try {
      logLine('[PM-EVICT] evicting [' + next.start.toFixed(2) + ',' + next.end.toFixed(2) + ') reason=capture-miss (buffered but never seen by our appendBuffer hook)');
      sb.remove(next.start, next.end);
    } catch (e) {
      logLine('[PM-EVICT] remove failed: ' + String(e));
    }
  }

  // A micro-seek forces the player to re-evaluate its buffered state and,
  // in practice, re-request around the current position - the standard way
  // to nudge an MSE-backed player after removing a range it thought it
  // already had. This is a real player-behavior mutation (not passive), so
  // it's only ever called as a last resort from reconcilePendingEvictions
  // below, at most once per eviction.
  function nudgePlayer(reason) {
    try {
      var video = getRealVideo();
      if (!video) return;
      logLine('[PM-EVICT-NUDGE] micro-seek to force re-fetch: ' + reason);
      video.currentTime = video.currentTime + 0.01;
    } catch (e) {
      logLine('[PM-EVICT-NUDGE] failed: ' + String(e));
    }
  }

  // Tracks every eviction until it's confirmed refilled (by OUR hook, via
  // evictionState.captured - not just `.buffered` having bytes, since only
  // our own capture actually fixes the underlying problem) or the playhead
  // passes it (stale, nothing more we can usefully do). This is what
  // prevents the 0.1.12 "evicted and never refilled" persistent-hole bug:
  // that version fired-and-forgot every removal.
  function reconcilePendingEvictions(evictionState, currentTime) {
    var now = Date.now();
    evictionState.pending = evictionState.pending.filter(function (p) {
      var stillMissing = subtractRanges([{ start: p.start, end: p.end }], evictionState.captured).length > 0;
      if (!stillMissing) return false; // refilled and captured for real - done
      if (currentTime > p.end + 2) {
        logLine('[PM-EVICT-STUCK] [' + p.start.toFixed(2) + ',' + p.end.toFixed(2) + ') never refilled before the playhead passed it - giving up on this span (will surface as a normal coverage/stall gap)');
        return false; // playhead already past it; nothing more we can do
      }
      var age = now - p.evictedAtWall;
      if (!p.nudged && age > EVICT_REFILL_CHECK_MS) {
        p.nudged = true;
        nudgePlayer('[' + p.start.toFixed(2) + ',' + p.end.toFixed(2) + ') not refilled ' + Math.round(age / 1000) + 's after eviction');
      } else if (p.nudged && age > EVICT_REFILL_CHECK_MS * 2 && currentTime > p.start - EVICT_STUCK_HORIZON_S) {
        logLine('[PM-EVICT-STUCK] [' + p.start.toFixed(2) + ',' + p.end.toFixed(2) + ') still not refilled ' + Math.round(age / 1000) + 's after eviction (already nudged) - playhead approaching at currentTime=' + currentTime.toFixed(2));
      }
      return true;
    });
  }

  function detectAndEvictCaptureMisses(sb, evictionState, videoIdAtInit, reason) {
    if (currentVideoId() !== videoIdAtInit) return;
    var video = getRealVideo();
    if (!video) return;
    var currentTime = video.currentTime;

    reconcilePendingEvictions(evictionState, currentTime);

    var buffered = snapshotRanges(sb.buffered);
    var gaps = subtractRanges(buffered, evictionState.captured);
    // LAST RESORT gating: only a gap that's already at, or will be reached
    // within EVICT_LOOKAHEAD_S of, the playhead - never speculative
    // eviction of something far ahead that might not even matter by the
    // time playback gets there.
    var relevant = gaps.filter(function (g) { return g.end > currentTime && g.start < currentTime + EVICT_LOOKAHEAD_S; });
    if (!relevant.length) return;

    var now = Date.now();
    evictionState.recentEvictions = evictionState.recentEvictions.filter(function (t) { return now - t < 60000; });
    if (evictionState.recentEvictions.length >= EVICT_MAX_PER_MINUTE) return;
    // Don't re-evict a span we're already tracking as pending (avoids
    // hammering the same hole every time this is called).
    var g = relevant[0];
    var alreadyPending = evictionState.pending.some(function (p) { return p.start < g.end && p.end > g.start; });
    if (alreadyPending) return;

    var evictStart = Math.max(g.start, currentTime + EVICT_GUARD_S);
    var evictEnd = Math.min(g.end, evictStart + EVICT_TARGET_CHUNK_S);
    if (evictEnd - evictStart < 1) return; // nothing safely/usefully evictable right now (all inside the guard band, or a sliver not worth a remove() call)
    if (evictEnd - evictStart > EVICT_MAX_CHUNK_S) evictEnd = evictStart + EVICT_MAX_CHUNK_S;

    logLine('[PM-EVICT] triggered by ' + (reason || 'append-activity') + ' - evicting smallest-useful span');
    evictionState.recentEvictions.push(now);
    evictionState.queue.push({ start: evictStart, end: evictEnd });
    evictionState.pending.push({ start: evictStart, end: evictEnd, evictedAtWall: now, nudged: false });
    pumpEvictionQueue(sb, evictionState);
  }

  // Ads run on a DIFFERENT media timeline than the main content - the one
  // legitimate case where a segment's container timestamp is NOT on the
  // video's own presentation timeline. Never transcribe them: check ONLY
  // the player's own ad-state class (0.1.11: the timecode-implausibility
  // backstop that used to sit alongside this is deleted entirely - it was a
  // heuristic on top of a parser that could itself produce garbage, and it
  // actively dropped real non-ad audio when the parser misfired; see
  // scanForTimecode's 0.1.11 fix above and PIPELINE_NOTES.md "0.1.11").
  function isAdShowing() {
    var player = document.getElementById('movie_player');
    return !!(player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')));
  }

  function toArrayBuffer(chunk) {
    if (chunk instanceof ArrayBuffer) return chunk.slice(0);
    if (ArrayBuffer.isView(chunk)) {
      return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    }
    throw new Error('appendBuffer chunk is neither ArrayBuffer nor ArrayBufferView');
  }

  // Postmessage bridge hardening (0.1.15): see content.js's matching
  // comment for the full rationale. capture.js runs first (document_start,
  // MAIN world, listed first in manifest.json) so it initiates: create a
  // MessageChannel, keep port1, hand content.js port2 via a one-time public
  // handshake message (safe - nothing else can be listening yet at this
  // point in document_start). From then on `post()` sends over the private
  // port instead of the public broadcast; falls back to public
  // window.postMessage if the port was never established or ever breaks,
  // so hardening can never become a single point of failure for the whole
  // extension.
  var contentPort = null;
  (function initSecureChannel() {
    try {
      var channel = new MessageChannel();
      contentPort = channel.port1;
      contentPort.onmessage = function (ev) {
        if (ev.data && ev.data.type === 'ack') logLine('[PM-SECURE-CHANNEL] private port handshake with content.js confirmed');
      };
      window.postMessage({ __pm: MSG_SOURCE, type: 'handshake' }, location.origin, [channel.port2]);
    } catch (e) {
      contentPort = null;
      console.log(TAG, '[PM-SECURE-CHANNEL] handshake setup failed, falling back to public postMessage: ' + String(e));
    }
  })();

  function post(payload) {
    // structured clone handles ArrayBuffer natively; targetOrigin restricted
    // to this window's own origin (youtube.com) for the fallback path,
    // listener filters by source.
    var msg = Object.assign({ __pm: MSG_SOURCE }, payload);
    if (contentPort) {
      try {
        contentPort.postMessage(msg);
        return;
      } catch (e) {
        console.log(TAG, '[PM-SECURE-CHANNEL] port postMessage failed, falling back to public: ' + String(e));
        contentPort = null; // don't keep retrying a broken port every call
      }
    }
    window.postMessage(msg, location.origin);
  }

  // capture.js runs in the MAIN world - a separate JS realm from content.js's
  // isolated world, so its console.log output, while visible in the SAME
  // DevTools console (same tab), physically cannot write into content.js's
  // log-ring buffer (no shared objects across worlds). Route every
  // diagnostic line through here so it also reaches the "Copy logs" button's
  // output, not just the live console.
  function logLine(text) {
    console.log(TAG, text);
    post({ type: 'chainlog', text: TAG + ' ' + text });
  }

  // Registry for the on-demand eviction check request from content.js (see
  // the 'message' listener below) - normally at most one audio SourceBuffer
  // is live at a time; the most recently instrumented one is "active".
  var activeEvictionSB = null;
  var activeEvictionState = null;
  var activeEvictionVideoId = null;

  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.__pmToCapture !== 'PM_CONTENT') return;
    if (ev.data.type === 'check-eviction' && activeEvictionSB && activeEvictionState) {
      try {
        detectAndEvictCaptureMisses(activeEvictionSB, activeEvictionState, activeEvictionVideoId, 'stall-watchdog');
      } catch (e) {
        logLine('[PM-EVICT] on-demand detect failed: ' + String(e));
      }
    }
  });

  var activeVideoId = currentVideoId();
  function checkNavigation() {
    var vid = currentVideoId();
    if (vid !== activeVideoId) {
      activeVideoId = vid;
      logLine('video changed -> ' + vid + ' (RESET)');
      post({ type: 'reset', videoId: vid });
    }
  }
  document.addEventListener('yt-navigate-finish', checkNavigation, true);
  // Fallback poll in case the SPA event isn't observed (e.g. YouTube DOM
  // structure changes); cheap and idempotent.
  setInterval(checkNavigation, 1000);

  var OrigMediaSource = window.MediaSource;
  if (!OrigMediaSource) {
    logLine('window.MediaSource not present at document_start');
    return;
  }

  var origAddSourceBuffer = OrigMediaSource.prototype.addSourceBuffer;

  OrigMediaSource.prototype.addSourceBuffer = function (mime) {
    var sb = origAddSourceBuffer.call(this, mime);
    try {
      if (typeof mime === 'string' && mime.toLowerCase().indexOf('audio') !== -1) {
        instrumentAudioSourceBuffer(sb, mime);
      }
    } catch (e) {
      logLine('addSourceBuffer hook failed: ' + String(e));
    }
    return sb;
  };

  // One-time sanity check (item 3 of the 0.1.9 redirect): confirm every part
  // of the pipeline that looks up "the video element" agrees on which one.
  var loggedVideoEnumeration = false;
  function logVideoEnumerationOnce() {
    if (loggedVideoEnumeration) return;
    loggedVideoEnumeration = true;
    try {
      var all = Array.prototype.slice.call(document.querySelectorAll('video'));
      var chosen = getRealVideo();
      logLine(
        '[PM-VIDEO-CHECK] ' + all.length + ' <video> element(s) found; ' +
          all.map(function (v, i) {
            return '#' + i + '(readyState=' + v.readyState + ' w=' + v.offsetWidth + ' cls=' + JSON.stringify(v.className) + (v === chosen ? ' <-- CHOSEN' : '') + ')';
          }).join(' ')
      );
    } catch (e) {
      logLine('[PM-VIDEO-CHECK] failed: ' + String(e));
    }
  }

  function instrumentAudioSourceBuffer(sb, initialMime) {
    logLine('audio SourceBuffer detected, mime=' + initialMime);
    logVideoEnumerationOnce();
    var mime = initialMime;
    var origAppendBuffer = sb.appendBuffer;
    var origChangeType = sb.changeType;
    var segmentCount = 0;
    var videoIdAtInit = currentVideoId();
    // Cached init-segment bytes (0.1.20 bug #2) - the actual first append
    // for this SourceBuffer's current lifetime, kept so a later timeline
    // DISCONTINUITY (a NEW-RANGE growth with no fresh init segment of its
    // own - a big forward or backward seek within the SAME SourceBuffer)
    // can be turned into a synthetic isInit segment reusing this exact
    // codec/track header. See finishAppendProcessing below.
    var cachedInitBytes = null;
    var timecodeScale = { value: 1000000 }; // Matroska default: 1e6 ns/tick = 1ms/tick; updated if Info>TimecodeScale is found
    var chainSegsSinceLog = 0; // [PM-CHAIN] log-collapse state (0.1.15) - see the logging site below
    var lastChainLogWall = Date.now();
    var lastTrimLogWall = 0; // [PM-TRIM] throttle (0.1.24) - see finishAppendProcessing below
    // Run-boundary sanity backstop (0.1.24) - see PIPELINE_NOTES "0.1.24":
    // a real live bug (fixed by 0.1.24's findGrowth rewrite) misclassified
    // ordinary buffer-eviction trim+extend as a brand-new disjoint range on
    // EVERY segment, firing a new demux run every single append. This is a
    // defense-in-depth backstop against THAT class of bug recurring for any
    // other reason: if run boundaries fire faster than a real seek pattern
    // plausibly would, stop opening new ones - degraded (stuck on one run,
    // possibly missing a genuine seek's own coverage) but alive beats churn
    // death (transcribing nothing at all, forever).
    var runBoundaryTimestamps = [];
    var runBoundaryRateLimited = false;
    var RUN_BOUNDARY_RATE_LIMIT_WINDOW_MS = 10000;
    var RUN_BOUNDARY_RATE_LIMIT_MAX = 3;
    var evictionState = { captured: [], recentEvictions: [], queue: [], pending: [] };
    sb.addEventListener('updateend', function () { pumpEvictionQueue(sb, evictionState); });
    // Registered as the "active" audio SourceBuffer for the on-demand
    // eviction check triggered from content.js's stall watchdog (see the
    // 'message' listener near the end of this file) - there is normally
    // only one at a time; the most recently instrumented one wins, matching
    // how videoIdAtInit-style "current" tracking already works elsewhere in
    // this file.
    activeEvictionSB = sb;
    activeEvictionState = evictionState;
    activeEvictionVideoId = videoIdAtInit;

    if (typeof origChangeType === 'function') {
      sb.changeType = function (newMime) {
        logLine('changeType ' + mime + ' -> ' + newMime);
        mime = newMime;
        // FIXED (0.1.15): a codec/bitrate switch (quality change) is NOT a
        // video change - this used to post a full 'reset', which
        // content.js's resetSession() turns into releaseMute() (unmuting
        // an ACTIVE word mute mid-utterance, audible) and wiping otherwise-
        // still-valid session.intervals/coveredIntervals for no reason.
        // Only capture-side codec bookkeeping needs to reset: the next
        // append after changeType() IS a genuine new init segment (real
        // browsers always re-init on changeType), so segmentCount=0 alone
        // makes capture.js correctly flag it isInit=true, which makes
        // offscreen correctly start a fresh demux run for it - session-
        // level coverage/word-dedupe already span run boundaries by design
        // (see offscreen-src.js's header), so nothing there needs resetting
        // either.
        segmentCount = 0;
        return origChangeType.call(this, newMime);
      };
    }

    // BUG FIXED (0.1.16): SourceBuffer.appendBuffer() is ASYNC - the browser
    // does not actually apply the append (and grow `.buffered`) until the
    // 'updateend' event fires. The previous code diffed `.buffered`
    // synchronously, immediately after calling the original appendBuffer,
    // which reads the OLD (pre-append) ranges every single time - growth was
    // ALWAYS `none`, on every line, for the entire life of this codebase
    // (confirmed against historical logs). 0.1.14's picker redesign made
    // this fatal for the first time: it feeds `s.bufferedRanges` exclusively
    // from `growthAbsStart`/`growthAbsEnd`, so with growth always empty,
    // offscreen never saw ANY available audio and produced zero windows,
    // ever ("[PM-NO-WINDOW] no captured audio range" forever). Fix: snapshot
    // `rangesBefore` synchronously (correct, reflects real pre-append
    // state), then queue the rest of this append's processing (growth
    // computation, eviction-captured-range bookkeeping, the [PM-CHAIN] log,
    // and `post()`) until the SourceBuffer's own 'updateend' fires, when
    // `.buffered` has actually updated. A small FIFO queue (`pendingAppends`)
    // preserves ordering if multiple appends ever queue up before their
    // updateend events fire (normally at most one is in flight, since a
    // well-behaved player waits for updateend before its next append, but
    // this is correct either way).
    var pendingAppends = [];
    sb.addEventListener('updateend', function () {
      if (!pendingAppends.length) return;
      var item = pendingAppends.shift();
      try {
        finishAppendProcessing(sb, item);
      } catch (e) {
        logLine('appendBuffer updateend processing failed: ' + String(e));
      }
    });

    function finishAppendProcessing(sbRef, item) {
      var rangesAfter = snapshotRanges(sbRef.buffered);
      var growth = findGrowth(item.rangesBefore, rangesAfter);

      // This segment's bytes ARE reaching our hook - record its actual
      // buffered span as "captured" so the eviction check above never
      // mistakes normal, currently-in-flight audio for a capture miss.
      if (growth) mergeRangeIntoList(evictionState.captured, growth.absStart, growth.absEnd);

      // RUN-BOUNDARY ON DISCONTINUITY (0.1.20 bug #2): a real, user-diagnosed
      // bug - a backward seek (2588 -> 2464.94) captured segments fine
      // (findGrowth correctly reported a brand-new, disjoint NEW-RANGE), but
      // offscreen logged "[PM-SKIP] no decodable audio in this run at that
      // time yet" dozens of times: the new bytes were appended to the SAME
      // SourceBuffer, so segmentCount never resets and isInit stays false -
      // nothing ever told offscreen a NEW demux run was needed - but they
      // landed on offscreen's ONE PERSISTENT mediabunny Input for that run
      // (see offscreen-src.js's "0.1.6" streaming-Input design), which is a
      // SEQUENTIAL decoder: once it has consumed cluster timestamps for
      // 2580-2670, it cannot rewind to serve 2460-2510 from the SAME stream.
      // A big FORWARD jump within one SourceBuffer has the same "no fresh
      // init segment" shape (see 0.1.14's original "jump forward = uncovered
      // forever" bug) and gets the identical fix here, even though a forward
      // jump's own bytes are less likely to break the sequential decoder -
      // safer to always open a fresh run on ANY disjoint NEW-RANGE than to
      // rely on direction.
      // Fix: offscreen already treats `isInit:true` as "open a fresh run"
      // (see its pm-segment handler) - reuse that exact mechanism instead of
      // adding a new wire message: whenever growth reports a NEW-RANGE that
      // ISN'T itself already a real init segment, resend the cached real
      // init segment's bytes as a synthetic isInit segment immediately
      // before this one. Offscreen demuxes the discontinuous bytes in their
      // own fresh run (same codec/track header, since it's the SAME cached
      // init bytes), while the old run(s) are left for the existing 0.1.15
      // pruning (KEEP_RUNS=2) to reclaim - nothing here touches session-level
      // coverage/word-dedupe, which already spans run boundaries by design.
      // [PM-TRIM] (0.1.24): throttled debug note whenever findGrowth detects
      // ordinary front-eviction (the matched before-range's start moved
      // forward) - so a future log visibly distinguishes "this append is
      // just eviction trim+extend" from an actual run boundary, instead of
      // the two being indistinguishable the way they used to be.
      if (growth && growth.trimmedS > 0.001) {
        var nowTrim = Date.now();
        if (nowTrim - lastTrimLogWall >= 5000) {
          lastTrimLogWall = nowTrim;
          logLine('[PM-TRIM] buffer eviction trimmed ~' + growth.trimmedS.toFixed(2) + 's off the front of the current range (normal on long videos; not a run boundary)');
        }
      }

      var isDiscontinuity = !!(growth && growth.isNewRange) && !item.isInit;
      if (isDiscontinuity && !runBoundaryRateLimited) {
        var nowRB = Date.now();
        runBoundaryTimestamps.push(nowRB);
        runBoundaryTimestamps = runBoundaryTimestamps.filter(function (t) { return nowRB - t < RUN_BOUNDARY_RATE_LIMIT_WINDOW_MS; });
        if (runBoundaryTimestamps.length > RUN_BOUNDARY_RATE_LIMIT_MAX) {
          runBoundaryRateLimited = true;
          logLine(
            '[PM-RUN-BOUNDARY-STORM] ' + runBoundaryTimestamps.length + ' run boundaries fired within ' +
              (RUN_BOUNDARY_RATE_LIMIT_WINDOW_MS / 1000) + 's -- something is misclassifying growth as disjoint; ' +
              'giving up on opening further new runs for this SourceBuffer (degraded but alive beats churn death) -- see PIPELINE_NOTES "0.1.24"'
          );
        }
      }
      if (isDiscontinuity && runBoundaryRateLimited) {
        logLine(
          '[PM-RUN-BOUNDARY-SUPPRESSED] would have opened a new run for NEW-RANGE growth=[' + growth.absStart.toFixed(2) + ',' + growth.absEnd.toFixed(2) +
            ') but the sanity backstop above suppressed it -- feeding into the existing run instead'
        );
      } else if (isDiscontinuity && cachedInitBytes) {
        logLine(
          '[PM-RUN-BOUNDARY] NEW-RANGE growth=[' + growth.absStart.toFixed(2) + ',' + growth.absEnd.toFixed(2) +
            ') with no fresh init segment of its own -- opening a new demux run (resending cached init bytes)'
        );
        post({
          type: 'segment',
          videoId: item.vid,
          mime: item.mime,
          isInit: true,
          segIndex: item.segmentCount,
          bytes: cachedInitBytes,
          currentTime: item.currentTime,
          localTimeSec: null,
          growthAbsStart: null,
          growthAbsEnd: null,
          growthIsNewRange: null,
          wallTime: Date.now(),
          isSyntheticRunBoundary: true
        });
      } else if (isDiscontinuity) {
        // Should not happen once the first real init segment has landed -
        // surfaced loudly rather than silently falling back to feeding the
        // discontinuous bytes into the existing (sequentially-stuck) run.
        logLine('[PM-RUN-BOUNDARY] NEW-RANGE growth detected but no cached init segment bytes available yet -- cannot open a clean new run');
      }

      // Log collapse (0.1.15): an unconditional per-segment [PM-CHAIN] line
      // was pure noise at normal append rates. Only log on an actual STATE
      // CHANGE (a new disjoint buffered range, or the container-timecode/
      // buffered-growth cross-check disagreeing beyond
      // CHAIN_LOG_CROSS_CHECK_SLACK_S), plus a periodic summary every 25
      // segments or 5s.
      var crossCheckDeltaVal = growth && item.localTimeSec != null ? growth.absStart - item.localTimeSec : null;
      var isDisagreement = crossCheckDeltaVal != null && Math.abs(crossCheckDeltaVal) > CHAIN_LOG_CROSS_CHECK_SLACK_S;
      var isNewRange = !!(growth && growth.isNewRange);
      var nowWall = Date.now();
      chainSegsSinceLog++;
      var summaryDue = chainSegsSinceLog >= 25 || nowWall - lastChainLogWall >= 5000;
      if (isNewRange || isDisagreement || summaryDue) {
        logLine(
          '[PM-CHAIN] seg=' + item.segmentCount + ' isInit=' + item.isInit +
            ' currentTime=' + fmt(item.currentTime) +
            ' localTicks=' + (item.localTicks == null ? 'null' : item.localTicks) +
            ' timecodeScale=' + timecodeScale.value +
            ' localTimeSec=' + (item.localTimeSec == null ? 'null' : item.localTimeSec.toFixed(3)) +
            ' rangesBefore=' + fmtRanges(item.rangesBefore) +
            ' rangesAfter=' + fmtRanges(rangesAfter) +
            ' growth=' + (growth ? '[' + growth.absStart.toFixed(3) + ',' + growth.absEnd.toFixed(3) + ')' + (growth.isNewRange ? ' NEW-RANGE' : '') : 'none') +
            ' crossCheckDelta=' + (crossCheckDeltaVal != null ? crossCheckDeltaVal.toFixed(3) : 'n/a') +
            (isDisagreement ? ' *** DISAGREEMENT ***' : '') +
            (summaryDue && !isNewRange && !isDisagreement ? ' (periodic summary, ' + chainSegsSinceLog + ' segs since last log)' : '')
        );
        chainSegsSinceLog = 0;
        lastChainLogWall = nowWall;
      }

      post({
        type: 'segment',
        videoId: item.vid,
        mime: item.mime,
        isInit: item.isInit,
        segIndex: item.segmentCount,
        bytes: item.ab, // structured-cloned, MAIN -> ISOLATED
        currentTime: item.currentTime,
        duration: item.duration,
        localTimeSec: item.localTimeSec,
        growthAbsStart: growth ? growth.absStart : null,
        growthAbsEnd: growth ? growth.absEnd : null,
        growthIsNewRange: growth ? growth.isNewRange : null,
        wallTime: Date.now()
      });
    }

    sb.appendBuffer = function (chunk) {
      var rangesBefore = snapshotRanges(this.buffered);

      var result = origAppendBuffer.call(this, chunk);

      try {
        var video = getRealVideo();
        var currentTime = video ? video.currentTime : NaN;
        // 0.1.23: video.duration, relayed alongside currentTime, so offscreen
        // can detect end-of-stream and safely close a run's demux stream for
        // final-tail flushing - see PIPELINE_NOTES "0.1.23" item 2.
        var duration = video ? video.duration : NaN;

        var ab = toArrayBuffer(chunk);
        var localTicks = scanForTimecode(new Uint8Array(ab), timecodeScale);
        var localTimeSec = localTicks != null ? (localTicks * timecodeScale.value) / 1e9 : null;

        // Drop ad audio at the source - never transcribe it. ONLY the
        // player's own ad-state class is used for this (0.1.11: the
        // timecode-implausibility backstop guard is DELETED entirely - it
        // was a heuristic sitting on top of a parser that could itself
        // produce garbage (see scanForTimecode's 0.1.11 fix above), and it
        // actively DROPPED REAL, non-ad AUDIO when the parser misfired,
        // which is strictly worse than the rare ad-detection gap it was
        // meant to backstop. Ad exclusion is a player-state fact, not
        // something to infer from a timestamp). Evaluated synchronously at
        // append time, before queuing anything - an ad segment never needs
        // growth info since it's dropped outright, not posted.
        var adShowing = isAdShowing();
        if (adShowing) {
          logLine('[PM-AD-SKIP] dropping segment (ad-showing)');
          return result;
        }

        segmentCount++;
        var isInit = segmentCount === 1;
        var vid = currentVideoId();
        // Cache the real init segment's bytes (0.1.20 bug #2) so a later
        // timeline discontinuity (NEW-RANGE growth with no init segment of
        // its own) can be turned into a synthetic run-boundary reusing this
        // exact codec/track header - see finishAppendProcessing above.
        if (isInit) cachedInitBytes = ab;

        pendingAppends.push({
          rangesBefore: rangesBefore,
          currentTime: currentTime,
          duration: duration,
          localTicks: localTicks,
          localTimeSec: localTimeSec,
          ab: ab,
          segmentCount: segmentCount,
          isInit: isInit,
          vid: vid,
          mime: mime
        });
        // Normal case: the browser hasn't finished applying this append yet
        // (sb.updating is true) and 'updateend' will fire and drain this
        // item. Defensive fallback: if updating is somehow already false
        // RIGHT NOW (observed possible for very small/instant appends in
        // some browser versions), process immediately rather than leaving
        // this item stuck in the queue forever waiting for an event that
        // already happened.
        if (!sb.updating) finishAppendProcessing(sb, pendingAppends.shift());
      } catch (e) {
        logLine('appendBuffer hook failed: ' + String(e));
      }

      return result;
    };
  }

  function fmt(n) {
    return typeof n === 'number' && !isNaN(n) ? n.toFixed(3) : 'NA';
  }
  function fmtRanges(ranges) {
    return '[' + ranges.map(function (r) { return r.start.toFixed(2) + '-' + r.end.toFixed(2); }).join(',') + ']';
  }

  logLine('capture.js installed at document_start, world=MAIN, videoId=' + activeVideoId);
})();
