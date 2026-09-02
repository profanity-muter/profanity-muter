// shared/pill.js
// Plain script (NOT an ES module), loaded as an isolated-world content
// script before content.js, and require()d by test/pill_test.js.
// Defines globalThis.PMPill.
//
// WHAT THIS IS FOR
// ----------------
// The status pill accumulated seven routine states over fifteen releases,
// each one added to answer a real question, and the 0.1.35 field trace
// showed the result: a pill that cycled through "Buffering + analyzing",
// "Analyzing, safe to pause (~1s)", "Analyzing, taking longer than
// expected" and "Press play to load audio" inside a few seconds of an
// ordinary cold start. Every transition was correct by its own rule. The
// aggregate was noise, and the user's verdict was that it should say
// "processing, with a countdown, then protected".
//
// So the INTERNAL states stay (they carry real distinctions the logic and
// the [PM-PILL] traces need) and the PRESENTATION collapses. This module is
// that collapse, kept pure and separate so the mapping is testable and so
// there is exactly one place where "what the user sees" is decided.
//
// THE COUNTDOWN
// -------------
// A countdown is a promise with a visible clock, which makes it a much
// better citizen than a static estimate: it is checkable by the person
// reading it. That cuts both ways, and the two failure modes are opposite:
//
//   * Absurd optimism. The trace showed "~1s" quoted on a cold seek, before
//     any real rtf had been measured, from a default guess. One second is
//     not a plausible time to decode and transcribe anything, and a
//     countdown that hits zero immediately teaches the user to distrust it.
//     Hence ETA_FLOOR_COLD_S: until a real rtf exists, the first promise is
//     floored generously.
//   * Alarming copy for a normal event. When the countdown runs out the old
//     model escalated the label to "taking longer than expected", which the
//     trace shows firing two seconds into a cold start. Overrunning an
//     estimate is ordinary. The label simply drops the number and waits.
//
// Escalation to an actual warning remains the health monitor's job, on its
// own much slower wall clock (shared/health.js, 3x the quote floored at
// 30s). That separation is deliberate: the pill describes what is
// happening, and only the health monitor is allowed to say something is
// wrong.

(function (root) {
  "use strict";

  // Until a measured rtf exists, quote generously. A cold start has to load
  // the model, demux, and transcribe, and the old 0.3 default rtf produced
  // sub-second quotes that were never once achievable.
  var ETA_FLOOR_COLD_S = 8;
  // With a real measurement in hand, a small floor is still worth keeping:
  // sub-second countdowns flicker and read as broken even when accurate.
  var ETA_FLOOR_S = 2;
  // Never quote beyond this, matching the pre-existing cap.
  var ETA_CEILING_S = 30;

  // The floor that applies right now. `hasMeasuredRtf` is the session having
  // completed at least one window whose compute time was measured.
  function etaFloorFor(hasMeasuredRtf) {
    return hasMeasuredRtf ? ETA_FLOOR_S : ETA_FLOOR_COLD_S;
  }

  // Clamp a raw estimate into something quotable.
  function clampEta(rawEtaS, hasMeasuredRtf) {
    var floor = etaFloorFor(hasMeasuredRtf);
    if (typeof rawEtaS !== "number" || !isFinite(rawEtaS)) return floor;
    return Math.min(ETA_CEILING_S, Math.max(floor, Math.ceil(rawEtaS)));
  }

  // Seconds left on the promise, or 0 once it has elapsed. Null when there
  // is no promise to count down.
  function countdownRemainingS(promise, now) {
    if (!promise || typeof promise.issuedWall !== "number" || promise.etaS == null) return null;
    var elapsedMs = (typeof now === "number" ? now : Date.now()) - promise.issuedWall;
    var remainingS = Math.ceil((promise.etaS * 1000 - elapsedMs) / 1000);
    return remainingS > 0 ? remainingS : 0;
  }

  // The routine states that all mean the same thing to a user: we are
  // working on it. Kept as separate internal states because the logic and
  // the traces genuinely distinguish them.
  var PROCESSING_KINDS = ["analyzing-safe", "analyzing-slow", "buffering"];

  function isProcessing(kind) {
    return PROCESSING_KINDS.indexOf(kind) !== -1;
  }

  // present(state, opts) -> {label, presented}
  //   `presented` is the collapsed presentation state, which is what the
  //   traces record alongside the internal kind, so a log line shows both
  //   what was decided and what the user actually read.
  //
  // state: {kind, ...}, opts: {promise, now}
  function present(state, opts) {
    opts = opts || {};
    var kind = state && state.kind;
    var now = typeof opts.now === "number" ? opts.now : Date.now();

    if (!kind) return null;
    if (kind === "off") return { label: "Off", presented: "off" };
    if (kind === "shorts") return { label: "Shorts not supported", presented: "shorts" };
    if (kind === "live") return { label: "Live - limited support", presented: "live" };
    if (kind === "protected") return { label: "Protected", presented: "protected" };
    // The one actionable routine state, and the only one worth a different
    // sentence: it asks the user to do something. content.js gates it hard
    // (see its needs-play conditions) precisely because it has misfired
    // historically, and when in doubt it falls through to the countdown.
    if (kind === "needs-play") {
      return { label: "Press play to load audio", presented: "needs-play" };
    }

    if (isProcessing(kind)) {
      var remainingS = countdownRemainingS(opts.promise, now);
      if (remainingS != null && remainingS > 0) {
        return { label: "Analyzing ~" + remainingS + "s", presented: "analyzing" };
      }
      // Elapsed, or no promise yet. No number, no alarm: the countdown
      // re-arms by itself on the next completed window, because the promise
      // is re-issued with a fresh clock then.
      return { label: "Analyzing…", presented: "analyzing" };
    }

    // Unknown internal state: present it as processing rather than leaking a
    // raw identifier to the user.
    return { label: "Analyzing…", presented: "analyzing" };
  }

  // ---- badge geometry and behaviour (0.1.36 addendum) --------------------
  //
  // ONE badge, top-left, clickable. Previously there were four separate
  // on-player surfaces (status pill bottom-right, a one-off notice banner
  // top-center, an "Analyzing audio" overlay top-left, and the dev
  // overlay), which is three more places than a user should have to look to
  // learn one thing.
  //
  // The vertical offset clears YouTube's hover chrome: the player fades in
  // a title gradient across the top on mouse-over, and a badge at top:8px
  // sits underneath that text. 56px puts it below the band while staying in
  // the corner people look at first.
  var BADGE_TOP_PX = 56;
  var BADGE_LEFT_PX = 8;
  // The dev overlay is anchored directly beneath, so the two can never
  // overlap regardless of badge width.
  var DEBUG_OVERLAY_TOP_PX = 86;

  // Clicking the badge opens the extension UI. The badge is the only part
  // of this that catches the pointer; everything around it stays
  // click-through, because a filter that eats clicks on the player it is
  // filtering would be worse than no affordance at all.
  var OPEN_UI_MESSAGE_TYPE = "pm-open-ui";

  function openUiMessage() {
    return { type: OPEN_UI_MESSAGE_TYPE };
  }

  // The ordered list of ways to open the UI, most to least direct.
  //
  // chrome.action.openPopup() is the real thing (it opens the actual
  // toolbar popup) but it is only available to a user-gesture-initiated
  // flow and has shipped and unshipped across Chrome versions, so it is
  // attempted rather than relied on. The popup page renders fine in a tab
  // (it is a fixed 320px column, which reads as a narrow panel rather than
  // breaking), so that is the fallback. The setup guide is the last resort
  // for a build where neither is available.
  function openUiPlan(caps) {
    caps = caps || {};
    var plan = [];
    if (caps.canOpenPopup !== false) plan.push("action-popup");
    if (caps.canOpenTab !== false) plan.push("popup-tab");
    plan.push("onboarding-tab");
    return plan;
  }

  var PMPillCore = {
    BADGE_TOP_PX: BADGE_TOP_PX,
    BADGE_LEFT_PX: BADGE_LEFT_PX,
    DEBUG_OVERLAY_TOP_PX: DEBUG_OVERLAY_TOP_PX,
    OPEN_UI_MESSAGE_TYPE: OPEN_UI_MESSAGE_TYPE,
    openUiMessage: openUiMessage,
    openUiPlan: openUiPlan,
    ETA_FLOOR_COLD_S: ETA_FLOOR_COLD_S,
    ETA_FLOOR_S: ETA_FLOOR_S,
    ETA_CEILING_S: ETA_CEILING_S,
    PROCESSING_KINDS: PROCESSING_KINDS,
    etaFloorFor: etaFloorFor,
    clampEta: clampEta,
    countdownRemainingS: countdownRemainingS,
    isProcessing: isProcessing,
    present: present
  };

  root.PMPill = PMPillCore;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMPillCore: PMPillCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
