// shared/moments.js
// Plain script (NOT an ES module), loaded by popup/popup.html and
// onboarding/onboarding.html, and require()d by background.js's tests.
// Defines globalThis.PMMoments.
//
// WHAT A "MOMENT" IS
// ------------------
// The three surfaces added in 0.1.30 - the first-run onboarding flow, the
// review prompt, and the share row - are all the same shape of decision:
// "given what storage says about this install, should we say something to
// the user right now?". Each is a small, purely-arithmetic predicate over
// a handful of storage keys, and each is exactly the kind of thing that
// rots into an untestable tangle of `if`s scattered through popup.js if
// it is written where it is displayed.
//
// So the predicates live here, pure, and the UI files only render what
// they are told. Nothing in this file touches chrome.*, the DOM, or the
// clock - `now` is always passed in - which is what makes the eligibility
// matrix in test/moments_test.js able to cover every gate.
//
// Storage schema (chrome.storage.sync) - all four keys are owned here and
// by the popup/onboarding pages; none are read by the content scripts or
// by shared/wordlist.js, so none are in its STORAGE_KEYS:
//
//   pm_onboarded    boolean  default false - the onboarding tab has been
//                   AUTO-OPENED once. Set by background.js the first time
//                   it opens the tab on install, and never consulted
//                   again except to not do that twice. Deliberately NOT
//                   the same thing as "the user finished onboarding":
//                   they can close the tab immediately, which is why the
//                   acknowledgment below is tracked separately.
//
//   pm_ackNotPerfect  {version, timestamp} | absent - the user explicitly
//                   acknowledged that this extension will not catch
//                   everything. `version` is ACK_VERSION, so a future
//                   material change to what is being acknowledged can
//                   require a fresh one rather than silently inheriting
//                   consent to different words. Until this exists, the
//                   popup shows a slim "Finish setup" banner.
//
//   pm_installedAt  number (epoch ms) | absent - when the extension was
//                   installed. Written once by background.js's
//                   onInstalled handler. See NOTE ON BACKFILL below.
//
//   pm_reviewPrompt {shownAt, dismissed} | absent - the review prompt has
//                   been shown. Its mere EXISTENCE is what makes the
//                   prompt never appear again; `dismissed` records which
//                   button ended it, for nothing but candor in a support
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
  // are the ONLY place either link exists - when the listing goes live,
  // replace STORE_ITEM_ID here and nothing else needs to change.
  //
  // The review URL shape is the canonical CWS one:
  //   https://chromewebstore.google.com/detail/<id>/reviews
  var STORE_ITEM_ID = "oejickocjjdcckcjiabjeakcjkjpabgk";
  var STORE_URL = "https://chromewebstore.google.com/detail/" + STORE_ITEM_ID;
  var REVIEW_URL = STORE_URL + "/reviews";

  // Where "View source on GitHub" sends people. The extension is open
  // source, and this is the ONE place the repository URL lives - the popup
  // and the onboarding flow both read it from here rather than hardcoding a
  // second copy in markup, exactly as they do with STORE_URL/REVIEW_URL.
  // test/moments_test.js pins it so any change is deliberate.
  var REPO_URL = "https://github.com/profanity-muter/profanity-muter";

  // Where "Report a problem" sends its mail.
  //
  // This MUST stay a role address the project controls, never a personal
  // mailbox: it goes out in the mailto: link of every problem report, so
  // it ends up in strangers' mail clients and address books permanently.
  // A project gmail satisfies that (nobody's name is in it) and is what
  // exists today; it swaps to support@profanitymuter.com if and when that
  // domain lands, at which point the gmail should keep forwarding rather
  // than simply disappear, since reports will go on arriving at whatever
  // address shipped in old builds for years. test/moments_test.js pins
  // this value so any change has to be deliberate.
  var SUPPORT_EMAIL = "profanity.muter@gmail.com";

  // The share blurb. Plain, first-person, no adjectives doing sales work,
  // no referral code and no tracking parameter on the URL - the whole
  // point is that a parent can paste this into a group chat without
  // feeling like they are forwarding an ad.
  var SHARE_TEXT =
    "I use Profanity Muter to auto-mute swearing in YouTube videos - " +
    "free, runs entirely on your device: " +
    STORE_URL;

  // ---- acknowledgment ----------------------------------------------------
  //
  // Bumping ACK_VERSION invalidates every existing acknowledgment and
  // re-shows the banner. Only do that for a MATERIAL change to what is
  // being acknowledged - not for copy edits.
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
  // CHROME WEB STORE POLICY - these are not preferences, they are the
  // rules this surface must obey, and every one of them is enforced by
  // reviewPromptEligibility below rather than by convention:
  //
  //   * Shown AT MOST ONCE, ever. Once pm_reviewPrompt exists, this
  //     function returns not-eligible forever. There is no "remind me
  //     later" state, on purpose - that is how "at most once" quietly
  //     becomes "repeatedly".
  //   * Dismissal is PERMANENT.
  //   * No incentive of any kind is offered for reviewing, and no rating
  //     is solicited before sending the user to the store (no "was this
  //     helpful? -> only positives get the review link" funnel).
  //   * Nothing about the extension is gated, degraded, delayed, or
  //     nagged based on whether the user reviews. The prompt is a card
  //     that can be dismissed and never returns.
  //   * It is a card INSIDE the popup - never a new tab, never a
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

  // Returns {eligible: boolean, reason: string}. `reason` is always set -
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
    // future from a device clock skew) - treat it as "not old enough"
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

  // ---- toolbar badge: moved out (0.1.56) ---------------------------------
  //
  // badgeDecision used to live here and owned two things: the per-tab health
  // "!" and a global "1" for the once-ever review nudge. Both are gone from
  // this file.
  //
  // The health case, plus the live protected/analyzing/grey states added in
  // 0.1.56, now live in shared/badge.js, because the badge stopped being a
  // two-case alert and became a mirror of the on-player pill. Health still
  // outranks everything there; that promise moved with the code.
  //
  // The review nudge is off the badge entirely. A "1" on the toolbar is the
  // universal shape of "you have a message", and spending it on an ask that
  // the popup already renders as a card cost us the one glanceable channel
  // the extension owns, at exactly the moment a new user needed it to say
  // "protected". The ask is unchanged and still governed by
  // reviewPromptEligibility below; it is simply rendered where it always
  // did its real work, in the popup.

  // ---- first-protected tour (0.1.56) -------------------------------------
  //
  // The other half of the same field observation. The pill is small, sits
  // in a corner of a player full of YouTube's own chrome, and says
  // "Protected" to someone who has never been told there is a pill. So the
  // first time filtering actually starts after install, the user gets a
  // two-step tour: one box pointing at the pill, then one pointing up at
  // the toolbar. See firstProtectedSteps below for why it is two.
  //
  // ONE TIME, EVER, latched in chrome.storage.sync (pm_firstProtectedSeen
  // {shownAt}), the same store and the same shape as pm_milestoneShown. Sync
  // rather than local on purpose: this is an introduction, and someone who
  // has already been introduced on their laptop should not be introduced
  // again on their desktop.
  //
  // It is routine status, so pm_showStatus=false suppresses it, exactly like
  // the milestone. Someone who has turned the pill off is not going to be
  // helped by a callout pointing at the pill.
  var FIRST_PROTECTED_VISIBLE_MS = 20000;

  // The unpinned step 2 is a card with a picture in it, and 20 seconds is
  // barely enough to read two lines, let alone find both markers in a
  // drawing. It still retires itself: a notice that waits forever is a
  // notice the user has to deal with.
  var FIRST_PROTECTED_CARD_VISIBLE_MS = 30000;

  function makeFirstProtectedRecord(now) {
    return { shownAt: typeof now === "number" ? now : Date.now() };
  }

  function firstProtectedAlreadyShown(record) {
    return !!(record && typeof record === "object" && typeof record.shownAt === "number");
  }

  // The gate. `presented` is shared/pill.js present().presented, so the
  // callout fires on the state the USER READ rather than on any internal
  // kind: the promise it makes ("this is where it says Protected") is only
  // true when the word Protected is actually on screen.
  function shouldShowFirstProtected(state) {
    state = state || {};
    if (state.showStatus === false) return false; // routine status opt-out
    if (firstProtectedAlreadyShown(state.record)) return false;
    return state.presented === "protected";
  }

  // The tour's copy, as an ordered list of steps (0.1.56, second pass).
  //
  // The first build was ONE box of three lines sitting under the pill,
  // naming the pill and the toolbar in the same breath. The product owner
  // read it as "a random box": a paragraph that mentions two surfaces
  // points at neither, and the user has to guess which words go with which
  // part of the screen. So it is two steps, each one aimed at exactly one
  // thing, and each one rendered where that thing actually is: step 1 hangs
  // off the pill with a caret touching it, step 2 sits up in the corner of
  // the viewport under the browser toolbar.
  //
  // `anchor` is the contract between this model and the renderer: "pill" is
  // positioned against shared/pill.js's BADGE_* geometry inside the player,
  // "toolbar" is fixed to the top-right of the viewport. Naming the anchor
  // here rather than inferring it from the index means a later third step
  // cannot silently inherit the wrong position.
  //
  // Step 2's copy forks on `pinned` because the two audiences need opposite
  // things. A user who pinned the icon needs to be told what it says; a user
  // who has not needs to be told how to get it, and telling someone to pin
  // an icon they already pinned teaches them this extension does not know
  // what it is talking about. Unknown (getUserSettings missing or throwing)
  // resolves to the pinned copy: it makes no claim about their toolbar, so
  // it is the only variant that cannot be wrong.
  // The Pin it picture, and where its two numbered markers sit (0.1.56,
  // third pass). The onboarding step already carried this drawing; the tour's
  // unpinned branch now carries the SAME file, because a user who never
  // finished onboarding is exactly the user step 2 is talking to, and two
  // drawings of one menu is two things to keep true.
  //
  // The marker coordinates are the ones in tools/pin-menu-mockup.html,
  // verbatim: .num is a 30px circle positioned from the TOP and the RIGHT of
  // a 760x430 drawing. Kept as those raw numbers rather than as the finished
  // percentages so that moving a circle in the mockup is one edit here, and
  // so the conversion is a function a node test can check rather than four
  // magic percentages pasted into a stylesheet.
  var PIN_MENU_IMAGE = "onboarding/pin-menu.png";
  var PIN_MENU_IMAGE_W = 760;
  var PIN_MENU_IMAGE_H = 430;
  var PIN_MENU_MARKER_PX = [
    { topPx: 62, rightPx: 150, sizePx: 30 },
    { topPx: 284, rightPx: 60, sizePx: 30 }
  ];

  // Percentages of the image box, so a ring drawn on top stays on its marker
  // at any rendered width. Rounded to 2dp: a stylesheet and a test both have
  // to write the same literal, and full float noise makes that a trap.
  function pinMenuMarkers() {
    var out = [];
    for (var i = 0; i < PIN_MENU_MARKER_PX.length; i++) {
      var m = PIN_MENU_MARKER_PX[i];
      var cx = PIN_MENU_IMAGE_W - m.rightPx - m.sizePx / 2;
      var cy = m.topPx + m.sizePx / 2;
      out.push({
        x: Math.round((cx / PIN_MENU_IMAGE_W) * 10000) / 100,
        y: Math.round((cy / PIN_MENU_IMAGE_H) * 10000) / 100
      });
    }
    return out;
  }

  function firstProtectedSteps(pinned) {
    return [
      {
        anchor: "pill",
        lines: [
          "That label is your on-page status.",
          "It reads Protected while this video is being filtered."
        ]
      },
      pinned === false
        ? {
            // The instruction card. Two lines and the picture, because
            // "click the puzzle-piece icon" is still only a sentence to
            // someone who has never seen that menu open: the drawing is the
            // part that actually points. It gets the longer dwell below.
            anchor: "toolbar",
            lines: [
              "Pin it to keep it in view:",
              "1. Click the puzzle-piece icon up here. 2. Click the pin next to Profanity Muter."
            ],
            image: PIN_MENU_IMAGE,
            markers: pinMenuMarkers()
          }
        : {
            anchor: "toolbar",
            lines: [
              "Keep it pinned. The icon up here shows the status of every video, plus a count of words muted."
            ]
          }
    ];
  }

  // ---- onboarding pin arrow (0.1.56, second pass) ------------------------
  //
  // The Pin it step says "the puzzle-piece icon in the Chrome toolbar", and
  // a user who has never pinned an extension does not know which of the
  // things up there that is. So the step also throws a bouncing arrow at the
  // top-right of the page, roughly under where the puzzle piece sits.
  //
  // Pure, because the interesting part is when it must NOT show: it is
  // advice, and advice that outlives its problem is noise. It goes the
  // instant the poll reports the icon pinned, and it never appears on any
  // other step. Unknown pinned-ness (the API is missing) still shows it,
  // which is the opposite of the callout's rule and deliberately so: here
  // the arrow only says where a menu is, which is true either way.
  function shouldShowPinArrow(state) {
    state = state || {};
    // Both numbers, explicitly: a caller that has not wired up the step
    // numbers yet would otherwise match undefined against undefined and show
    // a fixed-position arrow on every page that loads this file.
    if (typeof state.step !== "number" || typeof state.pinStep !== "number") return false;
    if (state.step !== state.pinStep) return false;
    return state.pinned !== true;
  }

  // ---- milestone pill -----------------------------------------------------
  //
  // The badge only reaches users who pinned the toolbar icon, and most
  // people never do. The on-player status pill reaches everyone, so it gets
  // ONE informational moment when the usage milestone is first reached:
  // "N videos protected", shown once, briefly, and never again.
  //
  // What this is NOT: review copy. No mention of reviews, ratings or the
  // store, and it asks for nothing. It is product status that happens to
  // make the next popup open a little likelier, which keeps it clear of the
  // promotional-injection problem that putting a real ask on the page would
  // create.
  //
  // Because it IS routine status, pm_showStatus=false suppresses it
  // entirely, unlike the health warning.
  //
  // Storage (chrome.storage.sync): pm_milestoneShown {shownAt} | absent.
  var MILESTONE_VISIBLE_MS = 8000;

  function makeMilestoneRecord(now) {
    return { shownAt: typeof now === "number" ? now : Date.now() };
  }

  function milestoneAlreadyShown(record) {
    return !!(record && typeof record === "object" && typeof record.shownAt === "number");
  }

  // The one-shot latch, as a pure predicate. `eligible` is the review
  // milestone being reached, reused deliberately: the moment worth
  // mentioning and the moment worth asking about a review are the same
  // moment, and two definitions of "enough usage" would be two things to
  // keep in sync.
  function shouldShowMilestone(state) {
    state = state || {};
    if (state.showStatus === false) return false; // routine status opt-out
    if (milestoneAlreadyShown(state.milestoneRecord)) return false;
    return state.eligible === true;
  }

  // The pill's text. Counts only, no adjectives, no ask.
  function milestoneText(stats) {
    var videos = Number(stats && stats.videosProtected);
    if (!isFinite(videos) || videos <= 0) return "";
    return videos + " videos protected";
  }

  // ---- completion review module (0.1.33) ----------------------------------
  //
  // The completion page is the highest-traffic point in the product:
  // effectively everyone who installs reaches it, and almost nobody
  // navigates back to the popup afterwards. So the review ask lives there,
  // designed rather than whispered.
  //
  // WHAT IT MUST NOT DO, absolute rather than stylistic:
  //   * No incentive of any kind, in copy or in product behaviour.
  //   * Nothing gated, delayed or degraded for declining.
  //   * Declining is one plain click, with no ceremony and no guilt copy.
  //     "Maybe later" is a real answer, not a retry prompt.
  //   * No fake social proof, no pre-filled stars, no invented counts.
  //
  // WHAT MAKES IT WORK inside that: it asks for support of the project
  // rather than a verdict on a product nobody has used yet. At minute zero
  // "is it working well?" has no answer, and asking anyway invites an
  // uninformed rating; "reviews decide whether people find this" is both
  // true and answerable on day one.
  //
  // Local-only counters (chrome.storage.local, pm_growth) exist so
  // conversion can be read off a devlog or a problem report later. No
  // network, ever.
  var GROWTH_COUNTERS = [
    "completionReviewShown",
    "completionReviewClicked",
    "completionReviewDismissed",
    "milestoneReviewClicked"
  ];

  function bumpGrowthCounter(record, key) {
    var out = {};
    var src = record && typeof record === "object" ? record : {};
    for (var i = 0; i < GROWTH_COUNTERS.length; i++) {
      var name = GROWTH_COUNTERS[i];
      var n = Number(src[name]);
      out[name] = isFinite(n) && n > 0 ? n : 0;
    }
    if (GROWTH_COUNTERS.indexOf(key) !== -1) out[key] = out[key] + 1;
    return out;
  }

  // Acting on the completion ask retires every later review surface: the
  // milestone card, its badge, and its pill. Someone who has been asked and
  // acted should not be asked again; asking twice reads as not listening.
  // Reusing pm_reviewPrompt for it means there is ONE definition of
  // "already asked" rather than a second flag to keep in sync.
  //
  // Declining retires NOTHING. "Maybe later" at minute zero describes
  // exactly the person the milestone surface exists for, once they have
  // some experience to draw on.
  function completionReviewOutcome(clicked, now) {
    return clicked === true ? makeReviewPromptRecord(true, now) : null;
  }

  // Should background.js auto-open the onboarding tab? Only on a genuine
  // first install, and only once. An UPDATE must never steal a tab from
  // someone who is mid-video - an update the user did not ask for is the
  // worst possible moment to take over the screen.
  function shouldAutoOpenOnboarding(reason, onboardedFlag) {
    return reason === "install" && !isOnboarded(onboardedFlag);
  }

  var PMMomentsCore = {
    STORE_ITEM_ID: STORE_ITEM_ID,
    STORE_URL: STORE_URL,
    REVIEW_URL: REVIEW_URL,
    REPO_URL: REPO_URL,
    SUPPORT_EMAIL: SUPPORT_EMAIL,
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
    shouldAutoOpenOnboarding: shouldAutoOpenOnboarding,
    FIRST_PROTECTED_VISIBLE_MS: FIRST_PROTECTED_VISIBLE_MS,
    FIRST_PROTECTED_CARD_VISIBLE_MS: FIRST_PROTECTED_CARD_VISIBLE_MS,
    PIN_MENU_IMAGE: PIN_MENU_IMAGE,
    PIN_MENU_IMAGE_W: PIN_MENU_IMAGE_W,
    PIN_MENU_IMAGE_H: PIN_MENU_IMAGE_H,
    PIN_MENU_MARKER_PX: PIN_MENU_MARKER_PX,
    pinMenuMarkers: pinMenuMarkers,
    makeFirstProtectedRecord: makeFirstProtectedRecord,
    firstProtectedAlreadyShown: firstProtectedAlreadyShown,
    shouldShowFirstProtected: shouldShowFirstProtected,
    firstProtectedSteps: firstProtectedSteps,
    shouldShowPinArrow: shouldShowPinArrow,
    MILESTONE_VISIBLE_MS: MILESTONE_VISIBLE_MS,
    makeMilestoneRecord: makeMilestoneRecord,
    milestoneAlreadyShown: milestoneAlreadyShown,
    shouldShowMilestone: shouldShowMilestone,
    milestoneText: milestoneText,
    GROWTH_COUNTERS: GROWTH_COUNTERS,
    bumpGrowthCounter: bumpGrowthCounter,
    completionReviewOutcome: completionReviewOutcome
  };

  root.PMMoments = PMMomentsCore;

  // Also expose via module.exports for Node tests, without turning this
  // into an ES module (same pattern as wordlist.js/devlog.js/lock.js).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMMomentsCore: PMMomentsCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
