// popup/popup.js
// Design C popup (0.1.51). A home dashboard with drill-in sub-screens, all
// in one popup page (views toggled by .pm-hidden). Reads/writes
// chrome.storage.sync directly for settings (pm_enabled, pm_muteAudio,
// pm_censorCaptions, pm_catchupMode, pm_debugOverlay, pm_showStatus,
// pm_strictness, pm_additionalWords, pm_allowWords, pm_padding) plus the
// optional parental lock (pm_lock), and reads chrome.storage.LOCAL for the
// Activity dashboard (pm_activity via shared/stats.js, pm_stats legacy).
//
// EVERY setting from the prior popup is preserved with the same storage key
// and semantics, reorganized under the new screens:
//   * Home: master on/off (header), Activity summary, Built-in list
//     (pm_strictness), and drill-ins.
//   * Manage words: pm_additionalWords ("Also block") + pm_allowWords
//     ("Always allow", new whitelist, 0.1.51).
//   * Playback & display: pm_muteAudio, pm_censorCaptions, pm_showStatus,
//     pm_catchupMode, pm_padding, pm_debugOverlay, plus Copy debug log /
//     Report a problem (never lock-gated).
//   * Activity: 24h / 7d / all-time breakdown + most-muted.
//
// LOCK ENFORCEMENT is unchanged in principle: persistSettings() is the ONE
// funnel every write goes through, and it asks PMLock.mayWriteSettings()
// before writing, so a forced DOM change still writes nothing. The 0.1.51
// additions are UI around that: the settings are gated behind a blur +
// password overlay while locked (the Activity summary stays public), the
// header on/off switch prompts for the password when clicked locked, and an
// unlocked session auto-relocks after 5 minutes of no interaction (the pure
// timer predicate is PMLock.shouldRelock).

(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  // ---- settings controls (same IDs/semantics as before) ----
  var enabledEl = $("pm-enabled");
  var muteAudioEl = $("pm-mute-audio");
  var censorCaptionsEl = $("pm-censor-captions");
  var catchupModeEls = document.getElementsByName("pm-catchup-mode");
  var debugOverlayEl = $("pm-debug-overlay");
  var showStatusEl = $("pm-show-status");
  var paddingEls = document.getElementsByName("pm-padding");
  var strictnessEls = document.getElementsByName("pm-strictness");
  var restoreEl = $("pm-restore");
  var statusEl = $("pm-status");
  var copyDevlogEl = $("pm-copy-devlog");

  // ---- navigation ----
  var backEl = $("pm-back");
  var titleEl = $("pm-title");
  var enabledWrapEl = $("pm-enabled-wrap");
  var lockIconEl = $("pm-lock-icon");
  var views = {
    home: $("pm-view-home"),
    manage: $("pm-view-manage"),
    playback: $("pm-view-playback"),
    activity: $("pm-view-activity"),
    lock: $("pm-view-lock")
  };
  var VIEW_TITLES = {
    home: "Profanity Muter",
    manage: "Manage words",
    playback: "Playback & display",
    activity: "Activity",
    lock: "Parental lock"
  };
  var currentView = "home";

  // ---- manage words ----
  var blockChipsEl = $("pm-block-chips");
  var allowChipsEl = $("pm-allow-chips");
  var blockFormEl = $("pm-block-form");
  var allowFormEl = $("pm-allow-form");
  var blockInputEl = $("pm-block-input");
  var allowInputEl = $("pm-allow-input");
  var manageSubEl = $("pm-manage-sub");

  // ---- activity ----
  var homeMutedEl = $("pm-home-muted");
  var homeVideosEl = $("pm-home-videos");
  var homeCatsEl = $("pm-home-cats");
  var actMutedEl = $("pm-act-muted");
  var actVideosEl = $("pm-act-videos");
  var actCatsEl = $("pm-act-cats");
  var actTopEl = $("pm-act-top");
  var rangeOptEls = document.querySelectorAll(".pm-range-opt");

  // ---- lock ----
  var lockSetupEl = $("pm-lock-setup");
  var lockManageEl = $("pm-lock-manage");
  var lockNewEl = $("pm-lock-new");
  var lockConfirmEl = $("pm-lock-confirm");
  var lockSetEl = $("pm-lock-set");
  var lockRemoveEl = $("pm-lock-remove");
  var lockStatusEl = $("pm-lock-status");
  var homeGateEl = $("pm-home-gated") && $("pm-home-gated").parentNode;
  var actGateEl = $("pm-act-gated") && $("pm-act-gated").parentNode;
  var homeOverlayEl = $("pm-home-overlay");
  var actOverlayEl = $("pm-act-overlay");
  var homePassEl = $("pm-home-pass");
  var actPassEl = $("pm-act-pass");
  var homeUnlockEl = $("pm-home-unlock");
  var actUnlockEl = $("pm-act-unlock");
  var homeLockMsgEl = $("pm-home-lockmsg");
  var actLockMsgEl = $("pm-act-lockmsg");
  var relockBarEl = $("pm-relock-bar");
  var lockNowEl = $("pm-lock-now");
  var lockDrillLabelEl = $("pm-lock-drill-label");

  // ---- other surfaces ----
  var openOnboardingEl = $("pm-open-onboarding");
  var finishSetupEl = $("pm-finish-setup");
  var reviewCardEl = $("pm-review-card");
  var reviewYesEl = $("pm-review-yes");
  var reviewNoEl = $("pm-review-no");
  var shareEl = $("pm-share");
  var reportProblemEl = $("pm-report-problem");
  var viewSourceEl = $("pm-view-source");
  var healthEl = $("pm-health");
  var healthMessageEl = $("pm-health-message");
  var healthDetailEl = $("pm-health-detail");
  var healthReportEl = $("pm-health-report");

  var hasStorage =
    typeof chrome !== "undefined" && chrome && chrome.storage && chrome.storage.sync;
  var hasLocalStorage =
    typeof chrome !== "undefined" && chrome && chrome.storage && chrome.storage.local;

  function statsApi() { return (typeof window !== "undefined" && window.PMStats) || null; }
  function wordlistCore() {
    return (typeof window !== "undefined" && window.PMWordlist && window.PMWordlist._core) || null;
  }

  // ---- generic setting accessors (unchanged resolution rules) ----
  function core() { return wordlistCore(); }
  function catchupModes() {
    var c = core();
    return (c && Array.isArray(c.CATCHUP_MODES)) ? c.CATCHUP_MODES : ["mute", "pause", "play"];
  }
  function defaultCatchupMode() { var c = core(); return (c && c.DEFAULT_CATCHUP_MODE) || "mute"; }
  function paddingModes() { var c = core(); return (c && Array.isArray(c.PADDING_MODES)) ? c.PADDING_MODES : ["tight", "normal", "wide"]; }
  function defaultPadding() { var c = core(); return (c && c.DEFAULT_PADDING) || "normal"; }
  function strictnessModes() { var c = core(); return (c && Array.isArray(c.STRICTNESS_MODES)) ? c.STRICTNESS_MODES : ["none", "standard", "strict"]; }
  function defaultStrictness() { var c = core(); return (c && c.DEFAULT_STRICTNESS) || "strict"; }
  function resolveFromStorage(items) {
    var c = core();
    return (c && typeof c.resolveSettingsFromStorage === "function") ? c.resolveSettingsFromStorage(items) : null;
  }

  function setRadio(els, value, allowed, fallback) {
    var mode = allowed.indexOf(value) !== -1 ? value : fallback;
    for (var i = 0; i < els.length; i++) els[i].checked = els[i].value === mode;
  }
  function getRadio(els, fallback) {
    for (var i = 0; i < els.length; i++) if (els[i].checked) return els[i].value;
    return fallback;
  }
  function setCatchupMode(v) { setRadio(catchupModeEls, v, catchupModes(), defaultCatchupMode()); }
  function getCatchupMode() { return getRadio(catchupModeEls, defaultCatchupMode()); }
  function setPadding(v) { setRadio(paddingEls, v, paddingModes(), defaultPadding()); }
  function getPadding() { return getRadio(paddingEls, defaultPadding()); }
  function setStrictness(v) { setRadio(strictnessEls, v, strictnessModes(), defaultStrictness()); }
  function getStrictness() { return getRadio(strictnessEls, defaultStrictness()); }

  function setStatus(text) {
    statusEl.textContent = text || "";
    if (text) {
      window.clearTimeout(setStatus._t);
      setStatus._t = window.setTimeout(function () { statusEl.textContent = ""; }, 2200);
    }
  }

  // ---- navigation ------------------------------------------------------
  function showView(name) {
    if (!views[name]) name = "home";
    currentView = name;
    Object.keys(views).forEach(function (k) {
      var v = views[k];
      var on = k === name;
      v.classList.toggle("pm-hidden", !on);
      v.setAttribute("aria-hidden", on ? "false" : "true");
    });
    var isHome = name === "home";
    backEl.classList.toggle("pm-hidden", isHome);
    titleEl.textContent = VIEW_TITLES[name] || VIEW_TITLES.home;
    // The master switch belongs to the home header only.
    enabledWrapEl.classList.toggle("pm-hidden", !isHome);
    applyLockUI();
    if (name === "activity") renderActivity();
    if (name === "manage") renderManage();
    if (name === "lock") renderLockView();
  }

  // ==== Parental lock state machine =====================================
  var lockRecord = null;
  var unlockedThisSession = false;
  var lockStateLoaded = false;
  var idleTimer = null;
  var currentEnabled = true; // last known pm_enabled, for revert-on-locked

  function lockApi() { return (typeof window !== "undefined" && window.PMLock) || null; }
  function hasLock() {
    var api = lockApi();
    return !!(api && api.isLockRecord && api.isLockRecord(lockRecord));
  }
  function isLocked() { return hasLock() && !unlockedThisSession; }

  // null when a write may proceed; "loading" until pm_lock is read; "locked"
  // otherwise. This is the single point the popup decides write-permission.
  function settingsWriteBlockedReason() {
    var api = lockApi();
    if (!api || typeof api.mayWriteSettings !== "function") return null;
    if (!lockStateLoaded) return "loading";
    return api.mayWriteSettings(lockRecord, unlockedThisSession) ? null : "locked";
  }
  function maySaveSettings() { return settingsWriteBlockedReason() === null; }

  // Reflect lock state across the whole UI: overlays, blur, padlock, the
  // relock bar, the lock drill label, and the idle timer.
  function applyLockUI() {
    var locked = isLocked();
    var lockSet = hasLock();

    if (homeGateEl) homeGateEl.classList.toggle("pm-gate--locked", locked);
    if (actGateEl) actGateEl.classList.toggle("pm-gate--locked", locked);
    show(homeOverlayEl, locked);
    show(actOverlayEl, locked);

    // Padlock in header: only when a lock exists.
    lockIconEl.classList.toggle("pm-hidden", !lockSet);
    lockIconEl.textContent = locked ? "🔒" : "🔓"; // closed / open

    // Relock bar: only while unlocked with a lock set, and only on home.
    show(relockBarEl, lockSet && !locked && currentView === "home");

    lockDrillLabelEl.textContent = lockSet ? "Parental lock" : "Set a parental lock";

    if (lockSet && !locked) armIdle();
    else disarmIdle();
  }

  function show(el, visible) {
    if (!el) return;
    el.classList.toggle("pm-hidden", !visible);
    el.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  function setLockMsg(text) {
    if (homeLockMsgEl) homeLockMsgEl.textContent = text || "";
    if (actLockMsgEl) actLockMsgEl.textContent = text || "";
  }

  // Auto-relock after 5 minutes of no interaction (PMLock.shouldRelock is
  // the pure predicate). resetIdle() runs on every interaction so it never
  // relocks mid-use; the timer itself is a plain setTimeout re-armed on each
  // interaction.
  function idleMs() {
    var api = lockApi();
    return (api && api.IDLE_RELOCK_MS) || 5 * 60 * 1000;
  }
  function armIdle() {
    disarmIdle();
    idleTimer = window.setTimeout(relock, idleMs());
  }
  function disarmIdle() {
    if (idleTimer) { window.clearTimeout(idleTimer); idleTimer = null; }
  }
  function resetIdle() {
    if (hasLock() && !isLocked()) armIdle();
  }
  function relock() {
    if (!hasLock()) return;
    unlockedThisSession = false;
    disarmIdle();
    if (currentView !== "home" && currentView !== "activity") showView("home");
    else applyLockUI();
    setStatus("Locked");
  }

  function attemptUnlock(passEl, msgSetter) {
    var api = lockApi();
    if (!api) return;
    var attempt = passEl.value;
    api.verify(lockRecord, attempt).then(function (ok) {
      passEl.value = "";
      if (!ok) { msgSetter("Wrong password"); return; }
      unlockedThisSession = true;
      msgSetter("");
      resetIdle();
      applyLockUI();
      setStatus("Settings unlocked");
    });
  }

  function promptUnlock() {
    // Bring the parent to the home overlay and focus the field.
    if (currentView !== "home") showView("home");
    else applyLockUI();
    setStatus("Locked - enter the password to change settings");
    if (homePassEl) { try { homePassEl.focus(); } catch (e) {} }
  }

  function loadLock() {
    if (!hasStorage) { lockStateLoaded = true; applyLockUI(); return; }
    chrome.storage.sync.get(["pm_lock"], function (items) {
      if (chrome.runtime && chrome.runtime.lastError) {
        // Fail OPEN: a transient sync error must not brick a parent's own
        // settings, and the lock is a deterrent anyway.
        lockRecord = null;
        lockStateLoaded = true;
        applyLockUI();
        return;
      }
      lockRecord = (items && items.pm_lock) || null;
      lockStateLoaded = true;
      applyLockUI();
    });
  }

  // ---- lock view (set / remove) ----
  function renderLockView() {
    var api = lockApi();
    var lockSet = hasLock();
    if (api && typeof api.available === "function" && !api.available() && !lockSet) {
      show(lockSetupEl, false);
      show(lockManageEl, false);
      lockStatusEl.textContent = "Password locking isn't available in this browser.";
      return;
    }
    show(lockSetupEl, !lockSet);
    show(lockManageEl, lockSet);
  }

  function setLockPassword() {
    var api = lockApi();
    if (!api || !hasStorage) { lockStatusEl.textContent = "Password locking isn't available."; return; }
    var check = api.validateNewPassword(lockNewEl.value, lockConfirmEl.value);
    if (!check.ok) { lockStatusEl.textContent = check.error; return; }
    lockStatusEl.textContent = "";
    api.create(lockNewEl.value).then(function (record) {
      chrome.storage.sync.set({ pm_lock: record }, function () {
        if (chrome.runtime && chrome.runtime.lastError) { lockStatusEl.textContent = "Couldn't save the password"; return; }
        lockRecord = record;
        // Setting a lock does not lock the parent out of the popup they are
        // in - they stay unlocked this session; the next open is locked.
        unlockedThisSession = true;
        lockNewEl.value = ""; lockConfirmEl.value = "";
        renderLockView();
        applyLockUI();
        lockStatusEl.textContent = "Password set. Settings lock next time this popup opens.";
      });
    }, function () {
      lockStatusEl.textContent = "Couldn't set a password on this browser";
    });
  }

  function removeLockPassword() {
    if (!hasStorage) return;
    if (!maySaveSettings()) { lockStatusEl.textContent = "Unlock first"; return; }
    chrome.storage.sync.remove("pm_lock", function () {
      if (chrome.runtime && chrome.runtime.lastError) { lockStatusEl.textContent = "Couldn't remove the password"; return; }
      lockRecord = null;
      unlockedThisSession = false;
      renderLockView();
      applyLockUI();
      lockStatusEl.textContent = "Password removed";
    });
  }

  // ==== storage write funnel (the lock's enforcement point) =============
  function persistSettings(values, cb, area) {
    if (!hasStorage) { setStatus("Storage unavailable"); return false; }
    var blocked = settingsWriteBlockedReason();
    if (blocked === "loading") { setStatus("One moment..."); return false; }
    if (blocked) { setStatus("Locked - enter the password to change settings"); return false; }
    var target = area === "local" ? chrome.storage.local : chrome.storage.sync;
    if (!target) { setStatus("Storage unavailable"); return false; }
    target.set(values, function () {
      var failed = !!(chrome.runtime && chrome.runtime.lastError);
      if (cb) cb(failed);
    });
    return true;
  }

  // The toggle/radio settings, collected so every save path covers the same
  // keys. Arrays (pm_additionalWords/pm_allowWords) are written separately
  // by the Manage screen. pm_safeMode/pm_wordlist are never written.
  function currentSettingsValues() {
    return {
      pm_enabled: !!enabledEl.checked,
      pm_muteAudio: !!muteAudioEl.checked,
      pm_censorCaptions: !!censorCaptionsEl.checked,
      pm_catchupMode: getCatchupMode(),
      pm_debugOverlay: !!debugOverlayEl.checked,
      pm_showStatus: !!showStatusEl.checked,
      pm_strictness: getStrictness(),
      pm_padding: getPadding()
    };
  }

  function saveTogglesOnly() {
    persistSettings(currentSettingsValues(), function (failed) {
      setStatus(failed ? "Save failed" : "Saved");
    });
  }

  // The master switch lives in the header, outside the gated region, so its
  // click must be intercepted directly: when locked, revert the visual flip
  // and send the parent to the unlock prompt instead of writing.
  function onEnabledChange() {
    if (settingsWriteBlockedReason() === "locked") {
      enabledEl.checked = currentEnabled;
      promptUnlock();
      return;
    }
    currentEnabled = enabledEl.checked;
    saveTogglesOnly();
  }

  // ==== word lists (Manage words) =======================================
  var blockWords = [];
  var allowWords = [];

  function normalizeWord(raw) {
    return String(raw || "").trim().replace(/\s+/g, " ");
  }
  function dedupePush(list, word) {
    var key = word.toLowerCase();
    for (var i = 0; i < list.length; i++) if (list[i].toLowerCase() === key) return false;
    list.push(word);
    return true;
  }

  function renderChips(container, list, cls, onRemove) {
    container.innerHTML = "";
    if (!list.length) {
      var empty = document.createElement("span");
      empty.className = "pm-chips-empty";
      empty.textContent = "(none yet)";
      container.appendChild(empty);
      return;
    }
    list.forEach(function (word, idx) {
      var chip = document.createElement("span");
      chip.className = "pm-chip" + (cls ? " " + cls : "");
      var label = document.createElement("span");
      label.textContent = word;
      var x = document.createElement("button");
      x.type = "button";
      x.className = "pm-chip-x";
      x.setAttribute("aria-label", "Remove " + word);
      x.textContent = "×";
      x.addEventListener("click", function () { onRemove(idx); });
      chip.appendChild(label);
      chip.appendChild(x);
      container.appendChild(chip);
    });
  }

  function renderManage() {
    renderChips(blockChipsEl, blockWords, "", removeBlockWord);
    renderChips(allowChipsEl, allowWords, "pm-chip--allow", removeAllowWord);
    updateManageSub();
  }

  function updateManageSub() {
    if (!manageSubEl) return;
    var parts = [];
    parts.push(blockWords.length + " added");
    parts.push(allowWords.length + " allowed");
    manageSubEl.textContent = "· " + parts.join(", ");
  }

  function saveBlockWords() {
    persistSettings({ pm_additionalWords: blockWords.slice() }, function (failed) {
      setStatus(failed ? "Save failed" : "Saved");
      if (failed) loadSettings();
    });
  }
  function saveAllowWords() {
    persistSettings({ pm_allowWords: allowWords.slice() }, function (failed) {
      setStatus(failed ? "Save failed" : "Saved");
      if (failed) loadSettings();
    });
  }

  function addBlockWord() {
    var w = normalizeWord(blockInputEl.value);
    if (!w) return;
    blockInputEl.value = "";
    if (!dedupePush(blockWords, w)) { renderManage(); return; }
    renderManage();
    saveBlockWords();
  }
  function removeBlockWord(idx) {
    blockWords.splice(idx, 1);
    renderManage();
    saveBlockWords();
  }
  function addAllowWord() {
    var w = normalizeWord(allowInputEl.value);
    if (!w) return;
    allowInputEl.value = "";
    if (!dedupePush(allowWords, w)) { renderManage(); return; }
    renderManage();
    saveAllowWords();
  }
  function removeAllowWord(idx) {
    allowWords.splice(idx, 1);
    renderManage();
    saveAllowWords();
  }

  // ==== settings load ===================================================
  function setControlsToDefaults() {
    setCatchupMode(defaultCatchupMode());
    setPadding(defaultPadding());
    setStrictness(defaultStrictness());
  }

  function loadSettings() {
    setControlsToDefaults();
    if (!hasStorage) { setStatus("Storage unavailable"); return; }
    chrome.storage.sync.get(
      [
        "pm_enabled", "pm_muteAudio", "pm_censorCaptions", "pm_catchupMode",
        "pm_debugOverlay", "pm_showStatus", "pm_strictness",
        "pm_additionalWords", "pm_allowWords", "pm_padding", "pm_safeMode", "pm_wordlist"
      ],
      function (items) {
        if (chrome.runtime && chrome.runtime.lastError) {
          setStatus("Couldn't load saved settings - showing defaults");
          return;
        }
        items = items || {};
        enabledEl.checked = items.pm_enabled !== false;
        currentEnabled = enabledEl.checked;
        muteAudioEl.checked = items.pm_muteAudio !== false;
        censorCaptionsEl.checked = items.pm_censorCaptions !== false;
        debugOverlayEl.checked = items.pm_debugOverlay === true;
        showStatusEl.checked = items.pm_showStatus !== false;

        var displayedCatchup =
          catchupModes().indexOf(items.pm_catchupMode) !== -1 ? items.pm_catchupMode
            : items.pm_safeMode === false ? "play" : defaultCatchupMode();
        setCatchupMode(displayedCatchup);
        setPadding(paddingModes().indexOf(items.pm_padding) !== -1 ? items.pm_padding : defaultPadding());

        var resolved = resolveFromStorage(items);
        if (resolved) {
          setStrictness(resolved.strictness);
          blockWords = resolved.additionalWords.slice();
          allowWords = (resolved.allowWords || []).slice();
        }
        renderManage();
      }
    );
  }

  function restoreDefaults() {
    setStrictness(defaultStrictness());
    blockWords = [];
    var values = currentSettingsValues();
    values.pm_additionalWords = [];
    var attempted = persistSettings(values, function (failed) {
      if (failed) { setStatus("Save failed"); return; }
      renderManage();
      setStatus("Defaults restored");
    });
    if (!attempted) loadSettings();
  }

  // ==== Activity dashboard ==============================================
  var activityStore = null;
  var activeRange = "all";
  var CAT_LABELS = {
    profanity: "Profanity",
    slur: "Slurs",
    religious: "Religious",
    euphemism: "Euphemisms",
    custom: "Your words"
  };

  function renderCats(container, cats) {
    container.innerHTML = "";
    var order = statsApi() ? statsApi().CATEGORIES : ["profanity", "slur", "religious", "euphemism", "custom"];
    var rows = [];
    for (var i = 0; i < order.length; i++) {
      var k = order[i];
      var n = (cats && cats[k]) || 0;
      if (n > 0) rows.push({ key: k, n: n });
    }
    rows.sort(function (a, b) { return b.n - a.n; });
    if (!rows.length) {
      var empty = document.createElement("div");
      empty.className = "pm-cats-empty";
      empty.textContent = "No activity yet.";
      container.appendChild(empty);
      return;
    }
    var max = rows[0].n;
    rows.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "pm-stat";
      var lab = document.createElement("span");
      lab.textContent = CAT_LABELS[r.key] || r.key;
      var bar = document.createElement("span");
      bar.className = "pm-stat-bar";
      var fill = document.createElement("i");
      fill.style.width = (max > 0 ? Math.round((r.n / max) * 100) : 0) + "%";
      bar.appendChild(fill);
      var num = document.createElement("span");
      num.className = "pm-stat-n";
      num.textContent = String(r.n);
      row.appendChild(lab); row.appendChild(bar); row.appendChild(num);
      container.appendChild(row);
    });
  }

  function summarize(range) {
    var api = statsApi();
    if (!api) return { muted: 0, videos: 0, cats: {}, top: [] };
    return api.summarize(activityStore, range, Date.now());
  }

  function renderHomeSummary() {
    // Home summary always all-time (public even when locked).
    var s = summarize("all");
    homeMutedEl.textContent = String(s.muted);
    homeVideosEl.textContent = String(s.videos);
    renderCats(homeCatsEl, s.cats);
  }

  function renderActivity() {
    var s = summarize(activeRange);
    actMutedEl.textContent = String(s.muted);
    actVideosEl.textContent = String(s.videos);
    renderCats(actCatsEl, s.cats);
    renderMostMuted(s.top);
    for (var i = 0; i < rangeOptEls.length; i++) {
      rangeOptEls[i].classList.toggle("pm-range-on", rangeOptEls[i].getAttribute("data-range") === activeRange);
    }
  }

  function renderMostMuted(top) {
    actTopEl.innerHTML = "";
    if (!top || !top.length) {
      var empty = document.createElement("div");
      empty.className = "pm-mostmuted-empty";
      empty.textContent = "Nothing muted yet.";
      actTopEl.appendChild(empty);
      return;
    }
    top.forEach(function (item, i) {
      var row = document.createElement("div");
      row.className = "pm-mm";
      var left = document.createElement("span");
      var rk = document.createElement("span");
      rk.className = "pm-mm-rk";
      rk.textContent = String(i + 1);
      left.appendChild(rk);
      left.appendChild(document.createTextNode(item.word));
      var n = document.createElement("span");
      n.className = "pm-mm-n";
      n.textContent = String(item.count);
      row.appendChild(left); row.appendChild(n);
      actTopEl.appendChild(row);
    });
  }

  function loadActivity() {
    var api = statsApi();
    if (!hasLocalStorage || !api) { activityStore = api ? api.emptyStore() : null; renderHomeSummary(); return; }
    chrome.storage.local.get(["pm_activity"], function (items) {
      if (chrome.runtime && chrome.runtime.lastError) { activityStore = api.emptyStore(); renderHomeSummary(); return; }
      activityStore = api.normalizeStore(items && items.pm_activity);
      renderHomeSummary();
      if (currentView === "activity") renderActivity();
    });
  }

  // ==== moments / health / devlog (carried over) ========================
  function momentsApi() { return (typeof window !== "undefined" && window.PMMoments) || null; }

  function openExtensionPage(relativePath) {
    var url;
    try { url = chrome.runtime.getURL(relativePath); } catch (e) { return; }
    try { chrome.tabs.create({ url: url }); window.close(); }
    catch (e) { window.open(url, "_blank"); }
  }
  function openOnboarding() { openExtensionPage("onboarding/onboarding.html"); }
  function openReportProblem() { openExtensionPage("report/report.html"); }
  function openRepo() {
    var m = momentsApi(); if (!m) return;
    try { chrome.tabs.create({ url: m.REPO_URL }); window.close(); }
    catch (e) { window.open(m.REPO_URL, "_blank"); }
  }

  function renderAckSurfaces(ackRecord) {
    var m = momentsApi();
    var acknowledged = !!(m && m.isAcknowledged(ackRecord));
    finishSetupEl.classList.toggle("pm-hidden", acknowledged);
    finishSetupEl.setAttribute("aria-hidden", acknowledged ? "true" : "false");
    // Share stays available always in the footer, but only meaningful after
    // acknowledgment; keep it visible (footer link) and not gated.
  }

  function renderReviewPrompt(items) {
    var m = momentsApi(); if (!m) return;
    var verdict = m.reviewPromptEligibility({
      stats: (items && items.pm_stats) || {},
      installedAt: items && items.pm_installedAt,
      ack: items && items.pm_ackNotPerfect,
      reviewPrompt: items && items.pm_reviewPrompt,
      now: Date.now()
    });
    if (!verdict.eligible) return;
    reviewCardEl.classList.remove("pm-hidden");
    reviewCardEl.setAttribute("aria-hidden", "false");
    try { chrome.action.setBadgeText({ text: "" }); } catch (e) {}
    markReviewPromptShown(false);
  }

  function markReviewPromptShown(dismissed) {
    var m = momentsApi(); if (!m || !hasStorage) return;
    try {
      chrome.storage.sync.set({ pm_reviewPrompt: m.makeReviewPromptRecord(dismissed, Date.now()) });
    } catch (e) {}
  }
  function hideReviewCard() {
    reviewCardEl.classList.add("pm-hidden");
    reviewCardEl.setAttribute("aria-hidden", "true");
  }
  function bumpGrowth(key) {
    var m = momentsApi(); if (!m || !hasLocalStorage) return;
    try {
      chrome.storage.local.get(["pm_growth"], function (items) {
        if (chrome.runtime && chrome.runtime.lastError) return;
        chrome.storage.local.set({ pm_growth: m.bumpGrowthCounter(items && items.pm_growth, key) });
      });
    } catch (e) {}
  }
  function onReviewYes() {
    var m = momentsApi();
    markReviewPromptShown(true);
    bumpGrowth("milestoneReviewClicked");
    hideReviewCard();
    if (!m) return;
    try { chrome.tabs.create({ url: m.REVIEW_URL }); window.close(); }
    catch (e) { window.open(m.REVIEW_URL, "_blank"); }
  }
  function onReviewNo() {
    markReviewPromptShown(true);
    hideReviewCard();
    setStatus("Thanks - we won't ask again");
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopyText(text); });
    }
    return Promise.resolve(fallbackCopyText(text));
  }
  function fallbackCopyText(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      var ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }
  function flashShareCopied() {
    if (flashShareCopied._t) window.clearTimeout(flashShareCopied._t);
    else flashShareCopied._label = shareEl.textContent;
    shareEl.textContent = "Link copied";
    shareEl.classList.add("pm-share--copied");
    flashShareCopied._t = window.setTimeout(function () {
      shareEl.textContent = flashShareCopied._label;
      shareEl.classList.remove("pm-share--copied");
      flashShareCopied._t = null;
    }, 2500);
  }
  function shareWithFriend() {
    var m = momentsApi();
    if (!m) { setStatus("Share link unavailable"); return; }
    copyText(m.SHARE_TEXT).then(function (ok) {
      if (ok) { flashShareCopied(); setStatus("Link copied"); }
      else setStatus("Couldn't copy - select the link and copy it");
    });
  }

  function loadMoments() {
    if (!hasStorage) return;
    chrome.storage.sync.get(["pm_ackNotPerfect", "pm_installedAt", "pm_reviewPrompt"], function (syncItems) {
      if (chrome.runtime && chrome.runtime.lastError) return;
      syncItems = syncItems || {};
      renderAckSurfaces(syncItems.pm_ackNotPerfect);
      if (!hasLocalStorage) return;
      chrome.storage.local.get(["pm_stats"], function (localItems) {
        if (chrome.runtime && chrome.runtime.lastError) return;
        renderReviewPrompt({
          pm_ackNotPerfect: syncItems.pm_ackNotPerfect,
          pm_installedAt: syncItems.pm_installedAt,
          pm_reviewPrompt: syncItems.pm_reviewPrompt,
          pm_stats: (localItems && localItems.pm_stats) || {}
        });
      });
    });
  }

  function renderHealth(health) {
    var unhealthy = !!(health && health.status === "unhealthy" && health.message);
    healthEl.classList.toggle("pm-hidden", !unhealthy);
    healthEl.setAttribute("aria-hidden", unhealthy ? "false" : "true");
    if (!unhealthy) return;
    healthMessageEl.textContent = health.message;
    healthDetailEl.textContent = health.detail || "";
  }
  function loadHealth() {
    if (typeof chrome === "undefined" || !chrome.tabs || typeof chrome.tabs.query !== "function" || typeof chrome.tabs.sendMessage !== "function") return;
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (chrome.runtime && chrome.runtime.lastError) return;
        var tab = tabs && tabs[0];
        if (!tab || tab.id == null) return;
        try {
          chrome.tabs.sendMessage(tab.id, { type: "pm-health-query" }, function (resp) {
            if (chrome.runtime && chrome.runtime.lastError) return;
            renderHealth(resp);
          });
        } catch (e) {}
      });
    } catch (e) {}
  }

  function copyDevlog() {
    if (!hasLocalStorage) { setStatus("Storage unavailable"); return; }
    chrome.storage.local.get(["pm_devlog"], function (items) {
      if (chrome.runtime && chrome.runtime.lastError) { setStatus("Copy failed"); return; }
      var log = items && items.pm_devlog;
      if (!log || !log.videos || !log.videos.length) { setStatus("No debug log yet"); return; }
      var text;
      try { text = JSON.stringify(log); } catch (e) { setStatus("Copy failed"); return; }
      if (!navigator.clipboard || !navigator.clipboard.writeText) { setStatus("Clipboard unavailable"); return; }
      navigator.clipboard.writeText(text).then(
        function () { setStatus("Debug log copied (" + log.videos.length + " videos)"); },
        function () { setStatus("Copy failed"); }
      );
    });
  }

  // ==== live storage updates ============================================
  if (hasLocalStorage && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== "local") return;
        if (changes.pm_activity) {
          var api = statsApi();
          activityStore = api ? api.normalizeStore(changes.pm_activity.newValue) : null;
          renderHomeSummary();
          if (currentView === "activity") renderActivity();
        }
      });
    } catch (e) {}
  }

  // ==== event wiring ====================================================
  enabledEl.addEventListener("change", onEnabledChange);
  muteAudioEl.addEventListener("change", saveTogglesOnly);
  censorCaptionsEl.addEventListener("change", saveTogglesOnly);
  debugOverlayEl.addEventListener("change", saveTogglesOnly);
  showStatusEl.addEventListener("change", saveTogglesOnly);
  var i;
  for (i = 0; i < catchupModeEls.length; i++) catchupModeEls[i].addEventListener("change", saveTogglesOnly);
  for (i = 0; i < paddingEls.length; i++) paddingEls[i].addEventListener("change", saveTogglesOnly);
  for (i = 0; i < strictnessEls.length; i++) strictnessEls[i].addEventListener("change", saveTogglesOnly);

  restoreEl.addEventListener("click", restoreDefaults);
  copyDevlogEl.addEventListener("click", copyDevlog);

  // navigation
  backEl.addEventListener("click", function () { showView("home"); });
  $("pm-go-manage").addEventListener("click", function () { if (isLocked()) { promptUnlock(); return; } showView("manage"); });
  $("pm-go-playback").addEventListener("click", function () { if (isLocked()) { promptUnlock(); return; } showView("playback"); });
  $("pm-go-lock").addEventListener("click", function () { if (isLocked()) { promptUnlock(); return; } showView("lock"); });
  $("pm-open-activity").addEventListener("click", function () { showView("activity"); });
  $("pm-summary-tap").addEventListener("click", function () { showView("activity"); });

  // manage words
  blockFormEl.addEventListener("submit", function (e) { e.preventDefault(); addBlockWord(); });
  allowFormEl.addEventListener("submit", function (e) { e.preventDefault(); addAllowWord(); });

  // activity range toggle
  for (i = 0; i < rangeOptEls.length; i++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        activeRange = btn.getAttribute("data-range") || "all";
        renderActivity();
      });
    })(rangeOptEls[i]);
  }

  // lock
  lockSetEl.addEventListener("click", setLockPassword);
  lockRemoveEl.addEventListener("click", removeLockPassword);
  homeUnlockEl.addEventListener("click", function () { attemptUnlock(homePassEl, function (m) { if (homeLockMsgEl) homeLockMsgEl.textContent = m; }); });
  actUnlockEl.addEventListener("click", function () { attemptUnlock(actPassEl, function (m) { if (actLockMsgEl) actLockMsgEl.textContent = m; }); });
  homePassEl.addEventListener("keydown", function (ev) { if (ev.key === "Enter") homeUnlockEl.click(); });
  actPassEl.addEventListener("keydown", function (ev) { if (ev.key === "Enter") actUnlockEl.click(); });
  lockConfirmEl.addEventListener("keydown", function (ev) { if (ev.key === "Enter") setLockPassword(); });
  lockNowEl.addEventListener("click", relock);
  lockIconEl.addEventListener("click", function () {
    if (isLocked()) promptUnlock();
    else if (hasLock()) relock();
  });

  // moments / footer
  openOnboardingEl.addEventListener("click", openOnboarding);
  finishSetupEl.addEventListener("click", openOnboarding);
  reviewYesEl.addEventListener("click", onReviewYes);
  reviewNoEl.addEventListener("click", onReviewNo);
  shareEl.addEventListener("click", shareWithFriend);
  reportProblemEl.addEventListener("click", openReportProblem);
  healthReportEl.addEventListener("click", openReportProblem);
  viewSourceEl.addEventListener("click", openRepo);

  // idle-timer reset on any interaction with the popup (so it never relocks
  // while actively in use). Capture phase so it sees every event.
  ["click", "keydown", "scroll", "input"].forEach(function (type) {
    document.addEventListener(type, resetIdle, true);
  });

  // ==== boot ============================================================
  loadSettings();
  loadActivity();
  applyLockUI();
  loadLock();
  loadMoments();
  loadHealth();
  showView("home");
})();
