// popup/popup.js
// Popup UI logic. Reads/writes chrome.storage.sync directly (pm_enabled,
// pm_muteAudio, pm_censorCaptions, pm_catchupMode, pm_debugOverlay,
// pm_showStatus, pm_strictness, pm_additionalWords, pm_padding,
// pm_multilingual) plus the optional parental lock (pm_lock), per the
// shared schema used by shared/wordlist.js and captions.js. pm_wordlist
// is DEPRECATED as of 0.1.29: read for migration, never written.
//
// pm_multilingual (boolean, default true) - "Filter other languages"
// toggle. This popup only stores the setting; the audio pipeline's
// Whisper-based language detection reads it (via
// PMWordlist.settings.multilingual) to decide whether to call
// PMWordlist.setLanguage(lang) when it detects non-English speech.
// pm_strictness/pm_additionalWords (the whole Built-in list + My
// additional words area below) is an ENGLISH-ONLY concept - it has no
// effect on which words are filtered for any other language a pack was
// loaded for; every non-English pack always uses its own full (core +
// extended) word list. The word list section below shows which non-English pack, if any, is currently
// active (via chrome.storage.LOCAL's pm_activeLanguage, written by
// shared/wordlist.js's setLanguage() - see "Active non-English language
// pack display" further down).
//
// WORD LIST MODEL (0.1.29 redesign)
// ---------------------------------
// pm_strictness is now a LEVEL - "none" | "standard" | "strict", default
// "strict" - selecting how much of the BUILT-IN list is switched on, and
// the user's own words are a separate, ADDITIVE list in
// pm_additionalWords. The effective list is always tier + additions; see
// shared/wordlist.js's resolveSettingsFromStorage for the resolution and
// the full migration table off the old schema.
//
// The single hard rule this popup enforces: **the built-in lists'
// CONTENTS are never displayed here.** Not in the textarea, not in the
// masked view, not in a count breakdown. The textarea holds the user's
// additional words and nothing else, at all times.
//
// That is why the old "Custom" mode is gone. It meant "use my list
// INSTEAD of the built-ins", so the only way to add a single word was to
// switch to Custom - which seeded the textarea with the entire built-in
// list to edit down, i.e. adding "poop" to the filter required showing a
// child's parent a screenful of slurs first. It also silently froze the
// user's copy of the built-ins at whatever shipped that day. Additive
// words fix both.
//
// Consequences for the code below, all of which USED to exist and are
// deliberately gone: no seeding the textarea from DEFAULT_WORDLIST, no
// "switch to custom for editing" auto-mode-change on unmask/save, no
// hasSavedCustomWordlist bookkeeping, and no reading of pm_wordlist for
// display. This popup never writes pm_wordlist again either - the
// deprecated key is left exactly as it was found, for rollback.
//
// PARENTAL LOCK (0.1.29)
// ----------------------
// When chrome.storage.sync's pm_lock is set, the popup opens LOCKED:
// every settings control is `disabled` and a password field is shown.
// Unlocking applies to this popup session only (no persisted unlocked
// flag - closing the popup re-locks). Enforcement is one rule in one
// place: persistSettings() is the ONLY function in this file that writes
// to storage, and it asks PMLock.mayWriteSettings() before doing so, so
// there are no per-handler checks to keep in sync and a future options
// surface inherits the rule by using the same funnel. The disabled
// controls are the visible half of this; persistSettings is the half
// that actually matters.
//
// "Copy debug log" is deliberately EXEMPT from the lock (and from the
// debug-overlay toggle): a kid who hits a problem must still be able to
// export a log and send it to whoever can read it. It only reads
// storage, and it exposes nothing a settings change could.
//
// The lock is a deterrent, not security - see shared/lock.js's header,
// and the caption shown under the control says so to the user in as many
// words.
//
// Separately, the STATS section reads/writes chrome.storage.LOCAL (not
// sync) key pm_stats ({totalMuted, videosProtected}), written by the
// audio pipeline. This is a different storage AREA on purpose - stats
// are per-install telemetry, not something that should sync across a
// user's devices - so it's handled independently of the settings
// load()/save() flow above, with its own chrome.storage.onChanged
// listener filtered to areaName === "local".
//
// pm_safeMode has been merged into pm_catchupMode ("mute" | "pause" |
// "play") and is NEVER written by this popup anymore - there is no
// separate Safe mode toggle. It is still read once, by
// shared/wordlist.js's resolveSettingsFromStorage, purely to migrate a
// legacy `pm_safeMode === false` (old "safe mode off") forward into
// `pm_catchupMode: "play"` the first time settings are resolved after
// an update, if the user never explicitly picks a catch-up mode.
//
// Word list handling:
//   - The textarea is always the source of truth for the user's
//     ADDITIONAL words - it holds them whether or not it's visible.
//   - A masked, read-only view is shown by default (each entry
//     rendered as asterisks matching its shape) so opening the popup
//     never flashes explicit text. "Show words to edit" swaps to the
//     real textarea. Masking still applies even though these are the
//     user's own words: the popup may well be opened in front of the
//     child the filter is for.
//   - Save writes exactly what's in the textarea to pm_additionalWords,
//     including an intentionally-emptied list.
//
// BUG FIX (2026-08-30) - "clicking the icon doesn't load the settings
// UI properly": chrome.storage.sync.get() is a real async round trip,
// not an instant local read (it can hit sync's own rate limits/quota
// errors, or just take a moment) - but every control's HTML started in
// its "off"/empty state, only becoming correct once that callback
// resolved. Two consequences: (1) on ANY storage error
// (chrome.runtime.lastError - quota exceeded, sync disabled, a
// transient failure), load()'s callback bailed out immediately,
// permanently leaving every toggle looking off and the word list
// area completely empty, with only a small, easy-to-miss "Failed to
// load settings" status line - this reproduced 100% with a simulated
// storage error and looked exactly like "the settings UI doesn't load
// very well". (2) Even without an error, there was a real window
// (however brief) after the popup opens but before storage.get()
// resolves where the same broken-looking all-off/empty state was
// visible, and popups are dismissed on blur - a user who clicks away
// during that window never sees it "load" at all. Fix: the HTML now
// ships with its real defaults already `checked`, and popup.js
// synchronously pre-renders the default word list and default
// catch-up mode BEFORE ever calling chrome.storage.sync.get() - so the
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
  var lockSetupEl = document.getElementById("pm-lock-setup");
  var lockLockedEl = document.getElementById("pm-lock-locked");
  var lockUnlockedEl = document.getElementById("pm-lock-unlocked");
  var lockNewEl = document.getElementById("pm-lock-new");
  var lockConfirmEl = document.getElementById("pm-lock-confirm");
  var lockPasswordEl = document.getElementById("pm-lock-password");
  var lockSetEl = document.getElementById("pm-lock-set");
  var lockUnlockEl = document.getElementById("pm-lock-unlock");
  var lockRemoveEl = document.getElementById("pm-lock-remove");
  var lockStatusEl = document.getElementById("pm-lock-status");
  var openOnboardingEl = document.getElementById("pm-open-onboarding");
  var finishSetupEl = document.getElementById("pm-finish-setup");
  var reviewCardEl = document.getElementById("pm-review-card");
  var reviewYesEl = document.getElementById("pm-review-yes");
  var reviewNoEl = document.getElementById("pm-review-no");
  var shareRowEl = document.getElementById("pm-share-row");
  var shareEl = document.getElementById("pm-share");
  var reportProblemEl = document.getElementById("pm-report-problem");

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

  // NOTE (0.1.29): the defaultWordlist() and coreWordlist() accessors
  // that used to live here are deleted, not merely unused. They existed
  // solely to put the built-in lists' CONTENTS on screen, which is the
  // one thing this popup must never do - leaving them around as
  // convenient helpers is how that comes back.

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
    return ["none", "standard", "strict"];
  }

  // The shared resolver (shared/wordlist.js). Using it here rather than
  // re-deriving the level/additional-words migration is deliberate: the
  // popup used to carry its own duplicate copy of the strictness
  // migration rules, and the 0.1.29 migration table is far too
  // consequential to have two implementations that can drift. Falls back
  // to null when wordlist.js somehow isn't loaded, in which case load()
  // simply leaves the already-correct default render alone.
  function resolveFromStorage(items) {
    if (
      typeof window !== "undefined" &&
      window.PMWordlist &&
      window.PMWordlist._core &&
      typeof window.PMWordlist._core.resolveSettingsFromStorage === "function"
    ) {
      return window.PMWordlist._core.resolveSettingsFromStorage(items);
    }
    return null;
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

  // The user's OWN additional words, as currently held in the textarea.
  // This is the only list this popup ever renders. There is deliberately
  // no function here that returns the built-in tier's contents for
  // display - see the header.
  function additionalWordsForDisplay() {
    return parseWordlist(wordlistEl.value);
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
  // an asterisk - no letters, shape only.
  function maskEntry(entry) {
    return entry.replace(/\S/g, "*");
  }

  // The summary line above the list. States the LEVEL and how many words
  // the user has added - never a built-in count, and never built-in
  // contents. "Strict list, plus 3 of your own" tells a parent everything
  // they need without putting the built-ins on screen; a built-in count
  // would only invite "which 123 words?".
  var LEVEL_PHRASES = {
    none: "No built-in list",
    standard: "Standard list",
    strict: "Strict list"
  };

  function updateWordlistModeNote(words) {
    var phrase = LEVEL_PHRASES[getStrictness()] || LEVEL_PHRASES.strict;
    var n = words.length;
    var own = n === 1 ? "1 of your own" : n + " of your own";
    wordlistModeNoteEl.textContent = phrase + ", plus " + own;
  }

  function updateWordlistHint() {
    if (getStrictness() === "none") {
      wordlistHintEl.textContent =
        'No built-in list is on - only the words below are filtered. One word or phrase per line; click "Show words to edit" to change them.';
    } else {
      wordlistHintEl.textContent =
        'Words you add here are filtered on top of the built-in list, one word or phrase per line. They\'re masked until you click "Show words to edit".';
    }
  }

  function renderMasked() {
    var words = additionalWordsForDisplay();
    updateWordlistModeNote(words);
    updateWordlistHint();
    maskedListEl.innerHTML = "";
    if (!words.length) {
      var empty = document.createElement("div");
      empty.className = "pm-masked-empty";
      empty.textContent =
        getStrictness() === "none"
          ? "(nothing to filter - no built-in list and no words of your own)"
          : "(no words of your own yet - the built-in list is still on)";
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

  // The textarea is now ALWAYS the user's own editable list, in every
  // level - so unmasking is just unmasking. The old
  // switchToCustomForEditing() path (which flipped strictness to
  // "custom" and seeded the textarea with the built-ins before revealing
  // it) is gone with the mode it served.
  function toggleMask() {
    if (masked) showUnmasked();
    else showMasked();
  }

  // Fires on every Built-in list radio click. The level no longer has any
  // effect on what the textarea holds - only on the summary line and the
  // hint - so this just re-renders and saves.
  function onStrictnessChange() {
    renderMasked();
    saveTogglesOnly();
  }

  // Synchronous, correct-by-default render - runs immediately, before
  // any chrome.storage.sync call, so the popup is fully usable and
  // visually correct (real default word list shown, defaults selected)
  // the instant it paints, independent of storage latency or errors.
  // The static HTML already ships `checked` on the default-true
  // toggles and the default "mute"/"normal"/"strict" radios, so this
  // only needs to handle what plain HTML can't: populating the word
  // list textarea and rendering the masked view.
  function renderDefaultsSynchronously() {
    // Empty, not seeded: a fresh install has no additional words, and the
    // built-ins must never appear here. (This line used to be
    // `defaultWordlist().join("\n")` - the single biggest source of
    // built-in contents leaking onto the screen, since it ran on EVERY
    // popup open before storage had even been read.)
    wordlistEl.value = "";
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
    // Array form, NOT the "defaults object" form - a defaults object
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
        "pm_additionalWords",
        "pm_padding",
        "pm_multilingual",
        "pm_safeMode", // read-only, for the legacy-migration display below
        "pm_wordlist" // read-only, for the 0.1.29 migration (never written)
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
        // add the status message - never blank a working UI.
        if (chrome.runtime && chrome.runtime.lastError) {
          setStatus("Couldn't load saved settings - showing defaults");
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
        // migrated "play" choice - same rule as
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

        // Level + additional words come straight from the shared
        // resolver, so the 0.1.29 migration table has exactly ONE
        // implementation (see resolveFromStorage's comment). A user
        // upgrading from the old "custom" schema therefore sees their
        // existing list appear in "My additional words" with the
        // built-in level set to None - the same effective filtering they
        // had before, now expressed in the new model.
        var resolved = resolveFromStorage(items);
        if (resolved) {
          setStrictness(resolved.strictness);
          wordlistEl.value = resolved.additionalWords.join("\n");
        }
        // Always refresh (not just `if (masked)`) - the mode note/hint
        // are visible regardless of masked/unmasked state.
        renderMasked();
      }
    );
  }

  // ---- the single storage-write funnel (and the lock's enforcement point) ----
  //
  // EVERY write this popup makes goes through here - settings, the word
  // list, and the stats reset (which targets the `local` area instead;
  // hence the `area` argument). That is the whole point: the parental
  // lock is checked in exactly one place, so it cannot be forgotten on a
  // new handler, and a future options page inherits it by calling this.
  // The disabled controls are the visible half of the lock; this is the
  // half that actually enforces it.
  //
  // Returns false (and leaves storage untouched) when the write was
  // refused, so callers can skip their optimistic UI updates.
  function persistSettings(values, cb, area) {
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
    var target =
      area === "local" ? chrome.storage.local : chrome.storage.sync;
    if (!target) {
      setStatus("Storage unavailable");
      return false;
    }
    target.set(values, function () {
      var failed = !!(chrome.runtime && chrome.runtime.lastError);
      if (cb) cb(failed);
    });
    return true;
  }

  // The settings every save path writes. Collected in one place so save()
  // and saveTogglesOnly() cannot drift apart in which keys they cover.
  //
  // pm_safeMode is intentionally NOT written - it's been merged into
  // pm_catchupMode; once pm_catchupMode is explicitly saved,
  // resolveSettingsFromStorage always prefers it and never looks at
  // pm_safeMode again. pm_wordlist is intentionally NOT written either
  // (0.1.29): it is deprecated and read-only, left exactly as found so a
  // rollback finds the user's old list intact.
  function currentSettingsValues() {
    return {
      pm_enabled: !!enabledEl.checked,
      pm_muteAudio: !!muteAudioEl.checked,
      pm_censorCaptions: !!censorCaptionsEl.checked,
      pm_catchupMode: getCatchupMode(),
      pm_debugOverlay: !!debugOverlayEl.checked,
      pm_showStatus: !!showStatusEl.checked,
      pm_strictness: getStrictness(),
      pm_padding: getPadding(),
      pm_multilingual: !!multilingualEl.checked
    };
  }

  function save() {
    var values = currentSettingsValues();
    // Written exactly as typed, including an intentionally emptied list.
    // Saving no longer changes the level in any way - adding words is
    // orthogonal to which built-in tier is on.
    values.pm_additionalWords = parseWordlist(wordlistEl.value);
    persistSettings(values, function (failed) {
      if (failed) {
        setStatus("Save failed");
        return;
      }
      // Always refresh (not just `if (masked)`) - the summary line's
      // "plus N of your own" count is visible regardless of masked or
      // unmasked state.
      renderMasked();
      setStatus("Saved");
    });
  }

  // Toggles save immediately for snappy feel; the word list needs the
  // explicit Save button since it's free-form text.
  //
  // IMPORTANT for perceived responsiveness: the checkbox/radio's own
  // visual flip is pure CSS driven off `:checked` (see popup.css) and
  // already happened, natively, before this "change" handler even
  // runs - this function must stay fire-and-forget. Never make the
  // toggle's visual state (or re-check/re-render any input here) wait
  // on the chrome.storage.sync.set() callback; the callback below is
  // ONLY allowed to touch the status text, never re-read storage or
  // re-set .checked on any control (that would double-flip / lag the
  // toggle behind a round trip that doesn't need to block anything).
  // The fire-and-forget settings-only path shared by every toggle and
  // radio EXCEPT the free-form additional-words textarea, which only
  // saves via the explicit Save button (save() above), since it needs
  // an explicit "I'm done typing" signal.
  function saveTogglesOnly() {
    persistSettings(currentSettingsValues(), function (failed) {
      setStatus(failed ? "Save failed" : "Saved");
    });
  }

  // "Restore defaults" (0.1.29 semantics): back to the shipped starting
  // point - the Strict built-in level, and none of your own words. It no
  // longer loads the built-in list into the textarea, because the
  // built-in list is not the user's list any more and its contents are
  // never shown. Unlike the old version this writes immediately rather
  // than staging an edit for Save: there is nothing left to review, and
  // "click Save to keep" on an already-cleared textarea read as though
  // the clear hadn't happened yet.
  function restoreDefaults() {
    setStrictness(defaultStrictness());
    wordlistEl.value = "";
    var values = currentSettingsValues();
    values.pm_additionalWords = [];
    var attempted = persistSettings(values, function (failed) {
      if (failed) {
        setStatus("Save failed");
        return;
      }
      renderMasked();
      setStatus("Defaults restored");
    });
    // Refused (locked / no storage): re-render from what is actually
    // stored rather than leaving the optimistic cleared view on screen.
    if (!attempted) load();
  }

  // ---- Active non-English language pack display (chrome.storage.LOCAL) ----
  //
  // shared/wordlist.js's PMWordlist.setLanguage() (called by the audio
  // pipeline's Whisper-based language detection, when pm_multilingual is
  // on) runs in the YouTube TAB's isolated-world content-script realm -
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
      ? "Detected language not supported yet (" + name + ") - using your English list only"
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
  // pipeline hasn't muted anything yet) - render zeros in that case
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
    // Routed through the same funnel as every other write (with
    // area: "local", since stats are per-install and not synced) so the
    // parental lock covers it too - wiping the "words muted all-time"
    // counter is exactly the kind of evidence-destroying change the lock
    // exists to prevent.
    var attempted = persistSettings(
      { pm_stats: zeroed },
      function (failed) {
        setStatus(failed ? "Reset failed" : "Stats reset");
        if (failed) loadStats();
      },
      "local"
    );
    // Render zeros immediately (fire-and-forget, same rule as the
    // toggles) - but only once the write was actually accepted.
    if (attempted) renderStats(zeroed);
  }

  // ---- Parental lock ------------------------------------------------------
  //
  // State lives in exactly two variables: `lockRecord` (the stored
  // {salt, hash}, or null) and `unlockedThisSession`. The decision that
  // depends on them is not made here - it is PMLock.mayWriteSettings(),
  // called from persistSettings(), so there is one rule in one place.
  // Everything in this section is UI around that one rule.
  //
  // There is deliberately no persisted "unlocked" flag: unlocking lasts
  // as long as the popup is open and not one moment longer. A parent who
  // unlocks, changes a setting and walks away has re-locked by the time
  // the popup loses focus, which is the behaviour they would assume.
  var lockRecord = null;
  var unlockedThisSession = false;
  // Whether pm_lock has actually been read yet. Until it has, we do NOT
  // know there is no lock - `lockRecord === null` at that point means
  // "unknown", not "unlocked". Without this, the milliseconds between
  // the popup painting and loadLock()'s callback are a real bypass: a
  // fast click on a toggle would sail through maySaveSettings() and
  // write. The controls stay live and correct-looking during that window
  // (the popup's standing rule), but a write inside it is deferred to
  // the honest answer rather than assumed.
  var lockStateLoaded = false;

  function lockApi() {
    return (typeof window !== "undefined" && window.PMLock) || null;
  }

  // null when a write may proceed; otherwise the reason it may not.
  // This is the ONLY place the popup decides whether a settings change is
  // allowed, and the decision itself lives in PMLock.mayWriteSettings.
  function settingsWriteBlockedReason() {
    var api = lockApi();
    // No lock module loaded at all -> nothing can be locked, so allow.
    // (Same posture as everywhere else here: a missing optional module
    // degrades the feature, it does not brick the popup.)
    if (!api || typeof api.mayWriteSettings !== "function") return null;
    if (!lockStateLoaded) return "loading";
    return api.mayWriteSettings(lockRecord, unlockedThisSession) ? null : "locked";
  }

  function maySaveSettings() {
    return settingsWriteBlockedReason() === null;
  }

  function setLockStatus(text) {
    lockStatusEl.textContent = text || "";
  }

  // Every control that changes a setting. Deliberately EXCLUDES
  // copyDevlogEl (see the header: a kid must still be able to export a
  // log while locked) and every control inside the lock row itself
  // (which is how you get unlocked in the first place).
  function lockableControls() {
    var list = [
      enabledEl, muteAudioEl, censorCaptionsEl, multilingualEl,
      showStatusEl, debugOverlayEl, wordlistEl, toggleMaskEl,
      restoreEl, saveEl, resetStatsEl
    ];
    var i;
    for (i = 0; i < catchupModeEls.length; i++) list.push(catchupModeEls[i]);
    for (i = 0; i < paddingEls.length; i++) list.push(paddingEls[i]);
    for (i = 0; i < strictnessEls.length; i++) list.push(strictnessEls[i]);
    return list;
  }

  function setControlsLocked(locked) {
    var controls = lockableControls();
    for (var i = 0; i < controls.length; i++) {
      if (controls[i]) controls[i].disabled = locked;
    }
    // Rows carry the class purely for the greyed-out look; `disabled`
    // above is what actually prevents interaction, and persistSettings
    // is what prevents the write regardless of either.
    var rows = document.querySelectorAll(".pm-row");
    for (var r = 0; r < rows.length; r++) {
      if (rows[r].classList.contains("pm-row--lock")) continue;
      rows[r].classList.toggle("pm-row--locked", locked);
    }
    // The masked list must stay masked while locked - revealing the
    // user's own word list is itself something the lock should cover.
    if (locked && !masked) showMasked();
  }

  function renderLockUI() {
    var api = lockApi();
    var hasLock = !!(api && api.isLockRecord && api.isLockRecord(lockRecord));
    var locked = hasLock && !unlockedThisSession;

    function show(el, visible) {
      el.classList.toggle("pm-hidden", !visible);
      el.setAttribute("aria-hidden", visible ? "false" : "true");
    }

    // WebCrypto missing (shouldn't happen on an extension page, which is
    // a secure context - guarded anyway): offer nothing rather than a
    // button that can't work, and say why.
    if (api && typeof api.available === "function" && !api.available() && !hasLock) {
      show(lockSetupEl, false);
      show(lockLockedEl, false);
      show(lockUnlockedEl, false);
      setLockStatus("Password locking isn't available in this browser.");
      setControlsLocked(false);
      return;
    }

    show(lockSetupEl, !hasLock);
    show(lockLockedEl, locked);
    show(lockUnlockedEl, hasLock && !locked);
    setControlsLocked(locked);
  }

  function loadLock() {
    if (!hasStorage) {
      // No storage at all: nothing can be locked and nothing can be
      // saved either, so this is "known, and there is no lock".
      lockStateLoaded = true;
      renderLockUI();
      return;
    }
    chrome.storage.sync.get(["pm_lock"], function (items) {
      if (chrome.runtime && chrome.runtime.lastError) {
        // Can't tell whether a lock exists. Fail OPEN, not closed: a
        // transient sync error must not leave a parent unable to unlock
        // their own settings, and the lock is a deterrent anyway - the
        // alternative (treat an unreadable record as locked) turns a
        // flaky sync quota into "your settings are bricked".
        lockRecord = null;
        lockStateLoaded = true;
        renderLockUI();
        return;
      }
      lockRecord = (items && items.pm_lock) || null;
      lockStateLoaded = true;
      renderLockUI();
    });
  }

  function setLockPassword() {
    var api = lockApi();
    if (!api || !hasStorage) {
      setLockStatus("Password locking isn't available.");
      return;
    }
    var check = api.validateNewPassword(lockNewEl.value, lockConfirmEl.value);
    if (!check.ok) {
      setLockStatus(check.error);
      return;
    }
    setLockStatus("");
    api.create(lockNewEl.value).then(
      function (record) {
        chrome.storage.sync.set({ pm_lock: record }, function () {
          if (chrome.runtime && chrome.runtime.lastError) {
            setLockStatus("Couldn't save the password");
            return;
          }
          lockRecord = record;
          // Setting a password does NOT immediately lock the parent out
          // of the popup they're standing in front of - they stay
          // unlocked for this session; the next open is locked.
          unlockedThisSession = true;
          lockNewEl.value = "";
          lockConfirmEl.value = "";
          renderLockUI();
          setLockStatus("Password set. Settings lock next time this popup opens.");
        });
      },
      function () {
        setLockStatus("Couldn't set a password on this browser");
      }
    );
  }

  function unlock() {
    var api = lockApi();
    if (!api) return;
    var attempt = lockPasswordEl.value;
    api.verify(lockRecord, attempt).then(function (ok) {
      lockPasswordEl.value = "";
      if (!ok) {
        setLockStatus("Wrong password");
        return;
      }
      unlockedThisSession = true;
      setLockStatus("");
      renderLockUI();
      setStatus("Settings unlocked");
    });
  }

  function removeLockPassword() {
    if (!hasStorage) return;
    // Only reachable while unlocked (the button lives in the unlocked
    // panel), but check the same central rule anyway rather than trusting
    // the DOM state - removing the lock is itself a settings change.
    if (!maySaveSettings()) {
      setLockStatus("Unlock first");
      return;
    }
    chrome.storage.sync.remove("pm_lock", function () {
      if (chrome.runtime && chrome.runtime.lastError) {
        setLockStatus("Couldn't remove the password");
        return;
      }
      lockRecord = null;
      unlockedThisSession = false;
      renderLockUI();
      setLockStatus("Password removed");
    });
  }

  // ---- Onboarding, review prompt, share (0.1.30) --------------------------
  //
  // Three surfaces, one storage read. All three decisions are made by the
  // pure predicates in shared/moments.js - this section only renders what
  // it is told, and every gate lives in one unit-tested place rather than
  // as conditionals grown into the UI.
  function momentsApi() {
    return (typeof window !== "undefined" && window.PMMoments) || null;
  }

  function openExtensionPage(relativePath) {
    var url;
    try {
      url = chrome.runtime.getURL(relativePath);
    } catch (e) {
      return;
    }
    try {
      chrome.tabs.create({ url: url });
      // A popup stays open behind the new tab it just spawned, which reads
      // as nothing having happened. Close it.
      window.close();
    } catch (e) {
      // No chrome.tabs (shouldn't happen in a popup): fall back to a plain
      // navigation rather than silently doing nothing.
      window.open(url, "_blank");
    }
  }

  function openOnboarding() {
    openExtensionPage("onboarding/onboarding.html");
  }

  // Always available, and deliberately not lock-gated - same rule as
  // "Copy debug log", which it sits beside: reporting a problem changes
  // no setting, and a child who hits a problem must still be able to send
  // the details to whoever can act on them.
  function openReportProblem() {
    openExtensionPage("report/report.html");
  }

  // The "Finish setup" banner and the share row are both driven off the
  // acknowledgment record, in opposite directions: the banner shows until
  // it exists, the share row shows only once it does. Nobody should be
  // recommending this extension to a friend before being told its limits.
  function renderAckSurfaces(ackRecord) {
    var m = momentsApi();
    var acknowledged = !!(m && m.isAcknowledged(ackRecord));
    finishSetupEl.classList.toggle("pm-hidden", acknowledged);
    finishSetupEl.setAttribute("aria-hidden", acknowledged ? "true" : "false");
    shareRowEl.classList.toggle("pm-hidden", !acknowledged);
    shareRowEl.setAttribute("aria-hidden", acknowledged ? "false" : "true");
  }

  // CHROME WEB STORE POLICY lives with the predicate, in
  // shared/moments.js - read it there before touching any of this. The
  // short version, restated at the point of use because it constrains
  // this code specifically:
  //   * at most once, ever - showing the card WRITES pm_reviewPrompt, so
  //     it can never be shown again even if the user neither clicks nor
  //     dismisses (closing the popup counts as having been asked);
  //   * dismissal is permanent, and "No thanks" is a real dismissal;
  //   * no incentive is offered, and no rating is solicited first - both
  //     buttons are equally available and nothing is gated on either;
  //   * it is a card inside the popup, never a tab or a notification.
  function renderReviewPrompt(items) {
    var m = momentsApi();
    if (!m) return;
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

    // Record it as shown IMMEDIATELY, not on click. If this waited for a
    // button, a user who simply closed the popup would be asked again on
    // every open - which is exactly the repeated nagging the "at most
    // once" rule exists to prevent. Being asked once and walking away IS
    // an answer.
    markReviewPromptShown(false);
  }

  function markReviewPromptShown(dismissed) {
    var m = momentsApi();
    if (!m || !hasStorage) return;
    try {
      chrome.storage.sync.set({
        pm_reviewPrompt: m.makeReviewPromptRecord(dismissed, Date.now())
      });
    } catch (e) {
      // Non-fatal: the worst case is being asked once more.
    }
  }

  function hideReviewCard() {
    reviewCardEl.classList.add("pm-hidden");
    reviewCardEl.setAttribute("aria-hidden", "true");
  }

  function onReviewYes() {
    var m = momentsApi();
    markReviewPromptShown(true);
    hideReviewCard();
    if (!m) return;
    try {
      chrome.tabs.create({ url: m.REVIEW_URL });
      window.close();
    } catch (e) {
      window.open(m.REVIEW_URL, "_blank");
    }
  }

  function onReviewNo() {
    markReviewPromptShown(true);
    hideReviewCard();
    setStatus("Thanks - we won't ask again");
  }

  function shareWithFriend() {
    var m = momentsApi();
    if (!m) return;
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      setStatus("Clipboard unavailable");
      return;
    }
    navigator.clipboard.writeText(m.SHARE_TEXT).then(
      function () { setStatus("Copied!"); },
      function () { setStatus("Copy failed"); }
    );
  }

  // One read for all three surfaces. pm_stats lives in the LOCAL area (see
  // the Stats section below), so it has to be fetched separately from the
  // sync keys and merged before the eligibility check can run.
  function loadMoments() {
    // No storage, or an unreadable one: show none of the three. We cannot
    // tell whether this user has acknowledged, and a banner shown on a
    // transient sync error to someone who finished months ago is worse
    // than a banner missed once by someone who hasn't.
    if (!hasStorage) return;
    chrome.storage.sync.get(
      ["pm_ackNotPerfect", "pm_installedAt", "pm_reviewPrompt"],
      function (syncItems) {
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
      }
    );
  }

  // ---- Copy debug log ---------------------------------------------------
  // Hands over the whole `pm_devlog` ring (last 10 videos: analyzed
  // windows, matched words, mute intervals, unanalyzed-playback gaps,
  // caption censor events, errors) as JSON, so "why did word X get
  // through on video Y" can be answered from evidence after the fact
  // instead of from memory. Written by the content scripts via
  // shared/devlog.js - see that file's header for the schema. Read-only
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
      // failure - say so plainly rather than copying "undefined" to the
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
      // ignore - non-fatal if listener registration fails
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
  // saveTogglesOnly - changing strictness changes which word list is
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
  lockSetEl.addEventListener("click", setLockPassword);
  lockUnlockEl.addEventListener("click", unlock);
  lockRemoveEl.addEventListener("click", removeLockPassword);
  // Enter submits the field it's typed in - a password field that
  // ignores Enter feels broken.
  openOnboardingEl.addEventListener("click", openOnboarding);
  finishSetupEl.addEventListener("click", openOnboarding);
  reviewYesEl.addEventListener("click", onReviewYes);
  reviewNoEl.addEventListener("click", onReviewNo);
  shareEl.addEventListener("click", shareWithFriend);
  reportProblemEl.addEventListener("click", openReportProblem);
  lockPasswordEl.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") unlock();
  });
  lockConfirmEl.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") setLockPassword();
  });

  load();
  renderStats(null); // synchronous zeros first, same correct-by-default pattern as settings
  loadStats();
  renderActiveLanguage(null); // hidden by default until/unless a non-English pack is confirmed active
  loadActiveLanguage();
  // Render the lock UI synchronously first (setup panel showing) for the
  // same correct-by-default reason as everything else here, then
  // reconcile once storage answers. A write attempted inside that window
  // is deferred, not allowed - see lockStateLoaded.
  renderLockUI();
  loadLock();
  // Note the deliberate absence of a synchronous pre-render here, unlike
  // every other section in this file. All three of these surfaces start
  // hidden in the HTML and are only ever revealed by a real storage read.
  // The popup's usual "render correct defaults immediately" rule would
  // mean flashing "Finish setup" at someone who finished setup weeks ago,
  // on every single open - and the honest default for "have you
  // acknowledged?" is "we don't know yet", which shows nothing.
  loadMoments();
})();
