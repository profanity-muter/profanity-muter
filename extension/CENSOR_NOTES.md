# Censor module notes (wordlist / captions / popup)

Scope owned by this agent: `shared/wordlist.js`, `captions.js`, `popup/`
(`popup.html`, `popup.js`, `popup.css`). The 2026-08-30 `shared/packs/`
language-pack data and the multilingual machinery were REMOVED in 0.1.46
(English-only build); that work now lives in a separate multilingual repo.
See "0.1.46" below.

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

## FEATURE (2026-08-30, REMOVED in 0.1.46): language pack architecture, `pm_multilingual`

The 0.1.25 / 2026-08-30 multilingual work (a `PMWordlist.setLanguage()` pack
loader, on-demand `shared/packs/<lang>.json` files, and the `pm_multilingual`
setting) was REMOVED in 0.1.46. This build filters English speech only, and
the multilingual codebase now lives in a separate repo. See "0.1.46" below.

## 0.1.46: English-only (multilingual removed, split to a separate repo)

0.1.44 bundled all three fp32 models (~707MB): base.en plus the 0.1.25
multilingual pair (a `whisper-tiny` language probe and a `whisper-base`
transcriber). 0.1.46 ships base.en ONLY (~280MB) and removes the multilingual
machinery outright rather than gating it:

- One model. `scripts/model-manifest.mjs` bundles `Xenova/whisper-base.en`
  only; the worker and offscreen `MODEL_IDS` carry that single id.
- The language-detection gate, the model routing, `shared/language.js`, and
  the non-English `shared/packs/*.json` are deleted. `shared/wordlist.js`
  keeps its English matcher; the pack loader and `pm_multilingual` setting
  are gone.
- The popup "Filter other languages" toggle and the active-language note are
  removed; onboarding states plainly that the filter is English only.

The multilingual feature is not gone from the world, just from this repo: it
now lives in a separate multilingual repo seeded from main@0.1.44.

## RELEASE BLOCKER (2026-09-02, 0.1.44): bundle the model weights, no more runtime fetch

> SUPERSEDED by 0.1.46 (see above): this build bundles `base.en` ONLY
> (~280MB). The three-model bundling and the per-language packs described in
> this section were removed with the multilingual feature. The "bundled, not
> fetched, remote hard-off" decision below still stands for `base.en`.

The pre-listing blocker. The Whisper weights were fetched from
huggingface.co at runtime, which MV3 and the Chrome Web Store reject as
remotely-hosted code, breaks the "nothing leaves your device" claim, and
makes transcription depend on a third party's uptime. They are now bundled
into the extension and loaded from disk, with remote loading hard-off.

### What is bundled, and why fp32 is large

Three model repos, the only ones the shipped code can reach:

| local id | repo | role |
|---|---|---|
| `base` | `Xenova/whisper-base.en` | the English default (DEFAULT_MODEL) |
| `lang-detect` | `Xenova/whisper-tiny` | the language-gate probe |
| `multilingual` | `Xenova/whisper-base` | a confirmed non-English switch, paired with the `shared/packs/` wordlists |

`whisper-tiny.en` and `whisper-small.en` sit in `MODEL_IDS` but no UI can
select them (there is no `pm_model` picker), so they are excluded rather
than shipped as dead weight.

**Size, stated plainly, because it is a submission fact.** The code loads
with `dtype: 'fp32'` (the quantized decoder hits an onnxruntime-web
MatMulNBits bug, per the spike notes), and fp32 is four bytes per
parameter. The bundled weights total **~707MB** across the three repos
(base.en 280MB, tiny 147MB, base 280MB), which is roughly four times the
~160MB an int8 estimate would suggest. This is the faithful number:
bundling matches what the extension runs today, and changing the dtype to
shrink the package is a transcription-quality decision, not a bundling one,
and belongs to its own round if install size becomes a listing problem. The
compressed store zip is smaller; the measured figure is in the round
report.

The file set per repo was not guessed. It was recorded by running the exact
`pipeline()` the worker uses against a clean cache and observing which files
landed: `config.json`, `tokenizer.json`, `tokenizer_config.json`,
`generation_config.json`, `preprocessor_config.json`, and the fp32
`onnx/encoder_model.onnx` + `onnx/decoder_model_merged.onnx` (fp32 carries
no dtype suffix).

### How they load

`env.allowLocalModels = true`, `env.allowRemoteModels = false` (hard-off, so
a missing or misnamed file fails loudly in dev instead of silently reaching
the network in production), and `env.localModelPath` set from the worker's
`init` message to `chrome.runtime.getURL('models/')` (getURL is only
available on the main thread, so it is passed in exactly as `wasmPaths`
already was). The local directory mirrors the Hub id, so
`Xenova/whisper-base.en` resolves to `models/Xenova/whisper-base.en/` with
no id remapping. `manifest.json`'s `web_accessible_resources` gains
`models/*`.

The onnxruntime-web WASM runtime was already local: `build.js` copies the
`ort-wasm-simd-threaded.*` files into `dist/` and `env.backends.onnx.wasm
.wasmPaths` points at `getURL('dist/')`. Confirmed, no CDN.

### The build step

Weights are gitignored (`extension/models/`), not committed: 707MB does not
belong in git, and they are reproducible. The build path:

- `npm run fetch-models` downloads them (idempotent), from
  `scripts/model-manifest.mjs`, the single source of truth shared by the
  fetch, the check, and the unit test.
- `npm run package` = fetch + build, the actual ship path.
- `npm run check-models` gates presence and rejects stub/LFS-pointer ONNX
  files.
- `npm run build` alone (JS only) just warns if `models/` is absent, so a
  routine dev build does not force a 707MB download.

The shipped zip must therefore be produced by `npm run package` (or a fetch
followed by build), not a bare git checkout.

### Offline verification

`npm run verify:offline` is the acceptance test, and it makes "no network" a
fact rather than a config flag: it replaces global `fetch` with one that
throws on any http URL, sets the worker's exact env (remote off), and then
loads and transcribes. Result: base.en loads from `models/` and produces a
real transcript ("Well, darn it, I dropped my coffee again..."), with
huggingface.co unreachable.

### Future note

If the ~280MB fp32 install ever becomes a review or install-size problem,
the lever is the dtype, evaluated against the MatMulNBits bug, in a
dedicated round.

## FIX ROUND (2026-09-02, 0.1.43): two numbers that were produced without being computed

Catch-up across four rounds: 35.8s, 25.2s, 15.2s, and this round targets
about 11s. The user asked whether to quote longer or go faster. The answer
was both, and the log split cleanly into one of each.

### The estimator reported zero for work with four seconds left

```
14:22:53.135  "let-finish (cheaper-to-finish) remaining=0ms"
14:22:57.167  that window finished, 4.03 seconds later
```

The policy did the right thing on wrong data. Reconstructing from the
window's own final numbers (wallMs=5518 queueMs=2270 computeMs=3209,
leaving decodeMs=39): it was queued at 51.688 and its compute did not begin
until 53.958. At the moment of the decision it had not touched the worker
at all.

Three errors, all pushing the same way, all making abandoned work look free
to wait for:

1. **It floored at zero.** `max(0, expected - elapsed)` says anything
   already overdue is about to finish. That is backwards. Running past a
   prediction is evidence the prediction was wrong, and the accurate
   reading of "this should have taken 750ms and has taken 1447ms" is "it is
   slower than I thought", never "it is nearly done".
2. **It treated the window as one blob.** A window waits for the mutex,
   then computes. Subtracting queue time from a whole-window prediction
   charged that waiting against work which had not begun. The estimate is
   now per stage, and a still-queued window reports the full compute ahead.
3. **It predicted a cold window from settled throughput.** The field window
   ran at an effective rtf of 2.2 while the session averaged about 0.3,
   because it was the first at a fresh position.

### The case did not need a wager at all

The deeper finding. Because the window was still QUEUED, abandoning it
required no terminate, no respawn and no warm-up. The cost is zero and the
whole remaining time is recovered.

0.1.42 built preemption as a single mechanism, terminate-and-respawn, and
so priced every abandonment as though it required killing the worker. But
there are two situations wearing one name. Dropping queued work for a
position nobody is watching is not a bet, it is tidying up: it skips the
thrash guard and the net-saving margin, because both exist only to price a
respawn. The shared-worker rule still applies, since another tab's queued
window is still not ours to drop.

Cancellation is a token checked at the moment the mutex turn comes up,
which is the last instant before the work becomes expensive. A cancelled
window returns quietly and is explicitly not counted against any error or
hang threshold, because we dropped it on purpose and it is not evidence of
anything failing.

### The cold quote had no arithmetic in it

The badge promised about 8s for a fresh seek that took 15.2s. That breaks
the pessimism rule in exactly the case the rule exists for, and the cause
was that the cold path had no model at all: with nothing measured it fell
to a flat floor, and a floor is not an estimate of anything.

A cold quote is now computed as roughly two windows at warm-up throughput,
which for the field case quotes about 19s against a 15.2s actual, on the
correct side of the truth. The user's description was the countdown hitting
zero and lingering, which reads as broken; falling from a truthful number
and snapping to Protected reads as fast.

Two details that matter more than the formula:

- **One source of truth for warm-up.** The constant lives in
  `shared/preempt.js` and the pill reads it, because the preemption model
  and the quote both depend on how slow a cold pipeline is, and two modules
  disagreeing about that would mean one of them was wrong.
- **Coldness is about the position, not the session.** A seek into an
  unanalyzed region starts from a standing start even ten minutes in.
  Quoting the settled average for it is precisely how 8s got promised for
  15.2s of work.

The monotonic rules are untouched, so the number only ever falls.

### Warm-up: now measurable rather than argued

0.1.42 concluded that early windows are slow because of runtime warm-up and
said so as a hypothesis, because `computeMs` bundles "waiting for the model
to be ready" with "running the model". The worker now reports those
separately, and offscreen logs `[PM-INFER]` for the first three inferences
of each worker instance, then goes quiet.

High `modelResolve` means loading; high `inference` on an already-resolved
model means genuine warm-up. Either way the next paste settles it, and the
cost model is built to be correct under both readings, since it charges for
the observed slowdown regardless of cause. Bounded to three lines per
worker on purpose: this exists to answer a question, not to narrate every
window forever.

### Tests

`preempt_test.js` 20 -> 30: the reconstructed field decision at its real
timings, both estimator errors separately, cold-window estimation, the free
cancellation path including that it ignores the guards while still
respecting the shared-worker rule. `pill_test.js` 43 -> 49: the cold
arithmetic against the field actual, positional coldness, the tightening as
coverage builds, and that both modules read the same warm-up constant.

The 0.1.42 fixtures needed updating rather than fixing: they described an
in-flight window without saying whether it was queued or computing, a
distinction that did not exist until this round. Suite: 406 node checks,
184 browser checks.

## FIX ROUND (2026-09-02, 0.1.42): computing audio nobody is waiting for

0.1.41 fixed run-poisoning, and catch-up after a seek storm improved from
35.8s to 25.2s. The same log then made the next cost obvious:

```
14:11:23.9  URL restore seek to t=25; window [24.00,26.50) enters the worker
14:11:24.8  user seeks to t=1633.93
14:11:32.4  that window finishes (wallMs=8410) and is applied via STALE-KEPT
14:11:32.4  only NOW does the first window at the real position start
```

Seven and a half seconds of a single-threaded worker computing audio for a
position the user had left before it even began.

The generation machinery from 0.1.18 already made the RESULT harmless, and
0.1.34's STALE-KEPT even put it to use. Neither can stop the WORK: a
running WASM call is not interruptible from outside. The only way to take
the thread back is to terminate the worker and spawn a fresh one.

### Preemption is a wager, so both sides get priced

`shared/preempt.js` abandons work only when finishing costs more than
starting over.

**The cost side** charges for spawn plus model load, measured from PM-WARM
or from the last real respawn rather than assumed, AND for the warmup that
follows. The first inferences after a fresh worker run several times slower
than steady state, which the same log shows plainly: rtf around 1.0 to 1.9
on the windows right after a seek against 0.23 once settled. A respawn is
not paid for once, it is paid again on the next window or two, and charging
only for spawn would make preemption look cheaper than it is.

**The remaining-work side** uses WALL-clock throughput, not compute-only.
The field window spent 3647ms of its 8410ms waiting for the worker mutex.
An estimate built from `computeMs` would have put its remaining time at
roughly half the truth and talked itself out of a preemption that was
clearly worth making. Offscreen now keeps a `wallRtf` EWMA alongside the
compute-only `lastKnownRtf`, which still drives window sizing where queue
wait would be the wrong signal.

For the field numbers: about 7.5s remaining against a 3.5s cost, a 4s net
win, comfortably clear of the margin.

### Biased toward letting work finish

The failures are asymmetric. A wrong "let it finish" costs some latency. A
wrong "preempt" costs that latency plus a respawn plus a slow window, and
can repeat. So:

- a **marginal** win is declined, since both sides are estimates and a few
  hundred milliseconds of predicted gain is noise, not a reason;
- an **unmeasurable** case is declined, because no basis for an estimate is
  no basis for a wager;
- a window **still covering** the new playhead is kept;
- a **nearly-finished** compute is kept.

### Three guards beyond the arithmetic

A **settle delay** before evaluating, because a scrub is many seeks and
only the last one is worth acting on. A **minimum interval** between
preemptions, since even settled seeks repeat when someone is working
through a long video; a sequence test asserts that twenty seconds of
seeking cannot turn into twenty respawns. And a rule that we **never
abandon another tab's window**: the worker is shared across the offscreen
document, and terminating it to serve our own seek would cost someone else
work they never agreed to lose.

Respawning rejects every pending request before terminating and rebuilds
the mutex chain. The promise chain only advances when its current call
settles, so a terminated worker with a live pending promise would wedge the
pipeline far worse than the compute being abandoned.

### The slow windows after a seek

Asked as part of this round, answered as far as the evidence allows. The
pattern is consistent across the log: the first windows after a seek run at
rtf near 1.0 to 1.9, then settle to 0.23. The queue delays (up to 2.3s) are
downstream of that, since a slow compute holds the shared mutex and the
next window waits behind it, which is congestion rather than a second
fault.

Window sizing is ruled out: the slow windows are ordinary sizes, and one of
them (2.5s of audio taking 4688ms) is small. Contention from the stale
compute is ruled out for the same reason the queue delays are explained by
it rather than the reverse: the transcribe path is globally serialized, so
there is no parallel work to contend with.

That leaves runtime warm-up (WASM JIT and allocator behaviour on the first
inferences of a model instance) as the consistent explanation, which is
also what makes the warmup penalty in the cost model necessary rather than
decorative. It is not proven: proving it needs per-inference instrumentation
inside the worker, which this round did not add. It is stated as the
working hypothesis, and the cost model is built to be correct either way,
since it charges for the observed slowdown regardless of its cause.

### Tests

`preempt_test.js` (20): the field case preempted with a real margin, every
decline path, the shared-worker rule, the settle and thrash guards
including a twenty-seek sequence, and the estimator's arithmetic. Writing
them caught a wrong assertion of mine about overlap at the protect-span
edge, where the code was right and the test was not. Suite: 390 node
checks, 184 browser checks.

## FIX ROUND (2026-09-02, 0.1.41): the backstop that broke the thing it protected

A user seek-stormed: 25 -> 1495 -> 1596 -> 1566, inside about two seconds.
Three legitimate run boundaries fired for the disjoint regions. The fourth
tripped the 0.1.24 churn cap, which suppressed it and fed audio from 1560
into a demux run anchored around 1590. That run cannot decode audio it was
never given, so window `[1565.73,1572.39)` skipped forever with "no
decodable audio in this run at that time yet". Coverage returned only when
the playhead drifted into a region the run could serve:
`covered at t=1602.00 in 35.81s`, which in play mode is 35.8 seconds of
audible unfiltered video.

### Why the backstop was right in 0.1.24 and wrong now

0.1.24 fixed a genuine catastrophe: `findGrowth` misread ordinary buffer
eviction (YouTube trimming a range's front while extending its tail) as a
disjoint new range on EVERY segment of a long video, firing hundreds of run
boundaries a minute, each superseded before it could transcribe anything.
The real fix was interval set-difference. The rate limiter was
defense-in-depth against that bug class recurring, and its rule was: after
three boundaries in ten seconds, stop opening runs and feed everything into
the existing one. Degraded but alive beat churn death.

That reasoning contains an assumption which was true then and false now:
that a suppressed boundary is a misclassified one. After 0.1.24,
misclassified growth is **contiguous** by construction, because it is the
same range trimmed and extended. A seek jump is **disjoint**. Suppressing a
contiguous boundary costs nothing, since the existing run holds that audio
anyway. Suppressing a disjoint one guarantees audio that can never be
decoded.

So the question was never "how many boundaries recently". It is "can the
existing run serve this". `shared/runs.js` now answers it, and its tests
hold both outages at once, because a fix for either can cause the other:
the trim-and-extend snapshot from the 0.1.24 report must still be
suppressed during a storm, and the 1560-into-1590 case must open a run no
matter how severe the storm is.

Churn protection survives as a cap on runs opened. It simply has one
exception no rate limit may override.

### Retirement had the same shape of bug

Keeping two runs, FIFO, was right when runs arrived one at a time. After a
seek storm the OLDEST run can be exactly the one holding the region the
playhead just came back to, so dropping it recreates the identical outage
from the other direction. Runs are now retired by distance from the
playhead, never the current one and never the one serving the playhead,
with the cap still enforced so a pathological session cannot accumulate
64MiB stream caches without bound.

This needed `run.fedStart`, which did not exist. `fedEnd` could say how far
a run had reached but never where it began, and "where did this run begin"
is precisely the question a seek storm asks.

### A restart that restores something

The 0.1.40 stall detector fired correctly at 15 seconds and requested a
restart. The restart re-ran the picker against the same poisoned mapping,
so it skipped identically: correct detection, toothless response.

Waiting helps a slow pipeline. It can never help a run that does not hold
the audio. The restart now asks first whether any run can serve the
playhead, and if none can, requests a fresh run for that region instead of
re-reading the same wrong map. Only `capture.js` can grant that, since the
cached init bytes live in the MAIN world, so the request travels
offscreen -> background -> content -> capture over the same bridge the
eviction check already uses. The churn cap is explicitly cleared for the
repair: it exists to stop runaway run creation, and this path only fires
when the pipeline is already stalled and producing nothing.

### Topology in the devlog

Suppressions, openings, retirements and rebuild requests are now recorded.
The entire cost of this round was a log that showed a window skipping
forever and nothing about why the mapping was wrong.

### Confirmed working in the same log, preserved

Badge click outcome logging (`outcome=opened-popup`, so 0.1.37's
instrumentation answered the question it was built for), the language gate
holding English through three `already-english` records, `PM-STALE-KEPT`
applying across generation 1 to 4, and the monotonic pill quote presenting
sensibly.

### Tests

`runs_test.js` (20): the disjoint-versus-contiguous matrix including both
field snapshots, rate-limit immunity for disjoint regions, the empty-run
case, append slop tolerance, storm timestamps ageing out, retirement LRU
including "never the run serving the playhead" and "never the current run",
and `runCanServe` as the stall recovery's question. Suite: 370 node checks,
184 browser checks.

## FIX ROUND (2026-09-02, 0.1.40): the decode hang was ours all along

Three releases treated the `sink.buffers()` hang as a mediabunny or
WebCodecs defect on some unaudited container path. 0.1.21 added a stage
timeout to bound it, 0.1.34 added a rebuild ladder, 0.1.35 shortened the
first wait. By 0.1.39 the field log showed roughly every other window
hanging on a six-minute video, 12+ events, each costing 10 to 35 seconds.

It was the timeout. Reading mediabunny's own implementation
(`dist/modules/src/media-sink.js`, `mediaSamplesInRange`):

- Every `buffers()` call constructs its **own** `AudioDecoder`, closed only
  in the `.finally()` of an internal pump task.
- That pump finishes when the range ends naturally, or when the **consumer**
  calls `iterator.return()`, which sets its terminated flags and releases
  the promises it awaits.
- The pump applies backpressure: once its sample queue fills it blocks on a
  promise that only the consumer's `next()` resolves.

Our guard did `await withStageTimeout(loopPromise)` and moved on. The async
loop stayed suspended inside `for await`, so the iterator was never closed,
so the pump parked forever holding a live decoder and a queue of unclosed
`AudioData`. WebCodecs decoders are a finite resource. **Each timeout made
the next decode likelier to stall, which timed out, which leaked another.**
The "every other window" density is a self-amplifying cascade, and the
guard written to bound one failure was manufacturing the next.

Two hypotheses were checked and refuted on the way, both worth recording so
nobody re-runs them. The bounded stream cache is not it: a read of evicted
data **throws** (`_throwDueToCacheMiss`), it does not hang, and a thrown
decode error takes a different, working path. And `_pull()` cannot orphan a
pending slice: every path either fills it, resolves it null at stream end,
or rejects it.

### The fix

An iterator we stop consuming gets closed. `shared/decode.js` owns the
drain, so the caller cannot forget the teardown, because the teardown is
not the caller's job. `test/decode_test.js` reproduces mediabunny's
backpressure and resource semantics with a fake iterator that holds a
"decoder" released only in `return()`, so a regression fails there rather
than in someone's six-minute video.

Recovery got cheaper now that it is not fighting a leak: first attempt 3s
rather than 10s (a decode that will settle settles in well under a second
at these window sizes, so ten seconds was dead time in front of a repair
that takes milliseconds), rebuild on the FIRST hang, advance past the span
on the second. Post-rebuild attempts keep the full 25s, so a genuinely slow
machine is never punished for being slow. Worst case before the pipeline
moves past a doomed span: about 60s down to about 28s.

Skipping still never marks a span covered, so skipped audio stays
unanalyzed and mute/pause catch-up keeps protecting it. Only the picker
stops returning to it.

### The timeline double-decode was downstream

`PM-TIMELINE-ALARM` fired on windows sharing an anchor (three at t0=24.00).
Not an independent bug: a hang leaves the span uncovered, the picker
correctly returns to the same anchor, and the rtf-aware sizing gives the
retry a different length, so two eventual successes overlap and produce
near-duplicate text. Fewer attempts per anchor plus no cascade removes the
cause rather than papering over the symptom.

### The countdown, made monotonic

Same log, separate report: the countdown "goes down, then up, then says
analyzing, then finally protected". Every jump was truthful in isolation,
since each completed window recomputes an estimate and a hang-delayed
window produces a worse one. Truthful in isolation is not trustworthy. A
number that can rise is not a countdown.

- **Monotonic display.** It may fall or hold, never rise. A worse estimate
  stops the descent instead of reversing it, and the existing elapsed rule
  is the escape valve: when the hold outlasts the promise, the label drops
  the number entirely. Only a seek or a video change may raise it, because
  those are new questions rather than revised answers.
- **Quote time-to-Protected, pessimistically.** Throughput is an EWMA over
  **wall** time including hang losses, because a window that took twelve
  seconds while the decoder hung for nine really did deliver its audio at
  that rate. Hang-prone videos now quote slower numbers by themselves. The
  bias is deliberate: finishing early and snapping to Protected reads as
  fast, hitting zero and lingering reads as broken.
- **Jitter gate.** A trivially better quote is flicker, not information.

The monotonicity test drives hostile sequences rather than a happy path,
and caught a real bug in the new ledger: `state.lastTickWall || now` treats
a zero timestamp as missing, disabling the tick whenever the clock reads
exactly 0. Real wall clocks never do, injected test clocks do, and a guard
that only works on real inputs is not a guard.

### Confirmed working in the field, for the record

Muting and matching whenever the language stays English; the health
promise path (one `stalled-analysis` followed by `recovered`); `PM-STALE-KEPT`
applying a window across a generation change instead of recomputing it; and
the 0.1.37 language gate holding English with three `already-english`
records at scores 19.7 to 22.3, which is the gate declining to act exactly
as designed.

### Not us: the reset-to-start on refresh

Investigated and dropped. The user's A/B reproduced it with the extension
disabled, so it is YouTube's own resume behaviour. For the record, the
load-order interaction is real but benign: we do engage pause-catchup at
t=0 roughly a second before YouTube's restore-seek lands, and the pending
fallback rewind is retired correctly when that seek arrives, because a
restore-seek is classified external and a page refresh allocates a fresh
session with no pending rewind. No load-settle machinery was built.

### Tests

`decode_test.js` (14) covers the disposal contract with a fake iterator
matching mediabunny's semantics, plus both ladders. `pill_test.js` grew to
43 with the monotonicity property, the jitter gate, wall-time EWMA
behaviour, and the escape valve. Suite: 349 node checks, 184 browser
checks.

## FIX ROUND (2026-09-02, 0.1.37): a two-letter code, and the protection failure behind it

The user photographed the badge reading "Analyzing ~5s · ko", then
"Protected · ko", on a plainly English video. He asked what "ko" meant.
That question is the whole finding: it disqualified the suffix from the
badge, and following it down found something considerably worse.

### The suffix is gone

A two-letter language code is dev information. The badge is the one surface
a non-technical user reads, and the pill doctrine is already countdown,
Protected, warnings, nothing else. Removed from both label paths (the
collapsed one and the legacy fallback); it remains in the `[PM-LANG]`
traces and the devlog, where it is genuinely useful.

### What the misdetection was actually doing

The log:

```
[PM-LANG] detected=ko score=13.18 model=multilingual
          (switching subsequent windows to the multilingual model)
```

A correct detection on comparable content scored 19.76. So the wrong answer
was acted on at two thirds the confidence of a right one, from a single
probe, permanently for that video.

The reported cost was throughput, and it was real: the multilingual model
pushed computeMs from ~4000 to as high as 13983, and catch-up time from
~6s to 19.07s. In pause-until-ready that is the user sitting through three
times the wait.

But the detected language **also swaps the active word list to that
language's pack**, and that is not a throughput problem. Verified directly
against the shipped `ko.json`, whose 66 entries are Korean:

| word | English pack | after ko switch |
|---|---|---|
| fuck | matches | does not match |
| shit | matches | does not match |
| asshole | matches | does not match |
| bitch | matches | does not match |

On an English video, after a misdetection, the filter silently stopped
filtering, and the badge said Protected while it did. That is the failure
mode this product exists to prevent, reached from one unconfirmed guess.

### The gate

Switching away from English can disable protection. Switching back restores
the safe default. Every rule follows from that asymmetry:

- **Confidence**: a probe below the bar cannot switch, and cannot even
  start a streak, or two weak guesses would add up to a decision neither
  earned. The bar sits between the two observed scores with room on both
  sides.
- **Corroboration**: the same language twice in a row. One probe is one
  opinion about a few seconds of audio, and music, an accent or a quiet
  passage can produce a confident wrong one. This carries most of the
  weight, precisely because two data points is thin calibration for a
  threshold.
- **Recovery**: one confident English observation reverts, at a lower bar
  and with no corroboration required. Before this, a wrong switch held for
  the rest of the video with no way back.
- **Accountability**: every decision, including the holds, goes to the
  devlog with its score and reason. The old line said what happened and
  nothing about why, which is exactly what made the field case
  unexplainable from a paste.

Probing is bounded (it loads a separate model and shares the single worker
thread), and detection failure no longer pins the session to English, so a
genuinely non-English video can still be found by a later probe.

### Badge position

The 56px offset was right while the player chrome is showing and wrong when
it is hidden, where it floated mid-picture attached to nothing. It now
rides up to the corner when the player is idle and glides back down when
the chrome appears, driven by a CSS descendant rule keyed on YouTube's own
`ytp-autohide` class: no polling, no observer, and it tracks the real
player state rather than our guess at it. The DEFAULT is the below-title
offset, so if that class ever disappears the rule never matches and the
badge stays somewhere safe instead of sitting under the title text.

### The click ladder was not broken

The first supplement read three clicks in nineteen seconds as a dead
button; the user confirmed they were deliberate use. The ladder is
unchanged. What it gained is outcome reporting at each rung
(opened-popup / opened-tab / rung-failed with a reason) flowing back into
the content trace, so the next field log distinguishes use from failure
without anyone having to guess. Worth noting as its own lesson: the trace
recorded the request and not the result, and that gap alone cost a round of
speculation.

### Tests

`language_test.js` (17) pins the gate against the real numbers: 13.18 must
not switch and cannot accumulate, 19.76 must be able to, corroboration is
required, disagreeing probes never add up, a weak probe breaks a streak,
reverting is easier than switching but not free, and every decision carries
a reason. `pill_test.js` grew assertions that no presented label can ever
carry a language code, that neither content.js path appends one, and that
the position rule is declarative with the safe default. Suite: 316 node
checks, 184 browser checks.

## FIX ROUND (2026-09-02, 0.1.36): one processing state, and a fallback that stops costing content

Two field traces. The first produced a product verdict rather than a bug
report: the pill should say "processing, with a countdown, then protected",
and instead cycled through four sentences in the first seconds of an
ordinary cold start. The second found the muted-playback fallback quietly
consuming the user's video.

### The pill: a presentation collapse, not a new state machine

Seven routine states had accumulated over fifteen releases. Each was added
to answer a real question, each transition in the trace was correct by its
own rule, and the aggregate was noise. So the INTERNAL states stay (the
logic and the [PM-PILL] traces use the distinctions) and the presentation
collapses to one processing state plus a countdown, then Protected.
`shared/pill.js` owns that mapping, so there is exactly one place where
what the user reads is decided, and it is unit tested.

A countdown is a better citizen than a static estimate because the person
reading it can check it. That cuts both ways, and both failure modes were
live in the trace:

- **Absurd optimism.** "~1s" quoted on a cold seek, from a default rtf
  guess, before anything had been measured. One second is not a plausible
  time to load a model, demux and transcribe, and a countdown that hits
  zero immediately teaches the user to ignore it. The first promise is now
  floored generously until a real rtf exists.
- **Alarm for a normal event.** When the countdown ran out, the old model
  escalated the label to "taking longer than expected", which the trace
  shows firing two seconds into a healthy cold start. Overrunning an
  estimate is ordinary. The label now drops the number and waits, and
  re-arms by itself when the next window completes.

Escalation to an actual warning remains the health monitor's job on its own
much slower wall clock. The pill describes what is happening; only the
health monitor says something is wrong. That separation is the thing that
keeps either surface worth reading.

"Press play to load audio" survives as the one actionable sentence, gated
hard, because it is the only state that asks the user to do something.

### Input uniformity

A 0.1.35 trace logged `capturedAtPlayhead=NA nearestCaptured=none` while
`bufferedRanges=1` held a range containing the playhead: the protected
branch returned before those inputs were computed. A trace that varies by
branch is worse than no trace, because it invites conclusions from fields
that were never evaluated. The full vector is now computed before any
branch reads or reports it, and a source-shape test pins that ordering
rather than the symptom. Traces also record the presented label next to the
internal state, computed before tracing so the two cannot disagree.

### Ownership ping-pong

Three engage/clear cycles in four seconds, each logging "ownership cleared:
external play observed". There was no external play. The extension was
reading its own programmatic resume as the user taking over, dropping
ownership, and re-engaging a moment later, which the user experiences as a
video stuttering between paused and playing.

Self-initiated actions are now timestamped marks rather than one-shot
booleans. The boolean was fragile in exactly the way this needed it not to
be: `play()` settles asynchronously and can fail without firing an event,
after which the stale flag swallows the NEXT event, possibly the genuinely
external one the whole mechanism exists to catch. A mark expires by itself.

A short quiet period after each release stops re-engagement at coverage
edges, where the covered/uncovered answer flickers as the playhead crosses
a boundary. The protection given up is small (the next window is usually
seconds away) and the behaviour removed is one the user reads as the
extension malfunctioning.

### The fallback was costing the user content

The muted-playback fallback exists for a genuine deadlock: pausing stops
YouTube fetching, and audio it buffered before our hook attached can never
be captured passively, so playing is what unblocks it. But the trigger
measured COVERAGE growth alone, and coverage does not move while a window
is being transcribed. A slow first window was therefore indistinguishable
from a dead pipeline.

The trace shows it firing while a window was actively computing and capture
had reached `[0,29)`. Nothing was starved. The user permanently lost the
first 2.44 seconds of the video: spoken words played silently and are gone.

Two fixes. **Starvation now has to be true on every axis at once**: no
window in flight (a heartbeat within ~1.5 cadences means one is), no
capture growth, and audio actually needed at the playhead. And **when it
legitimately fires, the content is no longer lost**: the start of the
silence is recorded, and once coverage catches up over that stretch the
video seeks back, unmutes, and plays it properly.

The rewind is guarded three ways. A user seek supersedes it entirely, since
their navigation outranks recovering audio they chose to skip past. A
sub-threshold stretch is not worth the jolt. And it never rewinds into
audio that is still unanalyzed, which would recover the sound and lose the
protection, the wrong trade in the strictest mode the product offers.

That last point is the principle worth keeping: pause-until-ready is chosen
by people who want nothing unchecked to reach a child's ears, and it has to
be exactly as careful with their content as with their protection. You may
wait, but you eventually hear every analyzed second.

### One badge, top-left, clickable (addendum)

The consolidation the presentation collapse implied but did not finish.
Four surfaces were being injected into the player: the status pill
(bottom-right), a one-off notice banner (top-center), an "Analyzing audio"
overlay (top-left), and the dev overlay. Three more places than a user
should have to look to learn one thing, and two of them said what the badge
already said.

Now there is one badge. All states share it, and only its content and tone
change: the countdown, Protected, the milestone moment, warnings, and the
one-off notices for Shorts, livestreams and protected content, which take
the badge for a few seconds and then revert. The "Analyzing audio" overlay
is gone entirely, since the badge's own processing state covers every
moment it appeared. The dev overlay stays separate, correctly, because it
is dev-only and off by default, but it is anchored directly beneath the
badge so the two can never overlap.

**Position**: top-left, offset 56px down. At the obvious 8px the badge sits
underneath the title gradient YouTube fades in across the top of the player
on mouse-over, which is exactly where it started life and why it had to
move.

**Clickable**: `cursor:pointer`, a brightness hover, `role="button"`,
`tabindex="0"`, Enter and Space, and `aria-label="Profanity Muter - open
settings"`. The click is stopped from reaching the player underneath, which
would otherwise pause the video as a side effect of asking for settings.

`pointer-events:auto` appears on the badge and nowhere else in the routine
path. That constraint is worth stating plainly: a filter that ate clicks on
the video it is filtering would be a worse bug than the missing affordance
this fixed. A source-shape test pins it, allowing exactly one deliberate
exception, the dev overlay's Copy logs button, which is gated behind
`pm_debugOverlay` and needs a real gesture for clipboard access anyway.

**The click ladder** lives in `shared/pill.js` so its ordering is testable,
and executes in the service worker. `chrome.action.openPopup()` first,
because it opens the actual toolbar popup and that is what was asked for;
it needs a user gesture (this click is one) and has shipped and unshipped
across Chrome versions, so it is attempted rather than relied on. The popup
page in a tab is the fallback, and the browser harness now asserts that
page survives tab width rather than assuming it: it stays a narrow column
with no horizontal overflow and its controls intact. The setup guide is the
last resort.

The one surface deliberately NOT folded in is the context-invalidated
banner, which fires only when the extension has been reloaded under a live
page. That is precisely the state where the badge cannot do its job:
`chrome.runtime` is gone, so a click could not open anything, and a badge
inviting a click it cannot honour is worse than a plain sentence saying
refresh.

**Copy**: the completion page's pin request no longer implies pinning is
the only route to settings, since it is now demonstrably not. It reads "Pin
for one-click access" and says the badge on the video always works. The pin
request itself stays.

### Tests

`pill_test.js` (23) covers the collapse, the countdown, both floors, and
the source-shape guard for input uniformity. `catchup_test.js` (24) covers
self-action tagging including expiry, ownership in both directions, the
debounce, the fallback trigger-gating matrix, and the rewind path including
user-supersede, sub-threshold, and the not-yet-covered wait. Suite: 299 node checks,
184 browser checks.

## FIX ROUND (2026-09-02, 0.1.35): the pill was right, the session was not

The 0.1.34 pill fixes did not stop the field reports, and the second
re-test made the reason unmistakable: the pill was showing states that were
impossible on fresh inputs. "Press play to load audio" while PAUSED with
captured audio at the playhead, and "Analyzing" with 28 seconds of coverage
ahead of the playhead when the margin is 5. Two rounds had been spent
improving a state machine that was already correct.

### The actual bug

`content.js` keyed its per-video session on videoId, and the audio relay
contained this:

```js
if (!session || session.videoId !== data.videoId) {
  session = newSession(data.videoId);
}
```

A segment is data about audio. It arrives asynchronously, in a stream, from
a MAIN-world script with its own view of which video is playing. One late
segment carrying the PREVIOUS video's id, landing just after a video-change
reset, therefore replaced the live session with an empty one bound to the
old video. Coverage, the mute schedule and the captured-range bookkeeping
all went in a single assignment. Worse, every subsequent transcription
result for the CURRENT video was then dropped by `addWords`' own
`session.videoId !== videoId` guard, so none of it could be rebuilt.

Both symptoms are the same fact seen twice: no `bufferedRanges` means
nothing captured at the playhead ("Press play"), and no `coveredIntervals`
means nothing analyzed ("Analyzing"). The pill was reporting an empty
session accurately, while the console showed the pipeline producing
coverage for a session nothing was reading any more. It also explains the
pause-catchup churn in the log (three engages, two ownership-cleared): each
wipe made the playhead uncovered again.

This was never a display bug. It was a filter that had silently stopped
filtering, wearing a display bug as a disguise, and it survived two rounds
because the symptom looked cosmetic.

**The rule**: navigation redefines which video the tab is on, and
`capture.js` sends an explicit reset for that. A segment never does. The
one exception is a missed reset, which would otherwise mean ignoring
segments forever, so a short run of segments for the same unexpected id is
adopted as the reset we never received. Alternating ids never accumulate
toward that, because alternation means confusion rather than navigation and
adopting either would be a coin flip on which video is being filtered.

Extracted to `shared/session_binding.js` as a pure function with its own
test file, deliberately: a four-line conditional in a message handler is
exactly the shape of thing that hides a protection failure, and this one
did, for two releases.

### Tracing, so the next one is not deduced

Every pill state CHANGE (not every tick, which would drown the log) now
emits `[PM-PILL]` with the whole input vector: playhead, paused,
captured-at-playhead plus nearest captured range, coverage end near the
playhead, uncovered-within-margin, growth recency, the promise ledger, and
the session identity. Gated on `pm_debugOverlay` and routed through `TLOG`
so it lands in the ring buffer that "Copy logs" pastes, meaning a single
paste reconstructs the pill's history.

Sessions carry an `instanceId` for the same reason. The bug this round was
two code paths holding different session objects, where every individual
value looks plausible and only the identity is wrong. That is invisible in
a log full of numbers and obvious in a log that prints which object
produced them.

### Hang timeout: 10s on the first attempt

25s was chosen when a timeout meant "give up on this window", so it had to
be generous enough never to punish a slow machine. Since 0.1.34 the second
attempt rebuilds the decode pipeline, which is cheap and is the repair most
likely to clear a wedged decoder, so waiting 25 seconds before trying it
was pure dead time. First attempts now wait 10s; post-rebuild attempts keep
the full 25s, so slowness is still never punished. Worst case before
anything changes drops from about 50s to about 35s.

### Tests

`session_binding_test.js` (12) pins the rule: late segments ignored,
matching traffic clearing a stale run, the missed-reset backstop firing
after a consecutive run, alternating ids never accumulating, and junk input
never producing a rebind. Suite: 252 node checks, 181 browser checks.

## FIX ROUND (2026-09-02, 0.1.34): what the first field test found

Two devlogs from a real machine, and every item below is a defect they
show rather than something anticipated. Worth recording as a group,
because the theme connecting them is one thing: the extension was telling
the user it was working while it was not.

### A. Offscreen lifecycle

**Two TypeErrors were never decode failures.** `closeRun()` nulls a run's
`track`/`sink`/`input`, and an in-flight `transcribeWindow` still holds
that same run object across its awaits. Reading a nulled field afterwards
produced "Cannot read properties of null (reading 'getPrimaryAudioTrack')"
and the same crash again in `sink.buffers` shape. Runs are now flagged
closed before teardown, `transcribeWindow` checks at every await boundary,
and an abort returns quietly **without touching the hang/error counters**.
That last part matters more than the crash: those counters lead to
`markUnanalyzable`, so a bookkeeping race could have switched protection
off for a video that was perfectly decodable.

**The decode hang repeated an identical doomed request.** The log shows the
same window timing out at 25s twice, and the old ladder would have done it
four more times: 150 seconds of a wedged decoder producing nothing while
the pill promised results. Repeating an identical operation is not a retry
strategy. Hangs now escalate: attempt 2 rebuilds the run's decode pipeline
(a wedged `AudioBufferSink` generator is exactly the shape of failure a
rebuild clears, and it is cheap), attempt 3 gives up on that SPAN and
advances. Skipped spans go into `s.skippedSpans`, which is excluded from
**picking only** and never added to `s.covered`, because coverage means
"analyzed" and claiming it for audio we failed to decode would silently
unmute it under mute/pause catch-up. The user stays protected; the pipeline
stops beating its head against one span. `HANG_THRESHOLD` remains the final
fallback.

**A fully transcribed window was discarded, recomputed, and discarded
again.** `[PM-STALE] window [0.00,2.50) ... computeMs=3613`, twice, for the
same 2.5 seconds of audio, coverage produced: none. A generation bump was
being treated as blanket invalidation, but the reason it moved is what
matters: a dropped session (page refresh, video change) means the audio
belongs to a video nobody is watching, while a SEEK does not change what
the audio at `[absStart,absEnd)` contains. Sessions now carry `dropped`,
and a seek keeps the decoded result unless the span became covered
meanwhile.

### B. The pill was lagging, and quoting a number it never checked

**"Press play to load audio" appeared while the video was playing.**
Capture growth stopping is not playback stopping: once YouTube has
buffered far enough ahead it stops appending for a while and playback
carries on regardless. The pill was telling users to do the thing they
were already doing. It now requires `video.paused` to say that.

**Updates are event-driven on top of the 2Hz poll**, refreshing on
play/pause/seek/ratechange/ended and, most importantly, the instant a
window completes, which is the single biggest change to what it should
say. For a status indicator, lagging reality is the same as lying.

**The ETA is now a promise with a ledger.** "Analyzing, safe to pause
(~3s)" is a specific claim, and the field test caught it frozen on that
exact wording for 30+ seconds. The cause was that every render recomputed
a fresh estimate, so the pill said "~3s" forever, each time as a brand new
and equally untested claim. A promise now holds its ORIGINAL clock and
quote until a window completes, and at 2x the quote the label escalates to
"Analyzing, taking longer than expected".

### C. Health could not see the case that mattered most

Every session in both logs had `health: []`, including the wedged one. The
playback-only clock is right that pausing is not a fault, but combined
with a pill that says "safe to pause", it produced the worst possible
gap: the user pauses **because we told them to**, the pipeline is dead,
and the one person least able to notice is the one we never warn.

New reason code `stalled-analysis`, on a WALL clock: if a promise goes
unfulfilled for longer than `max(3x the quote, 30s)`, the verdict is
unhealthy. Deliberately placed **before the windowsCompleted branch**
(the wedged session had four successful windows behind it, and past
success does not make a currently dead pipeline healthy) and **before the
playback gate** (so it fires while paused).

Bypassing the playback clock is safe here precisely because it requires an
outstanding promise: this can only fire where we said something specific
and it did not come true. Every existing false-positive guard is intact,
and any completed window retires the promise, so recovery needs no
separate path.

The ledger lives in `shared/health.js` rather than in the pill code
because two surfaces act on the same fact and must not disagree about it:
the pill escalates at 2x, the monitor at 3x. One definition, two
consumers, both testable without a browser. It is also maintained when the
pill is hidden, or `pm_showStatus=false` would suppress a warning that is
explicitly not suppressible.

The escalation now reads, end to end: "safe to pause (~3s)" at 0s,
"taking longer than expected" at 6s, "Profanity Muter is NOT filtering
this video" at 31s, back to normal the instant a window lands.

### Preserved deliberately

Log 2 showed **pause-until-ready working correctly**, holding and
releasing as designed. Nothing in this round touches that path.

No new storage keys: the ledger is per-session in-memory state, and the
verdict it produces is recorded through the existing devlog health array.

### Tests

`health_test.js` 37 -> 54, covering the ledger (original clock and quote
held, retirement on completion, late quote, negative clocks) and the
verdict (fires while paused, outranks past success, 3x/30s allowance, no
promise means no verdict, limits still outrank it, throttle never delays
it, recovery). Suite: 240 node checks, 181 browser checks.

## FEATURE (2026-09-02, 0.1.33): Shorts, trademark, two-tier reports, growth surfaces

### 1. Shorts are an explicit state

The content script always RAN on /shorts/ pages; it just never said
anything about them. Investigation first, before deciding to gate:

- `videoId` falls back to `location.pathname` (capture.js
  `currentVideoId`, content.js `currentVideoIdFromLocation`), so every
  Short gets a distinct id and every swipe fires a RESET that discards all
  accumulated coverage.
- Transcription intentionally trails playback by seconds. A Short is
  commonly 15-60s, starts instantly and LOOPS, so analysis has to win a
  race it was never designed for, on every swipe.
- `resolveRealVideo` prefers `#movie_player video.html5-main-video`, the
  watch-page player; the Shorts player is a different container, so
  element resolution falls back to a size heuristic.
- The session model assumes one monotonic video per page.

With the default catch-up mode now `play`, that adds up to unfiltered
audio behind a pill implying otherwise. So Shorts is now a documented
limit: reason code `shorts-unsupported`, the same calm treatment as
livestreams, checked BEFORE live because a Short can also be a premiere
and the Shorts answer is the more useful one there.

The on-player notice is **page-scoped, not session-scoped**. Every swipe
starts a new session, so a per-session flag would fire the notice on every
Short in a scroll; the flag resets on leaving /shorts/ so a later visit
informs once more rather than never again. The pill gains a matching
`Shorts not supported` state and the devlog records the verdict through
the existing health-transition path.

### 2. Trademark hygiene

`YouTube(TM)` on the first and most prominent mention per page (onboarding
subtitle, report subtitle, popup master-switch line), which is the
convention, rather than on every occurrence. The non-affiliation statement
sits on the onboarding acknowledgment step at footer scale, where it
belongs alongside the rest of what this is and is not. Both full-page
surfaces gained the same quiet icon lockup: mark inline with the wordmark
at text scale, so the page opens on its content rather than on a logo.

### 3. Two-tier problem reports

The critical change. The old flow put the entire diagnostic payload on the
clipboard and asked the user to paste it into the mail draft. Most people
will not: they hit send on a near-empty email, and every one of those
reports is undiagnosable. Asking a frustrated non-technical user to
perform a clipboard ritual correctly, at the moment they are annoyed
enough to write in, was always going to fail most of the time.

- **Tier 1, embedded.** The mail body now carries a compact summary:
  version, shortened UA, a settings line, and per-video health verdict
  plus window/match/mute/gap/error counts, newest first. Every report
  arrives actionable whether or not anyone pastes anything.
- **Tier 2, clipboard.** The full devlog JSON is still copied with
  consent, now framed as an optional extra rather than the load-bearing
  step.
- **Privacy tier is deliberately poorer in email.** Counts only: no
  transcripts, no matched words, no word-list contents. Mail bodies get
  forwarded and quoted and sit in mailboxes for years, and a list of which
  profanity a specific child said or heard is never needed to diagnose a
  pipeline that is not running. Video ids stay, being public identifiers
  that make a report reproducible.
- **Consent governs BOTH tiers.** Unticking the box withholds per-video
  data from the email as well as the clipboard, otherwise the checkbox
  would be lying; version, browser and settings remain, since none of them
  describe what was watched.
- **Hard 1800-char budget** on the whole mailto URL, enforced by a shrink
  loop that drops the oldest videos first and never truncates the user's
  own text, which is the one thing only they can supply.

`SUPPORT_EMAIL` is now the real project mailbox, pinned by a test so a
change is deliberate. It stays a role address: it ships in the mailto of
every report and lands in strangers' address books permanently.

### 4. Completion view, and the review ask

Finishing setup was a line of small print under a screen still titled "One
last thing". It is now a fifth view, reached ONLY by finishing (never by
Next/Back), with the header and progress rail hidden there: there is no
step 5 of 4, and hiding the header also stops the stale-subtitle `:has()`
rule resolving against a rail that no longer means anything.

The completion page is the highest-traffic point in the product, so the
review ask lives there and is designed rather than whispered. It asks for
support of the project rather than a verdict on a product nobody has used
yet: at minute zero "is it working well?" has no answer, and inviting a
rating anyway produces uninformed reviews.

Policy line, absolute: no incentive in copy or behaviour, nothing gated or
delayed for declining, no fake social proof or pre-filled stars, and
declining is one plain click with no second ask and no guilt copy.

**Retirement semantics.** Clicking through writes `pm_reviewPrompt`, which
retires every later review surface (milestone card, badge, pill) through
the single existing definition of "already asked" rather than a second
flag to keep in sync. "Maybe later" retires NOTHING: that person is
exactly who the milestone surface exists for, once they have experience to
draw on. Local-only `pm_growth` counters make the two surfaces comparable
later; nothing is transmitted.

The pin request is instructional only (Chrome has no programmatic pin) and
its diagram is a schematic in the page's own system, never a mock of
Chrome's UI, which ages badly and edges toward impersonation.

### 5. Toolbar badge and milestone pill

Both things the extension needs to say lived inside the popup, which most
users never open. The badge is the only surface it owns that is visible
without being asked for, and needs no permission.

One mechanism, one pure decision function, strict priority: **health
always outranks the review nudge**, because a nudge on top of a broken
filter is useless and insulting. **Documented limits never badge**: a
permanent mark for "this is a Short" would train users to ignore the badge
and cost exactly the signal the health case depends on. Health is per tab;
the review nudge is global. Opening the popup while the nudge is up clears
it.

The badge only reaches people who pinned the icon, so the on-player pill
gets one bounded moment at the same milestone: "N videos protected", once
ever, latched in `pm_milestoneShown`, stamped by the service worker as it
hands the answer out so two tabs cannot both show it. It is product status
and NOT review copy (no mention of reviews, ratings or the store), which
is why `pm_showStatus=false` suppresses it, unlike the health warning;
asking is skipped entirely in that case so the latch is not silently
consumed for someone who would never see it.

### Tests

`moments_test.js` 56, `report_test.js` 38, `health_test.js` 37; suite
totals 217 node checks plus 181 browser checks. The browser harness covers
the completion view end to end (landing on it, header and rail standing
down, the review module, declining retiring nothing, clicking retiring
everything, share, Open YouTube), the badge clearing, and the report
page's new copy and payload.

## FEATURE (2026-09-02, 0.1.32): Graceful failure (health monitor)

Until now, if YouTube changed something and the pipeline broke, the
extension failed SILENTLY. The pill would sit on "Analyzing" forever, the
popup would look normal, and a parent would believe their kid was
protected while nothing was being filtered at all. For a parental filter
that is the worst available outcome: believing you are protected when you
are not is strictly worse than knowing you are not, because it removes
the chance to do anything about it. The onboarding copy now promises the
extension will say so rather than stay quiet. This makes that true.

### The bar for saying "broken"

Set high on purpose. A filter that cries wolf gets ignored or
uninstalled, which produces the silent-failure outcome anyway by another
route, and a false alarm on a slow laptop is far likelier than a genuine
break. So the state machine (`shared/health.js`, pure, thresholds
injected) treats these as NOT broken:

- **Slow is not broken.** Transcription is designed to trail the
  playhead. One completed analysis window, however late, means the
  pipeline works. Only ZERO completed windows counts.
- **Paused is not broken.** The clock that matters is accumulated
  PLAYBACK time, not wall time since page load, so a paused video simply
  never reaches the evaluation threshold. There is deliberately no
  separate paused-check: the clock is the mechanism, and a check would
  also throw away a verdict that 20 seconds of real playback had already
  earned.
- **A documented limit is not a break.** Livestreams and protected/DRM
  audio get a calm, separate notice and must never produce the alarming
  message.
- **Lagging catch-up is not broken.** Coverage far behind the playhead
  with windows still completing is the system working as designed.

Thresholds: first verdict at **20 seconds of actual playback**,
re-evaluated every **15 seconds**. Recovery is instant and unthrottled,
because a stale warning misleads exactly as much as a missing one: one
completed window and the verdict flips back, the pill returns to normal,
and the recovery is recorded.

### Reason codes

| code | meaning |
|---|---|
| `no-audio-intercepted` | Playback ran but no audio ever reached the extension. The most likely casualty of a YouTube player change. |
| `model-load-failed` | The speech model could not be loaded. |
| `worker-dead` | The transcription worker crashed or stopped answering. |
| `zero-windows-completed` | Audio arrived, nothing came back. |
| `livestream-unsupported` | Live video, calm notice, not a fault. |
| `content-unanalyzable` | Encrypted/undecodable audio, calm notice, not a fault. |

The two specific fatal causes outrank the generic symptoms they produce,
so a report says "the model could not load" rather than "nothing was
analyzed". They are classified out of the existing offscreen `diag`
relay by `classifyDiag`, which is deliberately NARROW: a skipped window,
a stage timeout or a demux hiccup is routinely survivable, and treating
survivable trouble as fatal is precisely how a warning system loses its
credibility. Anything unrecognized stays unclassified and can only ever
contribute to `zero-windows-completed`.

### Where it surfaces

**On the player.** The existing status pill gains a warning state:
solid red, bold, no emoji, "Profanity Muter is NOT filtering this
video". It shows **even when `pm_showStatus` is off**. Turning off the
pill means "stop telling me things are fine"; it cannot reasonably be
read as "don't tell me when the filter has stopped working".
`pm_enabled` IS still respected: an extension the user switched off is
not failing, it is off. Livestreams instead get a one-time neutral
notice across the top of the player, via the same helper the protected
content notice now uses.

**In the popup.** A warning banner at the very top, above even the
setup banner, because "your filter is not working right now" outranks
everything else the popup has to say. It states the consequence in the
title ("Audio is NOT being filtered"), the cause underneath ("No audio
from this video reached the extension"), and offers a direct
**Report a problem** link into the existing report page. It is not
dismissable: it describes a live condition rather than a task, so it
disappears when the condition does.

**In `pm_devlog`.** A new `health` array per video entry, recording
every transition in BOTH directions with the reason code, playback
duration, window count and segment count. A warning that appeared and
then cleared is a materially different story from one that never
appeared, and only the log can tell them apart later.

### Why there is no `pm_health` storage key

A storage key was the obvious design and was rejected:

- Health is **per tab and per video**. A single stored value gets
  clobbered by whichever tab wrote last, so a popup opened over a
  working video could show a warning earned by a different tab. Keying
  by tabId would fix that, but a content script does not know its own
  tabId without asking the service worker for it.
- It is **transient**. Persisting a verdict means it can outlive the
  thing it describes, so the popup would then need staleness rules for a
  value that is only interesting while that tab is open.

Instead the popup asks the active tab directly
(`chrome.tabs.sendMessage` with `pm-health-query`; content.js answers
synchronously). Always fresh, inherently per-tab, and the absence of an
answer is itself the right answer: no content script means this is not a
YouTube tab, and the popup shows nothing. No new permission is needed
(`tabs.create`/`sendMessage` are unprivileged, `tabs.query` returns the
id without the `tabs` permission, and only the id is used). The durable
record stays in `pm_devlog`, which is where a verdict belongs for later
diagnosis.

### Tests

`test/health_test.js` (33) is the state-machine matrix: healthy, each
reason code, precedence between causes, every false-alarm guard (slow,
paused, lagging, throttled, below threshold), both unsupported paths,
recovery, transition detection, and the classifier's refusal to treat
survivable trouble as fatal. It matters more than most suites here
because the failures it covers cannot be reproduced on demand: nobody
can make YouTube break audio interception on a test machine, so this is
the only place the logic is ever exercised before a user depends on it.

`verify/popup_check.mjs` grew 137 -> 161 with the banner: hidden when no
tab answers, hidden when healthy, shown with message plus cause when
unhealthy, its report link opening the report page, no emoji, correct
stacking above the setup banner, still shown while the settings are
locked, and NOT shown for an `unsupported` verdict.

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
   one plain line about what that actually means: the matched words and
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

## FEATURE (2026-09-02, 0.1.30): Onboarding, plain limits & growth surfaces

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

**Plain-limits copy.** The tone target was to name the exact failure
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
- **Candor**: this is a **deterrent, not security**, and the caption
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

Note there is deliberately **no** `pm_health` key for the 0.1.32 health
monitor: the popup asks the active tab directly instead. See "Graceful
failure (health monitor)" above for why a stored value was rejected.
| `pm_lock`           | `{salt, hash}` or absent  | absent -> no lock. Optional parental lock over the popup's settings; `hash` = SHA-256(salt + password), hex. Owned by `shared/lock.js` + `popup/popup.js`; NOT in `STORAGE_KEYS`, NOT in the `PMWordlist.settings` contract. A deterrent, not security |
| `pm_padding`        | `"tight"\|"normal"\|"wide"` | `"normal"` - how much surrounding audio the mute interval pads around a matched word; consumed entirely by the audio pipeline's `content.js` for its interval math |
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
`{enabled, muteAudio, censorCaptions, safeMode, catchupMode, debugOverlay, showStatus, strictness, padding, additionalWordCount}`
(10 keys; `additionalWordCount` (0.1.29) is a COUNT, never the words
themselves - the user's own list lives on `_state.additionalWords`. The
`multilingual` key was removed in 0.1.46.) - no `wordlist`, `stemSet`, `phrases`, or
`phraseIndex` leakage (those live on the separate internal `_state`
object used by `isProfane`/`censorText`/`findMatches`). `safeMode` is
derived from `catchupMode` as described above. It's the same object
reference on every `refresh()`/`onChanged` cycle, mutated in place -
`content.js` (owned by the other agent) can read
`PMWordlist.settings.muteAudio`, `PMWordlist.settings.catchupMode`,
`PMWordlist.settings.safeMode`, `PMWordlist.settings.debugOverlay`,
`PMWordlist.settings.showStatus`, `PMWordlist.settings.strictness`,
or `PMWordlist.settings.padding`
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
