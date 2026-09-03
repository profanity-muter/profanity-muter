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
    reEvalMs: 15000, // re-evaluate this often afterwards
    // 0.1.34 broken-promise check. When the pill says "Analyzing, safe to
    // pause (~Ns)" it has made a specific promise, and the field test found
    // the case where that promise is silently broken forever: a user pauses
    // BECAUSE we said it was safe to, the decode pipeline is wedged, and
    // the playback-only clock means health never evaluates at all. They
    // wait indefinitely, told a filter is coming that is never coming.
    //
    // So a promise gets a WALL clock, and it is generous: three times the
    // ETA we quoted, and never less than the floor below. Slow is still not
    // broken, and a machine that takes four times its own estimate is still
    // working. What is being caught is not slowness, it is silence.
    promiseFactor: 3,
    promiseFloorMs: 30000
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
    STALLED: "stalled-analysis",
    UNANALYZABLE: "content-unanalyzable",
    // 0.1.49: this tab is not the one the shared pipeline is analyzing right
    // now, because another tab is. Not a fault and not a documented limit:
    // it clears itself the moment this tab becomes the active one (see
    // shared/active_tab.js and the active-tab-follow flow). It gets its own
    // reason so the message can be specific and actionable rather than
    // collapsing into "not working".
    OTHER_TAB: "served-elsewhere"
  };

  // Statuses:
  //   "pending"     - not enough evidence yet; show nothing.
  //   "ok"          - the pipeline has demonstrably done work.
  //   "unhealthy"   - broken; warn loudly.
  //   "unsupported" - a documented limit (live, DRM); calm notice, never
  //                   the alarming one.
  //   "waiting"     - nothing is wrong and nothing is unsupported; the shared
  //                   pipeline is simply busy with another tab right now, and
  //                   this state resolves itself when this tab becomes active.
  //                   Never badges the toolbar (see moments.badgeDecision) and
  //                   never shows the alarming on-video warning.
  var STATUS = {
    PENDING: "pending",
    OK: "ok",
    UNHEALTHY: "unhealthy",
    UNSUPPORTED: "unsupported",
    WAITING: "waiting"
  };

  // The user-facing sentence for each outcome. Kept here, beside the logic
  // that chooses it, so the popup and the on-player pill cannot drift into
  // saying different things about the same state. Plain language, no
  // jargon, no emoji, and it states the CONSEQUENCE ("audio is NOT being
  // filtered") rather than only the cause, because the consequence is what
  // the user actually needs to act on.
  var MESSAGES = {};
  // The interception layer itself never delivered any audio. After a YouTube
  // player change this is the most likely casualty, so the message names that
  // cause and the protected-content cause together, and states the
  // consequence plainly. This is a fail-closed case: filtering is off.
  MESSAGES[REASONS.NO_AUDIO] =
    "Profanity Muter can't read this video's audio. YouTube may have changed how it delivers audio, or this video is protected. Filtering is off for this video.";
  MESSAGES[REASONS.MODEL_LOAD_FAILED] =
    "Profanity Muter couldn't load its speech model, so this video is NOT being filtered. Reload the page to try again.";
  MESSAGES[REASONS.WORKER_DEAD] =
    "Profanity Muter's analysis stopped responding, so this video is NOT being filtered. Reload the page to try again.";
  // Audio arrived but 20+ seconds of playback produced not one analyzed
  // window. That is a genuine failure, distinct from the transient
  // "catching up" the pill shows in the first few seconds.
  MESSAGES[REASONS.ZERO_WINDOWS] =
    "Profanity Muter received this video's audio but couldn't analyze any of it, so it is NOT being filtered. Reload the page to try again.";
  MESSAGES[REASONS.LIVESTREAM] =
    "Livestreams aren't filtered. Profanity Muter needs to analyze audio a little ahead of what you hear, which a live stream doesn't allow.";
  MESSAGES[REASONS.STALLED] =
    "Profanity Muter stopped analyzing this video, so it is NOT being filtered. Reload the page to try again.";
  MESSAGES[REASONS.SHORTS] =
    "Shorts aren't filtered yet. They're too short, and change too fast, to analyze before they play.";
  MESSAGES[REASONS.UNANALYZABLE] =
    "Profanity Muter can't read this video's audio because it's protected. Filtering is off for this video.";
  MESSAGES[REASONS.OTHER_TAB] =
    "Profanity Muter filters one video at a time, and another tab is being filtered right now. Switch to this tab, or pause the other video, to filter this one.";

  // A short, plain-language explanation of the cause, for the places with
  // room for one (the popup banner, the dev log). Deliberately does not
  // speculate: each says only what was actually observed.
  var DETAILS = {};
  DETAILS[REASONS.NO_AUDIO] = "No audio from this video reached the extension.";
  DETAILS[REASONS.MODEL_LOAD_FAILED] = "The speech model could not be loaded.";
  DETAILS[REASONS.WORKER_DEAD] = "The analysis process stopped responding.";
  DETAILS[REASONS.ZERO_WINDOWS] = "Audio arrived but no part of it was analyzed.";
  DETAILS[REASONS.LIVESTREAM] = "Live video can't be analyzed ahead of playback.";
  DETAILS[REASONS.STALLED] = "Analysis was expected to finish and did not.";
  DETAILS[REASONS.SHORTS] = "Shorts are too short, and swap too fast, to analyze before they play.";
  DETAILS[REASONS.UNANALYZABLE] = "The audio is encrypted (protected content).";
  DETAILS[REASONS.OTHER_TAB] = "The shared analyzer is busy with another tab and will switch to this one when you do.";

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

  // ---- the promise ledger (0.1.34) ---------------------------------------
  //
  // "Analyzing, safe to pause (~3s)" is a specific claim, and the field test
  // caught it frozen for 30+ seconds against a wedged decoder. An estimate
  // that is never checked against what actually happened is not an estimate,
  // it is a slogan.
  //
  // The ledger lives here rather than in the pill code because TWO surfaces
  // depend on the same fact and must not disagree about it: the pill
  // escalates its own label at 2x the quoted time, and the health monitor
  // escalates to a real warning at 3x (floored at 30s). One definition, two
  // consumers, both testable without a browser.
  //
  // A promise is {issuedWall, etaS, windowsAtIssue}. The key property is
  // that it holds its ORIGINAL clock and its ORIGINAL quote until a window
  // completes: re-quoting a fresh "~3s" on every render is exactly how the
  // pill stayed plausible forever while nothing progressed.
  var PILL_ESCALATE_FACTOR = 2;

  // Open a promise, or keep the existing one. Completing a window changes
  // windowsCompleted, which retires the old promise and starts a new clock,
  // so "no outstanding promise" and "the promise was kept" are the same
  // thing to every consumer.
  function openOrKeepPromise(prev, input) {
    input = input || {};
    var now = typeof input.now === "number" ? input.now : Date.now();
    var windowsCompleted = input.windowsCompleted || 0;
    var etaS = typeof input.etaS === "number" ? input.etaS : null;
    if (prev && prev.windowsAtIssue === windowsCompleted) {
      // Keep the original clock and quote. Fill the quote in if this is the
      // first render that had enough information to compute one.
      if (prev.etaS == null && etaS != null) prev.etaS = etaS;
      return prev;
    }
    return { issuedWall: now, etaS: etaS, windowsAtIssue: windowsCompleted };
  }

  function promiseAgeMs(promise, now) {
    if (!promise || typeof promise.issuedWall !== "number") return null;
    var t = typeof now === "number" ? now : Date.now();
    return Math.max(0, t - promise.issuedWall);
  }

  // Has the pill's own softer threshold been passed? At 2x the quoted time
  // with nothing completed, stop repeating a number already proven wrong.
  // Deliberately gentler than the health verdict: "taking longer than
  // expected" is true and might still resolve, and the health monitor's
  // slower check is what escalates to "not filtering" if it never does.
  function promiseEscalated(promise, now, factor) {
    if (!promise || promise.etaS == null) return false;
    var age = promiseAgeMs(promise, now);
    if (age == null) return false;
    var f = typeof factor === "number" ? factor : PILL_ESCALATE_FACTOR;
    return age > promise.etaS * f * 1000;
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
  //   promiseAgeMs        wall ms since the pill last promised a completion
  //                       that has not been fulfilled, or null when no
  //                       promise is outstanding. The caller clears this on
  //                       any completed window, which is what keeps this
  //                       from firing on a pipeline that is merely slow.
  //   promiseEtaMs        the ETA that was quoted, in ms
  //   unanalyzable        offscreen gave up (DRM/undecodable)
  //   servedElsewhere     true when the shared pipeline is currently analyzing
  //                       a DIFFERENT tab, so this one is waiting its turn
  //                       (0.1.49 active-tab-follow). Calm, self-resolving.
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

    // 0.1.49: SERVED ELSEWHERE. The shared pipeline analyzes one video at a
    // time, and right now this tab is not the one. That is neither a fault
    // nor a documented limit, so it must never reach the broken checks below:
    // an inactive tab legitimately has zero completed windows, and calling
    // that "not working" would be a false alarm that clears itself the moment
    // the user switches tabs.
    //
    // Placed ABOVE the windowsCompleted OK check on purpose. A tab that
    // analyzed the first minute and was then switched away from is NOT still
    // "protected": if it keeps playing in the background it falls behind, and
    // reporting a stale green while that happens is exactly the silent-failure
    // trap this module exists to prevent. The truthful current state is
    // "waiting", and it is a calm, self-resolving one.
    if (input.servedElsewhere === true) {
      return {
        status: STATUS.WAITING,
        reason: REASONS.OTHER_TAB,
        message: messageFor(REASONS.OTHER_TAB),
        detail: detailFor(REASONS.OTHER_TAB),
        due: true
      };
    }

    // A BROKEN PROMISE outranks evidence of past work, and is checked before
    // the playback clock so it fires while PAUSED. Both orderings matter and
    // both come straight from the field test:
    //
    //   - before windowsCompleted, because the wedged session had already
    //     completed four windows earlier in the video. Past success does not
    //     make a currently-dead pipeline healthy.
    //   - before the playback gate, because the user was paused. Pausing is
    //     not evidence of a fault (see the clock discussion above), but it
    //     also must not be a reason we never check a promise we made.
    //
    // This is the one place the playback-only clock is deliberately bypassed,
    // and it is safe precisely because it needs an outstanding promise: we
    // only warn when we told the user something specific and it did not
    // come true.
    var promiseAgeMs = input.promiseAgeMs;
    if (typeof promiseAgeMs === "number" && isFinite(promiseAgeMs)) {
      var etaMs = typeof input.promiseEtaMs === "number" && isFinite(input.promiseEtaMs)
        ? input.promiseEtaMs
        : 0;
      var promiseFactor = typeof th.promiseFactor === "number" ? th.promiseFactor : DEFAULTS.promiseFactor;
      var promiseFloorMs = typeof th.promiseFloorMs === "number" ? th.promiseFloorMs : DEFAULTS.promiseFloorMs;
      var allowedMs = Math.max(etaMs * promiseFactor, promiseFloorMs);
      if (promiseAgeMs > allowedMs) {
        return {
          status: STATUS.UNHEALTHY,
          reason: REASONS.STALLED,
          message: messageFor(REASONS.STALLED),
          detail: detailFor(REASONS.STALLED),
          due: true
        };
      }
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
    PILL_ESCALATE_FACTOR: PILL_ESCALATE_FACTOR,
    openOrKeepPromise: openOrKeepPromise,
    promiseAgeMs: promiseAgeMs,
    promiseEscalated: promiseEscalated,
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
