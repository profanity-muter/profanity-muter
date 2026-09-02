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
      // The DISPLAYED value wins when the caller keeps a countdown ledger
      // (0.1.40), because that is the monotonic one. countdownRemainingS
      // remains the fallback for callers that do not.
      var remainingS = typeof opts.displayedS === "number"
        ? opts.displayedS
        : countdownRemainingS(opts.promise, now);
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
  // Two resting places, not one (0.1.37). 56px clears the title gradient
  // the player fades in on hover, and is correct WHILE that chrome is
  // showing. With the chrome hidden there is no title band to clear, and a
  // badge sitting 56px down floats in the middle of the picture looking
  // detached from everything. So it rides up to the corner when the player
  // is idle and glides back down when the chrome appears.
  //
  // YouTube marks the idle state with `ytp-autohide` on the player element,
  // so this is a pure CSS descendant rule with a transition: no polling, no
  // observers, and it tracks the real player state rather than our guess at
  // it. If that class ever stops existing the rule simply never matches and
  // the badge stays at the safe 56px, which is why the default is the
  // chrome-visible offset rather than the corner.
  var BADGE_TOP_PX = 56;
  var BADGE_TOP_IDLE_PX = 12;
  var BADGE_LEFT_PX = 12;
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

  // ---- monotonic countdown (0.1.40) --------------------------------------
  //
  // Field report: the countdown "goes down, then up, then says analyzing,
  // then finally protected". Every one of those transitions was truthful in
  // isolation, because each completed window recomputes an estimate and a
  // hang-delayed window produces a bigger one. Truthful in isolation is not
  // the same as trustworthy: a number that can go up is not a countdown,
  // and a user watching it learns to ignore it.
  //
  // Three rules, in order of how much they matter:
  //
  //   1. MONOTONIC DISPLAY. The displayed number may fall or hold. It may
  //      never rise. A new, worse estimate stops the descent rather than
  //      reversing it. The existing elapsed rule is the escape valve: if
  //      the hold outlasts the promise, the label drops the number and says
  //      "Analyzing...", which is the truthful way to say "longer than I
  //      thought" without ever ticking upward. Only a seek or a video
  //      change may raise it, because those are new questions rather than
  //      revised answers to the old one.
  //
  //   2. QUOTE TIME-TO-PROTECTED, PESSIMISTICALLY. The quantity a viewer
  //      cares about is when the badge turns green, not how long one window
  //      takes. And the throughput estimate feeding it counts WALL time
  //      including hangs, so a hang-prone video quotes slower numbers by
  //      itself rather than promising the throughput of a healthy one. The
  //      bias is deliberately toward over-quoting: finishing early and
  //      snapping to Protected reads as fast, while hitting zero and
  //      lingering reads as broken.
  //
  //   3. JITTER GATE. A quote that differs trivially from what is on screen
  //      is not new information, it is flicker. Adopt a lower quote only
  //      when the improvement is worth interrupting a smooth 1Hz tick.
  var JITTER_MIN_RATIO = 0.25; // 25% better
  var JITTER_MIN_S = 2; // or two whole seconds better
  // Pessimism applied to a raw estimate before it is ever quoted.
  var PESSIMISM_FACTOR = 1.25;
  // EWMA weight for new throughput samples. Low enough that one fast window
  // cannot erase the memory of a slow stretch.
  var RTF_EWMA_ALPHA = 0.3;

  // Fold one window's WALL time into the effective throughput estimate.
  // Wall, not compute: a window that took 12 seconds because the decoder
  // hung for 9 of them really did deliver its audio at that rate, and the
  // countdown is a promise about elapsed time, not about CPU.
  function updateEffectiveRtf(prevRtf, audioS, wallMs) {
    if (typeof audioS !== "number" || !(audioS > 0)) return prevRtf;
    if (typeof wallMs !== "number" || !(wallMs >= 0)) return prevRtf;
    var sample = wallMs / 1000 / audioS;
    if (!isFinite(sample) || sample <= 0) return prevRtf;
    if (typeof prevRtf !== "number" || !isFinite(prevRtf) || prevRtf <= 0) return sample;
    return prevRtf * (1 - RTF_EWMA_ALPHA) + sample * RTF_EWMA_ALPHA;
  }

  // Time until the protect margin ahead of the playhead is covered, given
  // how fast this session is actually going. Deliberately quoted on the
  // pessimistic side.
  // The cold case had no arithmetic at all: with no measured throughput it
  // fell to a flat floor, which quoted 8s for a fresh seek that took 15.2s.
  // That breaks the pessimism rule in exactly the situation the rule exists
  // for. The user's words were that the countdown "hits zero and lingers",
  // and lingering at zero is what a floor produces when the floor was
  // never an estimate of anything.
  //
  // So a cold quote is now computed rather than guessed: covering the
  // protect margin from a standing start takes roughly two windows at
  // warm-up throughput, and warm-up throughput is the SAME constant the
  // preemption model uses (shared/preempt.js WARMUP_RTF). Two modules
  // disagreeing about how slow a cold pipeline is would mean one of them
  // was wrong.
  //
  // It stays a floor rather than the whole answer: once real EWMA data
  // arrives the ordinary estimate takes over, and the monotonic display
  // rules let the number fall from a truthful 15 to done-at-12 and snap to
  // Protected. Finishing early reads as fast; hitting zero and waiting
  // reads as broken.
  var COLD_WINDOWS = 2;

  function warmupRtf() {
    var api = typeof globalThis !== "undefined" ? globalThis.PMPreempt : null;
    return api && typeof api.WARMUP_RTF === "number" ? api.WARMUP_RTF : 1.5;
  }

  // What covering `uncoveredAheadS` costs before any measurement exists.
  function coldEstimateS(uncoveredAheadS) {
    var span = typeof uncoveredAheadS === "number" && uncoveredAheadS > 0 ? uncoveredAheadS : 0;
    if (span <= 0) return 0;
    // Two windows' worth of work at warm-up speed: the span itself, plus
    // the second window that a fresh seek almost always needs before the
    // margin ahead of the playhead is actually covered.
    return span * warmupRtf() * COLD_WINDOWS;
  }

  // `isCold` is about the SITUATION, not the session's history. A seek into
  // an unanalyzed region starts from a standing start even in a session
  // that has been running for ten minutes, and quoting that session's
  // settled throughput for it is how the field log promised 8s for
  // something that took 15.2s. Defaults to "cold if nothing measured" for
  // callers that do not distinguish.
  function estimateSecondsToProtected(uncoveredAheadS, effectiveRtf, hasMeasuredRtf, isCold) {
    var rtf = typeof effectiveRtf === "number" && isFinite(effectiveRtf) && effectiveRtf > 0
      ? effectiveRtf
      : 0.3;
    var span = typeof uncoveredAheadS === "number" && uncoveredAheadS > 0 ? uncoveredAheadS : 0;
    var cold = typeof isCold === "boolean" ? isCold : !hasMeasuredRtf;
    var raw = span * rtf;
    if (cold) {
      // Quote the cold arithmetic, never less. The ordinary estimate takes
      // over as soon as this position has real coverage behind it, and the
      // monotonic rules let the number fall from there.
      raw = Math.max(raw, coldEstimateS(span));
    }
    return clampEta(raw * PESSIMISM_FACTOR, hasMeasuredRtf);
  }

  // Would adopting `candidateS` be a real improvement over what is shown?
  function passesJitterGate(displayedS, candidateS) {
    if (typeof displayedS !== "number") return true;
    if (typeof candidateS !== "number") return false;
    if (candidateS >= displayedS) return false; // never upward; rule 1
    var improvement = displayedS - candidateS;
    return improvement >= JITTER_MIN_S || improvement >= displayedS * JITTER_MIN_RATIO;
  }

  // The display ledger. Separate from the promise's own etaS, which stays
  // the raw internal estimate; this is only what the user is shown.
  //
  // state: {displayedS, lastTickWall} or null
  // input: {candidateS, now, issuedWall, reset}
  // returns {displayedS, lastTickWall, changed}
  function advanceCountdown(state, input) {
    input = input || {};
    var now = typeof input.now === "number" ? input.now : Date.now();
    var candidate = typeof input.candidateS === "number" ? input.candidateS : null;

    // A seek or a video change is a new question, so the display may be
    // raised. This is the ONLY path that can increase it.
    if (input.reset === true || !state || typeof state.displayedS !== "number") {
      return { displayedS: candidate, lastTickWall: now, changed: true };
    }

    // Tick down with the wall clock, so the number moves at 1Hz whatever
    // the render cadence.
    // Explicit null check, not `state.lastTickWall || now`: a zero
    // timestamp is falsy, and that form silently disabled the tick
    // whenever the clock read exactly 0. Real wall clocks never do, but
    // injected ones in tests do, and a guard that only works on real
    // inputs is not a guard.
    var lastTick = typeof state.lastTickWall === "number" ? state.lastTickWall : now;
    var elapsedS = Math.floor((now - lastTick) / 1000);
    var ticked = elapsedS > 0 ? Math.max(0, state.displayedS - elapsedS) : state.displayedS;
    var lastTickWall = elapsedS > 0 ? lastTick + elapsedS * 1000 : lastTick;

    // Rule 1 plus rule 3: adopt a candidate only when it is genuinely
    // better. Otherwise hold whatever the tick produced, which may be flat
    // at zero, at which point the caller's elapsed rule shows the
    // numberless label.
    if (candidate != null && passesJitterGate(ticked, candidate)) {
      return { displayedS: candidate, lastTickWall: now, changed: true };
    }
    return { displayedS: ticked, lastTickWall: lastTickWall, changed: ticked !== state.displayedS };
  }

  var PMPillCore = {
    JITTER_MIN_RATIO: JITTER_MIN_RATIO,
    JITTER_MIN_S: JITTER_MIN_S,
    PESSIMISM_FACTOR: PESSIMISM_FACTOR,
    RTF_EWMA_ALPHA: RTF_EWMA_ALPHA,
    updateEffectiveRtf: updateEffectiveRtf,
    COLD_WINDOWS: COLD_WINDOWS,
    coldEstimateS: coldEstimateS,
    estimateSecondsToProtected: estimateSecondsToProtected,
    passesJitterGate: passesJitterGate,
    advanceCountdown: advanceCountdown,
    BADGE_TOP_PX: BADGE_TOP_PX,
    BADGE_TOP_IDLE_PX: BADGE_TOP_IDLE_PX,
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
