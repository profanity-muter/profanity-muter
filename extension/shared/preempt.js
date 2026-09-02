// shared/preempt.js
// Plain script (NOT an ES module), imported into the offscreen bundle and
// require()d by test/preempt_test.js. Defines globalThis.PMPreempt.
//
// SEEK PREEMPTION: when to abandon a transcription nobody is waiting for.
//
// The 0.1.41 field log, after run-poisoning was fixed:
//
//   14:11:23.9  URL restore seek to t=25; window [24.00,26.50) enters the
//               worker.
//   14:11:24.8  the user seeks to t=1633.93.
//   14:11:32.4  that window finishes (wallMs=8410) and is applied via
//               STALE-KEPT, which is harmless and correct.
//   14:11:32.4  only NOW does the first window at the real position start.
//
// Seven and a half seconds of a single-threaded worker computing audio for
// a position the user left before it began. The generation machinery
// already made the RESULT harmless; what it could not do is stop the work,
// because a running WASM call cannot be interrupted from outside. The only
// way to take the thread back is to terminate the worker and respawn it.
//
// THE TRADE. Respawning is not free: the worker must start and the model
// must load again (PM-WARM measures this), and the first inferences after
// a spawn run several times slower than steady state before the runtime
// settles. So preemption is a wager, and the arithmetic must be real:
//
//     abandon only when finishing costs more than starting over.
//
// Both sides of that comparison are estimates, so the rules below are
// deliberately biased toward letting work finish. A wrong "let it finish"
// costs some seconds of latency. A wrong "preempt" costs those seconds
// PLUS a respawn PLUS a slow first window, and can repeat.

(function (root) {
  "use strict";

  // What a respawn costs when we have no measurement yet. PM-WARM in the
  // field reports spawn plus model load in the 1000-2500ms range; this is
  // the pessimistic end, because over-estimating the cost only makes us
  // preempt less often, which is the safe direction.
  var DEFAULT_RESPAWN_MS = 2500;

  // The first inferences after a fresh worker run far slower than steady
  // state. The same field log shows rtf around 1.0-1.9 on the first
  // windows after a seek against 0.23 once settled, so a respawn is not
  // paid for once, it is paid for again on the next window or two. Charged
  // to the preemption side of the ledger rather than quietly ignored.
  var WARMUP_PENALTY_MS = 1500;

  // Observed throughput of the first inferences after a fresh worker, in
  // wall ms per second of audio. The 0.1.42 field log put early windows at
  // rtf 1.0 to 1.9 against 0.23 once settled. Exported because the pill's
  // cold-start quote needs the same number: a cold estimate built from a
  // different constant would contradict the preemption model about how
  // slow a cold pipeline is, and one of them would be wrong.
  var WARMUP_RTF = 1.5;

  // A window that has already run past its predicted time tells us the
  // prediction was wrong, not that it is about to finish. When overdue,
  // assume at least this fraction of the elapsed time still remains,
  // rather than reporting zero. See estimateRemainingMs.
  var OVERDUE_REMAINING_RATIO = 0.5;

  // A scrubbing user fires a seek per frame. Preempting on each one would
  // respawn the worker continuously and transcribe nothing at all, which
  // is a worse failure than the one being fixed.
  var SETTLE_MS = 400;
  var MIN_PREEMPT_INTERVAL_MS = 5000;

  // Fallback throughput when the session has no measurement yet. Matches
  // the existing pipeline default.
  var DEFAULT_RTF = 0.3;

  // Both sides of the comparison are estimates, so a hair's-breadth win is
  // not a win. Preemption must beat finishing by a margin worth the risk of
  // being wrong about either number, or we are gambling on noise for a few
  // hundred milliseconds. Sized so the field case (about 7.5s remaining
  // against a 3.5s cost) clears it comfortably while a genuinely marginal
  // case does not.
  var MIN_NET_SAVING_MS = 2000;

  // Is the in-flight window still worth anything at the new playhead? It is
  // if it overlaps the span we are about to need protected.
  function stillUseful(inFlight, playheadT, protectMarginS) {
    if (!inFlight) return false;
    if (typeof playheadT !== "number") return true; // unknown playhead: assume it matters
    var margin = typeof protectMarginS === "number" ? protectMarginS : 5;
    return inFlight.start <= playheadT + margin && inFlight.end >= playheadT;
  }

  // How much longer this window is likely to take.
  //
  // 0.1.43 rewrote this after the field log caught it reporting
  // remaining=0ms for a window that then ran 4.4 more seconds. Two separate
  // errors, both of which made abandoned work look free to wait for:
  //
  // 1. IT FLOORED AT ZERO. `max(0, expected - elapsed)` says that anything
  //    already overdue is about to finish. That is backwards. Running past
  //    the prediction is evidence the prediction was wrong, and the accurate
  //    reading of "this should have taken 750ms and has taken 1447ms" is
  //    "it is slower than I thought", never "it is nearly done".
  //
  // 2. IT TREATED THE WINDOW AS ONE BLOB. A window waits for the worker
  //    mutex and then computes. At the moment of the field decision the
  //    window had been QUEUED for 1447ms and had not started computing at
  //    all, so the entire compute still lay ahead of it. Subtracting queue
  //    time from a whole-window prediction charged that waiting against
  //    work that had not begun.
  //
  // So the estimate is now built per stage. `computeStartedWall` is null
  // while the window is still waiting, in which case the full expected
  // compute is still to come.
  //
  // `effectiveRtf` must be WALL-clock throughput, not compute-only, for the
  // same reason as before: the queue wait is elapsed time a preemption
  // reclaims.
  function estimateRemainingMs(inFlight, effectiveRtf, now) {
    if (!inFlight || typeof inFlight.startedWall !== "number") return null;
    var audioS = typeof inFlight.audioS === "number" && inFlight.audioS > 0 ? inFlight.audioS : null;
    if (audioS == null) return null;
    var rtf = typeof effectiveRtf === "number" && isFinite(effectiveRtf) && effectiveRtf > 0
      ? effectiveRtf
      : DEFAULT_RTF;
    // A cold window runs at warm-up speed, not at the session's settled
    // average. The field case was exactly this: a steady-state rtf of about
    // 0.3 predicted 750ms for a window that took 5518ms, because it was the
    // first window at a fresh position. Using the higher of the two is the
    // only reading that is not knowingly optimistic.
    if (inFlight.isCold === true) rtf = Math.max(rtf, WARMUP_RTF);
    var nowMs = typeof now === "number" ? now : Date.now();
    var expectedTotalMs = audioS * rtf * 1000;

    if (typeof inFlight.computeStartedWall !== "number") {
      // Still queued. Everything the compute will take is ahead of us, and
      // no amount of waiting already done reduces it.
      return expectedTotalMs;
    }

    var computeElapsedMs = Math.max(0, nowMs - inFlight.computeStartedWall);
    var remaining = expectedTotalMs - computeElapsedMs;
    if (remaining > 0) return remaining;
    // Overdue: the prediction has been falsified, so lean on what has
    // actually been observed rather than on a number already proven wrong.
    return Math.max(0, computeElapsedMs * OVERDUE_REMAINING_RATIO);
  }

  function respawnCostMs(input) {
    var measured = typeof input.respawnMeasuredMs === "number" && input.respawnMeasuredMs > 0
      ? input.respawnMeasuredMs
      : DEFAULT_RESPAWN_MS;
    var warmup = typeof input.warmupPenaltyMs === "number" ? input.warmupPenaltyMs : WARMUP_PENALTY_MS;
    return measured + warmup;
  }

  // decide(input) -> {action, reason, remainingMs, costMs}
  //
  //   "preempt"     terminate the worker and start the playhead's window
  //   "let-finish"  leave it alone; it will land and be handled by the
  //                 existing STALE-KEPT path
  //   "none"        nothing to decide yet
  //
  // input:
  //   inFlight {start, end, startedWall, audioS, sessionKey} | null
  //   ownSessionKey     only OUR session's work may be preempted; the
  //                     worker is shared across tabs and killing another
  //                     tab's compute to serve ours is not ours to do
  //   playheadT, protectMarginS, effectiveRtf
  //   now, sinceSeekMs, settleMs
  //   lastPreemptWall, minPreemptIntervalMs
  //   respawnMeasuredMs, warmupPenaltyMs
  function decide(input) {
    input = input || {};
    var now = typeof input.now === "number" ? input.now : Date.now();
    var inFlight = input.inFlight;
    var cost = respawnCostMs(input);

    if (!inFlight) {
      return { action: "none", reason: "nothing-in-flight", remainingMs: null, costMs: cost };
    }
    // The worker is shared by every tab using this offscreen document.
    // Terminating it to serve our own seek would abandon someone else's
    // window mid-compute, which is a cost they never agreed to pay.
    if (input.ownSessionKey != null && inFlight.sessionKey != null &&
        inFlight.sessionKey !== input.ownSessionKey) {
      return { action: "none", reason: "other-session-owns-worker", remainingMs: null, costMs: cost };
    }

    // Wait for the playhead to settle. A scrub is many seeks, and the last
    // one is the only one worth acting on.
    var settleMs = typeof input.settleMs === "number" ? input.settleMs : SETTLE_MS;
    if (typeof input.sinceSeekMs === "number" && input.sinceSeekMs < settleMs) {
      return { action: "none", reason: "not-settled", remainingMs: null, costMs: cost };
    }

    if (stillUseful(inFlight, input.playheadT, input.protectMarginS)) {
      return { action: "let-finish", reason: "still-useful", remainingMs: null, costMs: cost };
    }

    var remainingMs = estimateRemainingMs(inFlight, input.effectiveRtf, now);

    // THE FREE CASE (0.1.43). A window still waiting for the worker mutex
    // has not consumed the worker at all, so dropping it needs no
    // terminate, no respawn and no warm-up: the cost is zero and the whole
    // remaining time is recovered. The field decision was exactly here,
    // 823ms before its compute began, and the old code weighed it as though
    // abandoning it required killing the worker.
    //
    // No thrash guard and no margin apply, because there is nothing to
    // trade off. Cancelling queued work for a position nobody is watching
    // is not a wager, it is tidying up.
    if (typeof inFlight.computeStartedWall !== "number") {
      return {
        action: "cancel-queued",
        reason: "queued-and-abandoned",
        remainingMs: remainingMs,
        costMs: 0
      };
    }

    // From here the worker is genuinely busy with this window, so taking
    // the thread back means terminating it. That IS a wager.
    //
    // Thrash guard: even with a settle delay, a user working a long video
    // produces settled seeks repeatedly, and respawning every few seconds
    // would spend the session starting up. Deliberately below the free
    // path above, which it must never block.
    var minInterval = typeof input.minPreemptIntervalMs === "number"
      ? input.minPreemptIntervalMs
      : MIN_PREEMPT_INTERVAL_MS;
    if (typeof input.lastPreemptWall === "number" && now - input.lastPreemptWall < minInterval) {
      return { action: "let-finish", reason: "thrash-guard", remainingMs: remainingMs, costMs: cost };
    }

    if (remainingMs == null) {
      // No basis for an estimate means no basis for a wager. Finishing is
      // the outcome we can at least predict.
      return { action: "let-finish", reason: "no-estimate", remainingMs: null, costMs: cost };
    }
    var minNet = typeof input.minNetSavingMs === "number" ? input.minNetSavingMs : MIN_NET_SAVING_MS;
    if (remainingMs <= cost + minNet) {
      return { action: "let-finish", reason: "cheaper-to-finish", remainingMs: remainingMs, costMs: cost };
    }
    return { action: "preempt", reason: "abandoned-and-slow", remainingMs: remainingMs, costMs: cost };
  }

  var PMPreemptCore = {
    DEFAULT_RESPAWN_MS: DEFAULT_RESPAWN_MS,
    WARMUP_PENALTY_MS: WARMUP_PENALTY_MS,
    SETTLE_MS: SETTLE_MS,
    MIN_PREEMPT_INTERVAL_MS: MIN_PREEMPT_INTERVAL_MS,
    DEFAULT_RTF: DEFAULT_RTF,
    WARMUP_RTF: WARMUP_RTF,
    OVERDUE_REMAINING_RATIO: OVERDUE_REMAINING_RATIO,
    MIN_NET_SAVING_MS: MIN_NET_SAVING_MS,
    stillUseful: stillUseful,
    estimateRemainingMs: estimateRemainingMs,
    respawnCostMs: respawnCostMs,
    decide: decide
  };

  root.PMPreempt = PMPreemptCore;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMPreemptCore: PMPreemptCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
