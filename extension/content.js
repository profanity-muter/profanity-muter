// content.js - isolated world, document_start. Loaded after
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
//  3. Persist the mute schedule + coverage per videoId across seeks - only a
//     real video change (RESET from capture.js) clears state.
(function () {
  'use strict';
  var TAG = '[PM]';
  // Padding presets (0.1.17) - PMWordlist.settings.padding ("tight"|"normal"|
  // "wide", default "normal", 8th settings key added by the wordlist agent's
  // UI). "normal" keeps the original 0.35/0.25 values (leading pad already
  // increased from a symmetric 0.25/0.25 after an early report of hearing
  // the first half of a word). Read fresh in applyWordsToIntervals (called
  // per-window) - no onChanged wiring needed: existing armed intervals keep
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
  var FALLBACK_STALL_MS = 8000;
  // A heartbeat arrives every 4s from offscreen while a transcription is
  // genuinely in progress, so anything fresher than ~1.5 cadences means a
  // window is in flight right now (0.1.36 addendum).
  var HEARTBEAT_FRESH_MS = 6000; // pause-catchup with zero coverage progress this long -> downgrade to muted playback (see tick())
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
    return line;
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
    // Every error also lands in the PERSISTENT dev log (shared/devlog.js),
    // not just this tab-lifetime ring buffer - an error is exactly the kind
    // of evidence that is worthless if it dies with the tab before anyone
    // thinks to ask about it.
    devlog('logError', ringAppend(arguments));
    console.error.apply(console, arguments);
  }

  // ---- persistent dev log (shared/devlog.js) -------------------------------
  // Loaded immediately before this file in the SAME content_scripts `js`
  // array (manifest.json), so globalThis.PMDevlog is always present by the
  // time any of this runs - the same guarantee this file already relies on
  // for PMWordlist. Every call still goes through this guard anyway: the
  // dev log is diagnostic scaffolding, and it must never be able to break
  // muting. See shared/devlog.js's header for the pm_devlog schema and the
  // reasoning behind what it does and doesn't store.
  function devlog(method, a, b) {
    var d = globalThis.PMDevlog;
    if (!d || typeof d[method] !== 'function') return;
    try {
      d[method](a, b);
    } catch (e) {
      /* diagnostics must never throw into the pipeline */
    }
  }

  // Relayed offscreen 'diag' messages that are routine progress notices,
  // not problems - kept out of the dev log's `errors` list so the capped
  // list stays a list of things that actually went wrong. Deliberately a
  // deny-list: anything not matched here is recorded.
  // ([PM-STAGE] per-stage progress, [PM-MODEL]/[PM-WARM] model selection
  // and warm-up, [PM-LANG] detection result, [PM-FIRST-COVERAGE] a
  // success milestone.) Everything else offscreen relays - [PM-SKIP],
  // [PM-HANG], [PM-STALL], [PM-ERROR], [PM-DEMUX-ERR],
  // [PM-UNANALYZABLE], [PM-NO-WINDOW], [PM-IDLE-GATE] - is kept: each of
  // those describes a reason coverage may not arrive.
  var DEVLOG_DIAG_NOISE_RE = /^\s*\[PM-(STAGE|MODEL|WARM|LANG|FIRST-COVERAGE)\]/;

  function extensionVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return 'unknown';
    }
  }

  // Resolved settings snapshot for a dev-log entry: what the extension was
  // ACTUALLY configured to do at the moment this video started, which is
  // the first thing "why did word X get through" has to rule out. Records
  // the active word list's SOURCE and SIZE, never its contents (a custom
  // list can be thousands of entries - see devlog.js's header).
  function devlogSettingsSnapshot() {
    var pm = globalThis.PMWordlist;
    var s = (pm && pm.settings) || {};
    var lang = (pm && pm.activeLanguage) || 'en';
    var count = (pm && pm._state && pm._state.wordlist && pm._state.wordlist.length) || 0;
    // 0.1.29: the active English list is the built-in TIER plus the
    // user's own additive words, so the source has to name both - a bare
    // "strictness:strict" no longer says whether the word in question
    // could have come from the user's own list. Still only counts and a
    // tier name, never contents.
    var added = typeof s.additionalWordCount === 'number' ? s.additionalWordCount : 0;
    var source = lang === 'en'
      ? 'tier:' + (s.strictness || 'strict') + '+own:' + added
      : 'pack:' + lang;
    if (pm && pm.packAvailable === false) source += ' (pack unavailable)';
    return {
      enabled: s.enabled !== false,
      strictness: s.strictness || 'strict',
      wordlistSource: source,
      wordCount: count,
      additionalWordCount: added,
      catchupMode: s.catchupMode || 'mute',
      muteAudio: s.muteAudio !== false,
      censorCaptions: s.censorCaptions !== false,
      padding: s.padding || 'normal'
    };
  }

  // ---- word matching (delegates entirely to shared/wordlist.js) -----------
  // 0.1.15 cleanup: the fallback wordlist/matching path (~55 LOC) this used
  // to carry for "shared/wordlist.js hasn't loaded" is deleted -
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
  // derived as `catchupMode !== "play"` on THEIR side - this file used to
  // carry its own duplicate copy of that same derivation (plus a legacy
  // pm_safeMode-only migration path that's been dead since the popup
  // stopped writing pm_safeMode at all) for a fallback settings object that,
  // per the above, is never actually reachable. Deleted (0.1.15 cleanup) -
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
  // deleted - the manual calibration knob added in 0.1.7 was never actually
  // measured/set away from 0; the debug overlay's raw per-word timestamp
  // strip already gives everything needed to measure an offset if one is
  // ever found, without a dead knob sitting in the settings surface.)
  var debugSettings = { debugOverlay: false };
  // pm_showStatus (0.1.15): shows/hides the always-on status pill (separate
  // from the debug overlay) - default true, owned by the UI agent's popup
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
  // Monotonic per-page counter (0.1.35). Purely diagnostic, but the thing it
  // makes visible is exactly the class of bug this round chased: two code
  // paths reading DIFFERENT session objects, where every field looks
  // plausible and only the identity is wrong.
  var sessionInstanceSeq = 0;

  function newSession(videoId) {
    sessionInstanceSeq++;
    return {
      instanceId: sessionInstanceSeq,
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
      // genuinely mid-transcription) - the stall watchdog requires BOTH no
      // coverage growth AND no recent heartbeat before firing, so a merely
      // slow attempt (long window, cold model, CPU contention) doesn't get
      // killed before it can finish.
      lastHeartbeatWall: Date.now(),
      // Fallback ladder (0.1.12): true while pause-catchup has been
      // downgraded to muted PLAYBACK for the CURRENT stall because pausing
      // itself made no coverage progress - see tick(). Reset once covered.
      catchupFallbackActive: false,
      // DRM/undecodable content (0.1.15): set true on an 'unanalyzable' port
      // message from offscreen - permanently suppresses safe-mode-uncovered
      // muting/pausing for this session (see runTickLogic()'s `uncovered`
      // computation) so a video that will never decode is never left
      // muted/paused forever waiting for coverage that can't arrive.
      unanalyzable: false,
      // Status pill + mute counting (0.1.15) - per-video count of matched
      // intervals actually muted through; activeMuteCountKey tracks the
      // CURRENTLY-active counted interval so re-entering the SAME interval
      // later (e.g. after a seek-back replay) counts again, but sitting
      // inside one interval across several ticks doesn't double-count it.
      mutedCount: 0,
      activeMuteCountKey: null,
      lifetimeVideoCounted: false, // videosProtected (chrome.storage.local pm_stats) increments once per video, on its first counted mute
      // [PM-CATCHUP-TIME] measurement (0.1.17) - set on a seek landing
      // uncovered, cleared (and logged) once coverage reaches the playhead.
      catchupMeasureStart: null,
      catchupMeasureTargetT: null,
      // Actionable status pill inputs (0.1.18) - mirrors what offscreen
      // tracks internally, built here from data content.js ALREADY sees
      // flowing through it (capture.js's own segment growth info, and the
      // rtf/computeMs already returned with every 'words' message) - no
      // new pipeline plumbing needed, purely local bookkeeping for display.
      bufferedRanges: [], // merged [{start,end}] - same interval-set concept as offscreen's s.bufferedRanges, built the same way from growthAbsStart/growthAbsEnd
      lastBufferedGrowthWall: Date.now(), // last time bufferedRanges actually grew - "is capture still making progress" signal
      lastKnownRtf: null, // last computeMs-based rtf, for a rough ETA estimate
      // 0.1.28 - the currently-open catch-up gap for the persistent dev
      // log ({start, end, mode}), or null. See trackDevlogGap() below.
      devlogGap: null,
      language: null, // 0.1.25 - detected language ('en', a real code, or null before/without detection); see handleLanguage()/addWords()
      // 0.1.32 health monitor (see shared/health.js). All per-video, all
      // reset with the session, because "is this working" is a question
      // about THIS video: a previous video's success says nothing about
      // whether audio is being intercepted on this one.
      windowsCompleted: 0, // analysis windows that actually came back
      audioSegments: 0, // audio segments intercepted from capture.js
      playbackMs: 0, // accumulated ACTUAL playback, not wall time (see tickHealth)
      lastPlaybackSampleWall: 0, // wall clock at the previous playback sample
      fatalReasons: [], // reason codes classified out of the diag stream
      health: null, // last non-pending verdict from PMHealth.evaluate
      healthEvalAt: 0, // when that verdict was reached (re-eval throttle)
      liveNoticeShown: false, // the calm livestream notice is shown once per video
      // 0.1.34: the outstanding "safe to pause (~Ns)" promise, or null.
      // {issuedWall, etaS, windowsAtIssue}. Cleared whenever the pill is not
      // in that state, and re-issued (with a fresh clock) whenever a window
      // completes, so "no outstanding promise" and "the promise was kept"
      // are the same thing to everything downstream.
      etaPromise: null,
      // 0.1.40: throughput measured in WALL time including hang losses, so
      // a hang-prone video quotes slower numbers by itself instead of
      // promising a healthy session's speed.
      effectiveRtf: null,
      // The monotonic display ledger. Kept apart from etaPromise, which
      // stays the internal estimate the health monitor reasons about.
      countdown: null,
      // 0.1.36 addendum: where the muted-playback fallback started, so the
      // content it consumed can be replayed audibly once coverage catches
      // up. Null when no rewind is pending. userSeekedSinceFallback drops
      // the rewind entirely, because the user's own navigation outranks
      // recovering audio they chose to skip past.
      fallbackStartT: null,
      userSeekedSinceFallback: false
    };
  }

  function resetSession(videoId) {
    TLOG(TAG, 'session reset (video changed), videoId=' + videoId);
    closeDevlogGap(); // must land in the OUTGOING video's entry, before startVideo
    releaseMute('video-changed');
    clearArmedTimers();
    session = newSession(videoId);
    unanalyzableNoticeShown = false; // a new video gets its own fresh chance (and notice) - see the 'unanalyzable' handler
    // Open this video's persistent dev-log entry. document.title is often
    // still the PREVIOUS page's title at this point on a YouTube SPA
    // navigation, and PMWordlist may not have finished its first async
    // settings refresh - both are corrected by the updateMeta call in
    // logVideoInfoOnce below, which waits for the player to resolve.
    devlog('startVideo', videoId, {
      title: document.title,
      version: extensionVersion(),
      settings: devlogSettingsSnapshot()
    });
    safePortPost({ type: 'reset', videoId: videoId });
    logVideoInfoOnce(videoId);
  }

  // Mirrors capture.js's own currentVideoId() - used ONLY to force a reset
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
  // long" at the start of every session - the first thing worth checking
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
    // Same moment, same reason: the player has resolved, so document.title
    // is now this video's real title and the settings snapshot is the
    // settled one. Refines the entry opened in resetSession().
    devlog('updateMeta', {
      title: document.title,
      version: extensionVersion(),
      settings: devlogSettingsSnapshot()
    });
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

  // ---- catch-up gap tracking (persistent dev log) --------------------------
  // A "gap" is a stretch of media time that PLAYED while the playhead was
  // not inside any analyzed (covered) region - audio that reached the
  // <video> element without ever having been checked against the word list.
  //
  // In catch-up mode "play" that audio is genuinely audible and this is the
  // leak. In "mute"/"pause" the very same stretch is covered by a blanket
  // mute (or never plays at all), so nothing leaks - but it is still
  // exactly the region that WOULD have leaked. Gaps are therefore recorded
  // in EVERY mode, with `mode` naming the one in force, so one record
  // answers both "what did play mode let through" and "what would play mode
  // have let through if I switched to it".
  //
  // A gap is held open across ticks and closed (written to the dev log)
  // when the playhead becomes covered, playback stops, the catch-up mode
  // changes, the playhead jumps (a seek ends the contiguous stretch; the
  // landing position opens its own gap if it is also uncovered), or the
  // session/page ends.
  var GAP_JUMP_S = 1.0; // playhead delta beyond this is a jump, not playback

  function closeDevlogGap() {
    if (!session || !session.devlogGap) return;
    var g = session.devlogGap;
    session.devlogGap = null;
    // devlog.js drops zero/negative-length gaps itself, so a gap that
    // opened and closed inside a single tick costs nothing here.
    devlog('logGap', g);
  }

  function trackDevlogGap(t, playing, uncovered, mode) {
    if (!session) return;
    var g = session.devlogGap;
    if (g && (g.mode !== mode || t < g.end - COVERAGE_EPS || t > g.end + GAP_JUMP_S)) {
      closeDevlogGap();
      // 0.1.40: a seek asks a new question, so the countdown is allowed to
      // start over rather than being held down by the previous answer. The
      // only path that may raise the displayed number.
      if (session) {
        session.countdownReset = true;
        session.countdown = null;
      }
      g = null;
    }
    if (playing && uncovered) {
      if (!g) session.devlogGap = { start: t, end: t, mode: mode };
      else g.end = t;
    } else if (g) {
      closeDevlogGap();
      // 0.1.40: a seek asks a new question, so the countdown is allowed to
      // start over rather than being held down by the previous answer. The
      // only path that may raise the displayed number.
      if (session) {
        session.countdownReset = true;
        session.countdown = null;
      }
    }
  }

  // ---- mute scheduling ------------------------------------------------------
  // Clamp per-word duration before padding (transformers.js word-timestamp
  // smear mitigation - live testing showed some "words" reported as 5-15s
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
    // matched[] is the dev log's view of the same loop: the matched word/
    // phrase and the UNPADDED media time it actually starts at. Kept
    // separate from newIntervals because those get padded, then merged
    // (mergeIntervals concatenates the `word` labels of overlapping
    // intervals with '+'), so by the time they reach the session they no
    // longer say which individual word was found where.
    var matched = [];
    for (i = 0; i < matches.length; i++) {
      var m = matches[i];
      var i0 = m.index, i1 = m.index + (m.length || 1) - 1;
      if (i0 < 0 || i1 >= tokens.length || i1 < i0) continue;
      var ivStart = Math.max(0, tokens[i0].start - pad.lead);
      var ivEnd = tokens[i1].end + pad.trail;
      var label = wordStrings.slice(i0, i1 + 1).join(' ');
      newIntervals.push({ start: ivStart, end: ivEnd, word: label });
      matched.push({ word: label, t: tokens[i0].start });
      for (var k = i0; k <= i1; k++) tokens[k].matched = true;
    }
    return { intervals: newIntervals, tokens: tokens, matched: matched };
  }

  // Record raw tokens for the debug overlay (word strip near the playhead) -
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

  // Multilingual support (0.1.25) - applies a detected language to the
  // current session, once, only on an actual CHANGE (offscreen sends the
  // language on every 'words'/'resync-result' message once resolved, not
  // just the first - this guards against redundant PMWordlist.setLanguage
  // calls / duplicate [PM-LANG-APPLIED] noise on every single window).
  // PMWordlist.setLanguage is called defensively (the wordlist agent owns
  // per-language wordlist packs and may not have shipped this method yet,
  // or ever, for a given build) - its absence must never break anything
  // else here.
  function applyDetectedLanguage(videoId, language) {
    if (!session || session.videoId !== videoId) return;
    if (!language || session.language === language) return;
    session.language = language;
    TLOG(TAG, '[PM-LANG-APPLIED] language=' + language);
    try {
      if (globalThis.PMWordlist && typeof globalThis.PMWordlist.setLanguage === 'function') {
        globalThis.PMWordlist.setLanguage(language);
      }
    } catch (e) {
      TWARN(TAG, 'PMWordlist.setLanguage threw:', e);
    }
  }

  function addWords(videoId, rawWords, windowStartS, windowEndS, wallMs, rtf, modelRtf, decodeMs, queueMs, computeMs, language, model) {
    if (!session || session.videoId !== videoId) return;
    applyDetectedLanguage(videoId, language);

    // Health monitor (0.1.32): a window coming back at all is THE evidence
    // that the pipeline works end to end. Counted before anything below
    // can throw, and counted even for a window that matched nothing: zero
    // matches is a result, not a failure.
    session.windowsCompleted++;
    // 0.1.40: wall time, not compute time. A window that took twelve
    // seconds because the decoder hung for nine really did deliver its
    // audio at that rate, and the countdown is a promise about elapsed
    // time. Feeding compute-only numbers here is how the old quotes stayed
    // optimistic on exactly the videos that needed pessimism.
    if (typeof windowStartS === 'number' && typeof windowEndS === 'number' && windowEndS > windowStartS) {
      var pillRtfApi = globalThis.PMPill;
      if (pillRtfApi && wallMs != null) {
        session.effectiveRtf = pillRtfApi.updateEffectiveRtf(
          session.effectiveRtf,
          windowEndS - windowStartS,
          wallMs
        );
      }
    }
    // 0.1.34: a completed window is the single biggest change to what the
    // pill should say ("Analyzing" becoming "Protected"), and waiting up to
    // half a second to say so was measured in the field as much worse than
    // that, because the coverage that makes it Protected can arrive in the
    // same instant. Refresh now rather than on the next poll. This also
    // discharges any outstanding ETA promise, since the promise is keyed on
    // windowsCompleted.
    refreshPillSoon();

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

    // Persistent per-window record (shared/devlog.js). This is the core of
    // "why did word X get through on video Y": it says whether the window
    // covering X was ever analyzed at all, how many words the transcript
    // held, what matched in it, and which padded intervals those matches
    // produced. The transcript TEXT itself is only stored when
    // pm_devlogVerbose is on - devlog.js decides that, not this file.
    devlog('logWindow', {
      t0: windowStartS,
      t1: windowEndS,
      transcriptWordCount: rawWords.length,
      matches: result.matched,
      muteIntervals: newIntervals,
      text: rawWords
        .map(function (w) { return w.word; })
        .join(' ')
    });

    // Log the raw transcript text too, not just counts: background.js/
    // offscreen's own "[PM] window ... text=[...]" log lives in the service
    // worker / offscreen document console, which is NOT visible to a
    // per-tab console reader (e.g. Chrome DevTools on the page, or
    // automation reading the page's console) - this is the only place the
    // actual transcribed words are ever visible from the tab itself, which
    // matters for diagnosing "did the transcript even contain word X".
    var firstWordS = rawWords.length ? Math.min.apply(null, rawWords.map(function (w) { return w.start; })).toFixed(2) : 'NA';
    var lastWordS = rawWords.length ? Math.max.apply(null, rawWords.map(function (w) { return w.end; })).toFixed(2) : 'NA';
    TLOG(
      TAG,
      '[PM-WINDOW] mediaSpan=[' + (typeof windowStartS === 'number' ? windowStartS.toFixed(2) : 'NA') + ',' + (typeof windowEndS === 'number' ? windowEndS.toFixed(2) : 'NA') + ')' +
        ' model=' + (model || 'NA') + // 0.1.25 -- RTF telemetry per model
        ' wallMs=' + (wallMs != null ? Math.round(wallMs) : 'NA') +
        // Split (0.1.18): wallMs used to bundle demux/decode + queue-wait-
        // for-the-shared-worker-mutex + actual compute into one number - a
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
    // Machine-parseable per-word timestamps, tab-visible - the deterministic
    // caption-correlation check (verify/caption_correlate.mjs) reads these
    // rather than eyeballing the debug overlay. Emitted after clamping (the
    // times actually used for muting), one line per addWords batch.
    TLOG(TAG, 'WORDTIMES', JSON.stringify(result.tokens.map(function (t) { return { w: t.word, s: +t.start.toFixed(3), e: +t.end.toFixed(3) }; })));
  }

  // Full resync after a port reconnect: offscreen sends everything it holds
  // for this session (words computed while the port was down must not be
  // silently lost) - this REPLACES local state rather than merging, since it
  // is authoritative.
  function handleResync(videoId, words, coveredIntervals, language) {
    if (!session || session.videoId !== videoId) return;
    applyDetectedLanguage(videoId, language);
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
  // player from SPA nav, miniplayer remnants, ad-player variants) - a naive
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

  // Hand the dev log a media-clock source. It timestamps caption censor
  // events (logged from captions.js, which has no <video> of its own) and
  // errors, and picking the right <video> on a YouTube page is a solved
  // problem here - see resolveRealVideo above - not one worth solving a
  // second time in another file.
  devlog('setTimeSource', function () {
    var v = getVideo();
    return v ? v.currentTime : null;
  });

  // ---- engage/release: every call is logged with an explicit reason so
  // there is never a silent "why is this muted" state. -----------------------
  //
  // PRODUCT RULE - MUTE, NEVER BLEEP. This sets video.muted and nothing
  // else, deliberately. Do not "improve" this by mixing in a bleep tone,
  // a beep, or any replacement audio: the Family Movie Act (17 U.S.C.
  // §110(11)) protects making limited portions of a work IMPERCEPTIBLE
  // during a private performance - it does not protect ADDING audio to
  // someone else's copyrighted work, which is what a bleep is. Silence is
  // the whole legal basis on which this extension operates. See
  // CENSOR_NOTES.md "Mute, never bleep" before touching this.
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
  // pm_stats - schema is exactly {totalMuted, videosProtected} per the
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
    // coordinator's explicit ask) - this is a distinct, greppable line
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
  // Flush on pagehide too - a throttled 10s timer alone would lose whatever
  // hadn't flushed yet if the tab/page goes away first.
  window.addEventListener('pagehide', function () {
    if (statsFlushTimer) {
      clearTimeout(statsFlushTimer);
      statsFlushTimer = null;
    }
    flushStats();
    // Same deal for the dev log: close whatever gap was still open at the
    // moment the page went away and force its final write. devlog.js has
    // its own pagehide listener, but it was registered when devlog.js
    // loaded - i.e. BEFORE this one - so it would otherwise flush a state
    // that is missing the last (and often longest) gap.
    closeDevlogGap();
    devlog('flushNow');
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
              // applies - releasing a word-level mute at its own end time
              // even while the playhead had ALSO drifted into (or the
              // schedule was armed slightly ahead of) an uncovered safe-mode
              // region left that region briefly unmuted: a real audio leak,
              // worst when the tab is backgrounded and this armed timer is
              // the ONLY thing firing (rAF is throttled/suspended while
              // hidden - see the visibilitychange backstop below). Mirror
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
  // 0.1.36: self-action markers replace the old one-shot booleans. See
  // shared/catchup.js for why a timestamped mark is the right shape here:
  // play() settles asynchronously and can fail without ever firing an
  // event, and a stale one-shot then swallows the NEXT event, which may be
  // the genuinely external one this whole mechanism exists to detect.
  var selfPlayMark = null;
  var selfPauseMark = null;
  // When we last released a catch-up pause, for the re-engage debounce.
  var lastCatchupReleaseWall = null;
  // Marks our own rewind seek, so the seeking handler does not mistake it
  // for the user superseding that very rewind.
  var selfSeekMark = null;

  function catchupApi() {
    return globalThis.PMCatchup || null;
  }

  function markSelfPlay() {
    var api = catchupApi();
    selfPlayMark = api ? api.markSelfAction(Date.now()) : { wall: Date.now() };
  }

  function markSelfPause() {
    var api = catchupApi();
    selfPauseMark = api ? api.markSelfAction(Date.now()) : { wall: Date.now() };
  }
  var analyzingOverlayEl = null;

  // ---- orphaned-content-script UX: when the extension is reloaded/updated
  // (dev iteration, or an auto-update), any already-injected content script
  // instance is orphaned - chrome.runtime.connect()/sendMessage() start
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
  // The ONE surface deliberately not folded into the badge (0.1.36
  // addendum). It fires only when the extension context is dead, which is
  // exactly the state where the badge cannot do its job: chrome.runtime is
  // gone, so a click could not open anything, and a badge that invites a
  // click it cannot honour is worse than a plain sentence. This one is
  // non-interactive, says the one thing that helps (refresh), and appears
  // once.
  function showContextInvalidBanner() {
    if (contextInvalidBannerShown) return;
    contextInvalidBannerShown = true;
    TERROR(TAG, 'extension context invalidated (extension was reloaded/updated) - this page needs a refresh to re-enable profanity muting');
    var video = getVideo();
    var container = video ? video.closest('.html5-video-player') || video.parentElement : document.body;
    if (!container) return;
    var banner = document.createElement('div');
    banner.textContent = 'Profanity Muter was updated - refresh this page to re-enable';
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

  // DRM/undecodable content (0.1.15) - see the 'unanalyzable' port message
  // handler. Never left silent: a rented/protected movie that can't be
  // transcribed should say so, not just quietly stop muting.
  var unanalyzableNoticeShown = false;
  // One-off banner across the top of the player. Two treatments: 'neutral'
  // for a documented limitation (protected content, livestreams) and
  // 'warning' for something actually broken. Factored out of the old
  // unanalyzable-only version in 0.1.32 so the health monitor's livestream
  // notice looks and behaves identically rather than being a second
  // near-copy of the same DOM code.
  // 0.1.36 addendum: this used to inject its own banner across the top of
  // the player, which made three surfaces where there should be one. The
  // explanatory text now takes over the badge for a spell and then reverts
  // to whatever the state says, reusing the same timed-override mechanism
  // the milestone moment already used. One badge, one place, content and
  // tone are the only things that change.
  var NOTICE_VISIBLE_MS = 9000; // long enough to read a sentence, not a fixture
  var noticeText = null;
  var noticeUntilWall = 0;

  function showPlayerNotice(text, kind) {
    noticeText = text;
    noticeUntilWall = Date.now() + NOTICE_VISIBLE_MS;
    TLOG(TAG, '[PM-NOTICE] ' + text);
    refreshPillSoon();
  }

  function activeNoticeText() {
    if (!noticeText) return null;
    if (Date.now() > noticeUntilWall) {
      noticeText = null;
      return null;
    }
    return noticeText;
  }

  function showUnanalyzableNotice() {
    if (unanalyzableNoticeShown) return;
    unanalyzableNoticeShown = true;
    showPlayerNotice(
      "Profanity Muter can't analyze this video's audio (protected content) - muting disabled for this video",
      'neutral'
    );
  }

  // 0.1.36 addendum: the "Analyzing audio…" overlay was a fourth surface
  // saying what the badge already says, in a different place and in
  // different words. The badge's own processing state ("Analyzing ~Ns")
  // covers every moment this was shown, so the element is gone and the
  // call sites remain, both because they still express real intent
  // (pause-catchup engaged / released) and because they are the natural
  // place for a future affordance if one is ever wanted. Any element left
  // over from a previous version of the extension in a long-lived tab is
  // cleaned up here.
  function showAnalyzingOverlay(show) {
    if (analyzingOverlayEl) {
      if (analyzingOverlayEl.parentElement) analyzingOverlayEl.parentElement.removeChild(analyzingOverlayEl);
      analyzingOverlayEl = null;
    }
    if (show) refreshPillSoon();
  }

  // ---- pm_debugOverlay: an instrument for measuring the reported "off by
  // one word" / small systematic timing offset. Shows current t, coverage
  // status, a ±5s strip of raw transcript words with live/matched
  // highlighting, and upcoming scheduled mute intervals - the user reads a
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
      // Anchored directly beneath the badge (0.1.36 addendum) so the two
      // can never overlap, whatever the badge's width.
      'position:absolute;top:' + ((globalThis.PMPill && globalThis.PMPill.DEBUG_OVERLAY_TOP_PX) || 86) +
        'px;left:8px;right:8px;z-index:2147483647;' +
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
      '(paste this whole block - every line needed to reconstruct the pipeline timeline is here)\n';
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

    // Coverage indicator alignment (0.1.23) - see PIPELINE_NOTES "0.1.23"
    // item 3: this used to show only the PLAYHEAD POINT's coverage
    // (COVERED/UNCOVERED), while the status pill judges the whole
    // [t, t+PROTECT_MARGIN] HORIZON - the two surfaces could disagree
    // confusingly (overlay says "COVERED" the instant t itself is covered,
    // while the pill still shows "Analyzing" because the horizon ahead
    // isn't). Now shows BOTH, using the exact same clampedHorizonEnd() the
    // pill itself calls, so they can never diverge.
    var coverageLabel;
    if (isLiveStream(video)) {
      coverageLabel = (covered ? 'COVERED-NOW' : 'UNCOVERED-NOW') + '/horizon n/a (live)';
    } else {
      var horizonEnd = clampedHorizonEnd(video, t);
      var horizonShortS = uncoveredDurationWithin(session.coveredIntervals, t, horizonEnd);
      var horizonLabel = horizonShortS <= COVERAGE_EPS ? 'horizon OK' : 'horizon ' + horizonShortS.toFixed(1) + 's short';
      coverageLabel = (covered ? 'COVERED-NOW' : 'UNCOVERED-NOW') + '/' + horizonLabel;
    }

    debugOverlayContentEl.innerHTML =
      '<b>[PM debug]</b> t=' + t.toFixed(2) + '  coverage=' + coverageLabel + '\n' +
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
  // overlay off along with everything else - it was previously gated only
  // on pm_debugOverlay, so it (and its own console chatter) stayed visible
  // even with the whole extension "disabled", which is exactly the kind of
  // visible-when-it-shouldn't-be state this fix targets.
  setInterval(function () {
    var settings = currentSettings();
    setDebugOverlayActive(settings.enabled && settings.debugOverlay);
  }, 500);

  // ---- status pill (0.1.15, made ACTIONABLE in 0.1.18) ---------------------
  // Small, always-on, subtle indicator - separate from the debug overlay
  // (which is off by default and verbose). Hideable via pm_showStatus.
  //
  // User feedback on the plain 0.1.15 pill: when uncovered, there was no way
  // to tell whether pausing-and-waiting would make progress (audio already
  // captured, just queued/processing) or whether they needed to keep
  // playing (to make YouTube fetch more audio in the first place). The
  // generic "Analyzing…" collapsed two very different situations - plus a
  // third, rarer one - into one unhelpful label. Now data-driven:
  //   - "Protected": coverage extends >=5s past the playhead. Nothing to do.
  //   - "Analyzing - safe to pause (~Ns)": the playhead's own region IS
  //     captured (in bufferedRanges) and just hasn't been transcribed yet -
  //     pausing is fine, it WILL finish; ETA is remaining-uncovered-audio
  //     near the playhead times the last measured rtf, capped at 30s.
  //   - "Buffering + analyzing…": NOT captured yet, but capture is actively
  //     growing (a segment landed in the last ~3s) - still fine to wait,
  //     YouTube is still fetching.
  //   - "Press play to load audio": NOT captured, and NO capture growth for
  //     ~4s - YouTube has stopped fetching (e.g. paused before the buffer
  //     reached this position). This is the ONE state needing user action.
  //   - "Off": DRM/unanalyzable (unchanged from before).
  // This is presentation only - every input (bufferedRanges, coverage,
  // growth recency, rtf) already exists; see the bookkeeping added above.
  var statusPillEl = null;
  var STATUS_GROWTH_RECENT_MS = 3000; // capture actively growing if a segment landed within this long
  var STATUS_GROWTH_STALLED_MS = 4000; // capture has stopped fetching if nothing landed for this long
  // 0.1.19: the pill's whole state/ETA judges only the playhead's own
  // protection horizon, never the full uncovered backlog further ahead -
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

  // Live-stream detection (0.1.21) - a live user session (audio/mp4,
  // codecs="mp4a.40.2") showed the pill sitting forever on "Analyzing -
  // safe to pause" for a live stream, which is a lie: full live-stream
  // support is explicitly deferred (see PIPELINE_NOTES.md "0.1.21") - the
  // pipeline still transcribes best-effort against whatever DVR buffer
  // exists, but coverage racing a moving live edge is not the same
  // guarantee "Protected"/"Analyzing" imply for on-demand video, and the
  // ETA math has no real basis for a stream with no fixed end. `duration
  // === Infinity` is the standard HTML5 signal for a live stream (per spec,
  // not YouTube-specific); YouTube's own live-badge class is checked too as
  // a defensive OR in case a specific live variant ever reports a finite
  // duration.
  function isLiveStream(video) {
    if (video && video.duration === Infinity) return true;
    try {
      var player = document.getElementById('movie_player');
      return !!(player && player.classList.contains('ytp-live'));
    } catch (e) {
      return false;
    }
  }

  // End-of-video clamp (0.1.22), factored out (0.1.23) so the pill
  // (computeStatusState) and the debug overlay's "coverage=" line
  // (renderDebugOverlay) can never disagree about what the playhead
  // "protection horizon" even IS - see PIPELINE_NOTES "0.1.23" item 3: the
  // two surfaces used different notions of coverage (pill: whole-horizon;
  // overlay: playhead point only) and could contradict each other
  // confusingly. Both now call this SAME function. A user report showed the
  // pill stuck on "Analyzing" forever at the end of a video - the
  // [t, t+PROTECT_MARGIN] horizon extends past video.duration into audio
  // that doesn't exist and can never be captured/transcribed, so a raw
  // uncovered-check against the UNCLAMPED horizon could never succeed even
  // once everything real had actually finished transcribing. Clamping to
  // video.duration whenever it's finite (a live stream is handled
  // separately by isLiveStream(), before this is ever called) means once
  // the clamped horizon collapses to <= t (i.e. we're already at/past the
  // last coverable point), a real uncovered-check naturally reports zero
  // uncovered duration with no separate near-the-end special case needed.
  function clampedHorizonEnd(video, t) {
    var horizonEnd = t + PROTECT_MARGIN;
    if (isFinite(video.duration)) horizonEnd = Math.min(horizonEnd, video.duration);
    return horizonEnd;
  }

  // ---- health monitor (0.1.32) --------------------------------------------
  //
  // "Failing silently is the worst outcome for a parental filter" is the
  // whole reason this exists; shared/health.js holds the reasoning and the
  // pure state machine, this is the wiring. Three inputs feed it, all of
  // which this file already had: completed analysis windows (addWords),
  // intercepted audio segments (the capture relay), and fatal diagnostics
  // (the offscreen 'diag' stream). The fourth, accumulated playback time,
  // is measured here.
  //
  // Guarded like every other optional module: a missing PMHealth degrades
  // to no health monitoring, never to broken muting.
  function healthApi() {
    return globalThis.PMHealth || null;
  }

  // Shorts (0.1.33). The content script matches all of youtube.com, so it
  // has always RUN on /shorts/ pages; it just never said anything about
  // them. Code-level findings, before gating:
  //   - videoId comes from location.search's `v` param or, failing that,
  //     the pathname (capture.js currentVideoId / this file's
  //     currentVideoIdFromLocation), so every Short gets a distinct id and
  //     every swipe fires a RESET that discards all accumulated coverage.
  //   - Transcription intentionally trails playback by seconds. A Short is
  //     commonly 15-60s, starts instantly, and LOOPS, so analysis has to
  //     win a race it was never designed for, on every swipe.
  //   - resolveRealVideo prefers '#movie_player video.html5-main-video',
  //     the watch-page player; the Shorts player is a different container,
  //     so element resolution falls back to a size heuristic.
  //   - The whole session model assumes one monotonic video per page.
  // None of that adds up to working support, and the default catch-up mode
  // is "play", so a user scrolling Shorts today gets unfiltered audio with
  // a pill implying otherwise. Say so instead.
  function isShortsPage() {
    try {
      return location.pathname.indexOf('/shorts/') === 0;
    } catch (e) {
      return false;
    }
  }

  // Page-scoped, NOT session-scoped: every swipe starts a new session, so a
  // per-session flag would fire the notice on every Short in a scroll.
  // Reset when the user leaves Shorts, so returning later informs them once
  // more rather than never again.
  var shortsNoticeShown = false;

  function noteFatalDiag(text) {
    var api = healthApi();
    if (!api || !session) return;
    var reason = api.classifyDiag(text);
    if (!reason) return;
    if (session.fatalReasons.indexOf(reason) === -1) {
      session.fatalReasons.push(reason);
      TWARN(TAG, '[PM-HEALTH] fatal signal classified: ' + reason);
    }
  }

  // Accumulate ACTUAL playback, not wall time. A video paused for ten
  // minutes has had no chance to be analyzed, and judging it on wall time
  // would produce exactly the false alarm this feature must avoid.
  //
  // The per-sample clamp matters: this is driven from the rAF tick, which
  // stops entirely while the tab is hidden, and from the 1s background
  // backstop. Without a clamp, a tab hidden for an hour would return and
  // book an hour of "playback" in a single sample, instantly crossing the
  // threshold on evidence that was never collected.
  var HEALTH_SAMPLE_CLAMP_MS = 1500;

  function samplePlayback(video) {
    if (!session) return;
    var nowWall = Date.now();
    var prev = session.lastPlaybackSampleWall;
    session.lastPlaybackSampleWall = nowWall;
    if (!prev) return; // first sample establishes the baseline only
    if (!video || video.paused || video.ended) return;
    var deltaMs = nowWall - prev;
    if (deltaMs <= 0) return;
    session.playbackMs += Math.min(deltaMs, HEALTH_SAMPLE_CLAMP_MS);
  }

  // Called from the rAF tick, so it must not allocate 60 times a second.
  // PMHealth.evaluate throttles the VERDICT, but it still builds an input
  // object and a result object on every call, and this is the hottest loop
  // in the extension. Gate the call itself to ~1Hz. One second is far
  // inside human reaction time for a warning that only becomes relevant
  // after 20 seconds of playback, and recovery stays effectively instant.
  var HEALTH_CALL_INTERVAL_MS = 1000;
  var lastHealthCallWall = 0;

  function evaluateHealth(video) {
    var api = healthApi();
    if (!api || !session) return;
    if (!isShortsPage()) shortsNoticeShown = false;
    maybeAskMilestone();
    var nowWall = Date.now();
    if (nowWall - lastHealthCallWall < HEALTH_CALL_INTERVAL_MS) return;
    lastHealthCallWall = nowWall;
    var verdict = api.evaluate({
      now: Date.now(),
      playbackMs: session.playbackMs,
      isWatchPage: !!video,
      isPaused: !video || video.paused,
      isLive: !!(video && isLiveStream(video)),
      isShorts: isShortsPage(),
      // 0.1.34: the broken-promise inputs. Null unless the pill currently
      // has an unfulfilled "safe to pause (~Ns)" claim outstanding, which is
      // what lets the health check bypass the playback-only clock without
      // giving up any of its false-positive discipline: it can only fire
      // where we made a specific promise and did not keep it.
      promiseAgeMs: api.promiseAgeMs(session.etaPromise, Date.now()),
      promiseEtaMs: session.etaPromise && session.etaPromise.etaS != null
        ? session.etaPromise.etaS * 1000
        : null,
      unanalyzable: !!session.unanalyzable,
      windowsCompleted: session.windowsCompleted,
      audioSegments: session.audioSegments,
      fatalReasons: session.fatalReasons,
      lastEvalAt: session.healthEvalAt || null
    });
    if (!verdict.due) return;

    var prev = session.health;
    session.healthEvalAt = Date.now();
    var changed = api.isTransition(prev, verdict);
    session.health = verdict;
    if (!changed) return;

    // Every transition is recorded, in both directions. A warning that
    // appeared and then cleared is a materially different story from one
    // that never appeared, and only the log can tell them apart later.
    if (verdict.status === api.STATUS.OK) {
      sendHealthToBackground(verdict.status); // clears the tab badge
      if (prev && prev.status !== api.STATUS.OK) {
        TLOG(TAG, '[PM-HEALTH] recovered: analysis is progressing again');
        devlog('logHealth', {
          status: 'recovered',
          reason: prev.reason || null,
          playbackMs: Math.round(session.playbackMs),
          windowsCompleted: session.windowsCompleted
        });
      }
      return;
    }

    // Tell the service worker so it can badge THIS tab (0.1.33). Only the
    // status travels; PMMoments.badgeDecision decides what it means, so the
    // rule lives in one place rather than being re-implemented here.
    sendHealthToBackground(verdict.status);

    TWARN(
      TAG,
      '[PM-HEALTH] ' + verdict.status + ': ' + verdict.reason +
        ' (playbackMs=' + Math.round(session.playbackMs) +
        ' windows=' + session.windowsCompleted +
        ' segments=' + session.audioSegments + ')'
    );
    devlog('logHealth', {
      status: verdict.status,
      reason: verdict.reason,
      playbackMs: Math.round(session.playbackMs),
      windowsCompleted: session.windowsCompleted,
      audioSegments: session.audioSegments
    });

    // The livestream case gets a calm, one-time notice rather than the
    // alarming pill treatment: it is a documented limitation, and telling
    // someone their filter is BROKEN when it is merely inapplicable is its
    // own kind of misrepresentation.
    if (verdict.reason === api.REASONS.LIVESTREAM && !session.liveNoticeShown) {
      session.liveNoticeShown = true;
      showPlayerNotice(verdict.message, 'neutral');
    }
    // Page-scoped flag, so a fast scroll through twenty Shorts produces one
    // notice rather than twenty.
    if (verdict.reason === api.REASONS.SHORTS && !shortsNoticeShown) {
      shortsNoticeShown = true;
      showPlayerNotice(verdict.message, 'neutral');
    }
  }

  function sendHealthToBackground(status) {
    try {
      var p = chrome.runtime.sendMessage({ type: 'pm-health', status: status });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) {
      // Orphaned content script, or the SW asleep mid-send. The badge is a
      // convenience and is never worth throwing into the pipeline for.
    }
  }

  // ---- milestone pill (0.1.33) --------------------------------------------
  //
  // A single, bounded, informational moment when the usage milestone is
  // first reached: "N videos protected". The service worker owns the
  // decision and the one-shot latch (it is the only context that sees the
  // stats and the latch without the popup being open); this file asks once
  // per page and renders the answer.
  //
  // It is product status, so pm_showStatus=false suppresses it entirely,
  // unlike the health warning. Asking is skipped in that case so the latch
  // is not silently consumed for someone who would never see it.
  var milestoneText = null;
  var milestoneUntilWall = 0;
  var milestoneAsked = false;

  function maybeAskMilestone() {
    if (milestoneAsked) return;
    if (!statusSettings.showStatus) return; // routine status opt-out
    milestoneAsked = true;
    try {
      chrome.runtime.sendMessage(
        { type: 'pm-milestone-check', showStatus: true },
        function (resp) {
          if (chrome.runtime && chrome.runtime.lastError) return;
          if (!resp || !resp.show || !resp.text) return;
          var m = globalThis.PMMoments;
          var visibleMs = (m && m.MILESTONE_VISIBLE_MS) || 8000;
          milestoneText = resp.text;
          milestoneUntilWall = Date.now() + visibleMs;
          TLOG(TAG, '[PM-MILESTONE] ' + resp.text);
        }
      );
    } catch (e) {
      // No SW available: nothing to show, nothing to clean up.
    }
  }

  function activeMilestoneText() {
    if (!milestoneText) return null;
    if (Date.now() > milestoneUntilWall) {
      milestoneText = null;
      return null;
    }
    return milestoneText;
  }

  function currentHealth() {
    return session ? session.health : null;
  }

  function isUnhealthy() {
    var api = healthApi();
    var h = currentHealth();
    return !!(api && h && h.status === api.STATUS.UNHEALTHY);
  }

  // ---- [PM-PILL] input tracing (0.1.35) ------------------------------------
  //
  // The 0.1.34 field re-test had the pill showing states that were
  // impossible on fresh inputs: "Press play to load audio" while paused
  // with captured audio at the playhead, and "Analyzing" with 28 seconds of
  // coverage past the playhead. When a state machine is provably correct and
  // its output is provably wrong, the answer is always in its INPUTS, and
  // guessing at those from the outside cost this round a lot of time.
  //
  // So every state CHANGE (not every tick, which would drown the log) emits
  // the entire input vector that produced it. The session identity is in
  // there deliberately: the actual bug turned out to be two code paths
  // holding different session objects, where every value looks plausible
  // and only the identity is wrong.
  //
  // Gated on pm_debugOverlay, and routed through TLOG so it lands in the
  // ring buffer that "Copy logs" pastes: the point is that the user's next
  // paste reconstructs the pill's whole history without another round trip.
  var lastTracedPillKind = null;
  // The label the user actually read, recorded so the trace shows both the
  // internal decision and its presentation (0.1.36).
  var lastPresentedLabel = null;

  function tracePillState(state) {
    if (!debugSettings.debugOverlay) return;
    var kind = state ? state.kind : 'none';
    if (kind === lastTracedPillKind) return;
    var prev = lastTracedPillKind;
    lastTracedPillKind = kind;
    var d = (state && state.trace) || {};
    TLOG(
      TAG,
      '[PM-PILL] ' + (prev || 'none') + ' -> ' + kind +
        ' wall=' + new Date().toISOString().slice(11, 23) +
        ' session=#' + (session ? session.instanceId : 'none') + '/' + (session ? session.videoId : 'none') +
        ' t=' + (d.t != null ? d.t.toFixed(2) : 'NA') +
        ' paused=' + (d.paused != null ? d.paused : 'NA') +
        ' capturedAtPlayhead=' + (d.capturedAtPlayhead != null ? d.capturedAtPlayhead : 'NA') +
        ' nearestCaptured=' + (d.nearestCaptured || 'none') +
        ' bufferedRanges=' + (d.bufferedRangesCount != null ? d.bufferedRangesCount : 'NA') +
        ' coverageEnd=' + (d.coverageEnd != null ? d.coverageEnd.toFixed(2) : 'NA') +
        ' horizonEnd=' + (d.horizonEnd != null ? d.horizonEnd.toFixed(2) : 'NA') +
        ' uncoveredInMargin=' + (d.uncoveredInMargin != null ? d.uncoveredInMargin.toFixed(2) : 'NA') +
        ' growthMs=' + (d.growthMs != null ? Math.round(d.growthMs) : 'NA') +
        ' windows=' + (session ? session.windowsCompleted : 'NA') +
        ' inFlight=' + (d.inFlight != null ? d.inFlight : 'NA') +
        ' promise=' + (d.promise || 'none') +
        (state && state.etaS != null ? ' etaS=' + state.etaS : '') +
        ' presented="' + (lastPresentedLabel || 'none') + '"'
    );
  }

  // The coverage end that actually matters for the playhead: the end of the
  // covered interval containing (or immediately following) t. Reporting a
  // global max would hide exactly the gap-before-the-playhead case.
  function coverageEndNear(intervals, t) {
    var best = null;
    for (var i = 0; i < intervals.length; i++) {
      var iv = intervals[i];
      if (iv.end <= t) continue;
      if (iv.start <= t + COVERAGE_EPS) return iv.end; // contains the playhead
      if (best == null) best = iv.end; // first one ahead of it
    }
    return best;
  }

  function computeStatusState() {
    if (!session) return null;

    if (session.unanalyzable) return { kind: 'off' };
    var video = getVideo();
    if (!video) return null;
    if (isShortsPage()) return { kind: 'shorts' };
    if (isLiveStream(video)) return { kind: 'live' };
    var t = video.currentTime;
    // Built once, attached to whichever state is returned below, so the
    // trace can never disagree with the decision it is explaining.
    var trace = {
      t: t,
      paused: video.paused,
      bufferedRangesCount: session.bufferedRanges.length,
      coverageEnd: coverageEndNear(session.coveredIntervals, t),
      growthMs: Date.now() - (session.lastBufferedGrowthWall || 0)
    };
    function withTrace(state) {
      trace.promise = session.etaPromise
        ? 'eta=' + session.etaPromise.etaS + 's age=' +
          Math.round((Date.now() - session.etaPromise.issuedWall) / 1000) + 's@w' +
          session.etaPromise.windowsAtIssue
        : 'none';
      state.trace = trace;
      return state;
    }
    var horizonEnd = clampedHorizonEnd(video, t);
    // "Protected" means the whole [t, t+margin] window is covered, not just
    // its two endpoints - a gap in the middle (real, given how transcription
    // windows land) must not read as protected.
    trace.horizonEnd = horizonEnd;
    trace.uncoveredInMargin = uncoveredDurationWithin(session.coveredIntervals, t, horizonEnd);

    // 0.1.36(b): the FULL input vector is computed before any branch reads
    // or reports it. The 0.1.35 trace had a transition logging
    // capturedAtPlayhead=NA with bufferedRanges=1 that contained the
    // playhead, because the protected branch returned before these were
    // computed. A trace that varies by branch is worse than no trace: it
    // invites conclusions from fields that were never evaluated.
    var playheadRange = null;
    for (var i = 0; i < session.bufferedRanges.length; i++) {
      var r = session.bufferedRanges[i];
      if (t >= r.start - 0.5 && t < r.end) {
        playheadRange = r;
        break;
      }
    }
    trace.capturedAtPlayhead = !!playheadRange;
    if (playheadRange) {
      trace.nearestCaptured = '[' + playheadRange.start.toFixed(2) + ',' + playheadRange.end.toFixed(2) + ')';
    } else if (session.bufferedRanges.length) {
      var nearest = session.bufferedRanges[0];
      for (var ni = 1; ni < session.bufferedRanges.length; ni++) {
        var cand = session.bufferedRanges[ni];
        if (Math.abs(cand.start - t) < Math.abs(nearest.start - t)) nearest = cand;
      }
      trace.nearestCaptured = '[' + nearest.start.toFixed(2) + ',' + nearest.end.toFixed(2) + ')';
    } else {
      trace.nearestCaptured = 'none';
    }
    trace.inFlight = Date.now() - (session.lastHeartbeatWall || 0) < HEARTBEAT_FRESH_MS;

    if (trace.uncoveredInMargin <= COVERAGE_EPS) {
      return withTrace({ kind: 'protected' });
    }

    if (playheadRange) {
      // Captured already - just queued/processing. ETA from how much of
      // the playhead's own protection HORIZON - not the whole captured
      // range, which can (and normally does) extend far past the horizon
      // since buffering intentionally leads transcription - is still
      // uncovered.
      var uncoveredAheadS = uncoveredDurationWithin(session.coveredIntervals, t, Math.min(horizonEnd, playheadRange.end));
      var rtf = session.lastKnownRtf != null ? Math.min(0.85, Math.max(0.1, session.lastKnownRtf)) : 0.3;
      // 0.1.36(a): floored. The trace quoted "~1s" on a cold seek from the
      // default rtf guess, which is not a plausible time to load a model,
      // demux and transcribe anything; the countdown then hit zero and the
      // old model escalated to alarming copy two seconds into a normal cold
      // start. Until a real rtf has been measured the floor is generous.
      var pillApi = globalThis.PMPill;
      // 0.1.40: quote TIME-TO-PROTECTED using measured wall-clock
      // throughput, biased pessimistic. Falls back to the old
      // per-window estimate only if the shared module is missing.
      var hasRtf = session.effectiveRtf != null || session.lastKnownRtf != null;
      var etaS = pillApi
        ? pillApi.estimateSecondsToProtected(
            uncoveredAheadS,
            session.effectiveRtf != null ? session.effectiveRtf : rtf,
            hasRtf
          )
        : Math.min(30, Math.max(1, Math.ceil(uncoveredAheadS * rtf)));

      // The promise ledger (0.1.34) lives in shared/health.js, because the
      // pill and the health monitor both act on the same promise and must
      // not disagree about it. The promise holds its ORIGINAL clock and
      // quote until a window completes; re-quoting a fresh "~3s" on every
      // render is exactly how the pill stayed plausible for 30+ seconds
      // while nothing at all progressed.
      var api = healthApi();
      if (!api) return withTrace({ kind: 'analyzing-safe', etaS: etaS });
      session.etaPromise = api.openOrKeepPromise(session.etaPromise, {
        now: Date.now(),
        windowsCompleted: session.windowsCompleted,
        etaS: etaS
      });
      // Past twice the quoted time with nothing completed, stop repeating a
      // number already proven wrong and say so plainly. Deliberately softer
      // than the health warning: at 2x this is "taking longer than
      // expected", which is true and might still resolve; the monitor's own
      // slower check is what escalates to "not filtering" if it never does.
      // 0.1.40: the DISPLAY ledger. New estimates may only lower what is on
      // screen; a worse one holds the number flat instead of ticking it up.
      // A number that can rise is not a countdown, and the user stops
      // trusting it, which costs more than the accuracy gained.
      if (pillApi) {
        session.countdown = pillApi.advanceCountdown(session.countdown, {
          candidateS: etaS,
          now: Date.now(),
          reset: session.countdownReset === true
        });
        session.countdownReset = false;
      }
      var displayedS = session.countdown ? session.countdown.displayedS : etaS;
      trace.displayedEta = displayedS;
      // Held flat at zero for longer than the promise allows: the elapsed
      // rule takes over with the numberless label. That is the escape
      // valve, and it is why the display never needs to tick upward.
      if (api.promiseEscalated(session.etaPromise, Date.now())) {
        return withTrace({ kind: 'analyzing-slow' });
      }
      return withTrace({ kind: 'analyzing-safe', etaS: session.etaPromise.etaS, displayedS: displayedS });
    }

    var sinceGrowthMs = Date.now() - (session.lastBufferedGrowthWall || 0);
    if (sinceGrowthMs < STATUS_GROWTH_RECENT_MS) return withTrace({ kind: 'buffering' });
    // 0.1.34: "Press play to load audio" told the user to do something they
    // were already doing. The field test showed it while the video was
    // PLAYING, because capture growth stopping is not the same fact as
    // playback stopping: once YouTube has buffered far enough ahead it stops
    // appending for a while, and playback carries on regardless. The advice
    // is only true if the video is actually paused, so it now says so only
    // then. A playing video with no growth is simply waiting on the
    // pipeline, which is what "analyzing" means.
    if (sinceGrowthMs >= STATUS_GROWTH_STALLED_MS && video.paused) return withTrace({ kind: 'needs-play' });
    return withTrace({ kind: 'buffering' }); // brief in-between window (recent < x < stalled) - still assume progress, avoid label flicker
  }

  function renderStatusPill() {
    var settings = currentSettings();
    // Compute the state FIRST, before any early return (0.1.34). The pill's
    // state machine is also the ETA promise ledger, and the health monitor's
    // broken-promise check reads that ledger. If this only ran when the pill
    // was on screen, then anyone who had turned pm_showStatus off could
    // never get the stalled-analysis warning, which is precisely the warning
    // that is not supposed to be suppressible. Displaying is gated below;
    // knowing is not.
    var status = settings.enabled ? computeStatusState() : null;
    // Presentation is computed BEFORE tracing so a trace line reports the
    // label that this same evaluation produced. Tracing first would log the
    // PREVIOUS label against the current state, which is precisely the kind
    // of subtly-wrong diagnostic that cost this round two releases.
    var pillApi = globalThis.PMPill;
    var presented = status && pillApi
      ? pillApi.present(status, {
          promise: session ? session.etaPromise : null,
          displayedS: status.displayedS,
          now: Date.now()
        })
      : null;
    lastPresentedLabel = presented ? presented.label : null;
    // Traced on CHANGE only, so a paste reconstructs the pill's history
    // without a line per tick. See tracePillState.
    tracePillState(status);
    // Leaving the analyzing states retires any outstanding promise, so a
    // later re-entry starts a fresh clock rather than inheriting a stale one.
    if (session && (!status || (status.kind !== 'analyzing-safe' && status.kind !== 'analyzing-slow'))) {
      session.etaPromise = null;
    }
    // A failure warning is NOT routine status, so pm_showStatus does not
    // suppress it (0.1.32). Turning off the pill means "stop telling me
    // things are fine"; it cannot reasonably be read as "don't tell me
    // when the filter has stopped working". pm_enabled IS still respected:
    // an extension the user switched off is not failing, it is off.
    if (settings.enabled && isUnhealthy()) {
      setStatusPillActive(true, 'warning');
      if (statusPillEl) {
        setPillContent('Profanity Muter is NOT filtering this video');
      }
      return;
    }
    if (!settings.enabled || !statusSettings.showStatus) {
      setStatusPillActive(false);
      return;
    }
    // A one-off notice (livestream, Shorts, protected content) takes the
    // badge for a few seconds, then it reverts to the state label. Ranked
    // below the health warning, which outranks everything.
    var notice = activeNoticeText();
    if (notice) {
      setStatusPillActive(true, 'notice');
      if (statusPillEl) setPillContent(notice);
      return;
    }
    // Health outranks the milestone everywhere, which is why this sits
    // below the unhealthy branch above rather than before it.
    var milestone = activeMilestoneText();
    if (milestone) {
      setStatusPillActive(true, 'milestone');
      if (statusPillEl) setPillContent(milestone);
      return;
    }
    if (!status) {
      setStatusPillActive(false);
      return;
    }
    setStatusPillActive(true, 'normal');
    if (!statusPillEl) return;
    // 0.1.36(1): presentation collapse. The internal states stay, because
    // the logic and the traces need the distinctions; what the user reads
    // is one processing state with a live countdown, then Protected. See
    // shared/pill.js for the reasoning and the countdown's two failure
    // modes.
    if (presented) {
      {
        // 0.1.37: NO language suffix. The badge showed "Protected · ko" to
        // a user watching an English video, who had no idea what "ko"
        // meant. A two-letter code is dev information, and the badge is the
        // one surface a non-technical user reads: countdown, Protected,
        // warnings, nothing else. The language still appears in the
        // [PM-LANG] traces and the devlog, where it belongs.
        var presentedLabel = presented.label;
        var mutedCount = session ? session.mutedCount || 0 : 0;
        if (mutedCount > 0) presentedLabel += ' · ' + mutedCount + ' muted';
        setPillContent(presentedLabel);
        return;
      }
    }
    var label;
    if (status.kind === 'off') label = 'Off';
    else if (status.kind === 'shorts') label = 'Shorts not supported';
    else if (status.kind === 'live') label = 'Live - limited support';
    else if (status.kind === 'protected') label = 'Protected';
    else if (status.kind === 'analyzing-safe') label = 'Analyzing - safe to pause (~' + status.etaS + 's)';
    else if (status.kind === 'buffering') label = 'Buffering + analyzing…';
    else if (status.kind === 'analyzing-slow') label = 'Analyzing - taking longer than expected';
    else if (status.kind === 'needs-play') label = 'Press play to load audio';
    else label = 'Analyzing…';
    // 0.1.37: the language suffix is gone from this legacy fallback path
    // too, for the same reason it left the main one. A user shown
    // "Protected · ko" on an English video learns nothing from the suffix
    // and mistrusts the word in front of it.
    var count = session ? session.mutedCount || 0 : 0;
    if (count > 0) label += ' · ' + count + ' muted';
    setPillContent(label);
  }
  // `tone` is 'normal' or 'warning'. The warning treatment is deliberately
  // loud relative to the routine pill (solid red rather than translucent
  // black, and bold) because it is the one pill state a user must not
  // skim past. No emoji, consistent with the rest of the extension's
  // styling.

  // The pill leads with the extension's own mark (icons/icon32.png, listed
  // in web_accessible_resources) rather than a generic shield emoji, so
  // the pill is visibly OURS on a page full of YouTube's UI. Content is
  // rebuilt img+text on every update; the img is 12px, decorative
  // (alt=""), and never receives pointer events (the pill itself is
  // pointer-events:none).
  function setPillContent(text) {
    if (!statusPillEl) return;
    while (statusPillEl.firstChild) statusPillEl.removeChild(statusPillEl.firstChild);
    try {
      var mark = document.createElement('img');
      mark.src = chrome.runtime.getURL('icons/icon32.png');
      mark.alt = '';
      mark.style.cssText = 'width:12px;height:12px;vertical-align:-2px;margin-right:5px;border-radius:2px;';
      statusPillEl.appendChild(mark);
    } catch (e) { /* chrome.* unavailable: text-only pill */ }
    statusPillEl.appendChild(document.createTextNode(text));
  }
  var statusPillTone = null;

  // 0.1.37: the adaptive position, as a stylesheet rather than JS.
  //
  // The badge's resting place depends on whether the player is showing its
  // chrome. YouTube already publishes that as `ytp-autohide` on the player
  // element, so a descendant rule tracks the real state with no polling and
  // no observer, and a transition makes it glide rather than jump.
  //
  // The inline style still sets `top`, so these rules carry !important:
  // that is the price of the badge being built in JS, and it is worth
  // paying to keep the position logic declarative. The DEFAULT is the
  // chrome-visible offset, so if `ytp-autohide` ever disappears the rule
  // simply never matches and the badge stays where it is safe rather than
  // flapping or sitting under the title text.
  var badgeStyleEl = null;
  function ensureBadgeStyle() {
    if (badgeStyleEl && badgeStyleEl.isConnected) return;
    var api = globalThis.PMPill;
    var chromeTop = (api && api.BADGE_TOP_PX) || 56;
    var idleTop = (api && api.BADGE_TOP_IDLE_PX) || 12;
    try {
      badgeStyleEl = document.createElement('style');
      badgeStyleEl.textContent =
        '.pm-badge{top:' + chromeTop + 'px !important;' +
        'transition:top 180ms cubic-bezier(0.4,0,0.2,1) !important;}' +
        '.ytp-autohide .pm-badge{top:' + idleTop + 'px !important;}';
      (document.head || document.documentElement).appendChild(badgeStyleEl);
    } catch (e) {
      badgeStyleEl = null; // inline top remains, which is the safe offset
    }
  }

  // Clicking the badge opens the extension UI. The service worker owns the
  // attempt ladder (see background.js): chrome.action.openPopup() needs a
  // user gesture and has shipped and unshipped across Chrome versions, so
  // it is tried rather than relied on, with the popup page in a tab as the
  // fallback.
  function openExtensionUi() {
    var api = globalThis.PMPill;
    var msg = api ? api.openUiMessage() : { type: 'pm-open-ui' };
    try {
      var p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(function () {});
      TLOG(TAG, '[PM-BADGE] clicked: requested the extension UI');
    } catch (e) {
      TWARN(TAG, '[PM-BADGE] could not reach the service worker: ' + String(e));
    }
  }
  function setStatusPillActive(active, tone) {
    tone = tone || 'normal';
    // A tone change on an existing pill has to re-style it, not just
    // re-label it; simplest correct thing is to rebuild.
    if (active && statusPillEl && tone !== statusPillTone) {
      setStatusPillActive(false);
    }
    if (active && !statusPillEl) {
      var video = getVideo();
      var container = video ? video.closest('.html5-video-player') || video.parentElement : document.body;
      if (!container) return;
      statusPillEl = document.createElement('div');
      statusPillTone = tone;
      ensureBadgeStyle();
      var pillGeom = globalThis.PMPill;
      var topPx = pillGeom ? pillGeom.BADGE_TOP_PX : 56;
      var leftPx = pillGeom ? pillGeom.BADGE_LEFT_PX : 12;
      // 0.1.36 addendum: ONE badge, top-left, clickable.
      //
      // The vertical offset clears YouTube's hover chrome. The player fades
      // in a title gradient across the top on mouse-over, and a badge at
      // top:8px sits underneath that text, which is why this is 56 and not
      // 8. It stays in the corner people look at first.
      //
      // pointer-events is now `auto` on the badge and nowhere else: the
      // badge is the only thing that catches the pointer, and the player
      // around it stays fully click-through. A filter that ate clicks on
      // the video it is filtering would be a worse bug than the missing
      // affordance it fixed.
      statusPillEl.style.cssText =
        'position:absolute;top:' + topPx + 'px;left:' + leftPx + 'px;z-index:2147483646;' +
        (tone === 'warning'
          ? 'background:#8a1f11;color:#fff;font:bold 11px/1.4 sans-serif;'
          : tone === 'milestone'
            ? 'background:#1d2f54;color:#f3e6c0;font:11px/1.4 sans-serif;'
            : tone === 'notice'
              ? 'background:#555;color:#fff;font:11px/1.4 sans-serif;'
            : 'background:rgba(0,0,0,0.62);color:#fff;font:11px/1.4 sans-serif;') +
        'padding:3px 8px;' +
        'border-radius:3px;pointer-events:auto;cursor:pointer;white-space:nowrap;' +
        'user-select:none;transition:filter 120ms ease;';
      statusPillEl.className = 'pm-badge';
      statusPillEl.setAttribute('role', 'button');
      statusPillEl.setAttribute('tabindex', '0');
      statusPillEl.setAttribute('aria-label', 'Profanity Muter - open settings');
      statusPillEl.setAttribute('title', 'Profanity Muter - open settings');
      statusPillEl.addEventListener('mouseenter', function () {
        if (statusPillEl) statusPillEl.style.filter = 'brightness(1.35)';
      });
      statusPillEl.addEventListener('mouseleave', function () {
        if (statusPillEl) statusPillEl.style.filter = '';
      });
      // Stop the click reaching the player underneath, which would pause
      // the video as a side effect of asking for settings.
      statusPillEl.addEventListener('click', function (ev) {
        ev.stopPropagation();
        ev.preventDefault();
        openExtensionUi();
      });
      statusPillEl.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.stopPropagation();
        ev.preventDefault();
        openExtensionUi();
      });
      if (container === document.body) {
        statusPillEl.style.position = 'fixed';
      } else if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }
      container.appendChild(statusPillEl);
    } else if (!active && statusPillEl) {
      if (statusPillEl.parentElement) statusPillEl.parentElement.removeChild(statusPillEl);
      statusPillEl = null;
      statusPillTone = null;
    }
  }
  // Polling stays as the backstop, but the pill is now also refreshed at the
  // exact moments its answer changes (0.1.34). The field test showed the
  // pill lagging reality by many seconds, which for a status indicator is
  // the same as lying: a user who pauses on "safe to pause" is acting on
  // what it said a moment ago, not on what is true now.
  setInterval(renderStatusPill, 500); // ~2Hz backstop
  function refreshPillSoon() {
    // A microtask hop, so a burst of events (play + seeking + a window
    // landing together) coalesces into one render rather than three.
    if (refreshPillSoon._q) return;
    refreshPillSoon._q = true;
    Promise.resolve().then(function () {
      refreshPillSoon._q = false;
      try {
        renderStatusPill();
      } catch (e) {
        /* the pill is never worth throwing into the pipeline for */
      }
    });
  }
  ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'ended'].forEach(function (evt) {
    document.addEventListener(evt, function (ev) {
      if (ev.target instanceof HTMLVideoElement) refreshPillSoon();
    }, true);
  });

  // pm_enabled=false must turn the ENTIRE extension off, not just stop
  // future muting decisions (0.1.13). Called synchronously from the
  // storage.onChanged handler, same pattern as handleCatchupModeChanged.
  var loggedDisabledLine = false;
  function handleEnabledChanged(newEnabled) {
    if (newEnabled) {
      // Re-enabling mid-page resumes cleanly from existing session state -
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
    // Release any active protection immediately - don't wait for tick() to
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
    // lightweight hook installed regardless - it has no knowledge of
    // pm_enabled and doesn't need it; only content.js's relay stops).
    if (session) safePortPost({ type: 'disable', videoId: session.videoId });
  }

  // Synchronous catch-up-mode transition (0.1.11: fixes "lags super hard" /
  // gets permanently stuck when switching pause<->mute mid-catchup). Called
  // directly from the storage.onChanged handler with the NEW mode value -
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

    // catchupFallbackActive is a pause-mode-specific concept (see tick()) -
    // clear it when leaving pause mode so a stale flag doesn't linger and
    // confuse a later re-entry into pause mode.
    if (newMode !== 'pause') session.catchupFallbackActive = false;

    // Leaving "pause": tick() only ever calls resumeFromCatchup() from
    // inside its OWN 'pause'-mode branch, so a video paused-for-catchup and
    // then switched to 'mute'/'play' would otherwise stay paused forever -
    // nothing else in tick() touches catchupPausedByUs. Resume right away.
    if (newMode !== 'pause' && catchupPausedByUs) {
      resumeFromCatchup('catchup-mode-changed-away-from-pause');
    }

    var hit = inMutedInterval(video.currentTime);
    var uncoveredNow = newMode !== 'play' && !isCovered(video.currentTime);

    if (newMode === 'pause') {
      // A forced mute from the old 'mute' strategy's uncovered-region reason
      // is now the wrong protection mechanism - release it immediately and
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
    // Re-engage debounce (0.1.36). At a coverage edge the covered/uncovered
    // answer flickers as the playhead crosses the boundary, and pausing
    // again milliseconds after releasing produced the stutter the field
    // trace caught: three engage/clear cycles in four seconds. The next
    // window is usually seconds away, so the protection given up here is
    // small and the behaviour removed is one the user reads as the
    // extension malfunctioning.
    var debounceApi = catchupApi();
    if (
      debounceApi &&
      !debounceApi.mayEngagePause({ lastReleaseWall: lastCatchupReleaseWall, now: Date.now() })
    ) {
      return;
    }
    var video = getVideo();
    if (!video || catchupPausedByUs) return;
    catchupPausedByUs = true;
    showAnalyzingOverlay(true);
    if (!video.paused) {
      markSelfPause();
      video.pause();
    }
    TLOG(TAG, 'PAUSE-CATCHUP engaged t=' + video.currentTime.toFixed(2));
  }

  function resumeFromCatchup(reason) {
    if (!catchupPausedByUs) return;
    var video = getVideo();
    catchupPausedByUs = false;
    lastCatchupReleaseWall = Date.now();
    showAnalyzingOverlay(false);
    if (video && video.paused) {
      markSelfPlay();
      video.play().catch(function () {});
    }
    TLOG(TAG, 'PAUSE-CATCHUP released t=' + (video ? video.currentTime.toFixed(2) : 'NA') + ' reason=' + reason);
  }

  // Fallback ladder (0.1.12): resumes playback like resumeFromCatchup(), but
  // deliberately does NOT hide the "Analyzing audio…" overlay - the fallback
  // is still actively protecting this stall via muted playback instead of a
  // pause, and hiding the overlay here would look like protection ended
  // when it didn't. Caller (tick()) is responsible for hiding the overlay
  // once coverage actually catches up.
  // Replay the stretch the muted-playback fallback consumed, once it is
  // covered. Guarded hard: the user's own seek supersedes (their navigation
  // outranks recovering audio they chose to skip), and a sub-threshold
  // rewind is more jarring than the fraction of a second it recovers.
  function maybeRewindAfterFallback(video, t) {
    if (!session || session.fallbackStartT == null || !video) return;
    var api = catchupApi();
    var startT = session.fallbackStartT;
    var uncoveredInSpan = uncoveredDurationWithin(session.coveredIntervals, startT, t);
    var decision = api
      ? api.rewindDecision({
          fallbackStartT: startT,
          playheadT: t,
          uncoveredInSpanS: uncoveredInSpan,
          userSeekedSince: session.userSeekedSinceFallback
        })
      : { rewind: false, reason: 'no-catchup-module' };

    if (!decision.rewind) {
      // Only retire the pending rewind for terminal reasons. "not covered
      // yet" is a wait, not a refusal.
      if (decision.reason !== 'not-covered-yet') {
        if (decision.reason !== 'no-pending-fallback') {
          TLOG(TAG, '[PM-REWIND] skipped rewind to ' + startT.toFixed(2) + ': ' + decision.reason);
          devlog('logError', '[PM-REWIND] skipped rewind to ' + startT.toFixed(2) + ' (' + decision.reason + ')');
        }
        session.fallbackStartT = null;
        session.userSeekedSinceFallback = false;
      }
      return;
    }

    var recoveredS = t - decision.toT;
    session.fallbackStartT = null;
    session.userSeekedSinceFallback = false;
    releaseMute('fallback-rewind');
    TLOG(
      TAG,
      '[PM-REWIND] replaying ' + recoveredS.toFixed(2) + 's that played muted: seeking ' +
        t.toFixed(2) + ' -> ' + decision.toT.toFixed(2)
    );
    devlog('logHealth', {
      status: 'recovered',
      reason: 'fallback-rewind',
      playbackMs: Math.round(recoveredS * 1000),
      windowsCompleted: session.windowsCompleted
    });
    // Our own seek: mark it so the seeking handler does not read it as the
    // user superseding the rewind we are performing.
    selfSeekMark = catchupApi() ? catchupApi().markSelfAction(Date.now()) : { wall: Date.now() };
    try {
      video.currentTime = decision.toT;
    } catch (e) {
      TWARN(TAG, '[PM-REWIND] seek failed: ' + String(e));
    }
    if (video.paused) {
      markSelfPlay();
      video.play().catch(function () {});
    }
  }

  function resumeFromCatchupKeepOverlay() {
    if (!catchupPausedByUs) return;
    var video = getVideo();
    catchupPausedByUs = false;
    lastCatchupReleaseWall = Date.now();
    if (video && video.paused) {
      markSelfPlay();
      video.play().catch(function () {});
    }
    TLOG(TAG, 'PAUSE-CATCHUP downgraded to muted-playback fallback t=' + (video ? video.currentTime.toFixed(2) : 'NA'));
  }

  document.addEventListener(
    'pause',
    function (ev) {
      if (!(ev.target instanceof HTMLVideoElement)) return;
      var pauseApi = catchupApi();
      var pauseVerdict = pauseApi
        ? pauseApi.ownershipOnPlaybackEvent({ owned: catchupPausedByUs, marker: selfPauseMark, now: Date.now() })
        : { owned: catchupPausedByUs, cleared: false, selfInitiated: false };
      if (pauseVerdict.selfInitiated) {
        selfPauseMark = null; // consumed, so a second event cannot claim it
        return;
      }
      if (pauseVerdict.cleared) {
        catchupPausedByUs = false; // user (or something else) paused independently - never fight it
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
      var playApi = catchupApi();
      var playVerdict = playApi
        ? playApi.ownershipOnPlaybackEvent({ owned: catchupPausedByUs, marker: selfPlayMark, now: Date.now() })
        : { owned: catchupPausedByUs, cleared: false, selfInitiated: false };
      if (playVerdict.selfInitiated) {
        selfPlayMark = null;
        return;
      }
      if (playVerdict.cleared) {
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
    TWARN(TAG, '[PM-STALL] no coverage growth for ' + STALL_MS + 'ms while playing an uncovered region - requesting pipeline restart');
    safePortPost({ type: 'restart', videoId: session.videoId });
    // Capture-miss eviction (0.1.13) is on-demand ONLY, gated on this exact
    // signal (per the minimal-footprint principle: mutating player/network
    // state is a last resort, tried only after 15s of genuinely zero
    // progress - well downstream of the 8s pause->mute fallback ladder,
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
  // chains (rAF stays suspended/throttled while hidden regardless - calling
  // this doesn't fight that, it's just a separate, additional trigger for
  // the SAME enforcement).
  function runTickLogic() {
    var video = getVideo();
    var settings = currentSettings();
    // Health monitoring runs on the same tick as everything else, before
    // the enabled-gate below: the playback clock has to keep ticking (and
    // the verdict has to stay current) independently of the mute/pause
    // decisions further down. evaluateHealth throttles itself, so calling
    // it every frame costs one comparison until a verdict is actually due.
    if (session && settings.enabled) {
      samplePlayback(video);
      evaluateHealth(video);
    } else if (session) {
      // Disabled: stop accruing playback so re-enabling later doesn't
      // instantly trip the threshold on time the pipeline never had.
      session.lastPlaybackSampleWall = 0;
    }
    if (video && session && settings.enabled) {
      var t = video.currentTime;
      var hit = inMutedInterval(t);
      // `&& !session.unanalyzable`: DRM/undecodable content (0.1.15) never
      // gets any real coverage, ever - without this, safe mode would mute/
      // pause this video forever waiting for transcription that offscreen
      // has already given up on (see the 'unanalyzable' handler above).
      var uncovered = settings.safeMode && !isCovered(t) && !session.unanalyzable;

      // [PM-CATCHUP-TIME] (0.1.17): visible in every Copy Logs paste so the
      // "uncovered -> covered" latency after a seek is a measured fact, not
      // an impression. Resolves on plain isCovered(t) (not the `uncovered`
      // var above, which also folds in unrelated settings/unanalyzable
      // state) - coverage reaching the playhead is the actual thing being
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
      // "muteReason === 'safe-mode-uncovered'" / "starts with 'word:'" - a
      // word interval landing while already forced-muted for
      // safe-mode-uncovered (or vice versa) left muteReason stale, so once
      // BOTH causes had actually ended, neither release check's string match
      // fired and the video stayed muted indefinitely. Observed live on a
      // real-Chrome regression run: coverage caught up seconds after landing
      // on a cold seek, but a word-hit inside that same still-uncovered
      // window pinned muteReason at 'safe-mode-uncovered' (never mind, at
      // 'word:X') and the mute never released. muteReason is now purely
      // informational (logging) - never a release condition.
      if (settings.catchupMode === 'pause') {
        // Word-level muting still always uses mute, even in pause mode.
        // Guarded against catchupFallbackActive: while the fallback ladder
        // below has downgraded to muted playback for an uncovered region,
        // this branch must NOT release that mute just because there's no
        // word-hit right now - the covered-region branch further down is
        // what ends the fallback (and does so more carefully, see there).
        if (hit && settings.muteAudio && !session.forcedMute) {
          engageMute('word:' + hit.word, hit);
        } else if (!hit && session.forcedMute && !session.catchupFallbackActive) {
          releaseMute('interval-ended');
        }

        if (uncovered && !hit) {
          if (session.catchupFallbackActive) {
            // Already downgraded for this stall - keep protecting via mute
            // until coverage catches up (engageMute no-ops if already
            // forced, e.g. from an overlapping word-hit).
            if (!session.forcedMute) engageMute('safe-mode-uncovered');
          } else {
            pauseForCatchup();
            // Fallback ladder (0.1.12): a real deadlock class exists here -
            // (a) pausing stops YouTube from fetching/appending anything
            // further, and (b) a region YouTube buffered BEFORE our hook
            // attached can never be captured passively no matter how long we
            // wait (see capture.js's eviction mechanism, which this pairs
            // with). If pause-catchup makes zero coverage progress for
            // FALLBACK_STALL_MS, downgrade to muted PLAYBACK instead -
            // playing is what makes YouTube resume buffering/appending (and
            // is what lets capture.js's eviction check see currentTime
            // advance) - keeping the "Analyzing audio…" overlay up so
            // protection still reads as active.
            // 0.1.36 addendum: the old condition measured COVERAGE growth
            // alone, and coverage does not move while a window is still
            // being transcribed, so a slow first window looked exactly like
            // a dead pipeline. The field trace caught it firing while a
            // window was actively computing and capture had reached [0,29),
            // costing the user the first 2.44 seconds of a video: spoken
            // words played silently and gone. Starvation now has to be true
            // on every axis at once. See shared/catchup.js.
            var fbApi = catchupApi();
            var heartbeatFresh = Date.now() - (session.lastHeartbeatWall || 0) < HEARTBEAT_FRESH_MS;
            var starved = fbApi
              ? fbApi.shouldEngageFallback({
                  windowInFlight: heartbeatFresh,
                  msSinceCoverageGrowth: Date.now() - session.lastCoverageGrowthWall,
                  msSinceCaptureGrowth: Date.now() - (session.lastBufferedGrowthWall || 0),
                  uncoveredAtPlayhead: true, // this branch only runs while uncovered
                  thresholdMs: FALLBACK_STALL_MS
                })
              : Date.now() - session.lastCoverageGrowthWall > FALLBACK_STALL_MS;
            if (catchupPausedByUs && starved) {
              TWARN(
                TAG,
                '[PM-FALLBACK] pause-catchup genuinely starved for ' + FALLBACK_STALL_MS +
                  'ms at t=' + t.toFixed(2) + ' (no window in flight, no capture growth) - downgrading to muted playback so YouTube resumes buffering/appending'
              );
              session.catchupFallbackActive = true;
              // Remember where the silence starts so it can be replayed.
              session.fallbackStartT = t;
              session.userSeekedSinceFallback = false;
              resumeFromCatchupKeepOverlay();
              engageMute('safe-mode-uncovered');
            }
          }
        } else if (!uncovered) {
          if (session.catchupFallbackActive) {
            session.catchupFallbackActive = false;
            showAnalyzingOverlay(false);
            // 0.1.36 addendum: replay what the fallback consumed. Muted
            // playback is protection paid for with the user's content, and
            // without this the payment is permanent: the trace's first 2.44
            // seconds of speech played silently and were gone. Now that
            // coverage has caught up, that stretch can be heard properly.
            // This is what makes "pause until ready" mean what it says: you
            // may wait, but you eventually hear every analyzed second.
            maybeRewindAfterFallback(video, t);
            // Only release here if there's no word-hit in progress right
            // now - if there is, leave forcedMute alone and let the normal
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
      // the log, yet the user HEARD AUDIO - YouTube's own player writes
      // video.muted during init/element churn, silently defeating our
      // one-shot write while session.forcedMute stayed true, so tick()
      // believed protection was still active and never did anything further
      // (nothing re-checked the actual DOM property against our intent).
      // Never assume our own flag reflects reality: re-assert video.muted
      // every tick while forcedMute is intended (a cheap property write),
      // and log loudly if it had actually drifted. This also naturally
      // re-applies to a newly-resolved <video> element, since getVideo()
      // re-resolves every tick already - no separate hook needed.
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
      // actual playthrough - a "playthrough" of an interval is tracked via
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
      // - so in "play" mode `uncovered` is ALWAYS false and `stalling` below
      // could never fire, no matter how long the pipeline had genuinely
      // died. A live user session confirmed this: after a decode-confusion
      // skip storm (see bug #2), zero transcription windows for 3+ minutes
      // in "play" mode with no recovery attempt ever made - safeMode gates
      // whether WE mute/pause for an uncovered region (a presentation
      // decision), but the underlying pipeline can stall regardless of that
      // setting, and "play" mode had no path to notice at all. Judged
      // independently of safeMode/catchupMode here; additionally requires
      // that audio is actually CAPTURED at the playhead already (via the
      // same session.bufferedRanges the status pill uses) - otherwise this
      // would fire constantly whenever the playhead is simply ahead of
      // capture itself (normal, not a pipeline stall) rather than only when
      // audio exists and transcription genuinely isn't happening.
      var playheadUncovered = !isCovered(t) && !session.unanalyzable;

      // Persistent record of unanalyzed playback (0.1.28) - see
      // trackDevlogGap above. Uses playheadUncovered, NOT the `uncovered`
      // var earlier in this function, which folds in settings.safeMode and
      // so is always false in "play" mode: the mode whose leak this exists
      // to measure.
      trackDevlogGap(t, !video.paused, playheadUncovered, settings.catchupMode);

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
        // firing - a heartbeat means offscreen is genuinely still working
        // (just slow: a long window, cold model load, CPU contention), and
        // restarting it mid-attempt would only make it slower (see
        // PIPELINE_NOTES "0.1.6" - this used to kill and restart in-flight
        // attempts on a long-running video before they could ever finish).
        var coverageStale = Date.now() - session.lastCoverageGrowthWall > STALL_MS;
        var heartbeatStale = Date.now() - session.lastHeartbeatWall > STALL_MS;
        if (coverageStale && heartbeatStale) requestStallRecovery();
      } else {
        session.lastStallRequestWall = 0;
      }
    } else {
      // No video, no session, or the extension is off: nothing is playing
      // unanalyzed on our watch, so any open gap ends here rather than
      // silently absorbing however long the disabled/idle period lasts.
      closeDevlogGap();
      // 0.1.40: a seek asks a new question, so the countdown is allowed to
      // start over rather than being held down by the previous answer. The
      // only path that may raise the displayed number.
      if (session) {
        session.countdownReset = true;
        session.countdown = null;
      }
    }
  }

  function tick() {
    runTickLogic();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // Backgrounded-tab protection (0.1.15): rAF suspends/heavily throttles
  // while the document is hidden, but audio keeps playing regardless - a
  // backgrounded tab is exactly where a stale mute/pause decision (or a
  // missed release) matters most, since the user has no visual cue
  // anything is wrong. Chrome's own "intensive throttling" of background
  // timers explicitly EXEMPTS tabs playing audible media, so a plain 1s
  // setInterval keeps firing reliably here even hidden. Runs the exact same
  // enforcement logic as the rAF loop - never a separate/divergent path.
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
  // were computed against the old currentTime/rate) - re-arm, but do NOT
  // touch session.intervals/coveredIntervals: already-transcribed words and
  // coverage stay valid across a seek.
  document.addEventListener(
    'seeking',
    function (ev) {
      var video = ev.target;
      if (!(video instanceof HTMLVideoElement) || !session) return;
      TLOG(TAG, 'seek detected -> t=' + video.currentTime.toFixed(2));
      // 0.1.36 addendum: a seek the USER made supersedes any pending
      // fallback rewind. Yanking them back to where we wanted them would be
      // the extension overriding a deliberate choice, which is worse than
      // the audio it recovers. Our own rewind seek is marked, so it does
      // not count as the user superseding itself.
      var seekApi = catchupApi();
      var ourSeek = seekApi && seekApi.isSelfAction(selfSeekMark, Date.now());
      if (ourSeek) {
        selfSeekMark = null;
      } else if (session && session.fallbackStartT != null) {
        session.userSeekedSinceFallback = true;
      }
      // A seek ends the contiguous stretch of unanalyzed playback, if one
      // was open. trackDevlogGap's own jump detection would catch this on
      // the next tick anyway; doing it here keeps the recorded end time at
      // the pre-seek position instead of wherever the playhead landed.
      closeDevlogGap();
      // 0.1.40: a seek asks a new question, so the countdown is allowed to
      // start over rather than being held down by the previous answer. The
      // only path that may raise the displayed number.
      if (session) {
        session.countdownReset = true;
        session.countdown = null;
      }
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
      // when the seek actually landed somewhere uncovered - an already-
      // covered seek has a trivial/zero catch-up time not worth logging.
      // Overwritten by a later seek before this one resolves (rare, but
      // simplest correct behavior - no stale/misattributed measurement).
      if (seekUncovered) {
        session.catchupMeasureStart = Date.now();
        session.catchupMeasureTargetT = video.currentTime;
      } else {
        session.catchupMeasureStart = null;
      }
      // Seek preemption (0.1.18): tell offscreen the playhead just jumped -
      // it bumps this session's generation counter so any window ALREADY
      // in flight for the old position has its result discarded (can't
      // abort a running WASM call, but its output is now stale) and its
      // maybeProcess loop stops picking any FURTHER old-region windows
      // instead of grinding through a whole queue before reaching the new
      // playhead (a live log showed an 8s wait behind exactly this).
      // Coverage/session state is untouched - "seek keeps everything".
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
  // pause/resume in an already-covered region - armSchedule()'s delays are
  // computed against currentTime/playbackRate AT ARM TIME, and a pause can
  // sit for an arbitrary length of wall time before resuming, so every
  // previously-armed delay is now wrong by however long the pause lasted
  // (upcoming mutes firing early relative to the NEW resume point, or a
  // past-due one never firing at all since its setTimeout already elapsed
  // while paused). Cheap and idempotent - same as the seeking/ratechange
  // handlers already do.
  document.addEventListener(
    'play',
    function (ev) {
      if (!(ev.target instanceof HTMLVideoElement) || !session) return;
      armSchedule();
    },
    true
  );

  // ---- health query from the popup (0.1.32) --------------------------------
  //
  // The popup asks the ACTIVE TAB directly rather than reading a stored
  // health key. Deliberate, and the reasons are worth stating because a
  // storage key was the obvious alternative:
  //
  //   * Health is per-tab and per-video. A single stored value would be
  //     clobbered by whichever tab wrote last, so a popup opened over a
  //     working video could show a warning earned by a different tab.
  //     Keying storage by tabId would work, but a content script does not
  //     know its own tabId without asking the service worker for it.
  //   * It is transient. Persisting a verdict means it can outlive the
  //     thing it describes, so the popup would need staleness rules for a
  //     value that is only ever interesting while that tab is open.
  //   * Asking is always fresh, and the absence of an answer is itself the
  //     right answer: no content script means not a YouTube tab, which is
  //     exactly when the popup should show nothing.
  //
  // The DURABLE record still exists, in pm_devlog, which is where a
  // verdict belongs for later diagnosis (see devlog 'health' entries).
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    try {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg || msg.type !== 'pm-health-query') return undefined;
        var h = currentHealth();
        sendResponse({
          videoId: session ? session.videoId : null,
          status: h ? h.status : null,
          reason: h ? h.reason : null,
          message: h ? h.message : '',
          detail: h ? h.detail : ''
        });
        return undefined; // responded synchronously
      });
    } catch (e) {
      // ignore - the popup simply gets no answer and shows nothing
    }
  }

  // ---- background port, with reconnect on drop (SW idles after ~30s and
  // gets respawned by Chrome on the next connect/message - offscreen state
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
    // visible signal - this trap has burned real debugging time twice.
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
        addWords(msg.videoId, msg.words || [], msg.windowStartS, msg.windowEndS, msg.wallMs, msg.rtf, msg.modelRtf, msg.decodeMs, msg.queueMs, msg.computeMs, msg.language, msg.model);
      } else if (msg.type === 'resync-result') {
        handleResync(msg.videoId, msg.words, msg.coveredIntervals, msg.language);
      } else if (msg.type === 'language') {
        // 0.1.25: snappier-UI push, sent once right when detection resolves
        // - the same 'words'/'resync-result' path above is the authoritative
        // source (applyDetectedLanguage is idempotent past the first
        // real change either way).
        applyDetectedLanguage(msg.videoId, msg.language);
      } else if (msg.type === 'preempt-decision') {
        TLOG(
          TAG,
          '[PM-PREEMPT] ' + msg.action + ' (' + msg.reason + ')' +
            (msg.remainingMs != null ? ' remaining=' + Math.round(msg.remainingMs) + 'ms' : '') +
            ' cost=' + Math.round(msg.costMs) + 'ms' +
            (msg.actualCostMs != null ? ' actual=' + msg.actualCostMs + 'ms' : '')
        );
        devlog('logPreempt', {
          action: msg.action,
          reason: msg.reason,
          remainingMs: msg.remainingMs,
          costMs: msg.costMs,
          actualCostMs: msg.actualCostMs
        });
      } else if (msg.type === 'request-run-rebuild') {
        // 0.1.41: offscreen found that no run can decode the playhead. Only
        // capture.js (MAIN world) holds the cached init bytes needed to
        // open one, so relay the request across the same bridge the
        // eviction check already uses.
        TWARN(TAG, '[PM-RUN-REBUILD] offscreen cannot decode the playhead at ' +
          (msg.atS != null ? msg.atS.toFixed(2) : 'unknown') + ' - asking capture.js for a fresh run');
        devlog('logRunTopology', {
          event: 'rebuild-requested',
          reason: 'no-run-serves-playhead',
          atS: msg.atS
        });
        try {
          window.postMessage({ __pmToCapture: 'PM_CONTENT', type: 'force-run-boundary', atS: msg.atS }, location.origin);
        } catch (e) {}
      } else if (msg.type === 'run-topology') {
        // Suppressions and retirements, recorded so a future paste shows
        // the run topology decisions rather than only their consequences.
        devlog('logRunTopology', {
          event: msg.event,
          reason: msg.reason,
          spanStart: msg.spanStart,
          spanEnd: msg.spanEnd
        });
      } else if (msg.type === 'language-decision') {
        // 0.1.37: recorded whatever the outcome, including holds.
        TLOG(
          TAG,
          '[PM-LANG] observed=' + (msg.observed || 'none') +
            (msg.score != null ? ' score=' + msg.score.toFixed(2) : '') +
            ' action=' + msg.action + ' (' + msg.reason + ') active=' + msg.active
        );
        devlog('logLanguage', {
          observed: msg.observed,
          score: msg.score,
          action: msg.action,
          reason: msg.reason,
          active: msg.active,
          model: msg.model
        });
      } else if (msg.type === 'open-ui-outcome') {
        // 0.1.37: the badge click ladder reporting what actually happened,
        // so a field log distinguishes deliberate use from a dead button.
        TLOG(TAG, '[PM-BADGE] outcome=' + msg.outcome + (msg.detail ? ' (' + msg.detail + ')' : ''));
      } else if (msg.type === 'heartbeat') {
        if (session && session.videoId === msg.videoId) session.lastHeartbeatWall = Date.now();
      } else if (msg.type === 'diag') {
        // Tab-visible diagnostics relayed from offscreen (skipped windows,
        // demux errors, stall notices) - anything that can block coverage
        // indefinitely must be visible here, not just in the offscreen
        // document's own (user-inaccessible) console.
        TWARN(TAG, '[from offscreen]', msg.text);
        // Pipeline problems (skipped windows, demux failures, stall
        // notices) arrive here as a relayed message rather than a thrown
        // exception, so TERROR's own dev-log hook never sees them - and
        // they are among the most direct answers there are to "why was
        // that stretch never analyzed". Record them explicitly, minus the
        // routine progress chatter this same channel also carries (see
        // DEVLOG_DIAG_NOISE_RE): a live 0.1.28 verification run put 17
        // entries in one video's `errors`, all of them [PM-STAGE]/
        // [PM-MODEL]/[PM-WARM] progress notices, which would eventually
        // push real failures out of the capped list. The filter is an
        // explicit deny-list of known-informational prefixes, never an
        // allow-list of known-bad ones - an unrecognized message is kept,
        // so the worst case is noise rather than blindness.
        // Health monitor (0.1.32): the same relayed text is the only place
        // a dead worker or an unloadable model is ever visible from the
        // tab, so classify it here. Narrow by design (see
        // PMHealth.classifyDiag) - survivable trouble must not be recorded
        // as fatal, or the warning stops meaning anything.
        noteFatalDiag(msg.text);
        if (!DEVLOG_DIAG_NOISE_RE.test(msg.text)) {
          devlog('logError', '[offscreen] ' + msg.text);
        }
      } else if (msg.type === 'unanalyzable') {
        if (session && session.videoId === msg.videoId && !session.unanalyzable) {
          session.unanalyzable = true;
          TWARN(TAG, '[PM-UNANALYZABLE] offscreen gave up transcribing this video (likely DRM/protected content) - releasing safe-mode protection');
          devlog('logError', '[PM-UNANALYZABLE] offscreen gave up transcribing this video (likely DRM/protected content) - safe-mode protection released for the rest of it');
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
      // respawns it on the next connect) - not a warning-worthy condition,
      // and console.warn here was polluting the extension's Errors page in
      // chrome://extensions with routine, harmless noise.
      TLOG(TAG, 'background port disconnected, reconnecting in ' + delay + 'ms (attempt ' + reconnectAttempts + ')');
      setTimeout(connectPort, delay);
    });
    // Whether this is the first connect or a reconnect after a drop, ask for
    // a full resync - cheap when there's nothing yet, and guarantees no
    // words computed while the port was down are silently lost.
    if (session) safePortPost({ type: 'resync', videoId: session.videoId });
  }
  connectPort();
  // FIX (0.1.18): stale cross-refresh work. A plain page REFRESH of the
  // SAME video does not change capture.js's own tracked video id, so its
  // 'reset' message (sent only on an ACTUAL video-id change) never fired -
  // meaning the offscreen session for this tabId:videoId key survived the
  // refresh untouched, in-flight/queued work and all. A live user log
  // showed the previous page-session's stale, still-running work draining
  // into the new page load and blocking the transcribe lane for 7+ seconds.
  // Force a reset unconditionally on THIS file's own startup - i.e. on
  // every page load, not just a detected video-id change - so offscreen
  // always starts this tab clean regardless of whether it thinks the video
  // id moved. Paired with offscreen-src.js's generation-counter fix, which
  // additionally discards any results from work that was ALREADY in flight
  // at the moment this reset lands (can't abort a running WASM call, but
  // its result is now discarded rather than applied).
  resetSession(currentVideoIdFromLocation());

  // ---- receive segments from capture.js (MAIN world) ------------------------
  // Postmessage bridge hardening (0.1.15): the public `window.postMessage`
  // broadcast this channel used exclusively is, by construction, readable
  // AND forgeable by any page script with its own 'message' listener -
  // including a forged 'segment' (garbage bytes) or, worse, something that
  // could manufacture false coverage and defeat safe mode. capture.js runs
  // at document_start in the MAIN world, which Chrome guarantees executes
  // before the page's own scripts get a chance to run (the same guarantee
  // this whole extension already depends on for patching
  // MediaSource.prototype before YouTube's own player code runs) - so a
  // MessagePort handed over synchronously at that same moment is safe from
  // any page script racing to intercept it. capture.js initiates the
  // handshake (transferring port2); once acknowledged, ALL further traffic
  // is trusted ONLY over that private port - the public broadcast handler
  // below stops processing anything once `securePort` is set. If the
  // handshake never completes for some reason (e.g. `MessageChannel`
  // unavailable), the public path remains the fallback rather than a
  // hardening measure becoming a single point of failure for the entire
  // extension.
  // Missed-reset backstop counters for the segment guard above. The
  // threshold itself lives in shared/session_binding.js.
  var staleSegmentCount = 0;
  var lastStaleSegmentVideoId = null;

  var securePort = null;
  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.__pm !== 'PM_CAPTURE') return;
    if (ev.data.type === 'handshake' && ev.ports && ev.ports[0]) {
      securePort = ev.ports[0];
      securePort.onmessage = function (portEv) { handleCaptureMessage(portEv.data); };
      try {
        securePort.postMessage({ type: 'ack' });
      } catch (e) {}
      TLOG(TAG, '[PM-SECURE-CHANNEL] private port established with capture.js - public postMessage no longer trusted for segment/reset');
      return;
    }
    if (securePort) return; // secure channel active - the public broadcast is untrusted from here on
    handleCaptureMessage(ev.data);
  });

  function handleCaptureMessage(data) {
    if (!data) return;

    if (data.type === 'run-topology') {
      // 0.1.41: capture.js's own topology decisions (a suppressed or opened
      // boundary), recorded in the devlog alongside offscreen's.
      devlog('logRunTopology', {
        event: data.event,
        reason: data.reason,
        spanStart: data.spanStart,
        spanEnd: data.spanEnd
      });
      return;
    }

    if (data.type === 'chainlog') {
      // capture.js runs in a separate JS realm (MAIN world) - its console
      // output can't write into this file's log-ring buffer directly, so it
      // posts here instead. Already printed to the console by capture.js
      // itself; only ring-buffer it (avoid double-printing the same line).
      // Suppressed while disabled (0.1.13): capture.js keeps its lightweight
      // hook installed regardless (it has no knowledge of pm_enabled), but
      // its chain-dump lines would otherwise keep flooding the ring buffer
      // for no purpose while the extension is off - the standing rule is a
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
      // offscreen entirely - capture.js can keep capturing (harmless,
      // invisible), but content.js must not spend any further CPU/messaging
      // on it while disabled.
      if (!currentSettings().enabled) return;
      // 0.1.35 - THE staleness bug. This used to read:
      //
      //     if (!session || session.videoId !== data.videoId) {
      //       session = newSession(data.videoId);
      //     }
      //
      // which means one late segment carrying the PREVIOUS video's id,
      // arriving just after a video-change reset, silently replaced the
      // live session with an empty one bound to the old video. Everything
      // went with it: coverage, the mute schedule, bufferedRanges. Worse,
      // every subsequent 'words' message for the CURRENT video was then
      // dropped by addWords' own `session.videoId !== videoId` guard, so
      // coverage could never be rebuilt and the pill was left reading an
      // empty session forever. That is both reported symptoms at once:
      // "Press play to load audio" (no bufferedRanges, so no captured range
      // at the playhead) and "Analyzing" (no coverage), while the console
      // showed the pipeline happily producing both.
      //
      // capture.js sends an explicit 'reset' on a real video change, and
      // that path (resetSession) is authoritative. A segment is data, not a
      // navigation event, and must never be allowed to redefine which video
      // this tab is on.
      // The rule itself lives in shared/session_binding.js, pure and unit
      // tested, because getting it wrong silently disables filtering and it
      // stayed wrong for two rounds while looking like a display bug.
      var binding = globalThis.PMSessionBinding;
      var decision = binding
        ? binding.segmentAction({
            hasSession: !!session,
            sessionVideoId: session ? session.videoId : null,
            incomingVideoId: data.videoId,
            staleCount: staleSegmentCount,
            lastStaleVideoId: lastStaleSegmentVideoId
          })
        : { action: session ? 'use' : 'create', staleCount: 0, staleVideoId: null };
      staleSegmentCount = decision.staleCount;
      lastStaleSegmentVideoId = decision.staleVideoId;

      if (decision.action === 'ignore') {
        TLOG(TAG, '[PM-SESSION] ignoring segment for videoId=' + data.videoId +
          ' (session is ' + session.videoId + ' #' + session.instanceId +
          ') - a segment never redefines the current video');
        return;
      }
      if (decision.action === 'reset') {
        TWARN(TAG, '[PM-SESSION] repeated segments for videoId=' + data.videoId +
          ' while session is ' + session.videoId + ' - treating as a missed reset');
        resetSession(data.videoId);
      } else if (decision.action === 'create') {
        session = newSession(data.videoId);
      }
      // Health monitor (0.1.32): counted here, at the relay, rather than
      // from bufferedRanges growth, so it means exactly "audio reached the
      // extension" and nothing more. A segment with unusable growth
      // metadata still proves interception is alive, which is the specific
      // thing "no-audio-intercepted" is about.
      session.audioSegments++;
      // Status-pill inputs (0.1.18): mirror offscreen's own bufferedRanges/
      // growth-recency tracking here too, purely from data already flowing
      // through this relay - no new message needed.
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
        duration: data.duration, // 0.1.23: relayed on to offscreen for end-of-stream run-close detection
        localTimeSec: data.localTimeSec,
        growthAbsStart: data.growthAbsStart,
        growthAbsEnd: data.growthAbsEnd,
        growthIsNewRange: data.growthIsNewRange,
        wallTime: data.wallTime, // capture.js's own Date.now() at capture - used by [PM-FIRST-COVERAGE]'s relay-latency milestone
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
