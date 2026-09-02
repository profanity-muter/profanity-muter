// popup/popup.js
// Popup UI logic. Reads/writes chrome.storage.sync directly (pm_enabled,
// pm_muteAudio, pm_censorCaptions, pm_catchupMode, pm_debugOverlay,
// pm_showStatus, pm_strictness, pm_padding, pm_multilingual, pm_wordlist)
// per the shared schema used by shared/wordlist.js and captions.js.
//
// pm_multilingual (boolean, default true) — "Filter other languages"
// toggle. This popup only stores the setting; the audio pipeline's
// Whisper-based language detection reads it (via
// PMWordlist.settings.multilingual) to decide whether to call
// PMWordlist.setLanguage(lang) when it detects non-English speech.
// pm_strictness/pm_wordlist (the whole Strictness section below) is an
// ENGLISH-ONLY concept — it has no effect on which words are filtered
// for any other language a pack was loaded for; every non-English pack
// always uses its own full (core + extended) word list. The Word list
// section below shows which non-English pack, if any, is currently
// active (via chrome.storage.LOCAL's pm_activeLanguage, written by
// shared/wordlist.js's setLanguage() — see "Active non-English language
// pack display" further down).
//
// pm_strictness ("standard" | "strict" | "custom", default "strict")
// selects which word list is ACTIVE, and interacts with pm_wordlist
// under an "explicit mode beats implicit override" rule — full details
// in shared/wordlist.js's resolveSettingsFromStorage, mirrored here for
// the popup's own display/editing logic:
//   - "standard" -> shows/uses PMWordlist._core.CORE_WORDLIST (built-in,
//     read-only in this popup)
//   - "strict"   -> shows/uses the full DEFAULT_WORDLIST (built-in,
//     read-only in this popup)
//   - "custom"   -> shows/uses the editable textarea's content
//     (pm_wordlist), same masked/unmasked editing flow as before
// In "standard"/"strict", pm_wordlist is never read for display and
// Save doesn't touch it either (see save()) — but the moment the user
// starts editing (unmask) or explicitly saves word-list changes, the
// popup auto-switches pm_strictness to "custom" first, per explicit
// product direction ("explicit mode beats implicit override" cuts both
// ways: editing IS the user explicitly choosing custom). Switching to
// "custom" with no pm_wordlist ever saved seeds the textarea with the
// FULL STRICT list (CORE + EXTENDED) as a pruning starting point,
// regardless of which built-in mode was active beforehand.
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
  var multilingualEl = document.getElementById("pm-multilingual");
  var activeLanguageNoteEl = document.getElementById("pm-active-language-note");
  var catchupModeEls = document.getElementsByName("pm-catchup-mode");
  var debugOverlayEl = document.getElementById("pm-debug-overlay");
  var showStatusEl = document.getElementById("pm-show-status");
  var paddingEls = document.getElementsByName("pm-padding");
  var strictnessEls = document.getElementsByName("pm-strictness");
  var wordlistEl = document.getElementById("pm-wordlist");
  var wordlistModeNoteEl = document.getElementById("pm-wordlist-mode-note");
  var wordlistHintEl = document.getElementById("pm-wordlist-hint");
  var maskedListEl = document.getElementById("pm-masked-list");
  var toggleMaskEl = document.getElementById("pm-toggle-mask");
  var restoreEl = document.getElementById("pm-restore");
  var saveEl = document.getElementById("pm-save");
  var statusEl = document.getElementById("pm-status");
  var statsLineEl = document.getElementById("pm-stats-line");
  var resetStatsEl = document.getElementById("pm-reset-stats");
  var copyDevlogEl = document.getElementById("pm-copy-devlog");

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

  function coreWordlist() {
    if (
      typeof window !== "undefined" &&
      window.PMWordlist &&
      window.PMWordlist._core &&
      Array.isArray(window.PMWordlist._core.CORE_WORDLIST)
    ) {
      return window.PMWordlist._core.CORE_WORDLIST;
    }
    return [];
  }

  function paddingModes() {
    if (
      typeof window !== "undefined" &&
      window.PMWordlist &&
      window.PMWordlist._core &&
      Array.isArray(window.PMWordlist._core.PADDING_MODES)
    ) {
      return window.PMWordlist._core.PADDING_MODES;
    }
    return ["tight", "normal", "wide"];
  }

  function defaultPadding() {
    if (
      typeof window !== "undefined" &&
      window.PMWordlist &&
      window.PMWordlist._core &&
      window.PMWordlist._core.DEFAULT_PADDING
    ) {
      return window.PMWordlist._core.DEFAULT_PADDING;
    }
    return "normal";
  }

  function setPadding(value) {
    var mode = paddingModes().indexOf(value) !== -1 ? value : defaultPadding();
    for (var i = 0; i < paddingEls.length; i++) {
      paddingEls[i].checked = paddingEls[i].value === mode;
    }
  }

  function getPadding() {
    for (var i = 0; i < paddingEls.length; i++) {
      if (paddingEls[i].checked) return paddingEls[i].value;
    }
    return defaultPadding();
  }

  function strictnessModes() {
    if (
      typeof window !== "undefined" &&
      window.PMWordlist &&
      window.PMWordlist._core &&
      Array.isArray(window.PMWordlist._core.STRICTNESS_MODES)
    ) {
      return window.PMWordlist._core.STRICTNESS_MODES;
    }
    return ["standard", "strict", "custom"];
  }

  function defaultStrictness() {
    if (
      typeof window !== "undefined" &&
      window.PMWordlist &&
      window.PMWordlist._core &&
      window.PMWordlist._core.DEFAULT_STRICTNESS
    ) {
      return window.PMWordlist._core.DEFAULT_STRICTNESS;
    }
    return "strict";
  }

  function setStrictness(value) {
    var mode = strictnessModes().indexOf(value) !== -1 ? value : defaultStrictness();
    for (var i = 0; i < strictnessEls.length; i++) {
      strictnessEls[i].checked = strictnessEls[i].value === mode;
    }
  }

  function getStrictness() {
    for (var i = 0; i < strictnessEls.length; i++) {
      if (strictnessEls[i].checked) return strictnessEls[i].value;
    }
    return defaultStrictness();
  }

  // Tracks whether pm_wordlist has ever actually been saved (an array,
  // even an empty one) — set from load()'s reconciliation and after a
  // successful word-list Save. Drives the "seed with the full strict
  // list only if nothing is saved yet" rule when entering custom mode.
  var hasSavedCustomWordlist = false;

  // The word list currently ACTIVE for display/matching purposes,
  // depending on strictness — NOT necessarily the textarea's raw
  // content (the textarea is only the source of truth while in
  // "custom"; in "standard"/"strict" it just holds whatever draft the
  // user last had in "custom", untouched and unused for display).
  function activeWordlistForDisplay() {
    var mode = getStrictness();
    if (mode === "standard") return coreWordlist();
    if (mode === "strict") return defaultWordlist();
    return parseWordlist(wordlistEl.value);
  }

  // Enter "custom" mode's editing state: seed the textarea with the
  // full strict list (CORE + EXTENDED) ONLY if no custom list has ever
  // been saved — otherwise leave the textarea alone (it already holds
  // the real saved custom list, kept in sync by load()'s reconciliation
  // even while a built-in mode is on-screen, precisely so this seeding
  // decision can be made correctly here).
  function enterCustomMode() {
    if (!hasSavedCustomWordlist) {
      wordlistEl.value = defaultWordlist().join("\n");
    }
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

  var STRICTNESS_LABELS = { standard: "Standard", strict: "Strict", custom: "Custom" };

  function updateWordlistModeNote(words) {
    var label = STRICTNESS_LABELS[getStrictness()] || "Strict";
    wordlistModeNoteEl.textContent = "Showing: " + label + " (" + words.length + " words)";
  }

  function updateWordlistHint() {
    if (getStrictness() === "custom") {
      wordlistHintEl.textContent =
        'Words are masked by default. Click "Show words to edit" to reveal and edit the real list (one word or phrase per line).';
    } else {
      wordlistHintEl.textContent =
        'This is a built-in list and can\'t be edited directly — click "Show words to edit" to switch to Custom and start from it.';
    }
  }

  function renderMasked() {
    var words = activeWordlistForDisplay();
    updateWordlistModeNote(words);
    updateWordlistHint();
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

  // Clicking "Show words to edit" in "standard"/"strict" doesn't just
  // unmask — there's nothing editable to unmask to yet, since the
  // textarea isn't the active source in those modes. It first switches
  // strictness to "custom" (seeding the textarea per enterCustomMode's
  // rule), saves that mode switch immediately (same instant-on-select
  // contract as picking the radio directly), and only then reveals the
  // now-genuinely-editable textarea.
  function switchToCustomForEditing() {
    enterCustomMode();
    setStrictness("custom");
    saveTogglesOnly();
    // The mode note/hint (e.g. "Showing: Standard (107 words)") are
    // always-visible elements, not hidden along with the masked list —
    // refresh them here even though we're about to unmask (renderMasked()
    // rebuilding the now-irrelevant masked DOM underneath is harmless
    // and cheap; keeping ONE place that updates the note/hint avoids
    // them going stale on any mode-changing path).
    renderMasked();
    showUnmasked();
  }

  function toggleMask() {
    if (masked) {
      if (getStrictness() === "custom") {
        showUnmasked();
      } else {
        switchToCustomForEditing();
      }
    } else {
      showMasked();
    }
  }

  // Fires on every direct Strictness radio click. Entering "custom"
  // this way seeds the textarea exactly like the edit-button path
  // (enterCustomMode's "only if nothing saved yet" rule). Any direct
  // mode switch returns to a safe masked view showing the newly-active
  // list — the user can click "Show words to edit" afterward if they
  // want to edit (only meaningful once already in "custom").
  function onStrictnessChange() {
    if (getStrictness() === "custom") {
      enterCustomMode();
    }
    showMasked();
    saveTogglesOnly();
  }

  // Synchronous, correct-by-default render — runs immediately, before
  // any chrome.storage.sync call, so the popup is fully usable and
  // visually correct (real default word list shown, defaults selected)
  // the instant it paints, independent of storage latency or errors.
  // The static HTML already ships `checked` on the default-true
  // toggles and the default "mute"/"normal"/"strict" radios, so this
  // only needs to handle what plain HTML can't: populating the word
  // list textarea and rendering the masked view.
  function renderDefaultsSynchronously() {
    wordlistEl.value = defaultWordlist().join("\n");
    setCatchupMode(defaultCatchupMode());
    setPadding(defaultPadding());
    setStrictness(defaultStrictness());
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
        "pm_strictness",
        "pm_padding",
        "pm_multilingual",
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
        multilingualEl.checked = items.pm_multilingual !== false;
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

        var displayedPadding =
          paddingModes().indexOf(items.pm_padding) !== -1
            ? items.pm_padding
            : defaultPadding();
        setPadding(displayedPadding);

        // Same "explicit value wins, else migrate off a legacy signal,
        // else default" pattern as pm_catchupMode above, mirroring
        // resolveSettingsFromStorage in shared/wordlist.js: a saved
        // pm_wordlist with no saved pm_strictness migrates the DISPLAY
        // to "custom" (preserving what the user already had before
        // strictness existed); no saved list at all defaults to
        // "strict".
        hasSavedCustomWordlist = Array.isArray(items.pm_wordlist);
        var displayedStrictness =
          strictnessModes().indexOf(items.pm_strictness) !== -1
            ? items.pm_strictness
            : hasSavedCustomWordlist
              ? "custom"
              : defaultStrictness();
        setStrictness(displayedStrictness);

        // Keep the textarea in sync with the REAL saved custom list
        // whenever one exists, even while a built-in mode
        // ("standard"/"strict") is what's actually on screen — this is
        // what lets switchToCustomForEditing()/enterCustomMode() later
        // correctly resume the user's existing custom list instead of
        // re-seeding over it. When there's no saved custom list, leave
        // the textarea holding the full strict list already set by
        // renderDefaultsSynchronously() above (a reasonable seed).
        if (hasSavedCustomWordlist) {
          wordlistEl.value = items.pm_wordlist.join("\n");
        }
        // Always refresh (not just `if (masked)`) — the mode note/hint
        // are visible regardless of masked/unmasked state.
        renderMasked();
      }
    );
  }

  function save() {
    if (!hasStorage) {
      setStatus("Storage unavailable");
      return;
    }
    // Saving word-list edits always means the user is explicitly
    // choosing "custom" — per spec, this holds even for the edge case
    // of clicking Save while still displaying "standard"/"strict"
    // without ever unmasking first. Do this BEFORE reading the
    // textarea so activeWordlistForDisplay()/getStrictness() below
    // reflect "custom" too.
    if (getStrictness() !== "custom") {
      setStrictness("custom");
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
        pm_strictness: getStrictness(),
        pm_padding: getPadding(),
        pm_multilingual: !!multilingualEl.checked,
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
        hasSavedCustomWordlist = true;
        // Always refresh (not just `if (masked)`) — the mode note
        // (e.g. word count) is visible regardless of masked/unmasked
        // state, and Save may have just switched strictness to
        // "custom" (see the top of this function).
        renderMasked();
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
        pm_showStatus: !!showStatusEl.checked,
        pm_strictness: getStrictness(),
        pm_padding: getPadding(),
        pm_multilingual: !!multilingualEl.checked
        // pm_safeMode intentionally not written — see save() comment.
        // pm_wordlist is intentionally NOT written here either — this
        // is the fire-and-forget settings-only save path shared by
        // every toggle/radio EXCEPT the free-form word-list textarea,
        // which only saves via the explicit Save button (save() above).
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
    // Restoring the word list is itself an edit — same auto-switch
    // rule as unmasking/saving. Persist the mode switch immediately
    // (instant-on-select contract), independent of the word-list
    // content itself, which still needs the explicit Save button.
    if (getStrictness() !== "custom") {
      setStrictness("custom");
      saveTogglesOnly();
    }
    // Always refresh (not just `if (masked)`) — see save()'s comment.
    renderMasked();
    setStatus("Defaults loaded — click Save to keep");
  }

  // ---- Active non-English language pack display (chrome.storage.LOCAL) ----
  //
  // shared/wordlist.js's PMWordlist.setLanguage() (called by the audio
  // pipeline's Whisper-based language detection, when pm_multilingual is
  // on) runs in the YouTube TAB's isolated-world content-script realm —
  // a completely separate JS context from this popup page, so this
  // popup can't just read PMWordlist.activeLanguage directly. Instead,
  // setLanguage() persists {lang, quality, available} to
  // chrome.storage.LOCAL (pm_activeLanguage) as a display-only
  // convenience; this section reads it the same way the STATS section
  // reads pm_stats (own onChanged listener filtered to areaName ===
  // "local", zeros/absent-safe). Only shown when a non-English pack is
  // actually active (English is the assumed baseline, not called out).
  var LANGUAGE_NAMES = {
    ar: "Arabic", cs: "Czech", da: "Danish", de: "German", eo: "Esperanto",
    es: "Spanish", fa: "Persian", fi: "Finnish", fil: "Filipino",
    fr: "French", "fr-CA-u-sd-caqc": "Québec French", hi: "Hindi",
    hu: "Hungarian", it: "Italian", ja: "Japanese", kab: "Kabyle",
    ko: "Korean", nl: "Dutch", no: "Norwegian", pl: "Polish",
    pt: "Portuguese", ru: "Russian", sv: "Swedish", th: "Thai",
    tlh: "Klingon", tr: "Turkish", zh: "Chinese"
  };

  function renderActiveLanguage(info) {
    if (!info || !info.lang || info.lang === "en") {
      activeLanguageNoteEl.textContent = "";
      activeLanguageNoteEl.classList.add("pm-hidden");
      activeLanguageNoteEl.setAttribute("aria-hidden", "true");
      return;
    }
    var name = LANGUAGE_NAMES[info.lang] || info.lang;
    var qualityLabel = info.quality === "community" ? "community-sourced" : "curated";
    var text = info.available === false
      ? "Detected language not supported yet (" + name + ") — using your English list only"
      : "Also filtering: " + name + " (" + qualityLabel + " word list)";
    activeLanguageNoteEl.textContent = text;
    activeLanguageNoteEl.classList.remove("pm-hidden");
    activeLanguageNoteEl.setAttribute("aria-hidden", "false");
  }

  function loadActiveLanguage() {
    if (!hasLocalStorage) return;
    chrome.storage.local.get(["pm_activeLanguage"], function (items) {
      if (chrome.runtime && chrome.runtime.lastError) return;
      renderActiveLanguage(items && items.pm_activeLanguage);
    });
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

  // ---- Copy debug log ---------------------------------------------------
  // Hands over the whole `pm_devlog` ring (last 10 videos: analyzed
  // windows, matched words, mute intervals, unanalyzed-playback gaps,
  // caption censor events, errors) as JSON, so "why did word X get
  // through on video Y" can be answered from evidence after the fact
  // instead of from memory. Written by the content scripts via
  // shared/devlog.js — see that file's header for the schema. Read-only
  // here; the popup never edits or clears it.
  function copyDevlog() {
    if (!hasLocalStorage) {
      setStatus("Storage unavailable");
      return;
    }
    chrome.storage.local.get(["pm_devlog"], function (items) {
      if (chrome.runtime && chrome.runtime.lastError) {
        setStatus("Copy failed");
        return;
      }
      var log = items && items.pm_devlog;
      // An absent key is the ordinary "nothing watched yet" case, not a
      // failure — say so plainly rather than copying "undefined" to the
      // clipboard and letting it look like the log is broken.
      if (!log || !log.videos || !log.videos.length) {
        setStatus("No debug log yet");
        return;
      }
      var text;
      try {
        text = JSON.stringify(log);
      } catch (e) {
        setStatus("Copy failed");
        return;
      }
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        setStatus("Clipboard unavailable");
        return;
      }
      navigator.clipboard.writeText(text).then(
        function () {
          setStatus("Debug log copied (" + log.videos.length + " videos)");
        },
        function () {
          setStatus("Copy failed");
        }
      );
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
        if (changes.pm_activeLanguage) {
          renderActiveLanguage(changes.pm_activeLanguage.newValue);
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
  multilingualEl.addEventListener("change", saveTogglesOnly);
  for (var ci = 0; ci < catchupModeEls.length; ci++) {
    catchupModeEls[ci].addEventListener("change", saveTogglesOnly);
  }
  for (var pi = 0; pi < paddingEls.length; pi++) {
    paddingEls[pi].addEventListener("change", saveTogglesOnly);
  }
  // Strictness radios get their OWN handler, not the generic
  // saveTogglesOnly — changing strictness changes which word list is
  // ACTIVE, so (unlike every other toggle/radio) it must also
  // re-render the masked word-list view. This is a deliberate,
  // narrowly-scoped exception to the "toggle/radio saves never touch
  // the masked list" rule from the earlier lag audit: it's the word
  // list itself changing, not an unrelated setting.
  for (var si = 0; si < strictnessEls.length; si++) {
    strictnessEls[si].addEventListener("change", onStrictnessChange);
  }
  toggleMaskEl.addEventListener("click", toggleMask);
  restoreEl.addEventListener("click", restoreDefaults);
  saveEl.addEventListener("click", save);
  resetStatsEl.addEventListener("click", resetStats);
  copyDevlogEl.addEventListener("click", copyDevlog);

  load();
  renderStats(null); // synchronous zeros first, same correct-by-default pattern as settings
  loadStats();
  renderActiveLanguage(null); // hidden by default until/unless a non-English pack is confirmed active
  loadActiveLanguage();
})();
