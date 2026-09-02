// shared/health.js
// Plain script (NOT an ES module), loaded as an isolated-world content
// script before content.js, and require()d by test/health_test.js.
// Defines globalThis.PMHealth.
//
// WHY THIS EXISTS
// ---------------
// For a parental filter, failing SILENTLY is the worst possible failure
// mode. If YouTube changes something and audio stops being intercepted,
// or the model never loads, or the worker dies, the old behaviour was a
// quiet pill that said "Analyzing" forever while the user believed their
// kid was protected. Believing you are protected when you are not is
// strictly worse than knowing you are not protected: it removes the
// chance to do anything about it.
//
// The onboarding copy now promises the extension will say so rather than
// stay quiet. This module is the part that makes that true.
//
// WHAT IS AND IS NOT "BROKEN"
// ---------------------------
// The bar is deliberately high, because a parental filter that cries wolf
// gets ignored or uninstalled, and a false alarm on a slow laptop is a
// much likelier event than a genuine pipeline break. So:
//
//   * SLOW IS NOT BROKEN. Transcription intentionally trails the
//     playhead; a machine that takes 40 seconds to get through the first
//     window is working, just slowly. Only ZERO completed windows counts.
//   * PAUSED IS NOT BROKEN. Nothing is expected to progress while the
//     video is not playing, so the clock that matters is accumulated
//     PLAYBACK time, not wall time since the page loaded.
//   * A LIMIT IS NOT A BREAK. Live streams and undecodable/DRM content
//     are documented limitations with their own calm notices, not
//     failures, and they must never produce the alarming message.
//   * RECOVERY IS REAL. If a window completes later, the verdict flips
//     back to healthy. A warning that cannot clear itself is a bug.
//
// Everything here is pure: no chrome.*, no DOM, no clock (the caller
// passes `now`), and all thresholds injected. That is what makes the
// state machine testable without a browser, which matters more here than
// almost anywhere else in this codebase, because the failures being
// detected are by definition ones we cannot reproduce on demand.

(function (root) {
  "use strict";

  // ---- thresholds (overridable, so tests can drive the machine) ----------
  //
  // FIRST_EVAL_MS is generous on purpose. 20 seconds of ACTUAL playback is
  // long enough that a cold model load plus a first window has had a fair
  // chance on a slow machine, and short enough that a genuinely broken
  // install is caught within the first video rather than the tenth.
  var DEFAULTS = {
    firstEvalMs: 20000, // accumulated playback before the first verdict
    reEvalMs: 15000 // re-evaluate this often afterwards
  };

  // ---- reason codes ------------------------------------------------------
  // Stable strings: they go into pm_devlog, so a report from the field can
  // be triaged by grepping for them.
  var REASONS = {
    NO_AUDIO: "no-audio-intercepted",
    MODEL_LOAD_FAILED: "model-load-failed",
    WORKER_DEAD: "worker-dead",
    ZERO_WINDOWS: "zero-windows-completed",
    LIVESTREAM: "livestream-unsupported",
    SHORTS: "shorts-unsupported",
    UNANALYZABLE: "content-unanalyzable"
  };

  // Statuses:
  //   "pending"     - not enough evidence yet; show nothing.
  //   "ok"          - the pipeline has demonstrably done work.
  //   "unhealthy"   - broken; warn loudly.
  //   "unsupported" - a documented limit (live, DRM); calm notice, never
  //                   the alarming one.
  var STATUS = {
    PENDING: "pending",
    OK: "ok",
    UNHEALTHY: "unhealthy",
    UNSUPPORTED: "unsupported"
  };

  // The user-facing sentence for each outcome. Kept here, beside the logic
  // that chooses it, so the popup and the on-player pill cannot drift into
  // saying different things about the same state. Plain language, no
  // jargon, no emoji, and it states the CONSEQUENCE ("audio is NOT being
  // filtered") rather than only the cause, because the consequence is what
  // the user actually needs to act on.
  var MESSAGES = {};
  MESSAGES[REASONS.NO_AUDIO] =
    "Profanity Muter isn't working on this video. Audio is NOT being filtered.";
  MESSAGES[REASONS.MODEL_LOAD_FAILED] =
    "Profanity Muter isn't working on this video. Audio is NOT being filtered.";
  MESSAGES[REASONS.WORKER_DEAD] =
    "Profanity Muter isn't working on this video. Audio is NOT being filtered.";
  MESSAGES[REASONS.ZERO_WINDOWS] =
    "Profanity Muter isn't working on this video. Audio is NOT being filtered.";
  MESSAGES[REASONS.LIVESTREAM] =
    "Livestreams aren't supported. Audio is not filtered on this video.";
  MESSAGES[REASONS.SHORTS] =
    "Shorts aren't supported yet. Audio is not filtered here.";
  MESSAGES[REASONS.UNANALYZABLE] =
    "This video's audio is protected and can't be analyzed. Audio is not filtered on this video.";

  // A short, plain-language explanation of the cause, for the places with
  // room for one (the popup banner, the dev log). Deliberately does not
  // speculate: each says only what was actually observed.
  var DETAILS = {};
  DETAILS[REASONS.NO_AUDIO] = "No audio from this video reached the extension.";
  DETAILS[REASONS.MODEL_LOAD_FAILED] = "The speech model could not be loaded.";
  DETAILS[REASONS.WORKER_DEAD] = "The transcription process stopped responding.";
  DETAILS[REASONS.ZERO_WINDOWS] = "Audio arrived but no part of it was analyzed.";
  DETAILS[REASONS.LIVESTREAM] = "Live video can't be analyzed ahead of playback.";
  DETAILS[REASONS.SHORTS] = "Shorts are too short, and swap too fast, to analyze before they play.";
  DETAILS[REASONS.UNANALYZABLE] = "The audio is encrypted (protected content).";

  function messageFor(reason) {
    return MESSAGES[reason] || MESSAGES[REASONS.ZERO_WINDOWS];
  }

  function detailFor(reason) {
    return DETAILS[reason] || "";
  }

  // ---- diagnostic classification ----------------------------------------
  //
  // The offscreen document relays free-text diagnostics to the tab (see
  // content.js's 'diag' handler). Two of them mean the pipeline is dead
  // rather than merely struggling, and knowing WHICH turns a vague
  // "not working" into an actionable report. Everything else is left
  // unclassified on purpose: a skipped window or a stage timeout is
  // frequently survivable, and treating survivable trouble as fatal is
  // exactly how a warning system loses its credibility.
  //
  // Returns a reason code or null.
  function classifyDiag(text) {
    if (typeof text !== "string" || !text) return null;
    var t = text.toLowerCase();
    // Model load: the worker reports failures fetching or initializing the
    // Whisper model. Without it nothing can ever be transcribed.
    if (t.indexOf("model") !== -1 &&
        (t.indexOf("load") !== -1 || t.indexOf("fetch") !== -1 || t.indexOf("download") !== -1) &&
        (t.indexOf("fail") !== -1 || t.indexOf("error") !== -1 || t.indexOf("could not") !== -1)) {
      return REASONS.MODEL_LOAD_FAILED;
    }
    // Worker: spawned, crashed, or stopped answering.
    if (t.indexOf("worker") !== -1 &&
        (t.indexOf("error") !== -1 || t.indexOf("dead") !== -1 ||
         t.indexOf("terminated") !== -1 || t.indexOf("crash") !== -1 ||
         t.indexOf("no response") !== -1)) {
      return REASONS.WORKER_DEAD;
    }
    return null;
  }

  // ---- the verdict -------------------------------------------------------
  //
  // input:
  //   now                 number, ms
  //   playbackMs          accumulated ACTUAL playback on this video
  //   isWatchPage         false on any non-video page
  //   isPaused            current paused state
  //   isLive              live stream / premiere
  //   isShorts            a /shorts/ page (see content.js isShortsPage)
  //   unanalyzable        offscreen gave up (DRM/undecodable)
  //   windowsCompleted    analysis windows finished for this video
  //   audioSegments       audio segments intercepted for this video
  //   fatalReasons        array of reason codes from classifyDiag
  //   lastEvalAt          when evaluate last returned a non-pending verdict
  //   thresholds          {firstEvalMs, reEvalMs}
  //
  // returns {status, reason, message, detail, due}
  //   `due` is false when it is simply not time to judge yet; the caller
  //   uses it to avoid re-rendering and re-logging on every tick.
  function evaluate(input) {
    input = input || {};
    var th = input.thresholds || {};
    var firstEvalMs = typeof th.firstEvalMs === "number" ? th.firstEvalMs : DEFAULTS.firstEvalMs;
    var reEvalMs = typeof th.reEvalMs === "number" ? th.reEvalMs : DEFAULTS.reEvalMs;
    var now = typeof input.now === "number" ? input.now : 0;

    function pending(why) {
      return { status: STATUS.PENDING, reason: why || null, message: "", detail: "", due: false };
    }

    // Not a video page at all: nothing is expected to happen here.
    if (input.isWatchPage === false) return pending("not-a-watch-page");

    // Documented limits are judged BEFORE the playback clock, because they
    // are true from the first frame and there is no reason to make a user
    // wait 20 seconds to be told a livestream is a livestream. They are
    // also judged before anything else so a live stream can never be
    // reported as "broken": zero completed windows is the EXPECTED state
    // there, not a fault.
    // Shorts, checked first among the limits because a Short can also be a
    // premiere and the Shorts answer is the more useful one there. See
    // CENSOR_NOTES.md "Shorts are an explicit state" for why this is gated
    // rather than supported: analysis cannot outrun a 30-second clip that
    // restarts on loop and is replaced wholesale by a swipe.
    if (input.isShorts === true) {
      return {
        status: STATUS.UNSUPPORTED,
        reason: REASONS.SHORTS,
        message: messageFor(REASONS.SHORTS),
        detail: detailFor(REASONS.SHORTS),
        due: true
      };
    }
    if (input.isLive === true) {
      return {
        status: STATUS.UNSUPPORTED,
        reason: REASONS.LIVESTREAM,
        message: messageFor(REASONS.LIVESTREAM),
        detail: detailFor(REASONS.LIVESTREAM),
        due: true
      };
    }
    if (input.unanalyzable === true) {
      return {
        status: STATUS.UNSUPPORTED,
        reason: REASONS.UNANALYZABLE,
        message: messageFor(REASONS.UNANALYZABLE),
        detail: detailFor(REASONS.UNANALYZABLE),
        due: true
      };
    }

    // Evidence of work beats everything below. Checked before the playback
    // clock so a healthy verdict is available immediately rather than only
    // at the first evaluation point, and so recovery is instant: one
    // completed window and the warning clears.
    if (input.windowsCompleted > 0) {
      return { status: STATUS.OK, reason: null, message: "", detail: "", due: true };
    }

    // Below here, nothing has been analyzed yet. That is completely normal
    // early on, so it only becomes a verdict once enough real playback has
    // happened, and then only every reEvalMs.
    var playbackMs = typeof input.playbackMs === "number" ? input.playbackMs : 0;
    if (playbackMs < firstEvalMs) return pending("too-early");

    if (typeof input.lastEvalAt === "number" && now - input.lastEvalAt < reEvalMs) {
      return pending("not-due");
    }

    // Note there is deliberately NO `if (isPaused) return pending(...)`
    // here. Pause is already handled, and handled better, by the clock:
    // `playbackMs` counts only actual playback, so a paused video simply
    // never reaches firstEvalMs and stays pending on the check above. A
    // separate paused-check would additionally throw away a verdict that
    // 20 seconds of real playback had already earned, which is wrong: if
    // nothing was analyzed in that time, pausing afterwards does not make
    // the pipeline any less broken, and the user still wants to know.
    // `isPaused` is accepted in the input purely so callers can be
    // explicit about it.

    // Order matters: report the most specific known cause. A dead worker
    // or an unloadable model explains everything downstream, so those win
    // over the generic symptoms they cause.
    var fatal = input.fatalReasons || [];
    if (fatal.indexOf(REASONS.MODEL_LOAD_FAILED) !== -1) return unhealthy(REASONS.MODEL_LOAD_FAILED);
    if (fatal.indexOf(REASONS.WORKER_DEAD) !== -1) return unhealthy(REASONS.WORKER_DEAD);

    // No audio ever reached us: the interception layer itself is broken,
    // which is the most likely casualty of a YouTube player change.
    if (!(input.audioSegments > 0)) return unhealthy(REASONS.NO_AUDIO);

    // Audio arrived, nothing came back.
    return unhealthy(REASONS.ZERO_WINDOWS);

    function unhealthy(reason) {
      return {
        status: STATUS.UNHEALTHY,
        reason: reason,
        message: messageFor(reason),
        detail: detailFor(reason),
        due: true
      };
    }
  }

  // Did the verdict change in a way worth surfacing and logging? Used by
  // content.js so a steady state does not re-render or re-log every tick,
  // and so a recovery is recorded exactly once.
  function isTransition(prev, next) {
    if (!next) return false;
    if (!prev) return next.status !== STATUS.PENDING;
    if (next.status === STATUS.PENDING) return false;
    return prev.status !== next.status || prev.reason !== next.reason;
  }

  var PMHealthCore = {
    DEFAULTS: DEFAULTS,
    REASONS: REASONS,
    STATUS: STATUS,
    MESSAGES: MESSAGES,
    DETAILS: DETAILS,
    messageFor: messageFor,
    detailFor: detailFor,
    classifyDiag: classifyDiag,
    evaluate: evaluate,
    isTransition: isTransition
  };

  root.PMHealth = PMHealthCore;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMHealthCore: PMHealthCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
