// test/language_test.js
// Node unit tests for shared/language.js: the gate deciding whether a
// language probe is allowed to move the pipeline off English.
//
// Run with: node test/language_test.js   (or npm test, from extension/)
//
// The field case this encodes: a plainly English video was declared Korean
// from a single probe at score 13.18, when a correct detection on
// comparable content scored 19.76. Acting on it swapped the active word
// list to the shipped 66-entry Korean pack, after which "fuck", "shit",
// "asshole" and "bitch" all stopped matching. The extension went on
// displaying "Protected". A filter that silently stops filtering, on
// exactly the content it was installed for, is the worst failure this
// product has, and it came from trusting one probe.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMLanguageCore } = require(path.join(__dirname, "..", "shared", "language.js"));

const L = PMLanguageCore;

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

// Feed a sequence of observations through the gate and return the trail.
function run(observations, startState) {
  let state = startState || L.newState();
  const trail = [];
  observations.forEach(function (o) {
    const r = L.decide(state, o);
    state = r.state;
    trail.push({ action: r.action, reason: r.reason, active: state.active });
  });
  return { state: state, trail: trail };
}

// ---- the exact field case ------------------------------------------------

test("the observed false positive (ko score 13.18) does NOT switch", () => {
  const r = L.decide(L.newState(), { language: "ko", score: 13.18 });
  assert.strictEqual(r.action, "hold");
  assert.strictEqual(r.reason, "low-confidence");
  assert.strictEqual(r.state.active, "en");
});

test("even repeated, the low-confidence guess never accumulates a switch", () => {
  // Two weak guesses must not add up to a decision neither of them earned,
  // which is why confidence is checked before the streak is touched.
  const out = run([
    { language: "ko", score: 13.18 },
    { language: "ko", score: 13.18 },
    { language: "ko", score: 13.18 }
  ]);
  assert.strictEqual(out.state.active, "en");
  out.trail.forEach(function (step) {
    assert.strictEqual(step.action, "hold", JSON.stringify(step));
  });
});

test("the observed CORRECT score (19.76) is comfortably above the bar", () => {
  // Calibration sanity: the gate must not be so strict that a real
  // detection cannot pass it either.
  assert.ok(19.76 > L.MIN_SWITCH_SCORE, "a correct detection must be able to switch");
  assert.ok(13.18 < L.MIN_SWITCH_SCORE, "the observed false positive must not");
});

// ---- corroboration -------------------------------------------------------

test("one confident probe is not enough on its own", () => {
  const r = L.decide(L.newState(), { language: "ko", score: 18.5 });
  assert.strictEqual(r.action, "hold");
  assert.strictEqual(r.reason, "awaiting-corroboration");
  assert.strictEqual(r.state.active, "en");
});

test("two consecutive agreeing confident probes DO switch", () => {
  const out = run([
    { language: "ko", score: 18.5 },
    { language: "ko", score: 18.9 }
  ]);
  assert.strictEqual(out.trail[1].action, "switch");
  assert.strictEqual(out.state.active, "ko");
});

test("disagreeing confident probes never accumulate", () => {
  // Alternating languages means the detector is unsure, not that either
  // answer is right.
  const out = run([
    { language: "ko", score: 18.5 },
    { language: "ja", score: 18.5 },
    { language: "ko", score: 18.5 },
    { language: "ja", score: 18.5 }
  ]);
  assert.strictEqual(out.state.active, "en");
  out.trail.forEach(function (step) {
    assert.strictEqual(step.action, "hold");
  });
});

test("a low-confidence probe BREAKS a building streak", () => {
  const out = run([
    { language: "ko", score: 18.5 },
    { language: "ko", score: 9 },
    { language: "ko", score: 18.5 }
  ]);
  assert.strictEqual(out.state.active, "en", "the streak restarted, so no switch yet");
});

// ---- switching back ------------------------------------------------------

test("a confident English probe reverts a wrong switch", () => {
  // Recovery has to be possible: the field session was stuck on Korean for
  // the rest of the video with no way back.
  const switched = run([
    { language: "ko", score: 18.5 },
    { language: "ko", score: 18.9 }
  ]);
  assert.strictEqual(switched.state.active, "ko");
  const back = L.decide(switched.state, { language: "en", score: 19.76 });
  assert.strictEqual(back.action, "revert");
  assert.strictEqual(back.state.active, "en");
});

test("reverting is DELIBERATELY easier than switching", () => {
  // Asymmetric on purpose: leaving English can disable protection, while
  // returning to it can only cost a slower model. One observation is
  // enough, at a lower bar, and no corroboration is required.
  assert.ok(L.MIN_REVERT_SCORE < L.MIN_SWITCH_SCORE);
  const switched = run([
    { language: "ko", score: 18.5 },
    { language: "ko", score: 18.9 }
  ]);
  const back = L.decide(switched.state, { language: "en", score: L.MIN_REVERT_SCORE });
  assert.strictEqual(back.action, "revert");
});

test("but a noise-level English probe does not flap the model back", () => {
  const switched = run([
    { language: "ko", score: 18.5 },
    { language: "ko", score: 18.9 }
  ]);
  const back = L.decide(switched.state, { language: "en", score: 2 });
  assert.strictEqual(back.action, "hold");
  assert.strictEqual(back.reason, "revert-low-confidence");
  assert.strictEqual(back.state.active, "ko");
});

test("English probes while already English are a no-op", () => {
  const r = L.decide(L.newState(), { language: "en", score: 19.76 });
  assert.strictEqual(r.action, "hold");
  assert.strictEqual(r.reason, "already-english");
});

test("re-detecting the language already active changes nothing", () => {
  const switched = run([
    { language: "ko", score: 18.5 },
    { language: "ko", score: 18.9 }
  ]);
  const again = L.decide(switched.state, { language: "ko", score: 19 });
  assert.strictEqual(again.action, "hold");
  assert.strictEqual(again.reason, "already-active");
  assert.strictEqual(again.state.active, "ko");
});

// ---- robustness ----------------------------------------------------------

test("a failed or empty detection holds English", () => {
  [{ language: null, score: null }, {}, { language: "", score: 20 }].forEach(function (o) {
    const r = L.decide(L.newState(), o);
    assert.strictEqual(r.action, "hold", JSON.stringify(o));
    assert.strictEqual(r.state.active, "en");
  });
  assert.strictEqual(L.decide(L.newState()).action, "hold");
});

test("a missing score is treated as no confidence, never as infinite", () => {
  const r = L.decide(L.newState(), { language: "ko" });
  assert.strictEqual(r.action, "hold");
  assert.strictEqual(r.reason, "low-confidence");
});

test("a junk state is replaced rather than trusted", () => {
  const r = L.decide(null, { language: "en", score: 19 });
  assert.strictEqual(r.state.active, "en");
  assert.strictEqual(L.decide("nonsense", { language: "ko", score: 19 }).state.active, "en");
});

test("every decision carries a reason, for the devlog", () => {
  // The field case left one line saying what happened and nothing saying
  // why, which is what made it unexplainable from a paste.
  const cases = [
    { language: "ko", score: 13.18 },
    { language: "ko", score: 18.5 },
    { language: "en", score: 19.76 },
    { language: null, score: null }
  ];
  cases.forEach(function (o) {
    const r = L.decide(L.newState(), o);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0, JSON.stringify(o));
    assert.ok(["switch", "revert", "hold"].indexOf(r.action) !== -1, r.action);
  });
});

// ---- probing budget ------------------------------------------------------

test("probing is bounded, since detection shares the single worker", () => {
  let state = L.newState();
  assert.strictEqual(L.shouldProbe(state), true);
  for (let i = 0; i < L.MAX_PROBES; i++) {
    state = L.decide(state, { language: "en", score: 19 }).state;
  }
  assert.strictEqual(L.shouldProbe(state), false);
  assert.ok(L.MAX_PROBES >= L.CONSECUTIVE_REQUIRED, "must allow enough probes to ever corroborate");
});

// ---- summary -------------------------------------------------------------

console.log("language_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
