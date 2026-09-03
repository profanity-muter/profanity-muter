// shared/active_tab.js
// Plain script (NOT an ES module), imported by the background service worker
// via importScripts and require()d by test/active_tab_test.js. Defines
// globalThis.PMActiveTab.
//
// WHY THIS EXISTS
// ---------------
// The whole extension shares ONE analysis pipeline: a single offscreen
// document with a single Whisper worker and a single ~280MB base.en model
// resident in memory. That worker is a single thread. Trying to analyze two
// videos at once does not make both work at half speed; it makes BOTH fall
// behind the playhead, because each window of one video is time the other
// video's window is not being computed, and neither can ever catch up.
//
// So the pipeline serves exactly one video at a time: the one the user is
// actually watching. This module is the pure decision of WHICH tab that is,
// kept separate from the service worker's event plumbing so the rule can be
// tested without a browser, the same way session_binding.js and preempt.js
// are. Getting it wrong silently starves the tab the user is looking at,
// which is the same failure class as a filter that has quietly stopped
// filtering, so it earns a pinned, tested rule rather than four lines of
// conditional in an event handler.
//
// THE RULE
// --------
// Given the set of YouTube tabs that currently have the extension attached
// (the only tabs that can be served), pick one:
//
//   1. The FOCUSED YouTube tab wins outright, playing or paused. If the user
//      switched to a tab, that is the video they mean to watch, even if it is
//      momentarily paused. Focus is the strongest possible signal of intent.
//   2. Otherwise (the user is looking at some other, non-YouTube window, e.g.
//      a video playing in a background tab while they read email) the tab
//      that is actually PLAYING wins. If several are playing, the most
//      recently activated one.
//   3. Otherwise nothing is playing and nothing YouTube is focused: keep
//      serving the most recently activated YouTube tab, so a single paused
//      tab is still the served one and does not flip to a "not being
//      filtered" state just because it is paused.
//
// A single candidate is always the answer, whatever its state: there is no
// other video to compete for the pipeline.

(function (root) {
  "use strict";

  // Pick the most recently activated candidate from a list. lastActiveWall is
  // a wall-clock stamp set when the tab was last made the active tab of its
  // window; higher is more recent. Ties (including all-zero, meaning nothing
  // has reported an activation yet) fall back to the lowest tabId purely so
  // the choice is deterministic and does not flap between equally-valid tabs.
  function mostRecent(list) {
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (best === null) { best = c; continue; }
      var cw = typeof c.lastActiveWall === "number" ? c.lastActiveWall : 0;
      var bw = typeof best.lastActiveWall === "number" ? best.lastActiveWall : 0;
      if (cw > bw || (cw === bw && c.tabId < best.tabId)) best = c;
    }
    return best;
  }

  // choose(candidates, opts) -> tabId | null
  //
  // candidates: array of { tabId, playing, lastActiveWall }
  //   tabId          number, the YouTube tab that has the extension attached
  //   playing        boolean, is its video currently playing (not paused)
  //   lastActiveWall number, wall ms when it last became its window's active
  //                  tab (0 if never observed)
  // opts: { focusedTabId }
  //   focusedTabId   the tab the user is currently focused on, or null/absent
  //                  when the focused surface is not one of the candidates
  //                  (a non-YouTube tab or window, or no focused window at
  //                  all).
  function choose(candidates, opts) {
    opts = opts || {};
    var list = [];
    for (var i = 0; i < (candidates ? candidates.length : 0); i++) {
      var c = candidates[i];
      if (c && typeof c.tabId === "number") list.push(c);
    }
    if (list.length === 0) return null;
    if (list.length === 1) return list[0].tabId;

    // 1. The focused YouTube tab wins, whatever its play state.
    var focusedTabId = opts.focusedTabId;
    if (typeof focusedTabId === "number") {
      for (var j = 0; j < list.length; j++) {
        if (list[j].tabId === focusedTabId) return focusedTabId;
      }
    }

    // 2. Nothing focused among the candidates: the playing tab wins.
    var playing = list.filter(function (c) { return c.playing === true; });
    if (playing.length > 0) {
      return mostRecent(playing).tabId;
    }

    // 3. Nothing focused, nothing playing: hold the most recently active tab.
    return mostRecent(list).tabId;
  }

  var PMActiveTabCore = {
    choose: choose,
    mostRecent: mostRecent
  };

  root.PMActiveTab = PMActiveTabCore;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMActiveTabCore: PMActiveTabCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
