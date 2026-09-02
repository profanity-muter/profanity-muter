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
  // Recovery has to be instant: a stale warning is exactly as dishonest as
  // a missing one.
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
  assert.ok(/NOT being filtered/.test(v.message), v.message);
  assert.ok(v.detail.length > 0);
});

test("audio arrived but nothing was analyzed", () => {
  const v = evaluate({ windowsCompleted: 0, audioSegments: 25 });
  assert.strictEqual(v.reason, R.ZERO_WINDOWS);
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
  assert.ok(/Livestreams aren't supported/.test(v.message), v.message);
  assert.ok(!/isn't working/.test(v.message), "must not use the alarming copy");
});

test("a livestream is judged immediately, without waiting out the clock", () => {
  const v = evaluate({ isLive: true, playbackMs: 0, windowsCompleted: 0, audioSegments: 0 });
  assert.strictEqual(v.status, S.UNSUPPORTED);
  assert.strictEqual(v.due, true);
});

test("a livestream that somehow analyzed windows is still reported as unsupported", () => {
  // Best-effort transcription against a DVR buffer does happen; the
  // guarantee still does not hold, so the honest label wins.
  const v = evaluate({ isLive: true, windowsCompleted: 5 });
  assert.strictEqual(v.reason, R.LIVESTREAM);
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
