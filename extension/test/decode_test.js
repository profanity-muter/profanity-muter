// test/decode_test.js
// Node unit tests for shared/decode.js: the decode timeout ladder and, far
// more importantly, the iterator disposal contract.
//
// Run with: node test/decode_test.js   (or npm test, from extension/)
//
// THE BUG THESE EXIST TO PREVENT. For three releases the sink.buffers()
// decode hang was treated as a mediabunny or WebCodecs defect on some
// unaudited container path, and each round wrapped another timeout around
// it. It was ours. mediabunny gives every buffers() call its own
// AudioDecoder and closes it only when the range ends or the consumer calls
// return(); its internal pump also blocks on backpressure that only the
// consumer releases. Abandoning the iteration on timeout therefore parked a
// live decoder plus a queue of unclosed AudioData, forever, and WebCodecs
// decoders are finite. Every timeout made the next decode likelier to
// stall, which timed out, which leaked another. The guard was manufacturing
// the failure it was guarding against.
//
// The fake iterator below reproduces those exact semantics, so a future
// change that stops closing the iterator fails here rather than in a user's
// six-minute video.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMDecodeCore } = require(path.join(__dirname, "..", "shared", "decode.js"));

const D = PMDecodeCore;

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      pending.push(
        r.then(
          function () { passed++; },
          function (e) {
            failed++;
            console.error("FAIL: " + name);
            console.error("      " + (e && e.message ? e.message : String(e)));
          }
        )
      );
      return;
    }
    passed++;
  } catch (e) {
    failed++;
    console.error("FAIL: " + name);
    console.error("      " + (e && e.message ? e.message : String(e)));
  }
}

// A stand-in for mediabunny's sample iterator, with the two properties that
// made the real bug possible: it holds a "decoder" resource, and it only
// releases it in return().
function fakeIterator(opts) {
  opts = opts || {};
  const state = {
    decoderOpen: true, // the resource the real one leaks
    returned: false,
    delivered: 0,
    pendingResolvers: []
  };
  const total = opts.total == null ? 3 : opts.total;
  const iterator = {
    async next() {
      if (state.returned) return { value: undefined, done: true };
      if (opts.throwOn != null && state.delivered === opts.throwOn) {
        throw new Error("decode error");
      }
      if (opts.hangAfter != null && state.delivered >= opts.hangAfter) {
        // The real pump blocks here on backpressure that only the consumer
        // releases, so nothing resolves until return() is called.
        return new Promise(function (resolve) {
          state.pendingResolvers.push(resolve);
        });
      }
      if (state.delivered >= total) return { value: undefined, done: true };
      state.delivered++;
      return { value: "chunk" + state.delivered, done: false };
    },
    async return() {
      state.returned = true;
      state.decoderOpen = false; // the teardown the leak was missing
      state.pendingResolvers.forEach(function (r) {
        r({ value: undefined, done: true });
      });
      state.pendingResolvers.length = 0;
      return { value: undefined, done: true };
    }
  };
  iterator._state = state;
  return iterator;
}

// ---- the disposal contract ----------------------------------------------

test("a HUNG decode closes its iterator, releasing the decoder", () => {
  // The whole round in one assertion. Before this, the decoder stayed open
  // forever and the next window inherited a poisoned pool.
  const it = fakeIterator({ hangAfter: 1, total: 5 });
  return D.drainWithTimeout(it, { timeoutMs: 20 }).then(function (r) {
    assert.strictEqual(r.timedOut, true);
    assert.strictEqual(it._state.returned, true, "return() must be called");
    assert.strictEqual(it._state.decoderOpen, false, "the decoder must be released");
  });
});

test("a hung decode does not hang the CALLER", () => {
  const it = fakeIterator({ hangAfter: 0, total: 5 });
  const started = Date.now();
  return D.drainWithTimeout(it, { timeoutMs: 25 }).then(function (r) {
    assert.strictEqual(r.timedOut, true);
    assert.ok(Date.now() - started < 2000, "must return promptly, not wait out the iterator");
  });
});

test("a normal decode returns its values and needs no teardown", () => {
  const it = fakeIterator({ total: 3 });
  return D.drainWithTimeout(it, { timeoutMs: 5000 }).then(function (r) {
    assert.strictEqual(r.timedOut, false);
    assert.strictEqual(r.error, null);
    assert.deepStrictEqual(r.values, ["chunk1", "chunk2", "chunk3"]);
  });
});

test("a THROWN decode error also closes the iterator", () => {
  // Closing twice is harmless; assuming the throw cleaned up is how the
  // original leak survived three releases.
  const it = fakeIterator({ throwOn: 1, total: 5 });
  return D.drainWithTimeout(it, { timeoutMs: 5000 }).then(function (r) {
    assert.ok(r.error, "the error must be reported, not swallowed");
    assert.strictEqual(r.timedOut, false, "a throw is not a hang");
    assert.strictEqual(it._state.decoderOpen, false);
  });
});

test("partial values are kept when a hang cuts a decode short", () => {
  const it = fakeIterator({ hangAfter: 2, total: 9 });
  return D.drainWithTimeout(it, { timeoutMs: 20 }).then(function (r) {
    assert.strictEqual(r.timedOut, true);
    assert.deepStrictEqual(r.values, ["chunk1", "chunk2"]);
  });
});

test("a teardown that throws never breaks the caller", () => {
  const it = {
    next: function () { return new Promise(function () {}); },
    return: function () { throw new Error("teardown exploded"); }
  };
  return D.drainWithTimeout(it, { timeoutMs: 20 }).then(function (r) {
    assert.strictEqual(r.timedOut, true, "the caller still gets its verdict");
  });
});

test("an iterator with no return() is tolerated", () => {
  const it = { next: function () { return Promise.resolve({ done: true }); } };
  return D.drainWithTimeout(it, { timeoutMs: 50 }).then(function (r) {
    assert.strictEqual(r.timedOut, false);
  });
});

test("junk input is refused rather than thrown on", () => {
  return D.drainWithTimeout(null, { timeoutMs: 10 }).then(function (r) {
    assert.ok(r.error);
    assert.strictEqual(r.timedOut, false);
  });
});

test("closeIterator always resolves, whatever the iterator does", () => {
  return Promise.all([
    D.closeIterator(null),
    D.closeIterator({}),
    D.closeIterator({ return: function () { throw new Error("no"); } }),
    D.closeIterator({ return: function () { return Promise.reject(new Error("no")); } })
  ]).then(function (results) {
    results.forEach(function (r) {
      assert.strictEqual(typeof r, "boolean");
    });
  });
});

// ---- the timeout ladder --------------------------------------------------

test("the first attempt is on a short leash, later ones are not", () => {
  // Ten seconds in front of a repair that takes milliseconds was not
  // patience, it was dead time. Post-rebuild attempts keep the generous
  // budget so a slow machine is never punished for being slow.
  assert.strictEqual(D.stageTimeoutMsFor(0), D.STAGE_TIMEOUT_FIRST_MS);
  assert.strictEqual(D.stageTimeoutMsFor(1), D.STAGE_TIMEOUT_MS);
  assert.strictEqual(D.stageTimeoutMsFor(5), D.STAGE_TIMEOUT_MS);
  assert.ok(D.STAGE_TIMEOUT_FIRST_MS <= 3000, "first attempt should be brisk");
  assert.ok(D.STAGE_TIMEOUT_MS >= 20000, "later attempts should be generous");
});

// ---- the hang ladder -----------------------------------------------------

test("the first hang rebuilds, rather than repeating the same wait", () => {
  assert.strictEqual(D.hangAction(0), "retry");
  assert.strictEqual(D.hangAction(1), "rebuild");
});

test("a hang that survives a rebuild makes the pipeline advance", () => {
  // Skipping never marks the span covered, so the audio stays unanalyzed
  // and mute/pause catch-up keeps protecting it. Only the picker moves on.
  assert.strictEqual(D.hangAction(D.HANG_SKIP_AT), "skip");
});

test("the give-up threshold still exists for a truly undecodable session", () => {
  assert.strictEqual(D.hangAction(D.HANG_THRESHOLD), "giveup");
  assert.strictEqual(D.hangAction(99), "giveup");
});

test("the ladder is ordered and reaches recovery fast", () => {
  assert.ok(D.HANG_REBUILD_AT < D.HANG_SKIP_AT);
  assert.ok(D.HANG_SKIP_AT < D.HANG_THRESHOLD);
  // Worst case before the pipeline advances past a doomed span: one short
  // attempt plus one generous one.
  const worstMs =
    D.stageTimeoutMsFor(0) + D.stageTimeoutMsFor(1) * (D.HANG_SKIP_AT - D.HANG_REBUILD_AT);
  assert.ok(worstMs <= 30000, "advance within ~30s, was ~60s: " + worstMs);
});

// ---- summary -------------------------------------------------------------

Promise.all(pending).then(function () {
  console.log("decode_test.js: " + passed + "/" + (passed + failed) + " passed");
  if (failed) process.exit(1);
});
