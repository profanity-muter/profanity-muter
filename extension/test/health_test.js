// test/health_test.js
// Node unit tests for shared/health.js: the graceful-failure state
// machine, its reason codes, and the diagnostic classifier.
//
// Run with: node test/health_test.js   (or npm test, from extension/)
//
// This is the highest-stakes state machine in the extension, for a reason
// that is easy to lose sight of: the failures it detects are ones we
// cannot reproduce on demand. Nobody can make YouTube break audio
// interception on a test machine, so the ONLY way this logic is ever
// exercised before a user depends on it is here. Two opposite mistakes
// both have to be prevented, and the tests below are organized around
// them:
//
//   1. Missing a real break, which means a parent believes their filter
//      works when it does not. That is the worst outcome the extension
//      has, worse than not existing.
//   2. Crying wolf on a slow machine, a paused video, a livestream, or a
//      pipeline that is merely lagging. A filter that warns spuriously
//      gets ignored or uninstalled, which produces outcome 1 anyway.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMHealthCore } = require(path.join(__dirname, "..", "shared", "health.js"));

const H = PMHealthCore;
const R = H.REASONS;
const S = H.STATUS;
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

// A healthy-looking baseline: a watch page, playing, well past the first
// evaluation point, audio arriving, windows completing. Each case below
// breaks exactly one thing.
function input(over) {
  return Object.assign(
    {
      now: NOW,
      playbackMs: 30000,
      isWatchPage: true,
      isPaused: false,
      isLive: false,
      unanalyzable: false,
      windowsCompleted: 3,
      audioSegments: 40,
      fatalReasons: [],
      lastEvalAt: null
    },
    over || {}
  );
}

function evaluate(over) {
  return H.evaluate(input(over));
}

// ---- healthy -------------------------------------------------------------

test("a working pipeline is ok", () => {
  const v = evaluate();
  assert.strictEqual(v.status, S.OK);
  assert.strictEqual(v.reason, null);
  assert.strictEqual(v.message, "");
  assert.strictEqual(v.due, true);
});

test("ONE completed window is enough to be ok, however slow", () => {
  // Slow is not broken. A machine that managed a single window in five
  // minutes of playback is working, and must never be told otherwise.
  const v = evaluate({ windowsCompleted: 1, playbackMs: 300000 });
  assert.strictEqual(v.status, S.OK);
});

test("lagging analysis is ok, not broken", () => {
  // Catch-up mode "play" with coverage far behind the playhead: the
  // pipeline is demonstrably alive, which is the only question asked here.
  const v = evaluate({ windowsCompleted: 2, audioSegments: 500 });
  assert.strictEqual(v.status, S.OK);
});

// ---- pending (no verdict yet) -------------------------------------------

test("not a watch page is never judged", () => {
  const v = evaluate({ isWatchPage: false, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.PENDING);
  assert.strictEqual(v.due, false);
});

test("too little playback is pending, not a verdict", () => {
  const v = evaluate({ playbackMs: 19999, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.PENDING);
  assert.strictEqual(v.reason, "too-early");
});

test("exactly at the threshold, a verdict is reached", () => {
  const v = evaluate({ playbackMs: 20000, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.UNHEALTHY);
});

test("a PAUSED video never reaches the threshold on its own", () => {
  // The paused no-op is enforced by the clock: playbackMs counts only
  // actual playback, so a video paused early simply stays pending however
  // long it sits there. This is the guard against the most obvious false
  // alarm there is.
  const v = evaluate({ isPaused: true, playbackMs: 5000, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.PENDING);
  assert.strictEqual(v.reason, "too-early");
});

test("pausing AFTER earning a verdict does not discard it", () => {
  // 25 seconds of real playback with nothing analyzed is broken whether or
  // not the user has since hit pause.
  const v = evaluate({ isPaused: true, playbackMs: 25000, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.UNHEALTHY);
});

test("re-evaluation is throttled", () => {
  const base = { playbackMs: 30000, windowsCompleted: 0, audioSegments: 0 };
  const tooSoon = evaluate(Object.assign({}, base, { lastEvalAt: NOW - 14999 }));
  assert.strictEqual(tooSoon.status, S.PENDING);
  assert.strictEqual(tooSoon.reason, "not-due");
  const due = evaluate(Object.assign({}, base, { lastEvalAt: NOW - 15000 }));
  assert.strictEqual(due.status, S.UNHEALTHY);
});

test("the throttle never delays a HEALTHY verdict", () => {
  // Recovery has to be instant: a stale warning misleads the user exactly
  // as much as a missing one.
  const v = evaluate({ lastEvalAt: NOW, windowsCompleted: 1 });
  assert.strictEqual(v.status, S.OK);
  assert.strictEqual(v.due, true);
});

test("custom thresholds are honoured", () => {
  const v = H.evaluate(
    Object.assign(input({ playbackMs: 5000, windowsCompleted: 0, audioSegments: 0 }), {
      thresholds: { firstEvalMs: 4000, reEvalMs: 1000 }
    })
  );
  assert.strictEqual(v.status, S.UNHEALTHY);
});

// ---- each reason code ----------------------------------------------------

test("no audio intercepted", () => {
  const v = evaluate({ windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.UNHEALTHY);
  assert.strictEqual(v.reason, R.NO_AUDIO);
  assert.ok(/Filtering is off/.test(v.message), v.message);
  assert.ok(/can't read this video's audio/.test(v.message), v.message);
  assert.ok(v.detail.length > 0);
});

test("audio arrived but nothing was analyzed", () => {
  const v = evaluate({ windowsCompleted: 0, audioSegments: 25 });
  assert.strictEqual(v.reason, R.ZERO_WINDOWS);
});

// ---- missed init segment (0.1.52: started mid-video) ---------------------
//
// Two look-alike states that must NOT collapse into one message: audio is
// arriving and nothing is coming back either way, but "the extension started
// after the video did and missed the audio setup" is fixed by a reload,
// while a real decode failure that DID have an init segment is a different
// problem. The distinguishing fact is whether any init segment was ever
// captured.

test("audio arriving with NO init segment ever captured is the missed-init case", () => {
  const v = evaluate({ windowsCompleted: 0, audioSegments: 25, initSegments: 0 });
  assert.strictEqual(v.status, S.UNHEALTHY);
  assert.strictEqual(v.reason, R.MISSED_INIT);
  assert.ok(/started after this video did/.test(v.message), v.message);
  assert.ok(/Reload the page/.test(v.message), v.message);
  assert.ok(v.detail.length > 0);
});

test("audio arriving WITH an init segment but no windows is a real decode failure", () => {
  // The init segment was captured, so this is not a missed-init: it is the
  // genuine ZERO_WINDOWS failure, and must keep its own message.
  const v = evaluate({ windowsCompleted: 0, audioSegments: 25, initSegments: 1 });
  assert.strictEqual(v.status, S.UNHEALTHY);
  assert.strictEqual(v.reason, R.ZERO_WINDOWS);
});

test("a legacy caller that does not report initSegments stays ZERO_WINDOWS", () => {
  // Undefined must be treated as "not reported", never as zero, so an old
  // caller never gets a real decode failure relabeled as missed-init.
  const v = evaluate({ windowsCompleted: 0, audioSegments: 25 });
  assert.strictEqual(v.reason, R.ZERO_WINDOWS);
});

test("no audio at all outranks missed-init, even with zero init segments", () => {
  // If no audio ever arrived, the interception layer is the story, not the
  // init segment. NO_AUDIO is checked first and must win.
  const v = evaluate({ windowsCompleted: 0, audioSegments: 0, initSegments: 0 });
  assert.strictEqual(v.reason, R.NO_AUDIO);
});

test("a completed window clears the missed-init warning (reload worked)", () => {
  const missed = evaluate({ windowsCompleted: 0, audioSegments: 25, initSegments: 0 });
  assert.strictEqual(missed.reason, R.MISSED_INIT);
  const recovered = evaluate({ windowsCompleted: 1, audioSegments: 30, initSegments: 1, lastEvalAt: NOW });
  assert.strictEqual(recovered.status, S.OK);
  assert.strictEqual(H.isTransition(missed, recovered), true);
});

test("the missed-init message names the fix and stays jargon-free", () => {
  const m = H.messageFor(R.MISSED_INIT);
  assert.ok(/Reload/.test(m), m);
  assert.ok(!/offscreen|worker|init segment|demux|decode/i.test(m), m);
  assert.ok(H.detailFor(R.MISSED_INIT).length > 0);
});

test("model load failure", () => {
  const v = evaluate({ windowsCompleted: 0, audioSegments: 25, fatalReasons: [R.MODEL_LOAD_FAILED] });
  assert.strictEqual(v.reason, R.MODEL_LOAD_FAILED);
});

test("dead worker", () => {
  const v = evaluate({ windowsCompleted: 0, audioSegments: 25, fatalReasons: [R.WORKER_DEAD] });
  assert.strictEqual(v.reason, R.WORKER_DEAD);
});

test("a specific fatal cause outranks the symptoms it produces", () => {
  // A dead worker with no audio either: report the worker, because that
  // is the actionable fact and the other is downstream of it.
  const v = evaluate({
    windowsCompleted: 0,
    audioSegments: 0,
    fatalReasons: [R.WORKER_DEAD, R.MODEL_LOAD_FAILED]
  });
  assert.strictEqual(v.reason, R.MODEL_LOAD_FAILED, "model load is reported first");
});

test("fatal signals are ignored while windows are still completing", () => {
  // A transient error the pipeline recovered from must not raise an alarm
  // about a filter that is demonstrably working.
  const v = evaluate({ windowsCompleted: 4, fatalReasons: [R.WORKER_DEAD] });
  assert.strictEqual(v.status, S.OK);
});

test("every reason code has a message and a detail", () => {
  Object.keys(R).forEach(function (key) {
    const code = R[key];
    assert.ok(H.messageFor(code).length > 0, code);
    assert.ok(H.detailFor(code).length > 0, code);
  });
});

test("no message contains an emoji or jargon the user cannot act on", () => {
  Object.keys(R).forEach(function (key) {
    const m = H.messageFor(R[key]);
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(m), m);
    assert.ok(!/offscreen|worker|websocket|wasm/i.test(m), m);
  });
});

// ---- documented limits are not failures ---------------------------------

test("a livestream is unsupported, never 'broken'", () => {
  const v = evaluate({ isLive: true, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.UNSUPPORTED);
  assert.strictEqual(v.reason, R.LIVESTREAM);
  assert.ok(/Livestreams aren't filtered/.test(v.message), v.message);
  assert.ok(!/isn't working/.test(v.message), "must not use the alarming copy");
});

test("a livestream is judged immediately, without waiting out the clock", () => {
  const v = evaluate({ isLive: true, playbackMs: 0, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.UNSUPPORTED);
  assert.strictEqual(v.due, true);
});

test("a livestream that somehow analyzed windows is still reported as unsupported", () => {
  // Best-effort transcription against a DVR buffer does happen; the
  // guarantee still does not hold, so the accurate label wins.
  const v = evaluate({ isLive: true, windowsCompleted: 5 });
  assert.strictEqual(v.reason, R.LIVESTREAM);
});

test("a Short is unsupported, never 'broken'", () => {
  const v = evaluate({ isShorts: true, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.UNSUPPORTED);
  assert.strictEqual(v.reason, R.SHORTS);
  assert.ok(/Shorts aren't filtered yet/.test(v.message), v.message);
  assert.ok(!/isn't working/.test(v.message), "must not use the alarming copy");
});

test("a Short is judged immediately, without waiting out the clock", () => {
  const v = evaluate({ isShorts: true, playbackMs: 0, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.UNSUPPORTED);
  assert.strictEqual(v.due, true);
});

test("Shorts outranks live, since a Short can also be a premiere", () => {
  const v = evaluate({ isShorts: true, isLive: true });
  assert.strictEqual(v.reason, R.SHORTS);
});

test("a Short that somehow analyzed windows is still reported as unsupported", () => {
  // Best-effort coverage can happen on a looping clip; the guarantee still
  // does not hold, so the accurate label wins.
  const v = evaluate({ isShorts: true, windowsCompleted: 5 });
  assert.strictEqual(v.reason, R.SHORTS);
});

test("protected/undecodable content is unsupported, not broken", () => {
  const v = evaluate({ unanalyzable: true, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.UNSUPPORTED);
  assert.strictEqual(v.reason, R.UNANALYZABLE);
  assert.ok(!/isn't working/.test(v.message), v.message);
});

test("live outranks unanalyzable when both are somehow set", () => {
  const v = evaluate({ isLive: true, unanalyzable: true });
  assert.strictEqual(v.reason, R.LIVESTREAM);
});

// ---- served elsewhere (0.1.49 active-tab-follow) -------------------------

test("a tab served elsewhere is waiting, not broken", () => {
  // Inactive tab, no windows, no audio: without the servedElsewhere branch
  // this would be a NO_AUDIO false alarm.
  const v = evaluate({ servedElsewhere: true, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.WAITING);
  assert.strictEqual(v.reason, R.OTHER_TAB);
  assert.strictEqual(v.due, true);
  assert.ok(/another tab/i.test(v.message), v.message);
  assert.ok(!/isn't working/.test(v.message), "waiting is not an error");
});

test("served-elsewhere outranks a stale OK from earlier coverage", () => {
  // A tab that analyzed windows earlier, then was switched away from, must
  // not keep reporting a green 'protected' while it is no longer being served.
  const v = evaluate({ servedElsewhere: true, windowsCompleted: 12 });
  assert.strictEqual(v.status, S.WAITING);
  assert.strictEqual(v.reason, R.OTHER_TAB);
});

test("served-elsewhere never fires the stall warning", () => {
  // An outstanding promise on an inactive tab is moot: we deliberately are
  // not analyzing it, so it must never escalate to STALLED.
  const v = evaluate({
    servedElsewhere: true,
    windowsCompleted: 0,
    promiseAgeMs: 999999,
    promiseEtaMs: 3000
  });
  assert.strictEqual(v.status, S.WAITING);
  assert.strictEqual(v.reason, R.OTHER_TAB);
});

test("becoming active again clears the waiting state", () => {
  const waiting = evaluate({ servedElsewhere: true, windowsCompleted: 0 });
  assert.strictEqual(waiting.status, S.WAITING);
  const active = evaluate({ servedElsewhere: false, windowsCompleted: 2 });
  assert.strictEqual(active.status, S.OK);
  assert.strictEqual(H.isTransition(waiting, active), true);
});

test("a documented limit outranks served-elsewhere (a Short is a Short in any tab)", () => {
  const v = evaluate({ servedElsewhere: true, isShorts: true });
  assert.strictEqual(v.reason, R.SHORTS);
});

// ---- recovery ------------------------------------------------------------

test("a window completing after a warning flips the verdict back to ok", () => {
  const broken = evaluate({ windowsCompleted: 0, audioSegments: 30 });
  assert.strictEqual(broken.status, S.UNHEALTHY);
  const recovered = evaluate({ windowsCompleted: 1, audioSegments: 30, lastEvalAt: NOW });
  assert.strictEqual(recovered.status, S.OK);
  assert.strictEqual(H.isTransition(broken, recovered), true);
});

test("recovery holds even with the old fatal signals still on record", () => {
  const recovered = evaluate({ windowsCompleted: 1, fatalReasons: [R.WORKER_DEAD, R.MODEL_LOAD_FAILED] });
  assert.strictEqual(recovered.status, S.OK);
});

// ---- transitions ---------------------------------------------------------

test("isTransition fires once per change, not per evaluation", () => {
  const a = evaluate({ windowsCompleted: 0, audioSegments: 0 });
  const b = evaluate({ windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(H.isTransition(a, b), false, "same verdict twice is not a transition");
  const c = evaluate({ windowsCompleted: 0, audioSegments: 5 });
  assert.strictEqual(c.reason, R.ZERO_WINDOWS);
  assert.strictEqual(H.isTransition(a, c), true, "a different reason IS a transition");
});

test("the first real verdict is a transition; a first pending one is not", () => {
  assert.strictEqual(H.isTransition(null, evaluate()), true);
  assert.strictEqual(H.isTransition(null, evaluate({ isWatchPage: false })), false);
});

test("a pending result never overwrites a real verdict", () => {
  const broken = evaluate({ windowsCompleted: 0, audioSegments: 0 });
  const pending = evaluate({ playbackMs: 100, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(pending.status, S.PENDING);
  assert.strictEqual(H.isTransition(broken, pending), false);
});

// ---- the promise ledger (0.1.34) ----------------------------------------
//
// The field test found the pill promising "safe to pause (~3s)" and then
// sitting frozen on it for 30+ seconds against a wedged decoder, while the
// health monitor stayed silent because its clock only counts PLAYBACK and
// the user had done exactly what the pill told them to do: pause. Someone
// who pauses BECAUSE we said it was safe is the person least able to notice
// that nothing is happening. These tests pin both halves of the fix.

test("a promise holds its ORIGINAL clock and quote until a window completes", () => {
  // Re-quoting a fresh estimate on every render is precisely how the pill
  // stayed plausible forever: every frame it said "~3s" and every frame
  // that was a brand new, equally untested claim.
  let p = H.openOrKeepPromise(null, { now: 1000, windowsCompleted: 2, etaS: 3 });
  assert.deepStrictEqual(p, { issuedWall: 1000, etaS: 3, windowsAtIssue: 2 });
  p = H.openOrKeepPromise(p, { now: 9000, windowsCompleted: 2, etaS: 9 });
  assert.strictEqual(p.issuedWall, 1000, "clock is not restarted");
  assert.strictEqual(p.etaS, 3, "quote is not revised upward to stay plausible");
});

test("completing a window retires the promise and starts a fresh clock", () => {
  // Which is what makes "no outstanding promise" and "the promise was kept"
  // the same thing to every consumer.
  const first = H.openOrKeepPromise(null, { now: 1000, windowsCompleted: 2, etaS: 3 });
  const next = H.openOrKeepPromise(first, { now: 9000, windowsCompleted: 3, etaS: 4 });
  assert.strictEqual(next.issuedWall, 9000);
  assert.strictEqual(next.etaS, 4);
  assert.strictEqual(next.windowsAtIssue, 3);
});

test("a promise opened before an ETA could be computed accepts the first one", () => {
  let p = H.openOrKeepPromise(null, { now: 1000, windowsCompleted: 0, etaS: null });
  assert.strictEqual(p.etaS, null);
  p = H.openOrKeepPromise(p, { now: 1200, windowsCompleted: 0, etaS: 5 });
  assert.strictEqual(p.etaS, 5);
  assert.strictEqual(p.issuedWall, 1000, "and still does not restart the clock");
});

test("promiseAgeMs measures wall time, and never goes negative", () => {
  const p = { issuedWall: 5000, etaS: 3, windowsAtIssue: 0 };
  assert.strictEqual(H.promiseAgeMs(p, 8000), 3000);
  assert.strictEqual(H.promiseAgeMs(p, 4000), 0, "a clock that moved backwards is not a promise kept");
  assert.strictEqual(H.promiseAgeMs(null, 8000), null);
  assert.strictEqual(H.promiseAgeMs({}, 8000), null);
});

test("the pill escalates at 2x the quoted time, not before", () => {
  const p = { issuedWall: 0, etaS: 3, windowsAtIssue: 0 };
  assert.strictEqual(H.promiseEscalated(p, 5999), false);
  assert.strictEqual(H.promiseEscalated(p, 6001), true);
});

test("a promise with no quote yet cannot be escalated", () => {
  assert.strictEqual(H.promiseEscalated({ issuedWall: 0, etaS: null }, 999999), false);
  assert.strictEqual(H.promiseEscalated(null, 999999), false);
});

// ---- health: the broken-promise verdict ---------------------------------

test("a broken promise is unhealthy, with its own reason code", () => {
  const v = evaluate({ promiseAgeMs: 31000, promiseEtaMs: 3000, windowsCompleted: 4 });
  assert.strictEqual(v.status, S.UNHEALTHY);
  assert.strictEqual(v.reason, R.STALLED);
  assert.ok(/stopped analyzing/.test(v.message), v.message);
  assert.ok(/NOT being filtered/.test(v.message), v.message);
});

test("the broken-promise check fires WHILE PAUSED", () => {
  // The whole point. The playback-only clock is right that pausing is not a
  // fault, but it must not mean we never check a promise we made, or the
  // person who paused because we told them to is the one person we never
  // warn.
  const v = evaluate({
    isPaused: true,
    playbackMs: 1000, // nowhere near the playback threshold
    promiseAgeMs: 31000,
    promiseEtaMs: 3000
  });
  assert.strictEqual(v.status, S.UNHEALTHY);
  assert.strictEqual(v.reason, R.STALLED);
});

test("a broken promise outranks past success", () => {
  // The wedged session in the field log had already completed four windows
  // earlier in the video. Past success does not make a currently dead
  // pipeline healthy.
  const v = evaluate({ windowsCompleted: 4, promiseAgeMs: 31000, promiseEtaMs: 3000 });
  assert.strictEqual(v.status, S.UNHEALTHY);
  assert.strictEqual(v.reason, R.STALLED);
});

test("the allowance is 3x the quote, floored at 30s", () => {
  // Slow is still not broken. A machine taking three times its own estimate
  // is working; what is being caught is silence, not slowness.
  assert.strictEqual(evaluate({ promiseAgeMs: 29000, promiseEtaMs: 3000 }).status, S.OK,
    "under the 30s floor, even though 29s is way past 3x3s");
  assert.strictEqual(evaluate({ promiseAgeMs: 31000, promiseEtaMs: 3000 }).reason, R.STALLED);
  // A big quote raises the bar above the floor.
  assert.strictEqual(evaluate({ promiseAgeMs: 45000, promiseEtaMs: 20000 }).status, S.OK,
    "45s is under 3x20s");
  assert.strictEqual(evaluate({ promiseAgeMs: 61000, promiseEtaMs: 20000 }).reason, R.STALLED);
});

test("no outstanding promise means no broken-promise verdict", () => {
  // The discipline that keeps this from ever crying wolf: it can only fire
  // where we made a specific claim and did not keep it.
  assert.strictEqual(evaluate({ promiseAgeMs: null, windowsCompleted: 3 }).status, S.OK);
  assert.strictEqual(evaluate({ windowsCompleted: 3 }).status, S.OK);
  assert.strictEqual(evaluate({ promiseAgeMs: "ages", windowsCompleted: 3 }).status, S.OK);
});

test("a completed window clears the warning immediately", () => {
  // The caller retires the promise on any completion, so recovery needs no
  // separate path and no waiting for the re-evaluation throttle.
  const broken = evaluate({ promiseAgeMs: 31000, promiseEtaMs: 3000, windowsCompleted: 4 });
  const recovered = evaluate({ promiseAgeMs: null, windowsCompleted: 5, lastEvalAt: NOW });
  assert.strictEqual(broken.status, S.UNHEALTHY);
  assert.strictEqual(recovered.status, S.OK);
  assert.strictEqual(H.isTransition(broken, recovered), true);
});

test("the re-evaluation throttle never delays a broken-promise verdict", () => {
  const v = evaluate({ promiseAgeMs: 31000, promiseEtaMs: 3000, lastEvalAt: NOW });
  assert.strictEqual(v.status, S.UNHEALTHY);
  assert.strictEqual(v.due, true);
});

test("a promise with no quote at all still gets the 30s floor", () => {
  assert.strictEqual(evaluate({ promiseAgeMs: 31000, promiseEtaMs: null }).reason, R.STALLED);
  assert.strictEqual(evaluate({ promiseAgeMs: 29000, promiseEtaMs: null }).status, S.OK);
});

test("documented limits still outrank a broken promise", () => {
  // A Short or a livestream that never analyzes anything has not broken a
  // promise, it was never going to be analyzed, and the calm copy is the
  // truthful one.
  assert.strictEqual(evaluate({ isShorts: true, promiseAgeMs: 99000, promiseEtaMs: 3000 }).reason, R.SHORTS);
  assert.strictEqual(evaluate({ isLive: true, promiseAgeMs: 99000, promiseEtaMs: 3000 }).reason, R.LIVESTREAM);
  assert.strictEqual(evaluate({ unanalyzable: true, promiseAgeMs: 99000, promiseEtaMs: 3000 }).reason, R.UNANALYZABLE);
});

test("custom promise thresholds are honoured", () => {
  const v = H.evaluate(
    Object.assign(input({ promiseAgeMs: 5000, promiseEtaMs: 1000 }), {
      thresholds: { promiseFactor: 2, promiseFloorMs: 1000 }
    })
  );
  assert.strictEqual(v.reason, R.STALLED);
});

test("the stalled message names the consequence, and stays jargon-free", () => {
  const m = H.messageFor(R.STALLED);
  assert.ok(/NOT being filtered/.test(m), m);
  assert.ok(!/offscreen|worker|decode|sink|promise/i.test(m), m);
  assert.ok(H.detailFor(R.STALLED).length > 0);
});

// ---- diagnostic classification -------------------------------------------

test("classifyDiag recognizes a model load failure", () => {
  assert.strictEqual(
    H.classifyDiag("[PM-ERROR] failed to load model Xenova/whisper-base.en"),
    R.MODEL_LOAD_FAILED
  );
  assert.strictEqual(
    H.classifyDiag("model download error: net::ERR_FAILED"),
    R.MODEL_LOAD_FAILED
  );
});

test("classifyDiag recognizes a dead worker", () => {
  assert.strictEqual(H.classifyDiag("whisper worker error: terminated"), R.WORKER_DEAD);
  assert.strictEqual(H.classifyDiag("[PM-ERROR] worker crash during transcribe"), R.WORKER_DEAD);
});

test("classifyDiag leaves SURVIVABLE trouble unclassified", () => {
  // The credibility of the warning depends on this: a skipped window or a
  // stage timeout is routinely recovered from, and treating it as fatal is
  // how the alarm becomes noise.
  [
    "[PM-SKIP] window [51.85,59.60) skipped: sink.buffers hang (1/6)",
    "[PM-STAGE] window [0.00,2.50) resolving audio track for this run",
    "[PM-NO-WINDOW] no captured audio range at or ahead of currentTime=0.00 yet",
    "[PM-STALL] no coverage growth",
    "[PM-DEMUX-ERR] EBML parse hiccup",
    "[PM-FIRST-COVERAGE] 4.2s",
    "[PM-WARM] worker spawn=2ms model load=11544ms"
  ].forEach(function (line) {
    assert.strictEqual(H.classifyDiag(line), null, line);
  });
});

test("classifyDiag never throws on junk", () => {
  [null, undefined, "", 42, {}].forEach(function (v) {
    assert.strictEqual(H.classifyDiag(v), null);
  });
});

// ---- summary -------------------------------------------------------------

console.log("health_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
