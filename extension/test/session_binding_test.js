// test/session_binding_test.js
// Node unit tests for shared/session_binding.js: the rule deciding whether
// an incoming audio segment may redefine which video the tab is on.
//
// Run with: node test/session_binding_test.js   (or npm test, from extension/)
//
// This is a small function guarding a large failure. The bug it encodes
// survived two release rounds because its symptom was a status pill showing
// the wrong label: the actual effect was that the extension's per-video
// session, including the mute schedule, was being silently thrown away and
// rebuilt empty, after which nothing could write to it again. A filter that
// has stopped filtering while reporting normally is the worst outcome this
// product has, so the rule gets pinned here rather than living as four
// lines of conditional in a message handler.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMSessionBindingCore } = require(
  path.join(__dirname, "..", "shared", "session_binding.js")
);

const B = PMSessionBindingCore;

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

function act(over) {
  return B.segmentAction(
    Object.assign(
      {
        hasSession: true,
        sessionVideoId: "current",
        incomingVideoId: "current",
        staleCount: 0,
        lastStaleVideoId: null
      },
      over || {}
    )
  );
}

// ---- the ordinary paths --------------------------------------------------

test("no session yet: bind one to this segment's video", () => {
  const r = act({ hasSession: false, incomingVideoId: "first" });
  assert.strictEqual(r.action, "create");
});

test("a segment for the current video is used", () => {
  assert.strictEqual(act().action, "use");
});

// ---- the bug this exists to prevent --------------------------------------

test("a late segment for the PREVIOUS video is ignored, not adopted", () => {
  // The exact 0.1.35 field bug: one of these used to replace the live
  // session with an empty one bound to the old video, discarding coverage
  // and the mute schedule, after which results for the current video were
  // dropped by addWords' own videoId guard and could never rebuild it.
  const r = act({ incomingVideoId: "previous" });
  assert.strictEqual(r.action, "ignore");
});

test("ignoring does not disturb the session's identity", () => {
  // Nothing in the returned decision can be mistaken for "rebind": the
  // caller only creates or resets on an explicit action.
  const r = act({ incomingVideoId: "previous" });
  assert.notStrictEqual(r.action, "create");
  assert.notStrictEqual(r.action, "reset");
});

test("matching traffic clears a stale run", () => {
  // A stray segment from another video is not a persistent condition, and
  // must not accumulate across unrelated moments toward a reset.
  const r = act({ staleCount: 2, lastStaleVideoId: "previous" });
  assert.strictEqual(r.action, "use");
  assert.strictEqual(r.staleCount, 0);
  assert.strictEqual(r.staleVideoId, null);
});

// ---- the missed-reset backstop -------------------------------------------

test("a persistent unexpected video is adopted as a missed reset", () => {
  // Ignoring forever would be its own silent failure: if the authoritative
  // reset was genuinely lost, every segment after it would be dropped and
  // the tab would filter nothing for the rest of the video.
  let staleCount = 0;
  let lastStale = null;
  const seen = [];
  for (let i = 0; i < B.STALE_SEGMENT_RESET_AFTER; i++) {
    const r = act({ incomingVideoId: "actually-new", staleCount, lastStaleVideoId: lastStale });
    seen.push(r.action);
    staleCount = r.staleCount;
    lastStale = r.staleVideoId;
  }
  assert.deepStrictEqual(seen.slice(0, -1), new Array(B.STALE_SEGMENT_RESET_AFTER - 1).fill("ignore"));
  assert.strictEqual(seen[seen.length - 1], "reset");
});

test("the counter resets after adopting, so one reset is not many", () => {
  const r = act({
    incomingVideoId: "actually-new",
    staleCount: B.STALE_SEGMENT_RESET_AFTER - 1,
    lastStaleVideoId: "actually-new"
  });
  assert.strictEqual(r.action, "reset");
  assert.strictEqual(r.staleCount, 0);
  assert.strictEqual(r.staleVideoId, null);
});

test("ALTERNATING unexpected ids never accumulate toward a reset", () => {
  // Two ids arriving in alternation means confusion, not a navigation we
  // missed, and adopting either would be a coin flip on which video the
  // tab is filtering.
  let staleCount = 0;
  let lastStale = null;
  for (let i = 0; i < 10; i++) {
    const r = act({
      incomingVideoId: i % 2 === 0 ? "alpha" : "beta",
      staleCount,
      lastStaleVideoId: lastStale
    });
    assert.strictEqual(r.action, "ignore", "iteration " + i);
    assert.strictEqual(r.staleCount, 1, "count never climbs: iteration " + i);
    staleCount = r.staleCount;
    lastStale = r.staleVideoId;
  }
});

test("the run counts consecutive segments for ONE id", () => {
  const first = act({ incomingVideoId: "x", staleCount: 0, lastStaleVideoId: null });
  assert.strictEqual(first.staleCount, 1);
  const second = act({ incomingVideoId: "x", staleCount: 1, lastStaleVideoId: "x" });
  assert.strictEqual(second.staleCount, 2);
  // A different id restarts the run at one rather than inheriting it.
  const other = act({ incomingVideoId: "y", staleCount: 2, lastStaleVideoId: "x" });
  assert.strictEqual(other.staleCount, 1);
});

test("the reset threshold is configurable, and low by design", () => {
  // Low because the costs are asymmetric: being wrong this way rebuilds one
  // session, being wrong the other way leaves a filter silently off.
  const r = act({ incomingVideoId: "new", staleCount: 0, lastStaleVideoId: null, resetAfter: 1 });
  assert.strictEqual(r.action, "reset");
  assert.ok(B.STALE_SEGMENT_RESET_AFTER <= 5, "threshold should stay small");
});

// ---- robustness ----------------------------------------------------------

test("junk input never yields a session rebind", () => {
  // A malformed message must not be able to redefine the current video.
  assert.strictEqual(B.segmentAction().action, "create"); // no session claimed
  assert.strictEqual(act({ incomingVideoId: undefined }).action, "ignore");
  assert.strictEqual(act({ incomingVideoId: null }).action, "ignore");
  assert.strictEqual(act({ sessionVideoId: null, incomingVideoId: "x" }).action, "ignore");
});

test("a session with a null id still matches a null-id segment", () => {
  // Degenerate but real: a page whose id resolution failed on both sides
  // should still be one coherent session rather than a rebind loop.
  const r = act({ sessionVideoId: null, incomingVideoId: null });
  assert.strictEqual(r.action, "use");
});

// ---- summary -------------------------------------------------------------

console.log("session_binding_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
