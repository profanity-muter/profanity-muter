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

// ---- suspend / background-throttle awareness (0.1.48) --------------------
//
// A frozen timer thread (machine sleep, hidden/throttled offscreen document)
// must not be counted as a decode hang. These drive an injected clock so the
// "freeze" is deterministic rather than wall-clock-dependent.

// A controllable fake clock + timer queue. Timers fire in due order only
// when we advance the clock, so a test can simulate a long freeze by jumping
// the clock forward in one step (exactly what a suspend looks like: the timer
// that was due long ago runs, and now() has leapt).
function fakeClock() {
  const c = { t: 0, timers: [], seq: 1 };
  c.now = function () { return c.t; };
  c.setTimer = function (fn, ms) {
    const id = c.seq++;
    c.timers.push({ id: id, due: c.t + (ms || 0), fn: fn });
    return id;
  };
  c.clearTimer = function (id) {
    c.timers = c.timers.filter(function (x) { return x.id !== id; });
  };
  // Advance real awake time in small steps so ticks fire on schedule.
  c.advance = function (ms) {
    const target = c.t + ms;
    for (;;) {
      const due = c.timers.filter(function (x) { return x.due <= target; }).sort(function (a, b) { return a.due - b.due; });
      if (due.length === 0) break;
      const next = due[0];
      c.timers = c.timers.filter(function (x) { return x.id !== next.id; });
      c.t = next.due;
      next.fn();
    }
    c.t = target;
  };
  // Jump the clock WITHOUT running intermediate ticks - a freeze. The next
  // scheduled tick then runs with now() already leapt far past its due time.
  c.freezeJump = function (ms) {
    c.t += ms;
    const due = c.timers.filter(function (x) { return x.due <= c.t; }).sort(function (a, b) { return a.due - b.due; });
    for (const timer of due) {
      c.timers = c.timers.filter(function (x) { return x.id !== timer.id; });
      timer.fn();
    }
  };
  return c;
}

test("a long freeze is credited back, not counted as a hang", () => {
  // The iterator never yields (a genuine wedge would look identical), but the
  // ONLY elapsed time is a 1-hour freeze. Awake time spent is ~0, so this
  // must NOT be reported as a timeout: it is a suspend, and the report says
  // so via suspendedMs.
  const clock = fakeClock();
  const it = fakeIterator({ hangAfter: 0, total: 5 });
  const p = D.drainWithTimeout(it, {
    timeoutMs: 25000, noProgressMs: 2000, tickMs: 1000,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  });
  // One tick's worth of awake time, then a huge freeze, then a little more
  // awake time - nowhere near 2s of CONTIGUOUS awake time without progress.
  clock.advance(1000);
  clock.freezeJump(3600 * 1000);
  clock.advance(500);
  // Let the wedge actually time out on awake time to prove the budget still
  // works AFTER a freeze (it was only credited the frozen portion).
  clock.advance(2000);
  return p.then(function (r) {
    assert.strictEqual(r.timedOut, true, "a real wedge still times out eventually");
    assert.ok(r.suspendedMs >= 3500 * 1000, "the frozen hour must be credited back: " + r.suspendedMs);
    assert.strictEqual(it._state.decoderOpen, false, "and the decoder is still released");
  });
});

test("a wedge with no freeze trips the fast no-progress budget", () => {
  // No suspend at all: 2s of awake time with zero buffers delivered is a
  // stuck decoder and must be caught fast, well before the 25s ceiling.
  const clock = fakeClock();
  const it = fakeIterator({ hangAfter: 0, total: 5 });
  const p = D.drainWithTimeout(it, {
    timeoutMs: 25000, noProgressMs: 2000, tickMs: 1000,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  });
  clock.advance(2500);
  return p.then(function (r) {
    assert.strictEqual(r.timedOut, true);
    assert.strictEqual(r.suspendedMs, 0, "no freeze happened, nothing to credit");
  });
});

test("a decode that keeps delivering buffers is never killed by the no-progress budget", () => {
  // Yields one buffer every ~1.5s for well past the 2s no-progress budget and
  // past the 25s ceiling would-be point IF it were counted from the start -
  // but progress resets the no-progress deadline each time, so it completes.
  const clock = fakeClock();
  let delivered = 0;
  const it = {
    async next() {
      if (delivered >= 30) return { value: undefined, done: true };
      delivered++;
      return { value: "chunk" + delivered, done: false };
    },
    async return() { return { value: undefined, done: true }; }
  };
  const p = D.drainWithTimeout(it, {
    timeoutMs: 60000, noProgressMs: 2000, tickMs: 1000,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer
  });
  // The async next() resolves on microtasks; advance a little to let ticks
  // interleave. 30 buffers resolve well within the microtask queue here since
  // the fake next() is synchronous-ish, so a small advance settles it.
  clock.advance(100);
  return p.then(function (r) {
    assert.strictEqual(r.timedOut, false, "steady progress must not time out");
    assert.strictEqual(r.values.length, 30);
  });
});

// ---- fail-safe accounting: playheadPassed --------------------------------

test("a span the playhead has NOT reached is never safe to abandon", () => {
  // Playhead at 71.59, window ends at 119.60: ~48s of lead remains. Giving up
  // here is the core defect - the window still had time to be covered.
  assert.strictEqual(D.playheadPassed(119.60, 71.59), false);
});

test("a span the playhead has moved past is safe to abandon", () => {
  assert.strictEqual(D.playheadPassed(119.60, 130.0), true);
});

test("with no playhead known, the old unconditional behavior is preserved", () => {
  assert.strictEqual(D.playheadPassed(119.60, null), true);
  assert.strictEqual(D.playheadPassed(119.60, undefined), true);
});

// ---- summary -------------------------------------------------------------

Promise.all(pending).then(function () {
  console.log("decode_test.js: " + passed + "/" + (passed + failed) + " passed");
  if (failed) process.exit(1);
});
