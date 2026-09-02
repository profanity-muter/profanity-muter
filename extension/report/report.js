// report/report.js
// The "Report a problem" page. Reachable from the popup's Debugging row
// and from the last screen of onboarding, and - like "Copy debug log" -
// deliberately NOT gated by the parental lock: someone hitting a problem
// must always be able to report it, and nothing here changes a setting.
//
// All assembly lives in shared/report.js (pure, unit-tested). This file
// is the DOM around it: read storage, fill the form, and on send do the
// two things that need a browser - write the clipboard and open a mail
// draft. See shared/report.js's header for why it's clipboard-and-paste
// rather than an attachment.

(function () {
  "use strict";

  var whatEl = document.getElementById("rp-what");
  var videoEl = document.getElementById("rp-video");
  var consentEl = document.getElementById("rp-consent");
  var logSummaryEl = document.getElementById("rp-log-summary");
  var sendEl = document.getElementById("rp-send");
  var statusEl = document.getElementById("rp-status");
  var doneEl = document.getElementById("rp-done");
  var mailtoEl = document.getElementById("rp-mailto");
  var emailEl = document.getElementById("rp-email");
  var copyAgainEl = document.getElementById("rp-copy-again");

  var hasLocalStorage =
    typeof chrome !== "undefined" &&
    chrome &&
    chrome.storage &&
    chrome.storage.local;

  // The devlog as read at page load. Held in memory so "Send" doesn't
  // race a second storage read, and so "copy again" reproduces exactly
  // what was copied the first time.
  var devlog = null;

  function reportApi() {
    return (typeof window !== "undefined" && window.PMReport) || null;
  }

  function supportEmail() {
    var m = (typeof window !== "undefined" && window.PMMoments) || null;
    return (m && m.SUPPORT_EMAIL) || "";
  }

  function extensionVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return "unknown";
    }
  }

  function setStatus(text) {
    statusEl.textContent = text || "";
    if (text) {
      window.clearTimeout(setStatus._t);
      setStatus._t = window.setTimeout(function () {
        statusEl.textContent = "";
      }, 4000);
    }
  }

  function show(el, visible) {
    el.classList.toggle("pm-hidden", !visible);
    el.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  // A one-line, plain summary of what the checkbox will actually attach,
  // in numbers rather than adjectives - including the truncation, before
  // it happens rather than as a surprise inside the report.
  function renderLogSummary() {
    var api = reportApi();
    if (!api) return;
    if (!consentEl.checked) {
      logSummaryEl.textContent = "No debug log will be included.";
      return;
    }
    if (!devlog || !devlog.videos || !devlog.videos.length) {
      logSummaryEl.textContent =
        "No debug log has been recorded yet - that's fine, send the report anyway.";
      return;
    }
    var trim = api.truncateDevlog(devlog);
    if (trim.truncated) {
      logSummaryEl.textContent =
        "Your log covers " +
        trim.originalVideos +
        " videos and is too large to send in full, so the " +
        trim.videosIncluded +
        " most recent will be included.";
      return;
    }
    logSummaryEl.textContent =
      "Will include " + trim.videosIncluded + " recent video(s) of activity.";
  }

  function load() {
    if (!hasLocalStorage) {
      renderLogSummary();
      return;
    }
    chrome.storage.local.get(["pm_devlog"], function (items) {
      if (chrome.runtime && chrome.runtime.lastError) {
        renderLogSummary();
        return;
      }
      devlog = (items && items.pm_devlog) || null;
      var api = reportApi();
      // Prefill the video field from the newest devlog entry, so the user
      // doesn't have to go back and find the video they were watching.
      // Only ever a prefill - it stays fully editable and clearable.
      if (api && !videoEl.value) {
        videoEl.value = api.latestVideoUrl(devlog);
      }
      renderLogSummary();
    });
  }

  function currentReport() {
    var api = reportApi();
    return api.buildReport({
      extensionVersion: extensionVersion(),
      userAgent: (typeof navigator !== "undefined" && navigator.userAgent) || "unknown",
      whatHappened: whatEl.value,
      videoUrl: videoEl.value.trim(),
      includeLog: consentEl.checked,
      devlog: devlog,
      now: Date.now()
    });
  }

  function copyReport() {
    var api = reportApi();
    if (!api) return Promise.reject(new Error("report module missing"));
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      return Promise.reject(new Error("clipboard unavailable"));
    }
    return navigator.clipboard.writeText(api.reportToJson(currentReport()));
  }

  // The mail draft (Tier 1). Carries the compact, counts-only summary in
  // the body so the report is actionable even if nobody pastes anything;
  // see shared/report.js for why that inversion was the point of 0.1.33.
  // The consent checkbox governs per-video data in BOTH tiers.
  function currentMailto() {
    var api = reportApi();
    return api.buildMailto({
      email: supportEmail(),
      extensionVersion: extensionVersion(),
      userAgent: (typeof navigator !== "undefined" && navigator.userAgent) || "",
      whatHappened: whatEl.value,
      videoUrl: videoEl.value.trim(),
      devlog: consentEl.checked ? devlog : null,
      logWithheld: !consentEl.checked
    });
  }

  function send() {
    var api = reportApi();
    if (!api) return;
    copyReport().then(
      function () {
        var mailto = currentMailto();
        mailtoEl.href = mailto;
        emailEl.textContent = supportEmail();
        show(doneEl, true);
        setStatus("Report copied");
        // Open the draft by clicking the same anchor the user can click
        // themselves, rather than assigning location - if no mail client
        // is configured, nothing happens and the visible fallback link
        // (plus the plain address next to it) is already on screen.
        try {
          mailtoEl.click();
        } catch (e) {
          /* the fallback link is right there */
        }
      },
      function () {
        // Never a dead end: if the clipboard is unavailable, the report
        // still has to be gettable, so fall back to selecting it in the
        // textarea for a manual copy.
        // The clipboard is the OPTIONAL tier now, so its failure is a
        // minor inconvenience rather than a dead end: the mail draft
        // already carries the summary that makes the report actionable.
        setStatus("Couldn't copy the full log - the email still has the summary");
        show(doneEl, true);
        emailEl.textContent = supportEmail();
        mailtoEl.href = currentMailto();
        try {
          mailtoEl.click();
        } catch (e) {
          /* the fallback link is right there */
        }
      }
    );
  }

  consentEl.addEventListener("change", renderLogSummary);
  sendEl.addEventListener("click", send);
  copyAgainEl.addEventListener("click", function () {
    copyReport().then(
      function () { setStatus("Report copied again"); },
      function () { setStatus("Couldn't copy"); }
    );
  });

  renderLogSummary();
  load();
})();
