// test/preempt_test.js
// Node unit tests for shared/preempt.js: whether to abandon a
// transcription nobody is waiting for.
//
// Run with: node test/preempt_test.js   (or npm test, from extension/)
//
// THE CASE THIS EXISTS FOR, from the 0.1.41 field log. A window for
// [24.00,26.50) entered the worker at 14:11:23.9. At 14:11:24.8 the user
// seeked to t=1633.93. The window kept computing until 14:11:32.4, and
// only then did the first window at the real position start: 7.6 seconds
// of a single-threaded worker busy on a position the user had left.
//
// The generation machinery already made the RESULT harmless. It cannot
// stop the WORK, because a running WASM call is not interruptible, so the
// only way to reclaim the thread is to terminate the worker and respawn.
// That is a wager with a real cost on both sides, and these tests hold the
// arithmetic straight: preemption must WIN, not merely be possible.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMPreemptCore } = require(path.join(__dirname, "..", "shared", "preempt.js"));

const P = PMPreemptCore;
const NOW = 1_800_000_000_000;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error("FAIL: " + name);
    console.error("      " + (e && e.message ? e.message : String(e)));
  }
}

// The field window, parameterised. Wall-clock rtf of 3.36 is what that
// window actually achieved: 8410ms for 2.5s of audio.
function fieldCase(over) {
  return P.decide(
    Object.assign(
      {
        inFlight: {
          start: 24,
          end: 26.5,
          startedWall: NOW - 900,
          // 0.1.43 split queued from computing. These cases are about the
          // respawn wager, so they describe a window that has the worker.
          computeStartedWall: NOW - 900,
          audioS: 2.5,
          sessionKey: "tab1:vid"
        },
        ownSessionKey: "tab1:vid",
        playheadT: 1633.93,
        protectMarginS: 5,
        effectiveRtf: 3.36,
        now: NOW,
        sinceSeekMs: 500,
        respawnMeasuredMs: 2000
      },
      over || {}
    )
  );
}

// ---- the field case ------------------------------------------------------

test("the 7.6s abandoned compute is preempted", () => {
  const v = fieldCase();
  assert.strictEqual(v.action, "preempt");
  assert.strictEqual(v.reason, "abandoned-and-slow");
});

test("and preemption wins by a real margin, not a rounding error", () => {
  const v = fieldCase();
  const net = v.remainingMs - v.costMs;
  assert.ok(net >= P.MIN_NET_SAVING_MS, "net saving " + Math.round(net) + "ms");
});

test("the cost model charges for warmup, not just spawn and load", () => {
  // The first inferences after a fresh worker run several times slower than
  // steady state, so a respawn is paid for again on the next window or two.
  // Pretending otherwise would make preemption look cheaper than it is.
  const cost = P.respawnCostMs({ respawnMeasuredMs: 2000 });
  assert.strictEqual(cost, 2000 + P.WARMUP_PENALTY_MS);
  assert.ok(P.WARMUP_PENALTY_MS > 0);
});

// ---- when NOT to preempt -------------------------------------------------

test("a window still covering the new playhead is left alone", () => {
  // Seeking a few seconds forward does not invalidate work that already
  // covers where you landed.
  const v = fieldCase({ playheadT: 25.5 });
  assert.strictEqual(v.action, "let-finish");
  assert.strictEqual(v.reason, "still-useful");
});

test("a window just inside the protect margin still counts as useful", () => {
  const v = fieldCase({ playheadT: 20 }); // window ends 26.5, margin 5
  assert.strictEqual(v.reason, "still-useful");
});

test("a nearly-finished compute is left alone", () => {
  // Killing work that is about to land pays the respawn for nothing.
  const v = fieldCase({ inFlight: {
    start: 24, end: 26.5, startedWall: NOW - 8000, computeStartedWall: NOW - 7900,
    audioS: 2.5, sessionKey: "tab1:vid"
  } });
  assert.strictEqual(v.action, "let-finish");
  assert.strictEqual(v.reason, "cheaper-to-finish");
});

test("a marginal win is declined", () => {
  // Both sides of the comparison are estimates. A few hundred milliseconds
  // of predicted gain is not worth a wager that can cost seconds when wrong.
  const v = fieldCase({ effectiveRtf: 1.9 });
  assert.strictEqual(v.action, "let-finish");
  assert.strictEqual(v.reason, "cheaper-to-finish");
});

test("with no throughput measurement yet, nothing is abandoned", () => {
  // No basis for an estimate is no basis for a wager.
  const v = fieldCase({ inFlight: {
    start: 24, end: 26.5, startedWall: NOW - 900, computeStartedWall: NOW - 900,
    audioS: null, sessionKey: "tab1:vid"
  } });
  assert.strictEqual(v.action, "let-finish");
  assert.strictEqual(v.reason, "no-estimate");
});

test("an idle worker has nothing to decide", () => {
  assert.strictEqual(P.decide({ inFlight: null }).action, "none");
  assert.strictEqual(P.decide({}).reason, "nothing-in-flight");
});

// ---- the shared worker ---------------------------------------------------

test("another TAB's compute is never abandoned to serve ours", () => {
  // The worker is shared by every tab using the offscreen document.
  // Terminating it for our own seek would abandon someone else's window
  // mid-compute, a cost they never agreed to pay.
  const v = fieldCase({ inFlight: {
    start: 24, end: 26.5, startedWall: NOW - 900, computeStartedWall: NOW - 900,
    audioS: 2.5, sessionKey: "tab9:other"
  } });
  assert.strictEqual(v.action, "none");
  assert.strictEqual(v.reason, "other-session-owns-worker");
});

// ---- scrubbing -----------------------------------------------------------

test("an unsettled seek is not acted on", () => {
  // A scrub is many seeks and only the last one matters. Acting on each
  // would respawn the worker continuously and transcribe nothing at all,
  // which is worse than the problem being fixed.
  const v = fieldCase({ sinceSeekMs: 50 });
  assert.strictEqual(v.action, "none");
  assert.strictEqual(v.reason, "not-settled");
});

test("the settle threshold is short enough to stay responsive", () => {
  assert.ok(P.SETTLE_MS >= 200 && P.SETTLE_MS <= 800, "settle " + P.SETTLE_MS + "ms");
  const v = fieldCase({ sinceSeekMs: P.SETTLE_MS });
  assert.strictEqual(v.action, "preempt");
});

test("a recent preemption blocks another one", () => {
  const v = fieldCase({ lastPreemptWall: NOW - 1000 });
  assert.strictEqual(v.action, "let-finish");
  assert.strictEqual(v.reason, "thrash-guard");
});

test("the guard expires, so a genuinely new seek is still served", () => {
  const v = fieldCase({ lastPreemptWall: NOW - (P.MIN_PREEMPT_INTERVAL_MS + 1) });
  assert.strictEqual(v.action, "preempt");
});

test("repeated settled seeks cannot respawn the worker in a loop", () => {
  // The property that matters, checked as a sequence rather than a single
  // call: a user working a long video fires settled seeks repeatedly.
  let lastPreemptWall = null;
  let preemptions = 0;
  for (let i = 0; i < 20; i++) {
    const now = NOW + i * 1000; // a settled seek every second
    const v = P.decide({
      inFlight: {
        start: 24, end: 26.5, startedWall: now - 900, computeStartedWall: now - 900,
        audioS: 2.5, sessionKey: "k"
      },
      ownSessionKey: "k",
      playheadT: 1633.93,
      effectiveRtf: 3.36,
      now: now,
      sinceSeekMs: 500,
      lastPreemptWall: lastPreemptWall,
      respawnMeasuredMs: 2000
    });
    if (v.action === "preempt") {
      preemptions++;
      lastPreemptWall = now;
    }
  }
  assert.ok(preemptions <= 5, "20s of seeking produced " + preemptions + " respawns");
});

// ---- estimation ----------------------------------------------------------

test("remaining time counts elapsed work already done", () => {
  const inFlight = { start: 0, end: 10, startedWall: NOW - 2100, computeStartedWall: NOW - 2000, audioS: 10 };
  assert.strictEqual(P.estimateRemainingMs(inFlight, 1.0, NOW), 8000);
});

test("remaining time never goes negative", () => {
  // 0.1.43: an overdue compute reports what the overrun implies, not zero.
  const inFlight = { start: 0, end: 10, startedWall: NOW - 60000, computeStartedWall: NOW - 60000, audioS: 10 };
  assert.strictEqual(
    P.estimateRemainingMs(inFlight, 1.0, NOW),
    60000 * P.OVERDUE_REMAINING_RATIO
  );
});

test("a missing rtf falls back to the pipeline default rather than zero", () => {
  const inFlight = { start: 0, end: 10, startedWall: NOW, audioS: 10 };
  assert.strictEqual(P.estimateRemainingMs(inFlight, null, NOW), 10 * P.DEFAULT_RTF * 1000);
});

test("stillUseful asks whether the window overlaps the protect span", () => {
  // The protect span is [playhead, playhead + margin]. A window ENDING
  // before the playhead is behind the user and no longer useful, however
  // close it sits; a window starting after the span is not needed yet.
  const w = { start: 10, end: 20 };
  assert.strictEqual(P.stillUseful(w, 20, 5), true, "window end touches the playhead");
  assert.strictEqual(P.stillUseful(w, 20.01, 5), false, "just behind the playhead");
  assert.strictEqual(P.stillUseful(w, 15, 5), true, "playhead inside the window");
  assert.strictEqual(P.stillUseful(w, 5, 5), true, "window starts inside the protect span");
  assert.strictEqual(P.stillUseful(w, 4.99, 5), false, "window starts past the protect span");
  assert.strictEqual(P.stillUseful(null, 5, 5), false);
});

test("an unknown playhead is treated as still needing the work", () => {
  assert.strictEqual(P.stillUseful({ start: 10, end: 20 }, null, 5), true);
});

// ---- the 0.1.43 estimator bug -------------------------------------------
//
// The field log caught the policy doing the right thing on wrong data:
//
//   14:22:53.135  "let-finish (cheaper-to-finish) remaining=0ms"
//   14:22:57.167  that window finished, 4.03 seconds later
//
// Reconstructed from its final numbers (wallMs=5518 queueMs=2270
// computeMs=3209 decodeMs=39): it was queued at 51.688 and its compute did
// not begin until 53.958. So at the moment of the decision it had not
// touched the worker at all, and the entire compute still lay ahead.
//
// Two separate errors produced "0ms", and both made abandoned work look
// free to wait for.

test("a QUEUED window does not report zero remaining", () => {
  // Error 1: the estimate subtracted queue time from a whole-window
  // prediction, charging the wait against work that had not begun.
  const remaining = P.estimateRemainingMs(
    { startedWall: NOW - 1447, audioS: 2.5 }, // queued 1447ms ago, not computing
    0.3,
    NOW
  );
  assert.ok(remaining > 0, "reported " + remaining + "ms");
  assert.strictEqual(remaining, 2.5 * 0.3 * 1000, "the whole compute is still ahead");
});

test("an overdue compute does not report zero either", () => {
  // Error 2: max(0, expected - elapsed) says anything overdue is about to
  // finish. Running past the prediction is evidence the prediction was
  // wrong, never evidence of being nearly done.
  const remaining = P.estimateRemainingMs(
    { startedWall: NOW - 5000, computeStartedWall: NOW - 4000, audioS: 2.5 },
    0.3, // predicts 750ms; it has already run 4000ms
    NOW
  );
  assert.ok(remaining > 0, "reported " + remaining + "ms");
  assert.strictEqual(remaining, 4000 * P.OVERDUE_REMAINING_RATIO);
});

test("a COLD window is estimated at warm-up speed, not the settled average", () => {
  // The field window ran at an effective rtf of 2.2 while the session
  // average was around 0.3, because it was the first at a fresh position.
  const warm = P.estimateRemainingMs({ startedWall: NOW, audioS: 2.5 }, 0.3, NOW);
  const cold = P.estimateRemainingMs({ startedWall: NOW, audioS: 2.5, isCold: true }, 0.3, NOW);
  assert.ok(cold > warm, "cold " + cold + " vs warm " + warm);
  assert.strictEqual(cold, 2.5 * P.WARMUP_RTF * 1000);
});

test("the field decision now recovers the time instead of waiting for it", () => {
  // The whole point of the round. True remaining was 4032ms.
  const v = P.decide({
    inFlight: {
      start: 24, end: 26.5,
      startedWall: NOW - 1447,
      computeStartedWall: null, // still queued, as it actually was
      audioS: 2.5, isCold: true, sessionKey: "k"
    },
    ownSessionKey: "k",
    playheadT: 1633.93,
    protectMarginS: 5,
    effectiveRtf: 0.3,
    now: NOW,
    sinceSeekMs: 500,
    respawnMeasuredMs: 2500
  });
  assert.strictEqual(v.action, "cancel-queued");
  assert.ok(v.remainingMs > 3000, "estimate near the true 4032ms: " + Math.round(v.remainingMs));
});

// ---- cancelling queued work is free -------------------------------------

test("dropping a QUEUED window costs nothing", () => {
  // It never reached the worker, so there is no terminate, no respawn and
  // no warm-up to pay for. Not a wager: tidying up.
  const v = fieldCase({ inFlight: {
    start: 24, end: 26.5, startedWall: NOW - 100, computeStartedWall: null,
    audioS: 2.5, sessionKey: "tab1:vid"
  } });
  assert.strictEqual(v.action, "cancel-queued");
  assert.strictEqual(v.costMs, 0);
});

test("the free path ignores the thrash guard and the margin", () => {
  // Both exist to price a respawn. With nothing to pay, there is nothing
  // for them to protect against.
  const v = fieldCase({
    lastPreemptWall: NOW - 10, // would block a respawn
    inFlight: {
      start: 24, end: 26.5, startedWall: NOW - 10, computeStartedWall: null,
      audioS: 0.1, sessionKey: "tab1:vid" // trivially small remaining
    }
  });
  assert.strictEqual(v.action, "cancel-queued");
});

test("a window that HAS started computing is still a wager", () => {
  const v = fieldCase({ inFlight: {
    start: 24, end: 26.5, startedWall: NOW - 2000, computeStartedWall: NOW - 100,
    audioS: 2.5, isCold: true, sessionKey: "tab1:vid"
  } });
  assert.ok(v.action === "preempt" || v.action === "let-finish", v.action);
  assert.ok(v.costMs > 0, "a respawn is never free");
});

test("another tab's QUEUED window is still not ours to drop", () => {
  // The free path must not become a loophole around the shared-worker rule.
  const v = fieldCase({ inFlight: {
    start: 24, end: 26.5, startedWall: NOW - 100, computeStartedWall: null,
    audioS: 2.5, sessionKey: "tab9:other"
  } });
  assert.strictEqual(v.action, "none");
  assert.strictEqual(v.reason, "other-session-owns-worker");
});

test("a queued window still covering the playhead is kept", () => {
  const v = fieldCase({
    playheadT: 25,
    inFlight: {
      start: 24, end: 26.5, startedWall: NOW - 100, computeStartedWall: null,
      audioS: 2.5, sessionKey: "tab1:vid"
    }
  });
  assert.strictEqual(v.action, "let-finish");
  assert.strictEqual(v.reason, "still-useful");
});

test("an unsettled seek still does not drop queued work", () => {
  const v = fieldCase({
    sinceSeekMs: 50,
    inFlight: {
      start: 24, end: 26.5, startedWall: NOW - 100, computeStartedWall: null,
      audioS: 2.5, sessionKey: "tab1:vid"
    }
  });
  assert.strictEqual(v.action, "none");
  assert.strictEqual(v.reason, "not-settled");
});

// ---- summary -------------------------------------------------------------

console.log("preempt_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
