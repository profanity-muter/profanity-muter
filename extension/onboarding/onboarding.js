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

  var TOTAL_STEPS = 4;

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
  var ackDoneEl = document.getElementById("ob-ack-done");
  var reportProblemEl = document.getElementById("ob-report-problem");

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
    for (var i = 1; i <= TOTAL_STEPS; i++) {
      var el = document.getElementById("ob-step-" + i);
      if (el) show(el, i === step);
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

  function goTo(n) {
    step = Math.min(TOTAL_STEPS, Math.max(1, n));
    renderStep();
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
      show(ackDoneEl, true);
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
        show(ackDoneEl, true);
        finishEl.disabled = true;
        setStatus("Setup complete");
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
