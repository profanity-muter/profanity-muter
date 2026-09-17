// test/moments_test.js
// Node unit tests for shared/moments.js: the review-prompt eligibility
// matrix, the onboarding/acknowledgment record shapes, and the share
// blurb constant.
//
// Run with: node test/moments_test.js   (or npm test, from extension/)
//
// The eligibility matrix is the reason this file exists. Every gate on
// the review prompt is a Chrome Web Store policy obligation or a product
// promise ("we will not ask you until you have a basis for an opinion"),
// and none of them are observable from the UI until the day they fire -
// weeks after install, on someone else's machine. Pure predicate plus an
// injected clock means the whole matrix is checkable in milliseconds.

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { PMMomentsCore } = require(path.join(__dirname, "..", "shared", "moments.js"));

const M = PMMomentsCore;
const DAY = M.DAY_MS;
const NOW = 1_800_000_000_000; // fixed clock; nothing here reads the real one

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

// A fully-eligible input, which each matrix row below breaks in exactly
// one way. Built fresh per call so a test can mutate its copy freely.
function eligibleInput(overrides) {
  const base = {
    now: NOW,
    installedAt: NOW - 8 * DAY,
    ack: M.makeAckRecord(NOW - 8 * DAY),
    reviewPrompt: undefined,
    stats: { videosProtected: 12, totalMuted: 30 }
  };
  return Object.assign(base, overrides || {});
}

function verdict(overrides) {
  return M.reviewPromptEligibility(eligibleInput(overrides));
}

// ---- acknowledgment ------------------------------------------------------

test("makeAckRecord stamps the current ack version and the given time", () => {
  const rec = M.makeAckRecord(NOW);
  assert.deepStrictEqual(rec, { version: M.ACK_VERSION, timestamp: NOW });
  assert.strictEqual(M.isAcknowledged(rec), true);
});

test("makeAckRecord falls back to Date.now() when no clock is passed", () => {
  const before = Date.now();
  const rec = M.makeAckRecord();
  assert.ok(rec.timestamp >= before && rec.timestamp <= Date.now() + 5);
});

test("isAcknowledged rejects absent, malformed, and stale-version records", () => {
  assert.strictEqual(M.isAcknowledged(undefined), false);
  assert.strictEqual(M.isAcknowledged(null), false);
  assert.strictEqual(M.isAcknowledged({}), false);
  assert.strictEqual(M.isAcknowledged({ version: M.ACK_VERSION }), false, "needs a timestamp");
  assert.strictEqual(M.isAcknowledged({ timestamp: NOW }), false, "needs a version");
  assert.strictEqual(M.isAcknowledged({ version: 0, timestamp: NOW }), false);
  assert.strictEqual(
    M.isAcknowledged({ version: M.ACK_VERSION + 1, timestamp: NOW }),
    false,
    "a FUTURE version is not an acknowledgment of what we currently say"
  );
  assert.strictEqual(M.isAcknowledged({ version: M.ACK_VERSION, timestamp: NaN }), false);
  assert.strictEqual(M.isAcknowledged("yes"), false);
});

test("bumping ACK_VERSION would invalidate existing acknowledgments", () => {
  // Guards the intent of versioning the record at all: an ack written
  // under a previous version must not carry forward silently.
  const old = { version: M.ACK_VERSION - 1, timestamp: NOW };
  assert.strictEqual(M.isAcknowledged(old), false);
});

// ---- onboarding ----------------------------------------------------------

test("isOnboarded is strictly boolean-true, not truthy", () => {
  assert.strictEqual(M.isOnboarded(true), true);
  assert.strictEqual(M.isOnboarded(false), false);
  assert.strictEqual(M.isOnboarded(undefined), false);
  assert.strictEqual(M.isOnboarded(1), false);
  assert.strictEqual(M.isOnboarded("true"), false);
});

test("shouldAutoOpenOnboarding: only on a genuine first install", () => {
  assert.strictEqual(M.shouldAutoOpenOnboarding("install", undefined), true);
  assert.strictEqual(M.shouldAutoOpenOnboarding("install", false), true);
  // Already opened once -> never again, even on a reinstall event.
  assert.strictEqual(M.shouldAutoOpenOnboarding("install", true), false);
  // An update must never seize a tab - the user didn't ask for it.
  assert.strictEqual(M.shouldAutoOpenOnboarding("update", undefined), false);
  assert.strictEqual(M.shouldAutoOpenOnboarding("chrome_update", undefined), false);
  assert.strictEqual(M.shouldAutoOpenOnboarding("shared_module_update", undefined), false);
  assert.strictEqual(M.shouldAutoOpenOnboarding(undefined, undefined), false);
});

// ---- review prompt: the eligibility matrix -------------------------------

const MATRIX = [
  ["all gates met", {}, true, "eligible"],

  // Already prompted - the "at most once, ever" rule. The record's mere
  // existence disqualifies, whichever button (if any) created it.
  ["already prompted, not dismissed", { reviewPrompt: { shownAt: NOW - DAY, dismissed: false } }, false, "already-prompted"],
  ["already prompted and dismissed", { reviewPrompt: { shownAt: NOW - DAY, dismissed: true } }, false, "already-prompted"],
  ["a prompt record from a much older build", { reviewPrompt: {} }, false, "already-prompted"],

  // Onboarding.
  ["never acknowledged", { ack: undefined }, false, "not-acknowledged"],
  ["acknowledged under an older ack version", { ack: { version: M.ACK_VERSION - 1, timestamp: NOW } }, false, "not-acknowledged"],

  // Install age.
  ["no install date recorded", { installedAt: undefined }, false, "no-install-date"],
  ["install date is not a number", { installedAt: "yesterday" }, false, "no-install-date"],
  ["installed 6 days ago", { installedAt: NOW - 6 * DAY }, false, "too-new"],
  ["installed exactly 7 days ago", { installedAt: NOW - 7 * DAY }, true, "eligible"],
  ["installed a second under 7 days ago", { installedAt: NOW - 7 * DAY + 1000 }, false, "too-new"],
  ["install date in the FUTURE (clock skew)", { installedAt: NOW + DAY }, false, "too-new"],

  // Usage milestones.
  ["no stats at all", { stats: {} }, false, "not-enough-videos"],
  ["9 videos", { stats: { videosProtected: 9, totalMuted: 100 } }, false, "not-enough-videos"],
  ["exactly 10 videos, 25 mutes", { stats: { videosProtected: 10, totalMuted: 25 } }, true, "eligible"],
  ["10 videos but 24 mutes", { stats: { videosProtected: 10, totalMuted: 24 } }, false, "not-enough-mutes"],
  ["plenty of mutes but too few videos", { stats: { videosProtected: 3, totalMuted: 900 } }, false, "not-enough-videos"],
  ["garbage stats values", { stats: { videosProtected: "many", totalMuted: "lots" } }, false, "not-enough-videos"],

  // Precedence: the most fundamental failing gate is the one reported.
  ["everything wrong at once reports already-prompted first", {
    reviewPrompt: { shownAt: 1 },
    ack: undefined,
    installedAt: undefined,
    stats: {}
  }, false, "already-prompted"],
  ["unacknowledged AND too new reports not-acknowledged", {
    ack: undefined,
    installedAt: NOW
  }, false, "not-acknowledged"]
];

MATRIX.forEach(function (row) {
  const [name, overrides, expectEligible, expectReason] = row;
  test("eligibility: " + name, () => {
    const v = verdict(overrides);
    assert.strictEqual(v.eligible, expectEligible, "eligible");
    assert.strictEqual(v.reason, expectReason, "reason");
  });
});

test("eligibility thresholds are the documented ones", () => {
  assert.strictEqual(M.REVIEW_MIN_VIDEOS, 10);
  assert.strictEqual(M.REVIEW_MIN_MUTED, 25);
  assert.strictEqual(M.REVIEW_MIN_INSTALL_DAYS, 7);
});

test("eligibility never throws on junk input", () => {
  assert.strictEqual(M.reviewPromptEligibility().eligible, false);
  assert.strictEqual(M.reviewPromptEligibility({}).eligible, false);
  assert.strictEqual(M.reviewPromptEligibility({ stats: null }).eligible, false);
});

test("a verdict always carries a reason", () => {
  MATRIX.forEach(function (row) {
    const v = verdict(row[1]);
    assert.ok(typeof v.reason === "string" && v.reason.length > 0, row[0]);
  });
});

// ---- review prompt record ------------------------------------------------

test("makeReviewPromptRecord records when and how it ended", () => {
  assert.deepStrictEqual(M.makeReviewPromptRecord(true, NOW), { shownAt: NOW, dismissed: true });
  assert.deepStrictEqual(M.makeReviewPromptRecord(false, NOW), { shownAt: NOW, dismissed: false });
  // Only a literal true counts as dismissed.
  assert.strictEqual(M.makeReviewPromptRecord("yes", NOW).dismissed, false);
});

test("a record made by simply SHOWING the card already disqualifies forever", () => {
  // The popup writes pm_reviewPrompt the moment the card renders, not on
  // click - otherwise closing the popup would re-ask on every open.
  const shown = M.makeReviewPromptRecord(false, NOW);
  const v = M.reviewPromptEligibility(eligibleInput({ reviewPrompt: shown }));
  assert.strictEqual(v.eligible, false);
  assert.strictEqual(v.reason, "already-prompted");
});

// ---- share + store constants --------------------------------------------

test("there is exactly ONE store item id, and both URLs derive from it", () => {
  assert.ok(M.STORE_URL.indexOf(M.STORE_ITEM_ID) !== -1);
  assert.ok(M.REVIEW_URL.indexOf(M.STORE_ITEM_ID) !== -1);
  assert.strictEqual(M.REVIEW_URL, M.STORE_URL + "/reviews");
});

test("the store id is pinned to the live listing id", () => {
  // Pinned so any change is deliberate: this id ships in every in-extension
  // share and review link, so old builds keep sending users to it for years.
  assert.strictEqual(M.STORE_ITEM_ID, "oejickocjjdcckcjiabjeakcjkjpabgk");
});

test("the repository URL is pinned to the open-source repo", () => {
  // The one place REPO_URL lives; the popup footer and the onboarding
  // colophon both read it from here. Pinned so any change is deliberate,
  // exactly like the store id: old builds keep sending readers to it.
  assert.strictEqual(M.REPO_URL, "https://github.com/profanity-muter/profanity-muter");
});

test("the support address is the real mailbox, pinned so a change is deliberate", () => {
  // Was a placeholder assertion until 0.1.33; now it pins the live
  // address. If the profanitymuter.com domain ever lands this becomes
  // support@profanitymuter.com AND the gmail keeps forwarding, because
  // reports will go on arriving at whatever address shipped in old builds
  // for years.
  assert.strictEqual(M.SUPPORT_EMAIL, "profanity.muter@gmail.com");
});

test("the support address is a role address, never a personal mailbox", () => {
  // It goes out in every problem report's mailto: link, so it lands in
  // strangers' mail clients and address books permanently. A project
  // gmail satisfies that; a person's name in it would not. The earlier
  // no-gmail rule assumed a custom domain the project does not have yet.
  assert.ok(/^[a-z.]+@/.test(M.SUPPORT_EMAIL), M.SUPPORT_EMAIL);
  ["nathanael", "desmond", "natedesmond", "alex", "stone"].forEach(function (needle) {
    assert.strictEqual(M.SUPPORT_EMAIL.toLowerCase().indexOf(needle), -1, needle);
  });
});


test("the share blurb is the agreed copy, and carries the link", () => {
  assert.strictEqual(
    M.SHARE_TEXT,
    "I use Profanity Muter to auto-mute swearing in YouTube videos - " +
      "free, runs entirely on your device: " +
      M.STORE_URL
  );
});

test("the share blurb has no tracking or referral parameters", () => {
  assert.strictEqual(M.SHARE_TEXT.indexOf("?"), -1, "no query string at all");
  ["utm_", "ref=", "referral", "aff"].forEach(function (needle) {
    assert.strictEqual(M.SHARE_TEXT.toLowerCase().indexOf(needle), -1, needle);
  });
});

test("no incentive is promised anywhere in the review or share copy", () => {
  // CWS policy: no compensation, discount, or feature may be offered for
  // a review. Guards against a well-meaning copy edit introducing one.
  const words = ["free trial", "discount", "reward", "unlock", "premium", "coupon", "gift"];
  words.forEach(function (w) {
    assert.strictEqual(M.SHARE_TEXT.toLowerCase().indexOf(w), -1, w);
  });
});

// ---- first-protected callout (0.1.56) -----------------------------------
//
// The introduction fires exactly once per install, on the state the user
// actually read, and obeys the routine-status opt-out. Every one of those is
// invisible until the day it fires on someone else's machine, which is why
// it is a pure predicate with the latch passed in.

test("the callout fires the first time the pill presents Protected", () => {
  assert.strictEqual(M.shouldShowFirstProtected({ presented: "protected", showStatus: true }), true);
});

test("the callout never fires twice", () => {
  const latch = M.makeFirstProtectedRecord(NOW);
  assert.strictEqual(
    M.shouldShowFirstProtected({ presented: "protected", showStatus: true, record: latch }),
    false
  );
  assert.strictEqual(M.firstProtectedAlreadyShown(latch), true);
  assert.strictEqual(M.firstProtectedAlreadyShown(undefined), false);
  assert.strictEqual(M.firstProtectedAlreadyShown({}), false);
});

test("the callout waits for Protected, not for any other presented state", () => {
  // The copy promises "this is where it says Protected", so it may only
  // appear while that word is on screen.
  ["analyzing", "needs-play", "other-tab", "shorts", "live", "off", null, undefined].forEach(
    function (presented) {
      assert.strictEqual(
        M.shouldShowFirstProtected({ presented: presented, showStatus: true }),
        false,
        String(presented)
      );
    }
  );
  assert.strictEqual(M.shouldShowFirstProtected({}), false);
});

test("the callout respects the routine-status opt-out", () => {
  // Pointing at a pill the user has switched off helps nobody.
  assert.strictEqual(M.shouldShowFirstProtected({ presented: "protected", showStatus: false }), false);
});

// ---- the two-step tour (0.1.56, second pass) -----------------------------
//
// Table-driven, because the tour IS a table: two steps, each with an anchor
// and a copy variant, and the failure mode is a box that points at the wrong
// thing, which no unit test catches unless the anchor is asserted.

test("the tour is two steps, anchored at the pill then the toolbar", () => {
  [true, false, undefined, null].forEach(function (pinned) {
    const steps = M.firstProtectedSteps(pinned);
    assert.strictEqual(steps.length, 2, String(pinned));
    assert.deepStrictEqual(steps.map((s) => s.anchor), ["pill", "toolbar"], String(pinned));
    steps.forEach(function (s) {
      assert.ok(Array.isArray(s.lines) && s.lines.length > 0, s.anchor);
    });
  });
});

test("step 1 names the thing it points at and asks for nothing", () => {
  // The old single box said "This badge is your on-page status" while
  // sitting 26px away from the badge with nothing joining them. The copy
  // now names a label the user can read on screen.
  const step = M.firstProtectedSteps(true)[0];
  const text = step.lines.join(" ");
  assert.ok(/label/i.test(text), text);
  assert.ok(/on-page status/i.test(text), text);
  assert.ok(/Protected/.test(text), text);
  assert.ok(!/toolbar|pin/i.test(text), "step 1 must point at one thing only");
  assert.ok(!/review|rate|rating|star|store/i.test(text));
});

test("step 2 forks on pinned, and unknown reads as pinned", () => {
  const cases = [
    { pinned: true, describes: true },
    { pinned: false, describes: false },
    { pinned: undefined, describes: true },
    { pinned: null, describes: true }
  ];
  cases.forEach(function (c) {
    const step = M.firstProtectedSteps(c.pinned)[1];
    const text = step.lines.join(" ");
    if (c.describes) {
      // Describes what the icon already does for them. It makes no claim
      // about their toolbar, which is the only variant that cannot be wrong
      // when we do not know, and it asks them to keep a thing rather than to
      // go and do one.
      assert.ok(/Keep it pinned/.test(text), String(c.pinned));
      assert.ok(/count/i.test(text), String(c.pinned));
      assert.ok(!/puzzle-piece/i.test(text), String(c.pinned));
      // No picture on this branch: they have the icon, there is nothing to
      // find, and a menu drawing would be a diagram of a solved problem.
      assert.strictEqual(step.image, undefined, String(c.pinned));
      assert.strictEqual(step.markers, undefined, String(c.pinned));
    } else {
      // Tells them how to get it, numbered, with the drawing that shows the
      // two controls. Advice to pin an already pinned icon teaches the user
      // this extension does not know what it is looking at.
      assert.ok(/puzzle-piece/i.test(text), String(c.pinned));
      assert.ok(/\bpin\b/i.test(text), String(c.pinned));
      assert.ok(/1\./.test(text) && /2\./.test(text), "the two clicks are numbered");
    }
    assert.ok(!/review|rate|rating|star|store/i.test(text));
  });
});

test("the unpinned step carries the picture", () => {
  // The card is the whole point of the unpinned branch: the sentence names
  // a control, the drawing points at it. If the descriptor goes missing the
  // renderer silently falls back to a text box that reads like the old one.
  const step = M.firstProtectedSteps(false)[1];
  assert.strictEqual(step.image, "onboarding/pin-menu.png");
  assert.strictEqual(step.image, M.PIN_MENU_IMAGE);
});

test("nothing is layered over the picture any more", () => {
  // The rings came out because the drawing already numbers and gold-rings
  // its own two controls, and a second set of circles on top read as extra
  // circles rather than as a cue. A descriptor field nobody renders is the
  // way that quietly comes back.
  const step = M.firstProtectedSteps(false)[1];
  assert.strictEqual(step.markers, undefined, "no markers field on the step");
  assert.strictEqual(typeof M.pinMenuMarkers, "undefined");
  assert.strictEqual(typeof M.PIN_MENU_MARKER_PX, "undefined");
  assert.strictEqual(typeof M.PIN_MENU_IMAGE_W, "undefined");
  assert.strictEqual(typeof M.PIN_MENU_IMAGE_H, "undefined");
});

test("no ring class survives in the surfaces that drew them", () => {
  // Deleted, not hidden. A rule left behind with nothing matching it is the
  // thing a later pass reads as still in use and wires back up. Greps the
  // three files that ever carried one.
  const root = path.join(__dirname, "..");
  [
    "content.js",
    path.join("onboarding", "onboarding.html"),
    path.join("onboarding", "onboarding.css")
  ].forEach(function (rel) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    ["pm-tour-ring", "ob-figure-ring", "TOUR_RING_CSS", "ob-figure-frame"].forEach(
      function (needle) {
        assert.strictEqual(src.indexOf(needle), -1, needle + " is still in " + rel);
      }
    );
  });
});

test("the Pin it step shows the payoff before the reason for it", () => {
  // Order on the page, in the file: title, then the five badge states under
  // "What the pinned icon tells you", then the paragraph explaining why the
  // icon is hidden, then the two clicks. Asking someone to pin a thing before
  // showing what it will tell them is asking for a chore.
  const html = fs.readFileSync(
    path.join(__dirname, "..", "onboarding", "onboarding.html"),
    "utf8"
  );
  const step = html.slice(html.indexOf('id="ob-step-4"'), html.indexOf("</section>", html.indexOf('id="ob-step-4"')));
  const order = [
    ">Pin the badge to see it working<",
    "What the pinned icon tells you",
    "The toolbar icon is where you see the filter working",
    "puzzle-piece icon</strong> in the Chrome toolbar",
    "pin-menu.png",
    'id="ob-pin-state"'
  ].map(function (needle) {
    const at = step.indexOf(needle);
    assert.ok(at > 0, "missing from the Pin it step: " + needle);
    return at;
  });
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], "out of order at position " + i);
  }
});

test("the card gets a longer dwell than the text step, and still retires", () => {
  // Two lines plus a drawing with two markers to find does not fit in the
  // 20s a two-line box gets. Both are finite: a notice that waits forever
  // stops being a notice and becomes something to deal with.
  assert.ok(M.FIRST_PROTECTED_CARD_VISIBLE_MS > M.FIRST_PROTECTED_VISIBLE_MS);
  assert.strictEqual(M.FIRST_PROTECTED_CARD_VISIBLE_MS, 30000);
  assert.ok(M.FIRST_PROTECTED_CARD_VISIBLE_MS < 60000, "still retires itself");
});

test("both steps point up here, not at some other page", () => {
  // "up here" is the whole gesture of step 2: it is rendered in the corner
  // of the viewport nearest the toolbar, and the copy has to agree with the
  // position or the box is back to being a random box.
  [true, false].forEach(function (pinned) {
    assert.ok(/up here/i.test(M.firstProtectedSteps(pinned)[1].lines.join(" ")), String(pinned));
  });
});

test("firstProtectedLines has left this module", () => {
  // The one-box version. A lingering export would be a second, stale answer
  // to "what does the introduction say".
  assert.strictEqual(typeof M.firstProtectedLines, "undefined");
});

// ---- the onboarding pin arrow (0.1.56, second pass) ----------------------

test("the pin arrow shows only on the pin step, and only until it is pinned", () => {
  const rows = [
    { step: 4, pinStep: 4, pinned: undefined, want: true },  // not asked yet
    { step: 4, pinStep: 4, pinned: false, want: true },      // asked, not pinned
    { step: 4, pinStep: 4, pinned: true, want: false },      // done, stop pointing
    { step: 1, pinStep: 4, pinned: false, want: false },
    { step: 3, pinStep: 4, pinned: undefined, want: false },
    { step: 5, pinStep: 4, pinned: false, want: false }
  ];
  rows.forEach(function (r) {
    assert.strictEqual(M.shouldShowPinArrow(r), r.want, JSON.stringify(r));
  });
  assert.strictEqual(M.shouldShowPinArrow(), false);
  assert.strictEqual(M.shouldShowPinArrow({}), false);
});

test("the callout latch is the same shape as the milestone latch", () => {
  // One shape for one-time sync latches, so a support paste of storage
  // reads the same way for both.
  assert.deepStrictEqual(Object.keys(M.makeFirstProtectedRecord(NOW)), ["shownAt"]);
  assert.strictEqual(M.makeFirstProtectedRecord(NOW).shownAt, NOW);
});

test("badgeDecision has left this module", () => {
  // 0.1.56: the badge became a mirror of the pill and moved to
  // shared/badge.js, and the review nudge left the badge entirely. A
  // lingering export here would be a second, stale answer to the same
  // question.
  assert.strictEqual(typeof M.badgeDecision, "undefined");
  assert.strictEqual(typeof M.BADGE_REVIEW_TEXT, "undefined");
});

// ---- milestone pill (0.1.33) --------------------------------------------

test("the milestone fires once, when eligibility is first reached", () => {
  assert.strictEqual(M.shouldShowMilestone({ eligible: true, showStatus: true }), true);
});

test("the milestone never fires twice", () => {
  const latch = M.makeMilestoneRecord(NOW);
  assert.strictEqual(
    M.shouldShowMilestone({ eligible: true, showStatus: true, milestoneRecord: latch }),
    false
  );
  assert.strictEqual(M.milestoneAlreadyShown(latch), true);
  assert.strictEqual(M.milestoneAlreadyShown(undefined), false);
  assert.strictEqual(M.milestoneAlreadyShown({}), false);
});

test("the milestone respects the routine-status opt-out", () => {
  // Unlike the health warning, this IS routine status: pm_showStatus=false
  // means no.
  assert.strictEqual(M.shouldShowMilestone({ eligible: true, showStatus: false }), false);
});

test("the milestone does not fire before the milestone is reached", () => {
  assert.strictEqual(M.shouldShowMilestone({ eligible: false, showStatus: true }), false);
  assert.strictEqual(M.shouldShowMilestone({}), false);
});

test("milestoneText states a count and asks for nothing", () => {
  assert.strictEqual(M.milestoneText({ videosProtected: 10 }), "10 videos protected");
  assert.strictEqual(M.milestoneText({ videosProtected: 0 }), "");
  assert.strictEqual(M.milestoneText({}), "");
  assert.strictEqual(M.milestoneText(null), "");
  // Policy-critical: product status, not review copy.
  assert.ok(!/review|rate|rating|star|store/i.test(M.milestoneText({ videosProtected: 12 })));
});

test("the milestone reuses the review milestone rather than inventing one", () => {
  // Two definitions of "enough usage" would be two things to keep in sync.
  const v = M.reviewPromptEligibility(eligibleInput());
  assert.strictEqual(M.shouldShowMilestone({ eligible: v.eligible, showStatus: true }), true);
});

test("acting on the completion ask silences the popup strip and the pill too", () => {
  const record = M.completionReviewOutcome(true, NOW);
  const v = M.reviewPromptEligibility(eligibleInput({ reviewPrompt: record }));
  assert.strictEqual(v.eligible, false);
  assert.strictEqual(M.shouldShowMilestone({ eligible: v.eligible, showStatus: true }), false);
});

// ---- completion review module (0.1.33) ----------------------------------

test("clicking Leave a review at completion retires every later ask", () => {
  // Someone who has been asked and acted should not be asked again;
  // asking twice reads as not listening. Implemented by reusing
  // pm_reviewPrompt so there is ONE definition of "already asked".
  const record = M.completionReviewOutcome(true, NOW);
  assert.deepStrictEqual(record, { shownAt: NOW, dismissed: true });
  const v = M.reviewPromptEligibility(eligibleInput({ reviewPrompt: record }));
  assert.strictEqual(v.eligible, false);
  assert.strictEqual(v.reason, "already-prompted");
});

test("'maybe later' at completion retires NOTHING", () => {
  // At minute zero a decline is not a verdict: that user is exactly who
  // the milestone surface exists for, once they have some experience.
  assert.strictEqual(M.completionReviewOutcome(false, NOW), null);
  assert.strictEqual(M.reviewPromptEligibility(eligibleInput()).eligible, true);
});

test("growth counters start at zero and increment one at a time", () => {
  let g = M.bumpGrowthCounter(null, "completionReviewShown");
  assert.deepStrictEqual(g, {
    completionReviewShown: 1,
    completionReviewClicked: 0,
    completionReviewDismissed: 0,
    milestoneReviewClicked: 0
  });
  g = M.bumpGrowthCounter(g, "completionReviewShown");
  g = M.bumpGrowthCounter(g, "milestoneReviewClicked");
  assert.strictEqual(g.completionReviewShown, 2);
  assert.strictEqual(g.milestoneReviewClicked, 1);
  assert.strictEqual(g.completionReviewClicked, 0);
});

test("growth counters survive a corrupted or partial stored record", () => {
  const g = M.bumpGrowthCounter({ completionReviewShown: "nonsense", extra: 5 }, "completionReviewClicked");
  assert.strictEqual(g.completionReviewShown, 0);
  assert.strictEqual(g.completionReviewClicked, 1);
  assert.strictEqual("extra" in g, false, "unknown keys are dropped, not carried");
});

test("an unknown counter name changes nothing", () => {
  const before = M.bumpGrowthCounter(null, "completionReviewShown");
  assert.deepStrictEqual(M.bumpGrowthCounter(before, "notACounter"), before);
});

test("there are exactly four local-only counters", () => {
  assert.deepStrictEqual(M.GROWTH_COUNTERS, [
    "completionReviewShown",
    "completionReviewClicked",
    "completionReviewDismissed",
    "milestoneReviewClicked"
  ]);
});

// ---- summary -------------------------------------------------------------

console.log("moments_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
