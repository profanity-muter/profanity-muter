// test/catchup_test.js
// Node unit tests for shared/catchup.js: pause-catchup ownership, the
// re-engage debounce, the muted-playback fallback trigger, and the rewind
// that stops the fallback costing the user content.
//
// Run with: node test/catchup_test.js   (or npm test, from extension/)
//
// Every rule here was written against a specific thing that happened on a
// real machine, and two of them cost the user something they cannot get
// back: seconds of a video that played silently and were gone. Pause-until
// -ready is the strictest mode this extension offers, chosen by people who
// want nothing unchecked to reach a child's ears, and it has to be exactly
// as careful with their content as with their protection.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMCatchupCore } = require(path.join(__dirname, "..", "shared", "catchup.js"));

const C = PMCatchupCore;
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

// ---- self-action tagging -------------------------------------------------

test("our own play is recognized as ours", () => {
  const marker = C.markSelfAction(NOW);
  assert.strictEqual(C.isSelfAction(marker, NOW), true);
  assert.strictEqual(C.isSelfAction(marker, NOW + 50), true);
});

test("a mark expires by itself", () => {
  // The old one-shot boolean could not do this: if the event never arrived
  // (a rejected play, say) the flag sat there and swallowed the NEXT event,
  // which might be the genuinely external one.
  const marker = C.markSelfAction(NOW);
  assert.strictEqual(C.isSelfAction(marker, NOW + C.SELF_ACTION_WINDOW_MS + 1), false);
});

test("a missing or malformed mark is never ours", () => {
  assert.strictEqual(C.isSelfAction(null, NOW), false);
  assert.strictEqual(C.isSelfAction({}, NOW), false);
  assert.strictEqual(C.isSelfAction({ wall: "soon" }, NOW), false);
});

test("a mark from the future is not ours either", () => {
  assert.strictEqual(C.isSelfAction(C.markSelfAction(NOW + 5000), NOW), false);
});

// ---- ownership -----------------------------------------------------------

test("OUR OWN play does not clear ownership", () => {
  // The 0.1.35 bug precisely: three engage/clear cycles in four seconds,
  // each logging "ownership cleared: external play observed" when there was
  // no external play at all. The extension was reading its own resume as
  // the user taking over.
  const r = C.ownershipOnPlaybackEvent({
    owned: true,
    marker: C.markSelfAction(NOW),
    now: NOW + 10
  });
  assert.strictEqual(r.selfInitiated, true);
  assert.strictEqual(r.cleared, false);
  assert.strictEqual(r.owned, true);
});

test("a genuinely external play DOES clear ownership", () => {
  // The other direction matters just as much: the user pressing play is
  // them taking their player back, and we must never fight that.
  const r = C.ownershipOnPlaybackEvent({ owned: true, marker: null, now: NOW });
  assert.strictEqual(r.selfInitiated, false);
  assert.strictEqual(r.cleared, true);
  assert.strictEqual(r.owned, false);
});

test("an external play we never owned clears nothing", () => {
  const r = C.ownershipOnPlaybackEvent({ owned: false, marker: null, now: NOW });
  assert.strictEqual(r.cleared, false);
  assert.strictEqual(r.owned, false);
});

test("a stale mark does not protect a later external play", () => {
  const r = C.ownershipOnPlaybackEvent({
    owned: true,
    marker: C.markSelfAction(NOW),
    now: NOW + C.SELF_ACTION_WINDOW_MS + 500
  });
  assert.strictEqual(r.cleared, true, "an expired mark must not swallow a real event");
});

// ---- re-engage debounce --------------------------------------------------

test("pausing again immediately after releasing is refused", () => {
  // This is the visible stutter: pause, release, pause again within
  // milliseconds as the playhead crosses a coverage boundary.
  assert.strictEqual(C.mayEngagePause({ lastReleaseWall: NOW, now: NOW + 100 }), false);
});

test("pausing is allowed once the quiet period passes", () => {
  assert.strictEqual(
    C.mayEngagePause({ lastReleaseWall: NOW, now: NOW + C.RE_ENGAGE_DEBOUNCE_MS }),
    true
  );
});

test("never having released means nothing to debounce", () => {
  assert.strictEqual(C.mayEngagePause({ now: NOW }), true);
  assert.strictEqual(C.mayEngagePause({}), true);
});

// ---- fallback trigger gating ---------------------------------------------

const STARVED = {
  windowInFlight: false,
  msSinceCoverageGrowth: 9000,
  msSinceCaptureGrowth: 9000,
  uncoveredAtPlayhead: true,
  thresholdMs: 8000
};

test("a genuinely starved pipeline still triggers the fallback", () => {
  // The deadlock it exists for is real: pausing stops YouTube fetching, and
  // audio buffered before our hook attached can never be captured
  // passively. This must keep working.
  assert.strictEqual(C.shouldEngageFallback(STARVED), true);
});

test("a window IN FLIGHT blocks the fallback", () => {
  // The field trace: a window was actively computing when the 8s timer
  // fired. Coverage does not move while transcription runs, so the old
  // coverage-only condition could not tell a slow window from a dead
  // pipeline. It cost the user 2.44 seconds of speech.
  assert.strictEqual(
    C.shouldEngageFallback(Object.assign({}, STARVED, { windowInFlight: true })),
    false
  );
});

test("growing capture ranges block the fallback", () => {
  // Priming the buffer is exactly what the fallback would be for, and it is
  // already happening. The trace had capture reaching [0,29) while the code
  // called it stalled.
  assert.strictEqual(
    C.shouldEngageFallback(Object.assign({}, STARVED, { msSinceCaptureGrowth: 500 })),
    false
  );
});

test("nothing uncovered at the playhead blocks the fallback", () => {
  assert.strictEqual(
    C.shouldEngageFallback(Object.assign({}, STARVED, { uncoveredAtPlayhead: false })),
    false
  );
});

test("coverage moving recently blocks the fallback", () => {
  assert.strictEqual(
    C.shouldEngageFallback(Object.assign({}, STARVED, { msSinceCoverageGrowth: 1000 })),
    false
  );
});

test("the fallback never fires on missing information", () => {
  // Consuming the user's content is a real cost, so the burden of proof is
  // on the trigger, not on the guard.
  assert.strictEqual(C.shouldEngageFallback({}), false);
  assert.strictEqual(C.shouldEngageFallback(), false);
});

// ---- the rewind ----------------------------------------------------------

const REWINDABLE = {
  fallbackStartT: 0,
  playheadT: 2.44,
  uncoveredInSpanS: 0,
  userSeekedSince: false
};

test("covered muted playback is replayed from where the silence started", () => {
  // The user's exact case: [0, 2.44) played silently. Now that it is
  // analyzed, they hear it.
  const r = C.rewindDecision(REWINDABLE);
  assert.strictEqual(r.rewind, true);
  assert.strictEqual(r.toT, 0);
  assert.strictEqual(r.reason, "rewind");
});

test("a USER seek supersedes the rewind entirely", () => {
  // Yanking someone back to where we wanted them would be the extension
  // overriding a deliberate choice, which is worse than the audio it
  // recovers.
  const r = C.rewindDecision(Object.assign({}, REWINDABLE, { userSeekedSince: true }));
  assert.strictEqual(r.rewind, false);
  assert.strictEqual(r.reason, "user-seeked");
});

test("a sub-threshold stretch is not worth a rewind", () => {
  const r = C.rewindDecision(Object.assign({}, REWINDABLE, { playheadT: 0.5 }));
  assert.strictEqual(r.rewind, false);
  assert.strictEqual(r.reason, "too-short");
});

test("the threshold is a strict boundary", () => {
  assert.strictEqual(
    C.rewindDecision(Object.assign({}, REWINDABLE, { playheadT: C.MIN_REWIND_S })).rewind,
    false
  );
  assert.strictEqual(
    C.rewindDecision(Object.assign({}, REWINDABLE, { playheadT: C.MIN_REWIND_S + 0.01 })).rewind,
    true
  );
});

test("we do NOT rewind into audio that is still unanalyzed", () => {
  // Replaying it would recover the sound and lose the protection, which is
  // the wrong trade in the strictest mode the product has.
  const r = C.rewindDecision(Object.assign({}, REWINDABLE, { uncoveredInSpanS: 1.2 }));
  assert.strictEqual(r.rewind, false);
  assert.strictEqual(r.reason, "not-covered-yet");
});

test("'not covered yet' is a wait, distinguishable from a refusal", () => {
  // content.js keeps the pending rewind alive on this reason and retires it
  // on the others, so the distinction has to survive in the API.
  const waiting = C.rewindDecision(Object.assign({}, REWINDABLE, { uncoveredInSpanS: 5 }));
  const refused = C.rewindDecision(Object.assign({}, REWINDABLE, { userSeekedSince: true }));
  assert.notStrictEqual(waiting.reason, refused.reason);
});

test("no pending fallback means no rewind", () => {
  assert.strictEqual(C.rewindDecision({}).reason, "no-pending-fallback");
  assert.strictEqual(C.rewindDecision().rewind, false);
  assert.strictEqual(
    C.rewindDecision({ fallbackStartT: 0, uncoveredInSpanS: 0 }).reason,
    "no-playhead"
  );
});

// ---- summary -------------------------------------------------------------

console.log("catchup_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
