// shared/feedback.js
// Plain script (popup + service worker via importScripts; require()able).
// Defines globalThis.PMFeedback. Pure: no chrome.*, no clock (now is passed).
//
// The feedback page is a static link opened in a tab. The address carries
// only the version and where the visitor came from; nothing else.
//
// Storage (chrome.storage.local):
//   pm_audioOffSince   epoch ms | absent - when audio filtering was switched
//                      off (pm_enabled false or pm_muteAudio false). The
//                      slow-computer auto-pause is a separate flag and is
//                      deliberately not counted here.
//   pm_feedbackSnooze  epoch ms | absent - no "Paused?" nudge before this.
(function (root) {
  "use strict";

  var BASE = "https://profanity-muter.github.io/feedback/";
  var DAY = 24 * 60 * 60 * 1000;
  var OFF_AFTER_MS = 7 * DAY;
  var SNOOZE_MS = 30 * DAY;
  var NUDGE_TEXT = "Paused for a while? Tell us why in one tap.";

  function url(from, version) {
    return BASE + "?from=" + encodeURIComponent(from) + "&v=" + encodeURIComponent(version || "");
  }

  // sync = { pm_enabled, pm_muteAudio }; both default to on.
  function audioOff(sync) {
    sync = sync || {};
    return sync.pm_enabled === false || sync.pm_muteAudio === false;
  }

  // What to do with pm_audioOffSince given the current toggle state.
  // Returns { set: ms } | { remove: true } | null (nothing to write).
  function offSincePatch(prevOffSince, isOff, now) {
    var has = typeof prevOffSince === "number";
    if (isOff) return has ? null : { set: now };
    return has ? { remove: true } : null;
  }

  function nudgeDue(offSince, snoozeUntil, now) {
    if (typeof offSince !== "number") return false;
    if (now - offSince < OFF_AFTER_MS) return false;
    if (typeof snoozeUntil === "number" && now < snoozeUntil) return false;
    return true;
  }

  var api = {
    BASE: BASE, DAY: DAY, OFF_AFTER_MS: OFF_AFTER_MS, SNOOZE_MS: SNOOZE_MS,
    NUDGE_TEXT: NUDGE_TEXT, url: url, audioOff: audioOff,
    offSincePatch: offSincePatch, nudgeDue: nudgeDue
  };
  root.PMFeedback = api;
  if (typeof module !== "undefined" && module.exports) module.exports = { PMFeedback: api };
})(typeof globalThis !== "undefined" ? globalThis : this);
