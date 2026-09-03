// onboarding/onboarding.js
// First-run setup flow. Opened automatically once by background.js on a
// genuine install (see its second onInstalled listener), and re-openable
// any time from the popup's "Setup guide" link.
//
// Four steps: how it works -> what it won't do -> guided setup ->
// acknowledgment. The middle two are the load-bearing ones. Step 2 exists
// as a full step rather than fine print because a parent who installs this
// believing it is airtight has been misled by us even if we never said so,
// and step 4 makes them say that back before finishing.
//
// Storage: writes the SAME chrome.storage.sync keys as the popup
// (pm_catchupMode, pm_strictness, pm_additionalWords, pm_lock), through the
// same one-funnel lock rule - see persist() below. It writes no key the
// popup doesn't, and defines no settings semantics of its own; this is a
// second view onto the same settings, never a parallel model of them.
//
// Everything is local. No fonts, no analytics, no network of any kind -
// the page loads three same-origin scripts and two same-origin
// stylesheets, and that is the entire dependency list.

(function () {
  "use strict";

  // Four navigable setup steps, plus a fifth DONE view reached only by
  // finishing (never by Next/Back), which is why the rail and the nav both
  // hide there rather than the rail growing a fifth station: setup is over,
  // so progress through it has stopped being a useful thing to show.
  var TOTAL_STEPS = 4;
  var DONE_STEP = 5;

  var dotsEl = document.getElementById("ob-dots");
  var backEl = document.getElementById("ob-back");
  var nextEl = document.getElementById("ob-next");
  var finishEl = document.getElementById("ob-finish");
  var statusEl = document.getElementById("ob-status");

  var catchupEls = document.getElementsByName("ob-catchup-mode");
  var strictnessEls = document.getElementsByName("ob-strictness");
  var wordlistEl = document.getElementById("ob-wordlist");
  var wordlistSaveEl = document.getElementById("ob-wordlist-save");

  var lockedEl = document.getElementById("ob-locked");
  var lockPasswordEl = document.getElementById("ob-lock-password");
  var lockUnlockEl = document.getElementById("ob-lock-unlock");
  var lockStatusEl = document.getElementById("ob-lock-status");
  var lockSetupEl = document.getElementById("ob-lock-setup");
  var lockDoneEl = document.getElementById("ob-lock-done");
  var lockNewEl = document.getElementById("ob-lock-new");
  var lockConfirmEl = document.getElementById("ob-lock-confirm");
  var lockSetEl = document.getElementById("ob-lock-set");
  var lockSetStatusEl = document.getElementById("ob-lock-set-status");

  var ackCheckEl = document.getElementById("ob-ack-check");
  var reportProblemEl = document.getElementById("ob-report-problem");
  var viewSourceEl = document.getElementById("ob-view-source");
  var openYouTubeEl = document.getElementById("ob-open-youtube");
  var shareEl = document.getElementById("ob-share");
  var doneStatusEl = document.getElementById("ob-done-status");
  var reviewLinkEl = document.getElementById("ob-review-link");
  var reviewModuleEl = document.getElementById("ob-review");
  var reviewLaterEl = document.getElementById("ob-review-later");
  var headerEl = document.querySelector(".ob-header");
  var navEl = document.querySelector(".ob-nav");

  var hasStorage =
    typeof chrome !== "undefined" &&
    chrome &&
    chrome.storage &&
    chrome.storage.sync;

  function moments() {
    return (typeof window !== "undefined" && window.PMMoments) || null;
  }

  function lockApi() {
    return (typeof window !== "undefined" && window.PMLock) || null;
  }

  function core() {
    return (
      (typeof window !== "undefined" &&
        window.PMWordlist &&
        window.PMWordlist._core) ||
      null
    );
  }

  function setStatus(text) {
    statusEl.textContent = text || "";
    if (text) {
      window.clearTimeout(setStatus._t);
      setStatus._t = window.setTimeout(function () {
        statusEl.textContent = "";
      }, 2000);
    }
  }

  function show(el, visible) {
    el.classList.toggle("pm-hidden", !visible);
    el.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  // ---- parental lock state (same rule as the popup) -----------------------
  //
  // Same two variables and the same single gate as popup.js. A lock only
  // exists here at all when someone re-opens this guide on an install that
  // already has one - on a genuine first run there is nothing to unlock.
  var lockRecord = null;
  var unlockedThisSession = false;
  var lockStateLoaded = false;

  function settingsWriteBlockedReason() {
    var api = lockApi();
    if (!api || typeof api.mayWriteSettings !== "function") return null;
    if (!lockStateLoaded) return "loading";
    return api.mayWriteSettings(lockRecord, unlockedThisSession) ? null : "locked";
  }

  // The ONLY function on this page that writes settings to storage - the
  // same funnel discipline popup.js uses, for the same reason: one place
  // to enforce the lock, so a new control can't quietly bypass it.
  function persist(values, cb) {
    if (!hasStorage) {
      setStatus("Storage unavailable");
      return false;
    }
    var blocked = settingsWriteBlockedReason();
    if (blocked === "loading") {
      setStatus("One moment…");
      return false;
    }
    if (blocked) {
      setStatus("Locked - enter the password to change settings");
      return false;
    }
    chrome.storage.sync.set(values, function () {
      var failed = !!(chrome.runtime && chrome.runtime.lastError);
      if (cb) cb(failed);
    });
    return true;
  }

  function renderLockState() {
    var api = lockApi();
    var hasLock = !!(api && api.isLockRecord && api.isLockRecord(lockRecord));
    var locked = hasLock && !unlockedThisSession;

    show(lockedEl, locked);
    show(lockSetupEl, !hasLock);
    show(lockDoneEl, hasLock);

    // Everything on the setup step is disabled while locked. persist()
    // refuses regardless - this is the visible half.
    var controls = [wordlistEl, wordlistSaveEl];
    var i;
    for (i = 0; i < catchupEls.length; i++) controls.push(catchupEls[i]);
    for (i = 0; i < strictnessEls.length; i++) controls.push(strictnessEls[i]);
    for (i = 0; i < controls.length; i++) {
      if (controls[i]) controls[i].disabled = locked;
    }
  }

  // ---- settings load/save -------------------------------------------------

  function setRadio(els, value, fallback) {
    var found = false;
    var i;
    for (i = 0; i < els.length; i++) {
      if (els[i].value === value) found = true;
    }
    var target = found ? value : fallback;
    for (i = 0; i < els.length; i++) {
      els[i].checked = els[i].value === target;
    }
  }

  function getRadio(els, fallback) {
    for (var i = 0; i < els.length; i++) {
      if (els[i].checked) return els[i].value;
    }
    return fallback;
  }

  function parseWords(raw) {
    return String(raw || "")
      .split("\n")
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line.length > 0; });
  }

  function load() {
    if (!hasStorage) {
      lockStateLoaded = true;
      renderLockState();
      return;
    }
    chrome.storage.sync.get(
      [
        "pm_catchupMode",
        "pm_strictness",
        "pm_additionalWords",
        "pm_wordlist",
        "pm_safeMode",
        "pm_lock",
        "pm_ackNotPerfect"
      ],
      function (items) {
        lockStateLoaded = true;
        if (chrome.runtime && chrome.runtime.lastError) {
          // Leave the HTML's defaults (mute + strict) on screen rather than
          // blanking a working page - same posture as the popup's load().
          renderLockState();
          return;
        }
        items = items || {};
        lockRecord = items.pm_lock || null;

        // Resolve through the shared resolver so this page shows exactly
        // what the extension will actually do, including the 0.1.29
        // migration off the legacy schema. Re-deriving any of that here
        // would be a second implementation of rules that must not drift.
        var c = core();
        var resolved =
          c && typeof c.resolveSettingsFromStorage === "function"
            ? c.resolveSettingsFromStorage(items)
            : null;
        if (resolved) {
          setRadio(catchupEls, resolved.catchupMode, "mute");
          setRadio(strictnessEls, resolved.strictness, "strict");
          wordlistEl.value = resolved.additionalWords.join("\n");
        }

        // Re-opening the guide after acknowledging: pre-check the box so
        // the Finish button isn't a second consent for the same thing.
        var m = moments();
        if (m && m.isAcknowledged(items.pm_ackNotPerfect)) {
          ackCheckEl.checked = true;
          updateFinishEnabled();
        }
        renderLockState();
      }
    );
  }

  // Settings save as they change, matching the popup's instant-on-select
  // contract. The words textarea is the one exception (free text needs an
  // explicit "done"), exactly as in the popup.
  function saveSettings() {
    persist(
      {
        pm_catchupMode: getRadio(catchupEls, "mute"),
        pm_strictness: getRadio(strictnessEls, "strict")
      },
      function (failed) {
        setStatus(failed ? "Save failed" : "Saved");
      }
    );
  }

  function saveWords() {
    persist({ pm_additionalWords: parseWords(wordlistEl.value) }, function (failed) {
      setStatus(failed ? "Save failed" : "Saved");
    });
  }

  // ---- lock actions -------------------------------------------------------

  function unlock() {
    var api = lockApi();
    if (!api) return;
    api.verify(lockRecord, lockPasswordEl.value).then(function (ok) {
      lockPasswordEl.value = "";
      if (!ok) {
        lockStatusEl.textContent = "Wrong password";
        return;
      }
      unlockedThisSession = true;
      lockStatusEl.textContent = "";
      renderLockState();
      setStatus("Settings unlocked");
    });
  }

  function setLockPassword() {
    var api = lockApi();
    if (!api || !hasStorage) {
      lockSetStatusEl.textContent = "Password locking isn't available.";
      return;
    }
    var check = api.validateNewPassword(lockNewEl.value, lockConfirmEl.value);
    if (!check.ok) {
      lockSetStatusEl.textContent = check.error;
      return;
    }
    lockSetStatusEl.textContent = "";
    api.create(lockNewEl.value).then(
      function (record) {
        chrome.storage.sync.set({ pm_lock: record }, function () {
          if (chrome.runtime && chrome.runtime.lastError) {
            lockSetStatusEl.textContent = "Couldn't save the password";
            return;
          }
          lockRecord = record;
          // Setting a password must not lock the person setting it out of
          // the rest of their own setup flow.
          unlockedThisSession = true;
          lockNewEl.value = "";
          lockConfirmEl.value = "";
          renderLockState();
          lockSetStatusEl.textContent = "Password set.";
        });
      },
      function () {
        lockSetStatusEl.textContent = "Couldn't set a password on this browser";
      }
    );
  }

  // ---- steps --------------------------------------------------------------

  var step = 1;

  function renderStep() {
    for (var i = 1; i <= DONE_STEP; i++) {
      var el = document.getElementById("ob-step-" + i);
      if (el) show(el, i === step);
    }
    var done = step === DONE_STEP;
    // On the completion view the rail and the whole header are stale:
    // there is no step 5 of 4, and the "set this up" tagline is finished
    // business.
    show(headerEl, !done);
    show(navEl, !done);
    if (done) {
      window.scrollTo(0, 0);
      return;
    }
    var dots = dotsEl.querySelectorAll(".ob-dot");
    for (var d = 0; d < dots.length; d++) {
      dots[d].classList.toggle("ob-dot--done", d < step);
    }
    dotsEl.setAttribute("aria-valuenow", String(step));

    backEl.disabled = step === 1;
    show(nextEl, step < TOTAL_STEPS);
    show(finishEl, step === TOTAL_STEPS);
    window.scrollTo(0, 0);
  }

  // Clamped to TOTAL_STEPS on purpose: Next and Back must never walk into
  // the completion view, which is reached only by actually finishing.
  function goTo(n) {
    step = Math.min(TOTAL_STEPS, Math.max(1, n));
    renderStep();
  }

  function goDone() {
    step = DONE_STEP;
    renderStep();
    wireReviewModule();
    bumpGrowth("completionReviewShown");
  }

  function setDoneStatus(text) {
    doneStatusEl.textContent = text || "";
    if (text) {
      window.clearTimeout(setDoneStatus._t);
      setDoneStatus._t = window.setTimeout(function () {
        doneStatusEl.textContent = "";
      }, 2500);
    }
  }

  function openYouTube() {
    var url = "https://www.youtube.com/";
    try {
      chrome.tabs.create({ url: url });
    } catch (e) {
      window.open(url, "_blank");
    }
  }

  // The same blurb the popup's share row copies (shared/moments.js), so
  // there is one piece of share copy in the product rather than two.
  // Offered here because sharing needs no product experience to be
  // sincere, unlike a review.
  // Robust clipboard copy with a fallback for when the async Clipboard API
  // is missing or rejects (some contexts, older engines, permission quirks):
  // a hidden textarea plus execCommand('copy'). Returns a Promise<boolean>
  // so every caller can report a clear result in BOTH branches - never a
  // silent no-op.
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return fallbackCopyText(text); }
      );
    }
    return Promise.resolve(fallbackCopyText(text));
  }

  function fallbackCopyText(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  // Prominent, immediate feedback: the share control briefly BECOMES its own
  // confirmation ("Link copied"), reverting after a few seconds, so there is
  // no doubt the click did something even if the small status line is missed.
  function flashShareCopied() {
    if (flashShareCopied._t) {
      window.clearTimeout(flashShareCopied._t);
    } else {
      flashShareCopied._label = shareEl.textContent;
    }
    shareEl.textContent = "Link copied";
    shareEl.classList.add("ob-share--copied");
    flashShareCopied._t = window.setTimeout(function () {
      shareEl.textContent = flashShareCopied._label;
      shareEl.classList.remove("ob-share--copied");
      flashShareCopied._t = null;
    }, 2500);
  }

  function shareWithFriend() {
    var m = moments();
    if (!m) {
      setDoneStatus("Share link unavailable");
      return;
    }
    copyText(m.SHARE_TEXT).then(function (ok) {
      if (ok) {
        flashShareCopied();
        setDoneStatus("Link copied to your clipboard.");
      } else {
        setDoneStatus("Couldn't copy automatically - select the link and copy it.");
      }
    });
  }

  // ---- completion review module -------------------------------------------
  //
  // Counters are local-only (chrome.storage.local, pm_growth) and exist so
  // conversion can be read off a devlog or problem report later. Nothing is
  // transmitted, by this or anything else here.
  function bumpGrowth(key) {
    var m = moments();
    if (!m || typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
    try {
      chrome.storage.local.get(["pm_growth"], function (items) {
        if (chrome.runtime && chrome.runtime.lastError) return;
        chrome.storage.local.set({
          pm_growth: m.bumpGrowthCounter(items && items.pm_growth, key)
        });
      });
    } catch (e) {
      // A counter is never worth breaking the page for.
    }
  }

  // The store URL lives in exactly one constant (shared/moments.js), so
  // this resolves it at runtime rather than hardcoding a second copy in
  // markup.
  function wireReviewModule() {
    var m = moments();
    if (!m || !reviewLinkEl) return;
    reviewLinkEl.href = m.REVIEW_URL;
  }

  function onReviewClicked() {
    var m = moments();
    bumpGrowth("completionReviewClicked");
    // Acting here retires every later review surface: the milestone card,
    // its badge and its pill. Reusing pm_reviewPrompt means there is one
    // definition of "already asked" rather than a second flag to sync.
    if (m && hasStorage) {
      try {
        var record = m.completionReviewOutcome(true, Date.now());
        if (record) chrome.storage.sync.set({ pm_reviewPrompt: record });
      } catch (e) {}
    }
    // The anchor's own navigation opens the store; nothing else to do.
  }

  // Declining is one plain click, with no second ask and no guilt copy. It
  // deliberately does NOT retire the milestone surface: "maybe later" at
  // minute zero describes exactly the person that surface exists for, once
  // they have some experience to draw on.
  function onReviewLater() {
    bumpGrowth("completionReviewDismissed");
    show(reviewModuleEl, false);
  }

  // ---- acknowledgment -----------------------------------------------------
  //
  // A real gate: Finish stays disabled until the box is ticked. The
  // acknowledgment is not implied by reaching this screen, by clicking
  // through, or by a pre-ticked box - the user has to do something.
  function updateFinishEnabled() {
    finishEl.disabled = !ackCheckEl.checked;
  }

  function finish() {
    if (!ackCheckEl.checked) return; // belt and braces; the button is disabled
    var m = moments();
    if (!m || !hasStorage) {
      // No storage to record it in, but the user still did the thing, so
      // still show the completion view rather than a dead button.
      goDone();
      return;
    }
    // NOT routed through persist(): the acknowledgment is not a setting,
    // it is a record that this person was told what the extension does and
    // doesn't do. A parental lock must not be able to prevent it (nor
    // would blocking it help anyone - the banner would simply never clear).
    chrome.storage.sync.set(
      { pm_ackNotPerfect: m.makeAckRecord(Date.now()), pm_onboarded: true },
      function () {
        if (chrome.runtime && chrome.runtime.lastError) {
          setStatus("Couldn't save - try again");
          return;
        }
        finishEl.disabled = true;
        goDone();
      }
    );
  }

  // ---- wiring -------------------------------------------------------------

  // Opened in a new tab rather than navigating: someone mid-setup who
  // hits a problem shouldn't lose the setup flow to reach the report form.
  reportProblemEl.addEventListener("click", function () {
    var url;
    try {
      url = chrome.runtime.getURL("report/report.html");
    } catch (e) {
      return;
    }
    try {
      chrome.tabs.create({ url: url });
    } catch (e) {
      window.open(url, "_blank");
    }
  });

  // "View source" opens the repository (the single REPO_URL constant in
  // shared/moments.js) in a new tab, so a reader mid-setup keeps their place.
  viewSourceEl.addEventListener("click", function () {
    var m = moments();
    if (!m) return;
    try {
      chrome.tabs.create({ url: m.REPO_URL });
    } catch (e) {
      window.open(m.REPO_URL, "_blank");
    }
  });

  reviewLinkEl.addEventListener("click", onReviewClicked);
  reviewLaterEl.addEventListener("click", onReviewLater);
  openYouTubeEl.addEventListener("click", openYouTube);
  shareEl.addEventListener("click", shareWithFriend);
  backEl.addEventListener("click", function () { goTo(step - 1); });
  nextEl.addEventListener("click", function () { goTo(step + 1); });
  finishEl.addEventListener("click", finish);
  ackCheckEl.addEventListener("change", updateFinishEnabled);

  var i;
  for (i = 0; i < catchupEls.length; i++) {
    catchupEls[i].addEventListener("change", saveSettings);
  }
  for (i = 0; i < strictnessEls.length; i++) {
    strictnessEls[i].addEventListener("change", saveSettings);
  }
  wordlistSaveEl.addEventListener("click", saveWords);
  lockUnlockEl.addEventListener("click", unlock);
  lockSetEl.addEventListener("click", setLockPassword);
  lockPasswordEl.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") unlock();
  });
  lockConfirmEl.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") setLockPassword();
  });

  renderStep();
  updateFinishEnabled();
  renderLockState();
  load();
})();
