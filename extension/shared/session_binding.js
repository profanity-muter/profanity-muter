// shared/session_binding.js
// Plain script (NOT an ES module), loaded as an isolated-world content
// script before content.js, and require()d by test/session_binding_test.js.
// Defines globalThis.PMSessionBinding.
//
// ONE rule, extracted here because getting it wrong silently disables
// filtering, and because the 0.1.35 field re-test proved it can be gotten
// wrong in a way that looks like a display bug for two rounds.
//
// WHAT WENT WRONG
// ---------------
// content.js keyed its per-video session on videoId and, in the audio
// relay, did this:
//
//     if (!session || session.videoId !== data.videoId) {
//       session = newSession(data.videoId);
//     }
//
// A segment is data about audio. It arrives asynchronously, in a stream,
// from a MAIN-world script with its own idea of which video is playing.
// One late segment carrying the PREVIOUS video's id, landing just after a
// video-change reset, therefore replaced the live session with an empty one
// bound to the old video. That threw away coverage, the mute schedule and
// the captured-range bookkeeping in a single assignment, and then every
// subsequent transcription result for the CURRENT video was dropped by the
// videoId guard in addWords, so none of it could be rebuilt.
//
// The user saw a status pill claiming "Press play to load audio" and
// "Analyzing" while the console showed the pipeline producing coverage
// normally. Both were true reports of an empty session that nothing was
// writing to any more.
//
// THE RULE
// --------
// A segment never redefines which video the tab is on. Navigation events do
// (capture.js sends an explicit 'reset'), and that path is authoritative.
// The single exception is a missed reset, which would otherwise mean
// ignoring every segment forever: a short run of segments for the same
// unexpected id is treated as the reset we never received.

(function (root) {
  "use strict";

  // How many consecutive segments for the SAME unexpected videoId before we
  // conclude the authoritative reset was lost and adopt it. Low, because the
  // cost of being wrong in this direction is one rebuilt session, while the
  // cost of being wrong in the other direction is a filter that has silently
  // stopped filtering.
  var STALE_SEGMENT_RESET_AFTER = 3;

  // segmentAction(state) -> {action, staleCount, staleVideoId}
  //   "create" - no session yet, bind one to this segment's video
  //   "use"    - the segment belongs to the current session
  //   "ignore" - a segment for some other video; drop it, keep the session
  //   "reset"  - the same other video has persisted, treat as a missed reset
  //
  // state: {hasSession, sessionVideoId, incomingVideoId, staleCount,
  //         lastStaleVideoId, resetAfter}
  function segmentAction(state) {
    state = state || {};
    var resetAfter =
      typeof state.resetAfter === "number" ? state.resetAfter : STALE_SEGMENT_RESET_AFTER;

    if (!state.hasSession) {
      return { action: "create", staleCount: 0, staleVideoId: null };
    }
    if (state.sessionVideoId === state.incomingVideoId) {
      // Matching traffic clears any stale run: whatever that other id was,
      // it is not a persistent condition.
      return { action: "use", staleCount: 0, staleVideoId: null };
    }

    // A different video. Count consecutive segments for THIS id only, so
    // alternating ids (which indicate confusion rather than a missed
    // navigation) never accumulate toward a reset.
    var sameAsLast = state.lastStaleVideoId === state.incomingVideoId;
    var count = sameAsLast ? (state.staleCount || 0) + 1 : 1;
    if (count >= resetAfter) {
      return { action: "reset", staleCount: 0, staleVideoId: null };
    }
    return { action: "ignore", staleCount: count, staleVideoId: state.incomingVideoId };
  }

  var PMSessionBindingCore = {
    STALE_SEGMENT_RESET_AFTER: STALE_SEGMENT_RESET_AFTER,
    segmentAction: segmentAction
  };

  root.PMSessionBinding = PMSessionBindingCore;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMSessionBindingCore: PMSessionBindingCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
