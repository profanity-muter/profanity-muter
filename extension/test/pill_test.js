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

// ---- monotonic countdown (0.1.40) ----------------------------------------
//
// Field report: the countdown "goes down, then up, then says analyzing,
// then finally protected". Each jump was truthful in isolation, because a
// hang-delayed window produces a worse estimate than the one on screen.
// Truthful in isolation is not trustworthy: a number that can rise is not a
// countdown, and a user who sees it rise once stops reading it.

test("PROPERTY: no sequence of estimates can ever raise the display", () => {
  // The core guarantee, checked against deliberately hostile input rather
  // than a happy path: wild swings, repeats, zeros, nulls.
  const estimates = [12, 30, 4, 29, 4, 18, 3, 25, 1, 40, 9, 0, 17, 2];
  let state = null;
  let now = 0;
  let prevDisplayed = Infinity;
  estimates.forEach(function (candidate) {
    state = P.advanceCountdown(state, { candidateS: candidate, now: now });
    assert.ok(
      state.displayedS <= prevDisplayed,
      "display rose from " + prevDisplayed + " to " + state.displayedS
    );
    prevDisplayed = state.displayedS;
    now += 1000;
  });
});

test("a WORSE estimate holds the number flat rather than ticking it up", () => {
  let state = P.advanceCountdown(null, { candidateS: 10, now: 0 });
  state = P.advanceCountdown(state, { candidateS: 25, now: 0 });
  assert.strictEqual(state.displayedS, 10, "held, not raised");
});

test("a meaningfully better estimate is adopted", () => {
  let state = P.advanceCountdown(null, { candidateS: 20, now: 0 });
  state = P.advanceCountdown(state, { candidateS: 5, now: 0 });
  assert.strictEqual(state.displayedS, 5);
});

test("the jitter gate ignores trivially better quotes", () => {
  // Otherwise a 1Hz tick is interrupted constantly by noise that carries no
  // information.
  assert.strictEqual(P.passesJitterGate(20, 19), false, "5% better is flicker");
  assert.strictEqual(P.passesJitterGate(20, 14), true, "30% better is news");
  assert.strictEqual(P.passesJitterGate(8, 6), true, "2 whole seconds is news");
  assert.strictEqual(P.passesJitterGate(20, 21), false, "never upward");
  assert.strictEqual(P.passesJitterGate(20, 20), false, "no change is not news");
});

test("the display ticks down on the wall clock between estimates", () => {
  let state = P.advanceCountdown(null, { candidateS: 10, now: 0 });
  state = P.advanceCountdown(state, { candidateS: null, now: 3000 });
  assert.strictEqual(state.displayedS, 7);
});

test("the display floors at zero and never goes negative", () => {
  let state = P.advanceCountdown(null, { candidateS: 3, now: 0 });
  state = P.advanceCountdown(state, { candidateS: null, now: 60000 });
  assert.strictEqual(state.displayedS, 0);
});

test("a seek RESETS the promise and may raise the number", () => {
  // The one legitimate way up: a seek is a new question, not a revised
  // answer to the old one.
  let state = P.advanceCountdown(null, { candidateS: 4, now: 0 });
  state = P.advanceCountdown(state, { candidateS: 22, now: 1000, reset: true });
  assert.strictEqual(state.displayedS, 22);
});

test("zero held flat is the escape valve, not an upward tick", () => {
  // Once the display sits at zero and the estimate is still worse, the
  // caller's elapsed rule shows the numberless "Analyzing..." label. The
  // number itself must never climb back up to explain the overrun.
  let state = P.advanceCountdown(null, { candidateS: 2, now: 0 });
  state = P.advanceCountdown(state, { candidateS: null, now: 5000 });
  assert.strictEqual(state.displayedS, 0);
  state = P.advanceCountdown(state, { candidateS: 30, now: 6000 });
  assert.strictEqual(state.displayedS, 0, "still zero: the label changes, the number does not rise");
});

// ---- effective throughput ------------------------------------------------

test("the rtf EWMA measures WALL time, so hangs make quotes slower", () => {
  // A window that took twelve seconds because the decoder hung for nine
  // really did deliver its audio at that rate, and the countdown is a
  // promise about elapsed time. Feeding compute-only numbers is how the old
  // quotes stayed optimistic on exactly the videos that needed pessimism.
  const healthy = P.updateEffectiveRtf(null, 18, 4000);
  const hung = P.updateEffectiveRtf(healthy, 18, 13000);
  assert.ok(hung > healthy, "a hang-delayed window must slow the estimate");
});

test("one fast window cannot erase a slow stretch", () => {
  let rtf = P.updateEffectiveRtf(null, 18, 13000);
  const afterOneFast = P.updateEffectiveRtf(rtf, 18, 2000);
  assert.ok(afterOneFast > 0.3, "EWMA keeps memory: " + afterOneFast);
});

test("the EWMA ignores junk samples rather than poisoning itself", () => {
  const base = P.updateEffectiveRtf(null, 18, 4000);
  assert.strictEqual(P.updateEffectiveRtf(base, 0, 4000), base);
  assert.strictEqual(P.updateEffectiveRtf(base, 18, -5), base);
  assert.strictEqual(P.updateEffectiveRtf(base, null, 4000), base);
});

test("quotes are biased pessimistic, and keep the cold-start floor", () => {
  // Finishing early and snapping to Protected reads as fast; hitting zero
  // and lingering reads as broken.
  const optimistic = 10 * 0.3;
  const quoted = P.estimateSecondsToProtected(10, 0.3, true);
  assert.ok(quoted >= optimistic, "quote must not be optimistic: " + quoted);
  assert.strictEqual(P.estimateSecondsToProtected(0.1, 0.3, false), P.ETA_FLOOR_COLD_S);
});

test("an early finish is possible by construction", () => {
  // The pessimism factor exists precisely so the common case is finishing
  // before the countdown does.
  assert.ok(P.PESSIMISM_FACTOR > 1);
});

test("present() prefers the DISPLAYED value over the raw promise", () => {
  const out = P.present(
    { kind: "analyzing-safe" },
    { promise: { issuedWall: 0, etaS: 30 }, displayedS: 4, now: 0 }
  );
  assert.strictEqual(out.label, "Analyzing ~4s");
});

test("a displayed zero shows the numberless label, not '~0s'", () => {
  const out = P.present({ kind: "analyzing-safe" }, { displayedS: 0, now: 0 });
  assert.strictEqual(out.label, "Analyzing…");
});

// ---- the cold-start quote (0.1.43) ---------------------------------------
//
// The 0.1.42 field log promised about 8s for a fresh seek that took 15.2s,
// which breaks the pessimism rule in exactly the case the rule exists for.
// The cause was that the cold case had no arithmetic at all: with no
// measured throughput the estimate fell to a flat floor, and a floor is not
// an estimate of anything. The user's experience was the countdown hitting
// zero and lingering, which reads as broken.

test("a cold quote is computed, not floored", () => {
  // Two windows' worth of work at warm-up throughput, which is what
  // covering a fresh seek actually costs.
  const cold = P.coldEstimateS(5);
  assert.ok(cold > P.ETA_FLOOR_COLD_S, "cold estimate " + cold + " must exceed the old flat floor");
  assert.strictEqual(cold, 5 * 1.5 * P.COLD_WINDOWS, "span x warm-up rtf x windows");
});

test("the cold quote covers the field case rather than under-promising it", () => {
  // Actual was 15.2s. Quoting less than that is the bug being fixed;
  // quoting somewhat more is the pessimism rule working, because the
  // number falls as real data arrives and snaps to Protected.
  const quoted = P.estimateSecondsToProtected(5, null, false);
  assert.ok(quoted >= 15, "quoted " + quoted + "s against a 15.2s actual");
});

test("coldness is about the POSITION, not the session's history", () => {
  // A seek into an unanalyzed region starts from a standing start even ten
  // minutes into a session. Quoting the settled throughput for it is how
  // the badge promised 8s for something that took 15.2s.
  const warmSession = 0.3;
  const afterSeek = P.estimateSecondsToProtected(5, warmSession, true, true);
  const settled = P.estimateSecondsToProtected(5, warmSession, true, false);
  assert.ok(afterSeek > settled, "cold " + afterSeek + " vs settled " + settled);
});

test("the quote tightens as coverage builds at this position", () => {
  // The whole point of quoting high: the number falls. 5s uncovered while
  // cold, then 1s uncovered once most of the margin is covered.
  const cold = P.estimateSecondsToProtected(5, 0.3, true, true);
  const nearlyDone = P.estimateSecondsToProtected(1, 0.3, true, false);
  assert.ok(nearlyDone < cold);
  // And the monotonic ledger will only ever let the display move down.
  let state = P.advanceCountdown(null, { candidateS: cold, now: 0 });
  state = P.advanceCountdown(state, { candidateS: nearlyDone, now: 1000 });
  assert.ok(state.displayedS < cold);
});

test("the warm-up constant has ONE source of truth", () => {
  // shared/preempt.js owns it, because two modules disagreeing about how
  // slow a cold pipeline is would mean one of them was wrong. Loaded here
  // so the wiring is exercised rather than assumed.
  const { PMPreemptCore } = require(path.join(__dirname, "..", "shared", "preempt.js"));
  assert.strictEqual(P.coldEstimateS(10), 10 * PMPreemptCore.WARMUP_RTF * P.COLD_WINDOWS);
});

test("a cold quote for nothing uncovered is still nothing", () => {
  assert.strictEqual(P.coldEstimateS(0), 0);
  assert.strictEqual(P.coldEstimateS(-5), 0);
  assert.strictEqual(P.coldEstimateS(null), 0);
});

// ---- summary -------------------------------------------------------------

console.log("pill_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
