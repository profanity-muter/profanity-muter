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

test("the store id is still the TODO placeholder (fails once the listing is live)", () => {
  // Deliberately asserted: when the extension is actually listed, this
  // test fails and forces the id to be replaced in shared/moments.js
  // rather than a placeholder shipping silently in a share link.
  assert.strictEqual(M.STORE_ITEM_ID, "TODO_CHROME_WEB_STORE_ITEM_ID");
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

// ---- summary -------------------------------------------------------------

console.log("moments_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
