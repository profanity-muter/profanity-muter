// test/pace_test.js
// Node unit tests for shared/pace.js: window-start resolution (the 0.1.58
// stuck-chunk fix), the repeat-span guard, the realtime-factor state machine
// (transient "busy" + back-off), the chronic per-video verdict, auto-pause
// gating and the worker thread cap.
//
// Run with: node test/pace_test.js   (or npm test, from extension/)
"use strict";

const assert = require("assert");
const path = require("path");
const { PMPaceCore: P } = require(path.join(__dirname, "..", "shared", "pace.js"));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) {
    failed++;
    console.error("FAIL: " + name);
    console.error("      " + (e && e.message ? e.message : String(e)));
  }
}

// ---- Task 1: the stuck-chunk loop -----------------------------------------
//
// Field log 0.1.57: playhead stuck at 2814.0 (pause catch-up), window
// [2813,2815.5) completes, then [2813,2819.67) is picked and completes, then
// the SAME [2813,2819.67) four more times. Cause: lowBound = playhead - 2s =
// 2812 is a hole behind the playhead that no window can ever fill (the cold
// start floor is playhead - 1s = 2813), so firstUncoveredPoint kept returning
// 2812, the cold floor then bumped it to 2813 which is already covered, and
// the window was re-decoded forever. resolveWindowStart must re-resolve
// AFTER the cold floor.

function mergeInto(list, a, b) {
  list.push({ start: a, end: b });
  list.sort((x, y) => x.start - y.start);
  const out = [];
  for (const c of list) {
    const l = out[out.length - 1];
    if (l && c.start <= l.end + 0.05) l.end = Math.max(l.end, c.end);
    else out.push({ start: c.start, end: c.end });
  }
  list.length = 0;
  list.push(...out);
}

// Mirrors pickNextWindow's use of the helper for a stuck playhead.
function pick(covered, ct, bufEnd, hadFirst) {
  const rangeStart = 2790, rangeEnd = bufEnd;
  const lowBound = Math.max(rangeStart, ct - 2);
  const high = rangeEnd - 0.4;
  return P.resolveWindowStart({
    coverageView: covered, covered, lowBound, high, rangeStart, rangeEnd, ct,
    hadFirstWindow: hadFirst, adjacencyS: 3, coldBehindS: 1, eps: 0.05
  });
}

test("stuck playhead: a completed cold window is never re-picked at the same start", () => {
  const covered = [];
  const seen = new Set();
  const ct = 2814.0; // never advances
  const bufEnd = 2820.07;
  let hadFirst = false;
  for (let i = 0; i < 6; i++) {
    const r = pick(covered, ct, bufEnd, hadFirst);
    if (r.reason) break; // nothing left to do: the loop terminated
    const end = Math.min(r.start + 6.67, bufEnd - 0.4);
    const key = r.start.toFixed(2) + "," + end.toFixed(2);
    assert.ok(!seen.has(key), "span " + key + " scheduled twice");
    seen.add(key);
    mergeInto(covered, r.start, end);
    hadFirst = true;
  }
  assert.ok(seen.size >= 1 && seen.size <= 2, "expected 1-2 distinct windows, got " + seen.size);
});

test("the field case: covered [2813,2815.5), stuck at 2814, advances past coverage", () => {
  const covered = [{ start: 2813, end: 2815.5 }];
  const r = pick(covered, 2814.0, 2820.07, true);
  assert.ok(!r.reason, "should still have work: " + r.reason);
  assert.ok(r.start >= 2815.5 - 0.06, "start " + r.start + " re-covers already covered audio");
});

test("fully covered up to the buffer: reports fully-covered rather than a covered span", () => {
  const covered = [{ start: 2813, end: 2819.67 }];
  const r = pick(covered, 2814.0, 2820.07, true);
  assert.strictEqual(r.reason, "fully-covered");
});

test("normal playback is unchanged: playhead ahead of coverage picks the uncovered point", () => {
  const covered = [{ start: 2790, end: 2800 }];
  const r = pick(covered, 2800.5, 2830, true);
  assert.ok(Math.abs(r.start - 2800) < 1e-9 || r.start >= 2800, "start " + r.start);
  assert.ok(r.start <= 2800.5);
});

test("repeat-span guard keys on the span and rounds to centiseconds", () => {
  const set = new Set();
  assert.strictEqual(P.isRepeatSpan(set, 2813, 2819.67), false);
  P.noteCompletedSpan(set, 2813, 2819.67);
  assert.strictEqual(P.isRepeatSpan(set, 2813.001, 2819.669), true);
  assert.strictEqual(P.isRepeatSpan(set, 2815.5, 2822), false);
});

test("completed-span memory is bounded", () => {
  const set = new Set();
  for (let i = 0; i < 500; i++) P.noteCompletedSpan(set, i, i + 5);
  assert.ok(set.size <= P.COMPLETED_SPANS_CAP);
  assert.strictEqual(P.isRepeatSpan(set, 499, 504), true);
});

// ---- Task 2: RTF state machine ------------------------------------------------

function win(rtf, audioS) { return { rtf, audioS: audioS == null ? 6 : audioS, cold: false }; }

test("3 consecutive slow windows enter busy; 2 do not", () => {
  const p = P.createPace();
  assert.strictEqual(p.onWindow(win(2.5), 1000).changed, false);
  assert.strictEqual(p.onWindow(win(2.5), 2000).changed, false);
  assert.strictEqual(p.state(), "ok");
  const r = p.onWindow(win(2.5), 3000);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.to, "busy");
  assert.strictEqual(p.state(), "busy");
});

test("a fast window in between resets the slow streak", () => {
  const p = P.createPace();
  p.onWindow(win(2), 1); p.onWindow(win(2), 2); p.onWindow(win(0.3), 3); p.onWindow(win(2), 4);
  assert.strictEqual(p.state(), "ok");
});

test("cold windows and tiny tail windows are ignored", () => {
  const p = P.createPace();
  for (let i = 0; i < 5; i++) p.onWindow({ rtf: 5, audioS: 6, cold: true }, i);
  for (let i = 0; i < 5; i++) p.onWindow({ rtf: 5, audioS: 1.2, cold: false }, i);
  assert.strictEqual(p.state(), "ok");
});

test("busy exits only below 0.8 (hysteresis): 0.9 stays busy, 0.7 recovers", () => {
  const p = P.createPace();
  for (let i = 0; i < 3; i++) p.onWindow(win(2), i);
  assert.strictEqual(p.state(), "busy");
  assert.strictEqual(p.onWindow(win(0.9), 100).changed, false);
  assert.strictEqual(p.state(), "busy");
  const r = p.onWindow(win(0.7), 200);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.to, "ok");
});

test("exit can require several windows when configured", () => {
  const p = P.createPace({ exitN: 3 });
  for (let i = 0; i < 3; i++) p.onWindow(win(2), i);
  p.onWindow(win(0.5), 10); p.onWindow(win(0.5), 11);
  assert.strictEqual(p.state(), "busy");
  p.onWindow(win(0.5), 12);
  assert.strictEqual(p.state(), "ok");
});

test("back-off: while busy, no window is allowed except one probe per 60s", () => {
  const p = P.createPace();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) p.onWindow(win(2), t0);
  let allowed = 0;
  for (let t = t0; t < t0 + 59_000; t += 1000) if (p.allowWindow(t)) allowed++;
  assert.strictEqual(allowed, 0, "no probe before 60s");
  assert.strictEqual(p.allowWindow(t0 + 60_000), true, "first probe at 60s");
  assert.strictEqual(p.allowWindow(t0 + 60_500), false, "only one probe per 60s");
  assert.strictEqual(p.allowWindow(t0 + 120_000), true, "next probe at 120s");
});

test("back-off: normal state always allows windows", () => {
  const p = P.createPace();
  for (let t = 0; t < 10; t++) assert.strictEqual(p.allowWindow(t), true);
});

test("video summary: median RTF and behind fraction weighted by audio seconds", () => {
  const p = P.createPace();
  p.onWindow(win(2, 6), 1); p.onWindow(win(0.5, 6), 2); p.onWindow(win(3, 12), 3);
  const v = p.video();
  assert.strictEqual(v.analyzedS, 24);
  assert.ok(Math.abs(v.behindFrac - 18 / 24) < 1e-9);
  assert.strictEqual(v.medianRtf, 2);
});

// ---- chronic verdict ------------------------------------------------------------

function vid(id, chronic, analyzedS) {
  return { id, t: 1, analyzedS: analyzedS == null ? 120 : analyzedS, medianRtf: chronic ? 2 : 0.2, behindFrac: chronic ? 0.9 : 0, chronic };
}

test("chronic needs 3 of the last 5 qualifying videos", () => {
  let h = [];
  h = P.upsertHistory(h, vid("a", true));
  h = P.upsertHistory(h, vid("b", true));
  assert.strictEqual(P.chronicVerdict(h).tripped, false, "2 videos is below the minimum");
  h = P.upsertHistory(h, vid("c", false));
  assert.strictEqual(P.chronicVerdict(h).tripped, false, "2 of 3");
  h = P.upsertHistory(h, vid("d", true));
  assert.strictEqual(P.chronicVerdict(h).tripped, true, "3 of 4");
});

test("videos under 60s of analysis do not count", () => {
  let h = [];
  for (const id of ["a", "b", "c", "d"]) h = P.upsertHistory(h, vid(id, true, 30));
  assert.strictEqual(P.chronicVerdict(h).tripped, false);
  h = P.upsertHistory(h, vid("e", true, 61));
  h = P.upsertHistory(h, vid("f", true, 61));
  assert.strictEqual(P.chronicVerdict(h).tripped, false, "only 2 qualifying");
  h = P.upsertHistory(h, vid("g", true, 61));
  assert.strictEqual(P.chronicVerdict(h).tripped, true);
});

test("only the last 5 qualifying videos are considered", () => {
  let h = [];
  for (const id of ["a", "b", "c"]) h = P.upsertHistory(h, vid(id, true));
  for (const id of ["d", "e", "f", "g", "h"]) h = P.upsertHistory(h, vid(id, false));
  assert.strictEqual(P.chronicVerdict(h).tripped, false);
});

test("history upserts by video id and keeps the last 10", () => {
  let h = [];
  h = P.upsertHistory(h, vid("a", false));
  h = P.upsertHistory(h, vid("a", true));
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].chronic, true);
  for (let i = 0; i < 15; i++) h = P.upsertHistory(h, vid("v" + i, false));
  assert.strictEqual(h.length, P.HISTORY_CAP);
  assert.strictEqual(h[h.length - 1].id, "v14");
});

test("videoEntry marks chronic when most analyzed time was behind realtime", () => {
  const e = P.videoEntry("x", { analyzedS: 100, behindFrac: 0.6, medianRtf: 1.4 }, 5);
  assert.strictEqual(e.chronic, true);
  assert.strictEqual(P.videoEntry("x", { analyzedS: 100, behindFrac: 0.4, medianRtf: 0.9 }, 5).chronic, false);
});

// ---- auto-pause gating + Try again --------------------------------------------

test("audio is allowed unless the auto-pause flag is set", () => {
  assert.strictEqual(P.audioAllowed({}), true);
  assert.strictEqual(P.audioAllowed(null), true);
  assert.strictEqual(P.audioAllowed({ pm_autoPausedSlow: { at: 1 } }), false);
});

test("tripping builds a flag with evidence; Try again clears flag and history", () => {
  let h = [];
  for (const id of ["a", "b", "c"]) h = P.upsertHistory(h, vid(id, true));
  const flag = P.makeAutoPauseFlag(P.chronicVerdict(h), 1234);
  assert.strictEqual(flag.at, 1234);
  assert.strictEqual(flag.chronicCount, 3);
  const patch = P.tryAgainPatch();
  assert.deepStrictEqual(patch.remove.sort(), ["pm_autoPausedSlow", "pm_paceHistory"]);
});

test("notice model: only shown while auto-paused, with Try again and Remove extension", () => {
  assert.strictEqual(P.noticeModel(null), null);
  const m = P.noticeModel({ at: 1 });
  assert.deepStrictEqual(m.buttons, ["Try again", "Remove extension"]);
  assert.ok(/captions are still censored/i.test(m.body));
  assert.ok(/processing power/i.test(m.body));
});

// ---- thread cap ------------------------------------------------------------------

test("thread cap is half the cores, at least 1, never above the current value", () => {
  assert.strictEqual(P.threadCap(8, 4), 4);
  assert.strictEqual(P.threadCap(8, 1), 1);
  assert.strictEqual(P.threadCap(2, 4), 1);
  assert.strictEqual(P.threadCap(1, 4), 1);
  assert.strictEqual(P.threadCap(undefined, 4), 1, "unknown core count is treated as 1 core... ");
  assert.strictEqual(P.threadCap(16, undefined), 8);
});

// ---- copy rules ----------------------------------------------------------------------

test("copy has no em-dashes, banned words or absolute claims", () => {
  const all = JSON.stringify(P.COPY);
  assert.ok(!new RegExp("[\\u2013\\u2014]").test(all));
  assert.ok(!new RegExp(["hon" + "est", "truth" + "ful", "gen" + "uine"].join("|"), "i").test(all));
  assert.ok(!/100%|guarantee/i.test(all));
  assert.strictEqual(P.COPY.pill, "Your computer is busy, so muting is falling behind. Closing other apps or tabs helps.");
});

console.log("pace_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
