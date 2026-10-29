// test/lifecycle_test.js - shared/lifecycle.js: idle teardown decision,
// session eviction, watch-page gating, diag rate limit.
"use strict";
const assert = require("assert");
const path = require("path");
const L = require(path.join(__dirname, "..", "shared", "lifecycle.js")).PMLifecycle;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + name + "\n      " + e.message); }
}
const MIN = 60 * 1000;
const T0 = 1_800_000_000_000;

test("only real watch ids open sessions", () => {
  assert.strictEqual(L.isSessionVideoId("dQw4w9WgXcQ"), true);
  assert.strictEqual(L.isSessionVideoId("/@buildwitt"), false);
  assert.strictEqual(L.isSessionVideoId("/"), false);
  assert.strictEqual(L.isSessionVideoId("/shorts/abc"), false);
  assert.strictEqual(L.isSessionVideoId(null), false);
  assert.strictEqual(L.isSessionVideoId(""), false);
});

test("idle clock starts when nothing plays, no teardown before the limit", () => {
  let r = L.idleStep({ playing: { 1: false }, idleSince: null }, T0);
  assert.deepStrictEqual(r, { idleSince: T0, teardown: false });
  r = L.idleStep({ playing: { 1: false }, idleSince: T0 }, T0 + 9 * MIN);
  assert.strictEqual(r.teardown, false);
});

test("teardown fires at 10 minutes of nothing playing", () => {
  const r = L.idleStep({ playing: { 1: false, 2: false }, idleSince: T0 }, T0 + 10 * MIN);
  assert.strictEqual(r.teardown, true);
});

test("any playing tab clears the idle clock", () => {
  const r = L.idleStep({ playing: { 1: false, 2: true }, idleSince: T0 }, T0 + 60 * MIN);
  assert.deepStrictEqual(r, { idleSince: null, teardown: false });
});

test("no tabs at all counts as idle", () => {
  assert.strictEqual(L.idleStep({ playing: {}, idleSince: T0 }, T0 + 11 * MIN).teardown, true);
});

test("the limit is configurable", () => {
  assert.strictEqual(L.idleStep({ playing: {}, idleSince: T0 }, T0 + 2 * MIN, MIN).teardown, true);
});

const S = (key, ageMin, o) => Object.assign({ key, lastTouchWall: T0 - ageMin * MIN, serving: false, processing: false }, o);

test("sessions idle 10+ minutes are evicted, fresh ones kept", () => {
  const ev = L.selectEvictions([S("1:a", 11, { serving: true }), S("2:b", 1), S("3:c", 2, { serving: true })], T0);
  assert.deepStrictEqual(ev, ["1:a"]);
});

test("cap keeps the 2 newest inactive sessions, never touches serving ones", () => {
  const ev = L.selectEvictions(
    [S("1:a", 1), S("2:b", 2), S("3:c", 3), S("4:d", 4), S("9:z", 5, { serving: true })],
    T0
  );
  assert.deepStrictEqual(ev.sort(), ["3:c", "4:d"]);
});

test("a session mid-transcription is never evicted", () => {
  assert.deepStrictEqual(L.selectEvictions([S("1:a", 60, { processing: true })], T0), []);
});

test("diag gate: first logs, same reason silent for 10 min, then once more", () => {
  const st = {};
  assert.strictEqual(L.diagGate(st, "fully-covered", T0), true);
  assert.strictEqual(L.diagGate(st, "fully-covered", T0 + 60 * 1000), false);
  assert.strictEqual(L.diagGate(st, "fully-covered", T0 + 9 * MIN), false);
  assert.strictEqual(L.diagGate(st, "fully-covered", T0 + 10 * MIN), true);
});

test("diag gate: a changed reason logs, but flapping is still throttled", () => {
  const st = {};
  assert.strictEqual(L.diagGate(st, "a", T0), true);
  assert.strictEqual(L.diagGate(st, "b", T0 + 1000), true);
  assert.strictEqual(L.diagGate(st, "a", T0 + 2000), false); // "a" logged 2s ago
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
