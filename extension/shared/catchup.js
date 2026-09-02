// shared/catchup.js
// Plain script (NOT an ES module), loaded as an isolated-world content
// script before content.js, and require()d by test/catchup_test.js.
// Defines globalThis.PMCatchup.
//
// PAUSE-CATCHUP OWNERSHIP, and why it needs rules of its own.
//
// In "pause until ready" mode the extension pauses the video itself, which
// means it has to answer a question no other part of the code faces: was
// THIS pause or play mine, or the user's? Getting it wrong in one direction
// means fighting the user for control of their own player. Getting it wrong
// in the other means never letting go.
//
// The 0.1.35 field trace showed the failure: three engage/clear cycles in
// four seconds at a coverage edge, with "ownership cleared: external play
// observed" each time. There was no external play. The extension was
// misreading its OWN programmatic play() calls as the user taking over,
// dropping ownership, then re-engaging a moment later when the playhead was
// still uncovered. The user sees a video that stutters between paused and
// playing several times a second.
//
// Two mechanisms, both here, both pure:
//
//   1. SELF-ACTION TAGGING. The old code used a one-shot boolean set just
//      before calling play(). That is fragile in exactly the way this bug
//      needs it not to be: play() resolves asynchronously, the event may
//      never arrive (a rejected play on a page without gesture permission),
//      and a stale flag then swallows the NEXT event, which might be the
//      genuinely external one. A timestamped window is used instead: any
//      matching event inside the window is ours, and the mark expires by
//      itself so nothing can be swallowed later.
//
//   2. RE-ENGAGE DEBOUNCE. At a coverage edge the "is the playhead covered"
//      answer flickers as the playhead crosses the boundary. Pausing again
//      within milliseconds of releasing produces the stutter and buys no
//      protection worth having, since the next window is usually seconds
//      away. A short quiet period after each release costs a small amount
//      of unanalyzed playback in the worst case and removes a behaviour the
//      user experiences as the extension malfunctioning.

(function (root) {
  "use strict";

  // How long after a self-initiated play()/pause() call its event is still
  // recognizable as ours. Generous relative to how fast the event actually
  // fires (same task, typically), because the cost of a slightly wide
  // window is only that one genuinely external action inside it is missed,
  // while the cost of too narrow a window is the ping-pong this fixes.
  var SELF_ACTION_WINDOW_MS = 1200;

  // Quiet period after releasing a catch-up pause before pausing again.
  var RE_ENGAGE_DEBOUNCE_MS = 1000;

  // Mark a self-initiated action. Returns the marker to store.
  function markSelfAction(now) {
    return { wall: typeof now === "number" ? now : Date.now() };
  }

  function isSelfAction(marker, now, windowMs) {
    if (!marker || typeof marker.wall !== "number") return false;
    var limit = typeof windowMs === "number" ? windowMs : SELF_ACTION_WINDOW_MS;
    var age = (typeof now === "number" ? now : Date.now()) - marker.wall;
    return age >= 0 && age <= limit;
  }

  // What a play or pause event means for ownership.
  //
  // state: {owned, marker, now, windowMs}
  // returns {owned, cleared, selfInitiated}
  //
  // Only a genuinely external event clears ownership. That is the whole
  // fix: the extension must not interpret its own actions as the user
  // taking over.
  function ownershipOnPlaybackEvent(state) {
    state = state || {};
    var self = isSelfAction(state.marker, state.now, state.windowMs);
    if (self) {
      // Ours. Ownership is unchanged, and the marker is consumed by the
      // caller so a second event cannot claim the same mark.
      return { owned: state.owned === true, cleared: false, selfInitiated: true };
    }
    if (state.owned === true) {
      return { owned: false, cleared: true, selfInitiated: false };
    }
    return { owned: false, cleared: false, selfInitiated: false };
  }

  // May a catch-up pause engage right now, given when we last released one?
  // Null/absent lastReleaseWall means we have never released, so yes.
  function mayEngagePause(state) {
    state = state || {};
    if (typeof state.lastReleaseWall !== "number") return true;
    var now = typeof state.now === "number" ? state.now : Date.now();
    var debounceMs =
      typeof state.debounceMs === "number" ? state.debounceMs : RE_ENGAGE_DEBOUNCE_MS;
    return now - state.lastReleaseWall >= debounceMs;
  }

  // ---- the muted-playback fallback (0.1.36 addendum) ---------------------
  //
  // The fallback exists for one specific deadlock: pausing stops YouTube
  // fetching, and a region it buffered before our hook attached can never
  // be captured passively. Playing is what makes YouTube resume appending.
  // So when a catch-up pause makes no progress, we downgrade to muted
  // playback to prime the buffer.
  //
  // The field trace showed it firing while a window was actively computing
  // and capture ranges were growing to [0,29). Nothing was starved; the
  // pipeline was simply mid-work. The old condition measured only COVERAGE
  // growth, and coverage by definition does not move while a window is
  // still being transcribed, so a slow first window looked identical to a
  // dead pipeline.
  //
  // The cost of that false positive is not cosmetic. Muted playback
  // consumes real content: the user's trace lost the first 2.44 seconds of
  // a video, spoken words played silently and gone. So the trigger now
  // requires actual starvation on every axis at once.
  function shouldEngageFallback(state) {
    state = state || {};
    var thresholdMs =
      typeof state.thresholdMs === "number" ? state.thresholdMs : 8000;
    // Something is being worked on right now. Coverage is not moving
    // because transcription takes time, which is the system working.
    if (state.windowInFlight === true) return false;
    // Audio is still arriving. Priming the buffer is exactly what the
    // fallback would be for, and it is already happening.
    if (typeof state.msSinceCaptureGrowth === "number" && state.msSinceCaptureGrowth < thresholdMs) {
      return false;
    }
    // Nothing at the playhead needs analysis: there is nothing to unblock.
    if (state.uncoveredAtPlayhead === false) return false;
    // And the original condition: coverage genuinely has not moved.
    if (typeof state.msSinceCoverageGrowth !== "number") return false;
    return state.msSinceCoverageGrowth > thresholdMs;
  }

  // Below this, a rewind is more jarring than the fraction of a second it
  // recovers.
  var MIN_REWIND_S = 0.75;

  // Once the fallback has played muted through content, that content is not
  // lost unless we choose to lose it. When coverage catches up over the
  // stretch that played silently, seek back and play it properly.
  //
  // This is what makes "pause until ready" mean what it says: you may wait,
  // but you eventually hear every analyzed second. Without it the mode
  // quietly drops audio and calls it protection.
  //
  // state: {fallbackStartT, playheadT, uncoveredInSpanS, userSeekedSince,
  //         minRewindS}
  // returns {rewind, toT, reason}
  function rewindDecision(state) {
    state = state || {};
    var minRewindS =
      typeof state.minRewindS === "number" ? state.minRewindS : MIN_REWIND_S;
    if (typeof state.fallbackStartT !== "number") {
      return { rewind: false, toT: null, reason: "no-pending-fallback" };
    }
    // The user's own navigation always wins. Yanking them back to where we
    // wanted them would be the extension overriding a deliberate choice,
    // which is worse than the audio it recovers.
    if (state.userSeekedSince === true) {
      return { rewind: false, toT: null, reason: "user-seeked" };
    }
    if (typeof state.playheadT !== "number") {
      return { rewind: false, toT: null, reason: "no-playhead" };
    }
    var spanS = state.playheadT - state.fallbackStartT;
    if (!(spanS > minRewindS)) {
      return { rewind: false, toT: null, reason: "too-short" };
    }
    // Only rewind into audio we can actually filter now. Replaying it
    // unanalyzed would recover the sound and lose the protection.
    var uncovered =
      typeof state.uncoveredInSpanS === "number" ? state.uncoveredInSpanS : Infinity;
    if (uncovered > 0.05) {
      return { rewind: false, toT: null, reason: "not-covered-yet" };
    }
    return { rewind: true, toT: state.fallbackStartT, reason: "rewind" };
  }

  var PMCatchupCore = {
    MIN_REWIND_S: MIN_REWIND_S,
    shouldEngageFallback: shouldEngageFallback,
    rewindDecision: rewindDecision,
    SELF_ACTION_WINDOW_MS: SELF_ACTION_WINDOW_MS,
    RE_ENGAGE_DEBOUNCE_MS: RE_ENGAGE_DEBOUNCE_MS,
    markSelfAction: markSelfAction,
    isSelfAction: isSelfAction,
    ownershipOnPlaybackEvent: ownershipOnPlaybackEvent,
    mayEngagePause: mayEngagePause
  };

  root.PMCatchup = PMCatchupCore;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMCatchupCore: PMCatchupCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
