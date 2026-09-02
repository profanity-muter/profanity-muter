// shared/moments.js
// Plain script (NOT an ES module), loaded by popup/popup.html and
// onboarding/onboarding.html, and require()d by background.js's tests.
// Defines globalThis.PMMoments.
//
// WHAT A "MOMENT" IS
// ------------------
// The three surfaces added in 0.1.30 — the first-run onboarding flow, the
// review prompt, and the share row — are all the same shape of decision:
// "given what storage says about this install, should we say something to
// the user right now?". Each is a small, purely-arithmetic predicate over
// a handful of storage keys, and each is exactly the kind of thing that
// rots into an untestable tangle of `if`s scattered through popup.js if
// it is written where it is displayed.
//
// So the predicates live here, pure, and the UI files only render what
// they are told. Nothing in this file touches chrome.*, the DOM, or the
// clock — `now` is always passed in — which is what makes the eligibility
// matrix in test/moments_test.js able to cover every gate.
//
// Storage schema (chrome.storage.sync) — all four keys are owned here and
// by the popup/onboarding pages; none are read by the content scripts or
// by shared/wordlist.js, so none are in its STORAGE_KEYS:
//
//   pm_onboarded    boolean  default false — the onboarding tab has been
//                   AUTO-OPENED once. Set by background.js the first time
//                   it opens the tab on install, and never consulted
//                   again except to not do that twice. Deliberately NOT
//                   the same thing as "the user finished onboarding":
//                   they can close the tab immediately, which is why the
//                   acknowledgment below is tracked separately.
//
//   pm_ackNotPerfect  {version, timestamp} | absent — the user explicitly
//                   acknowledged that this extension will not catch
//                   everything. `version` is ACK_VERSION, so a future
//                   material change to what is being acknowledged can
//                   require a fresh one rather than silently inheriting
//                   consent to different words. Until this exists, the
//                   popup shows a slim "Finish setup" banner.
//
//   pm_installedAt  number (epoch ms) | absent — when the extension was
//                   installed. Written once by background.js's
//                   onInstalled handler. See NOTE ON BACKFILL below.
//
//   pm_reviewPrompt {shownAt, dismissed} | absent — the review prompt has
//                   been shown. Its mere EXISTENCE is what makes the
//                   prompt never appear again; `dismissed` records which
//                   button ended it, for nothing but honesty in a support
//                   log. There is no "ask me later".
//
// NOTE ON BACKFILL: an install that predates 0.1.30 has no pm_installedAt.
// background.js backfills it with `now` on update, which means those users
// wait a further 7 days before becoming review-eligible. That is the
// deliberate choice: the alternative (treating an unknown install date as
// old enough) would prompt every existing user the moment they updated,
// which is precisely the "surprise nag" behaviour the 7-day gate exists to
// prevent.

(function (root) {
  "use strict";

  // ---- one-constant URLs -------------------------------------------------
  //
  // TODO(listing): the extension is not on the Chrome Web Store yet, so
  // there is no item id to point at. Both URLs below are placeholders and
  // are the ONLY place either link exists — when the listing goes live,
  // replace STORE_ITEM_ID here and nothing else needs to change.
  //
  // The review URL shape is the canonical CWS one:
  //   https://chromewebstore.google.com/detail/<id>/reviews
  var STORE_ITEM_ID = "TODO_CHROME_WEB_STORE_ITEM_ID";
  var STORE_URL = "https://chromewebstore.google.com/detail/" + STORE_ITEM_ID;
  var REVIEW_URL = STORE_URL + "/reviews";

  // The share blurb. Plain, first-person, no adjectives doing sales work,
  // no referral code and no tracking parameter on the URL — the whole
  // point is that a parent can paste this into a group chat without
  // feeling like they are forwarding an ad.
  var SHARE_TEXT =
    "I use Profanity Muter to auto-mute swearing in YouTube videos — " +
    "free, runs entirely on your device: " +
    STORE_URL;

  // ---- acknowledgment ----------------------------------------------------
  //
  // Bumping ACK_VERSION invalidates every existing acknowledgment and
  // re-shows the banner. Only do that for a MATERIAL change to what is
  // being acknowledged — not for copy edits.
  var ACK_VERSION = 1;

  function makeAckRecord(now) {
    return {
      version: ACK_VERSION,
      timestamp: typeof now === "number" ? now : Date.now()
    };
  }

  // Is this a valid acknowledgment for the CURRENT ack version? A record
  // from an older version reads as "not acknowledged", which is the point
  // of versioning it.
  function isAcknowledged(record) {
    return !!(
      record &&
      typeof record === "object" &&
      record.version === ACK_VERSION &&
      typeof record.timestamp === "number" &&
      isFinite(record.timestamp)
    );
  }

  // ---- review prompt -----------------------------------------------------
  //
  // CHROME WEB STORE POLICY — these are not preferences, they are the
  // rules this surface must obey, and every one of them is enforced by
  // reviewPromptEligibility below rather than by convention:
  //
  //   * Shown AT MOST ONCE, ever. Once pm_reviewPrompt exists, this
  //     function returns not-eligible forever. There is no "remind me
  //     later" state, on purpose — that is how "at most once" quietly
  //     becomes "repeatedly".
  //   * Dismissal is PERMANENT.
  //   * No incentive of any kind is offered for reviewing, and no rating
  //     is solicited before sending the user to the store (no "was this
  //     helpful? -> only positives get the review link" funnel).
  //   * Nothing about the extension is gated, degraded, delayed, or
  //     nagged based on whether the user reviews. The prompt is a card
  //     that can be dismissed and never returns.
  //   * It is a card INSIDE the popup — never a new tab, never a
  //     notification, never an interstitial.
  //
  // The milestone gates below exist so the ask lands only on someone with
  // a real basis for an opinion: 10 videos protected AND 25 words muted
  // AND a week of ownership. Asking earlier produces both worse reviews
  // and a worse product.
  var REVIEW_MIN_VIDEOS = 10;
  var REVIEW_MIN_MUTED = 25;
  var REVIEW_MIN_INSTALL_DAYS = 7;
  var DAY_MS = 24 * 60 * 60 * 1000;

  // Returns {eligible: boolean, reason: string}. `reason` is always set —
  // "eligible" when it is, otherwise the FIRST gate that failed, which is
  // what makes a support question ("why am I not seeing it?") answerable.
  //
  // Gate order is deliberate: cheap/absolute disqualifiers first, so the
  // reason reported is the most fundamental one rather than whichever
  // happened to be checked last.
  function reviewPromptEligibility(input) {
    input = input || {};
    var now = typeof input.now === "number" ? input.now : Date.now();
    var stats = input.stats || {};
    var prompt = input.reviewPrompt;

    // Already shown (whichever way it ended) -> never again.
    if (prompt && typeof prompt === "object") {
      return { eligible: false, reason: "already-prompted" };
    }
    // Never ask someone who has not finished onboarding: they have not
    // even been told what the extension does or does not promise.
    if (!isAcknowledged(input.ack)) {
      return { eligible: false, reason: "not-acknowledged" };
    }
    if (typeof input.installedAt !== "number" || !isFinite(input.installedAt)) {
      return { eligible: false, reason: "no-install-date" };
    }
    // Guard a clock that has moved backwards (or an installedAt in the
    // future from a device clock skew) — treat it as "not old enough"
    // rather than computing a negative age and passing every gate.
    var ageMs = now - input.installedAt;
    if (ageMs < REVIEW_MIN_INSTALL_DAYS * DAY_MS) {
      return { eligible: false, reason: "too-new" };
    }
    var videos = Number(stats.videosProtected);
    var muted = Number(stats.totalMuted);
    if (!isFinite(videos) || videos < REVIEW_MIN_VIDEOS) {
      return { eligible: false, reason: "not-enough-videos" };
    }
    if (!isFinite(muted) || muted < REVIEW_MIN_MUTED) {
      return { eligible: false, reason: "not-enough-mutes" };
    }
    return { eligible: true, reason: "eligible" };
  }

  function makeReviewPromptRecord(dismissed, now) {
    return {
      shownAt: typeof now === "number" ? now : Date.now(),
      dismissed: dismissed === true
    };
  }

  // ---- onboarding --------------------------------------------------------

  function isOnboarded(value) {
    return value === true;
  }

  // Should background.js auto-open the onboarding tab? Only on a genuine
  // first install, and only once. An UPDATE must never steal a tab from
  // someone who is mid-video — an update the user did not ask for is the
  // worst possible moment to take over the screen.
  function shouldAutoOpenOnboarding(reason, onboardedFlag) {
    return reason === "install" && !isOnboarded(onboardedFlag);
  }

  var PMMomentsCore = {
    STORE_ITEM_ID: STORE_ITEM_ID,
    STORE_URL: STORE_URL,
    REVIEW_URL: REVIEW_URL,
    SHARE_TEXT: SHARE_TEXT,
    ACK_VERSION: ACK_VERSION,
    REVIEW_MIN_VIDEOS: REVIEW_MIN_VIDEOS,
    REVIEW_MIN_MUTED: REVIEW_MIN_MUTED,
    REVIEW_MIN_INSTALL_DAYS: REVIEW_MIN_INSTALL_DAYS,
    DAY_MS: DAY_MS,
    makeAckRecord: makeAckRecord,
    isAcknowledged: isAcknowledged,
    reviewPromptEligibility: reviewPromptEligibility,
    makeReviewPromptRecord: makeReviewPromptRecord,
    isOnboarded: isOnboarded,
    shouldAutoOpenOnboarding: shouldAutoOpenOnboarding
  };

  root.PMMoments = PMMomentsCore;

  // Also expose via module.exports for Node tests, without turning this
  // into an ES module (same pattern as wordlist.js/devlog.js/lock.js).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMMomentsCore: PMMomentsCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
