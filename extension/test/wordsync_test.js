// test/wordsync_test.js
// Node unit tests for shared/wordsync.js: re-applying the word list to
// audio that is already analyzed, with no new audio work and no idle cost.
// Run with: node test/wordsync_test.js (or npm test).
"use strict";

const assert = require("assert");
const path = require("path");
const { PMWordSyncCore: W } = require(path.join(__dirname, "..", "shared", "wordsync.js"));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + name + "\n      " + e.message); }
}

// Fake clock: records every live timer so "no timers when idle" is checkable.
function clock() {
  let now = 0, id = 0;
  const live = new Map();
  return {
    setTimeout(fn, ms) { id++; live.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(h) { live.delete(h); },
    advance(ms) {
      now += ms;
      for (const [h, t] of [...live]) if (t.at <= now) { live.delete(h); t.fn(); }
    },
    liveCount() { return live.size; }
  };
}

function harness() {
  const c = clock();
  const log = { refresh: 0, post: 0, order: [] };
  let refreshDone = null;
  const s = W.createScheduler({
    delayMs: 500,
    setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
    refresh() { log.refresh++; log.order.push("refresh"); return new Promise((r) => { refreshDone = r; }); },
    post() { log.post++; log.order.push("post"); }
  });
  return { c, log, s, finishRefresh: () => refreshDone() };
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  await test("idle: constructing and unrelated changes create no timers and no requests", () => {
    const h = harness();
    assert.strictEqual(h.c.liveCount(), 0);
    h.s.notify({ pm_showStatus: { newValue: false } }, "sync");
    h.s.notify({ pm_wordlist: { newValue: "x" } }, "local");
    h.s.notify({ pm_additionalWords: { newValue: ["a"] } }, "local"); // wrong area
    h.c.advance(5000);
    assert.strictEqual(h.c.liveCount(), 0);
    assert.strictEqual(h.log.refresh + h.log.post, 0);
  });

  await test("an edit waits for the list refresh, then posts exactly one resync", async () => {
    const h = harness();
    h.s.notify({ pm_additionalWords: { newValue: ["x"] } }, "sync");
    assert.strictEqual(h.c.liveCount(), 1);
    h.c.advance(499);
    assert.strictEqual(h.log.refresh, 0);
    h.c.advance(1);
    assert.strictEqual(h.log.refresh, 1);
    assert.strictEqual(h.log.post, 0, "must not post before the refresh resolves");
    h.finishRefresh();
    await tick();
    assert.deepStrictEqual(h.log.order, ["refresh", "post"]);
    assert.strictEqual(h.c.liveCount(), 0, "no timer left behind");
  });

  await test("strictness and allow-list changes also count", async () => {
    for (const k of ["pm_strictness", "pm_allowWords"]) {
      const h = harness();
      const ch = {}; ch[k] = { newValue: 1 };
      h.s.notify(ch, "sync");
      h.c.advance(500); h.finishRefresh(); await tick();
      assert.strictEqual(h.log.post, 1, k);
    }
  });

  await test("a burst of edits collapses to one resync", async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) { h.s.notify({ pm_additionalWords: { newValue: [i] } }, "sync"); h.c.advance(200); }
    h.c.advance(500);
    h.finishRefresh(); await tick();
    assert.strictEqual(h.log.refresh, 1);
    assert.strictEqual(h.log.post, 1);
  });

  await test("an edit after the first resync fired starts a fresh one", async () => {
    const h = harness();
    h.s.notify({ pm_additionalWords: { newValue: [1] } }, "sync");
    h.c.advance(500); h.finishRefresh(); await tick();
    h.s.notify({ pm_additionalWords: { newValue: [] } }, "sync");
    h.c.advance(500); h.finishRefresh(); await tick();
    assert.strictEqual(h.log.post, 2);
  });

  const words = [
    { word: "hello", start: 1, end: 1.4 },
    { word: "frick", start: 5, end: 5.4 },
    { word: "darn", start: 9, end: 9.4 }
  ];
  const apply = (blocked) => (ws) => ({
    intervals: ws.filter((w) => blocked.has(w.word)).map((w) => ({ start: w.start - 0.35, end: w.end + 0.25, word: w.word }))
  });
  const keyOf = (iv) => iv.start.toFixed(2) + "," + iv.end.toFixed(2) + "," + iv.word;

  await test("adding a word that is already in the analyzed transcript creates its interval", () => {
    const before = W.rebuild({ oldIntervals: [], words, applyWords: apply(new Set(["darn"])), playhead: 0, activeKey: null, keyOf });
    assert.deepStrictEqual(before.intervals.map((i) => i.word), ["darn"]);
    const after = W.rebuild({ oldIntervals: before.intervals, words, applyWords: apply(new Set(["darn", "frick"])), playhead: 0, activeKey: null, keyOf });
    assert.deepStrictEqual(after.intervals.map((i) => i.word), ["frick", "darn"]);
  });

  await test("removing a word drops its interval", () => {
    const before = W.rebuild({ oldIntervals: [], words, applyWords: apply(new Set(["darn", "frick"])), playhead: 0, activeKey: null, keyOf });
    const after = W.rebuild({ oldIntervals: before.intervals, words, applyWords: apply(new Set(["darn"])), playhead: 0, activeKey: null, keyOf });
    assert.deepStrictEqual(after.intervals.map((i) => i.word), ["darn"]);
  });

  await test("intervals older than the retained transcript survive a resync", () => {
    const old = [{ start: 0.1, end: 0.5, word: "ancient" }];
    const trimmed = words.map((w) => Object.assign({}, w, { start: w.start + 100, end: w.end + 100 }));
    const r = W.rebuild({ oldIntervals: old, words: trimmed, applyWords: apply(new Set(["darn"])), playhead: 0, activeKey: null, keyOf });
    assert.deepStrictEqual(r.intervals.map((i) => i.word), ["ancient", "darn"]);
  });

  await test("an empty transcript keeps what we have", () => {
    const old = [{ start: 1, end: 2, word: "x" }];
    const r = W.rebuild({ oldIntervals: old, words: [], applyWords: apply(new Set()), playhead: 0, activeKey: null, keyOf });
    assert.strictEqual(r.intervals.length, 1);
  });

  await test("playhead inside a mute: the rebuilt interval inherits the count key, so it is not counted twice", () => {
    const base = W.rebuild({ oldIntervals: [], words, applyWords: apply(new Set(["frick"])), playhead: 0, activeKey: null, keyOf });
    const key = keyOf(base.intervals[0]);
    // User adds another word; frick's interval is unchanged, playhead at 5.1.
    const r = W.rebuild({ oldIntervals: base.intervals, words, applyWords: apply(new Set(["frick", "darn"])), playhead: 5.1, activeKey: key, keyOf });
    assert.strictEqual(r.activeKey, keyOf(r.intervals.find((i) => i.word === "frick")));
  });

  await test("count key moves with a changed interval and clears when the interval is gone", () => {
    const base = W.rebuild({ oldIntervals: [], words, applyWords: apply(new Set(["frick"])), playhead: 0, activeKey: null, keyOf });
    const key = keyOf(base.intervals[0]);
    const gone = W.rebuild({ oldIntervals: base.intervals, words, applyWords: apply(new Set()), playhead: 5.1, activeKey: key, keyOf });
    assert.strictEqual(gone.activeKey, null);
    const none = W.rebuild({ oldIntervals: base.intervals, words, applyWords: apply(new Set(["frick"])), playhead: 20, activeKey: null, keyOf });
    assert.strictEqual(none.activeKey, null);
  });

  console.log("wordsync_test.js: " + passed + "/" + (passed + failed) + " passed");
  if (failed > 0) process.exit(1);
})();
