// test/pill_test.js
// Node unit tests for shared/pill.js: the collapse from internal pill
// states to what the user actually reads, and the countdown that replaced
// a static estimate.
//
// Run with: node test/pill_test.js   (or npm test, from extension/)
//
// Why this matters more than a label usually would: the 0.1.35 field trace
// showed the pill cycling through four different sentences inside a few
// seconds of an ordinary cold start, each transition correct by its own
// rule. The user's verdict was that it should say "processing, with a
// countdown, then protected". These tests pin that collapse, and pin the
// two ways a countdown can lie: promising a time nothing could achieve,
// and treating its own overrun as an emergency.

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PMPillCore } = require(path.join(__dirname, "..", "shared", "pill.js"));

const P = PMPillCore;
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

function promise(etaS, issuedWall) {
  return { issuedWall: issuedWall == null ? NOW : issuedWall, etaS: etaS, windowsAtIssue: 0 };
}

// ---- the collapse --------------------------------------------------------

test("every routine processing state presents as one thing", () => {
  // The whole point: three internal states, one sentence. The distinctions
  // are real to the logic and meaningless to the reader.
  P.PROCESSING_KINDS.forEach(function (kind) {
    const out = P.present({ kind: kind }, { promise: promise(5), now: NOW });
    assert.strictEqual(out.presented, "analyzing", kind);
    assert.strictEqual(out.label, "Analyzing ~5s", kind);
  });
});

test("the internal states are still distinct, they are just not shown", () => {
  // Guards against someone "simplifying" by deleting the internal states,
  // which the logic and the traces genuinely use.
  assert.ok(P.PROCESSING_KINDS.indexOf("analyzing-safe") !== -1);
  assert.ok(P.PROCESSING_KINDS.indexOf("analyzing-slow") !== -1);
  assert.ok(P.PROCESSING_KINDS.indexOf("buffering") !== -1);
});

test("protected, off, shorts and live are unchanged", () => {
  assert.deepStrictEqual(P.present({ kind: "protected" }, { now: NOW }), {
    label: "Protected",
    presented: "protected"
  });
  assert.strictEqual(P.present({ kind: "off" }, { now: NOW }).label, "Off");
  assert.strictEqual(P.present({ kind: "shorts" }, { now: NOW }).label, "Shorts not supported");
  assert.strictEqual(P.present({ kind: "live" }, { now: NOW }).label, "Live - limited support");
});

test("press play survives as the one actionable sentence", () => {
  const out = P.present({ kind: "needs-play" }, { now: NOW });
  assert.strictEqual(out.label, "Press play to load audio");
  assert.strictEqual(out.presented, "needs-play");
});

test("an unknown internal state presents as processing, never as a raw id", () => {
  // A future state added to the logic must not leak an identifier onto the
  // player before someone remembers to give it a sentence.
  const out = P.present({ kind: "some-future-state" }, { now: NOW });
  assert.strictEqual(out.label, "Analyzing…");
  assert.strictEqual(out.presented, "analyzing");
});

test("no state at all presents as nothing", () => {
  assert.strictEqual(P.present(null, { now: NOW }), null);
  assert.strictEqual(P.present({}, { now: NOW }), null);
});

// ---- the countdown -------------------------------------------------------

test("the countdown counts down", () => {
  const p = promise(10);
  assert.strictEqual(P.countdownRemainingS(p, NOW), 10);
  assert.strictEqual(P.countdownRemainingS(p, NOW + 3000), 7);
  assert.strictEqual(P.countdownRemainingS(p, NOW + 9500), 1);
});

test("the countdown floors at zero rather than going negative", () => {
  assert.strictEqual(P.countdownRemainingS(promise(3), NOW + 30000), 0);
});

test("an elapsed countdown drops the number and does NOT alarm", () => {
  // The old model escalated to "taking longer than expected" here, which
  // the trace showed firing two seconds into a normal cold start.
  // Overrunning an estimate is ordinary; only the health monitor, on its
  // own much slower clock, is allowed to say something is wrong.
  const out = P.present({ kind: "analyzing-safe" }, { promise: promise(3), now: NOW + 9000 });
  assert.strictEqual(out.label, "Analyzing…");
  assert.ok(!/longer than expected|not working|NOT/i.test(out.label), out.label);
});

test("no promise yet also presents as the numberless label", () => {
  assert.strictEqual(P.present({ kind: "buffering" }, { now: NOW }).label, "Analyzing…");
  assert.strictEqual(P.countdownRemainingS(null, NOW), null);
  assert.strictEqual(P.countdownRemainingS({ issuedWall: NOW }, NOW), null);
});

test("the countdown re-arms when a fresh promise is issued", () => {
  // Re-arming is what a completed window does: openOrKeepPromise issues a
  // new promise, and the label goes straight back to a number.
  const elapsed = P.present({ kind: "analyzing-safe" }, { promise: promise(3), now: NOW + 9000 });
  assert.strictEqual(elapsed.label, "Analyzing…");
  const rearmed = P.present(
    { kind: "analyzing-safe" },
    { promise: promise(6, NOW + 9000), now: NOW + 9000 }
  );
  assert.strictEqual(rearmed.label, "Analyzing ~6s");
});

// ---- the floor -----------------------------------------------------------

test("a cold start is never quoted an absurdly optimistic time", () => {
  // The trace's actual number was ~1s, produced from a default rtf guess
  // before anything had been measured. One second is not a plausible time
  // to load a model, demux and transcribe, and a countdown that hits zero
  // immediately teaches the user to ignore it.
  assert.strictEqual(P.clampEta(1, false), P.ETA_FLOOR_COLD_S);
  assert.strictEqual(P.clampEta(0.2, false), P.ETA_FLOOR_COLD_S);
  assert.ok(P.ETA_FLOOR_COLD_S >= 6, "cold floor should be generous");
});

test("once an rtf has been measured the floor relaxes, but not to zero", () => {
  assert.strictEqual(P.clampEta(0.1, true), P.ETA_FLOOR_S);
  assert.strictEqual(P.etaFloorFor(true), P.ETA_FLOOR_S);
  assert.strictEqual(P.etaFloorFor(false), P.ETA_FLOOR_COLD_S);
  assert.ok(P.ETA_FLOOR_S >= 1, "sub-second countdowns flicker and read as broken");
});

test("a real estimate above the floor is respected, and rounded up", () => {
  assert.strictEqual(P.clampEta(12.2, true), 13);
  assert.strictEqual(P.clampEta(12.2, false), 13);
});

test("the ceiling still applies", () => {
  assert.strictEqual(P.clampEta(9999, true), P.ETA_CEILING_S);
});

test("a junk estimate falls back to the floor rather than to NaN", () => {
  assert.strictEqual(P.clampEta(NaN, false), P.ETA_FLOOR_COLD_S);
  assert.strictEqual(P.clampEta(undefined, true), P.ETA_FLOOR_S);
  assert.strictEqual(P.clampEta(Infinity, true), P.ETA_FLOOR_S);
});

// ---- input-vector completeness (defect b) --------------------------------

test("computeStatusState computes capture inputs before ANY branch returns", () => {
  // Source-shape guard for the 0.1.35 defect: a [PM-PILL] transition logged
  // capturedAtPlayhead=NA while bufferedRanges held a range containing the
  // playhead, because the protected branch returned before those inputs
  // were computed. A trace that varies by branch is worse than no trace, so
  // this pins the ordering rather than the symptom.
  const src = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const fnStart = src.indexOf("function computeStatusState()");
  assert.ok(fnStart > 0, "computeStatusState not found");
  const body = src.slice(fnStart, fnStart + 6000);
  const capturedAt = body.indexOf("trace.capturedAtPlayhead =");
  const nearestAt = body.indexOf("trace.nearestCaptured =");
  const firstTracedReturn = body.indexOf("return withTrace(");
  assert.ok(capturedAt > 0, "capturedAtPlayhead never assigned");
  assert.ok(nearestAt > 0, "nearestCaptured never assigned");
  assert.ok(
    capturedAt < firstTracedReturn,
    "capturedAtPlayhead must be computed before the first traced return"
  );
  assert.ok(
    nearestAt < firstTracedReturn,
    "nearestCaptured must be computed before the first traced return"
  );
});

// ---- the badge: geometry and the open-UI ladder (0.1.36 addendum) --------

test("the badge clears YouTube's hover title band", () => {
  // At top:8px the badge sits underneath the title gradient the player
  // fades in on mouse-over, which is where it was originally put and why
  // it had to move.
  assert.ok(P.BADGE_TOP_PX >= 40, "must clear the hover chrome: " + P.BADGE_TOP_PX);
  // 0.1.37 moved this from 8 to 12: with the badge now riding up to the
  // corner when the player is idle, a slightly larger inset keeps it from
  // looking wedged against the frame.
  assert.strictEqual(P.BADGE_LEFT_PX, 12);
});

test("the dev overlay is anchored below the badge, never overlapping it", () => {
  assert.ok(
    P.DEBUG_OVERLAY_TOP_PX > P.BADGE_TOP_PX,
    "dev overlay must sit below the badge"
  );
});

test("the click message shape is fixed", () => {
  // content.js sends it and background.js matches on it; a typo in either
  // would be a silently dead affordance.
  assert.deepStrictEqual(P.openUiMessage(), { type: "pm-open-ui" });
  assert.strictEqual(P.OPEN_UI_MESSAGE_TYPE, "pm-open-ui");
});

test("the open-UI ladder tries the real popup first", () => {
  // chrome.action.openPopup() opens the ACTUAL toolbar popup, which is what
  // the user asked for; a tab is a consolation prize.
  assert.deepStrictEqual(P.openUiPlan({}), ["action-popup", "popup-tab", "onboarding-tab"]);
  assert.strictEqual(P.openUiPlan()[0], "action-popup");
});

test("the ladder degrades in order, and always ends somewhere real", () => {
  // openPopup has shipped and unshipped across Chrome versions and needs a
  // user gesture, so it is attempted rather than relied on. Whatever is
  // missing, the ladder must still end at something that opens.
  assert.deepStrictEqual(P.openUiPlan({ canOpenPopup: false }), ["popup-tab", "onboarding-tab"]);
  assert.deepStrictEqual(P.openUiPlan({ canOpenPopup: false, canOpenTab: false }), [
    "onboarding-tab"
  ]);
  [{}, { canOpenPopup: false }, { canOpenTab: false }].forEach(function (caps) {
    assert.ok(P.openUiPlan(caps).length > 0, JSON.stringify(caps));
  });
});

test("content.js injects exactly one interactive on-player surface", () => {
  // Source-shape guard for the consolidation. Four surfaces existed before
  // this round (status pill, notice banner, analyzing overlay, dev
  // overlay). Only the badge may catch the pointer: a filter that ate
  // clicks on the video it is filtering would be a worse bug than the
  // missing affordance this fixed.
  const src = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const interactive = src.match(/pointer-events:auto/g) || [];
  // Two, and only two: the badge, and the dev overlay's Copy logs button.
  // The latter is gated behind pm_debugOverlay, is off by default, and
  // needs a real gesture for clipboard access, so it is a deliberate
  // exception rather than a second routine surface.
  assert.strictEqual(interactive.length, 2, "badge + dev-only Copy logs button");
  const badgeAt = src.indexOf("cursor:pointer;white-space:nowrap;");
  const copyLogsAt = src.indexOf("debugOverlayButtonEl.style.cssText");
  assert.ok(badgeAt > 0, "the badge must be the interactive routine surface");
  assert.ok(copyLogsAt > 0, "the other must be the dev-only Copy logs button");
  assert.ok(src.indexOf("aria-label', 'Profanity Muter - open settings") !== -1);
  // The two folded surfaces must not have grown their own elements again.
  assert.strictEqual(
    src.indexOf("analyzingOverlayEl = document.createElement"),
    -1,
    "the analyzing overlay should be folded into the badge"
  );
  assert.strictEqual(
    src.indexOf("notice.style.cssText"),
    -1,
    "the notice banner should be folded into the badge"
  );
});

// ---- no language suffix, ever (0.1.37) -----------------------------------

test("no presented label ever carries a language code", () => {
  // The badge read "Protected · ko" to a user watching an English video,
  // who had no idea what "ko" meant. A two-letter code is dev information;
  // the badge is the one surface a non-technical user reads.
  ["protected", "off", "shorts", "live", "needs-play"]
    .concat(P.PROCESSING_KINDS)
    .forEach(function (kind) {
      const out = P.present({ kind: kind }, { promise: { issuedWall: 0, etaS: 5 }, now: 1000 });
      assert.ok(out, kind);
      assert.strictEqual(/ · [a-z]{2}$/.test(out.label), false, kind + ": " + out.label);
    });
});

test("content.js no longer appends a language suffix on any path", () => {
  // There were two label paths (the collapsed one and a legacy fallback)
  // and both did it.
  const src = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.strictEqual(
    src.indexOf("' · ' + session.language"),
    -1,
    "the language suffix must not be appended to any label"
  );
});

// ---- adaptive badge position (0.1.37) ------------------------------------

test("the badge has two resting places, corner and below-title", () => {
  assert.ok(P.BADGE_TOP_IDLE_PX < P.BADGE_TOP_PX, "idle sits higher than chrome-visible");
  assert.ok(P.BADGE_TOP_IDLE_PX >= 8, "still inside the player, not flush to the edge");
  assert.ok(P.BADGE_TOP_PX >= 40, "must clear the hover title band");
});

test("position is driven by the player's own idle class, not polling", () => {
  // ytp-autohide is what YouTube already publishes for chrome-hidden, so
  // the rule tracks the real state instead of our guess at it, and needs
  // no observer or timer.
  const src = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  assert.ok(src.indexOf(".ytp-autohide .pm-badge") !== -1, "idle rule missing");
  assert.ok(src.indexOf("transition:top") !== -1, "must glide rather than jump");
  assert.ok(src.indexOf("pm-badge") !== -1);
});

test("the DEFAULT position is the safe one", () => {
  // If ytp-autohide ever stops existing the rule simply never matches, so
  // the default has to be the offset that clears the title band rather
  // than the corner that would sit under it.
  const src = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const defaultRule = src.indexOf(".pm-badge{top:' + chromeTop");
  const idleRule = src.indexOf(".ytp-autohide .pm-badge{top:' + idleTop");
  assert.ok(defaultRule > 0 && idleRule > defaultRule, "idle rule must override the safe default");
});

// ---- summary -------------------------------------------------------------

console.log("pill_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
