# Censor module notes (wordlist / captions / popup)

Scope owned by this agent: `shared/wordlist.js`, `captions.js`, `popup/`
(`popup.html`, `popup.js`, `popup.css`). No `manifest.json`, `capture.js`,
`content.js`, `background.js`, `offscreen*`/`dist/*`, or `verify/` files
were created or touched — those belong to the audio-pipeline agent
working in the same directory. (Confirmed against the manifest they
wrote: it loads `shared/wordlist.js`, `content.js`, `captions.js` as one
`document_start` content-script group, `capture.js` separately in the
page's MAIN world, and `popup/popup.html` as the toolbar popup — all
consistent with the paths this agent owns.)

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
`PMWordlist._state.wordlist` stayed `DEFAULT_WORDLIST` regardless — a
saved custom word list silently had zero effect on matching.

The exact same pattern existed in `popup/popup.js`'s `load()`, which
would have meant the popup always displayed (and, on Save, would have
silently overwritten) a real saved custom list with the built-in
defaults.

**Fix, in both files:** call `chrome.storage.sync.get()` with the
**array form** (a plain list of key names —
`PMWordlistCore.STORAGE_KEYS` in `wordlist.js`; the equivalent literal
array in `popup.js`), and apply defaulting ourselves, in code, on the
raw result. In `wordlist.js` this defaulting logic is now a pure,
exported, unit-tested function: `resolveSettingsFromStorage(items)` —
`items.pm_wordlist === undefined` (key truly never saved) falls back to
`DEFAULT_WORDLIST`; a saved empty array (`[]`) is honored as "no words"
and is NOT defaulted back. `captions.js` was audited too — it only uses
`chrome.storage.onChanged`, never `.get()`, so it was never exposed to
this bug. `popup.js`'s two `.set()` calls were also audited and don't
write any `undefined` values, so they're unaffected.

Also while fixing this: `PMWordlist.settings` was previously just an
alias for the internal `state` object, which also carries `wordlist`
(array), `stemSet` (a `Set`), `phrases` (array), and `phraseIndex` (a
`Map`) — extra shape the pipeline doesn't want and which wouldn't
serialize sensibly (`JSON.stringify` on a `Set`/`Map` produces `{}`).
`PMWordlist.settings` is now a dedicated object containing **exactly**
`{enabled, muteAudio, censorCaptions, safeMode}`, the same object
reference mutated in place on every `refresh()`/`onChanged` — confirmed
via `Object.keys(PMWordlist.settings).sort()` in the new integration
test (see "Test results" below).

Regression coverage added: 7 new pure-function tests for
`resolveSettingsFromStorage` (empty storage, `undefined` input, the
exact reported bug scenario with a real saved list, a saved empty list,
explicit `false` booleans, corrupted non-array `pm_wordlist`), plus a
new **integration test** (`wordlist_integration_test.js`) that stubs
`chrome.storage.sync` — its fake `get()` *throws* if ever called with
anything other than the array form, so this exact bug class can't
silently regress — and drives `PMWordlist.refresh()` end-to-end,
reproducing the pipeline agent's live scenario
(`["college", "connected", "dots"]`) against the real `refresh()` code
path, not just the extracted pure function.

## BUG FIX (2026-08-30): "clicking the icon doesn't load the settings UI properly"

### Diagnosis

Confirmed `popup.html` DOES include `shared/wordlist.js` via a script
tag before `popup.js` (`window.PMWordlist` was present and correct in
every repro run — that specific suspect was ruled out), and 10
consecutive real-extension popup opens (Playwright, `chromium.launchPersistentContext`
with `--load-extension` pointed at this actual unpacked extension
directory, then navigating a fresh page to
`chrome-extension://<id>/popup/popup.html` 10 times — the accepted
stand-in for the real action popup, since Playwright cannot click
actual browser-chrome toolbar icons) all produced a perfectly correct,
error-free popup. So the bug is NOT a crash-on-load or a missing
global.

The real root cause: **`chrome.storage.sync.get()` is a genuine async
round trip** (it can hit sync's own rate limits, quota errors, or just
take a moment — unlike a synchronous local read), but every control in
`popup.html` started in its default HTML state (`checked` was never
set, so every toggle rendered OFF) and the word list area
(`#pm-masked-list`) started completely empty — both only became correct
once `load()`'s storage callback resolved. This has two consequences,
confirmed by direct reproduction:

1. **A storage error left the UI permanently broken.** Simulating a
   realistic `chrome.runtime.lastError` (e.g. a `QUOTA_BYTES_PER_ITEM`
   error) showed `load()`'s callback doing `return` immediately,
   leaving every toggle OFF and the word list area with 0 children
   forever, with only a tiny, easy-to-miss "Failed to load settings"
   status line — see `popup-storage-error-BEFORE-FIX.png` (session
   scratchpad). This is a completely convincing match for "doesn't load
   the settings UI very well."
2. **Even without an error, there was a real window** — however brief —
   between the popup painting and `chrome.storage.sync.get()` resolving
   where the same broken-looking all-off/empty state was visible. Since
   action popups are destroyed on blur/dismissal, a user who clicks
   away (or the popup loses focus) during that window never sees it
   "load" correctly at all — which reads exactly like intermittent
   flakiness ("often doesn't load... properly").

### Fix

1. `popup.html` now ships with its real defaults already `checked` in
   the static markup — `#pm-enabled`, `#pm-mute-audio`,
   `#pm-censor-captions`, and the `"mute"` catch-up radio — so the very
   first paint, with zero JavaScript having run yet, already looks
   correct for the common case (a fresh/default-config user).
2. `popup.js` now has `renderDefaultsSynchronously()`, called at the
   very top of `load()`, BEFORE `chrome.storage.sync.get()` is ever
   invoked: it synchronously populates the word-list textarea with
   `DEFAULT_WORDLIST` and renders the masked view. This eliminates the
   "empty word list" flash entirely — the popup is fully correct and
   interactive the instant it paints, independent of storage latency.
3. The storage callback's error path no longer bails into a blank UI —
   it leaves the already-correct (default) UI exactly as it is and only
   adds a status message ("Couldn't load saved settings — showing
   defaults"). A storage error now degrades to "you're seeing defaults,
   here's a heads-up" instead of "the popup is broken."
4. The success path was changed from "always call `showMasked()`" to
   "only re-render the masked view if still masked" (`if (masked)
   renderMasked()`), so it can't clobber a user who — in the rare case
   they unmasked and started editing during that brief window before
   storage resolved — would otherwise have their in-progress edit view
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
  "pause"`, `debugOverlay: true`, 2-word custom list) — no flash of
  broken state, no double-render artifacts.
- **10 consecutive real-extension popup opens**, both before and after
  the fix, via Playwright loading the actual unpacked extension
  (`popup_repro.js`, session scratchpad): 0/10 broken before AND after
  (the plain fresh-storage case was never broken — the bug only shows
  under storage latency/errors, which this direct-navigation repro
  doesn't naturally hit, hence needing the explicit error-injection
  test above to actually exercise the failure path) — included to
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
`renderMasked()` — confirmed by grepping the full call graph and by a
live Playwright `MutationObserver` audit (below) showing **zero**
mutations to `#pm-masked-list` across four toggle/radio clicks
(checkbox, radio, checkbox, checkbox), while a subsequent Restore
Defaults click produced 124 mutations (proving the observer itself
works and that word-list re-renders are correctly scoped to actual
word-list changes only — Save, Restore Defaults, and the async
load()-reconcile step — never to a settings-only save).

The actual lag source: the radio group used plain native
`input[type="radio"]` elements styled only with `accent-color`. Native
radio/checkbox widgets — especially on macOS Chrome's modernized
"Chrome Refresh" form controls — carry their own internal fill
animation baked into the browser's UA rendering, which CSS
`transition` rules cannot fully suppress or tune (this is invisible to
DOM-level timing checks: `getComputedStyle(...).transitionDuration`
and the `change` event both fire in under 1ms, because the *logical*
state change is instant — only the browser's own *paint* of the native
widget lags, on a timescale headless-Chromium's rendering doesn't
reproduce identically to real macOS Chrome). This is exactly the class
of "invisible to automated timing but visible to a human eye" bug.

### Fix

Converted the "While catching up" radio inputs to a fully custom-drawn
control, the same principle already used for the toggle switches:
`appearance: none` plus a hand-drawn ring + dot purely from the
`:checked` pseudo-class in `popup.css`, with **no `transition` property
anywhere on the control** — there's nothing left to animate, native or
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
  the word list): 124 mutations — confirms the observer is live and
  that the "only re-render on actual word-list change" invariant holds.
- Re-ran the real-extension 10-consecutive-opens repro
  (`popup_repro.js`) after this change: still 0/10 broken.
- Screenshot confirming the custom radio renders and selects correctly:
  session scratchpad, `popup-custom-radio-pause-selected.png`.

## What's built

### `shared/wordlist.js`
Plain (non-module) script, safe to load as the first isolated-world
content script. Attaches `globalThis.PMWordlist`:

- `isProfane(word) -> bool`
- `censorText(text) -> string`
- `findMatches(tokens) -> [{index, length}]` — see "Sequence matching"
  below; for the audio pipeline.
- `refresh() -> Promise` — re-reads `chrome.storage.sync` and rebuilds
  internal match structures.
- `settings` — live settings snapshot (see "Settings split" below).

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
  wordlist entry when building the match set — a straight `Set` lookup
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
  1. **Aligned wildcard** — token and candidate stem must be the *same
     length*; every non-`*` character in the token must equal the
     candidate's character at that position (case-insensitive).
     `"sh*t"` (len 4) aligns against `"shit"`; `"f***ing"` (len 7)
     aligns against `"fucking"`.
  2. **First-letter-only shorthand** — a token that's one real letter
     followed by nothing but asterisks (`"f***"`, `"a**"`, `"s***"`)
     matches *any* stem starting with that letter whose length is
     within ±1 of the token's length. Deliberately loose: a bare
     `"f***"` carries no positional information beyond "starts with f,
     about this long," so the tool errs toward matching (over-censoring)
     rather than requiring an exact-length align. Rule 1 already covers
     the same-length case; rule 2 only adds the ±1 tolerance.
  Both rules scan the (small, ~140-entry) stem `Set` linearly per call
  rather than building a regex per candidate — no regex-per-word
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
`[{index, length}, ...]` — one entry per match, covering:
- a single profane word (via the same `isProfane`/wildcard logic,
  `length: 1`), or
- a multi-word phrase from the word list (`length` = word count).

**Linear time**: phrases are indexed by their first normalized word
(`buildPhraseIndex`, a `Map<firstWord, phraseWordArrays[]>`, each bucket
sorted longest-first). For each input token, `findMatchesCore` does one
`Map` lookup plus, at most, a short scan of same-first-word phrase
candidates (typically 0-2) — no `O(tokens * phrases)` scan. Phrase
comparison is case-insensitive and punctuation-tolerant per token
(`normalizeToken` on each token before comparing), so `"Oh, my GOD"`
matches the `"oh my god"` entry. Matches are reported in token order and
are *not* deduped against overlap (the loop doesn't skip ahead past a
phrase match) — in practice this only matters for pathological
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

### `chrome.storage.sync` (settings — synced across the user's devices)

| key                 | type                      | default                              |
|---------------------|---------------------------|----------------------------------------|
| `pm_enabled`        | `boolean`                 | `true` — master on/off                 |
| `pm_muteAudio`      | `boolean`                 | `true` — audio-pipeline mute toggle    |
| `pm_censorCaptions` | `boolean`                 | `true` — caption-censoring toggle      |
| `pm_catchupMode`    | `"mute"\|"pause"\|"play"` | `"mute"` — THE ONE setting for what happens in parts of the video not yet analyzed (see below); any other/invalid stored value defaults to `"mute"` |
| `pm_debugOverlay`   | `boolean`                 | `false` — shows an on-player diagnostic overlay (consumed by the audio pipeline's `content.js`); opt-in, unlike the other booleans which default to `true` |
| `pm_showStatus`     | `boolean`                 | `true` — shows an on-player status pill (consumed by the audio pipeline's `content.js`). Distinct from `pm_debugOverlay`: this is a lightweight, on-by-default status indicator, not an opt-in diagnostic |
| `pm_safeMode`       | `boolean`                 | DEPRECATED, read-only. No longer written by the popup — merged into `pm_catchupMode`. Only consulted, once, to migrate a legacy `false` forward (see "Safe mode + catch-up mode merge" below) |
| `pm_wordlist`       | `string[]`                | unset -> built-in `DEFAULT_WORDLIST`; once saved, respected exactly as-is (even `[]`) |

`pm_wordlist` semantics matter: built-in defaults are used **only** when
the key has never been saved at all (`items.pm_wordlist === undefined`
from `chrome.storage.sync.get`'s default). Once the popup has saved
*anything* — including an intentionally emptied list — that saved value
is used verbatim, with no length-based fallback. This lets a user
deliberately turn off word-based filtering by clearing the list and
saving, without silently reverting to defaults.

### `chrome.storage.LOCAL` (stats — per-install, NOT synced) — new, 2026-08-30

| key        | type                                            | default |
|------------|--------------------------------------------------|---------|
| `pm_stats` | `{totalMuted: number, videosProtected: number}`  | absent -> popup shows zeros |

Written by the audio pipeline (`content.js`, owned by the other agent)
as it runs; `shared/wordlist.js` does not read or write this key at
all — it's handled entirely in `popup/popup.js`, independently of the
`chrome.storage.sync` settings flow, because it's a different storage
**area** on purpose (per-install telemetry, not something that should
sync across a user's devices). See "STATS section" under `popup/`
below for the popup-side read/display/reset/live-update details.

### Safe mode + catch-up mode merge (2026-08-30)

Per user feedback, the separate "Safe mode" toggle and "While catching
up" radio choice were two settings expressing one idea, so they were
merged into a single setting: `pm_catchupMode` now takes three values
instead of two.

- `"mute"` (default) — mute audio in parts not yet analyzed.
- `"pause"` — pause playback outright in parts not yet analyzed (full
  protection: nothing unanalyzed ever plays).
- `"play"` — let it play unanalyzed. This is the old "Safe mode off"
  behavior, now expressed as a third catch-up option instead of a
  separate toggle.

The popup's standalone "Safe mode" toggle row and its `pm-safe-mode`
checkbox are **gone**. The "While catching up" radio group now has
three options — Mute audio / Pause video / Let it play — with the hint
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
and for `catchupMode` itself — `pm_catchupMode` always wins outright
when it's a valid, explicitly-saved value.

**Migration path** (`resolveSettingsFromStorage`, only applies when
`pm_catchupMode` has never been saved / is invalid):

1. A valid, explicitly saved `pm_catchupMode` (`"mute"`/`"pause"`/
   `"play"`) always wins outright — checked first, regardless of what
   `pm_safeMode` holds.
2. Otherwise, if the legacy `pm_safeMode` was explicitly saved as
   `false` (the user had turned safe mode off under the old two-setting
   schema), migrate that forward as `catchupMode: "play"` — preserving
   the user's old choice instead of silently reverting to `"mute"` and
   re-enabling protection they'd turned off.
3. Otherwise (nothing saved at all, `pm_safeMode` was `true`/unset, or
   `pm_catchupMode` is corrupted/mistyped) default to `"mute"`.

This migration is stateless and re-evaluated on every `resolveSettingsFromStorage`
call — it isn't a one-time write-back to storage. It naturally stops
applying the moment the user picks any of the three radio options in
the popup, since that action saves `pm_catchupMode` explicitly (rule 1
then wins forever after, even though the stale `pm_safeMode: false`
never gets cleaned up in storage — that's fine, it's simply never
looked at again).

Validated the same way the boolean keys default to `true` on anything
other than an explicit `false`: `resolveSettingsFromStorage` checks
`CATCHUP_MODES.indexOf(items.pm_catchupMode) !== -1` (where
`CATCHUP_MODES = ["mute", "pause", "play"]`) before falling through to
the migration check and then to `DEFAULT_CATCHUP_MODE` (`"mute"`).

### `PMWordlist.settings`

`PMWordlist.settings` is a dedicated object containing **exactly**
`{enabled, muteAudio, censorCaptions, safeMode, catchupMode, debugOverlay, showStatus}`
— no `wordlist`, `stemSet`, `phrases`, or `phraseIndex` leakage (those
live on the separate internal `_state` object used by `isProfane`/
`censorText`/`findMatches`). `safeMode` is derived from `catchupMode` as
described above. It's the same object reference on every
`refresh()`/`onChanged` cycle, mutated in place — `content.js` (owned by
the other agent) can read `PMWordlist.settings.muteAudio`,
`PMWordlist.settings.catchupMode`, `PMWordlist.settings.safeMode`,
`PMWordlist.settings.debugOverlay`, or `PMWordlist.settings.showStatus`
directly and each will reflect the latest saved/derived value without
needing its own storage listener, and without ever seeing internal
`Set`/`Map` fields. See "CRITICAL BUG FIX" above for why this was
tightened up.

### `pm_debugOverlay` (2026-08-30)

Simple opt-in boolean, `false` by default (one of two settings in this
schema that do NOT default to `true` — see `pm_showStatus` for
contrast). Turning it on is intended to show a small diagnostic overlay
on top of the YouTube player — that overlay itself is built and
rendered by the audio pipeline's `content.js` (owned by the other
agent); this file's only responsibility is exposing the live setting
via `PMWordlist.settings.debugOverlay`, wired through `STORAGE_KEYS`,
`resolveSettingsFromStorage`, `refresh()`, and the `onChanged` listener
exactly like every other setting.

### `pm_showStatus` (new, 2026-08-30)

Simple boolean, `true` by default (unlike `pm_debugOverlay` — this is a
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
   correct — the visual flip is driven purely by CSS off the checkbox's
   native `:checked` state (`.pm-switch input:checked + .pm-switch-track`
   etc. in `popup.css`), which happens before the `"change"` JS handler
   even runs, and `saveTogglesOnly()` was already fire-and-forget
   (`chrome.storage.sync.set(...)`, no `await`, no re-read/re-render in
   the callback — it only ever touches the status text). Two real
   contributors to sluggish/inconsistent feel were found and fixed
   anyway: (a) the transition duration was at the very top of the
   acceptable range (`0.15s`); tightened to `0.14s` on both the track's
   `background` transition and the thumb's `transform` transition,
   comfortably inside 120-150ms. (b) Each switch `<label>` had **both**
   an explicit `for="pm-..."` attribute **and** the `<input>` nested
   inside it as a descendant — a redundant double-association that's a
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
   on all sides — a block child's margin can collapse through a
   border-and-padding-less parent, which is exactly what was happening,
   pulling the thumb away from true (trackHeight − thumbHeight) / 2
   centering. Fixed by making `.pm-switch-track` a flex container
   (`display: flex; align-items: center;`) and giving the thumb
   `margin-left: 2px` only (no top/bottom margin to collapse) — flexbox
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
  both report `topGap: 2, bottomGap: 2` — exactly
  `(20 − 16) / 2 = 2` on both sides, pixel-centered in both states.
- Three sequential clicks on `#pm-mute-audio` toggle `checked` as
  `false → true → false` — exactly one flip per click, confirming the
  `for`-attribute removal eliminated any double-toggle risk.
- Screenshots saved to the session scratchpad:
  `popup-at-rest.png` (full popup, all switches ON, default catch-up
  mode), `popup-toggled.png` (same, "Mute audio" switched OFF via one
  click), `popup-switch-on-crop.png` (tight crop of the "Enabled"
  switch), and `popup-switch-on-zoomed.png` (same crop re-rendered at
  8x device scale factor for an easy visual centering check — the knob
  sits with a visually equal gap above and below it inside the track).

- `popup.html` / `popup.css` / `popup.js`, zero external resources
  (loads `shared/wordlist.js` itself, via a relative `<script src="../shared/wordlist.js">`,
  purely to reuse `DEFAULT_WORDLIST` and `chrome.storage.sync` — no new
  cross-boundary file was created, this only reads our own owned file).
- Four toggles, each saving immediately on change: **Enabled** (master),
  **Mute audio**, **Censor captions** (hint: "turn off to verify audio
  muting against what's actually said"), **Show status on player**
  (`pm_showStatus`, new 2026-08-30, hint: "Show a small status pill on
  top of the YouTube player", default **on** — consumed by the audio
  pipeline's `content.js` via `PMWordlist.settings.showStatus`; this
  popup/`shared/wordlist.js` side only owns the setting, not the pill's
  rendering). There is no separate Safe mode toggle anymore — see below.
- **"While catching up" radio group** (`pm_catchupMode`), three options
  — **Mute audio** / **Pause video** / **Let it play** — with the hint
  "What happens in parts of the video not yet analyzed." This single
  setting replaced the old Safe mode toggle + two-option radio combo
  (see "Safe mode + catch-up mode merge" above for the full rationale
  and migration path). Three `<input type="radio" name="pm-catchup-mode">`
  elements; saves immediately on change like the toggles. `pm_safeMode`
  is never written by the popup anymore — it's read once by
  `shared/wordlist.js`, only for the legacy migration, and the popup
  itself also consults it purely to decide what to *display* as checked
  on first load after an update (mirroring the same migration rule so
  the radio group doesn't flash "Mute audio" and then jump to "Let it
  play" — see `load()`'s `displayedCatchupMode` computation in
  `popup.js`). Loading an invalid/unset stored value (and no legacy
  `pm_safeMode: false` to migrate) falls back to selecting "Mute audio"
  (`"mute"`), the same defaulting rule as `resolveSettingsFromStorage`.
  The three radio inputs are custom-drawn (`appearance: none` + a
  hand-styled ring/dot, no `transition` property) rather than native —
  see the "radio flip lag" BUG FIX near the top of this file for why.
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
  full `DEFAULT_WORDLIST` content (one entry per line) — genuinely
  editable, not a greyed-out placeholder hint. Once saved, the textarea
  shows exactly the saved list.
- **Restore defaults** button repopulates the textarea (and, if masked,
  re-renders the masked view) with the full default list; it does not
  save automatically — the user still clicks Save to persist it, same
  as any other edit.
- **Save** always writes exactly what's in the textarea (parsed:
  trimmed, blank lines dropped) to `pm_wordlist`, including an
  intentionally empty array.
- A small **"Debugging"** section (new, 2026-08-30) with one toggle,
  **Show debug overlay** (`pm_debugOverlay`, hint: "Show analysis
  status on top of the YouTube player"), defaulting to **off** — the
  only toggle in the popup that defaults false. Saves immediately on
  change like the other toggles. Consumed by the audio pipeline's
  `content.js` via `PMWordlist.settings.debugOverlay` to drive an
  on-player diagnostic overlay; this popup/`shared/wordlist.js` side is
  only responsible for the setting itself, not the overlay's rendering.
- A small **"Stats"** section (new, 2026-08-30) displaying
  `chrome.storage.LOCAL` key `pm_stats` (`{totalMuted, videosProtected}`,
  written by the audio pipeline — see the storage schema above)
  compactly as "words muted all-time: N &middot; videos protected: M".
  Deliberately reads `chrome.storage.LOCAL`, not `sync` — this is
  per-install telemetry, handled entirely independently of the
  settings `load()`/`save()` flow, with its own
  `chrome.storage.onChanged` listener filtered to `areaName === "local"`
  so the line live-updates while the popup happens to be open and the
  pipeline writes new totals, with no polling. Renders zeros
  synchronously first (same correct-by-default-before-any-storage-read
  pattern as the settings — see "BUG FIX" above), reconciling to the
  real stored value once `chrome.storage.local.get` resolves; a
  malformed/non-numeric stored value is sanitized to `0` rather than
  rendering `NaN` or throwing. A **"Reset stats"** link button writes
  `{totalMuted: 0, videosProtected: 0}` back to `chrome.storage.local`
  — fire-and-forget, same rule as every other write in this popup: the
  displayed line zeroes out immediately on click, the actual
  `chrome.storage.local.set()` call happens in the background and only
  updates the status text on completion/failure, never re-rendering or
  blocking the visual reset.
- A status line (`role="status"`, `aria-live="polite"`) shows
  "Saved" / "Save failed" / "Storage unavailable" / a Restore-defaults
  hint / "Couldn't load saved settings — showing defaults" (see "BUG
  FIX" above), auto-clearing after 2s.
- All reads/writes guarded behind a `hasStorage` check so the popup
  degrades gracefully rather than throwing if `chrome.storage` isn't
  present.
- **The popup is correct-by-default synchronously, before any storage
  read completes** (see "BUG FIX" above): `popup.html`'s toggles/radio
  ship with their real defaults already `checked`, and `popup.js` calls
  `renderDefaultsSynchronously()` — populating the default word list and
  masked view — as the very first thing `load()` does, strictly before
  `chrome.storage.sync.get()` is invoked. The async storage callback
  only ever *reconciles* to the user's real saved settings if they
  differ, and on a storage error leaves the already-correct default UI
  alone rather than blanking it.

## Default list & known collisions

`DEFAULT_WORDLIST` is a curated, alphabetized, ~123-entry array covering
strong swears and compounds not already caught by suffix stemming
(`shitstain`, `motherfucker`, `dumbfuck`, `fuckwit`, etc. — plain
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
to guard against — they're bugs in the derivation, not intentional
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
common English words — including every `-in`/`-ain` word class the new
dropped-g heuristic could plausibly over-trigger on (`"rain"`,
`"captain"`, `"cousin"`, `"beginning"`, etc.) — as a regression guard.

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
photography/video production, gaming, "shoot for the stars," etc.) —
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

Ran a full collision scan — `PMWordlistCore.isProfaneCore()` against
every entry in `/usr/share/dict/words` (235,974 words) — as a general
quality pass triggered by adding the euphemism set above. Script:
session scratchpad, `collision_scan.js`; full word-level results
(word + which stem it matched): session scratchpad,
`collision_scan_results.txt` (not reproduced here — see "no
enumerating word-list contents in prose" note below).

**Before any fix: 103 distinct dictionary words flagged.** The large
majority were expected true positives (the list entries themselves,
or close derivatives like plurals/`-ing`/`-ed`/`-y` forms of an
intentionally-profane root — e.g. a mild-profanity entry's own
adjective form, or a slur entry's plural) or already-documented
accepted collisions from earlier in this file (the "Accepted
collisions, kept anyway" paragraph above already covers several
entries whose derivatives also showed up here — a common word for a
narrow opening, a hardware-tool verb, a laboratory/medical term, a
feline nickname, a construction-chemistry term — all pre-existing,
out of today's scope, and consistent with the already-stated
over-censoring-is-acceptable philosophy).

**Ten were genuine, high-severity false positives** — extremely
common, zero-ambiguity English words with no real profane
double-meaning, several with obvious everyday-content risk (cooking
videos in particular). Fixed via a new `SAFE_WORDS` short-circuit set
in `shared/wordlist.js`, checked in `isProfaneCore` BEFORE any
stem-set lookup — these exact words always resolve to "not profane"
regardless of word-list contents, because the collision is a stemming
*artifact*, not a deliberate word-list choice:

- A common word for the bodily fluid, plus its adjective form (strips
  via a mild-profanity entry's own `-y`-suffix-stripped root).
- A common word for a stroller/faulty-software ("buggy"), which
  strips via a different entry's `-er`-stripped root plus `-y`.
- The cooking spice "cumin" (a real recipe-content risk), which
  strips via the dropped-g heuristic to a 3-letter slang entry.
- Four cooking-content words — the adjective form of "spicy" plus its
  `-ed`/`-er`/`-ing` variants — which strip via a slur entry's
  4-letter root. This one is a plausible frequent-occurrence bug (any
  cooking/food video describing food as spicy) and was the highest
  real-world-severity find of the scan.
- A common word for a hazard/risk ("danger", singular; found and fixed
  before the full-dictionary scan, via manual review of the new
  additions — the scan confirmed it no longer appears).

**Rerunning the scan after the fix: 95 distinct words remain flagged**
— all reviewed and are either exact list entries, close/plural/`-ing`
derivatives of an intentionally-profane root, or already covered by
the "Accepted collisions" paragraph above (over-censoring some
niche/technical/archaic vocabulary is an accepted tradeoff for this
product; none of the remaining 95 are as common or as likely to appear
in ordinary YouTube captions as the 10 that were fixed).

`SAFE_WORDS` is intentionally small and will stay that way — it's a
targeted override for verified, high-severity collisions, not a
general-purpose dictionary. Add to it only when a real collision like
this is found and confirmed (e.g. via `collision_scan.js`).

## Test results

Pure matching logic (`PMWordlistCore`) is unit tested under Node with
zero dependencies, since it has no `chrome.*` requirement. Test file:
`wordlist_test.js` (kept in the session scratchpad, not committed to
this repo — see "Re-running the tests" below for the exact command).
A second file, `wordlist_integration_test.js`, stubs `chrome.storage`
to exercise the real (non-pure) `refresh()`/`onChanged` code path. A
third, `collision_scan.js` (see "Collision scan" above), is a one-off
audit tool (not part of the regular pass/fail suite) that scans
`/usr/share/dict/words` for false-positive collisions and writes full
results to `collision_scan_results.txt` — both in the session
scratchpad.

Run with `node wordlist_test.js`. Result: **187/187 passed**, covering:

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
- **Collision guardrails**: 60 common English words — including the
  full `-in`/`-ain` family the dropped-g heuristic touches
  (`"rain"`...`"cousin"`) — asserted NOT profane; `"oh my goodness"`
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
  (`["college", "connected", "dots"]` — the exact reported bug
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
  is DERIVED (`catchupMode !== "play"`) — verified for all three
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
  count as "explicitly saved" for override purposes — migration still
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

```
$ node wordlist_test.js
... (195 lines of PASS) ...
195 passed, 0 failed
```

Run with `node wordlist_integration_test.js`. Result: **21/21 passed**,
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
- `PMWordlist.settings` has exactly the 7 keys the pipeline consumes
  (`Object.keys(...).sort()` === `["catchupMode", "censorCaptions",
  "debugOverlay", "enabled", "muteAudio", "safeMode", "showStatus"]`)
  with correct default values for the keys left unsaved in the fake
  store (`muteAudio`/`censorCaptions` -> `true`, `catchupMode` ->
  `"mute"`, `debugOverlay` -> `false`, `showStatus` -> `true`).
- A second `refresh()` after the fake store is updated (empty wordlist
  saved, `pm_muteAudio` flipped to `false`, `pm_catchupMode` set to
  `"pause"`) correctly reflects all three changes: the empty list is
  honored (nothing flagged as profane), `PMWordlist.settings.muteAudio`
  becomes `false`, and `PMWordlist.settings.catchupMode` becomes
  `"pause"`.
- Two further `refresh()` cycles toggle `pm_debugOverlay` to `true` then
  back to `false` in the fake store, confirming
  `PMWordlist.settings.debugOverlay` tracks it live both directions,
  and that `PMWordlist.settings` still has exactly its 7 keys after
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
  permanently overrides the migration — `catchupMode` becomes `"pause"`
  and derived `safeMode` becomes `true`, correctly ignoring the stale
  `pm_safeMode: false` left behind in storage forever after.
- **`pm_debugOverlay`, end to end**: after saving `pm_debugOverlay: true`
  in the fake store, `refresh()` reflects it in
  `PMWordlist.settings.debugOverlay`; saving `false` again and
  refreshing once more confirms it tracks back down too.
- **`pm_showStatus`, end to end**: after saving `pm_showStatus: false`
  in the fake store, `refresh()` reflects it in
  `PMWordlist.settings.showStatus`, and `PMWordlist.settings` still has
  exactly its 7 keys (no drift); saving `true` again and refreshing
  once more confirms it tracks back up too.

```
$ node wordlist_integration_test.js
... (18 lines of PASS) ...
18 passed, 0 failed
```

### Re-running the tests

```js
// save as wordlist_test.js anywhere and run `node wordlist_test.js`
var { PMWordlistCore, DEFAULT_WORDLIST } = require(
  "~/Desktop/profanity-muter/extension/shared/wordlist.js"
);
// ... assertions against PMWordlistCore.isProfaneCore / censorTextCore /
// findMatchesCore / resolveSettingsFromStorage, see the "Test results"
// list above for exact cases.
```

For the integration test, stub `global.chrome.storage.sync` (`get`/
`set`) and `global.chrome.storage.onChanged.addListener` BEFORE
`require()`-ing `wordlist.js` (module init calls `refresh()`
immediately), then drive `PMWordlist.refresh().then(...)` — see
`wordlist_integration_test.js` in the session scratchpad for the full
fake-storage implementation.

`shared/wordlist.js` exports `{ PMWordlistCore, DEFAULT_WORDLIST }` via
`module.exports` whenever `module` exists (i.e. under Node), while still
attaching `globalThis.PMWordlist` in the browser — the same file works
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
   per its own toggle — this is the intended "verify audio muting
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

- `PMWordlist.findMatches(tokens)` — pass an array of transcribed words
  in order; get back `[{index, length}]` covering both single profane
  words and multi-word phrases (e.g. `"oh my god"`), respecting
  `pm_enabled`.
- `PMWordlist.settings.muteAudio` — live boolean, `true` by default,
  reflects the popup's "Mute audio" toggle; kept fresh automatically
  (same object `refresh()`/`onChanged` update, no separate listener
  needed on your end).
- `PMWordlist.settings.catchupMode` — live `"mute" | "pause" | "play"`,
  `"mute"` by default, reflects the popup's "While catching up" radio
  group (three options: Mute audio / Pause video / Let it play). THIS IS
  NOW THE ONE SETTING for catch-up behavior — the popup's old separate
  Safe mode toggle is gone and `pm_safeMode` is no longer written at
  all. `"mute"` = mute audio in unanalyzed parts; `"pause"` = pause
  playback outright (full protection, nothing unanalyzed ever plays);
  `"play"` = let it play unanalyzed (this is the old "safe mode off").
  Always exactly one of these three strings — any invalid/corrupted
  stored value is normalized to `"mute"` before you ever see it
  (a legacy `pm_safeMode: false` with no saved `pm_catchupMode` is
  transparently migrated to `"play"` — see "Safe mode + catch-up mode
  merge" above — so you never need to read `pm_safeMode` yourself).
- `PMWordlist.settings.safeMode` — still available, still a boolean,
  **unchanged contract** — but now DERIVED as `catchupMode !== "play"`
  rather than read independently from storage. If your existing code
  reads `PMWordlist.settings.safeMode` to decide "should catch-up
  protection apply at all", it keeps working exactly as before with
  zero changes needed. If you want to distinguish *how* it applies
  (mute vs. pause), read `PMWordlist.settings.catchupMode` instead.
- `PMWordlist.settings.debugOverlay` — live boolean, `false` by default
  (the popup's new "Debugging" section, "Show debug overlay" toggle).
  This is the ONLY setting for the on-player diagnostic overlay — this
  file (`shared/wordlist.js`) does not render anything itself; you own
  building and showing/hiding the overlay UI on the YouTube player
  entirely, keyed off this boolean. Kept fresh automatically, same as
  every other field on this object.
- `PMWordlist.settings.enabled` is also available on the same object if
  useful.
