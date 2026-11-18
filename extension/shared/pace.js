// shared/pace.js
// Plain script (NOT an ES module). Defines globalThis.PMPace. Loaded into the
// offscreen bundle, the service worker (importScripts), the content script
// and the popup, and require()d by test/pace_test.js.
//
// Four jobs, all pure so they can be tested without a browser:
//
//  1. WINDOW START RESOLUTION (0.1.58 stuck-chunk fix). See
//     resolveWindowStart. Field log: playhead frozen at 2814.0 while the
//     identical window [2813,2819.67) was decoded six times.
//  2. REALTIME FACTOR STATE MACHINE. Per completed window, compute RTF
//     (work ms / audio ms). Sustained > 1.0 means muting cannot keep up:
//     enter "busy", stop scheduling windows (back-off) except one probe a
//     minute, leave when a probe comes in under 0.8.
//  3. CHRONIC VERDICT. A small per-video summary persisted by the service
//     worker; 3 of the last 5 qualifying videos behind realtime means this
//     computer cannot do the job, and audio filtering is auto-paused.
//  4. THREAD CAP for the Whisper worker.
//
// The extension cannot see other processes. Nothing here, and none of the
// copy, names a cause beyond "busy" / "processing power free".

(function (root) {
  "use strict";

  var C = {
    BUSY_ENTER_RTF: 1.0,
    BUSY_ENTER_N: 3,
    BUSY_EXIT_RTF: 0.8,
    BUSY_EXIT_N: 1, // probes are 60s apart, so one good probe is the evidence
    PROBE_EVERY_MS: 60000,
    MIN_AUDIO_S: 3, // tail windows are dominated by fixed overhead; ignore them
    RTF_KEEP: 200,
    CHRONIC_BEHIND_FRAC: 0.5,
    CHRONIC_MIN_AUDIO_S: 60,
    CHRONIC_LOOKBACK: 5,
    CHRONIC_MIN_VIDEOS: 3,
    CHRONIC_TRIP: 3,
    HISTORY_CAP: 10,
    COMPLETED_SPANS_CAP: 64,
    REPEAT_COOLDOWN_MS: 30000,
    // 0.1.65 setup speed check (see speedVerdict). The ratio is pure Whisper
    // inference ms for one 18 s window / 18000. A real window's RTF also pays
    // for demux + resample, so "ok" stops a clear 0.1 below BUSY_EXIT_RTF:
    // a machine measured above 0.7 would, once busy, struggle to bring a
    // probe in under 0.8 and so could stay stuck in back-off.
    SPEED_OK_MAX: 0.7,
    SPEED_TOO_SLOW_RTF: 1.0, // = BUSY_ENTER_RTF: above this, muting cannot keep up even with nothing else running
    SPEED_MIN_MEM_GB: 2, // navigator.deviceMemory at or below this: the model alone needs more than 1 GB, do not load it
    SPEED_MODEL_READY_MS: 180000, // first model load on a slow disk can be long; this is the generous limit
    SPEED_WINDOW_TIMEOUT_MS: 54000, // 3x realtime for the 18 s clip
    SPEED_UI_GRACE_MS: 15000 // onboarding gives up on a silent check this long after both limits
  };

  // ---- 1. window start --------------------------------------------------

  function firstUncoveredPoint(intervals, lo, hi, eps) {
    var e = typeof eps === "number" ? eps : 0.05;
    var p = lo;
    for (var i = 0; i < intervals.length; i++) {
      var iv = intervals[i];
      if (iv.end <= p + e) continue;
      if (iv.start > p + e) return p;
      p = iv.end;
      if (p >= hi - e) return null;
    }
    return p < hi - e ? p : null;
  }

  function maxCoveredIn(view, rangeStart, rangeEnd, floor) {
    var m = floor;
    for (var i = 0; i < view.length; i++) {
      if (view[i].start < rangeEnd && view[i].end > rangeStart) m = Math.max(m, view[i].end);
    }
    return m;
  }

  // Where should the next window start?
  //
  // ROOT CAUSE of the 0.1.57 loop: the first uncovered point was found from
  // lowBound = playhead - OVERLAP (a hole BEHIND the playhead), and only
  // then was the cold-start floor (playhead - 1s) applied, bumping the start
  // into audio that was already covered. With a playhead that is not moving
  // (pause catch-up) the hole behind it can never be filled, so every pick
  // returned the same covered span. The fix is to apply the floor and then
  // look for the first uncovered point again from there.
  //
  // o: {coverageView, covered, lowBound, high, rangeStart, rangeEnd, ct,
  //     hadFirstWindow, adjacencyS, coldBehindS, eps}
  // returns {start, isColdStart} or {reason, detail}
  function resolveWindowStart(o) {
    var eps = typeof o.eps === "number" ? o.eps : 0.05;
    var view = o.coverageView;
    var start = firstUncoveredPoint(view, o.lowBound, o.high, eps);
    if (start == null) {
      start = Math.max(maxCoveredIn(view, o.rangeStart, o.rangeEnd, o.rangeStart), o.lowBound);
      if (start >= o.high) return { reason: "fully-covered" };
    }
    function isCold(at) {
      if (!o.hadFirstWindow) return true;
      for (var i = 0; i < o.covered.length; i++) {
        if (Math.abs(o.covered[i].end - at) < o.adjacencyS) return false;
      }
      return true;
    }
    var cold = isCold(start);
    if (cold) {
      var coldFloor = Math.max(o.rangeStart, o.ct - (typeof o.coldBehindS === "number" ? o.coldBehindS : 1));
      if (coldFloor >= o.high) return { reason: "cold-behind-playhead", coldFloor: coldFloor };
      if (coldFloor > start) {
        start = coldFloor;
        var again = firstUncoveredPoint(view, start, o.high, eps);
        if (again == null) {
          start = Math.max(maxCoveredIn(view, o.rangeStart, o.rangeEnd, start), start);
          if (start >= o.high) return { reason: "fully-covered" };
        } else {
          start = again;
        }
        cold = isCold(start);
      }
    }
    return { start: start, isColdStart: cold };
  }

  function spanKey(a, b) {
    return a.toFixed(2) + "," + b.toFixed(2);
  }
  function isRepeatSpan(set, a, b) {
    return set.has(spanKey(a, b));
  }
  function noteCompletedSpan(set, a, b) {
    set.add(spanKey(a, b));
    while (set.size > C.COMPLETED_SPANS_CAP) set.delete(set.values().next().value);
  }

  // ---- 2. RTF state machine ------------------------------------------------

  function median(xs) {
    if (!xs.length) return null;
    var s = xs.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function createPace(opts) {
    opts = opts || {};
    var enterN = opts.enterN || C.BUSY_ENTER_N;
    var exitN = opts.exitN || C.BUSY_EXIT_N;
    var state = "ok", slow = 0, fast = 0, lastProbe = 0;
    var rtfs = [], totalS = 0, behindS = 0;

    function onWindow(w, now) {
      var none = { changed: false, from: state, to: state };
      if (!w || w.cold || !(w.audioS >= C.MIN_AUDIO_S) || typeof w.rtf !== "number" || !isFinite(w.rtf)) return none;
      rtfs.push(w.rtf);
      if (rtfs.length > C.RTF_KEEP) rtfs.shift();
      totalS += w.audioS;
      if (w.rtf > C.BUSY_ENTER_RTF) behindS += w.audioS;
      var from = state;
      if (state === "ok") {
        slow = w.rtf > C.BUSY_ENTER_RTF ? slow + 1 : 0;
        if (slow >= enterN) { state = "busy"; slow = 0; fast = 0; lastProbe = now; }
      } else {
        fast = w.rtf < C.BUSY_EXIT_RTF ? fast + 1 : 0;
        if (fast >= exitN) { state = "ok"; slow = 0; fast = 0; }
      }
      return { changed: state !== from, from: from, to: state, rtf: w.rtf };
    }

    // May a new window be scheduled now? Busy: one probe per PROBE_EVERY_MS.
    function allowWindow(now) {
      if (state !== "busy") return true;
      if (now - lastProbe >= C.PROBE_EVERY_MS) { lastProbe = now; return true; }
      return false;
    }
    function probeDue(now) {
      return state === "busy" && now - lastProbe >= C.PROBE_EVERY_MS;
    }
    function video() {
      return {
        analyzedS: totalS,
        behindFrac: totalS > 0 ? behindS / totalS : 0,
        medianRtf: median(rtfs),
        windows: rtfs.length,
        recentRtf: median(rtfs.slice(-3))
      };
    }
    return {
      onWindow: onWindow,
      allowWindow: allowWindow,
      probeDue: probeDue,
      video: video,
      state: function () { return state; }
    };
  }

  // ---- 3. chronic verdict ------------------------------------------------------

  function videoEntry(id, v, now) {
    return {
      id: id,
      t: now,
      analyzedS: Math.round(v.analyzedS),
      medianRtf: v.medianRtf == null ? null : Math.round(v.medianRtf * 100) / 100,
      behindFrac: Math.round(v.behindFrac * 100) / 100,
      chronic: v.behindFrac >= C.CHRONIC_BEHIND_FRAC
    };
  }

  function upsertHistory(history, entry) {
    var out = (history || []).filter(function (e) { return e && e.id !== entry.id; });
    out.push(entry);
    return out.slice(-C.HISTORY_CAP);
  }

  function chronicVerdict(history) {
    var q = (history || []).filter(function (e) { return e && e.analyzedS >= C.CHRONIC_MIN_AUDIO_S; })
      .slice(-C.CHRONIC_LOOKBACK);
    var bad = q.filter(function (e) { return e.chronic; });
    return {
      tripped: q.length >= C.CHRONIC_MIN_VIDEOS && bad.length >= C.CHRONIC_TRIP,
      qualifying: q.length,
      chronicCount: bad.length,
      medianRtf: median(bad.map(function (e) { return e.medianRtf; }).filter(function (x) { return typeof x === "number"; }))
    };
  }

  // ---- auto-pause -----------------------------------------------------------------

  function audioAllowed(items) {
    return !(items && items.pm_autoPausedSlow);
  }
  function makeAutoPauseFlag(verdict, now) {
    return { at: now, chronicCount: verdict.chronicCount, qualifying: verdict.qualifying, medianRtf: verdict.medianRtf };
  }
  // "Try again": forget the flag AND the history, so the verdict starts fresh
  // (three new videos are needed before it can trip again).
  function tryAgainPatch() {
    return { remove: ["pm_autoPausedSlow", "pm_paceHistory"] };
  }

  // ---- setup speed check (0.1.65) ------------------------------------------------
  // o: {windowMs, audioS, loadMs, timedOut, deviceMemory, hardwareConcurrency}
  // Returns the record stored as pm_speedCheck (minus `at`). verdict is one of
  // "ok" | "borderline" | "too-slow" | "error" (no measurement and no timeout).
  function speedVerdict(o) {
    o = o || {};
    var num = function (x) { return typeof x === "number" && isFinite(x) ? x : null; };
    var mem = num(o.deviceMemory);
    var windowMs = num(o.windowMs), audioS = num(o.audioS);
    var ratio = windowMs != null && windowMs > 0 && audioS > 0 ? windowMs / (audioS * 1000) : null;
    var verdict, reason = null;
    if (mem != null && mem <= C.SPEED_MIN_MEM_GB) { verdict = "too-slow"; reason = "memory"; }
    else if (o.timedOut) { verdict = "too-slow"; reason = "timeout"; }
    else if (ratio == null) { verdict = "error"; }
    else if (ratio > C.SPEED_TOO_SLOW_RTF) { verdict = "too-slow"; reason = "ratio"; }
    else if (ratio > C.SPEED_OK_MAX) verdict = "borderline";
    else verdict = "ok";
    return {
      verdict: verdict,
      reason: reason,
      ratio: ratio == null ? null : Math.round(ratio * 1000) / 1000,
      windowMs: windowMs == null ? null : Math.round(windowMs),
      loadMs: num(o.loadMs) == null ? null : Math.round(o.loadMs),
      cores: num(o.hardwareConcurrency),
      memGb: mem
    };
  }
  // The pm_autoPausedSlow flag a too-slow setup check sets. `source` lets the
  // popup word its notice for a measurement rather than a run of slow videos.
  function makeSetupPauseFlag(record, now) {
    return { at: now, source: "setup-check", ratio: record && record.ratio != null ? record.ratio : null, reason: (record && record.reason) || null };
  }

  // ---- copy -------------------------------------------------------------------------
  // WHY it exists, in plain words: fully private, runs only on the device, and
  // the price is the computer's own processing power.
  var WHY =
    "Profanity Muter is fully private: it runs only on your device and never sends anything you watch or hear anywhere. " +
    "That means it uses your computer's own processing power to keep up with the video.";
  var COPY = {
    pill: "Your computer is busy, so muting is falling behind. Closing other apps or tabs helps.",
    pillWhyLabel: "Why?",
    pillWhy: WHY,
    pausedPill: "Audio filtering is paused on this computer. Captions are still censored.",
    noticeTitle: "Audio filtering is paused on this computer",
    noticeBody:
      "Profanity Muter is fully private: it runs only on your device and never sends anything you watch or hear anywhere. " +
      "That means it uses your computer's own processing power, and this computer doesn't have enough free right now. " +
      "Audio filtering is paused; captions are still censored. Closing other programs may help.",
    tryAgain: "Try again",
    remove: "Remove extension",
    onboarding: "Profanity Muter is fully private: it runs only on your device and never sends anything you watch or hear anywhere. That means it uses your computer's own processing power, and older or very busy computers may struggle to keep up.",
    // 0.1.65: a pause set by the setup speed check is a measurement, not "right now".
    noticeBodySetup:
      "Profanity Muter is fully private: it runs only on your device and never sends anything you watch or hear anywhere. " +
      "That means it uses your computer's own processing power, and a check during setup found this computer can't keep up. " +
      "Audio filtering is paused; captions are still censored.",
    speedRunning: "Checking that this computer can keep up…",
    speedRunningHint: "This can take up to a minute. You can keep reading or move on.",
    speedOk: "This computer can keep up.",
    speedBorderline: "This computer can keep up, but only just. Muting may fall behind when other programs are busy.",
    speedBusy: "A video is being filtered right now, so the check did not run. Check again when it has finished.",
    speedError: "The check could not run this time.",
    speedIdle: "Check that this computer can keep up",
    speedAgain: "Check again",
    speedTitle: "This computer is probably too slow for audio muting",
    speedCaptions: "Captions are still censored either way.",
    speedPaused: "Audio muting is paused for now.",
    speedPausedChosen: "Audio muting is paused and captions are still censored. You can try audio muting again from the toolbar popup.",
    speedTrying: "Audio muting is on because you chose to try it. If it falls behind, Profanity Muter will say so.",
    speedCaptionsOnly: "Continue with captions only",
    speedTryAnyway: "Try audio muting anyway"
  };
  function noticeModel(flag) {
    if (!flag) return null;
    var body = flag.source === "setup-check" ? COPY.noticeBodySetup : COPY.noticeBody;
    return { title: COPY.noticeTitle, body: body, buttons: [COPY.tryAgain, COPY.remove] };
  }

  // Why a setup check said too-slow, in plain words, from the stored record.
  function speedReasonText(r) {
    if (r.reason === "memory") {
      return "This computer reports " + r.memGb + " GB of memory, and the speech model alone needs more than 1 GB, so it was not loaded.";
    }
    if (r.reason === "timeout" || r.windowMs == null) {
      return "During a quick check, this computer could not finish working through " + CLIP_S + " seconds of speech in time.";
    }
    return "During a quick check, this computer took " + Math.round(r.windowMs / 1000) + " seconds to work through " + CLIP_S + " seconds of speech, so muting would fall behind the video.";
  }
  var CLIP_S = 18;

  // The onboarding status block, as data. st: {running, busy, error, record,
  // paused, past, chosen}. `actions` are ids the page maps to handlers.
  function speedCheckView(st) {
    st = st || {};
    var again = st.past ? ["again"] : [];
    if (st.running) return { state: "running", text: COPY.speedRunning, hint: COPY.speedRunningHint, actions: [] };
    if (st.busy) return { state: "busy", text: COPY.speedBusy, actions: ["again"] };
    var r = st.record;
    if (!r) return st.error ? { state: "error", text: COPY.speedError, actions: ["again"] } : { state: "idle", text: "", actions: ["start"] };
    if (r.verdict === "ok") return { state: "ok", text: COPY.speedOk, actions: again };
    if (r.verdict === "borderline") return { state: "borderline", text: COPY.speedBorderline, actions: again };
    if (r.verdict !== "too-slow") return { state: "error", text: COPY.speedError, actions: ["again"] };
    var v = { state: "too-slow", title: COPY.speedTitle, body: WHY + " " + speedReasonText(r) + " " + COPY.speedCaptions };
    if (!st.paused) { v.text = COPY.speedTrying; v.actions = ["captions-only", "remove"].concat(again); }
    else if (st.chosen) { v.text = COPY.speedPausedChosen; v.actions = again; }
    else { v.text = COPY.speedPaused; v.actions = ["captions-only", "try-anyway", "remove"].concat(again); }
    return v;
  }

  // ---- 4. thread cap --------------------------------------------------------------------

  function threadCap(hardwareConcurrency, current) {
    var hc = typeof hardwareConcurrency === "number" && hardwareConcurrency >= 1 ? hardwareConcurrency : 1;
    var cap = Math.max(1, Math.floor(hc / 2));
    return typeof current === "number" && current >= 1 ? Math.min(cap, current) : cap;
  }

  var PMPaceCore = {
    C: C,
    COMPLETED_SPANS_CAP: C.COMPLETED_SPANS_CAP,
    HISTORY_CAP: C.HISTORY_CAP,
    REPEAT_COOLDOWN_MS: C.REPEAT_COOLDOWN_MS,
    PROBE_EVERY_MS: C.PROBE_EVERY_MS,
    COPY: COPY,
    firstUncoveredPoint: firstUncoveredPoint,
    resolveWindowStart: resolveWindowStart,
    spanKey: spanKey,
    isRepeatSpan: isRepeatSpan,
    noteCompletedSpan: noteCompletedSpan,
    createPace: createPace,
    videoEntry: videoEntry,
    upsertHistory: upsertHistory,
    chronicVerdict: chronicVerdict,
    audioAllowed: audioAllowed,
    makeAutoPauseFlag: makeAutoPauseFlag,
    tryAgainPatch: tryAgainPatch,
    noticeModel: noticeModel,
    speedVerdict: speedVerdict,
    makeSetupPauseFlag: makeSetupPauseFlag,
    speedCheckView: speedCheckView,
    threadCap: threadCap
  };

  root.PMPace = PMPaceCore;
  if (typeof module !== "undefined" && module.exports) module.exports = { PMPaceCore: PMPaceCore };
})(typeof globalThis !== "undefined" ? globalThis : this);
