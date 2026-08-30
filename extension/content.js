// content.js — isolated world, document_start. Loaded after
// shared/wordlist.js (owned by another agent, defines globalThis.PMWordlist)
// and before captions.js.
//
// Responsibilities:
//  1. Relay MSE audio segments from capture.js (MAIN world, window.postMessage)
//     to background.js (chrome.runtime.connect port), base64-encoded.
//  2. Receive transcribed words + coverage deltas back from background, turn
//     profane words/phrases into padded/merged mute intervals using
//     PMWordlist, and enforce muting on the <video> element proactively
//     (setTimeout-armed against the schedule) with an rAF poll as backstop.
//  3. Persist the mute schedule + coverage per videoId across seeks — only a
//     real video change (RESET from capture.js) clears state.
(function () {
  'use strict';
  var TAG = '[PM]';
  // Padding presets (0.1.17) — PMWordlist.settings.padding ("tight"|"normal"|
  // "wide", default "normal", 8th settings key added by the wordlist agent's
  // UI). "normal" keeps the original 0.35/0.25 values (leading pad already
  // increased from a symmetric 0.25/0.25 after an early report of hearing
  // the first half of a word). Read fresh in applyWordsToIntervals (called
  // per-window) — no onChanged wiring needed: existing armed intervals keep
  // whatever padding they were built with, new windows just pick up
  // whatever's current the next time that function runs.
  var PADDING_PRESETS = {
    tight: { lead: 0.15, trail: 0.10 },
    normal: { lead: 0.35, trail: 0.25 },
    wide: { lead: 0.60, trail: 0.45 }
  };
  function currentPadding() {
    var pm = globalThis.PMWordlist;
    var key = (pm && pm.settings && pm.settings.padding) || 'normal';
    return PADDING_PRESETS[key] || PADDING_PRESETS.normal;
  }
  var MAX_WORD_DUR = 1.0; // clamp a single transcribed word's duration (Whisper timestamp smear mitigation)
  var STALL_MS = 15000; // no coverage growth while playing an uncovered region -> watchdog fires
  var FALLBACK_STALL_MS = 8000; // pause-catchup with zero coverage progress this long -> downgrade to muted playback (see tick())
  var COVERAGE_EPS = 0.05;

  // ---- log ring buffer (for the debug overlay's "Copy logs" button) -------
  // Every [PM]-tagged console line from this file also lands here, so the
  // user can hand us a complete log in one click instead of scraping
  // chrome://extensions' Errors page (which only shows warn/error, not the
  // full picture, and has burned real debugging time already).
  var LOG_RING_MAX = 1000;
  var logRing = [];
  function ringAppend(args) {
    var line = Array.prototype.map
      .call(args, function (a) {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch (e) {
          return String(a);
        }
      })
      .join(' ');
    logRing.push({ wallTime: Date.now(), line: line });
    if (logRing.length > LOG_RING_MAX) logRing.shift();
  }
  function TLOG() {
    ringAppend(arguments);
    console.log.apply(console, arguments);
  }
  function TWARN() {
    ringAppend(arguments);
    console.warn.apply(console, arguments);
  }
  function TERROR() {
    ringAppend(arguments);
    console.error.apply(console, arguments);
  }

  // ---- word matching (delegates entirely to shared/wordlist.js) -----------
  // 0.1.15 cleanup: the fallback wordlist/matching path (~55 LOC) this used
  // to carry for "shared/wordlist.js hasn't loaded" is deleted —
  // manifest.json's content_scripts entry lists shared/wordlist.js before
  // content.js in the SAME `js` array, and Chrome guarantees files within
  // one entry's `js` array execute in that listed order, so
  // globalThis.PMWordlist is always present by the time any of this file's
  // code runs. It was never actually reachable.
  function findMatches(words) {
    try {
      return globalThis.PMWordlist.findMatches(words) || [];
    } catch (e) {
      TERROR(TAG, 'PMWordlist.findMatches threw:', e);
      return [];
    }
  }

  // ---- settings ---------------------------------------------------------
  // PMWordlist.settings (owned by the wordlist agent) is the single source
  // of truth: {enabled, muteAudio, censorCaptions, safeMode, catchupMode}.
  // Its contract (CENSOR_NOTES.md) already guarantees `catchupMode` is
  // always exactly one of "mute"/"pause"/"play" and `safeMode` is already
  // derived as `catchupMode !== "play"` on THEIR side — this file used to
  // carry its own duplicate copy of that same derivation (plus a legacy
  // pm_safeMode-only migration path that's been dead since the popup
  // stopped writing pm_safeMode at all) for a fallback settings object that,
  // per the above, is never actually reachable. Deleted (0.1.15 cleanup) —
  // just trust the contract directly.
  function currentSettings() {
    var pm = globalThis.PMWordlist;
    var base = {
      enabled: pm.settings.enabled !== false,
      muteAudio: pm.settings.muteAudio !== false,
      catchupMode: pm.settings.catchupMode || 'mute',
      safeMode: pm.settings.safeMode !== false
    };
    base.debugOverlay = debugSettings.debugOverlay;
    return base;
  }

  // pm_debugOverlay is a debugging-only knob owned entirely by this file
  // (not part of the wordlist agent's PMWordlist.settings contract), read
  // directly from chrome.storage.sync. (0.1.15 cleanup: pm_timeOffsetMs
  // deleted — the manual calibration knob added in 0.1.7 was never actually
  // measured/set away from 0; the debug overlay's raw per-word timestamp
  // strip already gives everything needed to measure an offset if one is
  // ever found, without a dead knob sitting in the settings surface.)
  var debugSettings = { debugOverlay: false };
  // pm_showStatus (0.1.15): shows/hides the always-on status pill (separate
  // from the debug overlay) — default true, owned by the UI agent's popup
  // toggle, read the same way as the other debugging-adjacent knobs above.
  var statusSettings = { showStatus: true };
  function loadDebugSettings() {
    try {
      chrome.storage.sync.get({ pm_debugOverlay: false, pm_showStatus: true }, function (items) {
        if (chrome.runtime.lastError) return;
        debugSettings.debugOverlay = !!items.pm_debugOverlay;
        statusSettings.showStatus = items.pm_showStatus !== false;
      });
    } catch (e) {
      /* no chrome.storage available; keep defaults */
    }
  }
  loadDebugSettings();
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync') return;
      if (changes.pm_enabled) handleEnabledChanged(changes.pm_enabled.newValue !== false);
      if (changes.pm_catchupMode) {
        // Synchronous reaction to the raw NEW value (0.1.11 "lags super
        // hard" fix): PMWordlist.settings updates itself off this SAME
        // storage event asynchronously, so re-reading it here could still
        // be stale at this exact moment. The popup only ever writes a
        // valid "mute"/"pause"/"play" string directly (pm_safeMode hasn't
        // been written since the popup's old separate toggle was removed),
        // so no re-derivation is needed here either.
        handleCatchupModeChanged(changes.pm_catchupMode.newValue);
      }
      if (changes.pm_debugOverlay) debugSettings.debugOverlay = !!changes.pm_debugOverlay.newValue;
      if (changes.pm_showStatus) statusSettings.showStatus = changes.pm_showStatus.newValue !== false;
      // A muteAudio toggle-off must release any currently-engaged mute right
      // away, not wait for the next tick().
      if (changes.pm_muteAudio && changes.pm_muteAudio.newValue === false) releaseMute('mute-audio-disabled');
    });
  } catch (e) {}

  // ---- base64 helpers (chunked to avoid call-stack blowups on big arrays) -
  function uint8ToBase64(bytes) {
    var CHUNK = 0x8000;
    var binary = '';
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // ---- per-video session state (schedule, coverage) -----------------------
  // Persists across seeks; only replaced on an actual video-id change
  // (RESET from capture.js), per the "seek keeps everything" requirement.
  var session = null;

  function newSession(videoId) {
    return {
      videoId: videoId,
      intervals: [], // merged mute intervals [{start,end,word}]
      coveredIntervals: [], // merged transcribed coverage [{start,end}]
      allWords: [], // raw {word,start,end,matched} tokens near the playhead, for the debug overlay only
      allWordKeys: new Set(),
      prevMuted: null,
      forcedMute: false,
      muteReason: null,
      lastCoverageGrowthWall: Date.now(),
      lastStallRequestWall: 0,
      // Updated on every 'heartbeat' from offscreen (sent while it's
      // genuinely mid-transcription) — the stall watchdog requires BOTH no
      // coverage growth AND no recent heartbeat before firing, so a merely
      // slow attempt (long window, cold model, CPU contention) doesn't get
      // killed before it can finish.
      lastHeartbeatWall: Date.now(),
      // Fallback ladder (0.1.12): true while pause-catchup has been
      // downgraded to muted PLAYBACK for the CURRENT stall because pausing
      // itself made no coverage progress — see tick(). Reset once covered.
      catchupFallbackActive: false,
      // DRM/undecodable content (0.1.15): set true on an 'unanalyzable' port
      // message from offscreen — permanently suppresses safe-mode-uncovered
      // muting/pausing for this session (see runTickLogic()'s `uncovered`
      // computation) so a video that will never decode is never left
      // muted/paused forever waiting for coverage that can't arrive.
      unanalyzable: false,
      // Status pill + mute counting (0.1.15) — per-video count of matched
      // intervals actually muted through; activeMuteCountKey tracks the
      // CURRENTLY-active counted interval so re-entering the SAME interval
      // later (e.g. after a seek-back replay) counts again, but sitting
      // inside one interval across several ticks doesn't double-count it.
      mutedCount: 0,
      activeMuteCountKey: null,
      lifetimeVideoCounted: false, // videosProtected (chrome.storage.local pm_stats) increments once per video, on its first counted mute
      // [PM-CATCHUP-TIME] measurement (0.1.17) — set on a seek landing
      // uncovered, cleared (and logged) once coverage reaches the playhead.
      catchupMeasureStart: null,
      catchupMeasureTargetT: null,
      // Actionable status pill inputs (0.1.18) — mirrors what offscreen
      // tracks internally, built here from data content.js ALREADY sees
      // flowing through it (capture.js's own segment growth info, and the
      // rtf/computeMs already returned with every 'words' message) — no
      // new pipeline plumbing needed, purely local bookkeeping for display.
      bufferedRanges: [], // merged [{start,end}] — same interval-set concept as offscreen's s.bufferedRanges, built the same way from growthAbsStart/growthAbsEnd
      lastBufferedGrowthWall: Date.now(), // last time bufferedRanges actually grew — "is capture still making progress" signal
      lastKnownRtf: null // last computeMs-based rtf, for a rough ETA estimate
    };
  }

  function resetSession(videoId) {
    TLOG(TAG, 'session reset (video changed), videoId=' + videoId);
    releaseMute('video-changed');
    clearArmedTimers();
    session = newSession(videoId);
    unanalyzableNoticeShown = false; // a new video gets its own fresh chance (and notice) — see the 'unanalyzable' handler
    safePortPost({ type: 'reset', videoId: videoId });
    logVideoInfoOnce(videoId);
  }

  // Mirrors capture.js's own currentVideoId() — used ONLY to force a reset
  // at THIS file's own startup (see the call after connectPort() below),
  // independent of capture.js's video-id-change detection.
  function currentVideoIdFromLocation() {
    try {
      var params = new URLSearchParams(location.search);
      return params.get('v') || location.pathname;
    } catch (e) {
      return location.href;
    }
  }

  // One line establishing ground truth for "which video, which element, how
  // long" at the start of every session — the first thing worth checking
  // when reconstructing a pasted log's timeline. getVideo() may not have
  // resolved yet at the exact moment of reset (video element not created),
  // so retry briefly.
  function logVideoInfoOnce(videoId, attempt) {
    attempt = attempt || 0;
    var video = getVideo();
    if (!video && attempt < 10) {
      setTimeout(function () { logVideoInfoOnce(videoId, attempt + 1); }, 300);
      return;
    }
    TLOG(
      TAG,
      '[PM-SESSION] videoId=' + videoId +
        ' duration=' + (video && !isNaN(video.duration) ? video.duration.toFixed(2) : 'unknown') +
        ' videoElement=' + (video ? video.className || '(no class)' : 'not found') +
        ' settings=' + JSON.stringify(currentSettings()) +
        ' padding=' + JSON.stringify(currentPadding())
    );
  }

  function mergeRangeInto(list, start, end) {
    list.push({ start: start, end: end });
    list.sort(function (a, b) { return a.start - b.start; });
    var merged = [];
    for (var i = 0; i < list.length; i++) {
      var cur = list[i];
      var last = merged[merged.length - 1];
      if (last && cur.start <= last.end + COVERAGE_EPS) last.end = Math.max(last.end, cur.end);
      else merged.push({ start: cur.start, end: cur.end });
    }
    list.length = 0;
    for (var j = 0; j < merged.length; j++) list.push(merged[j]);
  }

  function isCovered(t) {
    var ivals = session.coveredIntervals;
    for (var i = 0; i < ivals.length; i++) {
      if (t >= ivals[i].start - COVERAGE_EPS && t < ivals[i].end + COVERAGE_EPS) return true;
    }
    return false;
  }

  // ---- mute scheduling ------------------------------------------------------
  // Clamp per-word duration before padding (transformers.js word-timestamp
  // smear mitigation — live testing showed some "words" reported as 5-15s
  // long on noisy content, far more than a plausible clean-audio pause), run
  // PMWordlist.findMatches, and build padded mute intervals. Pure function
  // (no session access) so it's reusable from both the normal incremental
  // path (addWords) and a full resync after a port reconnect (handleResync).
  function applyWordsToIntervals(rawWords) {
    var tokens = [];
    for (var i = 0; i < rawWords.length; i++) {
      var w = rawWords[i];
      var start = w.start, end = w.end;
      if (end - start > MAX_WORD_DUR) {
        TWARN(TAG, 'CLAMP word="' + w.word + '" dur=' + (end - start).toFixed(2) + 's -> ' + MAX_WORD_DUR + 's');
        end = start + MAX_WORD_DUR;
      }
      tokens.push({ word: w.word, start: start, end: end, matched: false });
    }

    var wordStrings = [];
    for (i = 0; i < tokens.length; i++) wordStrings.push(tokens[i].word);
    var matches = findMatches(wordStrings);
    var pad = currentPadding();

    var newIntervals = [];
    for (i = 0; i < matches.length; i++) {
      var m = matches[i];
      var i0 = m.index, i1 = m.index + (m.length || 1) - 1;
      if (i0 < 0 || i1 >= tokens.length || i1 < i0) continue;
      var ivStart = Math.max(0, tokens[i0].start - pad.lead);
      var ivEnd = tokens[i1].end + pad.trail;
      var label = wordStrings.slice(i0, i1 + 1).join(' ');
      newIntervals.push({ start: ivStart, end: ivEnd, word: label });
      for (var k = i0; k <= i1; k++) tokens[k].matched = true;
    }
    return { intervals: newIntervals, tokens: tokens };
  }

  // Record raw tokens for the debug overlay (word strip near the playhead) —
  // separate from the mute schedule since it needs EVERY word, not just
  // matches. Deduped by word+roundedStart so overlap-region re-transcriptions
  // don't accumulate duplicates; capped so a long session can't grow this
  // unboundedly (the overlay only ever shows a ±5s window anyway).
  function recordAllWords(tokens) {
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      var key = tok.word.toLowerCase() + '@' + tok.start.toFixed(1);
      if (session.allWordKeys.has(key)) continue;
      session.allWordKeys.add(key);
      session.allWords.push(tok);
    }
    if (session.allWords.length > 600) {
      var drop = session.allWords.length - 600;
      for (var j = 0; j < drop; j++) session.allWordKeys.delete(session.allWords[j].word.toLowerCase() + '@' + session.allWords[j].start.toFixed(1));
      session.allWords.splice(0, drop);
    }
  }

  function addWords(videoId, rawWords, windowStartS, windowEndS, wallMs, rtf, modelRtf, decodeMs, queueMs, computeMs) {
    if (!session || session.videoId !== videoId) return;

    // Status-pill ETA input (0.1.18): last measured compute-only rtf, same
    // basis offscreen uses for its own rtf-aware cold-window sizing.
    if (computeMs != null && typeof windowStartS === 'number' && typeof windowEndS === 'number' && windowEndS > windowStartS) {
      session.lastKnownRtf = computeMs / 1000 / (windowEndS - windowStartS);
    } else if (modelRtf != null) {
      session.lastKnownRtf = modelRtf;
    }

    var result = applyWordsToIntervals(rawWords);
    var newIntervals = result.intervals;
    recordAllWords(result.tokens);
    if (newIntervals.length) {
      for (var i = 0; i < newIntervals.length; i++) session.intervals.push(newIntervals[i]);
      mergeIntervals();
    }

    if (typeof windowStartS === 'number' && typeof windowEndS === 'number') {
      mergeRangeInto(session.coveredIntervals, windowStartS, windowEndS);
      session.lastCoverageGrowthWall = Date.now();
    }

    armSchedule();

    // Log the raw transcript text too, not just counts: background.js/
    // offscreen's own "[PM] window ... text=[...]" log lives in the service
    // worker / offscreen document console, which is NOT visible to a
    // per-tab console reader (e.g. Chrome DevTools on the page, or
    // automation reading the page's console) — this is the only place the
    // actual transcribed words are ever visible from the tab itself, which
    // matters for diagnosing "did the transcript even contain word X".
    var firstWordS = rawWords.length ? Math.min.apply(null, rawWords.map(function (w) { return w.start; })).toFixed(2) : 'NA';
    var lastWordS = rawWords.length ? Math.max.apply(null, rawWords.map(function (w) { return w.end; })).toFixed(2) : 'NA';
    TLOG(
      TAG,
      '[PM-WINDOW] mediaSpan=[' + (typeof windowStartS === 'number' ? windowStartS.toFixed(2) : 'NA') + ',' + (typeof windowEndS === 'number' ? windowEndS.toFixed(2) : 'NA') + ')' +
        ' wallMs=' + (wallMs != null ? Math.round(wallMs) : 'NA') +
        // Split (0.1.18): wallMs used to bundle demux/decode + queue-wait-
        // for-the-shared-worker-mutex + actual compute into one number — a
        // live paste showed wallMs-derived rtf of 3-8 next to modelRtf of
        // 0.2-0.5, hiding that almost all of it was QUEUE wait (a stale
        // session's backlog competing for the same worker), not compute.
        ' decodeMs=' + (decodeMs != null ? Math.round(decodeMs) : 'NA') +
        ' queueMs=' + (queueMs != null ? Math.round(queueMs) : 'NA') +
        ' computeMs=' + (computeMs != null ? Math.round(computeMs) : 'NA') +
        ' rtf=' + (rtf != null ? rtf.toFixed(3) : 'NA') +
        ' modelRtf=' + (modelRtf != null ? modelRtf.toFixed(3) : 'NA') +
        ' words received=' + rawWords.length + ' muted=' + newIntervals.length +
        ' firstWord=' + firstWordS + ' lastWord=' + lastWordS +
        ' coverage=[' + session.coveredIntervals.map(function (iv) {
          return iv.start.toFixed(1) + '-' + iv.end.toFixed(1);
        }).join(',') + ']' +
        ' text=[' + rawWords.map(function (w) { return w.word; }).join(' ') + ']'
    );
    // Machine-parseable per-word timestamps, tab-visible — the deterministic
    // caption-correlation check (verify/caption_correlate.mjs) reads these
    // rather than eyeballing the debug overlay. Emitted after clamping (the
    // times actually used for muting), one line per addWords batch.
    TLOG(TAG, 'WORDTIMES', JSON.stringify(result.tokens.map(function (t) { return { w: t.word, s: +t.start.toFixed(3), e: +t.end.toFixed(3) }; })));
  }

  // Full resync after a port reconnect: offscreen sends everything it holds
  // for this session (words computed while the port was down must not be
  // silently lost) — this REPLACES local state rather than merging, since it
  // is authoritative.
  function handleResync(videoId, words, coveredIntervals) {
    if (!session || session.videoId !== videoId) return;
    TLOG(TAG, 'resync received:', (words || []).length, 'words,', (coveredIntervals || []).length, 'covered intervals');
    var result = applyWordsToIntervals(words || []);
    session.intervals = result.intervals;
    session.allWords = [];
    session.allWordKeys = new Set();
    recordAllWords(result.tokens);
    mergeIntervals();
    session.coveredIntervals = [];
    for (var i = 0; i < (coveredIntervals || []).length; i++) {
      mergeRangeInto(session.coveredIntervals, coveredIntervals[i].start, coveredIntervals[i].end);
    }
    session.lastCoverageGrowthWall = Date.now();
    armSchedule();
  }

  function mergeIntervals() {
    session.intervals.sort(function (a, b) { return a.start - b.start; });
    var merged = [];
    for (var i = 0; i < session.intervals.length; i++) {
      var cur = session.intervals[i];
      var last = merged[merged.length - 1];
      if (last && cur.start <= last.end) {
        last.end = Math.max(last.end, cur.end);
        if (last.word.indexOf(cur.word) === -1) last.word = last.word + '+' + cur.word;
      } else {
        merged.push({ start: cur.start, end: cur.end, word: cur.word });
      }
    }
    session.intervals = merged;
  }

  function inMutedInterval(t) {
    var ivals = session.intervals;
    for (var i = 0; i < ivals.length; i++) {
      if (t >= ivals[i].start && t < ivals[i].end) return ivals[i];
    }
    return null;
  }

  // YouTube pages routinely contain MULTIPLE <video> elements (inline-preview
  // player from SPA nav, miniplayer remnants, ad-player variants) — a naive
  // querySelector('video') grabs the FIRST in DOM order, which can be a
  // dormant one (readyState 0, currentTime frozen) while the real player
  // plays elsewhere, unmuted, unmonitored. Prefer the known real-player
  // selector; fall back to the largest rendered element with data, then
  // largest overall. Cached (invalidated on SPA nav) since this runs every
  // rAF frame via tick().
  var cachedVideoEl = null;
  function resolveRealVideo() {
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
  function getVideo() {
    if (cachedVideoEl && cachedVideoEl.isConnected) return cachedVideoEl;
    cachedVideoEl = resolveRealVideo();
    return cachedVideoEl;
  }
  document.addEventListener('yt-navigate-finish', function () { cachedVideoEl = null; }, true);

  // ---- engage/release: every call is logged with an explicit reason so
  // there is never a silent "why is this muted" state. -----------------------
  function engageMute(reason, intervalInfo) {
    var video = getVideo();
    if (!video || !session) return;
    if (session.forcedMute) return; // already forced-muted for some reason; don't clobber prevMuted
    session.prevMuted = video.muted;
    video.muted = true;
    session.forcedMute = true;
    session.muteReason = reason;
    TLOG(
      TAG,
      'MUTE engaged t=' + video.currentTime.toFixed(2) + ' reason=' + reason +
        (intervalInfo ? ' interval=[' + intervalInfo.start.toFixed(2) + ',' + intervalInfo.end.toFixed(2) + ') word=' + intervalInfo.word : '')
    );
  }

  function releaseMute(reason) {
    var video = getVideo();
    if (!session || !session.forcedMute) return;
    if (video) video.muted = session.prevMuted;
    var prevReason = session.muteReason;
    session.forcedMute = false;
    session.muteReason = null;
    session.prevMuted = null;
    TLOG(TAG, 'MUTE released t=' + (video ? video.currentTime.toFixed(2) : 'NA') + ' reason=' + reason + ' (was: ' + prevReason + ')');
  }

  // ---- mute counting + lifetime stats (0.1.15) -----------------------------
  // Per-video count (session.mutedCount) drives the status pill; lifetime
  // totals persist across videos/sessions in chrome.storage.local under
  // pm_stats — schema is exactly {totalMuted, videosProtected} per the
  // popup's contract. chrome.storage.local (not sync) since this is
  // write-frequent and sync has tighter per-item write-rate limits.
  var STATS_FLUSH_MS = 10000;
  var pendingStatsDelta = { totalMuted: 0, newVideoProtected: false };
  var statsFlushTimer = null;

  function countMute(interval) {
    if (!session) return;
    session.mutedCount = (session.mutedCount || 0) + 1;
    var wordCount = interval.word.split(' ').length;
    // Ensure the counter and the existing MUTE log lines agree (per the
    // coordinator's explicit ask) — this is a distinct, greppable line
    // right alongside the MUTE engaged/released lines already logged by
    // engageMute()/releaseMute() for the same interval.
    TLOG(
      TAG,
      '[PM-COUNT] muted #' + session.mutedCount + ' this video: "' + interval.word + '"' +
        (wordCount > 1 ? ' (' + wordCount + '-word phrase)' : '')
    );
    var isFirstForVideo = !session.lifetimeVideoCounted;
    session.lifetimeVideoCounted = true;
    queueStatsIncrement(1, isFirstForVideo);
  }

  function queueStatsIncrement(muteDelta, isNewVideoProtected) {
    pendingStatsDelta.totalMuted += muteDelta;
    if (isNewVideoProtected) pendingStatsDelta.newVideoProtected = true;
    if (!statsFlushTimer) statsFlushTimer = setTimeout(flushStats, STATS_FLUSH_MS);
  }

  function flushStats() {
    statsFlushTimer = null;
    var delta = pendingStatsDelta;
    pendingStatsDelta = { totalMuted: 0, newVideoProtected: false };
    if (delta.totalMuted === 0 && !delta.newVideoProtected) return;
    try {
      chrome.storage.local.get({ pm_stats: { totalMuted: 0, videosProtected: 0 } }, function (items) {
        if (chrome.runtime.lastError) return;
        var stats = items.pm_stats || { totalMuted: 0, videosProtected: 0 };
        stats.totalMuted = (stats.totalMuted || 0) + delta.totalMuted;
        if (delta.newVideoProtected) stats.videosProtected = (stats.videosProtected || 0) + 1;
        chrome.storage.local.set({ pm_stats: stats });
      });
    } catch (e) {}
  }
  // Flush on pagehide too — a throttled 10s timer alone would lose whatever
  // hadn't flushed yet if the tab/page goes away first.
  window.addEventListener('pagehide', function () {
    if (statsFlushTimer) {
      clearTimeout(statsFlushTimer);
      statsFlushTimer = null;
    }
    flushStats();
  });

  // ---- proactive scheduling: arm setTimeouts against the interval list so
  // muting engages at the exact moment, independent of rAF cadence/throttling
  // (rAF loop below remains as a backstop for drift/pause/resume cases). -----
  var armedTimers = [];
  function clearArmedTimers() {
    for (var i = 0; i < armedTimers.length; i++) clearTimeout(armedTimers[i]);
    armedTimers = [];
  }

  function armSchedule() {
    clearArmedTimers();
    var video = getVideo();
    if (!video || !session) return;
    var settings = currentSettings();
    if (!settings.enabled || !settings.muteAudio) return;
    var rate = video.playbackRate || 1;
    var now = video.currentTime;

    for (var i = 0; i < session.intervals.length; i++) {
      var iv = session.intervals[i];
      if (iv.end <= now) continue; // already fully in the past
      if (iv.start > now) {
        var startDelayMs = ((iv.start - now) / rate) * 1000;
        armedTimers.push(
          setTimeout(
            (function (interval) {
              return function () {
                var v = getVideo();
                if (v && v.currentTime >= interval.start - 0.05 && v.currentTime < interval.end) {
                  engageMute('word:' + interval.word, interval);
                }
              };
            })(iv),
            Math.max(0, startDelayMs)
          )
        );
      } else {
        engageMute('word:' + iv.word, iv); // already inside the interval right now
      }
      var endDelayMs = ((iv.end - now) / rate) * 1000;
      armedTimers.push(
        setTimeout(
          (function (interval) {
            return function () {
              var v = getVideo();
              if (!v || !session.forcedMute) return;
              var vt = v.currentTime;
              // FIXED (0.1.15): this used to release purely on
              // !inMutedInterval(vt), WITHOUT the coverage check tick()
              // applies — releasing a word-level mute at its own end time
              // even while the playhead had ALSO drifted into (or the
              // schedule was armed slightly ahead of) an uncovered safe-mode
              // region left that region briefly unmuted: a real audio leak,
              // worst when the tab is backgrounded and this armed timer is
              // the ONLY thing firing (rAF is throttled/suspended while
              // hidden — see the visibilitychange backstop below). Mirror
              // tick()'s exact release condition instead of a narrower one.
              var settingsNow = currentSettings();
              var stillUncovered = settingsNow.safeMode && !isCovered(vt);
              if (!inMutedInterval(vt) && !stillUncovered) {
                releaseMute('interval-ended:' + interval.word);
              }
            };
          })(iv),
          Math.max(0, endDelayMs)
        )
      );
    }
  }

  // ---- catch-up mode "pause": instead of muting through an uncovered
  // region, pause playback and show a minimal "Analyzing audio…" overlay,
  // auto-resuming once coverage catches up. Never fights the user: any
  // pause/play we didn't ourselves initiate immediately releases our claim.
  var catchupPausedByUs = false;
  var suppressNextPauseEvent = false;
  var suppressNextPlayEvent = false;
  var analyzingOverlayEl = null;

  // ---- orphaned-content-script UX: when the extension is reloaded/updated
  // (dev iteration, or an auto-update), any already-injected content script
  // instance is orphaned — chrome.runtime.connect()/sendMessage() start
  // throwing "Extension context invalidated," and it silently stops doing
  // anything at all (no mute, no captions censoring) with zero visible
  // signal to the user. Reported live twice now (mistaken for a real bug).
  // Detect it and say so on the page instead of failing silently. -----------
  var contextInvalidBannerShown = false;
  function isExtensionContextValid() {
    try {
      return !!(chrome && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }
  function showContextInvalidBanner() {
    if (contextInvalidBannerShown) return;
    contextInvalidBannerShown = true;
    TERROR(TAG, 'extension context invalidated (extension was reloaded/updated) — this page needs a refresh to re-enable profanity muting');
    var video = getVideo();
    var container = video ? video.closest('.html5-video-player') || video.parentElement : document.body;
    if (!container) return;
    var banner = document.createElement('div');
    banner.textContent = 'Profanity Muter was updated — refresh this page to re-enable';
    banner.style.cssText =
      'position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#c0392b;color:#fff;font:12px/1.4 sans-serif;padding:5px 12px;border-radius:4px;' +
      'pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,0.4);';
    if (container === document.body) {
      banner.style.position = 'fixed';
    } else if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(banner);
  }

  // DRM/undecodable content (0.1.15) — see the 'unanalyzable' port message
  // handler. Never left silent: a rented/protected movie that can't be
  // transcribed should say so, not just quietly stop muting.
  var unanalyzableNoticeShown = false;
  function showUnanalyzableNotice() {
    if (unanalyzableNoticeShown) return;
    unanalyzableNoticeShown = true;
    var video = getVideo();
    var container = video ? video.closest('.html5-video-player') || video.parentElement : document.body;
    if (!container) return;
    var notice = document.createElement('div');
    notice.textContent = "Profanity Muter can't analyze this video's audio (protected content) — muting disabled for this video";
    notice.style.cssText =
      'position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#555;color:#fff;font:12px/1.4 sans-serif;padding:5px 12px;border-radius:4px;' +
      'pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,0.4);';
    if (container === document.body) {
      notice.style.position = 'fixed';
    } else if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(notice);
  }

  function showAnalyzingOverlay(show) {
    var video = getVideo();
    if (show) {
      if (analyzingOverlayEl || !video) return;
      analyzingOverlayEl = document.createElement('div');
      analyzingOverlayEl.textContent = 'Analyzing audio…';
      analyzingOverlayEl.style.cssText =
        'position:absolute;top:8px;left:8px;z-index:2147483647;background:rgba(0,0,0,0.65);' +
        'color:#fff;font:12px/1.4 sans-serif;padding:3px 8px;border-radius:4px;pointer-events:none;';
      var container = video.closest('.html5-video-player') || video.parentElement;
      if (container) {
        if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
        container.appendChild(analyzingOverlayEl);
      }
    } else if (analyzingOverlayEl) {
      if (analyzingOverlayEl.parentElement) analyzingOverlayEl.parentElement.removeChild(analyzingOverlayEl);
      analyzingOverlayEl = null;
    }
  }

  // ---- pm_debugOverlay: an instrument for measuring the reported "off by
  // one word" / small systematic timing offset. Shows current t, coverage
  // status, a ±5s strip of raw transcript words with live/matched
  // highlighting, and upcoming scheduled mute intervals — the user reads a
  // word's highlight moment against when they actually hear it to measure
  // lead/lag. Deliberately plain DOM (no framework), pointer-events:none,
  // updated on its own ~4Hz timer independent of tick()'s rAF loop so it
  // keeps working even if muting itself is disabled. ------------------------
  var debugOverlayEl = null;
  var debugOverlayContentEl = null;
  var debugOverlayButtonEl = null;
  var debugOverlayTimer = null;

  function ensureDebugOverlayEl() {
    if (debugOverlayEl) return debugOverlayEl;
    var video = getVideo();
    if (!video) return null;
    debugOverlayEl = document.createElement('div');
    debugOverlayEl.style.cssText =
      'position:absolute;bottom:40px;left:8px;right:8px;z-index:2147483647;' +
      'background:rgba(0,0,0,0.78);color:#eee;font:11px/1.5 monospace;' +
      'padding:6px 8px;border-radius:4px;pointer-events:none;white-space:pre-wrap;' +
      'max-height:40%;overflow:hidden;';

    debugOverlayContentEl = document.createElement('div');
    debugOverlayEl.appendChild(debugOverlayContentEl);

    // The overlay itself is pointer-events:none (must never intercept clicks
    // on the player underneath) EXCEPT this one button, which needs a real
    // user gesture for navigator.clipboard.writeText to succeed anyway.
    debugOverlayButtonEl = document.createElement('button');
    debugOverlayButtonEl.textContent = 'Copy logs';
    debugOverlayButtonEl.style.cssText =
      'pointer-events:auto;margin-top:4px;font:11px monospace;padding:2px 8px;' +
      'border-radius:3px;border:1px solid #666;background:#333;color:#eee;cursor:pointer;';
    debugOverlayButtonEl.addEventListener('click', function (ev) {
      ev.stopPropagation();
      copyLogsToClipboard(debugOverlayButtonEl);
    });
    debugOverlayEl.appendChild(debugOverlayButtonEl);

    var container = video.closest('.html5-video-player') || video.parentElement;
    if (container) {
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      container.appendChild(debugOverlayEl);
    }
    return debugOverlayEl;
  }

  function copyLogsToClipboard(button) {
    var video = getVideo();
    var version = 'unknown';
    try {
      version = chrome.runtime.getManifest().version;
    } catch (e) {}
    var header =
      '=== Profanity Muter debug log === version=' + version +
      ' videoId=' + (session ? session.videoId : 'none') +
      ' t=' + (video ? video.currentTime.toFixed(2) : 'NA') +
      ' copiedAt=' + new Date().toISOString() + '\n' +
      '(paste this whole block — every line needed to reconstruct the pipeline timeline is here)\n';
    var body = logRing.map(function (entry) { return new Date(entry.wallTime).toISOString() + ' ' + entry.line; }).join('\n');
    var text = header + body;
    var done = function (ok) {
      var original = 'Copy logs';
      button.textContent = ok ? 'copied ✓' : 'copy failed';
      setTimeout(function () { button.textContent = original; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      done(false);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; });
  }

  function renderDebugOverlay() {
    var video = getVideo();
    if (!video || !session) return;
    var el = ensureDebugOverlayEl();
    if (!el) return;
    var t = video.currentTime;
    var covered = isCovered(t);

    var nearby = session.allWords
      .filter(function (w) { return w.end >= t - 5 && w.start <= t + 5; })
      .sort(function (a, b) { return a.start - b.start; });
    var strip = nearby
      .map(function (w) {
        var live = t >= w.start && t < w.end;
        var label = escapeHtml(w.word) + '[' + w.start.toFixed(2) + '-' + w.end.toFixed(2) + ']';
        if (live && w.matched) return '<span style="background:#c0392b;color:#fff;font-weight:bold">*' + label + '*</span>';
        if (live) return '<span style="background:#f1c40f;color:#000;font-weight:bold">' + label + '</span>';
        if (w.matched) return '<span style="color:#ff6b6b">' + label + '</span>';
        return label;
      })
      .join(' ');

    var upcoming = session.intervals
      .filter(function (iv) { return iv.end > t; })
      .sort(function (a, b) { return a.start - b.start; })
      .slice(0, 4)
      .map(function (iv) { return '[' + iv.start.toFixed(2) + '-' + iv.end.toFixed(2) + '] ' + escapeHtml(iv.word); })
      .join('  ');

    debugOverlayContentEl.innerHTML =
      '<b>[PM debug]</b> t=' + t.toFixed(2) + '  coverage=' + (covered ? 'COVERED' : 'UNCOVERED') + '\n' +
      'words (t±5s): ' + (strip || '(none yet)') + '\n' +
      'upcoming mutes: ' + (upcoming || '(none)');
  }

  function setDebugOverlayActive(active) {
    if (active && !debugOverlayTimer) {
      debugOverlayTimer = setInterval(renderDebugOverlay, 250); // ~4x/s per spec
      renderDebugOverlay();
    } else if (!active && debugOverlayTimer) {
      clearInterval(debugOverlayTimer);
      debugOverlayTimer = null;
      if (debugOverlayEl && debugOverlayEl.parentElement) debugOverlayEl.parentElement.removeChild(debugOverlayEl);
      debugOverlayEl = null;
      debugOverlayContentEl = null;
      debugOverlayButtonEl = null;
    }
  }
  // Poll the setting rather than wiring a dedicated onChanged branch: cheap,
  // and naturally handles PMWordlist-vs-fallback source switching too.
  // Gated on `enabled` too (0.1.13): pm_enabled=false must turn the debug
  // overlay off along with everything else — it was previously gated only
  // on pm_debugOverlay, so it (and its own console chatter) stayed visible
  // even with the whole extension "disabled", which is exactly the kind of
  // visible-when-it-shouldn't-be state this fix targets.
  setInterval(function () {
    var settings = currentSettings();
    setDebugOverlayActive(settings.enabled && settings.debugOverlay);
  }, 500);

  // ---- status pill (0.1.15, made ACTIONABLE in 0.1.18) ---------------------
  // Small, always-on, subtle indicator — separate from the debug overlay
  // (which is off by default and verbose). Hideable via pm_showStatus.
  //
  // User feedback on the plain 0.1.15 pill: when uncovered, there was no way
  // to tell whether pausing-and-waiting would make progress (audio already
  // captured, just queued/processing) or whether they needed to keep
  // playing (to make YouTube fetch more audio in the first place). The
  // generic "Analyzing…" collapsed two very different situations — plus a
  // third, rarer one — into one unhelpful label. Now data-driven:
  //   - "Protected": coverage extends >=5s past the playhead. Nothing to do.
  //   - "Analyzing — safe to pause (~Ns)": the playhead's own region IS
  //     captured (in bufferedRanges) and just hasn't been transcribed yet —
  //     pausing is fine, it WILL finish; ETA is remaining-uncovered-audio
  //     near the playhead times the last measured rtf, capped at 30s.
  //   - "Buffering + analyzing…": NOT captured yet, but capture is actively
  //     growing (a segment landed in the last ~3s) — still fine to wait,
  //     YouTube is still fetching.
  //   - "Press play to load audio": NOT captured, and NO capture growth for
  //     ~4s — YouTube has stopped fetching (e.g. paused before the buffer
  //     reached this position). This is the ONE state needing user action.
  //   - "Off": DRM/unanalyzable (unchanged from before).
  // This is presentation only — every input (bufferedRanges, coverage,
  // growth recency, rtf) already exists; see the bookkeeping added above.
  var statusPillEl = null;
  var STATUS_GROWTH_RECENT_MS = 3000; // capture actively growing if a segment landed within this long
  var STATUS_GROWTH_STALLED_MS = 4000; // capture has stopped fetching if nothing landed for this long
  // 0.1.19: the pill's whole state/ETA judges only the playhead's own
  // protection horizon, never the full uncovered backlog further ahead —
  // see the "0.1.19" PIPELINE_NOTES entry for why that distinction matters
  // (transcription intentionally trails buffering, so "everything ahead of
  // the playhead" is never fully covered during normal playback).
  var PROTECT_MARGIN = 5; // seconds of lookahead that must be covered to call it "Protected"

  function uncoveredDurationWithin(intervals, lo, hi) {
    var coveredS = 0;
    for (var i = 0; i < intervals.length; i++) {
      var start = Math.max(intervals[i].start, lo), end = Math.min(intervals[i].end, hi);
      if (end > start) coveredS += end - start;
    }
    return Math.max(0, hi - lo - coveredS);
  }

  function computeStatusState() {
    if (!session) return null;
    if (session.unanalyzable) return { kind: 'off' };
    var video = getVideo();
    if (!video) return null;
    var t = video.currentTime;
    var horizonEnd = t + PROTECT_MARGIN;
    // "Protected" means the whole [t, t+margin] window is covered, not just
    // its two endpoints — a gap in the middle (real, given how transcription
    // windows land) must not read as protected.
    if (uncoveredDurationWithin(session.coveredIntervals, t, horizonEnd) <= COVERAGE_EPS) {
      return { kind: 'protected' };
    }

    var playheadRange = null;
    for (var i = 0; i < session.bufferedRanges.length; i++) {
      var r = session.bufferedRanges[i];
      if (t >= r.start - 0.5 && t < r.end) {
        playheadRange = r;
        break;
      }
    }

    if (playheadRange) {
      // Captured already — just queued/processing. ETA from how much of
      // the playhead's own protection HORIZON — not the whole captured
      // range, which can (and normally does) extend far past the horizon
      // since buffering intentionally leads transcription — is still
      // uncovered.
      var uncoveredAheadS = uncoveredDurationWithin(session.coveredIntervals, t, Math.min(horizonEnd, playheadRange.end));
      var rtf = session.lastKnownRtf != null ? Math.min(0.85, Math.max(0.1, session.lastKnownRtf)) : 0.3;
      var etaS = Math.min(30, Math.max(1, Math.ceil(uncoveredAheadS * rtf)));
      return { kind: 'analyzing-safe', etaS: etaS };
    }

    var sinceGrowthMs = Date.now() - (session.lastBufferedGrowthWall || 0);
    if (sinceGrowthMs < STATUS_GROWTH_RECENT_MS) return { kind: 'buffering' };
    if (sinceGrowthMs >= STATUS_GROWTH_STALLED_MS) return { kind: 'needs-play' };
    return { kind: 'buffering' }; // brief in-between window (recent < x < stalled) — still assume progress, avoid label flicker
  }

  function renderStatusPill() {
    var settings = currentSettings();
    if (!settings.enabled || !statusSettings.showStatus) {
      setStatusPillActive(false);
      return;
    }
    var status = computeStatusState();
    if (!status) {
      setStatusPillActive(false);
      return;
    }
    setStatusPillActive(true);
    if (!statusPillEl) return;
    var label;
    if (status.kind === 'off') label = '🛡 Off';
    else if (status.kind === 'protected') label = '🛡 Protected';
    else if (status.kind === 'analyzing-safe') label = '🛡 Analyzing — safe to pause (~' + status.etaS + 's)';
    else if (status.kind === 'buffering') label = '🛡 Buffering + analyzing…';
    else if (status.kind === 'needs-play') label = '🛡 Press play to load audio';
    else label = '🛡 Analyzing…';
    var count = session ? session.mutedCount || 0 : 0;
    if (count > 0) label += ' · ' + count + ' muted';
    statusPillEl.textContent = label;
  }
  function setStatusPillActive(active) {
    if (active && !statusPillEl) {
      var video = getVideo();
      var container = video ? video.closest('.html5-video-player') || video.parentElement : document.body;
      if (!container) return;
      statusPillEl = document.createElement('div');
      statusPillEl.style.cssText =
        'position:absolute;bottom:8px;right:8px;z-index:2147483646;' +
        'background:rgba(0,0,0,0.55);color:#fff;font:11px/1.4 sans-serif;padding:2px 7px;' +
        'border-radius:3px;pointer-events:none;white-space:nowrap;';
      if (container === document.body) {
        statusPillEl.style.position = 'fixed';
      } else if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }
      container.appendChild(statusPillEl);
    } else if (!active && statusPillEl) {
      if (statusPillEl.parentElement) statusPillEl.parentElement.removeChild(statusPillEl);
      statusPillEl = null;
    }
  }
  setInterval(renderStatusPill, 500); // ~2Hz per spec

  // pm_enabled=false must turn the ENTIRE extension off, not just stop
  // future muting decisions (0.1.13). Called synchronously from the
  // storage.onChanged handler, same pattern as handleCatchupModeChanged.
  var loggedDisabledLine = false;
  function handleEnabledChanged(newEnabled) {
    if (newEnabled) {
      // Re-enabling mid-page resumes cleanly from existing session state —
      // safe mode already protects whatever gap formed while disabled
      // (isCovered() correctly reports "uncovered" for anything not
      // covered), so there is nothing to reset. Just resume relaying
      // segments (the 'segment' handler below checks `enabled` itself) and
      // tell offscreen to resume processing.
      loggedDisabledLine = false;
      TLOG(TAG, '[PM] enabled');
      if (session) {
        safePortPost({ type: 'enable', videoId: session.videoId });
        armSchedule(); // restore proactive scheduling for already-known intervals (cleared on disable)
      }
      return;
    }
    if (!loggedDisabledLine) {
      loggedDisabledLine = true;
      TLOG(TAG, '[PM] disabled');
    }
    // Release any active protection immediately — don't wait for tick() to
    // notice (its body already short-circuits entirely on !enabled, so it
    // would otherwise never release anything it had already engaged).
    // clearArmedTimers() matters here too: a previously-armed word-mute
    // setTimeout (from before disabling) would otherwise fire later and
    // call engageMute() again, silently re-muting a "disabled" session.
    clearArmedTimers();
    releaseMute('disabled');
    if (catchupPausedByUs) resumeFromCatchup('disabled');
    if (session) session.catchupFallbackActive = false;
    showAnalyzingOverlay(false);
    setDebugOverlayActive(false);
    setStatusPillActive(false);
    // Tell offscreen to idle this session's transcription CPU, and stop
    // relaying any further segments from capture.js (which keeps its own
    // lightweight hook installed regardless — it has no knowledge of
    // pm_enabled and doesn't need it; only content.js's relay stops).
    if (session) safePortPost({ type: 'disable', videoId: session.videoId });
  }

  // Synchronous catch-up-mode transition (0.1.11: fixes "lags super hard" /
  // gets permanently stuck when switching pause<->mute mid-catchup). Called
  // directly from the storage.onChanged handler with the NEW mode value —
  // never waits for tick()'s rAF cadence. Every call it makes
  // (engageMute/releaseMute/pauseForCatchup/resumeFromCatchup) is already
  // idempotent/guarded against the current state, so this is safe to invoke
  // on every relevant storage change with no risk of repeated churn.
  function handleCatchupModeChanged(newMode) {
    if (!session) return;
    var video = getVideo();
    if (!video) return;
    var settings = currentSettings();
    if (!settings.enabled) return;

    // catchupFallbackActive is a pause-mode-specific concept (see tick()) —
    // clear it when leaving pause mode so a stale flag doesn't linger and
    // confuse a later re-entry into pause mode.
    if (newMode !== 'pause') session.catchupFallbackActive = false;

    // Leaving "pause": tick() only ever calls resumeFromCatchup() from
    // inside its OWN 'pause'-mode branch, so a video paused-for-catchup and
    // then switched to 'mute'/'play' would otherwise stay paused forever —
    // nothing else in tick() touches catchupPausedByUs. Resume right away.
    if (newMode !== 'pause' && catchupPausedByUs) {
      resumeFromCatchup('catchup-mode-changed-away-from-pause');
    }

    var hit = inMutedInterval(video.currentTime);
    var uncoveredNow = newMode !== 'play' && !isCovered(video.currentTime);

    if (newMode === 'pause') {
      // A forced mute from the old 'mute' strategy's uncovered-region reason
      // is now the wrong protection mechanism — release it immediately and
      // pause instead (word-level mutes are untouched: those still use
      // mute in every catchupMode and are left exactly as they are).
      if (session.forcedMute && session.muteReason === 'safe-mode-uncovered') {
        releaseMute('catchup-mode-changed-to-pause');
      }
      if (uncoveredNow && !hit) pauseForCatchup();
    } else if (newMode === 'play') {
      // Catch-up protection is now fully off: any uncovered-region forced
      // mute is stale and must be cleared outright.
      if (session.forcedMute && session.muteReason === 'safe-mode-uncovered') {
        releaseMute('catchup-mode-changed-to-play');
      }
    } else {
      // 'mute': if we just resumed from a catch-up pause above (or were
      // already playing) and the region is still uncovered, protect it the
      // 'mute' way right away rather than leaving one unmuted frame until
      // the next tick.
      if (settings.muteAudio && uncoveredNow && !hit && !session.forcedMute) {
        engageMute('safe-mode-uncovered');
      }
    }
  }

  function pauseForCatchup() {
    var video = getVideo();
    if (!video || catchupPausedByUs) return;
    catchupPausedByUs = true;
    showAnalyzingOverlay(true);
    if (!video.paused) {
      suppressNextPauseEvent = true;
      video.pause();
    }
    TLOG(TAG, 'PAUSE-CATCHUP engaged t=' + video.currentTime.toFixed(2));
  }

  function resumeFromCatchup(reason) {
    if (!catchupPausedByUs) return;
    var video = getVideo();
    catchupPausedByUs = false;
    showAnalyzingOverlay(false);
    if (video && video.paused) {
      suppressNextPlayEvent = true;
      video.play().catch(function () {});
    }
    TLOG(TAG, 'PAUSE-CATCHUP released t=' + (video ? video.currentTime.toFixed(2) : 'NA') + ' reason=' + reason);
  }

  // Fallback ladder (0.1.12): resumes playback like resumeFromCatchup(), but
  // deliberately does NOT hide the "Analyzing audio…" overlay — the fallback
  // is still actively protecting this stall via muted playback instead of a
  // pause, and hiding the overlay here would look like protection ended
  // when it didn't. Caller (tick()) is responsible for hiding the overlay
  // once coverage actually catches up.
  function resumeFromCatchupKeepOverlay() {
    if (!catchupPausedByUs) return;
    var video = getVideo();
    catchupPausedByUs = false;
    if (video && video.paused) {
      suppressNextPlayEvent = true;
      video.play().catch(function () {});
    }
    TLOG(TAG, 'PAUSE-CATCHUP downgraded to muted-playback fallback t=' + (video ? video.currentTime.toFixed(2) : 'NA'));
  }

  document.addEventListener(
    'pause',
    function (ev) {
      if (!(ev.target instanceof HTMLVideoElement)) return;
      if (suppressNextPauseEvent) { suppressNextPauseEvent = false; return; }
      if (catchupPausedByUs) {
        catchupPausedByUs = false; // user (or something else) paused independently — never fight it
        showAnalyzingOverlay(false);
        TLOG(TAG, 'catchup-pause ownership cleared: external pause observed');
      }
    },
    true
  );
  document.addEventListener(
    'play',
    function (ev) {
      if (!(ev.target instanceof HTMLVideoElement)) return;
      if (suppressNextPlayEvent) { suppressNextPlayEvent = false; return; }
      if (catchupPausedByUs) {
        catchupPausedByUs = false;
        showAnalyzingOverlay(false);
        TLOG(TAG, 'catchup-pause ownership cleared: external play observed');
      }
    },
    true
  );

  // ---- rAF backstop: catches safe-mode coverage boundaries (which are not
  // proactively timer-scheduled since coverage grows continuously) and any
  // drift from the timer path (paused/resumed video, throttled timers). ------
  function requestStallRecovery() {
    var now = Date.now();
    if (now - session.lastStallRequestWall < STALL_MS) return; // throttle repeated requests
    session.lastStallRequestWall = now;
    TWARN(TAG, '[PM-STALL] no coverage growth for ' + STALL_MS + 'ms while playing an uncovered region — requesting pipeline restart');
    safePortPost({ type: 'restart', videoId: session.videoId });
    // Capture-miss eviction (0.1.13) is on-demand ONLY, gated on this exact
    // signal (per the minimal-footprint principle: mutating player/network
    // state is a last resort, tried only after 15s of genuinely zero
    // progress — well downstream of the 8s pause->mute fallback ladder,
    // which is tried first and is non-mutating). capture.js (MAIN world)
    // owns the actual buffered/captured bookkeeping and decides locally
    // whether a real capture-miss gap exists near the playhead; this is
    // just the request to go check.
    try {
      window.postMessage({ __pmToCapture: 'PM_CONTENT', type: 'check-eviction' }, location.origin);
    } catch (e) {}
  }

  // Mute/coverage enforcement logic, split out from tick()'s rAF scheduling
  // (0.1.15) so the backgrounded-tab backstop below can invoke this exact
  // logic directly without ALSO enqueueing extra requestAnimationFrame
  // chains (rAF stays suspended/throttled while hidden regardless — calling
  // this doesn't fight that, it's just a separate, additional trigger for
  // the SAME enforcement).
  function runTickLogic() {
    var video = getVideo();
    var settings = currentSettings();
    if (video && session && settings.enabled) {
      var t = video.currentTime;
      var hit = inMutedInterval(t);
      // `&& !session.unanalyzable`: DRM/undecodable content (0.1.15) never
      // gets any real coverage, ever — without this, safe mode would mute/
      // pause this video forever waiting for transcription that offscreen
      // has already given up on (see the 'unanalyzable' handler above).
      var uncovered = settings.safeMode && !isCovered(t) && !session.unanalyzable;

      // [PM-CATCHUP-TIME] (0.1.17): visible in every Copy Logs paste so the
      // "uncovered -> covered" latency after a seek is a measured fact, not
      // an impression. Resolves on plain isCovered(t) (not the `uncovered`
      // var above, which also folds in unrelated settings/unanalyzable
      // state) — coverage reaching the playhead is the actual thing being
      // timed, regardless of catch-up mode configuration.
      if (session.catchupMeasureStart != null && isCovered(t)) {
        var catchupMs = Date.now() - session.catchupMeasureStart;
        TLOG(
          TAG,
          '[PM-CATCHUP-TIME] seek to t=' + session.catchupMeasureTargetT.toFixed(2) +
            ' -> covered at t=' + t.toFixed(2) + ' in ' + (catchupMs / 1000).toFixed(2) + 's'
        );
        session.catchupMeasureStart = null;
      }

      // Release decisions are based on the CURRENT hit/uncovered state, never
      // on the stored muteReason string. A previous version gated release on
      // "muteReason === 'safe-mode-uncovered'" / "starts with 'word:'" — a
      // word interval landing while already forced-muted for
      // safe-mode-uncovered (or vice versa) left muteReason stale, so once
      // BOTH causes had actually ended, neither release check's string match
      // fired and the video stayed muted indefinitely. Observed live on a
      // real-Chrome regression run: coverage caught up seconds after landing
      // on a cold seek, but a word-hit inside that same still-uncovered
      // window pinned muteReason at 'safe-mode-uncovered' (never mind, at
      // 'word:X') and the mute never released. muteReason is now purely
      // informational (logging) — never a release condition.
      if (settings.catchupMode === 'pause') {
        // Word-level muting still always uses mute, even in pause mode.
        // Guarded against catchupFallbackActive: while the fallback ladder
        // below has downgraded to muted playback for an uncovered region,
        // this branch must NOT release that mute just because there's no
        // word-hit right now — the covered-region branch further down is
        // what ends the fallback (and does so more carefully, see there).
        if (hit && settings.muteAudio && !session.forcedMute) {
          engageMute('word:' + hit.word, hit);
        } else if (!hit && session.forcedMute && !session.catchupFallbackActive) {
          releaseMute('interval-ended');
        }

        if (uncovered && !hit) {
          if (session.catchupFallbackActive) {
            // Already downgraded for this stall — keep protecting via mute
            // until coverage catches up (engageMute no-ops if already
            // forced, e.g. from an overlapping word-hit).
            if (!session.forcedMute) engageMute('safe-mode-uncovered');
          } else {
            pauseForCatchup();
            // Fallback ladder (0.1.12): a real deadlock class exists here —
            // (a) pausing stops YouTube from fetching/appending anything
            // further, and (b) a region YouTube buffered BEFORE our hook
            // attached can never be captured passively no matter how long we
            // wait (see capture.js's eviction mechanism, which this pairs
            // with). If pause-catchup makes zero coverage progress for
            // FALLBACK_STALL_MS, downgrade to muted PLAYBACK instead —
            // playing is what makes YouTube resume buffering/appending (and
            // is what lets capture.js's eviction check see currentTime
            // advance) — keeping the "Analyzing audio…" overlay up so
            // protection still reads as active.
            if (catchupPausedByUs && Date.now() - session.lastCoverageGrowthWall > FALLBACK_STALL_MS) {
              TWARN(
                TAG,
                '[PM-FALLBACK] pause-catchup made no coverage progress for ' + FALLBACK_STALL_MS +
                  'ms at t=' + t.toFixed(2) + ' - downgrading to muted playback so YouTube resumes buffering/appending'
              );
              session.catchupFallbackActive = true;
              resumeFromCatchupKeepOverlay();
              engageMute('safe-mode-uncovered');
            }
          }
        } else if (!uncovered) {
          if (session.catchupFallbackActive) {
            session.catchupFallbackActive = false;
            showAnalyzingOverlay(false);
            // Only release here if there's no word-hit in progress right
            // now — if there is, leave forcedMute alone and let the normal
            // word-interval-ended branch above release it later (its guard
            // no longer applies once catchupFallbackActive is false).
            if (!hit && session.forcedMute && session.muteReason === 'safe-mode-uncovered') {
              releaseMute('covered-and-clear');
            }
          } else if (catchupPausedByUs) {
            resumeFromCatchup('covered');
          }
        }
      } else {
        var shouldMute = settings.muteAudio && (hit || uncovered);
        if (shouldMute && !session.forcedMute) {
          engageMute(hit ? 'word:' + hit.word : 'safe-mode-uncovered', hit);
        } else if (shouldMute && session.forcedMute && hit && session.muteReason !== 'word:' + hit.word) {
          session.muteReason = 'word:' + hit.word; // keep it current for logging clarity only
        } else if (!shouldMute && session.forcedMute) {
          releaseMute(uncovered ? 'n/a' : 'covered-and-clear');
        }
      }

      // Continuous mute enforcement (0.1.12): a live user report showed
      // "MUTE engaged t=0.00 safe-mode-uncovered" that was never released in
      // the log, yet the user HEARD AUDIO — YouTube's own player writes
      // video.muted during init/element churn, silently defeating our
      // one-shot write while session.forcedMute stayed true, so tick()
      // believed protection was still active and never did anything further
      // (nothing re-checked the actual DOM property against our intent).
      // Never assume our own flag reflects reality: re-assert video.muted
      // every tick while forcedMute is intended (a cheap property write),
      // and log loudly if it had actually drifted. This also naturally
      // re-applies to a newly-resolved <video> element, since getVideo()
      // re-resolves every tick already — no separate hook needed.
      if (session.forcedMute) {
        if (video.muted !== true) {
          TWARN(
            TAG,
            '[PM-MUTE-FIGHT] video.muted was ' + video.muted + ' while forcedMute=true (reason=' + session.muteReason +
              ') at t=' + t.toFixed(2) + ' - something else flipped it; re-asserting'
          );
        }
        video.muted = true;
      }

      // Mute counting (0.1.15): count once per word/phrase interval per
      // actual playthrough — a "playthrough" of an interval is tracked via
      // activeMuteCountKey (set while the playhead is inside it, cleared
      // once it leaves), so re-entering the SAME interval later (a seek
      // back and replay) counts again, but sitting inside one interval
      // across many ticks only counts once. Gated on video.muted (the real
      // DOM state, not just session.forcedMute) so it reflects whether
      // muting was ACTUALLY applied, regardless of which mechanism/reason
      // caused it.
      if (hit && video.muted) {
        var hitKey = hit.start.toFixed(2) + ',' + hit.end.toFixed(2) + ',' + hit.word;
        if (session.activeMuteCountKey !== hitKey) {
          session.activeMuteCountKey = hitKey;
          countMute(hit);
        }
      } else if (!hit) {
        session.activeMuteCountKey = null;
      }

      // Mode-independent stall input (0.1.20 bug #3): `uncovered` above folds
      // in `settings.safeMode`, which is derived as `catchupMode !== 'play'`
      // — so in "play" mode `uncovered` is ALWAYS false and `stalling` below
      // could never fire, no matter how long the pipeline had genuinely
      // died. A live user session confirmed this: after a decode-confusion
      // skip storm (see bug #2), zero transcription windows for 3+ minutes
      // in "play" mode with no recovery attempt ever made — safeMode gates
      // whether WE mute/pause for an uncovered region (a presentation
      // decision), but the underlying pipeline can stall regardless of that
      // setting, and "play" mode had no path to notice at all. Judged
      // independently of safeMode/catchupMode here; additionally requires
      // that audio is actually CAPTURED at the playhead already (via the
      // same session.bufferedRanges the status pill uses) — otherwise this
      // would fire constantly whenever the playhead is simply ahead of
      // capture itself (normal, not a pipeline stall) rather than only when
      // audio exists and transcription genuinely isn't happening.
      var playheadUncovered = !isCovered(t) && !session.unanalyzable;
      var playheadHasCapturedAudio = false;
      for (var pbi = 0; pbi < session.bufferedRanges.length; pbi++) {
        var pbr = session.bufferedRanges[pbi];
        if (t >= pbr.start - 0.5 && t < pbr.end) {
          playheadHasCapturedAudio = true;
          break;
        }
      }
      var stalling = playheadUncovered && playheadHasCapturedAudio && (
        settings.catchupMode === 'pause'
          ? (session.catchupFallbackActive ? !video.paused : catchupPausedByUs)
          : !video.paused
      );
      if (stalling) {
        // Require BOTH no coverage growth AND no recent heartbeat before
        // firing — a heartbeat means offscreen is genuinely still working
        // (just slow: a long window, cold model load, CPU contention), and
        // restarting it mid-attempt would only make it slower (see
        // PIPELINE_NOTES "0.1.6" — this used to kill and restart in-flight
        // attempts on a long-running video before they could ever finish).
        var coverageStale = Date.now() - session.lastCoverageGrowthWall > STALL_MS;
        var heartbeatStale = Date.now() - session.lastHeartbeatWall > STALL_MS;
        if (coverageStale && heartbeatStale) requestStallRecovery();
      } else {
        session.lastStallRequestWall = 0;
      }
    }
  }

  function tick() {
    runTickLogic();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // Backgrounded-tab protection (0.1.15): rAF suspends/heavily throttles
  // while the document is hidden, but audio keeps playing regardless — a
  // backgrounded tab is exactly where a stale mute/pause decision (or a
  // missed release) matters most, since the user has no visual cue
  // anything is wrong. Chrome's own "intensive throttling" of background
  // timers explicitly EXEMPTS tabs playing audible media, so a plain 1s
  // setInterval keeps firing reliably here even hidden. Runs the exact same
  // enforcement logic as the rAF loop — never a separate/divergent path.
  var backgroundBackstopInterval = null;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      runTickLogic(); // react to the transition immediately, don't wait up to 1s for the first backstop tick
      if (!backgroundBackstopInterval) backgroundBackstopInterval = setInterval(runTickLogic, 1000);
    } else if (backgroundBackstopInterval) {
      clearInterval(backgroundBackstopInterval);
      backgroundBackstopInterval = null;
    }
  });

  // Seek/rate changes invalidate the proactively-armed timer delays (they
  // were computed against the old currentTime/rate) — re-arm, but do NOT
  // touch session.intervals/coveredIntervals: already-transcribed words and
  // coverage stay valid across a seek.
  document.addEventListener(
    'seeking',
    function (ev) {
      var video = ev.target;
      if (!(video instanceof HTMLVideoElement) || !session) return;
      TLOG(TAG, 'seek detected -> t=' + video.currentTime.toFixed(2));
      // Proactively react synchronously here (don't wait for the next rAF
      // tick or an armed timer) so there is no gap between "seek lands" and
      // "safe mode notices the new position is uncovered".
      var settings = currentSettings();
      var seekUncovered = !isCovered(video.currentTime) && !(session && session.unanalyzable);
      if (settings.enabled && settings.safeMode && seekUncovered) {
        if (settings.catchupMode === 'pause') pauseForCatchup();
        else if (settings.muteAudio) engageMute('safe-mode-uncovered');
      }
      // [PM-CATCHUP-TIME] measurement (0.1.17): only meaningful to measure
      // when the seek actually landed somewhere uncovered — an already-
      // covered seek has a trivial/zero catch-up time not worth logging.
      // Overwritten by a later seek before this one resolves (rare, but
      // simplest correct behavior — no stale/misattributed measurement).
      if (seekUncovered) {
        session.catchupMeasureStart = Date.now();
        session.catchupMeasureTargetT = video.currentTime;
      } else {
        session.catchupMeasureStart = null;
      }
      // Seek preemption (0.1.18): tell offscreen the playhead just jumped —
      // it bumps this session's generation counter so any window ALREADY
      // in flight for the old position has its result discarded (can't
      // abort a running WASM call, but its output is now stale) and its
      // maybeProcess loop stops picking any FURTHER old-region windows
      // instead of grinding through a whole queue before reaching the new
      // playhead (a live log showed an 8s wait behind exactly this).
      // Coverage/session state is untouched — "seek keeps everything".
      safePortPost({ type: 'seek', videoId: session.videoId, currentTime: video.currentTime });
      armSchedule();
    },
    true
  );
  document.addEventListener(
    'ratechange',
    function (ev) {
      if (!(ev.target instanceof HTMLVideoElement) || !session) return;
      armSchedule();
    },
    true
  );
  // FIXED (0.1.15): no re-arm on 'play' left stale timer delays after a
  // pause/resume in an already-covered region — armSchedule()'s delays are
  // computed against currentTime/playbackRate AT ARM TIME, and a pause can
  // sit for an arbitrary length of wall time before resuming, so every
  // previously-armed delay is now wrong by however long the pause lasted
  // (upcoming mutes firing early relative to the NEW resume point, or a
  // past-due one never firing at all since its setTimeout already elapsed
  // while paused). Cheap and idempotent — same as the seeking/ratechange
  // handlers already do.
  document.addEventListener(
    'play',
    function (ev) {
      if (!(ev.target instanceof HTMLVideoElement) || !session) return;
      armSchedule();
    },
    true
  );

  // ---- background port, with reconnect on drop (SW idles after ~30s and
  // gets respawned by Chrome on the next connect/message — offscreen state
  // survives that, so reconnecting resumes cleanly without losing coverage). -
  var port = null;
  var reconnectAttempts = 0;
  function safePortPost(msg) {
    if (!port) return;
    try {
      port.postMessage(msg);
    } catch (e) {
      TWARN(TAG, 'port.postMessage failed (will reconnect):', String(e));
    }
  }
  function connectPort() {
    // Orphaned content script (extension was reloaded/updated after this
    // page loaded): chrome.runtime.id throws/is undefined, and connect()
    // would too. Detect it up front rather than retrying forever with no
    // visible signal — this trap has burned real debugging time twice.
    if (!isExtensionContextValid()) {
      showContextInvalidBanner();
      return;
    }
    try {
      port = chrome.runtime.connect({ name: 'pm-content' });
    } catch (e) {
      TERROR(TAG, 'chrome.runtime.connect failed:', e);
      showContextInvalidBanner();
      return;
    }
    reconnectAttempts = 0;
    port.onMessage.addListener(function (msg) {
      if (!msg || !msg.type) return;
      if (msg.type === 'words') {
        addWords(msg.videoId, msg.words || [], msg.windowStartS, msg.windowEndS, msg.wallMs, msg.rtf, msg.modelRtf, msg.decodeMs, msg.queueMs, msg.computeMs);
      } else if (msg.type === 'resync-result') {
        handleResync(msg.videoId, msg.words, msg.coveredIntervals);
      } else if (msg.type === 'heartbeat') {
        if (session && session.videoId === msg.videoId) session.lastHeartbeatWall = Date.now();
      } else if (msg.type === 'diag') {
        // Tab-visible diagnostics relayed from offscreen (skipped windows,
        // demux errors, stall notices) — anything that can block coverage
        // indefinitely must be visible here, not just in the offscreen
        // document's own (user-inaccessible) console.
        TWARN(TAG, '[from offscreen]', msg.text);
      } else if (msg.type === 'unanalyzable') {
        if (session && session.videoId === msg.videoId && !session.unanalyzable) {
          session.unanalyzable = true;
          TWARN(TAG, '[PM-UNANALYZABLE] offscreen gave up transcribing this video (likely DRM/protected content) — releasing safe-mode protection');
          clearArmedTimers();
          releaseMute('unanalyzable');
          if (catchupPausedByUs) resumeFromCatchup('unanalyzable');
          session.catchupFallbackActive = false;
          showAnalyzingOverlay(false);
          showUnanalyzableNotice();
        }
      }
    });
    port.onDisconnect.addListener(function () {
      port = null;
      if (!isExtensionContextValid()) {
        showContextInvalidBanner();
        return; // don't retry forever against a dead context
      }
      reconnectAttempts++;
      var delay = Math.min(5000, 300 * reconnectAttempts);
      // Normal MV3 service-worker idle behavior (SW idles ~30s, Chrome
      // respawns it on the next connect) — not a warning-worthy condition,
      // and console.warn here was polluting the extension's Errors page in
      // chrome://extensions with routine, harmless noise.
      TLOG(TAG, 'background port disconnected, reconnecting in ' + delay + 'ms (attempt ' + reconnectAttempts + ')');
      setTimeout(connectPort, delay);
    });
    // Whether this is the first connect or a reconnect after a drop, ask for
    // a full resync — cheap when there's nothing yet, and guarantees no
    // words computed while the port was down are silently lost.
    if (session) safePortPost({ type: 'resync', videoId: session.videoId });
  }
  connectPort();
  // FIX (0.1.18): stale cross-refresh work. A plain page REFRESH of the
  // SAME video does not change capture.js's own tracked video id, so its
  // 'reset' message (sent only on an ACTUAL video-id change) never fired —
  // meaning the offscreen session for this tabId:videoId key survived the
  // refresh untouched, in-flight/queued work and all. A live user log
  // showed the previous page-session's stale, still-running work draining
  // into the new page load and blocking the transcribe lane for 7+ seconds.
  // Force a reset unconditionally on THIS file's own startup — i.e. on
  // every page load, not just a detected video-id change — so offscreen
  // always starts this tab clean regardless of whether it thinks the video
  // id moved. Paired with offscreen-src.js's generation-counter fix, which
  // additionally discards any results from work that was ALREADY in flight
  // at the moment this reset lands (can't abort a running WASM call, but
  // its result is now discarded rather than applied).
  resetSession(currentVideoIdFromLocation());

  // ---- receive segments from capture.js (MAIN world) ------------------------
  // Postmessage bridge hardening (0.1.15): the public `window.postMessage`
  // broadcast this channel used exclusively is, by construction, readable
  // AND forgeable by any page script with its own 'message' listener —
  // including a forged 'segment' (garbage bytes) or, worse, something that
  // could manufacture false coverage and defeat safe mode. capture.js runs
  // at document_start in the MAIN world, which Chrome guarantees executes
  // before the page's own scripts get a chance to run (the same guarantee
  // this whole extension already depends on for patching
  // MediaSource.prototype before YouTube's own player code runs) — so a
  // MessagePort handed over synchronously at that same moment is safe from
  // any page script racing to intercept it. capture.js initiates the
  // handshake (transferring port2); once acknowledged, ALL further traffic
  // is trusted ONLY over that private port — the public broadcast handler
  // below stops processing anything once `securePort` is set. If the
  // handshake never completes for some reason (e.g. `MessageChannel`
  // unavailable), the public path remains the fallback rather than a
  // hardening measure becoming a single point of failure for the entire
  // extension.
  var securePort = null;
  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.__pm !== 'PM_CAPTURE') return;
    if (ev.data.type === 'handshake' && ev.ports && ev.ports[0]) {
      securePort = ev.ports[0];
      securePort.onmessage = function (portEv) { handleCaptureMessage(portEv.data); };
      try {
        securePort.postMessage({ type: 'ack' });
      } catch (e) {}
      TLOG(TAG, '[PM-SECURE-CHANNEL] private port established with capture.js — public postMessage no longer trusted for segment/reset');
      return;
    }
    if (securePort) return; // secure channel active — the public broadcast is untrusted from here on
    handleCaptureMessage(ev.data);
  });

  function handleCaptureMessage(data) {
    if (!data) return;

    if (data.type === 'chainlog') {
      // capture.js runs in a separate JS realm (MAIN world) — its console
      // output can't write into this file's log-ring buffer directly, so it
      // posts here instead. Already printed to the console by capture.js
      // itself; only ring-buffer it (avoid double-printing the same line).
      // Suppressed while disabled (0.1.13): capture.js keeps its lightweight
      // hook installed regardless (it has no knowledge of pm_enabled), but
      // its chain-dump lines would otherwise keep flooding the ring buffer
      // for no purpose while the extension is off — the standing rule is a
      // single informational "[PM] disabled" line, not continued noise.
      if (currentSettings().enabled) ringAppend([data.text]);
      return;
    }

    if (data.type === 'reset') {
      resetSession(data.videoId);
      return;
    }

    if (data.type === 'segment') {
      // pm_enabled=false (0.1.13): stop relaying segments to background/
      // offscreen entirely — capture.js can keep capturing (harmless,
      // invisible), but content.js must not spend any further CPU/messaging
      // on it while disabled.
      if (!currentSettings().enabled) return;
      if (!session || session.videoId !== data.videoId) {
        session = newSession(data.videoId);
      }
      // Status-pill inputs (0.1.18): mirror offscreen's own bufferedRanges/
      // growth-recency tracking here too, purely from data already flowing
      // through this relay — no new message needed.
      if (typeof data.growthAbsStart === 'number' && typeof data.growthAbsEnd === 'number' && !Number.isNaN(data.growthAbsStart) && !Number.isNaN(data.growthAbsEnd)) {
        mergeRangeInto(session.bufferedRanges, data.growthAbsStart, data.growthAbsEnd);
        session.lastBufferedGrowthWall = Date.now();
      }
      var bytes = new Uint8Array(data.bytes);
      safePortPost({
        type: 'segment',
        videoId: data.videoId,
        mime: data.mime,
        isInit: data.isInit,
        segIndex: data.segIndex,
        currentTime: data.currentTime,
        localTimeSec: data.localTimeSec,
        growthAbsStart: data.growthAbsStart,
        growthAbsEnd: data.growthAbsEnd,
        growthIsNewRange: data.growthIsNewRange,
        wallTime: data.wallTime, // capture.js's own Date.now() at capture — used by [PM-FIRST-COVERAGE]'s relay-latency milestone
        dataB64: uint8ToBase64(bytes)
      });
    }
  }

  (function () {
    var version = 'unknown';
    try {
      version = chrome.runtime.getManifest().version;
    } catch (e) {}
    TLOG(TAG, '[PM-SESSION] content.js installed, version=' + version + ' url=' + location.pathname + location.search);
  })();
})();
