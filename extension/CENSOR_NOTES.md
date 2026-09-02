# Censor module notes (wordlist / captions / popup)

Scope owned by this agent: `shared/wordlist.js`, `captions.js`, `popup/`
(`popup.html`, `popup.js`, `popup.css`), plus (new, 2026-08-30)
`shared/packs/` (language pack data files) and `tools/`
(`import-ldnoobw.mjs`, the LDNOOBW pack importer). No `manifest.json`,
`capture.js`, `content.js`, `background.js`, `offscreen*`/`dist/*`, or
`verify/` files were created or touched - those belong to the
audio-pipeline agent working in the same directory. (Confirmed against
the manifest they wrote: it loads `shared/wordlist.js`, `content.js`,
`captions.js` as one `document_start` content-script group, `capture.js`
separately in the page's MAIN world, and `popup/popup.html` as the
toolbar popup - all consistent with the paths this agent owns.) **One
exception requiring the audio-pipeline agent's action**: the new
`shared/packs/*.json` lazy-loading needs a `web_accessible_resources`
entry in `manifest.json` - see "ACTION NEEDED" under "FEATURE: language
pack architecture" below; this agent did not edit `manifest.json`
itself, per scope.

## CRITICAL BUG FIX (2026-08-30): storage.get() defaults-object trap

The audio-pipeline agent's live verification caught a severe bug in
`shared/wordlist.js`'s `refresh()`: it called

```js
chrome.storage.sync.get(
  { pm_enabled: true, pm_wordlist: undefined, pm_safeMode: true },
  callback
);
```

An `undefined`-valued key in the "defaults object" form drops out of
the request entirely, so `items.pm_wordlist` came back `undefined` on
**every single call**, even when a real custom word list had been
saved. Live evidence: `chrome.storage.sync.get(null)` returned the
actually-saved `["college", "connected", "dots"]`, but
`PMWordlist._state.wordlist` stayed `DEFAULT_WORDLIST` regardless - a
saved custom word list silently had zero effect on matching.

The exact same pattern existed in `popup/popup.js`'s `load()`, which
would have meant the popup always displayed (and, on Save, would have
silently overwritten) a real saved custom list with the built-in
defaults.

**Fix, in both files:** call `chrome.storage.sync.get()` with the
**array form** (a plain list of key names -
`PMWordlistCore.STORAGE_KEYS` in `wordlist.js`; the equivalent literal
array in `popup.js`), and apply defaulting ourselves, in code, on the
raw result. In `wordlist.js` this defaulting logic is now a pure,
exported, unit-tested function: `resolveSettingsFromStorage(items)` -
`items.pm_wordlist === undefined` (key truly never saved) falls back to
`DEFAULT_WORDLIST`; a saved empty array (`[]`) is honored as "no words"
and is NOT defaulted back. `captions.js` was audited too - it only uses
`chrome.storage.onChanged`, never `.get()`, so it was never exposed to
this bug. `popup.js`'s two `.set()` calls were also audited and don't
write any `undefined` values, so they're unaffected.

Also while fixing this: `PMWordlist.settings` was previously just an
alias for the internal `state` object, which also carries `wordlist`
(array), `stemSet` (a `Set`), `phrases` (array), and `phraseIndex` (a
`Map`) - extra shape the pipeline doesn't want and which wouldn't
serialize sensibly (`JSON.stringify` on a `Set`/`Map` produces `{}`).
`PMWordlist.settings` is now a dedicated object containing **exactly**
`{enabled, muteAudio, censorCaptions, safeMode}`, the same object
reference mutated in place on every `refresh()`/`onChanged` - confirmed
via `Object.keys(PMWordlist.settings).sort()` in the new integration
test (see "Test results" below).

Regression coverage added: 7 new pure-function tests for
`resolveSettingsFromStorage` (empty storage, `undefined` input, the
exact reported bug scenario with a real saved list, a saved empty list,
explicit `false` booleans, corrupted non-array `pm_wordlist`), plus a
new **integration test** (`wordlist_integration_test.js`) that stubs
`chrome.storage.sync` - its fake `get()` *throws* if ever called with
anything other than the array form, so this exact bug class can't
silently regress - and drives `PMWordlist.refresh()` end-to-end,
reproducing the pipeline agent's live scenario
(`["college", "connected", "dots"]`) against the real `refresh()` code
path, not just the extracted pure function.

## BUG FIX (2026-08-30): "clicking the icon doesn't load the settings UI properly"

### Diagnosis

Confirmed `popup.html` DOES include `shared/wordlist.js` via a script
tag before `popup.js` (`window.PMWordlist` was present and correct in
every repro run - that specific suspect was ruled out), and 10
consecutive real-extension popup opens (Playwright, `chromium.launchPersistentContext`
with `--load-extension` pointed at this actual unpacked extension
directory, then navigating a fresh page to
`chrome-extension://<id>/popup/popup.html` 10 times - the accepted
stand-in for the real action popup, since Playwright cannot click
actual browser-chrome toolbar icons) all produced a perfectly correct,
error-free popup. So the bug is NOT a crash-on-load or a missing
global.

The real root cause: **`chrome.storage.sync.get()` is a genuine async
round trip** (it can hit sync's own rate limits, quota errors, or just
take a moment - unlike a synchronous local read), but every control in
`popup.html` started in its default HTML state (`checked` was never
set, so every toggle rendered OFF) and the word list area
(`#pm-masked-list`) started completely empty - both only became correct
once `load()`'s storage callback resolved. This has two consequences,
confirmed by direct reproduction:

1. **A storage error left the UI permanently broken.** Simulating a
   realistic `chrome.runtime.lastError` (e.g. a `QUOTA_BYTES_PER_ITEM`
   error) showed `load()`'s callback doing `return` immediately,
   leaving every toggle OFF and the word list area with 0 children
   forever, with only a tiny, easy-to-miss "Failed to load settings"
   status line - see `popup-storage-error-BEFORE-FIX.png` (session
   scratchpad). This is a completely convincing match for "doesn't load
   the settings UI very well."
2. **Even without an error, there was a real window** - however brief -
   between the popup painting and `chrome.storage.sync.get()` resolving
   where the same broken-looking all-off/empty state was visible. Since
   action popups are destroyed on blur/dismissal, a user who clicks
   away (or the popup loses focus) during that window never sees it
   "load" correctly at all - which reads exactly like intermittent
   flakiness ("often doesn't load... properly").

### Fix

1. `popup.html` now ships with its real defaults already `checked` in
   the static markup - `#pm-enabled`, `#pm-mute-audio`,
   `#pm-censor-captions`, and the `"mute"` catch-up radio - so the very
   first paint, with zero JavaScript having run yet, already looks
   correct for the common case (a fresh/default-config user).
2. `popup.js` now has `renderDefaultsSynchronously()`, called at the
   very top of `load()`, BEFORE `chrome.storage.sync.get()` is ever
   invoked: it synchronously populates the word-list textarea with
   `DEFAULT_WORDLIST` and renders the masked view. This eliminates the
   "empty word list" flash entirely - the popup is fully correct and
   interactive the instant it paints, independent of storage latency.
3. The storage callback's error path no longer bails into a blank UI -
   it leaves the already-correct (default) UI exactly as it is and only
   adds a status message ("Couldn't load saved settings - showing
   defaults"). A storage error now degrades to "you're seeing defaults,
   here's a heads-up" instead of "the popup is broken."
4. The success path was changed from "always call `showMasked()`" to
   "only re-render the masked view if still masked" (`if (masked)
   renderMasked()`), so it can't clobber a user who - in the rare case
   they unmasked and started editing during that brief window before
   storage resolved - would otherwise have their in-progress edit view
   forced back to masked.

### Verification

- Reproduced the broken state directly: simulated `chrome.runtime.lastError`
  BEFORE the fix -> `enabledChecked: false`, `maskedListChildCount: 0`,
  status "Failed to load settings" (screenshot:
  `popup-storage-error-BEFORE-FIX.png`).
- Same simulated error AFTER the fix -> checked **immediately, before
  the storage callback even resolves**: `enabledChecked: true`,
  `maskedListChildCount: 114`, `catchupChecked: "mute"`; after the
  (still-erroring) callback resolves: unchanged plus the new status
  text (screenshot: `popup-storage-error-AFTER-FIX.png`).
- A slow-but-successful storage response (900ms simulated latency, with
  a real saved custom list/toggle state) showed correct instant
  defaults on paint, then a clean reconcile to the actual saved values
  once the response arrived (`muteAudio: false`, `catchupMode:
  "pause"`, `debugOverlay: true`, 2-word custom list) - no flash of
  broken state, no double-render artifacts.
- **10 consecutive real-extension popup opens**, both before and after
  the fix, via Playwright loading the actual unpacked extension
  (`popup_repro.js`, session scratchpad): 0/10 broken before AND after
  (the plain fresh-storage case was never broken - the bug only shows
  under storage latency/errors, which this direct-navigation repro
  doesn't naturally hit, hence needing the explicit error-injection
  test above to actually exercise the failure path) - included to
  confirm the fix introduces no regressions across repeated real loads.
- Confirmed `pm_debugOverlay` (see below) persists correctly against
  the real extension: default `false` -> toggle -> `true` -> reopen a
  brand-new popup instance (simulating close+reopen) -> still `true`.

## BUG FIX (2026-08-30): "While catching up" radio lag + masked-list re-render audit

### Diagnosis

The architecture was already correct in the way that mattered most:
`saveTogglesOnly()` (the shared handler for every toggle AND every
catch-up radio) writes to `chrome.storage.sync` fire-and-forget, its
callback only ever touches the status text, and it never calls
`renderMasked()` - confirmed by grepping the full call graph and by a
live Playwright `MutationObserver` audit (below) showing **zero**
mutations to `#pm-masked-list` across four toggle/radio clicks
(checkbox, radio, checkbox, checkbox), while a subsequent Restore
Defaults click produced 124 mutations (proving the observer itself
works and that word-list re-renders are correctly scoped to actual
word-list changes only - Save, Restore Defaults, and the async
load()-reconcile step - never to a settings-only save).

The actual lag source: the radio group used plain native
`input[type="radio"]` elements styled only with `accent-color`. Native
radio/checkbox widgets - especially on macOS Chrome's modernized
"Chrome Refresh" form controls - carry their own internal fill
animation baked into the browser's UA rendering, which CSS
`transition` rules cannot fully suppress or tune (this is invisible to
DOM-level timing checks: `getComputedStyle(...).transitionDuration`
and the `change` event both fire in under 1ms, because the *logical*
state change is instant - only the browser's own *paint* of the native
widget lags, on a timescale headless-Chromium's rendering doesn't
reproduce identically to real macOS Chrome). This is exactly the class
of "invisible to automated timing but visible to a human eye" bug.

### Fix

Converted the "While catching up" radio inputs to a fully custom-drawn
control, the same principle already used for the toggle switches:
`appearance: none` plus a hand-drawn ring + dot purely from the
`:checked` pseudo-class in `popup.css`, with **no `transition` property
anywhere on the control** - there's nothing left to animate, native or
otherwise, so the paint is exactly as instant as the logical state
change. No JavaScript changes were needed for this half of the fix
(`saveTogglesOnly()` was already correctly fire-and-forget); a
defensive comment already existed above it from the earlier toggle-lag
fix and still applies verbatim to the radios.

### Verification

- `getComputedStyle(radioInput).transitionDuration` -> `"0s"` (no
  transition property applies at all).
- 5 sampled click-to-`change`-event latencies on the custom radio:
  all `< 1ms` (session scratchpad: `popup_radio_latency.js`).
- `MutationObserver` on `#pm-masked-list` across 4 consecutive
  toggle/radio clicks (mute-audio checkbox, pause-video radio,
  censor-captions checkbox, debug-overlay checkbox): **0 mutations**.
  A subsequent Restore Defaults click (which SHOULD, and does, change
  the word list): 124 mutations - confirms the observer is live and
  that the "only re-render on actual word-list change" invariant holds.
- Re-ran the real-extension 10-consecutive-opens repro
  (`popup_repro.js`) after this change: still 0/10 broken.
- Screenshot confirming the custom radio renders and selects correctly:
  session scratchpad, `popup-custom-radio-pause-selected.png`.

## FEATURE (2026-08-30): `pm_strictness` (Standard / Strict / Custom) + `pm_padding`

### `pm_strictness`: "standard" | "strict" | "custom" - default "strict"

Splits `DEFAULT_WORDLIST` into two groups and adds a third,
independent "use my own list" mode:

- `CORE_WORDLIST` (107 entries) - clear profanity, slurs, and crude
  terms.
- `EXTENDED_WORDLIST` (16 entries) - euphemisms, ASR-mishears, and
  religious exclamations (the entries added in the earlier "ASR-mishear
  / euphemism additions" pass, e.g. the `"gosh"`/`"heck"`/`"freaking"`
  family and the `"oh (my) god"`/`"jesus christ"` religious-exclamation
  set - see `shared/wordlist.js` for the exact list; not repeated here
  to keep this doc filter-safe).
- `CORE_WORDLIST.length + EXTENDED_WORDLIST.length === DEFAULT_WORDLIST.length`,
  no overlap, no leftovers - enforced by a dedicated test (see below).

`pm_strictness` selects which of three sources is ACTIVE:

| value        | active word list                        |
|--------------|------------------------------------------|
| `"standard"` | `CORE_WORDLIST` only                      |
| `"strict"`   | `DEFAULT_WORDLIST` (CORE + EXTENDED - the pre-existing full default) |
| `"custom"`   | the user's saved `pm_wordlist`, verbatim |

**"Explicit mode beats implicit override," both directions:** in
`"standard"`/`"strict"`, a saved `pm_wordlist` is completely IGNORED
for matching purposes - but it is NOT deleted or cleared; it stays
untouched in storage so switching to `"custom"` later immediately
recovers it (verified end to end in the integration test: switch
`"strict"` -> `"custom"` and the previously-ignored custom list's
entries start matching again, with zero re-saving). In `"custom"`, the
built-in `CORE`/`DEFAULT` lists are ignored entirely - even `"fuck"` (a
`CORE_WORDLIST` entry) won't match unless it also happens to be in the
user's custom list.

**Migration** (mirrors the `pm_catchupMode`/`pm_safeMode` pattern
exactly): resolved in `resolveSettingsFromStorage`, in this order:

1. A valid, explicitly saved `pm_strictness` always wins outright.
2. Otherwise, a saved `pm_wordlist` (`Array.isArray` true, even `[]`)
   migrates to `"custom"` - this is what makes a pre-strictness-feature
   install's existing custom list keep working exactly as before with
   zero user action needed.
3. Otherwise (fresh install, nothing saved at all) defaults to
   `"strict"` - the pre-strictness-feature default behavior
   (`DEFAULT_WORDLIST`).

An explicit `"custom"` with NO saved `pm_wordlist` at all (shouldn't
happen via the popup UI, which always seeds before switching, but the
pure function is defensive about it) falls back to `DEFAULT_WORDLIST`
rather than silently matching nothing.

### Popup: Strictness radio group + word-list section rewrite

- A new **"Strictness"** radio group, three stacked options each with
  a one-line description: **Standard** ("Clear profanity only"),
  **Strict** ("Also likely-profanity and religious exclamations"),
  **Custom** ("Your own edited word list"). Custom-drawn radios (same
  `appearance: none`, no-`transition` technique as the catch-up-mode
  radios - see the "radio flip lag" BUG FIX above), stacked vertically
  (`.pm-radio-group--stacked`) rather than the compact inline layout
  the other radio groups use, to fit the description text.
- The **Word list** section now shows a small italic note above the
  hint text - `"Showing: Strict (123 words)"` / `"Showing: Standard
  (107 words)"` / `"Showing: Custom (N words)"` - reflecting whichever
  list is currently ACTIVE, kept in sync by `renderMasked()` (which now
  reads from `activeWordlistForDisplay()` - `CORE_WORDLIST`,
  `DEFAULT_WORDLIST`, or the parsed textarea, depending on
  `getStrictness()` - instead of unconditionally reading the textarea).
  The hint text itself also changes: in "standard"/"strict" it reads
  "This is a built-in list and can't be edited directly - click 'Show
  words to edit' to switch to Custom and start from it"; in "custom" it
  reverts to the original masked-by-default editing hint.
- **In "standard"/"strict," the masked view is READ-ONLY** and shows
  the active built-in list; the textarea stays hidden and un-editable
  through the UI (nothing prevents editing it via devtools, but there's
  no in-UI path to reveal it without first switching to "custom").
  Clicking **"Show words to edit"** while in "standard"/"strict" - via
  `switchToCustomForEditing()` - auto-switches the Strictness radio to
  "custom" (saved immediately, fire-and-forget, same instant-on-select
  contract as every other radio in this popup), THEN reveals the now
  genuinely-editable textarea.
- **Seeding rule, per explicit product refinement:** switching to
  "custom" with no `pm_wordlist` ever saved seeds the textarea with the
  **full strict list (CORE + EXTENDED)** - always, regardless of which
  built-in mode (`"standard"` or `"strict"`) was active immediately
  beforehand. This is enforced by `enterCustomMode()`, gated on a
  module-level `hasSavedCustomWordlist` flag (set from `load()`'s
  reconciliation and after every successful word-list Save) - NOT on
  "whichever built-in list happened to be on screen." Verified directly:
  switching Standard -> "edit" seeds all 123 words (the full strict
  list), not 107 (Standard's own count).
- **If a custom list already exists**, switching away to
  "standard"/"strict" and back to "custom" (via the radio OR the edit
  button) resumes that EXACT existing list untouched - `load()`'s
  reconciliation keeps the textarea populated with the real saved
  `pm_wordlist` even while a built-in mode is what's on screen,
  specifically so this resume-without-reseeding behavior works
  correctly. Verified directly (a 3-word legacy list survives a
  Standard -> Custom round trip byte-for-byte).
- **Saving edits, or clicking Restore Defaults, while in
  "standard"/"strict" ALSO auto-switches to "custom"** - `save()` and
  `restoreDefaults()` both force `getStrictness()` to `"custom"` before
  proceeding if it isn't already, covering the edge case of a user
  reaching either action without going through the edit button first.
- **Selecting a mode is instant** (fire-and-forget `pm_strictness`
  write via the shared `saveTogglesOnly()`), but - deliberately, and
  unlike every OTHER toggle/radio in this popup - the Strictness radio
  gets its OWN change handler (`onStrictnessChange`), not the generic
  `saveTogglesOnly` directly, because changing strictness changes which
  word list is ACTIVE and so the masked view legitimately needs to
  re-render. This is a narrow, deliberate exception to the "toggle/radio
  saves never touch the masked list" invariant from the earlier lag
  audit - verified that it stays narrow: a `MutationObserver` on
  `#pm-masked-list` shows **0 mutations** across mute-audio/catch-up/
  padding/debug-overlay clicks, but **>0 mutations** on a Strictness
  click, in the same test run.

### `pm_padding`: "tight" | "normal" | "wide" - default "normal"

Simple, independent three-way setting with no interaction with
anything else (no migration path - there was no prior padding concept
to migrate from). Exposed in the popup as a **"Mute padding"** radio
group (compact inline layout, like the catch-up-mode radios) with a
combined hint: "How much surrounding audio gets muted around a word.
Tight may clip word edges; wide mutes a bit of surrounding speech too."
Wired through `STORAGE_KEYS`, `resolveSettingsFromStorage`,
`state`/`settings` (the 9th and final key added in this session),
`refresh()`, and the `onChanged` listener, identically to every other
setting. This file only stores/validates/exposes the value - the audio
pipeline's `content.js` (owned by the other agent) consumes it for the
actual mute-interval math.

## FEATURE (2026-08-30): language pack architecture, Spanish pack, LDNOOBW tier-2 packs, `pm_multilingual`

### ACTION NEEDED from the audio-pipeline agent: `manifest.json` web_accessible_resources

`shared/wordlist.js`'s `PMWordlist.setLanguage(lang)` lazily loads
non-English packs via `fetch(chrome.runtime.getURL("shared/packs/" +
lang + ".json"))` from the isolated-world content-script context.
Chrome does **not** allow a content script to `fetch()` its own
extension's packaged files unless they're listed in
`manifest.json`'s `web_accessible_resources` - this file is owned by
the audio-pipeline agent, not this one, so it hasn't been added here.
**Until `shared/packs/*.json` is added to `web_accessible_resources`,
every `setLanguage()` call for a non-`"en"` language will fail the
fetch and resolve to `packAvailable = false`** - English matching is
completely unaffected (this failure path was explicitly designed to
degrade gracefully, see below), but no other pack will ever actually
load. Needed manifest addition (same `matches` pattern as the existing
`dist/*` entry):

```json
{
  "resources": ["shared/packs/*.json"],
  "matches": ["chrome-extension://*/*"]
}
```

### Pack shape

A "pack" is a plain object:

```js
{
  lang: "es",                 // matches the pack's own filename (no .json)
  quality: "curated" | "community",
  words: { core: [...], extended: [...] },   // extended may be []
  matchConfig: {
    stemming: "en-suffix" | "none",
    foldDiacritics: boolean,
    substringMode: boolean,
    wildcards: boolean
  }
}
```

English is pack `"en"` - inlined in `shared/wordlist.js` (the existing
`CORE_WORDLIST`/`EXTENDED_WORDLIST`/`DEFAULT_WORDLIST` from the
`pm_strictness` feature, unchanged), with `matchConfig`
`{stemming:"en-suffix", foldDiacritics:false, substringMode:false,
wildcards:true}` - **exactly** the pre-pack-architecture matching
behavior. Every other language is a JSON file at
`shared/packs/<lang>.json`, loaded on demand - packs are never bundled
into every page load; only a page that actually calls
`setLanguage(lang)` for a given `lang` pays the fetch cost for it, once
(subsequent calls for the same `lang` reuse the in-memory cache, no
re-fetch).

**`pm_strictness`/the user's custom `pm_wordlist` are an "en"-only
concept.** They only apply while the active language is `"en"`; any
other active pack always uses its own full word list (core + extended
combined - no per-pack strictness split), and the custom list is not
consulted at all while a non-English pack is active. This is
deliberate - strictness tiers and hand-editing are an English-first UX
feature, not something every language pack needs to replicate.

### `PMWordlist.setLanguage(lang)` - the new API surface for the pipeline agent

```js
PMWordlist.setLanguage("es").then(function (ok) {
  // ok === true  -> the "es" pack (or "en") is now active
  // ok === false -> unknown lang / fetch failed / invalid pack shape;
  //                 the PREVIOUSLY active pack is left completely
  //                 unchanged (matching keeps working exactly as
  //                 before this call) - this is a signal-only failure
  //                 mode, never a broken/empty matching state.
});
```

- `setLanguage("en")` (or `setLanguage()`/falsy) restores English
  matching using whatever `pm_strictness`/`pm_wordlist` last resolved
  to - no storage round trip needed, it's cached (`state.enWordlist`,
  refreshed on every `refresh()` regardless of which language is
  currently active).
- `setLanguage(lang)` for an already-loaded pack applies instantly from
  the in-memory cache.
- `setLanguage(lang)` for a never-loaded pack fetches
  `shared/packs/<lang>.json`, validates its shape, caches it, and
  applies it. See the "ACTION NEEDED" note above for the
  `web_accessible_resources` dependency this requires.
- **`PMWordlist.packAvailable`** (live getter property, not a
  snapshot) - `true` once the currently-active language resolved to a
  real pack; `false` after a `setLanguage()` call for an unknown/
  unfetchable language (matching state is left exactly as it was
  before that call - this is purely a UI signal, e.g. for an on-player
  status pill to show "not supported for this language yet"). Always
  `true` for `"en"`.
- **`PMWordlist.activeLanguage`** (live getter property) - the current
  pack's `lang` code, `"en"` by default.
- Both are same-JS-realm live reads - fine for `content.js`/the
  on-player pill (same isolated-world realm as `shared/wordlist.js`),
  but **the popup runs in a separate JS realm/page** and can't read
  them directly. For the popup's benefit, `setLanguage()` also persists
  `{lang, quality, available}` to `chrome.storage.LOCAL` as
  `pm_activeLanguage` (not `sync` - this is transient per-tab runtime
  state, not a user setting) on every call (success or failure); the
  popup's Word list section reads it the same way the Stats section
  reads `pm_stats` (own `chrome.storage.onChanged` listener, filtered
  to `areaName === "local"`).
- `findMatches`/`isProfane`/`censorText` are all transparently
  pack-aware - they always match against whatever pack is currently
  active, rebuilt automatically by `setLanguage()`/`refresh()`. The
  pipeline doesn't need any other API changes to get multilingual
  matching once it calls `setLanguage()`.

### `pm_multilingual` (new storage key, `sync`, boolean, default `true`)

"Filter other languages (auto-detect)" toggle in the popup. This file
only stores/exposes it (`PMWordlist.settings.multilingual`, the 10th
key on that object now) - it has **no effect on matching by itself**.
The audio pipeline's Whisper-based language detection is expected to
read it to decide whether to call `setLanguage()` at all when it
detects non-English speech; if it's off, the pipeline should simply
never call `setLanguage()` for anything other than `"en"` (or should
call `setLanguage("en")` to make sure a previously-detected pack gets
turned back off). Wired through `STORAGE_KEYS`,
`resolveSettingsFromStorage`, `state`/`settings`, `refresh()`, and the
`onChanged` listener, identically to every other boolean setting.

### matchConfig-driven matching engine

Every pure matching function (`stemsOf`, `buildStemSet`,
`buildPhraseList`/`buildPhraseIndex`, `isProfaneCore`, `censorTextCore`,
`findMatchesCore`) now takes an optional trailing `matchConfig`
argument, defaulting to `EN_MATCH_CONFIG`
(`{stemming:"en-suffix", foldDiacritics:false, substringMode:false,
wildcards:true}`) when omitted - **every pre-existing call site in this
codebase (and every existing test) passes 2-3 args with no
`matchConfig`, so English behavior is provably byte-for-byte unchanged**
(the full pre-existing 234-test pure suite + 33-test integration suite
both pass unmodified in outcome, only updated for the new
`multilingual`/10th-key shape additions - see "Test results" below).

- **`stemming: "none"`** (every community-tier pack, plus the curated
  Spanish pack): no suffix-stripping at all - a "stem" is just the
  normalized word itself. These packs are expected to list common
  inflected forms explicitly in their own data (the curated Spanish
  pack does this for its core entries).
- **`foldDiacritics: true`**: `normalizeToken`/`normalizeSpaces`
  additionally run `String.prototype.normalize("NFD")` and strip
  combining diacritical marks (`̀-ͯ`) before the existing
  punctuation-trim step, so e.g. Spanish `"coño"` and an ASR-mishear
  `"cono"` (accent stripped) both normalize to the same match key, in
  both directions (list entries and input tokens/text are folded the
  same way). Applied to phrase-index words too (`buildPhraseList`
  passes `matchConfig.foldDiacritics` through).
- **`substringMode: true`** (Chinese/Japanese/Thai/Korean packs - no
  reliable whitespace word boundaries): `isProfaneCore` checks whether
  any list entry appears anywhere *inside* the normalized token/text
  (`isProfaneSubstring`, a plain `stemSet` substring scan) instead of
  exact-stem `Set` lookup; `censorTextCore` skips the token-regex path
  entirely and instead does a direct longest-entry-first substring
  scan-and-replace over the raw text. The phrase-index machinery is
  skipped for these packs (`buildPhraseList` returns `[]` when
  `substringMode` is true) since a multi-character list entry already
  matches as a substring on its own.
- **`wildcards`**: gates whether the existing `*`-wildcard matcher
  (aligned + first-letter-shorthand rules, unchanged) is even
  consulted; every pack ships this `true` (helps recognize
  partially-censored ASR output the same way English does), but the
  flag exists per the spec'd `matchConfig` shape.
- **Unicode-aware tokenizing** (a general correctness fix that
  incidentally makes non-English packs work at all, not itself a
  matchConfig field): `normalizeToken`'s punctuation-trim regex and
  `censorTextCore`'s token-scan/`censorWord` regexes were rewritten
  from a plain `a-z0-9'*` character class to Unicode property escapes
  (`\p{L}\p{N}'*`, `u` flag) - "core word character" now means any
  letter/digit in any language, not just ASCII. This is a strict
  superset of the old behavior for English (`\p{L}` already covers
  `a-z` case-insensitively, `\p{N}` covers `0-9`) - confirmed by the
  full unchanged English test suite - and is what lets e.g. accented
  Spanish `"coño"` or `"mamón"` get recognized/censored as one token in
  `censorTextCore` instead of being split apart at the accented
  character.

### Spanish pack (`shared/packs/es.json`, quality `"curated"`)

111 entries (96 core + 15 extended). LATAM + peninsular strong
profanity/vulgarity/insults, common inflected forms listed explicitly
per-entry (no stemmer - `stemming: "none"`), plus an extended group of
religious-exclamation equivalents and mild euphemisms (Spanish
equivalents of the English extended list's `"oh my god"`/`"gosh"`/
`"heck"` family). `matchConfig`: `{stemming:"none",
foldDiacritics:true, substringMode:false, wildcards:true}`. Word
content lives only in the JSON file, not reproduced here (filter-safe
convention, same as the English list).

**Collision scan**: attempted against a real Spanish dictionary
(`/usr/share/dict/words` is English-only on this machine, and no
`es_ES`/`es` aspell/hunspell wordlist is installed) - **skipped, no
Spanish system dictionary was available to scan against.** Every core
entry was manually reviewed for the same "innocent-word-collision"
standard applied to the English list; none of the 111 entries are
common non-profane Spanish words. This should be re-run properly if/
when a Spanish dictionary becomes available (e.g. `brew install
hunspell` + an `es_ES` dictionary, or a wordlist package).

### LDNOOBW tier-2 packs (`shared/packs/<lang>.json`, quality `"community"`)

`tools/import-ldnoobw.mjs` fetches every per-language raw word list
from the `LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words`
GitHub repo and converts each into a `"community"`-quality pack,
skipping `"en"`/`"es"` (both already have hand-curated packs - importing
the raw lists for those would be a quality regression, not an
addition). Cleaning is **programmatic only** (no manual per-entry
curation, per the coordinator's instruction): trim/dedupe/lowercase,
drop entries shorter than 2 characters or longer than 40 (implausible/
corrupted), drop control characters, the Unicode replacement character,
URLs, and digit-only lines. Per-language `matchConfig` defaults:
`stemming: "none"` for all (no per-language stemmer built),
`foldDiacritics: true` for Latin-script languages / `false` for
non-Latin-script ones (Arabic, Persian, Hindi, Russian, and the four
substring-mode languages below), `substringMode: true` for Chinese/
Japanese/Thai/Korean (no reliable word boundaries), `wildcards: true`
for all. Re-run with `node tools/import-ldnoobw.mjs` (all languages) or
`node tools/import-ldnoobw.mjs de fr ja` (specific ones) - network
access to `raw.githubusercontent.com` required; each run overwrites the
existing community-tier file for that language (never touches
`es.json`, which is curated and excluded).

Per-language entry counts (core + extended combined; every community
pack currently has an empty `extended` group - the raw LDNOOBW lists
aren't split into tiers):

| lang | name | quality | entries |
|---|---|---|---|
| ar | Arabic | community | 38 |
| cs | Czech | community | 41 |
| da | Danish | community | 20 |
| de | German | community | 66 |
| eo | Esperanto | community | 37 |
| es | Spanish | **curated** | 111 |
| fa | Persian | community | 45 |
| fi | Finnish | community | 130 |
| fil | Filipino | community | 13 |
| fr | French | community | 91 |
| fr-CA-u-sd-caqc | Québec French | community | 7 |
| hi | Hindi | community | 119 |
| hu | Hungarian | community | 96 |
| it | Italian | community | 168 |
| ja | Japanese | community (substring mode) | 176 |
| kab | Kabyle | community | 21 |
| ko | Korean | community (substring mode) | 70 |
| nl | Dutch | community | 190 |
| no | Norwegian | community | 40 |
| pl | Polish | community | 54 |
| pt | Portuguese | community | 76 |
| ru | Russian | community | 151 |
| sv | Swedish | community | 43 |
| th | Thai | community (substring mode) | 31 |
| tlh | Klingon | community | 3 |
| tr | Turkish | community | 142 |
| zh | Chinese | community (substring mode) | 297 |

(`en`, quality curated, ~123 entries - inline in `wordlist.js`, see
"Default list & known collisions" above - is the 28th language but
isn't a `shared/packs/` file.)

### Popup: "Filter other languages" toggle + active pack display

- New toggle in the popup body (between "Show status on player" and
  the "While catching up" radio group): **Filter other languages**
  (`pm_multilingual`, hint: "Auto-detect the spoken language and filter
  its own profanity too"), default **on**, saves immediately like every
  other toggle (`saveTogglesOnly()`).
- The Word list section gains a new line, `#pm-active-language-note`,
  hidden by default and only shown when `chrome.storage.LOCAL`'s
  `pm_activeLanguage` names a non-English, currently-active pack:
  `"Also filtering: Spanish (curated word list)"` /
  `"Also filtering: German (community-sourced word list)"`, or, if a
  `setLanguage()` call failed (`available: false`), `"Detected language
  not supported yet (<name>) - using your English list only"`. Reads/
  live-updates exactly like the Stats section (own
  `chrome.storage.onChanged` listener filtered to `areaName ===
  "local"`, correct-by-default-before-any-storage-read pattern - hidden
  until the async read resolves, never a placeholder flash).

### Test results (language pack architecture)

Extended both existing Node test files (session scratchpad, same
"kept out of the repo" convention as before - see "Re-running the
tests" below):

- **`wordlist_test.js`: 258/258 passed** (was 234; all 234 original
  assertions pass completely unmodified in behavior - the only edits to
  pre-existing assertions were adding the new `multilingual: true` key
  to 10 full-shape `resolveSettingsFromStorage(...)` equality checks,
  which is the same kind of mechanical update every prior new setting
  required). New coverage: `stemming:"none"` (exact + separately-listed
  inflected forms match, unlisted inflections don't), `foldDiacritics`
  (accented list entry matches both its own accented form and an
  accent-stripped input, in both `isProfaneCore` and `censorTextCore`,
  with a negative control proving the fold - not luck - is what makes
  it work), `substringMode` (exact match, substring-within-a-larger-
  token match, negative case, and an actual `censorTextCore` in-place
  replacement, using arbitrary CJK-shaped test strings that are NOT
  real profanity - this only tests substring matching mechanics),
  `PMWordlistCore.EN_MATCH_CONFIG` shape, `validatePack` (valid pack,
  wrong `lang`, invalid `quality`, `null` input), and `pm_multilingual`
  defaulting (empty/undefined -> `true`, explicit `true`/`false`
  respected, a corrupted non-boolean value treated as `true` consistent
  with every other true-default boolean, `STORAGE_KEYS` includes it).
- **`wordlist_integration_test.js`: 55/55 passed** (was 33). New
  coverage, appended after the existing `pm_strictness` end-to-end
  scenario: `PMWordlist.activeLanguage`/`packAvailable` default to
  `"en"`/`true`; **`setLanguage("es")`** (via a stubbed `fetch` +
  `chrome.runtime.getURL` that serves the REAL shipped `es.json` off
  disk, not a hand-rolled fixture, so this catches any shape drift
  between the pack file and what `setLanguage()`/`validatePack()`
  expect) resolves `true`, flips `activeLanguage`/`packAvailable`
  correctly, makes a real Spanish pack word match while the English
  custom list stops being consulted, and the active `matchConfig`
  matches the pack's own; **diacritic folding** end-to-end (an
  accent-stripped variant of a real accented Spanish core entry matches
  via both `isProfane` and `findMatches`, with an explicit "these
  actually differ" setup assertion); **switching back to `"en"`**
  restores the exact prior English wordlist byte-for-byte with no
  storage round trip and resumes English-only matching; **`setLanguage`
  with an unknown/unfetchable lang** (`"xx"`, simulated HTTP 404)
  resolves `false`, sets `packAvailable` to `false`, and - critically -
  leaves `activeLanguage` and matching completely unchanged (still
  `"en"`, still matching the English custom list) rather than breaking
  anything. Also updated the pre-existing `PMWordlist.settings` key-set
  assertions (two spots) from 9 to 10 keys (`multilingual` added).

```
$ node wordlist_test.js
... (258 lines of PASS) ...
258 passed, 0 failed

$ node wordlist_integration_test.js
... (55 lines of PASS) ...
55 passed, 0 failed
```

Also ran `node -e "..."` spot checks (not part of either test file)
confirming: all 27 `shared/packs/*.json` files (26 community + 1
curated) pass `PMWordlistCore.validatePack`; the Japanese pack's
substring mode correctly matches a real imported entry both standalone
and embedded inside a longer string, and correctly censors it in place
in `censorTextCore`; the French pack's `foldDiacritics` correctly
matches an accent-stripped variant of a real accented imported entry
(`"bourré"` -> stripped variant matches). A Playwright smoke test
(`popup_multilingual_smoke.js`, session scratchpad) confirmed, against
the real `popup.html`/`popup.js` with a minimal mocked
`chrome.storage`: the `#pm-multilingual` toggle exists and is checked
by default, one click flips it to unchecked, and
`#pm-active-language-note` is hidden by default; a second run
(`popup_activelang_smoke.js`) pre-seeded a mocked
`chrome.storage.local` with `pm_activeLanguage: {lang:"es",
quality:"curated", available:true}` and confirmed the note renders
exactly `"Also filtering: Spanish (curated word list)"` and un-hides.

### Re-running the tests

Same pattern as the existing suite (see "Re-running the tests" further
below in this file) - `wordlist_test.js`/`wordlist_integration_test.js`
in the session scratchpad `require()` `shared/wordlist.js` directly (as
`{PMWordlistCore, DEFAULT_WORDLIST}` / via `global.PMWordlist` after
stubbing `chrome.*`). The integration test's `setLanguage("es")`
scenario additionally needs `global.fetch` and
`chrome.runtime.getURL` stubbed (see the fake-fetch block near the top
of that file) - it reads the real `shared/packs/es.json` off disk
rather than a hand-rolled fixture, so it stays honest about the actual
shipped pack shape.

## FEATURE (2026-09-02, 0.1.31): "Report a problem"

A user-facing path from "it didn't mute the swearing" to something a
developer can act on, aimed at the people who actually hit this: friends
and parents, not engineers.

Before this, the only diagnostic route was the popup's "Copy debug log",
which yields a wall of JSON with no context - no description of what went
wrong, no video, no version, and no idea what to do with it next. A
non-technical user was never going to complete that journey.

### Where it lives

A **"Report a problem"** link beside "Copy debug log" in the popup's
Debugging row, and a second entry point on the onboarding flow's final
screen. Both open `report/report.html` in a tab. It shares "Copy debug
log"'s rule exactly: **always available, never lock-gated** - reporting a
problem changes no setting, and a child who hits one must still be able
to get the details to whoever can act on them. The browser harness
asserts it stays enabled in the two states that hide or disable other
things (settings locked, and not yet acknowledged).

The page reuses `popup.css` plus `onboarding.css`, which is now
explicitly the shared **full-page shell** for extension pages rather than
onboarding's private stylesheet (documented in its header; kept under
that name rather than churning a working file for cosmetics).

### The form

1. **"What happened?"** - freeform, with a hint that plain words beat
   technical ones ("It didn't mute the swearing about a minute in").
2. **"Which video?"** - prefilled from the newest `pm_devlog` entry via
   `latestVideoUrl()`, fully editable and clearable. The prefill only
   fires for a plausible YouTube id: `content.js` falls back to a
   *pathname* as `videoId` on non-watch pages, and gluing that into a
   watch URL would produce a confidently wrong link, so anything that
   doesn't look like an id yields an empty field instead.
3. **"Include my debug log (recommended)"** - checked by default, with
   one honest line about what that actually means: the matched words and
   their timings, the settings, and which parts of the video were
   analyzed - *not* transcripts of what was said, unless the user turned
   on `pm_devlogVerbose` themselves. Below it, a live summary states in
   numbers what will be attached, **including truncation before it
   happens** rather than as a surprise inside the report.
4. **"Copy report & open email"**.

### Why clipboard-and-paste, said out loud

`mailto:` cannot attach files, and its body travels in a URL that
browsers and mail clients truncate (commonly around a couple of thousand
characters). A debug log is tens to hundreds of KB. So the report goes on
the **clipboard** and the mail draft carries only the user's own words,
the video, the version, and the instruction to paste. That is genuinely
worse than an attachment, and the only alternative - uploading to a
server - would mean sending users' data somewhere, which this extension
does not do.

So the UI **says so plainly** ("Email can't attach the report
automatically, so this copies it to your clipboard and opens a draft.
Paste into the email where it says to, then send.") rather than letting a
user think the near-empty draft is a bug. The confirmation panel also
shows the support address as plain text and a "Copy the report again"
link, so a missing mail client is never a dead end. If the clipboard
itself is unavailable, the panel still appears with the mail link rather
than failing silently.

The mail draft is opened by clicking the page's own visible
`<a href="mailto:">` - so when no mail client is configured, nothing
happens and the fallback link the user can click themselves is already on
screen.

### Report shape

```
{ kind: "profanity-muter-problem-report", reportVersion, extensionVersion,
  userAgent, createdAt, videoUrl, whatHappened,
  debugLogIncluded, debugLogTruncated, debugLogNote, debugLog }
```

`debugLog` is `null` rather than omitted when withheld - an explicit "no
log here" reads unambiguously where an absent key reads like a bug in the
reporter. `debugLogNote` is **always** populated, including "The user
chose not to include their debug log", so nobody has to ask the reporter
why the log is missing and burn a round trip with someone already
frustrated.

**Size guard**: over ~200KB serialized, the log is cut to the **3 most
recent** videos (three, not one - the problem video is often not the
newest by the time someone gets round to reporting), and the truncation
is disclosed in `debugLogNote` with the real numbers (how many videos, of
how many, and the original size in KB).

### `SUPPORT_EMAIL`

A single constant beside `STORE_ITEM_ID` in `shared/moments.js`,
currently the placeholder `support@example.com`. Two tests guard it: one
asserts it is **still the placeholder** (so listing day fails the suite
and forces a real address, same forcing function as the store id), and
one asserts it is a **role address, never a personal mailbox** - it goes
out in the `mailto:` of every report and ends up in strangers' mail
clients and address books permanently.

### Tests

`test/report_test.js` (26) covers assembly and the two branches a user
can't see until it's too late: that **declining the log actually leaves
it out** (a privacy promise made in the UI, one boolean away from being a
lie - asserted by checking no log content survives anywhere in the
serialized report), and that an oversized log is **trimmed to the newest
3 with the truncation disclosed** rather than producing something nobody
can paste. Plus mailto shape (canonical unescaped address, versioned
subject, encoded body, paste instruction verbatim, **no log in the body**,
and the whole draft under 2000 characters so a mail client won't mangle
it), junk-input coercion, and the video prefill's refusal to guess.

`verify/popup_check.mjs` grew 103 -> 147: the popup link renders/enabled
(including while locked and pre-acknowledgment) and opens the page; the
page's consent default, prefill, empty-log copy, live truncation warning,
clipboard payload with and without consent, mail draft href shape and
size, cleared-video handling, "copy again", and the onboarding entry
point. The harness now injects the **real** manifest version into the
stubbed `getManifest()`, so version assertions are exact rather than a
moving target.

## FEATURE (2026-09-02, 0.1.30): Onboarding, honest limits & growth surfaces

Three surfaces that share one idea, which is why they share one module
(`shared/moments.js`): each is a small, purely-arithmetic predicate over a
few storage keys deciding whether to say something to the user right now.
Written where they are displayed, those predicates rot into untestable
`if`s scattered through `popup.js`; written as pure functions with an
injected clock, the whole eligibility matrix is checkable in milliseconds.
The UI files only render what they are told.

### 1. First-run onboarding (`onboarding/`)

A full extension page, opened automatically **once**, by `background.js`'s
second `onInstalled` listener, on `reason === "install"` only. Never on
`update`: an update the user did not ask for is the worst possible moment
to seize a tab, and doing it would re-open for everyone on every release.
`pm_onboarded` is set *before* the tab is created, so a failed open can't
leave the flag unset and re-trigger. Re-openable any time from the popup's
"Setup guide" link. No `chrome.tabs` permission is needed - `tabs.create`
is available to every extension; only *reading* tab url/title requires it.

Four steps, progress dots, everything local (three same-origin scripts,
two same-origin stylesheets, no network of any kind):

1. **How it works** - on-device transcription, nothing uploaded, no
   account, no server; matched words silenced as they play; captions
   censored too.
2. **What it won't do** - a full step, not fine print.
3. **Guided setup** - catch-up mode first and framed as the one setting
   worth thinking about, then built-in level, additional words, and an
   optional parental lock.
4. **Acknowledgment** - a real gate.

The page reuses `popup/popup.css` wholesale and adds only page layout
(`onboarding.css` undoes the popup's fixed 320px body width). A second
copy of the switch/radio/button styles would guarantee the two surfaces
drift. It writes the **same** storage keys as the popup through the same
one-funnel lock rule (`persist()`), resolves what to display through
`resolveSettingsFromStorage` so the 0.1.29 migration has one
implementation, and defines no settings semantics of its own.

**Honest-limits copy.** The tone target was to name the exact failure
mode plainly rather than reach for legalese - the register comparable
products use (Enjoy Movies Your Way naming poorly-timed subtitles and
words missing from captions; ClearPlay's "we do not guarantee that our
filters will be 100% accurate"; YouTube Kids' "no automated system of
filters is perfect"). So the screen says: analysis trails the video at
the start and after skipping, and that window is where a word is most
likely to slip through; speech recognition is imperfect and a clean word
can occasionally be muted by mistake; only listed words match; and
caption censoring depends on captions existing and being well-timed. It
closes with "no automated filter is perfect, and this one isn't either" -
a good filter, not a guarantee, the way you'd treat a spam folder.

**The acknowledgment** (`pm_ackNotPerfect: {version, timestamp}`) is a
checkbox plus a button that stays `disabled` until it is ticked. It is
not implied by reaching the screen, by clicking through, or by a
pre-ticked box. `version` is `ACK_VERSION`, so a future material change
to what is being acknowledged can require a fresh one instead of
silently inheriting consent to different words - a record from any other
version reads as *not acknowledged*. It is written **outside** the lock
funnel on purpose: it is not a setting but a record that this person was
told, and a parental lock must not be able to prevent it (blocking it
would only mean the banner never clears).

Until it exists, the popup shows a slim, non-dismissable **"Finish
setup"** banner. Slim and non-dismissable is the deliberate combination:
it blocks nothing and costs one line, but it is the one thing we want
every user to have actually seen.

### Mute, never bleep

Confirmed product rule, recorded here because it is the kind of thing a
future contributor "improves" without knowing: **this extension mutes and
must never add a bleep tone.** The Family Movie Act (17 U.S.C. §110(11))
protects making limited portions of a work *imperceptible* during a
private performance; it does not protect *adding* audio to someone else's
copyrighted work, which is exactly what a bleep is. Silence is the legal
basis on which the whole extension operates. The rule is restated at the
one place it could be violated - `engageMute()` in `content.js` - and the
onboarding copy says "silenced… removed, not covered over; nothing is
added to the audio" rather than anything that hints at a bleep. Do not
let future copy promise one either.

### 2. Review prompt (milestone-triggered)

A small dismissable card **inside the popup**. Never a new tab, never a
notification, never an interstitial.

> Is Profanity Muter doing its job? A review helps other parents find it.

**Chrome Web Store policy constraints**, enforced by
`reviewPromptEligibility` rather than by convention, and restated in
comments at both the predicate and the point of use:

- **Shown at most once, ever.** Once `pm_reviewPrompt` exists the
  predicate returns not-eligible forever. There is deliberately no
  "remind me later" state - that is how "at most once" quietly becomes
  "repeatedly".
- **Dismissal is permanent**, and "No thanks" is a real dismissal.
- **No incentive** of any kind, and **no rating solicited first** - no
  "was this helpful? → only positives get the review link" funnel. Both
  buttons are equally available.
- **Nothing is gated, degraded, delayed or nagged** based on whether the
  user reviews.

The card **records itself as shown the moment it renders**, not on click.
If it waited for a button, a user who simply closed the popup would be
asked again on every open. Being asked once and walking away is an answer.

Eligibility (all must hold): `videosProtected >= 10` **and**
`totalMuted >= 25` **and** installed >= 7 days **and** acknowledged
**and** never prompted. The milestones exist so the ask lands only on
someone with a real basis for an opinion; asking earlier produces both
worse reviews and a worse product. Note `pm_stats` lives in the **local**
area while the rest are **sync**, so the popup does two reads and merges
before deciding.

*Backfill:* installs predating 0.1.30 have no `pm_installedAt`;
`background.js` stamps it on update, so they wait 7 days from the update.
Deliberate - treating an unknown install date as old enough would prompt
every existing user the moment they updated, which is the surprise nag
the gate exists to prevent.

### 3. Share with a friend

A row in the popup, shown **only after acknowledgment** (nobody should be
recommending this before being told its limits) and deliberately **not**
lock-gated - like "Copy debug log", it changes no setting. One click
copies:

> I use Profanity Muter to auto-mute swearing in YouTube videos - free,
> runs entirely on your device: `<store URL>`

No tracking, no referral code, no query string at all (asserted in the
tests). The store URL and the review URL both derive from a single
`STORE_ITEM_ID` constant in `shared/moments.js`, currently the placeholder
`TODO_CHROME_WEB_STORE_ITEM_ID` since the extension isn't listed yet - and
a test asserts it is *still* the placeholder, so that when the listing
goes live the test fails and forces the id to be replaced rather than a
placeholder shipping silently in a share link.

### Tests

`test/moments_test.js` (36) - the full eligibility matrix below, ack
record shapes and version invalidation, `shouldAutoOpenOnboarding`, and
the share/store constants (including the no-tracking and no-incentive
assertions).

| input | eligible | reason |
|---|---|---|
| all gates met | yes | `eligible` |
| prompt record exists (dismissed or not, or `{}`) | no | `already-prompted` |
| never acknowledged / acked under an older version | no | `not-acknowledged` |
| no install date, or a non-numeric one | no | `no-install-date` |
| installed 6 days ago / 7 days minus a second | no | `too-new` |
| installed exactly 7 days ago | yes | `eligible` |
| install date in the future (clock skew) | no | `too-new` |
| no stats / 9 videos / garbage values | no | `not-enough-videos` |
| 10 videos but 24 mutes | no | `not-enough-mutes` |
| exactly 10 videos and 25 mutes | yes | `eligible` |

`verify/popup_check.mjs` grew from 39 to 103 checks, covering what only a
rendered page can show: the banner appearing when unacknowledged and
clearing when acked (including a stale ack version bringing it back), each
review gate individually suppressing the card, the card writing
`pm_reviewPrompt` on render, both buttons' behaviour, the share row
copying the blurb, share/debug-log/setup-guide staying usable while the
settings are locked, and the whole onboarding page - step navigation,
`mute` preselected, settings writing through, the deprecated `pm_wordlist`
never written, no built-in word appearing anywhere on that page either,
the Finish gate refusing a *forced* click on the disabled button, and an
existing parental lock disabling the setup step and refusing a forced
change until unlocked.

## FEATURE (2026-09-02, 0.1.29): Hidden lists & parental lock

Two changes that only make sense together: the popup stops showing the
built-in word lists, and it gains an optional password over settings.
Both come from the same use: a parent configuring this on a child's
machine, with the child in the room.

### 1. Hidden built-in lists, additive custom words

`pm_strictness` is now a three-way **level** - `"none"` / `"standard"` /
`"strict"`, default `"strict"` (product doctrine unchanged:
over-censoring beats under-censoring) - selecting how much of the
BUILT-IN list is on. The user's own words moved to a separate, **additive**
key, `pm_additionalWords`. The active English list is always:

```js
mergeWordlists(tierWordlist(level), additionalWords)   // deduped
```

**The built-in lists' contents are never displayed in the UI again.** Not
in the textarea, not in the masked view, not as a count. The old model
made that impossible to hold: `"custom"` meant "use my list INSTEAD of
the built-ins", so the only way to add one word was to switch to Custom,
which seeded the textarea with the entire built-in list to edit down -
i.e. adding "poop" to the filter required first showing a parent (and
whoever was looking over their shoulder) a screenful of slurs. It also
silently froze that user's copy of the built-ins at whatever shipped that
day; every later list improvement passed them by. Additive words fix
both, and `"none"` covers the case the old Custom mode really existed
for.

Popup surface: a **Built-in list** radio group (None / Standard / Strict)
with one-line descriptions that enumerate nothing, and a **My additional
words** textarea holding only the user's own entries. The summary line
reads e.g. `Strict list, plus 3 of your own` - level + the user's count,
never a built-in count (a built-in count only invites "which 123
words?"). Masking still applies to the user's own words: this popup gets
opened in front of the child it is filtering for.

`Restore defaults` now means "back to the shipped starting point": level
`strict`, no additional words. It writes immediately rather than staging
an edit, because there is nothing left to review.

**Migration table** (`resolveSettingsFromStorage`; `hasSavedWordlist`
means `Array.isArray(pm_wordlist)`, true even for `[]`):

| stored state | -> level | -> additionalWords | why |
|---|---|---|---|
| `pm_additionalWords` is an array | valid `pm_strictness`, else `strict` | that array (sanitized) | already on the new schema |
| ...with a stale `pm_strictness: "custom"` | `none` | that array | half-migrated storage must not re-enable a tier the user switched off |
| `"custom"` + saved `pm_wordlist` | `none` | that list | identical effective list to before |
| `"custom"` + saved `[]` | `none` | `[]` | an intentionally emptied list stays empty |
| `"custom"`, nothing ever saved | **`strict`** | `[]` | the OLD code fell back to `DEFAULT_WORDLIST` in this edge case. Mapping it to `none` would silently disable all filtering - the one migration outcome that must never happen |
| `"none"`/`"standard"`/`"strict"` | kept | `[]` | any `pm_wordlist` was already ignored in these modes and stays ignored |
| no/invalid `pm_strictness` + saved `pm_wordlist` | `none` | that list | pre-strictness schema meant "that list, no built-ins" |
| nothing saved | `strict` | `[]` | unchanged default |

`pm_wordlist` is never written again - not by `resolveSettingsFromStorage`
(which is pure) and not by the popup. It is left exactly where it was so
a rollback to 0.1.28 finds the user's old list intact.

The invariant the whole table is built around, asserted directly in
`test/wordlist_test.js`: **no pre-0.1.29 install filters LESS after the
upgrade.** For every legacy shape, every word that used to match still
matches.

### 2. Parental lock (`pm_lock`)

Optional password over every settings change in the popup. New module
`shared/lock.js` (plain script, Node-loadable pure core, loaded by
`popup.html` only - nothing in the content-script path consults it, so
it is deliberately absent from `manifest.json`).

- **Storage**: `pm_lock = {salt, hash}` in sync (so it roams), where
  `hash = SHA-256(salt + password)` in hex via `crypto.subtle`. The
  plaintext is never stored. The salt stops a common password's hash
  being recognizable at a glance; it is **not** meaningful protection
  against an offline attacker, and key stretching (PBKDF2/scrypt) was
  deliberately skipped - see below for why the threat model doesn't
  warrant it.
- **UX**: no lock -> a "Lock settings with a password" setup panel
  (enter + confirm). Lock set -> the popup opens LOCKED: settings visible
  but `disabled`, with a password field. Correct password unlocks **for
  that popup session only** - there is deliberately no persisted unlocked
  flag, so closing the popup re-locks (a parent who unlocks, changes a
  setting and walks away has re-locked by the time it loses focus).
  Setting a password does not lock the parent out of the popup they are
  standing in front of; the next open is locked. While unlocked, "Remove
  password" is available.
- **Honesty**: this is a **deterrent, not security**, and the caption
  under the control says so: anyone who can open `chrome://extensions`
  can clear this extension's storage or remove it, and a forgotten
  password means removing and re-adding the extension. All of this runs
  in the child's own profile; the lock raises changing a setting from one
  click to "know chrome://extensions exists and be willing to visibly
  wipe the extension", which is the whole product goal. Nothing in the
  code or the copy claims more.
- **Enforcement depth**: popup-side only, by explicit decision - this is
  client-side either way, and no content-script-side enforcement was
  built. But the check is **one rule in one place**:
  `persistSettings()` is the only function in `popup.js` that writes to
  storage (settings, word list, and the stats reset, which passes
  `area: "local"`), and it asks `PMLock.mayWriteSettings()` before doing
  anything. There are no per-handler checks to drift, and a future
  options surface inherits the rule by using the same funnel. The
  `disabled` attributes are the visible half; `persistSettings` is the
  half that actually enforces.
- **Two failure modes chosen deliberately**: a *corrupted* lock record
  reads as NO lock (a half-written record must not brick a profile), and
  an unreadable `pm_lock` (sync error) fails OPEN - a flaky sync quota
  must not lock a parent out of their own settings.
- **Startup race, closed**: `lockRecord === null` before `pm_lock` has
  been read means *unknown*, not *unlocked*. Without the separate
  `lockStateLoaded` flag, the milliseconds between the popup painting and
  the storage callback were a real bypass - a fast click would sail
  through. Writes in that window are refused with "One moment…" while the
  controls stay live and correct-looking.

**"Copy debug log" is exempt from the lock** (and from the debug-overlay
toggle): a kid who hits a problem must still be able to export a log and
send it to whoever can read it. It only reads storage.

### Tests

`test/wordlist_test.js` (34) - the full migration matrix above, the
additive merge (dedupe, whitespace normalization, EXTENDED-tier
interaction: `standard` + a re-added `"gosh"` gets that one word back
without the rest of the euphemism tier), and the never-filter-less
invariant. `test/lock_test.js` (19) - hash round trip against **real**
WebCrypto (Node's own `crypto.subtle`, injected rather than mocked, since
a mocked digest would only prove the plumbing calls something), salt
participation, malformed-record handling, and the write gate including
its fail-open behaviour.

`verify/popup_check.mjs` (39, `npm run verify:popup`, ~5s headless, no
network) covers the two properties that are properties of the RENDERED
PAGE and unreachable from a pure test: that no built-in word appears
anywhere in `document.body.innerText`, and that a locked popup writes
nothing even when the `disabled` attribute is stripped from devtools and
the change event dispatched anyway.

## FEATURE (2026-09-02, 0.1.28): persistent dev log (`pm_devlog`)

The question that kept coming up and could not be answered after the
fact was **"why did word X get through on video Y?"**. Everything needed
to answer it existed in memory at the time - the analyzed windows, the
matches found in each, the padded mute intervals, which regions played
while still unanalyzed - but all of it lived only in `content.js`'s
tab-lifetime console ring buffer, which dies with the tab and is only
recoverable if the user happened to click "Copy logs" *before*
navigating away. By the time anyone asks the question, the evidence is
gone. There was no persisted evidence at all.

New module **`shared/devlog.js`** (plain script, isolated-world safe,
Node-loadable pure core - same shape as `shared/wordlist.js`), loaded in
`manifest.json`'s isolated-world `content_scripts` entry as
`shared/wordlist.js` -> **`shared/devlog.js`** -> `content.js` ->
`captions.js`, i.e. before both files that use it. It attaches
`globalThis.PMDevlog` and keeps a **ring buffer of the last 10 videos**
in `chrome.storage.local` under `pm_devlog`.

**What one entry records** (full schema in `shared/devlog.js`'s header
comment, which is the source of truth):

- `videoId`, `title`, `startedAt`, extension `version`
- `settings` - the **resolved** snapshot at video start: `enabled`,
  `strictness`, `wordlistSource`, `wordCount`, `catchupMode`,
  `muteAudio`, `censorCaptions`, `padding`. Deliberately the word list's
  **source and size, never its contents** - a custom list can be
  thousands of entries and is the single biggest size risk in the whole
  record, while source + count is what actually answers "was the word
  even in the active list".
- `windows[]` - one per analyzed audio window:
  `{t0, t1, transcriptWordCount, matches: [{word, t}], muteIntervals:
  [{start, end}]}`. The matched words and their unpadded timestamps are
  kept; the **transcript text is not**, unless `pm_devlogVerbose` is on.
- `gaps[]` - `{start, end, mode}`: stretches of media time that **played
  while unanalyzed**, i.e. exactly the audio catch-up mode `"play"` lets
  through unchecked. Recorded in *every* catch-up mode, with `mode`
  naming the one in force, so one record answers both "what did play
  mode let through" and "what would play mode have let through if I
  switched to it".
- `captions[]` + `captionCount` - caption censor events as
  `{t, original, censored}`, **per word, not per segment**. Derived by
  aligning the before/after text token by token
  (`PMDevlogCore.diffCensored`), which is sound because `censorTextCore`
  preserves whitespace-separated token count on both its phrase path
  (`censorPhrase` maps word-by-word) and its single-token path. The one
  path that doesn't is `substringMode`; that case is detected by the
  length mismatch and recorded as a count with no per-word attribution
  rather than a guess. `captionCount` counts *all* events including ones
  later dropped by the size guard, so a short list never reads as
  "captions weren't censoring".
- `errors[]` - `{t, wall, text}`: every `TERROR` from `content.js` (the
  hook lives inside `TERROR` itself), plus the relayed offscreen `diag`
  messages and the `unanalyzable` verdict, which arrive as messages
  rather than thrown exceptions and would otherwise never reach it. The
  `diag` channel also carries routine progress chatter, so a small
  deny-list (`[PM-STAGE]`/`[PM-MODEL]`/`[PM-WARM]`/`[PM-LANG]`/
  `[PM-FIRST-COVERAGE]`) is filtered out - a live verification run put
  17 entries in one video's `errors`, every one of them a progress
  notice, which would eventually push real failures out of the capped
  list. Deliberately a deny-list of known-informational prefixes, never
  an allow-list of known-bad ones: an unrecognized message is kept, so
  the worst case is noise rather than blindness.
- `truncated` - stamped `true` if the size guard dropped anything from
  this entry, so a reader can never mistake a trimmed entry for a
  complete one.

**Privacy + size posture.** Transcripts are the one field gated behind a
flag, `pm_devlogVerbose` (`chrome.storage.sync`, default `false`), for
two reasons in this order: (1) a verbatim transcript of everything
watched sitting in storage is a very different thing to keep than a list
of matched profanity, and (2) transcripts dominate the 256KB budget and
would evict the structural evidence that actually answers the question.
There is **no popup UI** for the flag on purpose - it's a debugging
escape hatch, set deliberately with
`chrome.storage.sync.set({pm_devlogVerbose: true})` from the extension
console. It is read directly by `devlog.js` and is **not** in
`shared/wordlist.js`'s `STORAGE_KEYS` or the `PMWordlist.settings`
contract, because it is not a user-facing setting and nothing else needs
to see it.

**Size guard.** `pm_devlog` is capped at ~256KB serialized. Drop order,
in phases: oldest **videos** first, down to a single entry - the newest
entry is the video being watched right now, i.e. the one almost
certainly being asked about, so it is never dropped whole - then oldest
**windows** within the oldest surviving entry (windows are by far the
largest field, especially verbose), then captions, gaps, errors. Routine
per-entry ceilings (600 windows / 400 captions / 300 gaps / 100 errors)
keep the byte cap a backstop rather than the everyday mechanism.

**Write batching.** `chrome.storage.local` has a write budget, and this
module is fed from an rAF-cadence tick loop and a per-window
transcription callback. Every event mutates an **in-memory** entry only;
storage sees at most one read-modify-write every 5s, plus a forced flush
on `pagehide` and on a video change (so the video just left is durable
before its in-memory copy is dropped). Only the *current* video's entry
is held in memory - the ring itself lives in storage and is only ever
touched through that read-modify-write, which means two tabs watching
two videos both end up in the ring instead of one clobbering the other,
and memory stays O(one video) however long the browser session runs.

**Export.** New "Copy debug log" button in the popup's Debugging row
(`#pm-copy-devlog`, `popup.html` + `popup.js`), styled as a
`pm-link-button` alongside "Reset stats". It copies
`JSON.stringify(pm_devlog)` to the clipboard and reports through the
existing `setStatus` feedback: "Debug log copied (N videos)", "No debug
log yet" for the ordinary nothing-watched-yet case (rather than copying
`undefined` and looking broken), or "Copy failed" / "Clipboard
unavailable". Read-only - the popup never edits or clears the log.

**Instrumentation points** (`content.js`, `captions.js`): `resetSession`
opens the entry and `logVideoInfoOnce` refines its title/settings once
the player has resolved (at `document_start`, `document.title` is
routinely still the previous page's on a YouTube SPA navigation);
`applyWordsToIntervals` now also returns `matched[]` (word + unpadded
start) because the interval list it already returned gets padded and
then merged, and `mergeIntervals` concatenates overlapping intervals'
`word` labels with `+`, so by the time intervals reach the session they
no longer say which individual word was found where; `addWords` logs the
window; `runTickLogic` tracks catch-up gaps via `trackDevlogGap` against
`playheadUncovered` (**not** the `uncovered` variable, which folds in
`settings.safeMode` and is therefore always false in `"play"` mode - the
very mode whose leak this exists to measure); `censorElement` in
`captions.js` logs a censor event on any write that actually changed
something.

**Tests** (`extension/test/`, run with `npm test` from `extension/`):
`devlog_test.js` covers the pure core (ring eviction, upsert-on-rewatch,
size guard phases, entry/window shape, timestamp rounding, the caption
diff) - 24/24. `devlog_integration_test.js` stubs `chrome.storage` and
covers the browser wiring (write batching, flush-on-video-change,
verbose gating via `onChanged`, pre-session error buffering, corrupted
stored value, storage failures never throwing into the pipeline) -
14/14.

## What's built

### `shared/wordlist.js`
Plain (non-module) script, safe to load as the first isolated-world
content script. Attaches `globalThis.PMWordlist`:

- `isProfane(word) -> bool`
- `censorText(text) -> string`
- `findMatches(tokens) -> [{index, length}]` - see "Sequence matching"
  below; for the audio pipeline.
- `refresh() -> Promise` - re-reads `chrome.storage.sync` and rebuilds
  internal match structures.
- `settings` - live settings snapshot (see "Settings split" below).

Internals are split into a pure "core" (`PMWordlistCore`, no `chrome.*`
dependency: `normalizeToken`, `stemsOf`, `buildStemSet`,
`buildPhraseList`, `buildPhraseIndex`, `isProfaneCore`, `censorTextCore`,
`findMatchesCore`) and a small stateful wrapper that wires that core up
to `chrome.storage.sync` and `chrome.storage.onChanged`. The pure core
is what's unit tested (see below) and is also exported via
`module.exports` when running under Node, without turning the file into
an ES module for the browser.

Matching rules implemented exactly as specced:
- Case-insensitive, surrounding punctuation stripped; a trailing
  apostrophe (`"fuckin'"`) is also stripped.
- Base word plus common suffixes (`s`, `es`, `ed`, `ing`, `er`, `y`) via
  simple stemming applied to **both** the token being checked and each
  wordlist entry when building the match set - a straight `Set` lookup
  after normalization, not a regex per word. A suffix-stripped stem is
  only kept if it's at least 3 characters (`MIN_STEM_LENGTH`), which is
  what keeps `"ass"` from stripping down to the common word `"as"`.
- Dropped-g forms (`"fuckin"`, `"pissin"`, with or without a trailing
  apostrophe) are treated as if spelled with the `g`, so they reduce to
  the same stems as `"fucking"`/`"pissing"` in both directions (applied
  to both list entries and input tokens).
- **Wildcard matching** (new): a token containing `*` is routed to a
  dedicated matcher instead of the exact-stem `Set` lookup, so Whisper's
  partially-censored output (`"s***"`, `"sh*t"`, `"f**k"`, `"f***ing"`)
  is still recognized. Two rules, both documented in-code next to
  `isProfaneWildcard`:
  1. **Aligned wildcard** - token and candidate stem must be the *same
     length*; every non-`*` character in the token must equal the
     candidate's character at that position (case-insensitive).
     `"sh*t"` (len 4) aligns against `"shit"`; `"f***ing"` (len 7)
     aligns against `"fucking"`.
  2. **First-letter-only shorthand** - a token that's one real letter
     followed by nothing but asterisks (`"f***"`, `"a**"`, `"s***"`)
     matches *any* stem starting with that letter whose length is
     within ±1 of the token's length. Deliberately loose: a bare
     `"f***"` carries no positional information beyond "starts with f,
     about this long," so the tool errs toward matching (over-censoring)
     rather than requiring an exact-length align. Rule 1 already covers
     the same-length case; rule 2 only adds the ±1 tolerance.
  Both rules scan the (small, ~140-entry) stem `Set` linearly per call
  rather than building a regex per candidate - no regex-per-word
  explosion.
- Multi-word phrases (entries containing a space) are supported by
  `censorText` (longest-phrase-first, whitespace-flexible, case
  insensitive) but not by `isProfane`, which is single-token only, per
  spec. `findMatches` (below) supports phrases too, indexed for
  linear-time lookup.
- `censorText`/`censorWord` replace each matched word with
  `firstLetter + asterisks` (e.g. `"damn"` -> `"d***"`), preserving any
  punctuation glued to the token. Asterisks are treated as *core*
  characters (not punctuation) throughout tokenizing and censoring, so
  an already partially-censored token like `"sh*t"` is recognized and
  fully re-censored to the canonical `"s***"` rather than being split on
  the `*` or left alone.
- YouTube's auto-caption profanity placeholder `"[ __ ]"` is always
  rewritten to `"[ *** ]"`, independent of the word list.
- All `chrome.*` access is guarded (`hasChromeStorage()` checks +
  try/catch around listener registration) so loading this file in a
  page/context without `chrome.*` (e.g. the Node test) never throws.

### Sequence matching for the audio pipeline: `findMatches(tokens)`

`PMWordlist.findMatches(tokens)` / `PMWordlistCore.findMatchesCore(tokens, stemSet, phraseIndex)`
takes an array of already-transcribed words in order and returns
`[{index, length}, ...]` - one entry per match, covering:
- a single profane word (via the same `isProfane`/wildcard logic,
  `length: 1`), or
- a multi-word phrase from the word list (`length` = word count).

**Linear time**: phrases are indexed by their first normalized word
(`buildPhraseIndex`, a `Map<firstWord, phraseWordArrays[]>`, each bucket
sorted longest-first). For each input token, `findMatchesCore` does one
`Map` lookup plus, at most, a short scan of same-first-word phrase
candidates (typically 0-2) - no `O(tokens * phrases)` scan. Phrase
comparison is case-insensitive and punctuation-tolerant per token
(`normalizeToken` on each token before comparing), so `"Oh, my GOD"`
matches the `"oh my god"` entry. Matches are reported in token order and
are *not* deduped against overlap (the loop doesn't skip ahead past a
phrase match) - in practice this only matters for pathological
overlapping entries, which the shipped default list doesn't have.
Respects `pm_enabled` the same way `isProfane`/`censorText` do (returns
`[]` when disabled).

### `captions.js`
Isolated-world content script intended for `document_start`, run after
`shared/wordlist.js`. Uses a single `MutationObserver` on
`document.body` (subtree + childList + characterData) and, on each
batch of mutations, schedules one coalesced censor pass per animation
frame via `requestAnimationFrame`.

Censors:
- Player captions: every `.ytp-caption-segment` node's `textContent`.
- Transcript panel (when open): every `ytd-transcript-segment-renderer`,
  targeting its `#segment-text` / `.segment-text` / `yt-formatted-string`
  child (falls back to the row itself if none of those exist).

Avoiding self-triggered observer loops:
- A `WeakMap<node, lastWrittenText>` records the exact string this
  script wrote to a node. Before writing, it compares the node's
  current `textContent` to that recorded value; if they match, the
  current mutation was caused by our own previous write (or is a
  duplicate re-render of already-censored text) and is skipped.
- It also skips the write entirely when `censorText()` returns the same
  string as the input (nothing to censor), so untouched caption text
  never triggers a DOM write / new mutation.
- Respects `pm_enabled` AND `pm_censorCaptions` (via
  `PMWordlist.settings`, guarded); when either is off, the observer
  callback and animation-frame pass are no-ops. `pm_censorCaptions` off
  + `pm_muteAudio` on lets a user verify audio muting against the real
  (uncensored) caption text.
- Listens to `chrome.storage.onChanged` for `pm_enabled` / `pm_wordlist`
  / `pm_safeMode` / `pm_censorCaptions` and, on change, clears the
  write-cache and re-runs a full censor pass so a popup toggle is
  reflected live without a page reload.

## Storage schema

### `chrome.storage.sync` (settings - synced across the user's devices)

| key                 | type                      | default                              |
|---------------------|---------------------------|----------------------------------------|
| `pm_enabled`        | `boolean`                 | `true` - master on/off                 |
| `pm_muteAudio`      | `boolean`                 | `true` - audio-pipeline mute toggle    |
| `pm_censorCaptions` | `boolean`                 | `true` - caption-censoring toggle      |
| `pm_catchupMode`    | `"mute"\|"pause"\|"play"` | `"mute"` - THE ONE setting for what happens in parts of the video not yet analyzed (see below); any other/invalid stored value defaults to `"mute"` |
| `pm_debugOverlay`   | `boolean`                 | `false` - shows an on-player diagnostic overlay (consumed by the audio pipeline's `content.js`); opt-in, unlike the other booleans which default to `true` |
| `pm_showStatus`     | `boolean`                 | `true` - shows an on-player status pill (consumed by the audio pipeline's `content.js`). Distinct from `pm_debugOverlay`: this is a lightweight, on-by-default status indicator, not an opt-in diagnostic |
| `pm_strictness`     | `"none"\|"standard"\|"strict"` | `"strict"` - the LEVEL: how much of the BUILT-IN list is on (nothing / `CORE_WORDLIST` / `DEFAULT_WORDLIST`). The active list is always this tier PLUS `pm_additionalWords`. `"custom"` is no longer a valid value - see "Hidden lists & parental lock" below for the full migration table |
| `pm_additionalWords` | `string[]`               | unset -> `[]` - the user's OWN words, ADDED ON TOP of the tier. The only word-list key the popup writes from 0.1.29, and the only one whose contents are ever shown in the UI |
| `pm_onboarded`      | `boolean`                 | `false` -> the onboarding tab has not been auto-opened yet. Set by `background.js` on a genuine install, immediately before opening the tab. NOT "finished onboarding" |
| `pm_ackNotPerfect`  | `{version, timestamp}` or absent | absent -> the popup shows the "Finish setup" banner and hides the share row. Written by the onboarding page's final step |
| `pm_installedAt`    | `number` (epoch ms) or absent | stamped once by `background.js`; gates the review prompt's 7-day rule |
| `pm_reviewPrompt`   | `{shownAt, dismissed}` or absent | absent -> the review prompt may still be shown. Its existence alone disqualifies forever |
| `pm_lock`           | `{salt, hash}` or absent  | absent -> no lock. Optional parental lock over the popup's settings; `hash` = SHA-256(salt + password), hex. Owned by `shared/lock.js` + `popup/popup.js`; NOT in `STORAGE_KEYS`, NOT in the `PMWordlist.settings` contract. A deterrent, not security |
| `pm_padding`        | `"tight"\|"normal"\|"wide"` | `"normal"` - how much surrounding audio the mute interval pads around a matched word; consumed entirely by the audio pipeline's `content.js` for its interval math |
| `pm_multilingual`   | `boolean`                 | `true` - "Filter other languages (auto-detect)"; stored/exposed here only - the audio pipeline's language detection reads it to decide whether to call `PMWordlist.setLanguage(lang)`; see "FEATURE: language pack architecture" below |
| `pm_safeMode`       | `boolean`                 | DEPRECATED, read-only. No longer written by the popup - merged into `pm_catchupMode`. Only consulted, once, to migrate a legacy `false` forward (see "Safe mode + catch-up mode merge" below) |
| `pm_devlogVerbose`  | `boolean`                 | `false` - when true, the persistent dev log also stores each analyzed window's FULL transcript text. Owned and read directly by `shared/devlog.js`; deliberately NOT in this file's `STORAGE_KEYS` and NOT part of the `PMWordlist.settings` contract - it is a debugging escape hatch with no popup UI (set it from the extension console), not a user-facing setting. See "FEATURE: persistent dev log" above |
| `pm_wordlist`       | `string[]`                | **DEPRECATED as of 0.1.29, read-only.** Was the user's REPLACEMENT list under the old `"custom"` mode. Now read only to migrate an existing install onto `pm_additionalWords`, and deliberately left untouched in storage afterwards so a rollback finds it intact |

`pm_additionalWords` semantics: it is respected exactly as saved,
including an intentionally emptied list, and it is **additive** - it
never suppresses the built-in tier. A user who wants only their own words
selects level `"none"`, which is a first-class choice rather than an
emergent consequence of emptying a list.

(Historical note on `pm_wordlist`, which the above replaced: built-in
defaults were used **only** when that key had never been saved at all
(`items.pm_wordlist === undefined`), and once anything was saved -
including an emptied list - it was used verbatim with no length-based
fallback. That rule still governs how the 0.1.29 migration reads the old
key: `Array.isArray(pm_wordlist)` is the "the user saved something" test,
and `[]` counts.)

### `chrome.storage.LOCAL` (stats - per-install, NOT synced) - new, 2026-08-30

| key        | type                                            | default |
|------------|--------------------------------------------------|---------|
| `pm_stats` | `{totalMuted: number, videosProtected: number}`  | absent -> popup shows zeros |
| `pm_activeLanguage` | `{lang: string, quality: string\|null, available: boolean}` | absent -> popup shows nothing (assumed English). Written by `shared/wordlist.js`'s `setLanguage()` on every call (success or failure); read by `popup/popup.js` to display the active non-English pack, if any - see "FEATURE: language pack architecture" below |
| `pm_devlog` | `{version: 1, videos: Entry[]}` | absent -> popup's "Copy debug log" says "No debug log yet". The persistent dev log: a ring buffer of the last 10 videos (analyzed windows + matched words, padded mute intervals, unanalyzed-playback gaps, caption censor events, errors), capped at ~256KB serialized. Written by `shared/devlog.js` from `content.js`/`captions.js`, batched to at most one write per 5s; read (never modified) by `popup/popup.js`'s "Copy debug log" button. `shared/wordlist.js` does not touch it. Full `Entry` schema lives in `shared/devlog.js`'s header comment - see "FEATURE: persistent dev log" above |

Written by the audio pipeline (`content.js`, owned by the other agent)
as it runs; `shared/wordlist.js` does not read or write this key at
all - it's handled entirely in `popup/popup.js`, independently of the
`chrome.storage.sync` settings flow, because it's a different storage
**area** on purpose (per-install telemetry, not something that should
sync across a user's devices). See "STATS section" under `popup/`
below for the popup-side read/display/reset/live-update details.

### Safe mode + catch-up mode merge (2026-08-30)

Per user feedback, the separate "Safe mode" toggle and "While catching
up" radio choice were two settings expressing one idea, so they were
merged into a single setting: `pm_catchupMode` now takes three values
instead of two.

- `"mute"` (default) - mute audio in parts not yet analyzed.
- `"pause"` - pause playback outright in parts not yet analyzed (full
  protection: nothing unanalyzed ever plays).
- `"play"` - let it play unanalyzed. This is the old "Safe mode off"
  behavior, now expressed as a third catch-up option instead of a
  separate toggle.

The popup's standalone "Safe mode" toggle row and its `pm-safe-mode`
checkbox are **gone**. The "While catching up" radio group now has
three options - Mute audio / Pause video / Let it play - with the hint
updated to "What happens in parts of the video not yet analyzed." The
popup **stops writing `pm_safeMode` entirely**; only `pm_catchupMode` is
saved from here on.

**Back-compat contract, preserved exactly:** `content.js` (owned by the
other agent) already reads `PMWordlist.settings.safeMode` as a boolean
and needed zero code changes. `resolveSettingsFromStorage` still
returns a `safeMode` field, but it is now **derived**, not read
independently from storage:

```js
safeMode = (catchupMode !== "play")
```

So `catchupMode: "mute"` or `"pause"` -> `safeMode: true`;
`catchupMode: "play"` -> `safeMode: false`. Once `pm_catchupMode` has
ever been explicitly saved, a stale/contradictory `pm_safeMode` left
over in storage is completely ignored for both the derived `safeMode`
and for `catchupMode` itself - `pm_catchupMode` always wins outright
when it's a valid, explicitly-saved value.

**Migration path** (`resolveSettingsFromStorage`, only applies when
`pm_catchupMode` has never been saved / is invalid):

1. A valid, explicitly saved `pm_catchupMode` (`"mute"`/`"pause"`/
   `"play"`) always wins outright - checked first, regardless of what
   `pm_safeMode` holds.
2. Otherwise, if the legacy `pm_safeMode` was explicitly saved as
   `false` (the user had turned safe mode off under the old two-setting
   schema), migrate that forward as `catchupMode: "play"` - preserving
   the user's old choice instead of silently reverting to `"mute"` and
   re-enabling protection they'd turned off.
3. Otherwise (nothing saved at all, `pm_safeMode` was `true`/unset, or
   `pm_catchupMode` is corrupted/mistyped) default to `"mute"`.

This migration is stateless and re-evaluated on every `resolveSettingsFromStorage`
call - it isn't a one-time write-back to storage. It naturally stops
applying the moment the user picks any of the three radio options in
the popup, since that action saves `pm_catchupMode` explicitly (rule 1
then wins forever after, even though the stale `pm_safeMode: false`
never gets cleaned up in storage - that's fine, it's simply never
looked at again).

Validated the same way the boolean keys default to `true` on anything
other than an explicit `false`: `resolveSettingsFromStorage` checks
`CATCHUP_MODES.indexOf(items.pm_catchupMode) !== -1` (where
`CATCHUP_MODES = ["mute", "pause", "play"]`) before falling through to
the migration check and then to `DEFAULT_CATCHUP_MODE` (`"mute"`).

### `PMWordlist.settings`

`PMWordlist.settings` is a dedicated object containing **exactly**
`{enabled, muteAudio, censorCaptions, safeMode, catchupMode, debugOverlay, showStatus, strictness, padding, multilingual, additionalWordCount}`
(11 keys, as of the 0.1.29 `additionalWordCount` addition - a COUNT, never
the words themselves; the user's own list lives on `_state.additionalWords`.
See also "FEATURE: language
pack architecture" above) - no `wordlist`, `stemSet`, `phrases`, or
`phraseIndex` leakage (those live on the separate internal `_state`
object used by `isProfane`/`censorText`/`findMatches`). `safeMode` is
derived from `catchupMode` as described above. It's the same object
reference on every `refresh()`/`onChanged` cycle, mutated in place -
`content.js` (owned by the other agent) can read
`PMWordlist.settings.muteAudio`, `PMWordlist.settings.catchupMode`,
`PMWordlist.settings.safeMode`, `PMWordlist.settings.debugOverlay`,
`PMWordlist.settings.showStatus`, `PMWordlist.settings.strictness`,
`PMWordlist.settings.padding`, or `PMWordlist.settings.multilingual`
directly and each will reflect the latest saved/derived value without
needing its own storage listener, and without ever seeing internal
`Set`/`Map` fields. See "CRITICAL BUG FIX" above for why this was
tightened up.

### `pm_debugOverlay` (2026-08-30)

Simple opt-in boolean, `false` by default (one of two settings in this
schema that do NOT default to `true` - see `pm_showStatus` for
contrast). Turning it on is intended to show a small diagnostic overlay
on top of the YouTube player - that overlay itself is built and
rendered by the audio pipeline's `content.js` (owned by the other
agent); this file's only responsibility is exposing the live setting
via `PMWordlist.settings.debugOverlay`, wired through `STORAGE_KEYS`,
`resolveSettingsFromStorage`, `refresh()`, and the `onChanged` listener
exactly like every other setting.

### `pm_showStatus` (new, 2026-08-30)

Simple boolean, `true` by default (unlike `pm_debugOverlay` - this is a
lightweight, always-on-by-default status pill, not an opt-in
diagnostic). The popup's "Show status on player" toggle writes it; the
audio pipeline's on-player status pill (built/rendered by `content.js`,
owned by the other agent) reads it via `PMWordlist.settings.showStatus`
to decide whether to render at all. Wired through `STORAGE_KEYS`,
`resolveSettingsFromStorage`, `state`/`settings` (the 7th key),
`refresh()`, and the `onChanged` listener, identically to every other
setting in this file.

## `popup/`

### UI fix (2026-08-30): toggle responsiveness + knob vertical centering

User feedback flagged two toggle-switch issues, both fixed:

1. **Perceived lag on click.** The switches were already architecturally
   correct - the visual flip is driven purely by CSS off the checkbox's
   native `:checked` state (`.pm-switch input:checked + .pm-switch-track`
   etc. in `popup.css`), which happens before the `"change"` JS handler
   even runs, and `saveTogglesOnly()` was already fire-and-forget
   (`chrome.storage.sync.set(...)`, no `await`, no re-read/re-render in
   the callback - it only ever touches the status text). Two real
   contributors to sluggish/inconsistent feel were found and fixed
   anyway: (a) the transition duration was at the very top of the
   acceptable range (`0.15s`); tightened to `0.14s` on both the track's
   `background` transition and the thumb's `transform` transition,
   comfortably inside 120-150ms. (b) Each switch `<label>` had **both**
   an explicit `for="pm-..."` attribute **and** the `<input>` nested
   inside it as a descendant - a redundant double-association that's a
   known source of inconsistent/double click-forwarding behavior across
   browser engines. Removed the `for` attributes from all four switch
   labels (`popup.html`); the nested `<input>` alone is sufficient for
   both the label's click-to-toggle behavior and its accessibility
   association. A defensive comment was added directly above
   `saveTogglesOnly()` in `popup.js` locking in the invariant for future
   edits: the storage-write callback must never re-set `.checked` on any
   control or otherwise gate the toggle's visual state.
2. **Knob vertically off-center** (closer to the top of the track).
   Root cause: `.pm-switch-track` was `display: block` and
   `.pm-switch-thumb` was a block child positioned with `margin: 2px`
   on all sides - a block child's margin can collapse through a
   border-and-padding-less parent, which is exactly what was happening,
   pulling the thumb away from true (trackHeight − thumbHeight) / 2
   centering. Fixed by making `.pm-switch-track` a flex container
   (`display: flex; align-items: center;`) and giving the thumb
   `margin-left: 2px` only (no top/bottom margin to collapse) - flexbox
   centers the 16px-tall thumb in the 20px-tall track using real layout
   math, immune to margin collapsing. The existing `translateX(16px)`
   checked-state animation is untouched (transforms don't affect flex
   layout, so the horizontal slide behavior is unchanged).

**Verified** with a Playwright script (`popup_screenshot.js`, session
scratchpad) that opens `popup.html` directly via a `file://` URL with a
minimal mocked `chrome.storage.sync`/`onChanged` (no extension build/ID
needed):
- `getBoundingClientRect()` ground-truth geometry on the "Enabled"
  switch (ON) and the "Mute audio" switch (OFF, after a real click):
  both report `topGap: 2, bottomGap: 2` - exactly
  `(20 − 16) / 2 = 2` on both sides, pixel-centered in both states.
- Three sequential clicks on `#pm-mute-audio` toggle `checked` as
  `false → true → false` - exactly one flip per click, confirming the
  `for`-attribute removal eliminated any double-toggle risk.
- Screenshots saved to the session scratchpad:
  `popup-at-rest.png` (full popup, all switches ON, default catch-up
  mode), `popup-toggled.png` (same, "Mute audio" switched OFF via one
  click), `popup-switch-on-crop.png` (tight crop of the "Enabled"
  switch), and `popup-switch-on-zoomed.png` (same crop re-rendered at
  8x device scale factor for an easy visual centering check - the knob
  sits with a visually equal gap above and below it inside the track).

- `popup.html` / `popup.css` / `popup.js`, zero external resources
  (loads `shared/wordlist.js` itself, via a relative `<script src="../shared/wordlist.js">`,
  purely to reuse `DEFAULT_WORDLIST` and `chrome.storage.sync` - no new
  cross-boundary file was created, this only reads our own owned file).
- Four toggles, each saving immediately on change: **Enabled** (master),
  **Mute audio**, **Censor captions** (hint: "turn off to verify audio
  muting against what's actually said"), **Show status on player**
  (`pm_showStatus`, new 2026-08-30, hint: "Show a small status pill on
  top of the YouTube player", default **on** - consumed by the audio
  pipeline's `content.js` via `PMWordlist.settings.showStatus`; this
  popup/`shared/wordlist.js` side only owns the setting, not the pill's
  rendering). There is no separate Safe mode toggle anymore - see below.
- **"While catching up" radio group** (`pm_catchupMode`), three options
  - **Mute audio** / **Pause video** / **Let it play** - with the hint
  "What happens in parts of the video not yet analyzed." This single
  setting replaced the old Safe mode toggle + two-option radio combo
  (see "Safe mode + catch-up mode merge" above for the full rationale
  and migration path). Three `<input type="radio" name="pm-catchup-mode">`
  elements; saves immediately on change like the toggles. `pm_safeMode`
  is never written by the popup anymore - it's read once by
  `shared/wordlist.js`, only for the legacy migration, and the popup
  itself also consults it purely to decide what to *display* as checked
  on first load after an update (mirroring the same migration rule so
  the radio group doesn't flash "Mute audio" and then jump to "Let it
  play" - see `load()`'s `displayedCatchupMode` computation in
  `popup.js`). Loading an invalid/unset stored value (and no legacy
  `pm_safeMode: false` to migrate) falls back to selecting "Mute audio"
  (`"mute"`), the same defaulting rule as `resolveSettingsFromStorage`.
  The three radio inputs are custom-drawn (`appearance: none` + a
  hand-styled ring/dot, no `transition` property) rather than native -
  see the "radio flip lag" BUG FIX near the top of this file for why.
- **"Mute padding" radio group** (`pm_padding`, new 2026-08-30) -
  **Tight** / **Normal** / **Wide**, compact inline layout like the
  catch-up-mode radios, with a combined hint covering all three
  options. See "FEATURE: pm_padding" above; this file only stores the
  value, the audio pipeline does the actual interval math.
- **"Strictness" radio group** (`pm_strictness`, new 2026-08-30) -
  **Standard** / **Strict** / **Custom**, stacked layout with a
  one-line description under each option. This is the big one - full
  behavior (read-only built-in lists, auto-switch-to-custom on edit,
  the "seed with the full strict list" rule, ignore-both-directions
  semantics, migration) is documented in its own "FEATURE:
  pm_strictness" section near the top of this file, not repeated here.
- **Word list is masked by default.** On open, a read-only
  `<div id="pm-masked-list">` lists every current entry with its letters
  replaced by asterisks (spaces preserved, so a phrase still reads as
  multiple words, e.g. `"*** ** * ****"`). A "Show words to edit" link
  button swaps to the real `<textarea>` for editing (label flips to
  "Hide words"); re-masking re-renders the masked view from whatever is
  currently in the textarea, so in-progress edits are reflected. The
  `<textarea>` is always the single source of truth (hidden via a
  `pm-hidden` class when masked, not removed from the DOM), so Save
  reads from it regardless of the current view.
- **Real, editable defaults, not a placeholder.** On load, if
  `pm_wordlist` has never been saved, the textarea is populated with the
  full `DEFAULT_WORDLIST` content (one entry per line) - genuinely
  editable, not a greyed-out placeholder hint. Once saved, the textarea
  shows exactly the saved list.
- **Restore defaults** button repopulates the textarea (and, if masked,
  re-renders the masked view) with the full default list; it does not
  save automatically - the user still clicks Save to persist it, same
  as any other edit.
- **Save** always writes exactly what's in the textarea (parsed:
  trimmed, blank lines dropped) to `pm_wordlist`, including an
  intentionally empty array.
- A small **"Debugging"** section (new, 2026-08-30) with one toggle,
  **Show debug overlay** (`pm_debugOverlay`, hint: "Show analysis
  status on top of the YouTube player"), defaulting to **off** - the
  only toggle in the popup that defaults false. Saves immediately on
  change like the other toggles. Consumed by the audio pipeline's
  `content.js` via `PMWordlist.settings.debugOverlay` to drive an
  on-player diagnostic overlay; this popup/`shared/wordlist.js` side is
  only responsible for the setting itself, not the overlay's rendering.
- A small **"Stats"** section (new, 2026-08-30) displaying
  `chrome.storage.LOCAL` key `pm_stats` (`{totalMuted, videosProtected}`,
  written by the audio pipeline - see the storage schema above)
  compactly as "words muted all-time: N &middot; videos protected: M".
  Deliberately reads `chrome.storage.LOCAL`, not `sync` - this is
  per-install telemetry, handled entirely independently of the
  settings `load()`/`save()` flow, with its own
  `chrome.storage.onChanged` listener filtered to `areaName === "local"`
  so the line live-updates while the popup happens to be open and the
  pipeline writes new totals, with no polling. Renders zeros
  synchronously first (same correct-by-default-before-any-storage-read
  pattern as the settings - see "BUG FIX" above), reconciling to the
  real stored value once `chrome.storage.local.get` resolves; a
  malformed/non-numeric stored value is sanitized to `0` rather than
  rendering `NaN` or throwing. A **"Reset stats"** link button writes
  `{totalMuted: 0, videosProtected: 0}` back to `chrome.storage.local`
  - fire-and-forget, same rule as every other write in this popup: the
  displayed line zeroes out immediately on click, the actual
  `chrome.storage.local.set()` call happens in the background and only
  updates the status text on completion/failure, never re-rendering or
  blocking the visual reset.
- A status line (`role="status"`, `aria-live="polite"`) shows
  "Saved" / "Save failed" / "Storage unavailable" / a Restore-defaults
  hint / "Couldn't load saved settings - showing defaults" (see "BUG
  FIX" above), auto-clearing after 2s.
- All reads/writes guarded behind a `hasStorage` check so the popup
  degrades gracefully rather than throwing if `chrome.storage` isn't
  present.
- **The popup is correct-by-default synchronously, before any storage
  read completes** (see "BUG FIX" above): `popup.html`'s toggles/radio
  ship with their real defaults already `checked`, and `popup.js` calls
  `renderDefaultsSynchronously()` - populating the default word list and
  masked view - as the very first thing `load()` does, strictly before
  `chrome.storage.sync.get()` is invoked. The async storage callback
  only ever *reconciles* to the user's real saved settings if they
  differ, and on a storage error leaves the already-correct default UI
  alone rather than blanking it.

## Default list & known collisions

`DEFAULT_WORDLIST` is a curated, alphabetized, ~123-entry array covering
strong swears and compounds not already caught by suffix stemming
(`shitstain`, `motherfucker`, `dumbfuck`, `fuckwit`, etc. - plain
derivative forms like `"fucking"`/`"fucker"`/`"damned"` don't need
separate entries since stemming already reduces them to their root),
crude anatomical/sexual slang, a moderate set of commonly-filtered
slurs, and a religious-exclamation set (`"oh my god"`, `"oh god"`,
`"god damn"`, `"goddamn"`, `"jesus christ"`) added per explicit request.
Users who don't want any category (religious exclamations included) can
delete those lines from the now fully-editable list.

**Deliberately excluded** to avoid the stemming pipeline deriving an
innocent short root: `"tosser"` (would derive `"toss"` via `-er`
stripping), `"beaner"` (would derive `"bean"`), `"cracker"` (would
derive `"crack"`, plus a strong standalone food-item collision). These
are exactly the kind of "innocent-word collision" the coordinator asked
to guard against - they're bugs in the derivation, not intentional
entries, so they're just left out.

**Accepted collisions, kept anyway** (over-censoring beats
under-censoring for this product, per explicit product direction):
`"ass"`, `"hell"`, `"screw"`, `"tit"`/`"tits"`, `"boob"`/`"boobs"`,
`"chink"` (also "a narrow opening"), `"dyke"` (also an embankment/levee),
`"tranny"` (also car-transmission slang), `"retard"` (also "to slow"),
`"cum"`/`"cumming"` (also Latin "with" in academic phrases / a place
name). These are exact whole-word entries; matching is always
whole-token (after stemming), never substring, so e.g. `"raccoon"` is
never flagged by the (deliberately excluded) slur `"coon"` and
`"container"` is never flagged by anything ending in `-er`.

The Node test suite's "no false positive" block (see below) locks in 60+
common English words - including every `-in`/`-ain` word class the new
dropped-g heuristic could plausibly over-trigger on (`"rain"`,
`"captain"`, `"cousin"`, `"beginning"`, etc.) - as a regression guard.

### ASR-mishear / euphemism additions (2026-08-30)

Prompted by a real user report: Whisper transcribed a mild religious
exclamation as a euphemism variant, and it went un-censored because
that variant wasn't in the list. Added a small curated set of common
ASR-mishear/euphemism forms: `"gosh"`, `"oh my gosh"`, `"freaking"`,
`"frickin"`, `"fricking"`, `"friggin"`, `"effing"`, `"dang"`, `"heck"`
(9 entries; `"oh my gosh"` is a phrase, the rest are single words).

**`"shoot"` was deliberately NOT added**, per the same "innocent-word
collision" standard already applied elsewhere in this list: it's an
extremely common verb in totally unrelated, frequent contexts (sports,
photography/video production, gaming, "shoot for the stars," etc.) -
far higher and far more mainstream collision exposure than any of the
9 entries actually added, all of which are near-exclusively used as
the mild exclamation/euphemism they're meant to catch. This is a
judgment call, not a mechanical rule; document it here rather than
silently drop the suggestion.

**Documented, ACCEPTED collision (explicitly signed off on, not a
bug):** `"freaking"` naturally stems via the ordinary `-ing` suffix
rule (same mechanism as every other `-ing` entry in this list) down to
a 5-letter root that also stands alone in phrases like "a freak
accident" or "circus freak." Per explicit product direction
(over-censoring beats under-censoring), the bare root word is expected
to be flagged too, and this is locked in by a dedicated regression test
rather than treated as something to fix.

### Collision scan (2026-08-30)

Ran a full collision scan - `PMWordlistCore.isProfaneCore()` against
every entry in `/usr/share/dict/words` (235,974 words) - as a general
quality pass triggered by adding the euphemism set above. Script:
session scratchpad, `collision_scan.js`; full word-level results
(word + which stem it matched): session scratchpad,
`collision_scan_results.txt` (not reproduced here - see "no
enumerating word-list contents in prose" note below).

**Before any fix: 103 distinct dictionary words flagged.** The large
majority were expected true positives (the list entries themselves,
or close derivatives like plurals/`-ing`/`-ed`/`-y` forms of an
intentionally-profane root - e.g. a mild-profanity entry's own
adjective form, or a slur entry's plural) or already-documented
accepted collisions from earlier in this file (the "Accepted
collisions, kept anyway" paragraph above already covers several
entries whose derivatives also showed up here - a common word for a
narrow opening, a hardware-tool verb, a laboratory/medical term, a
feline nickname, a construction-chemistry term - all pre-existing,
out of today's scope, and consistent with the already-stated
over-censoring-is-acceptable philosophy).

**Ten were genuine, high-severity false positives** - extremely
common, zero-ambiguity English words with no real profane
double-meaning, several with obvious everyday-content risk (cooking
videos in particular). Fixed via a new `SAFE_WORDS` short-circuit set
in `shared/wordlist.js`, checked in `isProfaneCore` BEFORE any
stem-set lookup - these exact words always resolve to "not profane"
regardless of word-list contents, because the collision is a stemming
*artifact*, not a deliberate word-list choice:

- A common word for the bodily fluid, plus its adjective form (strips
  via a mild-profanity entry's own `-y`-suffix-stripped root).
- A common word for a stroller/faulty-software ("buggy"), which
  strips via a different entry's `-er`-stripped root plus `-y`.
- The cooking spice "cumin" (a real recipe-content risk), which
  strips via the dropped-g heuristic to a 3-letter slang entry.
- Four cooking-content words - the adjective form of "spicy" plus its
  `-ed`/`-er`/`-ing` variants - which strip via a slur entry's
  4-letter root. This one is a plausible frequent-occurrence bug (any
  cooking/food video describing food as spicy) and was the highest
  real-world-severity find of the scan.
- A common word for a hazard/risk ("danger", singular; found and fixed
  before the full-dictionary scan, via manual review of the new
  additions - the scan confirmed it no longer appears).

**Rerunning the scan after the fix: 95 distinct words remain flagged**
- all reviewed and are either exact list entries, close/plural/`-ing`
derivatives of an intentionally-profane root, or already covered by
the "Accepted collisions" paragraph above (over-censoring some
niche/technical/archaic vocabulary is an accepted tradeoff for this
product; none of the remaining 95 are as common or as likely to appear
in ordinary YouTube captions as the 10 that were fixed).

`SAFE_WORDS` is intentionally small and will stay that way - it's a
targeted override for verified, high-severity collisions, not a
general-purpose dictionary. Add to it only when a real collision like
this is found and confirmed (e.g. via `collision_scan.js`).

## Test results

Pure matching logic (`PMWordlistCore`) is unit tested under Node with
zero dependencies, since it has no `chrome.*` requirement. Test file:
`wordlist_test.js` (kept in the session scratchpad, not committed to
this repo - see "Re-running the tests" below for the exact command).
A second file, `wordlist_integration_test.js`, stubs `chrome.storage`
to exercise the real (non-pure) `refresh()`/`onChanged` code path. A
third, `collision_scan.js` (see "Collision scan" above), is a one-off
audit tool (not part of the regular pass/fail suite) that scans
`/usr/share/dict/words` for false-positive collisions and writes full
results to `collision_scan_results.txt` - both in the session
scratchpad.

Run with `node wordlist_test.js`. Result: **234/234 passed**, covering:

- Base word match, suffix stemming (`s`/`ed`/`ing`/`er`/`y`),
  case-insensitivity + punctuation stripping, non-matches.
- `censorText` output format, non-matching sentences untouched, trailing
  punctuation preserved, `"[ __ ]"` placeholder handling, multi-word
  phrase support (custom list).
- **Wildcard matching**: aligned (`"sh*t"`, `"f***ing"`, `"f**k"`,
  `"b****"`), first-letter-only shorthand (`"f***"`, `"a**"`, `"s***"`),
  first-letter-only negatives with no candidate letter (`"q***"`,
  `"z**"`), full-sentence re-censoring of an already-partial token.
- **Dropped-g / apostrophe**: `"fuckin"`, `"fuckin'"`, `"Fuckin'!"`
  (case + punctuation combined), `"pissin"`.
- **Collision guardrails**: 60 common English words - including the
  full `-in`/`-ain` family the dropped-g heuristic touches
  (`"rain"`...`"cousin"`) - asserted NOT profane; `"oh my goodness"`
  sentence asserted byte-for-byte unchanged.
- **`findMatches`**: single-word hit, 3-token phrase (`"oh my god"`),
  case/punctuation-tolerant phrase match, phrase at the start of the
  window, phrase at the end of the window, negative near-miss
  (`"oh my goodness"` vs `"oh my god"`), mixed single-word + phrase hit
  in one sequence, wildcard token via the single-token fallback path,
  empty input, no-match input.
- `DEFAULT_WORDLIST` sanity: no duplicates, alphabetized, contains the
  new religious-exclamation entries.
- **`resolveSettingsFromStorage` defaulting regression** (see "CRITICAL
  BUG FIX" above): `STORAGE_KEYS` is array-shaped and covers all 6
  keys; empty storage (`{}`) and `undefined` input both default
  everything without throwing; a saved custom wordlist
  (`["college", "connected", "dots"]` - the exact reported bug
  scenario) is used verbatim; a saved empty wordlist (`[]`) is honored
  as empty rather than defaulted; explicit `false` booleans are
  respected, not coerced to `true`; a corrupted non-array
  `pm_wordlist` falls back to `DEFAULT_WORDLIST` instead of crashing
  downstream.
- **`pm_catchupMode` defaulting**: `CATCHUP_MODES` is exactly
  `["mute", "pause", "play"]` and `DEFAULT_CATCHUP_MODE` is `"mute"`;
  explicit `"mute"`/`"pause"`/`"play"` are all respected as-is; unset,
  `null`, a numeric value, and a mistyped string (`"paws"`) all fall
  back to `"mute"`.
- **Safe mode + catch-up mode merge**: `safeMode` in the resolved shape
  is DERIVED (`catchupMode !== "play"`) - verified for all three
  `catchupMode` values, and verified that a stale/contradictory
  `pm_safeMode` is ignored once `pm_catchupMode` is explicitly saved.
- **`pm_safeMode` -> `pm_catchupMode` migration**: a saved legacy
  `pm_safeMode: false` with no saved `pm_catchupMode` resolves to
  `catchupMode: "play"` (full resolved shape checked, including the
  consistent derived `safeMode: false`); a saved legacy
  `pm_safeMode: true` (the old default) does NOT migrate, resolving to
  `"mute"` same as a fresh install with nothing saved at all; an
  explicitly saved `pm_catchupMode` (`"mute"` or `"pause"`) overrides
  the legacy migration permanently, even in the presence of
  `pm_safeMode: false`; an invalid/corrupted `pm_catchupMode` does NOT
  count as "explicitly saved" for override purposes - migration still
  applies underneath it.
- **`pm_debugOverlay` defaulting**: defaults to `false` (unlike every
  other boolean, which defaults to `true`) on both `{}` and `undefined`
  input; explicit `true`/`false` are both respected; non-boolean/
  corrupted values (`"true"` the string, `1` the number) are treated as
  `false`, not coerced truthy; full resolved shape checked with
  `pm_debugOverlay: true` and everything else default.
- **ASR-mishear / euphemism additions**: all 9 new entries present in
  `DEFAULT_WORDLIST`; `"shoot"` confirmed absent (deliberate exclusion);
  each new entry (plus its natural stemmed/dropped-g/apostrophe forms)
  positively matches; the `"oh my gosh"` phrase is recognized via
  `findMatches` (including the expected, documented single-word overlap
  on its last word, which is also its own standalone entry); the
  accepted `"freaking"` -> bare-root collision is locked in as an
  explicit, intentional assertion, not left as an implicit side effect.
- **`SAFE_WORDS` collision-scan fixes** (see "Collision scan" above):
  all 10 previously-flagged words (a common bodily-fluid word + its
  adjective form, a stroller/faulty-code word, a cooking spice, and
  four spicy-food-adjective forms, plus the earlier `"danger"`/
  `"dangers"` fix) individually confirmed to resolve to "not profane"
  now, added to the same collision-guardrail block as the existing 60+
  common-word regression list.
- **`pm_showStatus` defaulting**: defaults to `true` (like most other
  booleans, unlike `pm_debugOverlay`) on both `{}` and `undefined`
  input; explicit `true`/`false` are both respected; non-boolean/
  corrupted values (`"false"` the string, `0` the number) are treated
  as `true` (not `=== false`), consistent with the other true-default
  booleans; full resolved shape checked with `pm_showStatus: false` and
  everything else default; `STORAGE_KEYS` includes `pm_showStatus`.
- **`pm_strictness` grouping + mode selection + migration** (see
  "FEATURE: pm_strictness" above for the full narrative):
  `STRICTNESS_MODES` is exactly `["standard", "strict", "custom"]`,
  `DEFAULT_STRICTNESS` is `"strict"`; `CORE_WORDLIST.length +
  EXTENDED_WORDLIST.length === DEFAULT_WORDLIST.length` with no overlap
  and no leftovers (checked via a dedup'd-union size check too); spot
  checks that specific entries land in the expected group; explicit
  `"standard"`/`"strict"`/`"custom"` each select the correct word list;
  **both directions of "explicit mode beats implicit override"**
  verified (`"standard"`/`"strict"` ignore a saved custom list;
  `"custom"` ignores the built-ins); a saved empty custom list stays
  honored as empty; an explicit `"custom"` with no saved list at all
  falls back to `DEFAULT_WORDLIST`; invalid/corrupted `pm_strictness`
  values fall through to the migration rule rather than crashing or
  defaulting incorrectly; migration cases (no saved list -> `"strict"`,
  a saved list (even empty) with no `pm_strictness` -> `"custom"`, an
  explicit `pm_strictness` overriding the migration rule permanently).
- **`pm_padding` defaulting**: `PADDING_MODES` is exactly `["tight",
  "normal", "wide"]`, `DEFAULT_PADDING` is `"normal"`; explicit
  `"tight"`/`"normal"`/`"wide"` are all respected; invalid/`null` values
  fall back to `"normal"`; full resolved shape checked with
  `pm_padding: "wide"`; `STORAGE_KEYS` includes `pm_strictness` and
  `pm_padding`.

```
$ node wordlist_test.js
... (234 lines of PASS) ...
234 passed, 0 failed
```

Run with `node wordlist_integration_test.js`. Result: **33/33 passed**,
covering, against the real `refresh()`/`PMWordlist.*` code path (not
just the extracted pure function), via a fake `chrome.storage.sync`
whose `get()` *throws* if ever called with anything other than the
array form:

- The exact reported bug scenario: a saved custom wordlist
  (`["college", "connected", "dots"]`) is loaded into
  `PMWordlist._state.wordlist` and `PMWordlist.isProfane("college")`
  becomes `true`, while `"fuck"` (a `DEFAULT_WORDLIST`-only entry) is
  no longer flagged, confirming the custom list fully replaced the
  defaults rather than being silently ignored.
- `PMWordlist.settings` has exactly the 9 keys the pipeline consumes
  (`Object.keys(...).sort()` === `["catchupMode", "censorCaptions",
  "debugOverlay", "enabled", "muteAudio", "padding", "safeMode",
  "showStatus", "strictness"]`) with correct default values for the
  keys left unsaved in the fake store (`muteAudio`/`censorCaptions` ->
  `true`, `catchupMode` -> `"mute"`, `debugOverlay` -> `false`,
  `showStatus` -> `true`, `padding` -> `"normal"`) - `strictness`
  resolves to `"custom"` here specifically because the fake store's
  initial `pm_wordlist` (the pre-existing `["college","connected","dots"]`
  fixture) has no `pm_strictness` saved alongside it, triggering the
  migration rule.
- A second `refresh()` after the fake store is updated (empty wordlist
  saved, `pm_muteAudio` flipped to `false`, `pm_catchupMode` set to
  `"pause"`) correctly reflects all three changes: the empty list is
  honored (nothing flagged as profane), `PMWordlist.settings.muteAudio`
  becomes `false`, and `PMWordlist.settings.catchupMode` becomes
  `"pause"`.
- Two further `refresh()` cycles toggle `pm_debugOverlay` to `true` then
  back to `false` in the fake store, confirming
  `PMWordlist.settings.debugOverlay` tracks it live both directions,
  and that `PMWordlist.settings` still has exactly its 9 keys after
  repeated refreshes (no accidental key drift).
- A third `refresh()` with a corrupted `pm_catchupMode` (`"paws"`, a
  typo) confirms `PMWordlist.settings.catchupMode` falls back to
  `"mute"` rather than propagating the bad value.
- **Migration, end to end**: with `pm_catchupMode` deleted from the
  fake store and `pm_safeMode` set to `false` (simulating a pre-merge
  install), `refresh()` resolves `PMWordlist.settings.catchupMode` to
  `"play"` and the derived `PMWordlist.settings.safeMode` to `false`.
  Then, simulating the user picking "Pause video" in the new radio
  group (which never touches `pm_safeMode`), a further `refresh()`
  after saving `pm_catchupMode: "pause"` confirms the explicit choice
  permanently overrides the migration - `catchupMode` becomes `"pause"`
  and derived `safeMode` becomes `true`, correctly ignoring the stale
  `pm_safeMode: false` left behind in storage forever after.
- **`pm_debugOverlay`, end to end**: after saving `pm_debugOverlay: true`
  in the fake store, `refresh()` reflects it in
  `PMWordlist.settings.debugOverlay`; saving `false` again and
  refreshing once more confirms it tracks back down too.
- **`pm_showStatus`, end to end**: after saving `pm_showStatus: false`
  in the fake store, `refresh()` reflects it in
  `PMWordlist.settings.showStatus`, and `PMWordlist.settings` still has
  exactly its 9 keys (no drift); saving `true` again and refreshing
  once more confirms it tracks back up too.
- **`pm_padding`, end to end**: `refresh()` cycles through `"wide"` ->
  `"tight"` -> an invalid `"bogus"` value (falls back to `"normal"`),
  each reflected live in `PMWordlist.settings.padding`.
- **`pm_strictness`, end to end** (the most involved scenario in this
  suite): starting from the prior step's state (`pm_wordlist: []`, no
  `pm_strictness` saved -> migrated to `"custom"`), explicitly saving
  `pm_strictness: "standard"` alongside a NEW custom list
  (`["totally", "custom", "words"]`) confirms `_state.wordlist` becomes
  exactly `CORE_WORDLIST` and that list's entries do NOT match - the
  saved custom list is completely ignored while `"standard"`. Switching
  to `"strict"` (list still untouched in storage) confirms
  `_state.wordlist` becomes the full `DEFAULT_WORDLIST`, still ignoring
  it. Switching to `"custom"` (again, no new write to `pm_wordlist` -
  it was sitting there, ignored, the whole time) confirms
  `_state.wordlist` immediately becomes exactly that custom list again
  and its entries DO match - proving the "preserved but ignored, then
  instantly recovered" contract end to end, not just in the pure
  function.

```
$ node wordlist_integration_test.js
... (33 lines of PASS) ...
33 passed, 0 failed
```

### Re-running the tests

```js
// save as wordlist_test.js anywhere and run `node wordlist_test.js`
var { PMWordlistCore, DEFAULT_WORDLIST } = require(
  "~/profanity-muter/extension/shared/wordlist.js"
);
// ... assertions against PMWordlistCore.isProfaneCore / censorTextCore /
// findMatchesCore / resolveSettingsFromStorage, see the "Test results"
// list above for exact cases.
```

For the integration test, stub `global.chrome.storage.sync` (`get`/
`set`) and `global.chrome.storage.onChanged.addListener` BEFORE
`require()`-ing `wordlist.js` (module init calls `refresh()`
immediately), then drive `PMWordlist.refresh().then(...)` - see
`wordlist_integration_test.js` in the session scratchpad for the full
fake-storage implementation.

`shared/wordlist.js` exports `{ PMWordlistCore, DEFAULT_WORDLIST }` via
`module.exports` whenever `module` exists (i.e. under Node), while still
attaching `globalThis.PMWordlist` in the browser - the same file works
in both places unmodified.

## Smoke-testing `captions.js` (manual, once the extension is loadable)

This can't be verified headlessly here since it depends on the real
`manifest.json` (which content scripts load in what order/world) and
live YouTube caption DOM. Steps to smoke-test:

1. `chrome://extensions` -> enable Developer Mode -> "Load unpacked" ->
   select `~/Desktop/profanity-muter/extension`.
2. Open a YouTube video known to have profanity in its captions (auto
   or manual, ideally auto-generated so some `"[ __ ]"` bleeps and
   partially-obscured tokens show up). Turn on captions (CC button).
3. Confirm profane words in the on-screen caption bar render as
   `x***`-style tokens instead of the original word, that `"[ __ ]"`
   shows as `"[ *** ]"`, and that any already-partial token Whisper
   emits (e.g. `"sh*t"`) renders as the canonical `"s***"` rather than
   leaking the original letters.
4. Open the transcript panel and confirm the same rows are censored
   there too, including as more rows load while scrolling.
5. Open the extension popup. Confirm the word-list section shows the
   masked view by default (asterisk lines, not real words); click
   "Show words to edit" and confirm the real list appears (should be
   the full ~114-entry default list, including the religious-exclamation
   phrases, if `pm_wordlist` was never saved before). Click "Restore
   defaults" and confirm the textarea repopulates.
6. Flip **Censor captions** off (leave **Mute audio** on). Confirm
   caption/transcript text shows the real, uncensored words on the next
   render while audio muting (owned by the other agent) still behaves
   per its own toggle - this is the intended "verify audio muting
   against what's actually said" workflow. Flip it back on.
7. Flip **Enabled** off entirely; confirm captions stop being censored
   regardless of the other two toggles. Flip back on.
8. Edit the custom word list in the popup (unmask, add e.g. `"banana"`),
   Save, and confirm a caption/transcript line containing "banana"
   becomes `"b*****"` without reloading the page.
9. Open DevTools console on the watch page and confirm no errors are
   thrown by `captions.js` or `wordlist.js`, and that the observer isn't
   thrashing (a temporary `console.count` in the censor pass should show
   a bounded number of calls per caption update, not an unbounded loop).
10. Sanity-check isolation: this script only ever reads/writes
    `.textContent` on caption/transcript nodes it selects; it does not
    touch `manifest.json`, `capture.js`, `content.js`, `background.js`,
    `offscreen*`/`dist/*`, or `verify/`.

## Contract for the audio-pipeline agent (`content.js`)

- `PMWordlist.findMatches(tokens)` - pass an array of transcribed words
  in order; get back `[{index, length}]` covering both single profane
  words and multi-word phrases (e.g. `"oh my god"`), respecting
  `pm_enabled`. As of `pm_strictness` (2026-08-30), this is ALREADY
  strictness-aware transparently - `findMatches`/`isProfane`/
  `censorText` all match against whichever word list is currently
  ACTIVE (`CORE_WORDLIST` / `DEFAULT_WORDLIST` / the user's custom
  list, per `pm_strictness`), rebuilt automatically on every
  `refresh()`. You don't need to read `pm_strictness` yourself unless
  you want to display which mode is active somewhere.
- `PMWordlist.settings.muteAudio` - live boolean, `true` by default,
  reflects the popup's "Mute audio" toggle; kept fresh automatically
  (same object `refresh()`/`onChanged` update, no separate listener
  needed on your end).
- `PMWordlist.settings.catchupMode` - live `"mute" | "pause" | "play"`,
  `"mute"` by default, reflects the popup's "While catching up" radio
  group (three options: Mute audio / Pause video / Let it play). THIS IS
  NOW THE ONE SETTING for catch-up behavior - the popup's old separate
  Safe mode toggle is gone and `pm_safeMode` is no longer written at
  all. `"mute"` = mute audio in unanalyzed parts; `"pause"` = pause
  playback outright (full protection, nothing unanalyzed ever plays);
  `"play"` = let it play unanalyzed (this is the old "safe mode off").
  Always exactly one of these three strings - any invalid/corrupted
  stored value is normalized to `"mute"` before you ever see it
  (a legacy `pm_safeMode: false` with no saved `pm_catchupMode` is
  transparently migrated to `"play"` - see "Safe mode + catch-up mode
  merge" above - so you never need to read `pm_safeMode` yourself).
- `PMWordlist.settings.safeMode` - still available, still a boolean,
  **unchanged contract** - but now DERIVED as `catchupMode !== "play"`
  rather than read independently from storage. If your existing code
  reads `PMWordlist.settings.safeMode` to decide "should catch-up
  protection apply at all", it keeps working exactly as before with
  zero changes needed. If you want to distinguish *how* it applies
  (mute vs. pause), read `PMWordlist.settings.catchupMode` instead.
- `PMWordlist.settings.debugOverlay` - live boolean, `false` by default
  (the popup's new "Debugging" section, "Show debug overlay" toggle).
  This is the ONLY setting for the on-player diagnostic overlay - this
  file (`shared/wordlist.js`) does not render anything itself; you own
  building and showing/hiding the overlay UI on the YouTube player
  entirely, keyed off this boolean. Kept fresh automatically, same as
  every other field on this object.
- `PMWordlist.settings.showStatus` - live boolean, `true` by default
  (the popup's "Show status on player" toggle, new 2026-08-30). This is
  the ONE setting for whether your on-player status pill should render
  at all - distinct from `debugOverlay` (opt-in diagnostic, defaults
  false): `showStatus` is the lightweight, on-by-default status
  indicator. This file does not render anything itself; you own
  building/showing/hiding the pill UI, keyed off this boolean. Kept
  fresh automatically, same as every other field on this object.
- `pm_stats` (new, 2026-08-30) - **not** part of `PMWordlist.settings`
  and **not** in `chrome.storage.sync` at all. It lives in
  `chrome.storage.LOCAL` as `{totalMuted: number, videosProtected: number}`,
  written entirely by your side (`content.js`) as the pipeline runs;
  `shared/wordlist.js` never reads or writes it. The popup's STATS
  section reads it directly via `chrome.storage.local.get(["pm_stats"])`
  and live-updates via `chrome.storage.onChanged` filtered to
  `areaName === "local"` - write to it whenever you want the displayed
  totals to update; no signal/event back to you is needed since the
  popup does the listening. The popup's "Reset stats" button writes
  `{totalMuted: 0, videosProtected: 0}` back to the same key - if your
  pipeline code holds an in-memory running total, it should treat a
  `chrome.storage.onChanged` reset-to-zero on `pm_stats` (area
  `"local"`) as authoritative and reset its own counter too, rather
  than immediately overwriting the reset with a stale in-memory value
  on its next write.
- `PMWordlist.settings.padding` - live `"tight" | "normal" | "wide"`,
  `"normal"` by default (the popup's new "Mute padding" radio group,
  2026-08-30). This is the ONE setting for how much surrounding audio
  your mute interval should pad around a matched word - this file only
  stores/validates/exposes it; ALL of the actual interval math
  (tight/normal/wide -> however many ms/frames of padding) is entirely
  your side's responsibility. Always exactly one of these three
  strings - any invalid/corrupted stored value is normalized to
  `"normal"` before you ever see it.
- `PMWordlist.settings.strictness` - live `"standard" | "strict" |
  "custom"`, `"strict"` by default (the popup's new "Strictness" radio
  group, 2026-08-30). You almost certainly don't need to read this
  directly - see the `findMatches` note above, the active word list is
  already applied transparently. It's exposed mainly in case you want
  to show which mode is active somewhere in your own UI (e.g. an
  on-player status pill).
- `PMWordlist.settings.enabled` is also available on the same object if
  useful.
