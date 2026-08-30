// popup/popup.js
// Popup UI logic. Reads/writes chrome.storage.sync directly (pm_enabled,
// pm_muteAudio, pm_censorCaptions, pm_catchupMode, pm_debugOverlay,
// pm_showStatus, pm_wordlist) per the shared schema used by
// shared/wordlist.js and captions.js.
//
// Separately, the STATS section reads/writes chrome.storage.LOCAL (not
// sync) key pm_stats ({totalMuted, videosProtected}), written by the
// audio pipeline. This is a different storage AREA on purpose — stats
// are per-install telemetry, not something that should sync across a
// user's devices — so it's handled independently of the settings
// load()/save() flow above, with its own chrome.storage.onChanged
// listener filtered to areaName === "local".
//
// pm_safeMode has been merged into pm_catchupMode ("mute" | "pause" |
// "play") and is NEVER written by this popup anymore — there is no
// separate Safe mode toggle. It is still read once, by
// shared/wordlist.js's resolveSettingsFromStorage, purely to migrate a
// legacy `pm_safeMode === false` (old "safe mode off") forward into
// `pm_catchupMode: "play"` the first time settings are resolved after
// an update, if the user never explicitly picks a catch-up mode.
//
// Word list handling:
//   - The textarea is always the source of truth for the word list —
//     it holds the real words whether or not it's currently visible.
//   - A masked, read-only view is shown by default (each entry
//     rendered as asterisks matching its shape) so opening the popup
//     never flashes explicit text. "Show words to edit" swaps to the
//     real textarea; editing requires unmasking.
//   - Save always writes exactly what's in the textarea to pm_wordlist
//     (including an intentionally-emptied list). The built-in defaults
//     are only used by shared/wordlist.js when pm_wordlist has never
//     been saved at all.
//
// BUG FIX (2026-08-30) — "clicking the icon doesn't load the settings
// UI properly": chrome.storage.sync.get() is a real async round trip,
// not an instant local read (it can hit sync's own rate limits/quota
// errors, or just take a moment) — but every control's HTML started in
// its "off"/empty state, only becoming correct once that callback
// resolved. Two consequences: (1) on ANY storage error
// (chrome.runtime.lastError — quota exceeded, sync disabled, a
// transient failure), load()'s callback bailed out immediately,
// permanently leaving every toggle looking off and the word list
// area completely empty, with only a small, easy-to-miss "Failed to
// load settings" status line — this reproduced 100% with a simulated
// storage error and looked exactly like "the settings UI doesn't load
// very well". (2) Even without an error, there was a real window
// (however brief) after the popup opens but before storage.get()
// resolves where the same broken-looking all-off/empty state was
// visible, and popups are dismissed on blur — a user who clicks away
// during that window never sees it "load" at all. Fix: the HTML now
// ships with its real defaults already `checked`, and popup.js
// synchronously pre-renders the default word list and default
// catch-up mode BEFORE ever calling chrome.storage.sync.get() — so the
// popup is fully correct and usable the instant it paints, with zero
// dependency on storage latency. The async load() call then only ever
// needs to *reconcile* to the user's actual saved settings if they
// differ from defaults; on a storage error, it now leaves the
// already-correct UI alone instead of blanking it, and only surfaces
// the status message.

(function () {
  "use strict";

  var enabledEl = document.getElementById("pm-enabled");
  var muteAudioEl = document.getElementById("pm-mute-audio");
  var censorCaptionsEl = document.getElementById("pm-censor-captions");
  var catchupModeEls = document.getElementsByName("pm-catchup-mode");
  var debugOverlayEl = document.getElementById("pm-debug-overlay");
  var showStatusEl = document.getElementById("pm-show-status");
  var wordlistEl = document.getElementById("pm-wordlist");
  var maskedListEl = document.getElementById("pm-masked-list");
  var toggleMaskEl = document.getElementById("pm-toggle-mask");
  var restoreEl = document.getElementById("pm-restore");
  var saveEl = document.getElementById("pm-save");
  var statusEl = document.getElementById("pm-status");
  var statsLineEl = document.getElementById("pm-stats-line");
  var resetStatsEl = document.getElementById("pm-reset-stats");

  var hasStorage =
    typeof chrome !== "undefined" &&
    chrome &&
    chrome.storage &&
    chrome.storage.sync;

  var hasLocalStorage =
    typeof chrome !== "undefined" &&
    chrome &&
    chrome.storage &&
    chrome.storage.local;

  function defaultWordlist() {
    if (
      typeof window !== "undefined" &&
      window.PMWordlist &&
      window.PMWordlist._core &&
      Array.isArray(window.PMWordlist._core.DEFAULT_WORDLIST)
    ) {
      return window.PMWordlist._core.DEFAULT_WORDLIST;
    }
    return [];
  }

  function catchupModes() {
    if (
      typeof window !== "undefined" &&
      window.PMWordlist &&
      window.PMWordlist._core &&
      Array.isArray(window.PMWordlist._core.CATCHUP_MODES)
    ) {
      return window.PMWordlist._core.CATCHUP_MODES;
    }
    return ["mute", "pause", "play"];
  }

  function defaultCatchupMode() {
    if (
      typeof window !== "undefined" &&
      window.PMWordlist &&
      window.PMWordlist._core &&
      window.PMWordlist._core.DEFAULT_CATCHUP_MODE
    ) {
      return window.PMWordlist._core.DEFAULT_CATCHUP_MODE;
    }
    return "mute";
  }

  function setCatchupMode(value) {
    var mode = catchupModes().indexOf(value) !== -1 ? value : defaultCatchupMode();
    for (var i = 0; i < catchupModeEls.length; i++) {
      catchupModeEls[i].checked = catchupModeEls[i].value === mode;
    }
  }

  function getCatchupMode() {
    for (var i = 0; i < catchupModeEls.length; i++) {
      if (catchupModeEls[i].checked) return catchupModeEls[i].value;
    }
    return defaultCatchupMode();
  }

  function setStatus(text) {
    statusEl.textContent = text;
    if (text) {
      window.clearTimeout(setStatus._t);
      setStatus._t = window.setTimeout(function () {
        statusEl.textContent = "";
      }, 2000);
    }
  }

  function parseWordlist(raw) {
    return raw
      .split("\n")
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line.length > 0; });
  }

  // Mask a single entry, preserving spaces (so a masked phrase still
  // reads as multiple words) but turning every other character into
  // an asterisk — no letters, shape only.
  function maskEntry(entry) {
    return entry.replace(/\S/g, "*");
  }

  function renderMasked() {
    var words = parseWordlist(wordlistEl.value);
    maskedListEl.innerHTML = "";
    if (!words.length) {
      var empty = document.createElement("div");
      empty.className = "pm-masked-empty";
      empty.textContent = "(list is empty — no words will be censored)";
      maskedListEl.appendChild(empty);
      return;
    }
    words.forEach(function (word) {
      var line = document.createElement("div");
      line.textContent = maskEntry(word);
      maskedListEl.appendChild(line);
    });
  }

  var masked = true;

  function showMasked() {
    renderMasked();
    maskedListEl.classList.remove("pm-hidden");
    maskedListEl.setAttribute("aria-hidden", "false");
    wordlistEl.classList.add("pm-hidden");
    wordlistEl.setAttribute("aria-hidden", "true");
    toggleMaskEl.textContent = "Show words to edit";
    masked = true;
  }

  function showUnmasked() {
    maskedListEl.classList.add("pm-hidden");
    maskedListEl.setAttribute("aria-hidden", "true");
    wordlistEl.classList.remove("pm-hidden");
    wordlistEl.setAttribute("aria-hidden", "false");
    toggleMaskEl.textContent = "Hide words";
    masked = false;
    wordlistEl.focus();
  }

  function toggleMask() {
    if (masked) {
      showUnmasked();
    } else {
      showMasked();
    }
  }

  // Synchronous, correct-by-default render — runs immediately, before
  // any chrome.storage.sync call, so the popup is fully usable and
  // visually correct (real default word list shown, defaults selected)
  // the instant it paints, independent of storage latency or errors.
  // The static HTML already ships `checked` on the default-true
  // toggles and the default "mute" radio, so this only needs to handle
  // what plain HTML can't: populating the word list and rendering the
  // masked view.
  function renderDefaultsSynchronously() {
    wordlistEl.value = defaultWordlist().join("\n");
    setCatchupMode(defaultCatchupMode());
    showMasked();
  }

  function load() {
    renderDefaultsSynchronously();

    if (!hasStorage) {
      setStatus("Storage unavailable");
      return;
    }
    // Array form, NOT the "defaults object" form — a defaults object
    // with an `undefined`-valued key (e.g. { pm_wordlist: undefined })
    // silently drops that key from the request, so it ALWAYS comes
    // back undefined even when a real value was saved. That was the
    // bug: the popup would always show the built-in defaults and, on
    // Save, silently overwrite a real saved custom word list. Default
    // manually, in code, on the raw result instead.
    chrome.storage.sync.get(
      [
        "pm_enabled",
        "pm_muteAudio",
        "pm_censorCaptions",
        "pm_catchupMode",
        "pm_debugOverlay",
        "pm_showStatus",
        "pm_safeMode", // read-only, for the legacy-migration display below
        "pm_wordlist"
      ],
      function (items) {
        // BUG FIX: this used to `return` here, leaving the popup
        // however it happened to look at that instant (which, before
        // the synchronous pre-render above existed, meant permanently
        // blank/all-off). Now the popup was already fully correct via
        // renderDefaultsSynchronously() before this callback ever ran,
        // so on error we simply leave it as-is (showing built-in
        // defaults, exactly what shared/wordlist.js itself falls back
        // to at runtime when it can't read storage either) and only
        // add the status message — never blank a working UI.
        if (chrome.runtime && chrome.runtime.lastError) {
          setStatus("Couldn't load saved settings — showing defaults");
          return;
        }
        items = items || {};
        enabledEl.checked = items.pm_enabled !== false;
        muteAudioEl.checked = items.pm_muteAudio !== false;
        censorCaptionsEl.checked = items.pm_censorCaptions !== false;
        debugOverlayEl.checked = items.pm_debugOverlay === true;
        showStatusEl.checked = items.pm_showStatus !== false;
        // Invalid/unset pm_catchupMode falls back to the default
        // ("mute") UNLESS the legacy pm_safeMode was explicitly saved
        // as false, in which case the radio group should reflect the
        // migrated "play" choice — same rule as
        // resolveSettingsFromStorage in shared/wordlist.js, duplicated
        // here just for what the popup *displays* (the popup never
        // writes pm_safeMode itself; once the user picks any option
        // here and it saves, pm_catchupMode becomes explicitly set and
        // this legacy fallback no longer applies).
        var displayedCatchupMode =
          catchupModes().indexOf(items.pm_catchupMode) !== -1
            ? items.pm_catchupMode
            : items.pm_safeMode === false
              ? "play"
              : defaultCatchupMode();
        setCatchupMode(displayedCatchupMode);

        // pm_wordlist has never been saved -> keep showing the full,
        // real, editable default list already rendered above (not a
        // placeholder). Once saved, show exactly what was saved, even
        // if that's an empty list.
        var words = Array.isArray(items.pm_wordlist)
          ? items.pm_wordlist
          : defaultWordlist();
        wordlistEl.value = words.join("\n");
        if (masked) renderMasked();
      }
    );
  }

  function save() {
    if (!hasStorage) {
      setStatus("Storage unavailable");
      return;
    }
    var words = parseWordlist(wordlistEl.value);
    chrome.storage.sync.set(
      {
        pm_enabled: !!enabledEl.checked,
        pm_muteAudio: !!muteAudioEl.checked,
        pm_censorCaptions: !!censorCaptionsEl.checked,
        pm_catchupMode: getCatchupMode(),
        pm_debugOverlay: !!debugOverlayEl.checked,
        pm_showStatus: !!showStatusEl.checked,
        // pm_safeMode is intentionally NOT written here — it's been
        // merged into pm_catchupMode. Leaving pm_safeMode untouched in
        // storage is fine: once pm_catchupMode is explicitly saved
        // (this call), resolveSettingsFromStorage always prefers it
        // and never looks at pm_safeMode again.
        // Written exactly as-is, including an intentionally empty list.
        pm_wordlist: words
      },
      function () {
        if (chrome.runtime && chrome.runtime.lastError) {
          setStatus("Save failed");
          return;
        }
        if (masked) renderMasked();
        setStatus("Saved");
      }
    );
  }

  // Toggles save immediately for snappy feel; the word list needs the
  // explicit Save button since it's free-form text.
  //
  // IMPORTANT for perceived responsiveness: the checkbox/radio's own
  // visual flip is pure CSS driven off `:checked` (see popup.css) and
  // already happened, natively, before this "change" handler even
  // runs — this function must stay fire-and-forget. Never make the
  // toggle's visual state (or re-check/re-render any input here) wait
  // on the chrome.storage.sync.set() callback; the callback below is
  // ONLY allowed to touch the status text, never re-read storage or
  // re-set .checked on any control (that would double-flip / lag the
  // toggle behind a round trip that doesn't need to block anything).
  function saveTogglesOnly() {
    if (!hasStorage) return;
    chrome.storage.sync.set(
      {
        pm_enabled: !!enabledEl.checked,
        pm_muteAudio: !!muteAudioEl.checked,
        pm_censorCaptions: !!censorCaptionsEl.checked,
        pm_catchupMode: getCatchupMode(),
        pm_debugOverlay: !!debugOverlayEl.checked,
        pm_showStatus: !!showStatusEl.checked
        // pm_safeMode intentionally not written — see save() comment.
      },
      function () {
        if (chrome.runtime && chrome.runtime.lastError) {
          setStatus("Save failed");
        } else {
          setStatus("Saved");
        }
      }
    );
  }

  function restoreDefaults() {
    wordlistEl.value = defaultWordlist().join("\n");
    if (masked) {
      renderMasked();
    }
    setStatus("Defaults loaded — click Save to keep");
  }

  // ---- Stats section (chrome.storage.LOCAL, not sync) ----
  //
  // pm_stats = {totalMuted, videosProtected}, written by the audio
  // pipeline as it runs. May be entirely absent (fresh install, or the
  // pipeline hasn't muted anything yet) — render zeros in that case
  // rather than leaving the line blank or erroring. Numbers are
  // sanitized (Number(...) with a NaN->0 fallback) so a malformed
  // stored value can't break the display.
  function renderStats(stats) {
    stats = stats || {};
    var totalMuted = Number(stats.totalMuted);
    var videosProtected = Number(stats.videosProtected);
    if (!Number.isFinite(totalMuted)) totalMuted = 0;
    if (!Number.isFinite(videosProtected)) videosProtected = 0;
    statsLineEl.textContent =
      "words muted all-time: " + totalMuted + " · videos protected: " + videosProtected;
  }

  function loadStats() {
    if (!hasLocalStorage) {
      renderStats(null);
      return;
    }
    chrome.storage.local.get(["pm_stats"], function (items) {
      if (chrome.runtime && chrome.runtime.lastError) {
        renderStats(null);
        return;
      }
      renderStats(items && items.pm_stats);
    });
  }

  function resetStats() {
    if (!hasLocalStorage) {
      renderStats(null);
      setStatus("Storage unavailable");
      return;
    }
    var zeroed = { totalMuted: 0, videosProtected: 0 };
    // Render immediately (fire-and-forget, same rule as the toggles) —
    // don't wait on the write to confirm before showing zeros.
    renderStats(zeroed);
    chrome.storage.local.set({ pm_stats: zeroed }, function () {
      if (chrome.runtime && chrome.runtime.lastError) {
        setStatus("Reset failed");
      } else {
        setStatus("Stats reset");
      }
    });
  }

  // Live-update the stats line as the audio pipeline writes new totals
  // while the popup happens to be open, without polling.
  if (hasLocalStorage && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== "local") return;
        if (changes.pm_stats) {
          renderStats(changes.pm_stats.newValue);
        }
      });
    } catch (e) {
      // ignore — non-fatal if listener registration fails
    }
  }

  enabledEl.addEventListener("change", saveTogglesOnly);
  muteAudioEl.addEventListener("change", saveTogglesOnly);
  censorCaptionsEl.addEventListener("change", saveTogglesOnly);
  debugOverlayEl.addEventListener("change", saveTogglesOnly);
  showStatusEl.addEventListener("change", saveTogglesOnly);
  for (var ci = 0; ci < catchupModeEls.length; ci++) {
    catchupModeEls[ci].addEventListener("change", saveTogglesOnly);
  }
  toggleMaskEl.addEventListener("click", toggleMask);
  restoreEl.addEventListener("click", restoreDefaults);
  saveEl.addEventListener("click", save);
  resetStatsEl.addEventListener("click", resetStats);

  load();
  renderStats(null); // synchronous zeros first, same correct-by-default pattern as settings
  loadStats();
})();
