// shared/devlog.js
// Plain script (NOT an ES module) — loaded as an isolated-world content
// script AFTER shared/wordlist.js and BEFORE content.js/captions.js (see
// manifest.json content_scripts order). Defines globalThis.PMDevlog.
//
// WHY THIS EXISTS
// ---------------
// The question that keeps coming up and could not be answered after the
// fact is: "why did word X get through on video Y?". Everything needed to
// answer it already existed in memory at the time (the analyzed windows,
// the matches found in each, the padded mute intervals, which regions
// played while still unanalyzed) — but all of it lived only in the
// per-tab console ring buffer in content.js, which dies with the tab and
// is only recoverable if the user happened to click "Copy logs" BEFORE
// navigating away. By the time anyone asks the question, the evidence is
// gone.
//
// This module keeps a small, durable, structured record of the last 10
// videos watched in chrome.storage.local under `pm_devlog`, and the
// popup's "Copy debug log" button hands the whole thing over as JSON. It
// is deliberately NOT a second copy of the console log: it stores the
// decisions and their inputs (window spans, matched words + timestamps,
// mute intervals, unanalyzed-playback gaps, caption censor events,
// errors), not the running commentary.
//
// Storage schema (chrome.storage.LOCAL — NOT synced; this is per-install
// diagnostic data, write-frequent, and can approach 256KB):
//
//   pm_devlog  { version: 1, videos: Entry[] }   default absent -> treated
//              as {version: 1, videos: []}. `videos` is OLDEST FIRST,
//              newest last, at most MAX_VIDEOS (10) long. One entry per
//              videoId; re-watching a video already in the ring UPDATES
//              its entry and moves it to the newest slot rather than
//              adding a duplicate.
//
//   Entry = {
//     videoId:    string        — the YouTube `v` param (or pathname), the
//                                 same id content.js keys its session on
//     title:      string|null   — document.title at session start (refined
//                                 once the player has actually resolved,
//                                 since at document_start it is often still
//                                 the pre-navigation title)
//     startedAt:  number        — Date.now() when the video's session began
//     version:    string        — extension version from the manifest
//     settings:   {enabled, strictness, wordlistSource, wordCount,
//                  additionalWordCount, catchupMode, muteAudio,
//                  censorCaptions, padding}
//                                 — RESOLVED settings snapshot at video
//                                 start (see below). Deliberately NOT the
//                                 full word list: a custom list can be
//                                 thousands of entries and is the single
//                                 biggest size risk in this whole record,
//                                 while `wordlistSource` + `wordCount` is
//                                 what actually answers "was the word even
//                                 in the active list". As of 0.1.29
//                                 `wordlistSource` names the built-in TIER
//                                 and the user's own count together
//                                 ("tier:strict+own:3"), since the active
//                                 list is tier + additions and a bare tier
//                                 name no longer says where a match could
//                                 have come from.
//     windows:    Window[]      — one per analyzed audio window
//     gaps:       Gap[]         — unanalyzed-playback periods
//     captions:   CaptionEvent[]— caption censor events
//     captionCount: number      — TOTAL caption censor events, including
//                                 ones dropped from `captions` by the cap
//                                 below (so the list being short never
//                                 reads as "captions weren't censoring")
//     errors:     ErrorEvent[]  — TERROR/pipeline errors
//     truncated:  boolean       — true once the size guard has dropped
//                                 anything from this entry (see
//                                 enforceSizeCap); a consumer must never
//                                 read a truncated entry as complete
//   }
//
//   Window = {
//     t0, t1:              number  — media-time span of the analyzed window
//     transcriptWordCount: number  — how many words the transcript held
//     matches:             [{word, t}]        — matched word/phrase + the
//                                               media time it starts at
//     muteIntervals:       [{start, end}]     — the PADDED intervals those
//                                               matches produced
//     text?:               string  — full transcript, ONLY when
//                                    pm_devlogVerbose is on (see below)
//   }
//
//   Gap = {start, end, mode}  — a period during which playback advanced
//                               while the playhead was NOT covered by any
//                               analyzed region: exactly the audio that
//                               catch-up mode "play" lets through
//                               unchecked. Recorded in EVERY catch-up mode
//                               (with `mode` naming the one in force), so
//                               the same record answers both "what did
//                               play mode leak" and "what would it have
//                               leaked if I turned it on".
//
//   CaptionEvent = {t, original, censored}  — one word actually rewritten
//                               in the caption DOM, at media time `t`.
//                               Per-WORD, not per-segment: storing whole
//                               caption segments would put a transcript of
//                               the video in storage, which is exactly what
//                               the verbose flag exists to gate.
//
//   ErrorEvent = {t, wall, text} — `t` is media time (or null if unknown),
//                               `wall` is Date.now().
//
// Storage schema (chrome.storage.sync):
//   pm_devlogVerbose  boolean  default false — when true, each Window also
//                     carries its full `text` transcript. Off by default
//                     for two reasons, in this order: (1) privacy — a
//                     verbatim transcript of everything watched is a very
//                     different thing to leave sitting in storage than a
//                     list of matched profanity, and (2) size — transcripts
//                     dominate the 256KB budget and would evict the
//                     structural evidence that actually answers the "why
//                     did X get through" question. There is no popup UI for
//                     this key on purpose: it is a debugging escape hatch,
//                     set deliberately from the extension console with
//                     `chrome.storage.sync.set({pm_devlogVerbose: true})`.
//
// Ownership note: this key is read directly here rather than being added to
// shared/wordlist.js's STORAGE_KEYS/PMWordlist.settings contract, because
// it is not a user-facing setting and nothing else needs to see it.
//
// Like shared/wordlist.js, this file is written so the pure logic works
// with zero dependency on chrome.* — see PMDevlogCore below — so it can be
// required directly under Node for unit tests (test/devlog_test.js). All
// chrome.storage wiring is guarded so a context without chrome.* (Node, a
// stripped page) never throws.

(function (root) {
  "use strict";

  // ---- tunables ----------------------------------------------------------
  // MAX_VIDEOS is the product requirement (last 10 videos). The rest are
  // per-entry sanity ceilings that keep a single very long video from
  // filling the whole budget by itself before the size guard ever runs —
  // the size guard is the backstop, these are the routine bound. A 3-hour
  // video analyzed in ~10s windows produces ~1000 windows, so 600 keeps
  // the most recent ~1.7 hours of analysis for a worst-case long video and
  // is comfortably under the byte cap for anything normal.
  var SCHEMA_VERSION = 1;
  var MAX_VIDEOS = 10;
  var MAX_WINDOWS = 600;
  var MAX_GAPS = 300;
  var MAX_CAPTIONS = 400;
  var MAX_ERRORS = 100;
  // ~256KB serialized. Measured against JSON.stringify's output length
  // (UTF-16 code units, not bytes) — deliberately the cheap approximation
  // rather than a TextEncoder round trip on every flush; for ASCII-ish
  // English content the two agree, and for content where they don't, the
  // code-unit count is an UNDER-estimate of bytes only for astral-plane
  // characters (rare in this data), while chrome.storage.local's own quota
  // is an order of magnitude larger (10MB unlimited-storage-free) than this
  // self-imposed cap. Being off by a little here has no failure mode.
  var MAX_BYTES = 256 * 1024;
  // Errors logged before any video session has started (e.g. a failed
  // chrome.runtime.connect during content.js's own startup, which happens
  // BEFORE its first resetSession call) are held here and attached to the
  // first entry created. Without this, the single most diagnostic class of
  // error — the pipeline failing to come up at all — would be the one class
  // that never makes it into the log.
  var MAX_PENDING_ERRORS = 20;

  // ---- flush batching ----------------------------------------------------
  // chrome.storage.local has a write budget and this module is fed from an
  // rAF-cadence tick loop and a per-window transcription callback — writing
  // on every event would be both wasteful and, on a busy video, close to
  // rate-limiting. Everything mutates an in-memory entry; storage sees at
  // most one read-modify-write every FLUSH_MS, plus one final flush on
  // pagehide (which is the flush that actually matters, since that is when
  // the tab is about to take the in-memory copy with it).
  var FLUSH_MS = 5000;

  // ======================================================================
  // PURE CORE — no chrome.*, no DOM, no timers. Everything below this line
  // that touches the browser goes through it. Exported for Node tests.
  // ======================================================================

  function emptyLog() {
    return { version: SCHEMA_VERSION, videos: [] };
  }

  // Coerce whatever came back from storage into a well-formed log. A
  // corrupted/foreign value is replaced wholesale rather than merged: this
  // is diagnostic data, and silently carrying half-parsed junk forward
  // would poison every later read of it.
  function normalizeLog(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.videos)) {
      return emptyLog();
    }
    return { version: SCHEMA_VERSION, videos: raw.videos.slice() };
  }

  function createEntry(meta) {
    meta = meta || {};
    return {
      videoId: meta.videoId == null ? "unknown" : String(meta.videoId),
      title: meta.title == null ? null : String(meta.title),
      startedAt: typeof meta.startedAt === "number" ? meta.startedAt : Date.now(),
      version: meta.version == null ? "unknown" : String(meta.version),
      settings: meta.settings || null,
      windows: [],
      gaps: [],
      captions: [],
      captionCount: 0,
      errors: [],
      truncated: false
    };
  }

  // Bounded push: keeps the NEWEST `max` items. Oldest-first ordering is
  // preserved throughout, so "drop the oldest" is always a shift from the
  // front, here and in the size guard.
  function pushCapped(list, item, max) {
    list.push(item);
    while (list.length > max) list.shift();
    return list;
  }

  // Upsert `entry` into `log` as the NEWEST video and trim the ring to
  // MAX_VIDEOS. Re-watching a video already present updates that entry in
  // place (by videoId) and moves it to the newest slot instead of creating
  // a duplicate — otherwise a page refresh, which starts a fresh session
  // for the same videoId, would burn two of the ten slots on one video.
  function mergeEntry(log, entry, maxVideos) {
    maxVideos = maxVideos || MAX_VIDEOS;
    var out = normalizeLog(log);
    var kept = [];
    for (var i = 0; i < out.videos.length; i++) {
      if (out.videos[i] && out.videos[i].videoId === entry.videoId) continue;
      kept.push(out.videos[i]);
    }
    kept.push(entry);
    while (kept.length > maxVideos) kept.shift();
    out.videos = kept;
    return out;
  }

  function serializedSize(log) {
    try {
      return JSON.stringify(log).length;
    } catch (e) {
      return Infinity;
    }
  }

  // Size guard. Drop order, per spec: oldest VIDEOS first, then oldest
  // WINDOWS within the oldest surviving video.
  //
  // The video-dropping phase deliberately stops at one video rather than
  // emptying the ring: the newest entry is the video the user is watching
  // right now, i.e. the one they are almost certainly asking about, so it
  // is never dropped whole — it gets trimmed from the inside instead.
  //
  // Within-entry trimming walks oldest-video-first and, inside each,
  // drops the oldest windows (the largest field by far, especially in
  // verbose mode) before falling back to the other lists. Any entry that
  // loses anything is stamped `truncated: true` so a reader can never
  // mistake a trimmed entry for a complete one.
  //
  // NOTE: entries are trimmed IN PLACE (normalizeLog copies the videos
  // array, not the entries in it). That is deliberate — the newest entry
  // is the live in-memory `current` object, and a window dropped to fit the
  // budget should stay dropped rather than being re-serialized on the next
  // flush and re-dropped forever.
  function enforceSizeCap(log, maxBytes) {
    maxBytes = maxBytes || MAX_BYTES;
    var out = normalizeLog(log);
    if (serializedSize(out) <= maxBytes) return out;

    // Phase 1: oldest videos first, down to a single (newest) entry.
    while (out.videos.length > 1 && serializedSize(out) > maxBytes) {
      out.videos.shift();
    }
    if (serializedSize(out) <= maxBytes) return out;

    // Phase 2: oldest windows within the oldest surviving video, then the
    // remaining lists, then (only if a single entry is somehow still over
    // budget with everything trimmed) the verbose transcripts are already
    // gone with their windows, so there is nothing left to shed and we
    // return the smallest form we can produce.
    var guard = 0;
    while (serializedSize(out) > maxBytes && guard++ < 100000) {
      var trimmed = false;
      for (var i = 0; i < out.videos.length && !trimmed; i++) {
        var e = out.videos[i];
        if (!e) continue;
        if (e.windows && e.windows.length) {
          e.windows.shift();
          e.truncated = true;
          trimmed = true;
        } else if (e.captions && e.captions.length) {
          e.captions.shift(); // captionCount deliberately survives the trim
          e.truncated = true;
          trimmed = true;
        } else if (e.gaps && e.gaps.length) {
          e.gaps.shift();
          e.truncated = true;
          trimmed = true;
        } else if (e.errors && e.errors.length) {
          e.errors.shift();
          e.truncated = true;
          trimmed = true;
        }
      }
      if (!trimmed) break; // nothing left anywhere to drop
    }
    return out;
  }

  // Round a media-time number to 2dp, preserving null/undefined and
  // rejecting NaN/Infinity. Every timestamp stored anywhere in this record
  // goes through here: raw floats like 12.340000000000002 are both noise
  // and, multiplied across a thousand windows, real bytes.
  function t2(n) {
    if (typeof n !== "number" || !isFinite(n)) return null;
    return Math.round(n * 100) / 100;
  }

  function normalizeWindow(w, verbose) {
    w = w || {};
    var matches = [];
    var rawMatches = w.matches || [];
    for (var i = 0; i < rawMatches.length; i++) {
      matches.push({ word: String(rawMatches[i].word), t: t2(rawMatches[i].t) });
    }
    var intervals = [];
    var rawIntervals = w.muteIntervals || [];
    for (var j = 0; j < rawIntervals.length; j++) {
      intervals.push({ start: t2(rawIntervals[j].start), end: t2(rawIntervals[j].end) });
    }
    var out = {
      t0: t2(w.t0),
      t1: t2(w.t1),
      transcriptWordCount: typeof w.transcriptWordCount === "number" ? w.transcriptWordCount : 0,
      matches: matches,
      muteIntervals: intervals
    };
    if (verbose && typeof w.text === "string" && w.text) out.text = w.text;
    return out;
  }

  // Which words a censorText() pass actually rewrote, derived by aligning
  // the original and censored strings token by token.
  //
  // This alignment is sound because of a specific property of
  // wordlist.js's censorTextCore: both its phrase path (censorPhrase maps
  // word-by-word over the phrase, preserving the whitespace splits) and
  // its single-token path (a regex replace of one token with censorWord's
  // output) preserve the whitespace-separated token COUNT. The one path
  // that does not is substringMode (used only by packs configured for it),
  // which can collapse or reshape tokens — that case is detected by the
  // length mismatch and reported as "unknown", so the caller records a
  // count without inventing a per-word attribution it cannot actually make.
  // Returns [] when nothing changed.
  function diffCensored(original, censored) {
    if (typeof original !== "string" || typeof censored !== "string") return [];
    if (original === censored) return [];
    var a = original.split(/\s+/);
    var b = censored.split(/\s+/);
    if (a.length !== b.length) return null; // caller: count-only, no attribution
    var out = [];
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) out.push({ original: a[i], censored: b[i] });
    }
    return out;
  }

  var PMDevlogCore = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_VIDEOS: MAX_VIDEOS,
    MAX_WINDOWS: MAX_WINDOWS,
    MAX_GAPS: MAX_GAPS,
    MAX_CAPTIONS: MAX_CAPTIONS,
    MAX_ERRORS: MAX_ERRORS,
    MAX_BYTES: MAX_BYTES,
    emptyLog: emptyLog,
    normalizeLog: normalizeLog,
    createEntry: createEntry,
    pushCapped: pushCapped,
    mergeEntry: mergeEntry,
    serializedSize: serializedSize,
    enforceSizeCap: enforceSizeCap,
    normalizeWindow: normalizeWindow,
    diffCensored: diffCensored,
    t2: t2
  };

  // ======================================================================
  // BROWSER WIRING — in-memory current entry + batched storage flush.
  // ======================================================================

  // Only the CURRENT video's entry is held in memory. The ring itself lives
  // in storage and is only ever touched through a read-modify-write at
  // flush time. This is deliberate: it means two tabs watching two videos
  // both end up in the ring instead of one tab's stale in-memory copy of
  // the whole log clobbering the other's, and it means this module holds
  // O(one video) of memory regardless of how long the browser session runs.
  var current = null;
  var verbose = false;
  var dirty = false;
  var flushTimer = null;
  var pendingErrors = [];
  // Media-time source, installed by content.js (which owns <video>
  // resolution — there are routinely several <video> elements on a YouTube
  // page and picking the wrong one is a solved problem over there, not one
  // worth solving twice). Until it is set, timestamps record as null rather
  // than as a wrong number.
  var timeSource = null;

  function hasLocalStorage() {
    return (
      typeof chrome !== "undefined" &&
      chrome &&
      chrome.storage &&
      chrome.storage.local &&
      typeof chrome.storage.local.get === "function" &&
      typeof chrome.storage.local.set === "function"
    );
  }

  function hasSyncStorage() {
    return (
      typeof chrome !== "undefined" &&
      chrome &&
      chrome.storage &&
      chrome.storage.sync &&
      typeof chrome.storage.sync.get === "function"
    );
  }

  function now() {
    return Date.now();
  }

  function mediaTime() {
    if (typeof timeSource !== "function") return null;
    try {
      return t2(timeSource());
    } catch (e) {
      return null;
    }
  }

  function setTimeSource(fn) {
    timeSource = typeof fn === "function" ? fn : null;
  }

  function markDirty() {
    dirty = true;
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer || !hasLocalStorage()) return;
    try {
      flushTimer = setTimeout(function () {
        flushTimer = null;
        flush();
      }, FLUSH_MS);
    } catch (e) {
      flushTimer = null;
    }
  }

  // Read-modify-write the ring. Never throws into a caller: every logging
  // entry point is on a hot path in the muting pipeline, and a storage
  // failure must degrade to "no debug log", never to "muting broke".
  function flush() {
    if (!dirty || !current || !hasLocalStorage()) return;
    dirty = false;
    var entry = current;
    try {
      chrome.storage.local.get(["pm_devlog"], function (items) {
        try {
          if (chrome.runtime && chrome.runtime.lastError) return;
          var merged = mergeEntry(items && items.pm_devlog, entry);
          merged = enforceSizeCap(merged, MAX_BYTES);
          chrome.storage.local.set({ pm_devlog: merged }, function () {
            // Swallow lastError explicitly: reading it is what stops Chrome
            // logging "Unchecked runtime.lastError" noise into the very
            // Errors page this feature exists to make unnecessary.
            if (chrome.runtime && chrome.runtime.lastError) return;
          });
        } catch (e) {
          /* ignore */
        }
      });
    } catch (e) {
      /* ignore */
    }
  }

  // Force an immediate flush (pagehide, video change). Cancels any pending
  // timer so the two paths can't both fire a write for the same state.
  function flushNow() {
    if (flushTimer) {
      try {
        clearTimeout(flushTimer);
      } catch (e) {}
      flushTimer = null;
    }
    flush();
  }

  // ---- public logging API ------------------------------------------------

  // Begin a new video's entry. Flushes the outgoing entry first, so the
  // video the user just left is durable before its in-memory copy is
  // dropped — a video change is exactly when the previous video's evidence
  // becomes the thing worth keeping.
  function startVideo(videoId, meta) {
    meta = meta || {};
    flushNow();
    current = createEntry({
      videoId: videoId,
      title: meta.title,
      version: meta.version,
      settings: meta.settings || null,
      startedAt: now()
    });
    // Attach anything logged before there was an entry to attach it to.
    for (var i = 0; i < pendingErrors.length; i++) {
      pushCapped(current.errors, pendingErrors[i], MAX_ERRORS);
    }
    pendingErrors = [];
    markDirty();
  }

  // Refine the entry's metadata after the fact. content.js calls this once
  // the player element has actually resolved, because at document_start
  // (when startVideo runs) document.title is still frequently the previous
  // page's title on a YouTube SPA navigation, and PMWordlist may not have
  // finished its first async settings refresh either.
  function updateMeta(meta) {
    if (!current || !meta) return;
    if (meta.title != null) current.title = String(meta.title);
    if (meta.version != null) current.version = String(meta.version);
    if (meta.settings) current.settings = meta.settings;
    markDirty();
  }

  function logWindow(w) {
    if (!current) return;
    pushCapped(current.windows, normalizeWindow(w, verbose), MAX_WINDOWS);
    markDirty();
  }

  function logGap(gap) {
    if (!current || !gap) return;
    var start = t2(gap.start);
    var end = t2(gap.end);
    if (start == null || end == null || end <= start) return;
    pushCapped(
      current.gaps,
      { start: start, end: end, mode: String(gap.mode || "unknown") },
      MAX_GAPS
    );
    markDirty();
  }

  // Record a caption censor pass. Takes the BEFORE and AFTER text of a
  // single caption node and stores only the words that actually changed
  // (see diffCensored) — never the surrounding caption text, which would
  // amount to persisting a transcript of the video.
  function logCaptionCensor(original, censored) {
    if (!current) return;
    var pairs = diffCensored(original, censored);
    if (pairs === null) {
      // Token counts didn't align (substringMode pack) — count it, but
      // don't guess at which word became which.
      current.captionCount++;
      markDirty();
      return;
    }
    if (!pairs.length) return;
    var t = mediaTime();
    for (var i = 0; i < pairs.length; i++) {
      current.captionCount++;
      pushCapped(
        current.captions,
        { t: t, original: pairs[i].original, censored: pairs[i].censored },
        MAX_CAPTIONS
      );
    }
    markDirty();
  }

  function logError(text) {
    var ev = { t: mediaTime(), wall: now(), text: String(text) };
    if (!current) {
      pushCapped(pendingErrors, ev, MAX_PENDING_ERRORS);
      return;
    }
    pushCapped(current.errors, ev, MAX_ERRORS);
    markDirty();
  }

  // ---- pm_devlogVerbose --------------------------------------------------
  function loadVerbose() {
    if (!hasSyncStorage()) return;
    try {
      chrome.storage.sync.get(["pm_devlogVerbose"], function (items) {
        if (chrome.runtime && chrome.runtime.lastError) return;
        verbose = !!(items && items.pm_devlogVerbose);
      });
    } catch (e) {
      /* ignore */
    }
  }

  if (hasSyncStorage() && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== "sync") return;
        if (changes.pm_devlogVerbose) verbose = !!changes.pm_devlogVerbose.newValue;
      });
    } catch (e) {
      /* ignore */
    }
  }
  loadVerbose();

  // Final flush when the page goes away. `pagehide` (not `unload`) for the
  // same reason content.js's stats flush uses it: it is the event that
  // actually fires on a bfcache-eligible navigation. content.js registers
  // its own pagehide handler for pm_stats; these are independent listeners
  // on independent state and don't need to coordinate.
  if (typeof window !== "undefined" && window.addEventListener) {
    try {
      window.addEventListener("pagehide", function () {
        flushNow();
      });
    } catch (e) {
      /* ignore */
    }
  }

  root.PMDevlog = {
    startVideo: startVideo,
    updateMeta: updateMeta,
    logWindow: logWindow,
    logGap: logGap,
    logCaptionCensor: logCaptionCensor,
    logError: logError,
    setTimeSource: setTimeSource,
    flushNow: flushNow,
    // exposed for tests/inspection; not part of the contract consumers use
    _core: PMDevlogCore,
    _current: function () { return current; },
    _verbose: function () { return verbose; }
  };

  // Also expose the core for Node-based unit testing via module.exports,
  // without turning this file into an ES module (same pattern as
  // shared/wordlist.js).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMDevlogCore: PMDevlogCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
