// test/runs_test.js
// Node unit tests for shared/runs.js: which demux run serves which region,
// and what to do when a seek storm reshapes the answer faster than the
// pipeline can follow.
//
// Run with: node test/runs_test.js   (or npm test, from extension/)
//
// TWO OUTAGES ARE ENCODED HERE, AND THE FIX FOR EITHER CAN CAUSE THE OTHER.
//
// 0.1.24: findGrowth misread ordinary buffer eviction as a disjoint range
// on every segment of a long video, firing hundreds of run boundaries a
// minute, each superseded before it could transcribe anything. The
// backstop was a rate limiter: after three boundaries in ten seconds, stop
// opening runs and feed everything into the existing one. Degraded but
// alive beat churn death.
//
// 0.1.41: a user seek-stormed (25 -> 1495 -> 1596 -> 1566 in two seconds).
// Four genuinely disjoint regions, correctly classified. The fourth
// tripped that limiter, so audio from 1560 was fed into a run anchored
// around 1590, which could never decode it. The window skipped forever and
// coverage returned only when the playhead drifted somewhere the run could
// serve: 35.8 seconds of unfiltered audible playback.
//
// The distinction that resolves both: misclassified growth is CONTIGUOUS
// by construction, so suppressing it is free. A seek jump is DISJOINT, so
// suppressing it guarantees undecodable audio. These tests hold both ends.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMRunsCore } = require(path.join(__dirname, "..", "shared", "runs.js"));

const R = PMRunsCore;
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

// A storm: enough recent boundaries to trip the churn cap.
function storm(n) {
  const walls = [];
  for (let i = 0; i < (n == null ? 5 : n); i++) walls.push(NOW - i * 100);
  return walls;
}

function classify(over) {
  return R.classifyBoundary(
    Object.assign(
      {
        isNewRange: true,
        growthStart: 100,
        growthEnd: 110,
        currentRunSpan: { start: 100, end: 105 },
        boundaryWalls: [],
        now: NOW
      },
      over || {}
    )
  );
}

// ---- the 0.1.41 outage ---------------------------------------------------

test("a DISJOINT boundary opens a run even during a storm", () => {
  // The exact field case: growth at [1560,1569.94) while the current run
  // is anchored around 1590. Suppressing this is what broke the pipeline.
  const v = classify({
    growthStart: 1560,
    growthEnd: 1569.94,
    currentRunSpan: { start: 1590, end: 1620 },
    boundaryWalls: storm()
  });
  assert.strictEqual(v.action, "new-run");
  assert.strictEqual(v.reason, "disjoint-requires-run");
});

test("no rate limit can suppress a disjoint boundary, however severe", () => {
  // "Degraded but alive" is neither, when the degradation is audio that
  // can never be decoded.
  [5, 20, 500].forEach(function (n) {
    const v = classify({
      growthStart: 3000,
      growthEnd: 3010,
      currentRunSpan: { start: 0, end: 100 },
      boundaryWalls: storm(n)
    });
    assert.strictEqual(v.action, "new-run", n + " recent boundaries");
  });
});

test("a seek backwards is just as disjoint as a seek forwards", () => {
  const v = classify({
    growthStart: 25,
    growthEnd: 35,
    currentRunSpan: { start: 1500, end: 1600 },
    boundaryWalls: storm()
  });
  assert.strictEqual(v.action, "new-run");
});

// ---- the 0.1.24 outage, still fixed --------------------------------------

test("a CONTIGUOUS boundary during a storm is still suppressed", () => {
  // The misclassification case: growth the current run already holds, so
  // suppressing costs nothing and the churn cap is the right tool. This is
  // what stops the every-segment run churn that broke long videos.
  const v = classify({
    growthStart: 809,
    growthEnd: 810,
    currentRunSpan: { start: 135, end: 809 },
    boundaryWalls: storm()
  });
  assert.strictEqual(v.action, "suppressed");
  assert.strictEqual(v.reason, "storm-contiguous");
});

test("the trim-and-extend snapshot from the 0.1.24 report stays contiguous", () => {
  // before=[135.40,808.64] after=[136.54,809.50]: growth is the extended
  // tail, which the run plainly already serves.
  assert.strictEqual(
    R.isContiguousWith({ start: 135.4, end: 808.64 }, 808.64, 809.5),
    true
  );
});

test("a contiguous boundary opens a run when there is NO storm", () => {
  // Below the cap the old behaviour is unchanged: a boundary is a boundary.
  const v = classify({ growthStart: 105, growthEnd: 115, boundaryWalls: [] });
  assert.strictEqual(v.action, "new-run");
  assert.strictEqual(v.reason, "boundary-contiguous");
});

test("ordinary growth is never a boundary at all", () => {
  const v = classify({ isNewRange: false });
  assert.strictEqual(v.action, "feed-existing");
});

// ---- boundaries of the boundary ------------------------------------------

test("a run fed nothing yet can serve anything", () => {
  // Otherwise the first segment after a rebuild would look disjoint from
  // an empty run and churn immediately.
  assert.strictEqual(R.isContiguousWith(null, 1500, 1510), true);
  const v = classify({ currentRunSpan: null, growthStart: 1500, growthEnd: 1510, boundaryWalls: storm() });
  assert.strictEqual(v.action, "suppressed", "contiguous with an empty run");
});

test("the disjoint threshold tolerates ordinary append slop", () => {
  // Appends routinely land a hair past the fed end; that is not a seek.
  assert.strictEqual(R.isContiguousWith({ start: 100, end: 200 }, 201, 210), true);
  assert.strictEqual(R.isContiguousWith({ start: 100, end: 200 }, 400, 410), false);
  assert.ok(R.DISJOINT_GAP_S >= 1 && R.DISJOINT_GAP_S <= 10, "small but not hair-trigger");
});

test("a boundary with no usable growth span still respects the cap", () => {
  const quiet = classify({ growthStart: null, growthEnd: null, boundaryWalls: [] });
  assert.strictEqual(quiet.action, "new-run");
  const stormy = classify({ growthStart: null, growthEnd: null, boundaryWalls: storm() });
  assert.strictEqual(stormy.action, "suppressed");
});

test("stale boundary timestamps age out of the window", () => {
  const old = [NOW - 60000, NOW - 55000, NOW - 50000, NOW - 45000, NOW - 40000];
  const v = classify({ growthStart: 105, growthEnd: 115, boundaryWalls: old });
  assert.strictEqual(v.action, "new-run", "an old storm is not a current one");
});

// ---- retirement ----------------------------------------------------------

function runs(spec) {
  return spec.map(function (x) {
    return { span: x.span, isCurrent: !!x.isCurrent };
  });
}

test("nothing is retired while under the cap", () => {
  const idx = R.selectRunToRetire({
    runs: runs([{ span: { start: 0, end: 10 } }]),
    playheadT: 5,
    maxRuns: 4
  });
  assert.strictEqual(idx, -1);
});

test("the run FURTHEST from the playhead is retired, not the oldest", () => {
  // FIFO was right when runs arrived one at a time. After a seek storm the
  // oldest run can be exactly the one the playhead just came back to, and
  // dropping it recreates the same outage from the other direction.
  const idx = R.selectRunToRetire({
    runs: runs([
      { span: { start: 1560, end: 1580 } }, // oldest, and where the playhead is
      { span: { start: 20, end: 40 } }, // furthest away
      { span: { start: 1500, end: 1520 } },
      { span: { start: 1590, end: 1620 }, isCurrent: true }
    ]),
    playheadT: 1570,
    maxRuns: 3
  });
  assert.strictEqual(idx, 1, "the distant run goes, not index 0");
});

test("the run serving the playhead is never retired", () => {
  const idx = R.selectRunToRetire({
    runs: runs([
      { span: { start: 1560, end: 1580 } },
      { span: { start: 0, end: 20 } },
      { span: { start: 5000, end: 5020 } },
      { span: { start: 1590, end: 1620 }, isCurrent: true }
    ]),
    playheadT: 1570,
    maxRuns: 3
  });
  assert.notStrictEqual(idx, 0);
});

test("the current run is never retired", () => {
  const idx = R.selectRunToRetire({
    runs: runs([
      { span: { start: 0, end: 10 }, isCurrent: true },
      { span: { start: 20, end: 30 } }
    ]),
    playheadT: 5,
    maxRuns: 1
  });
  assert.strictEqual(idx, 1);
});

test("a run adjacent to the playhead survives, since the playhead is moving", () => {
  const idx = R.selectRunToRetire({
    runs: runs([
      { span: { start: 100, end: 200 } }, // playhead about to enter
      { span: { start: 9000, end: 9100 } },
      { span: { start: 0, end: 10 }, isCurrent: true }
    ]),
    playheadT: 201,
    maxRuns: 2
  });
  assert.strictEqual(idx, 1);
});

test("with no playhead known, retirement still makes progress", () => {
  const idx = R.selectRunToRetire({
    runs: runs([{ span: { start: 0, end: 10 } }, { span: { start: 20, end: 30 }, isCurrent: true }]),
    playheadT: null,
    maxRuns: 1
  });
  assert.strictEqual(idx, 0);
});

test("when every run is playhead-relevant, the oldest non-current one goes", () => {
  // The cap must still be enforced, or a pathological session grows runs
  // without bound and every one holds a 64MiB stream cache.
  const idx = R.selectRunToRetire({
    runs: runs([
      { span: { start: 100, end: 110 } },
      { span: { start: 100, end: 110 } },
      { span: { start: 100, end: 110 }, isCurrent: true }
    ]),
    playheadT: 105,
    maxRuns: 2
  });
  assert.strictEqual(idx, 0);
});

// ---- can this run serve the playhead? ------------------------------------

test("runCanServe answers the question the stall recovery needs", () => {
  // Waiting helps a slow pipeline and can never help a run that does not
  // hold the audio, so the restart has to be able to tell them apart.
  assert.strictEqual(R.runCanServe({ start: 1590, end: 1620 }, 1565.73), false);
  assert.strictEqual(R.runCanServe({ start: 1560, end: 1580 }, 1565.73), true);
  assert.strictEqual(R.runCanServe(null, 100), false);
  assert.strictEqual(R.runCanServe({ start: 100, end: 200 }, 201), true, "slop tolerated");
});

test("distanceFromPlayhead is zero inside a span and grows outside it", () => {
  assert.strictEqual(R.distanceFromPlayhead({ start: 100, end: 200 }, 150), 0);
  assert.strictEqual(R.distanceFromPlayhead({ start: 100, end: 200 }, 210), 10);
  assert.strictEqual(R.distanceFromPlayhead({ start: 100, end: 200 }, 40), 60);
  assert.strictEqual(R.distanceFromPlayhead(null, 40), Infinity);
});

// ---- summary -------------------------------------------------------------

console.log("runs_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
