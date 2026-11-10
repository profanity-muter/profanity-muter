// shared/refresh_notice.js
// Plain script (NOT an ES module): loaded by popup.html and onboarding.html,
// and require()d by test/refresh_notice_test.js. Defines globalThis.PMRefreshNotice.
//
// A YouTube tab that was already open when the extension was installed or
// updated never gets the content script (Chrome only injects on page load),
// so nothing filters it until the page is reloaded. These are the decisions
// the popup and the setup page make about that, kept pure so they are testable.
//
// Reading tab.url needs no "tabs" permission: the youtube.com host permission
// already exposes it for matching tabs. If it is ever undefined we cannot tell
// a YouTube tab from any other, so the popup shows nothing rather than guess.
(function (root) {
  "use strict";

  var COPY = {
    popupNotice: "Refresh this page to start filtering.",
    popupButton: "Refresh page",
    setupLine: "You have YouTube open already. Refresh it so Profanity Muter can start.",
    setupButton: "Refresh YouTube tabs"
  };

  function isYouTubeUrl(url) {
    return typeof url === "string" && url.indexOf("https://www.youtube.com/") === 0;
  }

  // tab: the active tab. resp: the content script's reply to pm-health-query
  // (undefined if none). hadError: chrome.runtime.lastError was set, meaning
  // no content script is listening (never injected, or orphaned by an update).
  function needsRefresh(tab, resp, hadError) {
    if (!tab || !isYouTubeUrl(tab.url)) return false;
    return !!hadError || !!(resp && resp.contextInvalid);
  }

  function tabIds(tabs) {
    var ids = [];
    for (var i = 0; tabs && i < tabs.length; i++) {
      if (tabs[i] && tabs[i].id != null) ids.push(tabs[i].id);
    }
    return ids;
  }

  var core = { COPY: COPY, isYouTubeUrl: isYouTubeUrl, needsRefresh: needsRefresh, tabIds: tabIds };
  root.PMRefreshNotice = core;
  if (typeof module !== "undefined" && module.exports) module.exports = { PMRefreshNoticeCore: core };
})(typeof globalThis !== "undefined" ? globalThis : this);
