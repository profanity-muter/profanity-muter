// test/stats_test.js
// Node unit tests for shared/stats.js's pure core (0.1.51): the bounded,
// local-only Activity store behind the popup's dashboard. Covers range
// summaries (24h / 7d / all-time), per-category + per-word attribution, and
// the bounds that keep it from growing without limit.
//
// Run with: node test/stats_test.js   (or npm test, from extension/)

"use strict";

const assert = require("assert");
const path = require("path");
const { PMStatsCore } = require(path.join(__dirname, "..", "shared", "stats.js"));

const {
  emptyStore, recordMute, summarize, normalizeStore, dayKey,
  MAX_DAYS, MAX_WORDS_ALLTIME, MAX_WORDS_PER_DAY, CATEGORIES
} = PMStatsCore;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error("FAIL: " + name); console.error("      " + (e && e.message ? e.message : String(e))); }
}

const NOW = Date.parse("2026-09-04T12:00:00");
const DAY = 24 * 60 * 60 * 1000;

function rec(store, over) {
  return recordMute(store, Object.assign({ category: "profanity", word: "fuck", isNewVideo: false, now: NOW }, over));
}

test("empty store summarizes to zeros", () => {
  const s = summarize(emptyStore(), "all", NOW);
  assert.strictEqual(s.muted, 0);
  assert.strictEqual(s.videos, 0);
  assert.deepStrictEqual(s.top, []);
  CATEGORIES.forEach((c) => assert.strictEqual(s.cats[c], 0));
});

test("a mute increments muted, category, and word", () => {
  let store = rec(emptyStore(), { category: "religious", word: "hell", isNewVideo: true });
  const s = summarize(store, "all", NOW);
  assert.strictEqual(s.muted, 1);
  assert.strictEqual(s.videos, 1);
  assert.strictEqual(s.cats.religious, 1);
  assert.deepStrictEqual(s.top, [{ word: "hell", count: 1 }]);
});

test("isNewVideo counts videos only when true", () => {
  let store = emptyStore();
  store = rec(store, { isNewVideo: true });
  store = rec(store, { isNewVideo: false });
  store = rec(store, { isNewVideo: false });
  const s = summarize(store, "all", NOW);
  assert.strictEqual(s.muted, 3);
  assert.strictEqual(s.videos, 1);
});

test("range windows: 24h vs 7d vs all-time", () => {
  let store = emptyStore();
  store = rec(store, { now: NOW });                 // today
  store = rec(store, { now: NOW - 3 * DAY });        // 3 days ago
  store = rec(store, { now: NOW - 8 * DAY, category: "slur", word: "x", isNewVideo: true }); // 8 days ago
  assert.strictEqual(summarize(store, "24h", NOW).muted, 1);
  assert.strictEqual(summarize(store, "7d", NOW).muted, 2);
  assert.strictEqual(summarize(store, "all", NOW).muted, 3);
  // the 8-day-old slur only shows up in all-time
  assert.strictEqual(summarize(store, "7d", NOW).cats.slur, 0);
  assert.strictEqual(summarize(store, "all", NOW).cats.slur, 1);
});

test("most-muted is sorted by count desc, ties alphabetical", () => {
  let store = emptyStore();
  for (let i = 0; i < 5; i++) store = rec(store, { word: "aaa" });
  for (let i = 0; i < 5; i++) store = rec(store, { word: "bbb" });
  for (let i = 0; i < 9; i++) store = rec(store, { word: "ccc" });
  const top = summarize(store, "all", NOW).top;
  assert.strictEqual(top[0].word, "ccc");
  assert.strictEqual(top[1].word, "aaa"); // tie 5/5, alphabetical
  assert.strictEqual(top[2].word, "bbb");
});

test("day buckets are bounded to MAX_DAYS", () => {
  let store = emptyStore();
  for (let d = 0; d < MAX_DAYS + 20; d++) {
    store = rec(store, { now: NOW - d * DAY });
  }
  assert.ok(Object.keys(store.days).length <= MAX_DAYS, Object.keys(store.days).length);
  // all-time still counts every mute even after old day buckets are dropped
  assert.strictEqual(summarize(store, "all", NOW).muted, MAX_DAYS + 20);
});

test("all-time word map is bounded", () => {
  let store = emptyStore();
  for (let i = 0; i < MAX_WORDS_ALLTIME + 200; i++) {
    store = rec(store, { word: "w" + i });
  }
  assert.ok(Object.keys(store.allTime.words).length <= MAX_WORDS_ALLTIME + 20,
    Object.keys(store.allTime.words).length);
});

test("per-day word map is bounded", () => {
  let store = emptyStore();
  for (let i = 0; i < MAX_WORDS_PER_DAY + 200; i++) {
    store = rec(store, { word: "w" + i, now: NOW });
  }
  const dk = dayKey(NOW);
  assert.ok(Object.keys(store.days[dk].words).length <= MAX_WORDS_PER_DAY + 20,
    Object.keys(store.days[dk].words).length);
});

test("normalizeStore repairs a corrupted value into an empty store", () => {
  assert.deepStrictEqual(normalizeStore(null), emptyStore());
  assert.deepStrictEqual(normalizeStore("garbage"), emptyStore());
  assert.deepStrictEqual(normalizeStore({ days: 42, allTime: "x" }), emptyStore());
});

test("unknown category folds into profanity, never a new bucket", () => {
  let store = rec(emptyStore(), { category: "not-a-real-cat" });
  const s = summarize(store, "all", NOW);
  assert.strictEqual(s.cats.profanity, 1);
  assert.deepStrictEqual(Object.keys(s.cats).sort(), CATEGORIES.slice().sort());
});

console.log("stats_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
