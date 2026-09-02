# Profanity Muter - audio pipeline (as built)

Owner scope: `manifest.json`, `capture.js`, `content.js`, `background.js`,
`offscreen.html` + `src/offscreen-src.js` (bundled to `dist/offscreen.bundle.js`
via `build.js`), and `verify/`. `shared/wordlist.js`, `captions.js`, and
`popup/` are owned by another agent working in the same tree.

## Design principle: MINIMAL FOOTPRINT (governs 0.1.13 and everything after)

The extension should be as invisible to YouTube as possible; avoid anything
that pattern-matches bot behavior unless absolutely necessary.

- **Passive first.** Interception (the `appendBuffer` copy in `capture.js`)
  and DOM reading are invisible - fine, unrestricted. Anything that MUTATES
  player/network state (SourceBuffer eviction, micro-seek nudges,
  programmatic seeks, quality changes) is a LAST RESORT: rate-limited (a few
  per minute max), and only triggered when the user's actual experience is
  genuinely blocked - never speculative/precautionary. Where a non-mutating
  option (e.g. content.js's muted-playback fallback ladder) and a mutating
  one (capture.js's capture-miss eviction) could both resolve the same
  problem, prefer the non-mutating one and let it go first; the mutating one
  is only reached if that alone didn't work (see 0.1.13's eviction
  redesign - gated on content.js's 15s stall watchdog, which fires strictly
  after the 8s pause->mute fallback has already had its chance).
- **No extra requests to YouTube endpoints** from the extension at runtime -
  no `timedtext`/innertube fetches in the shipped path. Caption correlation
  (`verify/caption_correlate.mjs`) stays a dev-side verification tool only,
  run manually against a pasted log + a captions JSON fetched by a human in
  a real browser tab - never called from the shipped extension code.
- **No high-frequency property writes that could look synthetic.** The
  per-tick `video.muted` re-assertion (0.1.12's mute-fight fix) is fine - a
  local element property, not something that touches player/network
  behavior. Anything that DOES touch player behavior (the eviction nudge's
  micro-seek) stays inside the tightly-rate-limited, last-resort path above,
  never at tick()'s cadence.
- **Verification stays human-paced** - one video at a time, seconds between
  actions, back off on any sign of rate-limiting/errors from Google's CDN.

## Architecture

```
capture.js (MAIN world, document_start)
  patches MediaSource.prototype.addSourceBuffer / SourceBuffer.appendBuffer
  -> window.postMessage({type:'segment', videoId, mime, isInit, bytes,
                          currentTime, bufferedEnd}) per append
  -> window.postMessage({type:'reset', videoId}) on video-id change
     (yt-navigate-finish + 1s poll fallback) or SourceBuffer.changeType

content.js (isolated world, document_start; after shared/wordlist.js)
  relays segments -> background.js via chrome.runtime.connect port
  (bytes base64-encoded; port.postMessage does not reliably structured-clone
  large ArrayBuffers across the isolated/background boundary in practice)
  receives {type:'words', videoId, words, windowStartS, windowEndS}
  -> clamps per-word duration, runs PMWordlist.findMatches (or per-word
     isProfane fallback), builds padded/merged mute intervals
  -> merges [windowStartS, windowEndS) into a persistent per-video
     coveredIntervals set (survives seeks; only a real video-id change resets it)
  -> proactively arms setTimeout for each interval's start/end (re-armed on
     seek/ratechange), with an rAF loop as backstop for safe-mode coverage
     boundaries and drift
  -> stall watchdog: 15s of no coverage growth while playing an uncovered
     region -> sends {type:'restart'} to background

background.js (MV3 service worker; expendable, holds no session state)
  owns the offscreen document lifecycle (chrome.offscreen.createDocument,
  re-created on demand - this is what makes it safe for the SW to idle/respawn)
  routes segment bytes / reset / restart / config from each tab's port to
  the offscreen doc via chrome.runtime.sendMessage, and routes transcript
  results back to the right tab's port by tabId
  reads chrome.storage.sync (pm_model) and forwards it as 'pm-config' - the
  offscreen doc has no chrome.storage access of its own

offscreen.html -> dist/offscreen.bundle.js (esbuild bundle of src/offscreen-src.js)
  transformers.js Whisper pipeline (Xenova/whisper-tiny.en default,
  Xenova/whisper-base.en selectable via pm_model - both confirmed to ship
  alignment_heads in generation_config.json, i.e. both support word timestamps)
  mediabunny for streaming WebM/Opus (+ MP4/ADTS) demux + WebCodecs decode
  runs rolling ~18s windows (2s overlap) ahead of the playhead, word timestamps on
```

## Data model: "runs", not one endlessly-growing buffer

Early version accumulated every appended segment for a video into one
single growing byte buffer and fed the whole thing to mediabunny each time.
That's correct for continuous playback (spike-capture confirmed individual
segments don't decode standalone - the *cumulative* stream since init is
what's needed), but breaks on a big forward seek: YouTube starts a **fresh
SourceBuffer with a fresh init segment** for the new position, and its
internal cluster timestamps do not reliably continue the old absolute
timeline (observed: sometimes they do, sometimes the new run's own clock is
what YouTube ends up using - see below).

Fix: bytes are grouped into **runs**, one per init segment (`capture.js`'s
per-SourceBuffer `segmentCount` reset already tells us which append is
`isInit`). Each run gets its own mediabunny `Input`. A run's local
(possibly-near-zero) timestamps are converted to absolute video time via
`run.timeOffset`, resolved **adaptively** on the run's first successful
decode: if the first decoded sample's timestamp is already close to the
run's anchor (`video.currentTime` observed when the run started), the
stream is already absolute and offset=0; otherwise offset = anchor − firstLocal.

**Anchor-capture bug found and fixed during verification**: freezing the
anchor at the exact moment the init segment was appended sometimes caught a
*transient* `currentTime` (e.g. mid-seek, or during an ad→content element
swap) - a post-seek run got anchored at ~0 instead of the real seek target,
so windows kept re-covering `[0, 9.6)` etc. instead of the target region.
Fix: keep refreshing `run.anchorTime` from every segment appended to that
run until the offset is actually resolved (first decode), not just the
first one. Confirmed fixed: after seeking to t=50 on the regression video, the
run correctly anchored near 48–58s instead of restarting at 0 (see Evidence).

Per-video `coveredIntervals` (merged `[start,end]`, not a single scalar) are
tracked independently in content.js and are **not cleared on seek** - only a
genuine video-id change (RESET from capture.js) clears state. This matches
the "seek keeps everything" requirement: safe mode mutes only inside an
actually-uncovered interval, wherever the playhead jumps to.

## Muting: padding, clamping, proactive scheduling

- Per-word duration is clamped to 1.0s before padding (Whisper/transformers.js
  timestamp smear across pauses was observed live: e.g. a "you." token timestamped
  as 16.12s long). Clamping happens in content.js, per raw transcribed word,
  before matching/padding.
- Matched intervals are padded **asymmetrically**: 0.35s lead / 0.25s trail
  (leading pad increased from an initial symmetric 0.25/0.25 after a report of
  hearing the first half of a word).
- Muting is armed **proactively** via `setTimeout` against each interval's
  start/end (computed against `video.currentTime`/`playbackRate`, re-armed on
  `seeking`/`ratechange`), not just polled from an rAF loop - this removes
  dependence on rAF cadence/tab-throttling for exact onset timing. The rAF
  loop remains as a backstop for safe-mode's continuously-changing coverage
  boundary and for drift recovery.
- `seeking` handler also **synchronously** checks safe-mode coverage and
  engages mute immediately (not waiting for the next rAF tick or an armed
  timer), closing a ~1s unmuted gap observed right at the instant of a big
  forward seek before the async paths caught up.

## Word matching

content.js prefers `PMWordlist.findMatches(words) -> [{index,length}]`
(phrase-aware, owned by the wordlist agent) and falls back to per-word
`PMWordlist.isProfane` if `findMatches` isn't present. Raw Whisper token text
is passed through **unmodified** (no asterisk-stripping, no punctuation
pre-processing) so a censored/asterisked ASR output like `s***` reaches the
wordlist matcher exactly as transcribed.

## Robustness

- **Service worker respawn**: background.js holds no session state (bytes,
  coverage, dedupe all live in the offscreen doc), so an MV3 SW idle-kill and
  respawn is a non-event - `ensureOffscreenDocument()` verifies via
  `chrome.runtime.getContexts` before creating, and content.js's port
  reconnects with backoff on disconnect.
- **Stall watchdog**: if safe mode is muting an uncovered region and coverage
  hasn't grown in 15s while actually playing, content.js sends `restart`;
  background forwards `pm-restart` to offscreen, which force-clears a
  session's `processing`/`pendingRerun` flags and re-kicks `maybeProcess`.
  Confirmed firing correctly in testing (see Evidence) without a restart storm
  once the coverage-interval bug below was fixed.

## Findings / bugs discovered during verification (not all mine to fix)

1. **Extension-profile caching trap (my harness, fixed)**: reusing the same
   Playwright persistent-profile directory across code edits made Chrome keep
   running a **stale cached service worker** despite `--load-extension`
   reading `capture.js`/`content.js` fresh from disk each launch - a whole
   round of edits to `background.js` had zero effect for several verification
   runs (this is what produced the earlier "coverage=[] always" and
   "muted=0 everywhere" reports). Root-caused by adding a canary
   `console.log` to `background.js` and observing it never printed against
   the reused profile, but did print immediately with a version bump / fresh
   profile. Fix: `verify/run_playwright.mjs` now uses `fs.mkdtempSync` for a
   fresh profile every run (`PM_REUSE_PROFILE=1` opts back into a fixed one
   for fast local iteration once the code is trusted stable). **Real-world
   implication**: anyone iterating on this extension's `background.js` in a
   loaded/pinned profile should hit "Reload" in `chrome://extensions` (or bump
   `manifest.json`'s `version`) after every edit - don't trust that
   `--load-extension`/an existing profile picks up service-worker changes.
2. **`shared/wordlist.js` `pm_wordlist` custom-list bug (not mine, reported to
   the wordlist agent)**: `refresh()` calls
   `chrome.storage.sync.get({pm_enabled: true, pm_wordlist: undefined, pm_safeMode: true}, cb)`.
   Evidence from a live page: `chrome.storage.sync.get(null, ...)` correctly
   returns `pm_wordlist:["college","connected","dots"]`, but
   `PMWordlist._state.wordlist` still holds the built-in `DEFAULT_WORDLIST`
   moments later on the same page. A default value of `undefined` for a key
   in the "object of defaults" form of `chrome.storage.get` appears to make
   that key drop out of the request (likely dropped during argument
   serialization, the same way `JSON.stringify` drops `undefined`-valued
   keys), so `items.pm_wordlist` is always `undefined` regardless of what's
   stored. **Any custom `pm_wordlist` currently has no effect** - only the
   built-in default list is ever used. Workaround used for verification:
   scenario 1 (clean speech, needed custom test words) could not exercise
   word-triggered muting because of this; scenario 2 uses a real profane word
   already in `DEFAULT_WORDLIST` ("fucking") to sidestep it entirely.
3. Not independently verified but worth flagging: this task's `pm_muteAudio`
   setting is read via `PMWordlist.settings` if present (owned by the
   wordlist/popup agents), falling back to a direct `chrome.storage.sync` read
   of `pm_enabled`/`pm_safeMode`/`pm_muteAudio` - if the wordlist agent's
   `PMWordlist.settings` shape differs from `{enabled, muteAudio, safeMode}`
   this will silently fall through to the (currently-broken, see #2)
   fallback path instead. Re-check once both land.

## Evidence (real Playwright runs against live YouTube, fresh profile each run)

**Scenario 1** - Steve Jobs 2005 Stanford speech
(`https://www.youtube.com/watch?v=UF8uR6Z6KLc`): play → seek forward to
t=220 (past all buffered/covered content) → seek backward to t=8 (into
already-covered content).

```
[PM] MUTE engaged t=0.00 reason=safe-mode-uncovered
[PM] MUTE released t=6.66 reason=covered-and-clear (was: safe-mode-uncovered)
... seek to t=220 ...
[PM] MUTE engaged t=220.00 reason=safe-mode-uncovered      <- no unmuted gap after this fix
[PM] MUTE released t=8.00 reason=covered-and-clear (was: safe-mode-uncovered)
... seek to t=8 (backward, into already-covered region) ...
```
Post-forward-seek samples: `muted:true` from the very next sample onward (no
unmuted playback observed inside the uncovered region). Post-backward-seek
samples: `muted:false` from the first or second sample (coverage already
existed there from the initial play - no re-mute needed, "plays instantly").

**Scenario 2** - regression video (`o-7Fvkq-Nug`, reported "shit" ~64s missed),
cold seek to t=50 before any coverage exists there:

```
[PM] seek detected -> t=50.00
[PM] MUTE engaged t=50.00 reason=safe-mode-uncovered
[PM] window start=48.00 end=58.72 ... text=[I'm going to do this, don't listen to
     him. I think he's going to get me trapped. Yeah, but that's why he was
     fucking moving. Why are you over here? I don't know, it's okay. Why are
     you in your seat?]
[PM] MUTE released t=50.06 reason=covered-and-clear (was: safe-mode-uncovered)
[PM] MUTE engaged t=53.42 reason=word:fucking interval=[53.43,54.61) word=fucking
[PM] MUTE released t=54.61 reason=interval-ended:fucking (was: safe-mode-uncovered)
```
This is the end-to-end proof: cold seek past all existing coverage → capture
correctly demuxes the new run and anchors it near the real seek target
(48–58.72s, not 0) → real profanity ("fucking") is transcribed, matched, and
muted for exactly its own interval, released right after.

**Not yet confirmed**: "shit" specifically at ~64s. The video being tested
(seemingly a paintball/tag game, not narration) plays at least one pre-roll
and mid-roll ad that ignore `video.currentTime` assignment, and this specific
verification run hit a live-page reset (currentTime snapped back to 0,
readyState 0) shortly after t=58.78 before reaching t=64 - external YouTube
flakiness (likely another ad or a genuine player reload under the CPU load of
real-time transcription), not a pipeline bug we could isolate further in the
time available. The stall watchdog correctly fired ("[PM-STALL] no coverage
growth for 15000ms ... requesting pipeline restart") when this happened.
Re-run with a longer budget and/or `PM_S2_PLAY_MS` bumped further to get
past this specific video's ad load is the natural next step; the mechanism
proven above ("fucking" at 53.42) is not expected to behave differently for
"shit" at 64s once the pipeline reaches that timestamp cleanly.

## RTF / lag numbers (Xenova/whisper-tiny.en, fp32, wasm, real runs)

| window size | wall time | RTF (wall/audio) |
|---|---|---|
| 9.60s | ~1.5–7.1s | 0.09–0.36 (first window of a run is slower - cold pipeline path) |
| 18–19s (steady state) | ~1.6–2.6s | 0.13–0.29 |
| short tail windows (<2s) | ~1.4–4.4s | can exceed 1.0 (fixed overhead dominates on tiny windows - not a throughput concern since these only happen at coverage boundaries) |

`lagMs` (segment-captured-to-words-available) observed 1.4s–6.9s, consistent
with the transcribe wall time plus queueing behind prior windows - well
within YouTube's 10–35s pre-buffer lookahead (per spike-capture), so the
pipeline comfortably stays ahead of the playhead once caught up.

## Round 2: offset drift, catch-up mode, resync (post-live-user-report)

Live user testing on `o-7Fvkq-Nug` surfaced three symptoms the coordinator
correctly diagnosed as one root cause: a wrong `run.timeOffset` shifts every
word in that run - "fuck slipped through" (real profanity mapped to a video
time later than where the mute interval landed), "mute fires too early"
(interval mapped earlier than the real word), and "safe mode mutes forever"
(coverage intervals land away from the playhead, so `isCovered(currentTime)`
is never true). Changes made:

- **[PM-ANCHOR] / [PM-DRIFT] logging + self-correction** (`offscreen-src.js`,
  `transcribeRunWindow`): every run's offset resolution now logs
  `anchorTime`, `firstLocal`, `chosenOffset`, and the absolute-vs-relative
  verdict. After computing a window's predicted absolute span, it's
  cross-checked against two independent ground-truth signals from
  capture.js - the span can't start before `run.anchorTime` (when the run
  began) and can't end after `s.bufferedEndS` (what's actually been
  fetched). A violation beyond 0.5s recomputes `run.timeOffset`, re-maps
  that window's own words before sending them, clears the run's coverage/
  dedupe so far, and sends a new `pm-invalidate` message so content.js drops
  its (wrong) schedule and coverage - safe mode's default (mute while
  uncovered) protects the gap until corrected words arrive. A 3s cooldown
  per run prevents oscillation when the *ground truth itself* is churning
  (see Playwright confound below) rather than the offset being stably wrong.
- **Stall-watchdog restart now re-resolves the offset**: previously a
  restart only unstuck a wedged `processing` flag, so a stall caused by a
  bad offset (coverage never reaching the playhead) would fire forever
  without ever fixing the actual cause. It now also nulls
  `run.timeOffset`/clears `run.localCovered` and re-anchors to the current
  `s.currentTimeS` before re-kicking `maybeProcess`.
- **Resample diagnostic redone**: the first version compared `float16k.length`
  against a value derived from the *same formula*, so it could never fail -
  worthless. Replaced with `[PM-RESAMPLE]`/`[PM-RESAMPLE-WARN]`: logs
  `nativeRate` (warns if it isn't 48000, the normal Opus/WebM rate - a wrong
  rate here would make WebAudio's resampler silently stretch/shift the whole
  window) and cross-checks decoded buffers' own summed duration against
  their claimed timestamp span (gap/overlap in decode, independent of rate).
- **RMS energy check**: `rmsAt()` computes RMS over each transcribed word's
  own local (pre-offset) span from the exact PCM handed to Whisper - a cheap
  signal for whether *Whisper's own within-window timing* is plausible
  (near-silence under a word means Whisper mistimed it), independent of our
  run-offset math entirely. Logged as `[PM-ENERGY]` for any word under a
  0.01 RMS threshold.
- **Default model tiny -> base**: live console output showed severe
  word-timestamp smear on `whisper-tiny.en` for noisy multi-speaker content -
  dozens of CLAMP warnings/minute, some "words" reported 5-15s long. Switched
  `DEFAULT_MODEL` to `Xenova/whisper-base.en` (confirmed to ship
  `alignment_heads`, so word timestamps are supported); RTF headroom easily
  covers this even at ~3x its tiny-model cost. `pm_model` can still select
  `tiny`. **Not yet re-verified against the live smear reports** (see gaps).
- **Port-drop resync**: content.js now sends `{type:'resync'}` on every
  connect (first connect and reconnects alike). Background forwards it to
  offscreen as `pm-resync`, which now retains `run.allWords` (every word ever
  emitted for the run, in absolute time) and replies with the full word list
  + covered intervals; content.js's `handleResync` replaces (not merges) its
  schedule/coverage from that snapshot. This closes the gap where words
  computed while a port was down (SW idle-killed mid-transcription) would
  previously just be silently lost - background pushes were fire-and-forget
  with no retry.
- **`pm_catchupMode` ("mute" | "pause" | "play")**: on entering an uncovered
  region, "pause" calls `video.pause()` and shows a minimal "Analyzing
  audio…" overlay instead of muting, auto-resuming (`video.play()`) once
  coverage catches up; "play" is the merged safe-mode-off state. Ownership
  tracking (`catchupPausedByUs` + `suppressNextPauseEvent`/
  `suppressNextPlayEvent` guards around our own pause()/play() calls) means
  any pause/play we didn't initiate immediately releases our claim - never
  fights a user action. Word-level muting is unaffected by this setting and
  always uses mute. The setting merges with safe-mode per the wordlist
  agent's contract: `PMWordlist.settings.safeMode` is still read as a
  derived legacy boolean (`catchupMode !== "play"`) so nothing else in this
  file needed to change; the chrome.storage fallback derives the same way
  from whichever of `pm_catchupMode`/`pm_safeMode` is present.

### Playwright verification confound: ad storms in a logged-out profile

Re-verifying the offset fix against `o-7Fvkq-Nug` at t=55 and t=2540 in a
fresh (logged-out) Playwright profile hit heavy, repeated ad insertion -
each ad transition creates a brand-new demux "run" anchored near t=0, so
`s.currentTimeS`/`s.bufferedEndS` (the drift check's ground truth) were
themselves churning every few seconds. The [PM-DRIFT] correction logic
appears to behave sensibly given the ground truth it's fed each time (it's
not obviously miscomputing), but the resulting log volume/oscillation from
several back-to-back short ads made it hard to distinguish "working as
intended against churning ground truth" from "genuinely still buggy". Per
the coordinator, this is expected to mostly disappear against a real,
logged-in Chrome profile (fewer/no ads), which is the next verification
step (via `claude-in-chrome`, see below) - **the deep offset/smear diagnosis
at t≈55-75 and t≈2540-2560 has not yet been re-confirmed clean** as of this
writing; that is the immediate next step once the extension reload is
confirmed.

Also fixed along the way: `verify/run_offset_check.mjs` (new harness for this
round) initially tried `page.evaluate(() => chrome.storage.sync...)` on the
YouTube tab itself - `chrome.storage` is only reachable from an
extension-context page (background/offscreen/a `chrome-extension://` page),
never from a regular page's `page.evaluate`, even with a content script
injected into it. Fixed by routing all storage writes through a
`chrome-extension://<id>/popup/popup.html` page, same pattern as the
existing seeding helper in `run_playwright.mjs`.

### Verification workflow change

Real-user testing found the fresh/logged-out Playwright profile's ad load on
this specific video unrepresentative and noisy for this diagnosis. Per the
coordinator, regression scenarios on real videos now go through
`claude-in-chrome` driving the user's own logged-in Chrome profile (new
background tab, `video.volume=0` so playback stays silent while `.muted`
stays fully observable, `read_console_messages` filtered to `[PM`) - Playwright
remains for fast logic iteration where ads don't matter (scenarios 1/2 above
still pass there). Each code change to `background.js`/`content.js`/
`dist/offscreen.bundle.js` needs a manual Reload in `chrome://extensions`
before it's visible to the real-Chrome workflow (neither this agent nor MCP
can trigger that reload) - `manifest.json` is bumped to 0.1.4 as of this
writing to make the pending reload unambiguous.

## Round 3: real-Chrome regression findings

Testing against the user's real (logged-in, ad-free) Chrome profile via
`claude-in-chrome` surfaced two more real bugs, both now fixed, plus one
architectural gap not yet fixed:

- **Fixed: `tick()`'s mute-release could get permanently stuck.** Release
  conditions were gated on matching a stored `muteReason` string
  (`'safe-mode-uncovered'` vs `'word:X'`). `engageMute()` has an early-return
  guard once `session.forcedMute` is already true (so it never clobbers
  `prevMuted`) - which meant if a word-hit interval started while ALREADY
  forced-muted for `safe-mode-uncovered` (very plausible: dense speech right
  after a cold seek lands in a still-uncovered region), the reason string
  never updated to `'word:X'`. Once BOTH the word interval and the uncovered
  region had actually ended, neither release branch's string-match fired,
  and the video stayed muted indefinitely. Rewrote `tick()` to compute a
  single `shouldMute = muteAudio && (hit || uncovered)` and release purely
  on that going false - `muteReason` is now informational/logging only,
  never a gating condition. Reproduced live: coverage caught up seconds
  after landing on a cold seek to t=2530, but the video stayed muted for
  the rest of the observed session before this fix.
- **Fixed: raw transcript text was invisible from a real page/tab.**
  Discovered while trying to verify whether "fuck" actually appears in the
  transcript near t≈2549: background.js/offscreen's `[PM] window ...
  text=[...]` log lives in the service worker / offscreen document console,
  which is architecturally a *different* console than the page's - any
  tool (or a user's own DevTools opened on the YouTube tab) that reads
  console output from the tab itself will never see it. `content.js`'s
  `addWords` now also logs the full `text=[...]` word list alongside its
  existing word-count summary, so the actual transcript is visible from the
  tab console too.
- **Fixed: port-disconnect log downgraded `console.warn` -> `console.log`.**
  The ~30s SW idle/respawn cycle (see architecture notes) is normal and
  expected, not warning-worthy - logging it as a warning was polluting the
  extension's Errors page in `chrome://extensions`, which surfaces
  `console.warn`/`console.error` from any context.
- **Not fixed - architectural gap, demux cost scales with total run
  length.** Reproduced live: a tab that had been continuously playing one
  video for ~25 minutes (one long unbroken demux "run", no ad/init-segment
  breaks) had its pipeline go completely silent after a backward seek into
  early, previously-covered territory - two `[PM-STALL]`-triggered
  `[PM-DRIFT]` invalidations 15s apart, then no further progress for 90+s
  (confirmed via a `pm-resync` reply showing 273 accumulated words but 0
  covered intervals), leaving the video muted continuously for 3+ minutes.
  Root cause: `transcribeRunWindow` reconstructs a fresh `mediabunny.Input`
  from the ENTIRE accumulated run buffer on every single window attempt -
  cost grows with total run length, so on a long-running video each attempt
  can take longer than the 15s stall-watchdog timeout, which then restarts
  it before it ever finishes (a self-defeating loop). This is a genuinely
  different failure mode than the original bug reports (indefinite
  over-mute vs. the original silent slip-through) - arguably a safer
  failure direction, but still a real usability problem for long videos.
  Fix would be either capping/windowing what's hand to mediabunny per
  attempt (e.g. only feed the tail of the buffer needed for the current
  window plus its own init segment) or caching the `Input`/track object
  across calls instead of rebuilding it from scratch each time.
- A backward-seek-in-a-long-running-tab scenario is also a good stress
  test for whether `run.timeOffset`'s absolute/relative resolution still
  holds after a very long run - not distinguishable from the above stall
  in this pass; worth revisiting once the demux-cost fix lands.

## 0.1.6: persistent streaming demux + heartbeat-aware stall watchdog

Fixed the "demux cost scales with total run length" gap flagged above -
this is not a rare edge case for this user (routinely watches long videos
with heavy skipping), so it graduated from "known gap" to "must fix":

- **`offscreen-src.js`: a run's mediabunny `Input`/track/`AudioBufferSink`
  are now created ONCE per run and reused for every window attempt**,
  instead of slicing the entire accumulated byte buffer and constructing a
  fresh `Input` from scratch every single call. Bytes are fed in via
  `mediabunny.ReadableStreamSource` (designed for exactly this - an
  append-only, growing stream of unknown final length) with a generous
  64 MiB cache (`RUN_STREAM_CACHE_BYTES`), since our access pattern isn't
  strictly sequential (seeks jump the requested window around within a
  run). Cost per attempt is now bounded by the WINDOW being decoded, not
  the run's total length so far. `run.buffer`/`run.len` and the manual
  doubling-buffer logic are gone entirely.
- **Heartbeat-aware stall watchdog**: `maybeProcess` now sends a
  `pm-heartbeat` (immediately, then every 4s) for as long as it's actively
  working, relayed by background.js to content.js's port. The watchdog in
  `tick()` now requires BOTH no coverage growth AND no recent heartbeat
  before firing (`coverageStale && heartbeatStale`), so a merely slow
  attempt (large window, cold model load, CPU contention) is no longer
  killed before it can finish.
- **`pm-restart` no longer disturbs a genuinely in-flight attempt**: it now
  checks `s.processing` first and, if true, logs and returns without
  touching any state. The previous version unconditionally reset
  `run.timeOffset`/`localCovered` and re-kicked `maybeProcess` even if the
  original call was still awaiting deep inside `transcribeRunWindow` - that
  in-flight promise doesn't get cancelled, so it would keep running
  to completion in parallel with a freshly-started loop, both mutating the
  same run's `localCovered`/`timeOffset` concurrently. Since content.js now
  only sends `restart` when both signals are stale, an in-flight attempt at
  restart time should be rare, but the check makes it safe either way.
- Not yet re-verified live (needs another real-Chrome pass): whether this
  actually resolves the 25-minute-long-run stall reproduced in Round 3, and
  whether `ReadableStreamSource`'s "not great with random access" caveat
  (per mediabunny's own docs) causes any issue for the specific
  seek-backward-into-old-territory pattern that triggered the original
  bug - the 64 MiB cache should keep old data resident, but this is
  untested at real scale.

## 0.1.6 final verification: blocked by an external YouTube CDN outage

Attempted the full final pass (region A t≈55-75, region B t≈2540-2560,
pause-catchup check, long-run stall re-test) in a fresh background tab
post-reload, per the standing constraints. Region A repeatedly got stuck at
`readyState=0` (HAVE_NOTHING) forever after any seek, on ANY video -
confirmed via `read_network_requests`: `videoplayback` requests to Google's
CDN were returning **HTTP 503** repeatedly, including on a completely
unrelated, always-reliable test video (`jNQXAC9IVRw`, "Me at the zoo") with
no seek involved at all. This is an external network/CDN issue, not an
extension bug - nothing in this codebase touches or could cause an HTTP 503
from `googlevideo.com`. Stopped there rather than continuing to debug a
problem that isn't in this code; the final clean pass on 0.1.6 (both
regions, pause-catchup, long-run stall recovery) is still outstanding and
should be re-attempted once playback is confirmed working normally again.

## 0.1.7: debug overlay + calibration offset (for the "off by one word" report)

New user report: on profanity-heavy content, mutes sometimes land on the
word adjacent to the actual swear (before or after - user isn't sure which),
a small sub-second systematic offset, distinct from the earlier large-offset
bugs. Candidate causes not yet distinguished: Opus pre-skip/priming samples
shifting the decode timeline, window-slice/rounding at run boundaries,
anchor-resolution rounding, or Whisper's own word-start bias on plosives.
Per "measure first, don't guess," added the instrument rather than a blind
correction:

- **`pm_debugOverlay`** (bool, default false; popup toggle owned by the UI
  agent) renders a compact, `pointer-events:none` panel over the player,
  updated ~4Hz (own `setInterval`, independent of `tick()`'s rAF loop so it
  keeps working even with muting disabled): current `t`, coverage status,
  a ±5s strip of RAW transcript words (not just matches) with each word's
  `[start-end]`, the word currently under the playhead highlighted, and
  matched/muted words flagged in red - plus the next few upcoming scheduled
  mute intervals. The intent: the user watches a word highlight and compares
  that moment to when they actually hear it spoken, to read off lead/lag
  directly.
- Backing data: `session.allWords` now tracks every raw transcribed token
  (not just profanity matches) near the playhead, deduped by
  word+rounded-start and capped at 600 entries (the overlay only ever needs
  a ±5s window; this just bounds memory for long sessions).
  `applyWordsToIntervals` now returns `{intervals, tokens}` instead of just
  `intervals` - `tokens` carries a `matched` flag per word for the overlay's
  highlighting (`handleResync` updated for the new shape too).
- **`pm_timeOffsetMs`** (number, default 0): a manual calibration knob,
  applied uniformly to every token's start/end in `applyWordsToIntervals`
  before clamping/matching/padding. Stays 0 until the overlay above
  produces an actual measured value - not applied speculatively.
- Both are read directly from `chrome.storage.sync` (not through
  `PMWordlist.settings`) since they're debugging-only knobs specific to this
  file, not part of the wordlist agent's settings contract.
- **Not yet measured**: the actual offset value, if any. Needs a live
  session with the overlay on and a human confirming lead/lag by ear.

## 0.1.7 verification: blocked again, this time by a tooling/CDP artifact

Resumed at the requested human pace (fresh tab, seconds between actions).
Hit a different blocker than the CDP 503s, and spent real effort isolating
it before giving up on this pass: `javascript_tool`'s `document.querySelector('video')`
consistently reported `t=0, readyState=0, paused=false` for the entire
session - through an initial load, an explicit `location.reload()`, and
long waits - while `computer` screenshots of the SAME tab, taken seconds
apart, showed the video genuinely playing and advancing normally (e.g.
25:04 -> 25:34 across a ~30s gap, captions changing correctly). A direct
`document.hidden`/`visibilityState` check confirmed the tab was correctly
backgrounded (`hidden: true`) per the standing "never steal focus" test
constraint, which explains real playback continuing while JS-observed state
looked frozen - but does not explain the two data sources (live JS
evaluation vs. screenshot capture) disagreeing about the actual `<video>`
element's `currentTime`/`readyState`. This reads as the automation tool's
`Runtime.evaluate` binding to a stale/detached execution context for this
tab (plausible given YouTube's SPA does in-place DOM swaps that don't always
look like a "navigation" to a CDP session) rather than a bug in this
extension - `MediaSource.prototype.addSourceBuffer` patch-presence checks
earlier in the same session did read real, live state correctly, so JS
execution isn't uniformly broken, just this specific `<video>` element
query. Did not find a way to un-stick it in the time available (a full
`location.reload()` did not resolve it). The outstanding verification
(regions A/B, pause-catchup, long-run stall recovery, offset measurement via
the new debug overlay) is still not completed as of this writing - next
attempt should try a brand-new tab group from scratch (not reusing a
group that has seen an earlier stuck tab) and verify the JS-vs-screenshot
state agrees BEFORE running any scenario.

## 0.1.8: two more root causes (multi-`<video>` element + anchor-lags-lookahead)

Both diagnosed from real user measurement, not guessed:

- **`getVideo()`/capture.js's video lookup fixed.** `document.querySelector('video')`
  returns the FIRST `<video>` in DOM order - on a YouTube watch page there can
  be more than one (inline-preview player from SPA navigation, miniplayer
  remnants, ad-player variants), and the first one can be a dormant element
  (readyState 0, frozen currentTime) while the REAL player plays elsewhere,
  unmuted and unmonitored. This was independently found while chasing what
  looked like a tooling artifact during verification (JS reads said
  `t=0, readyState=0` while screenshots showed real advancing playback) -
  turned out to be a real bug, not a CDP quirk. Both `content.js` (`getVideo()`,
  now cached + invalidated on `yt-navigate-finish`) and `capture.js`
  (`getRealVideo()`, used for the `currentTime` read on every `appendBuffer`)
  now prefer `#movie_player video.html5-main-video`, falling back to the
  largest-rendered-area element with `readyState > 0` (or largest overall if
  none have data yet). This is a plausible independent contributor to
  "identified but not muted" reports - capture.js's own `currentTime`
  readings (used for anchoring and drift ground truth) would have been wrong
  whenever a dormant decoy element was selected.
- **Anchor-to-`currentTime` made new runs late by the buffering lookahead.**
  User measured it directly with the debug overlay during continuous
  playback: the word actually being heard consistently appeared several ROWS
  AHEAD (i.e. at a LATER claimed timestamp) in the word strip than the
  live-highlighted word - the transcript's timestamps run seconds ahead of
  true video time, so mutes fire seconds after the swear already played.
  Root cause: a run's anchor was `video.currentTime` at the moment its init
  segment was appended - but YouTube buffers ahead of the playhead (10-35s
  per spike-capture), so `bufferedEnd` at that same moment is already several
  seconds ahead of `currentTime`. For a run whose internal cluster clock is
  itself absolute (matches spike-capture's finding for the normal case),
  anchoring at the smaller `currentTime` instead of the true, larger
  `bufferedEnd` position biased the whole run's offset resolution - and
  because a fresh MediaSource/SourceBuffer (a new "run") gets created not
  just on user seeks but on ordinary ad boundaries, quality switches, and
  manifest refreshes during long continuous viewing, this happens
  repeatedly throughout a normal watching session, matching exactly the
  reported "continuous playback only" symptom (the seek-based test harness
  scenarios never showed it, because right after a cold seek
  `currentTime ≈ bufferedEnd` anyway - the error is ~0 in exactly the case
  already tested).
  - Fix: `capture.js` now also snapshots `buffered.end()` **before** calling
    the original `appendBuffer` (`prevBufferedEnd`) and sends it alongside
    `currentTime`. `offscreen-src.js`'s new `pickAnchorCandidate(currentTime,
    prevBufferedEnd)` prefers `prevBufferedEnd` when it's a sane
    forward-looking value (`>= currentTime` and within 60s of it - MSE
    guarantees new bytes extend the buffered range starting exactly there),
    falling back to `currentTime` when it isn't (empty/stale buffered range,
    e.g. immediately after a big seek before the old range clears) - which
    keeps the already-verified seek-case behavior intact.
  - `[PM-ANCHOR]` now also logs `bufferedEndS` and the anchor-vs-bufferedEnd
    delta, so this specific class of error is directly auditable going
    forward.
  - `pm_timeOffsetMs` is kept as a residual/manual calibration knob only -
    per-run error varies with the lookahead at that run's start, so a global
    constant can't fix it; this is a structural fix, not a leaned-on
    workaround.
  - The drift cross-check's `tooEarly` bound (`videoStartS < run.anchorTime
    - slack`) was previously not independent of this bug - a wrong,
    currentTime-based anchor would make the check "self-consistently" pass
    even though both were wrong the same way. Now that the anchor is
    computed from stronger evidence (bufferedEnd-before-append), that bound
    is meaningfully independent again. Not otherwise restructured - the
    `tooLate` bound (against `s.bufferedEndS`) was already independent and
    unaffected by this bug.
- **Not yet re-verified live**: whether this actually closes the gap the
  user measured with the overlay (transcript now tracking audibly-current
  word within a few hundred ms during continuous, unseeked playback), and
  whether the fixed `getVideo()` changes anything for the still-outstanding
  region A/B/pause-catchup/long-run scenarios.

## 0.1.9: replace the offset GUESS with measured arithmetic (strategic redirect)

0.1.8's `currentTime`-vs-`bufferedEnd` heuristic still left the user "wildly
unsynced," and their actual scenario turned out to be YouTube's "continue
watching" resume-mid-video - where the run's local clock and true video time
diverge from the very first segment and the anchor conversion is doing 100%
of the work. Per the coordinator/user's direction: stop iterating heuristics,
make the whole timeline chain measurable, and replace the absolute-vs-
relative GUESS with arithmetic from two independent ground-truth
measurements, per segment, continuously - no `currentTime` involved in
anchoring at all anymore.

**The two measurements (both in `capture.js`, both from real evidence, not
inference):**
1. **The segment's own container timestamp** - a minimal recursive EBML
   scanner (`readVint`/`scanForTimecode`) walks the raw appended bytes
   looking for `Segment > Info > TimecodeScale` (read once, from the init
   segment, default 1e6 ns/tick per the Matroska spec) and the first
   `Cluster > Timecode` in the chunk, converted to seconds
   (`ticks * timecodeScale / 1e9`). This is `localTimeSec` - parsed directly
   from bytes, no decoder involved.
2. **The absolute video-time span this segment landed at** - `findGrowth()`
   diffs the AUDIO SourceBuffer's buffered ranges immediately before vs.
   after the `appendBuffer` call: either an existing range's `end` grew
   (`absStart` = old end, `absEnd` = new end) or, after a seek/resume before
   the old range clears, a brand-new range appeared (`absStart`/`absEnd` =
   its bounds, flagged `isNewRange`). MSE guarantees appended bytes extend
   the buffered range starting exactly where the growth is observed, so this
   is ground truth, not an inference.

**offset = absStart − localTimeSec**, computed fresh for every segment (not
just the init one), fed into a rolling median per run
(`recordOffsetSample`, `OFFSET_SAMPLE_WINDOW = 8`) rather than a one-shot
"resolve once and freeze" step. `run.anchorTime`, `pickAnchorCandidate()`,
the absolute-vs-relative tolerance check, and the old currentTime/bufferedEnd
-based `[PM-DRIFT]` "correction" are all deleted - there is nothing left to
guess or self-correct toward, since every sample is independently measured.
`currentTime` no longer participates in anchoring at all (only still used,
unrelated to offset, for `pickNextWindow`'s "where's the playhead in
run-local time" windowing math). `chrome.storage`'s `pm_timeOffsetMs` from
0.1.7 remains as a residual manual calibration knob.

**Full-chain-dump logging** (per the "make it inspectable" directive): every
`appendBuffer` call now logs one `[PM-CHAIN]` line in `capture.js` with
`currentTime`, the raw EBML `localTicks`/`timecodeScale`/`localTimeSec`, all
buffered ranges before AND after the append, the detected growth span, and
the resulting `measuredOffset` - everything needed to audit the arithmetic
by inspection, in one line, without cross-referencing multiple contexts.
`offscreen-src.js` mirrors this per-run with `[PM-OFFSET-SAMPLE]` (sample
offset, running median, sample count, variance - a high variance flags a run
whose measurements disagree with each other, worth a closer look).

**Also (item 3 of the redirect): confirmed video-element consistency.**
`capture.js` now logs a one-time `[PM-VIDEO-CHECK]` enumerating every
`<video>` element on the page and which one it chose (via the same
`getRealVideo()` lookup as content.js's `getVideo()` from 0.1.8), so the
0.1.8 dormant-decoy-element fix can be directly confirmed to be selecting
consistently, in the same log stream as the chain dump.

**A window with no measured offset yet is skipped, not guessed.** If a run's
first segment(s) haven't yielded a `localTimeSec`/`growthAbsStart` pair
(would only happen if every fragment so far lacked its own Cluster - not
expected in practice), `transcribeRunWindow` logs and returns `false` rather
than transcribing with an unknown offset; it retries once more data arrives.

**Not yet verified live**: whether this closes the resume-mid-video gap the
user hit, and whether it holds up during genuinely continuous (non-seek,
non-resume) playback too. Needs a `[PM-CHAIN]`/`[PM-OFFSET-SAMPLE]` dump from
a real resume-point session read back for the actual numbers, plus a debug-
overlay recheck.

## 0.1.10: "media time in, media time out" - the real fix, plus a real EBML bug

The 0.1.9 measured-offset system still left the user "wildly unsynced," and
their scenario (a YouTube "continue watching" resume mid-video) pointed at
something deeper: the whole idea that runs need an OFFSET at all. Governing
principle adopted per the coordinator/user's explicit redirect: **the WebM
container is the only clock.** YouTube's audio SourceBuffer runs on the media
presentation timeline - the SAME timeline as `video.currentTime` (this is
literally spike-capture's original, very first finding: `buffered.end()`
tracks `currentTime` directly, no correction needed). mediabunny, decoding
the identical bytes via the identical container format, reports that exact
timeline in its `AudioBuffer.timestamp` values, untouched. So a decoded
window's own reported timestamp already **is** absolute video time -
`word_abs = window's own timestamp + word's offset within it`, full stop.

**Deleted entirely**: `run.timeOffset`, `run.offsetSamples`,
`recordOffsetSample`, `median`/`variance`, and every currentTime/bufferedEnd-
based anchor or "corrective" heuristic from 0.1.6-0.1.9. There is nothing
left to estimate. `currentTime` now participates ONLY in enforcement
(schedule arming, `isCovered(currentTime)` checks) - never in constructing a
timestamp. Coverage and word-dedupe moved from per-run to session-level
(`s.covered`, `s.allWords`) since every run's timestamps are already on the
same absolute timeline - a resume/seek starting a new run just contributes
to the SAME coverage tracker, no run-boundary bookkeeping needed.
`capture.js`'s buffered-range-growth measurement and EBML-parsed container
timecode are kept ONLY as a logged `[PM-CHECK]` cross-check (do the two
independent measurements roughly agree?) - never an input to any timestamp.

**A real, separate bug found and fixed while investigating "still
uncovered from t=0" reports on 0.1.9**: the EBML scanner's `walk()` bailed
out (`return`) on ANY element with EBML's "unknown size" sentinel *before*
checking whether it was a master element worth descending into. Live/
streamed Matroska Clusters very commonly use exactly that sentinel (the
encoder doesn't know a cluster's total size in advance) - so the scanner
was silently failing to find a Timecode in most real segments. Under the
0.1.9 design this meant `run.timeOffset` never resolved, every window was
skipped forever, and a real video sat permanently muted from t=0 with zero
visible symptom (the skip only logged in the offscreen document's own,
user-inaccessible console) - this is what the user was actually hitting.
Fixed: descend into any master element regardless of known/unknown size,
bounding an unknown-size element's scan at the enclosing scope's end. Under
0.1.10 this bug would only have affected the (now-deleted) offset machinery
and the `[PM-CHECK]` cross-check log, not timestamp construction itself -
but it's still fixed, since the cross-check needs to actually work to be
useful, and the underlying scanner logic error was real.

**Ad filtering (capture.js)**: ads run on a different media timeline than
the main content - the one legitimate case where a segment's container
timestamp is NOT on the video's presentation timeline. Segments are now
dropped at the source (never posted, never transcribed) when either the
player reports `ad-showing`/`ad-interrupting` on `#movie_player`, or the
parsed container timecode implausibly exceeds `video.duration + 15s`
(a backstop for ad-state detection gaps).

**Observability - nothing that can block coverage stays invisible again.**
Per the explicit rule this keeps re-biting the user: any state that can
block coverage indefinitely must surface in the TAB's own console, because
skip/stall reasons logged only in the offscreen document's or service
worker's console are invisible to the user and to any tab-scoped tooling.
- `notifyTab()` (offscreen) and `broadcastDiag()` (background.js and
  offscreen-src.js, for genuinely uncaught errors/rejections via
  `self.addEventListener('error'/'unhandledrejection')`) route diagnostics
  through a new `pm-diag`/`diag` message to the owning tab's port.
  `transcribeWindow`'s every `return false` path (no track yet, demux
  error, no decodable audio, sink error) now calls this instead of only
  logging locally.
- content.js's own `console.log/warn/error` calls all route through new
  `TLOG`/`TWARN`/`TERROR` wrappers that also append to a 1000-line ring
  buffer (`logRing`). capture.js (a separate MAIN-world JS realm - its
  console output is visible in the same DevTools console but cannot write
  into content.js's ring buffer directly) posts its own key lines
  (`[PM-CHAIN]`, `[PM-AD-SKIP]`, `[PM-VIDEO-CHECK]`, etc.) via a new
  `chainlog` message so they land in the same ring buffer too.
- **"Copy logs" button** on the debug overlay (`pm_debugOverlay`):
  `navigator.clipboard.writeText()`s the entire ring buffer, prefixed with a
  header line (version, videoId, current t, copy timestamp) so a single
  paste is enough to reconstruct what the pipeline believed and did -
  session start (version + full settings snapshot + resolved video
  element/duration), every appended segment's chain-dump essentials, every
  window's result (media-time span, wall time, rtf, word count, first/last
  word time) or skip reason, every mute/pause engage/release with reason,
  coverage snapshots, and stall/restart/resync events - without asking the
  user to reproduce with extra instrumentation. `WORDTIMES` lines (compact
  JSON per-word timestamps) are also emitted for `verify/caption_correlate.mjs`
  to consume directly from a pasted log.
- **Orphaned-content-script banner**: reloading/updating the extension
  orphans any already-injected content script (`chrome.runtime.connect`/
  `sendMessage` start throwing "Extension context invalidated"), which
  previously failed completely silently - burned real debugging time twice
  (a stale tab's evidence was mistaken for a live bug report). `content.js`
  now checks `chrome.runtime.id` access before connecting/reconnecting and,
  if invalid, shows a small persistent "Profanity Muter was updated -
  refresh this page to re-enable" banner on the player instead of retrying
  forever with no signal.
- Removed the now-fully-dead `pm-invalidate`/`invalidate` message path
  (offscreen had no sender left after the 0.1.9 rewrite - confirmed by
  grepping the built bundle for zero occurrences - so `background.js`'s
  relay and `content.js`'s `handleInvalidate` were vestigial and are gone).
  Also added a belt-and-suspenders fix in `background.js`: `onInstalled`
  (fires on install/update/reload, not routine SW idle-respawns) now
  force-closes any existing offscreen document before recreating one, in
  case a stale pre-reload offscreen doc was ever the reason old behavior
  seemed to persist after a reload.

**Deterministic sync verification - `verify/caption_correlate.mjs`**:
replaces eyeballing the debug overlay. Matches our transcript's distinctive
(non-stopword, 3+ letter) words to same-word occurrences in YouTube's own
caption track (same media timeline as `currentTime`) within a ±10s search
radius, over a configurable time window, and computes the **distribution**
of time deltas rather than a per-word pass/fail - caption content is
famously unreliable and cue timing itself is only accurate to about ±1s, so
a per-word window would fail a correct build on caption noise alone.
Verdict: `|median(delta)| < 1.0s AND IQR(delta) < 2.0s` - a systematic sync
offset shows up as a shifted median; scatter from caption sloppiness is
tolerated. Reads our own words from `WORDTIMES` lines in a saved console
log (paste-compatible with the Copy Logs button); captions are fetched by
scraping the watch page for a signed `captionTracks[].baseUrl` (YouTube's
bare `timedtext` endpoint returns HTTP 200 with an empty body without real
session/cookie context - confirmed while building this script; a bare
Node `fetch` doesn't have that context) or, more reliably, via
`--captions-json <path>` pointing at a `fmt=json3` response body fetched
from within a real browser tab.

**Not yet run**: the caption-correlation check itself, on either a fresh
t=0 session or a mid-video resume - this is the actual acceptance
criterion per the coordinator/user and is still outstanding as of this
writing, blocked on getting a live extension session's `WORDTIMES` log
plus a fetched captions JSON in the same pass.

## 0.1.11: EBML garbage-timecode bug, delete the drop guard, slicing resilience, timeline-shift alarm

Root-caused from a fresh live user Copy Logs paste (resume at ~1514s on
`o-7Fvkq-Nug`): initially perfect (three `word:Fuck` mutes engaged/released at
correct sub-second intervals), then at 02:08:22.464Z:
`[PM-AD-SKIP] dropping segment (implausible timecode
1.4509186193065867e+259s > duration 4348.3s)` - followed by two consecutive
18s windows transcribing nearly identical dialogue ("Nah, cause what if I
just get hit...") and all subsequent mutes landing on the wrong words
("muting random stuff", per the user).

**Root cause, confirmed**: `capture.js`'s `scanForTimecode` walked a
mid-cluster CONTINUATION chunk (an appended fragment with no fresh element
header at its start - raw Block/SimpleBlock payload bytes) as if it were a
well-formed EBML stream from offset 0. Byte 0xE7 (Timecode's own id)
occurring by pure coincidence in that garbage, followed by a garbage vint
happening to decode as a large "size", made `readUint` loop over a huge byte
count and return `1.45e259`. The 0.1.10-era plausibility-drop guard
(`localTimeSec > duration + 15`) then fired on that garbage and **dropped a
real, in-content audio segment** - the decoded stream compacted around the
hole, and every window from there on was reading roughly the wrong 9-18s
slice, hence the duplicate-dialogue windows and all the subsequent
mistimed mutes.

**Fixes**:

- **`capture.js`: `scanForTimecode` now requires well-formedness before
  trusting a Timecode.** Every element encountered must (1) have a
  recognized EBML/Matroska id (`isKnownId` - a small explicit whitelist:
  Segment/Info/Cluster/Header/SeekHead/Tracks/Cues/Tags/Chapters/
  Attachments/BlockGroup as masters, plus TimecodeScale/Timecode/Void/CRC-32/
  SimpleBlock/Position/PrevSize as known leaves) and (2) have a
  size that actually fits inside its enclosing scope
  (`contentStart + size <= end`), and additionally the two uint-typed ids we
  read (TimecodeScale, Timecode) can never legitimately exceed 8 octets per
  the EBML spec (`size > 8` -> reject). Any violation sets a `malformed` flag
  that aborts the ENTIRE scan (not just that node) - a continuation chunk
  now correctly returns `null` (like most segments always did) instead of
  occasionally producing garbage. Verified with a standalone Node harness:
  a well-formed Cluster>Timecode still resolves correctly; a garbage buffer
  starting with byte `0xE7` followed by a garbage multi-byte size (the
  actual failure shape) now returns `null`; pure random bytes also return
  `null`.
- **`capture.js`: the timecode-plausibility drop guard is DELETED entirely.**
  `[PM-AD-SKIP]` now fires ONLY on the player's own `ad-showing`/
  `ad-interrupting` class check. There is no longer any path where a parser
  hiccup can drop real audio - worst case with the parser bug alone (now
  also fixed) would have been a missed `[PM-CHECK]` cross-check log, never a
  dropped segment.
- **`offscreen-src.js`: slicing resilience - coverage now follows the
  ACTUALLY-decoded buffers' own timestamps, never the requested window.**
  `transcribeWindow` computes `[coverStart, coverEnd)` from the min/max of
  `wrapped[].timestamp`/`.timestamp+.duration` (mediabunny's own decoded
  timestamps) and logs a loud `[PM-COVERAGE-GAP]` via `notifyTab` whenever
  that falls short of the requested `[absStart, absEnd)` by more than 0.5s.
  `s.covered` is now merged PER DECODED BUFFER (not as one
  `[absStart, absEnd)` span), so an internal gap between two buffers inside
  the same window is preserved as a real hole for `pickNextWindow` to revisit,
  rather than compacted away. Critically, the **same `[coverStart, coverEnd)`
  span (not the requested window) is now what's sent to content.js** as
  `windowStartS`/`windowEndS` in `pm-words-result` - content.js's own
  `session.coveredIntervals` (which gates safe-mode mute release) was
  previously built directly from the requested window too, so this closes
  the "silent compaction" bug on BOTH sides of the pipeline, not just
  offscreen's internal bookkeeping. Known residual limitation: a single
  `pm-words-result` message still carries one span, so a rare internal
  micro-gap inside an otherwise-mostly-decoded window could still be
  slightly overstated to content.js (min-to-max, not the exact union) even
  though offscreen's own `s.covered` tracks it precisely - not expected to
  matter in practice since the concrete failure mode (a full tail
  truncation from a dropped segment) no longer occurs at all now that the
  drop guard is gone.
- **`offscreen-src.js`: timeline-shift self-check alarm.** Word-level
  4-grams of each window's raw transcript are compared against the previous
  window's for the same session (`s.lastWindowGrams`/`lastWindowSpan`); if
  more than 60% of the smaller set's 4-grams also appear in the other set,
  logs a loud `[PM-TIMELINE-ALARM]` via `notifyTab` (reaches the tab's ring
  buffer through the existing `pm-diag` -> `diag` -> `TWARN` path) - this is
  exactly the symptom the live bug produced (two windows transcribing nearly
  the same dialogue) and now self-reports instead of silently corrupting
  downstream mutes unnoticed.
- **`offscreen-src.js`/`background.js`/`content.js`: `wallMs`/`rtf`
  accounting fixed.** `rtf` was computed from `transcribeMs` (the Whisper
  call alone) while `wallMs` logged on the same `[PM-WINDOW]` line is the
  FULL time since `transcribeWindow` started (including demux/track-ready
  wait and resample) - e.g. the reported `wallMs=26681` with `rtf=0.276`
  implied the model took ~5s on an 18s window (true) while hiding ~21.7s of
  other real latency, misleadingly suggesting the pipeline was keeping up in
  real time. `rtf` is now computed from `wallMs` (consistent basis with the
  number it's logged next to); the model-only figure is preserved as a new
  `modelRtf` field (threaded through `pm-words-result` -> `background.js`'s
  `[PM]` log -> content.js's `[PM-WINDOW]` log) for anyone specifically
  diagnosing transcription throughput vs. demux/queueing latency separately.

**Verification status**: this 0.1.11 work was never independently reloaded
before more fixes landed - folded straight into 0.1.12 below (unit-verified
in isolation only; live verification is against 0.1.12 as a whole).

## 0.1.12: catch-up-mode snappiness, capture-miss eviction, pause-fallback ladder, EBML resync, mute-fight enforcement, [PM-NO-WINDOW] observability

Five separate fixes, all folded into one version bump since they landed
together before the 0.1.11 reload happened:

### 1. Catch-up-mode transitions are now synchronous, not tick()-dependent

User report: toggling the "While catching up" setting (mute/pause) "lags
super hard" while catch-up is actively engaged. Root cause, worse than
"lag": `tick()` only ever called `resumeFromCatchup()` from inside its OWN
`'pause'`-mode branch - switching pause -> mute (or -> play) while genuinely
paused-for-catchup left the video **paused forever**, since the `mute`/`play`
branch never touches `catchupPausedByUs` at all. `content.js`'s
`chrome.storage.onChanged` listener now calls a new
`handleCatchupModeChanged(newMode)` synchronously, right in the storage
event handler - computed from the event's own new value (not a re-read of
possibly-stale `PMWordlist.settings`, which may update asynchronously via
the wordlist agent's own listener on a different tick):

- Leaving `'pause'` while `catchupPausedByUs`: resume immediately.
- Entering `'pause'` with a stale `'safe-mode-uncovered'` forced mute still
  active: release it and pause immediately instead of leaving one unmuted-
  then-paused frame gap.
- Entering `'play'`: clear any stale uncovered-region forced mute outright.
- Entering `'mute'` while still uncovered: engage the mute immediately.

Every call made (`engageMute`/`releaseMute`/`pauseForCatchup`/
`resumeFromCatchup`) is already idempotent/guarded against current state, so
this is safe to invoke on every relevant storage change with no risk of
repeated pause/play/mute churn - each is a no-op if already in the target
state.

### 2. Capture-miss eviction (capture.js) - closes a real deadlock class

User found this analyzing the pause-catchup lag report: (a) pausing stops
YouTube from fetching/appending anything further; (b) worse, regions
YouTube buffered **before our hook attached** (initial page-load buffering,
or a "continue watching" resume jumping straight into an already-fetched
region) sit in the SourceBuffer's `.buffered` ranges but were **never seen
by our appendBuffer hook and never will be passively** - the player has no
reason to re-fetch data it already has. In pause-catchup mode this is a
hard deadlock: paused forever, waiting for coverage that can structurally
never arrive.

Fix, entirely self-contained in `capture.js` (no cross-context coverage
plumbing needed - a buffered-but-uncaptured span can never be covered
regardless of what content.js/offscreen do, so this is detectable purely
from bytes capture.js already sees):

- Every non-ad segment's own buffered-range GROWTH span (`findGrowth`'s
  `absStart`/`absEnd`, already computed for the `[PM-CHAIN]` log) is merged
  into a per-SourceBuffer `evictionState.captured` list - ground truth for
  "what did our hook actually see".
- A new `setInterval` (every 3s, self-clearing when the video id changes)
  diffs the SourceBuffer's actual `.buffered` ranges against `captured`
  (`subtractRanges`) and looks for a gap within `EVICT_LOOKAHEAD_S` (45s) of
  the playhead.
- If found: `sourceBuffer.remove(start, end)` - the player treats this
  exactly like a normal quota-driven eviction, notices the hole, and
  re-fetches/re-appends that span, and THIS TIME the hook is attached and
  captures it. Logged as `[PM-EVICT]`.
- Guard rails: never touches `currentTime ± EVICT_GUARD_PLAYING_S` (2s)
  while actually playing (avoid stall/jank) - a much smaller `±0.2s` guard
  while paused, since nothing is actively being decoded right at that edge;
  evicts in `EVICT_MAX_CHUNK_S` (30s) chunks, not one giant removal; rate-
  limited to `EVICT_MAX_PER_MINUTE` (4) to avoid a fetch storm if something
  is persistently wrong; respects `sb.updating` via a simple queue pumped on
  `updateend`.
- This benefits `'mute'` catch-up mode too, for free - it's mode-unaware,
  purely byte-level, so a capture-miss region under mute mode (previously:
  muted forever, no fix) now also gets evicted/recaptured.

### 3. Pause-catchup fallback ladder (content.js)

Second layer for the same deadlock class, in case eviction alone doesn't
resolve it fast enough (or at all, e.g. some other cause of zero progress):
if pause-catchup (`session.catchupFallbackActive === false` path in
`tick()`) makes **zero coverage progress for `FALLBACK_STALL_MS`** (8s),
downgrade to **muted PLAYBACK** for that stall - playing is what actually
makes YouTube resume buffering/appending (and what lets the eviction check's
`currentTime` advance in the first place). The "Analyzing audio…" overlay
stays up throughout (a new `resumeFromCatchupKeepOverlay()` resumes without
hiding it, unlike the normal `resumeFromCatchup()`), so protection still
reads as active to the user. Logged loudly as `[PM-FALLBACK]`. Reverts to
normal pause-mode behavior for the NEXT uncovered region once this one is
actually covered - not a permanent global downgrade.
`session.catchupFallbackActive` is reset when leaving `'pause'` mode
entirely (via `handleCatchupModeChanged`) so it can't linger stale into a
later re-entry. The general 15s stall-watchdog (`STALL_MS`, restarts
offscreen's `maybeProcess`) still operates independently and additionally
during the fallback-muted period (`stalling`'s computation now treats an
active fallback like the `'mute'` strategy: `!video.paused` gates it, not
`catchupPausedByUs` which is false once downgraded) - two complementary
timers, no conflict (`FALLBACK_STALL_MS` 8s fires well before `STALL_MS`
15s in the common case).

Re-audited the pause-catchup resume condition per the standing ask: it
already resumes purely on `isCovered(video.currentTime)` (with
`COVERAGE_EPS` margin baked into `isCovered`) going true - no change needed
there; with eviction (guarantees forward progress becomes possible) and the
fallback ladder (guarantees pausing itself is never the sole permanent
blocker) both in place, this resume condition should now always eventually
fire.

### 4. EBML scanner: unknown-size Cluster + resync (capture.js)

A fresh Copy Logs paste (resume at t≈2610 on `o-7Fvkq-Nug`) showed the
0.1.11 well-formedness gate go too far the other way: `localTimeSec` was
`null` for ~78 consecutive segments where the 0.1.10 log (a different
resume point, granted, but a real behavior comparison) showed a fresh
Timecode roughly every 10s. Two contributing issues, both fixed:

- Confirmed the unknown-size-Cluster path itself is correct (added a
  dedicated unit test reproducing YouTube's actual 8-byte unknown-size vint
  form, `0x01FFFFFFFFFFFFFF` - passes; floating-point rounding of
  `Math.pow(2,56)-1` was a suspect but both sides of the `size === maxVal`
  comparison round the same way in practice, confirmed empirically).
- The REAL gap: `appendBuffer` chunk boundaries do not follow EBML element
  boundaries - an append can start mid-way through a still-open Cluster's
  prior `SimpleBlock` stream (raw, non-boundary-aligned continuation bytes,
  or a block whose declared size spans past this specific append). The
  0.1.11 scanner's single `malformed` flag aborted the ENTIRE scan on the
  first such hiccup, even when a genuine FRESH Cluster (with its own
  Timecode) existed later in the very same append buffer - so it never got
  a chance to look there.
  - Fix: `scanForTimecode` now retries. If position 0 hits `malformed`
    before reaching the buffer's end, it searches for the Cluster
    element's own 4-byte id (`0x1F43B675` - a near-zero false-positive-rate
    byte pattern, unlike matching a single byte like Timecode's `0xE7`,
    which is what caused the original 1e259 bug) anywhere later in the same
    buffer, and re-validates FULL well-formedness (whitelist + bounds +
    8-octet uint cap - unchanged, still what actually stops garbage) from
    each candidate position, up to 20 attempts. A coincidental 4-byte match
    still has to pass every check to be trusted, so this does not reopen
    the original vulnerability - verified with a unit test where the
    4 Cluster-id bytes appear coincidentally in garbage and are correctly
    still rejected, alongside a test where a genuine Cluster+Timecode
    follows a malformed/oversized-SimpleBlock prefix in the same buffer and
    IS correctly found via resync.
  - Target behavior restored: a fresh Timecode roughly every ~10s of
    appended audio, `null` on genuine continuation chunks, garbage never.

### 5. Continuous mute enforcement + [PM-NO-WINDOW] observability

- **`[PM-MUTE-FIGHT]` (content.js)**: the same log paste showed `MUTE
  engaged t=0.00 reason=safe-mode-uncovered` that was never released, yet
  the user HEARD AUDIO - YouTube's own player can write `video.muted`
  itself during init/element churn, silently defeating our one-shot write
  while `session.forcedMute` stayed `true`, so `tick()` believed protection
  was still active and never re-checked. Fix: `tick()` now re-asserts
  `video.muted = true` every frame while `forcedMute` is intended (a cheap
  property write) and logs a loud `[PM-MUTE-FIGHT]` if it finds the flag had
  actually drifted. This also transparently covers a newly-resolved
  `<video>` element (`getVideo()` already re-resolves every tick) with no
  separate hook needed - protection is now continuously enforced, never
  assumed from our own flag.
- **`[PM-NO-WINDOW]` (offscreen-src.js)**: the same paste showed 60+s of
  buffered audio with ZERO `[PM-WINDOW]` attempts and repeated
  `[PM-STALL] no attempt in progress` - but no skip reason anywhere,
  violating the standing "every did-not-attempt must emit a diag line"
  rule. Every silent bail path in `maybeProcess`/`pickNextWindow` (`no
  run yet`, `not enough buffered audio`, `fully covered already`, `below
  MIN_NEW_S`) now calls a shared, per-reason-throttled (5s)
  `logNoWindowReason` -> `notifyTab` -> the tab's own ring buffer. The
  suspected underlying cause of the zero-attempt window itself is the same
  capture-miss scenario fix #2 addresses (our hook's first-ever-seen append
  for this session may not actually be the true init segment if YouTube
  pre-buffered before hook attach) - now both mitigated (eviction) and, if
  it ever recurs for a different reason, guaranteed visible.

**Verification status**: all five fixes complete, `node build.js` bundles
clean, `node --check` passes on all plain-JS files, EBML scanner unit-
verified in isolation (6 cases: well-formed cluster, garbage-with-
coincidental-Timecode-byte, pure random garbage, real 8-byte-unknown-size
form, resync-past-garbage-prefix, coincidental-4-byte-cluster-id-still-
rejected - all pass). **Not yet run live** - needs the reload below, then:
(1) deadlock repro - navigate to a timestamped URL mid-video (forcing a
resume into pre-buffered territory), immediately enable pause catch-up
mode, confirm it recovers (via eviction and/or the fallback ladder) instead
of hanging; (2) standing long-playback verification (2+ min, many cluster
boundaries): no `[PM-AD-SKIP]` misfires outside real ads, no
`[PM-TIMELINE-ALARM]`, no `[PM-MUTE-FIGHT]` (or if one fires, confirm it
self-corrects), word times tracking `currentTime`, roughly-10s-cadence
`[PM-CHAIN]` timecodes; (3) `verify/caption_correlate.mjs` median/IQR sync
numbers.

## 0.1.13: eviction redesign, hallucination filter, loudness/model work, cold-start, full pm_enabled=false

A 0.1.12 Copy Logs paste (resume at 2633 on `o-7Fvkq-Nug`) confirmed the big
wins: "Oh my God" x2 and "fucking" muted at correct times, media-time
doctrine holding, coverage correct across discontinuous ranges. Also
surfaced four new issues, all fixed here, plus two coordinator/user
addenda (full `pm_enabled=false` disable, and the minimal-footprint
principle above).

### 1. Eviction redesign - LAST RESORT, on-demand, self-healing

0.1.12's eviction was itself causing the exact player stalls it was meant to
prevent: `[PM-EVICT]` fired 5x in 70s off a blind 3s timer across a 45s
lookahead, up to 30s per removal, guarded only 2s from the playhead (one
eviction started just 2.98s ahead of `currentTime` - inside the danger zone
in practice) - and left a PERSISTENT HOLE `[2670,2674.56]` that was evicted
and never refilled, which the player then stalled on when the playhead
reached it (fire-and-forget: nothing ever checked whether an eviction
actually worked). Redesigned in `capture.js`:

- **On-demand only, no blind timer.** The periodic `setInterval` is gone.
  Eviction is now checked ONLY when content.js's `requestStallRecovery()`
  fires (15s of zero coverage progress) - which, per the minimal-footprint
  principle, is already strictly downstream of the non-mutating 8s
  pause->mute fallback ladder (0.1.12) having had its chance first. Wired
  via a same-origin `window.postMessage({__pmToCapture:'PM_CONTENT',
  type:'check-eviction'})` from content.js to capture.js (mirroring the
  existing capture.js -> content.js channel in reverse); capture.js tracks
  the most-recently-instrumented audio SourceBuffer as "active" for this.
- **Narrower lookahead** (`EVICT_LOOKAHEAD_S`: 45s -> 10s) - only a gap at
  or about to reach the playhead is worth evicting; not something that
  might not even matter by the time playback gets there.
- **Wider, uniform guard band** (`EVICT_GUARD_S`: 2s (playing-only) -> 5s,
  always) - simplicity and safety over squeezing a few extra seconds.
- **Smaller chunks** (`EVICT_TARGET_CHUNK_S`/`EVICT_MAX_CHUNK_S`: up to 30s
  -> 10-15s) - smallest useful span, not one giant removal.
- **Tighter rate limit** (4/min -> 3/min) per the minimal-footprint
  principle.
- **Refill verification + a single nudge**, the actual fix for the
  persistent-hole bug: every eviction is tracked in `evictionState.pending`
  until `evictionState.captured` (real, hook-observed re-appends - not just
  `.buffered` having *some* bytes) confirms it's back. If still missing
  after `EVICT_REFILL_CHECK_MS` (4s), a single micro-seek
  (`video.currentTime += 0.01`) nudges the player to re-request there
  (logged `[PM-EVICT-NUDGE]`) - the standard way to get an MSE-backed
  player to notice a hole it thought it didn't have. If STILL missing as
  the playhead approaches within `EVICT_STUCK_HORIZON_S` (30s), logs a loud
  `[PM-EVICT-STUCK]` alarm (purely informational at that point - a content
  script can't force a browser-internal fetch scheduler to comply, but this
  guarantees the failure is visible rather than silently repeating the
  0.1.12 bug). A pending eviction is dropped once refilled OR once the
  playhead passes it (stale, nothing more to do there).
- Unit-verified: a mock-SourceBuffer harness confirms a real gap gets
  evicted with the correct 5s-guarded, 12s-chunked bounds; a second call on
  the same still-pending gap is correctly suppressed (no re-evict spam); a
  gap beyond the 10s lookahead is correctly ignored.

### 2. Whisper hallucination loop (offscreen-src.js)

Window `[2671.09,2689.09)` emitted "it's him" ~40x consecutively with
degenerate timestamps - many zero-duration words (normal/common from
Whisper on its own, NOT a bug) plus one token with `s=2700.455 e=2671.095`:
END BEFORE START, and entirely outside the window's own span. Classic
decoder degeneration on ambiguous/quiet audio. Fixed with a transcript
sanity filter, applied BEFORE anything downstream (dedupe, mute-interval
building, and the 0.1.11 timeline-shift check) ever sees a window's raw
output:

- Drop any token whose `end < start` outright (nonsensical, unsalvageable).
  Zero-duration (`end === start`) is left alone - genuinely common/normal,
  not an error signal on its own.
- Drop any token whose local timestamp falls outside
  `[windowStart-1, windowEnd+2]` (relative to the window's own span) -
  logged as `[PM-SANITY]`.
- **`collapseHallucinationLoops`**: detects a cycle of length 1 or 2 (a
  single word, or a two-word phrase - covers both "yeah yeah yeah..." and
  "it's him it's him...") repeating more than 5 times consecutively, keeps
  only the first two cycles (so a short genuine repetition like "no, no,
  no" is never touched - verified in a unit test), and drops the rest,
  logging a loud `[PM-HALLUCINATION]` alarm via `notifyTab`. Unit-tested
  against the exact "it's him" x40 shape, a normal sentence (untouched), a
  3x legitimate repeat below threshold (untouched), and a single-word 10x
  loop.
- `no_repeat_ngram_size: 3` also passed to the `transcriber()` call as a
  best-effort mitigation - transformers.js's ASR pipeline doesn't expose a
  direct `condition_on_previous_text` toggle (moot anyway: each window is
  already its own independent call with no prior window's text fed back
  in, so cross-window conditioning is already off), and whether this
  specific generate() kwarg is actually honored by the pipeline is
  UNVERIFIED - `collapseHallucinationLoops` is the guaranteed defense, this
  is a bonus if it works.

### 3. Quiet-speech recall + model visibility

- **Loudness normalization** (`normalizeLoudness` in `windowToFloat16k`,
  offscreen-src.js): simple peak normalization of the final 16kHz window
  PCM to a target peak of 0.9, applied after any resample. Deliberately
  conservative: a window already at/above target is untouched (gain=1,
  most normal speech); a window with almost no signal at all
  (peak < 0.02) is ALSO left untouched - amplifying pure noise floor to
  full scale would manufacture false "speech" for Whisper to hallucinate
  on, the opposite of the goal. Gain capped at 8x. Logged as
  `[PM-NORMALIZE]` whenever gain != 1.
- **`[PM-MODEL]` session-start logging**: the actually-resolved model id
  (and whether it was overridden via `pm_model` vs. the built-in
  `DEFAULT_MODEL`) is now logged via `notifyTab` once per session - closes
  the "is this build really defaulting to base?" question without needing
  to trust the source alone.
- **`pm_model: "small"` added** (`Xenova/whisper-small.en`) as an opt-in
  accuracy tier - confirmed on the Hub to ship `alignment_heads` (same
  basis tiny/base were confirmed on), so word timestamps are supported.
  **RTF cost is an ESTIMATE, not a measurement**: small has roughly ~3.3x
  base's parameter count (244M vs 74M), so expect roughly 2-3x base's
  measured steady-state RTF (0.13-0.29 per the existing RTF table) - likely
  still comfortably under 1.0, but this has not been run live. Re-verify
  with a real session before recommending it broadly.

### 4. Cold-start + tiny-tail deferral (offscreen-src.js)

User reported ~10s to first coverage after a session start/seek. Root
cause: the FIRST window landing at a fresh, disjoint point still had to
wait for a full `WINDOW_S` (18s) worth of audio to buffer AND transcribe
before any protection engaged near where the user just landed.

- **`pickNextWindow` now detects "cold"** structurally (offscreen isn't
  directly told about seeks): the very first window of a session, OR any
  window whose start isn't within `COLD_START_ADJACENCY_S` (3s) of
  existing coverage's tail (i.e. it's opening a new, disjoint region -
  exactly what a seek/resume produces), gets a small `COLD_START_WINDOW_S`
  (5s) window (with a correspondingly small `COLD_START_MIN_NEW_S`, 1.5s)
  instead of the normal 18s. Normal-size windows resume immediately after
  (`s.hadFirstWindow` flips true once any window actually completes).
- **Tiny-tail windows deferred**: a live log showed a 0.05s window
  attempted at `rtf=68` - fixed per-call overhead (demux/resample/generate)
  completely dominates a sliver that small. The old tail-case exemption
  (`end < high` check letting ANY size through at the current buffer edge)
  is now bounded by `MIN_TAIL_S` (2s): a smaller tail is deferred unless
  `s.lastBufferedGrowthWall` shows the run has genuinely gone quiet for
  `TAIL_STALL_MS` (3s), implying this really is the last bit that will ever
  arrive (e.g. actual end of video) rather than just "not enough has
  batched in yet".
- **Model/offscreen-doc warmth across video changes**: audited, already
  satisfied by existing architecture - `transcriberPromises` (the loaded
  Whisper pipeline cache) is module-level in `offscreen-src.js`, not
  per-session, and `background.js`'s `ensureOffscreenDocument()` only
  force-closes the offscreen doc on `onInstalled` (an actual extension
  reload), never on a video/session change. No code change was needed
  here - confirmed by reading, not assumed.

### 5. `pm_enabled=false` now turns the ENTIRE extension off

Previously the debug overlay (and its own logging) stayed visible even with
`pm_enabled=false`, since it was gated only on `pm_debugOverlay`. Fixed
end-to-end:

- `content.js`'s debug-overlay poll now requires `settings.enabled` too.
- New `handleEnabledChanged(newEnabled)`, wired synchronously into the
  `pm_enabled` `storage.onChanged` branch (same pattern as 0.1.11's
  `handleCatchupModeChanged`): on disable, releases any active mute
  (`releaseMute('disabled')`), resumes any catch-up pause
  (`resumeFromCatchup('disabled')`), clears `catchupFallbackActive`, hides
  the analyzing overlay AND the debug overlay, and - importantly -
  `clearArmedTimers()`, since a previously-armed word-mute `setTimeout`
  from before disabling would otherwise fire later and silently re-mute a
  "disabled" session. Logs exactly one `[PM] disabled` line.
- The `'segment'` handler (relaying capture.js's bytes to background) now
  checks `currentSettings().enabled` and drops segments outright while
  disabled - capture.js keeps its lightweight hook installed regardless
  (it has no knowledge of `pm_enabled` and doesn't need it), only
  content.js's relay stops.
- The `'chainlog'` handler (capture.js's own log lines, relayed into
  content.js's ring buffer) is also gated on `enabled` - otherwise
  capture.js's per-segment chain-dump lines would keep flooding the ring
  buffer for no purpose while "disabled", violating the single-line rule.
- `content.js` sends a new `{type:'disable'}`/`{type:'enable'}` port
  message -> `background.js` relays as `pm-disable`/`pm-enable` ->
  `offscreen-src.js`'s session gets a `disabled` flag that `maybeProcess`
  checks first thing (idles transcription CPU without tearing down or
  reloading the model - `transcriberPromises` stays warm).
- Re-enabling mid-page resumes cleanly from existing session state (no
  reset) - safe mode already protects whatever gap formed while disabled,
  since `isCovered()` correctly reports "uncovered" for anything not
  covered. `armSchedule()` is re-run on enable to restore proactive timers
  for already-known intervals (cleared by `clearArmedTimers()` on
  disable).

**Verification status**: all five items complete, `node build.js` bundles
clean, `node --check` passes on all plain-JS files. Hallucination-collapse
and eviction-detection logic both unit-verified in isolation (Node
harnesses, not live runs). **Not yet run live** - needs the reload below,
then, at human pacing: (1) mid-video resume + continuous play, confirming
the 0.1.12 wins still hold and no new regressions; (2) the eviction-stall
scenario specifically - force a capture-miss (timestamped-URL resume into
pre-buffered territory) and confirm NO persistent holes and NO player
stalls this time, with refill/nudge/stuck logging behaving as designed;
(3) the on/off/on cycle for `pm_enabled` - visually confirm no overlays and
no console chatter while off, and clean resumption when back on;
(4) `verify/caption_correlate.mjs` median/IQR sync numbers.

## 0.1.14: range-aware playhead-first window picker + window-loop breaker

A 0.1.13 log confirmed muting QUALITY is now good in covered regions
(phrase mute "What the fuck?+Oh my god!" worked, many clean word mutes) -
but surfaced two critical pipeline bugs, both fixed here.

### 1. Range-blind window picker ("jump forward = uncovered forever")

After a seek from the ~2860 region to 3220.98, capture correctly recorded
the new appends (ranges `[2640-2860]`, `[3220-3310+]` both growing,
segs 144-229 landing) - but offscreen logged `[PM-NO-WINDOW] not enough new
buffered audio yet (currentTimeS=3220.98 bufferedEndS=2860.00)` forever.
Root cause: availability was modeled as ONE monotonic scalar
(`s.bufferedEndS`, `Math.max`-accumulated across every segment). A big
forward seek WITHIN THE SAME SourceBuffer produces NO new init segment
(segs 143+ all `isInit=false`), so nothing ever resets anything - capture.js
correctly recorded a brand-new, DISJOINT range far ahead of the old one,
but the scalar model has no way to represent "there are two separate
available regions" at all; picking was structurally blind to it.

Fix - `pickNextWindow` redesigned to be range-aware and playhead-first:

- **`s.bufferedRanges`**: a real merged interval set, built by merging every
  segment's own `growthAbsStart`/`growthAbsEnd` (capture.js's own
  buffered-range-growth measurement - literally the span our hook watched
  land, already sent for the `[PM-CHECK]` cross-check, just not previously
  used for window picking). `s.bufferedEndS` is kept only as a legacy/
  informational scalar; `pickNextWindow` no longer reads it at all.
- **Always picks from the range CONTAINING `currentTime`, or - if the
  playhead has jumped somewhere not buffered yet - the NEAREST range
  AHEAD of it.** Never a linear frontier that can only ever grow from
  where it last was. When fully covered up to a range's own available end,
  extension happens WITHIN THAT SAME RANGE only (never jumping to some
  other, unrelated buffered region just because of array ordering).
- This is also what makes a backward seek into an uncovered hole inside an
  otherwise-covered range work correctly (e.g. the `[2645,2647.9)` hole in
  the reported coverage) - `firstUncoveredPoint` over the CONTAINING
  range's own bounds finds it directly; verified in a unit test alongside
  the forward-jump-into-disjoint-range case, a jump beyond all known
  ranges (correctly reports `no-range-at-playhead`, nothing to pick until
  a segment arrives there), and the cold-start case.
- **Not blindly changed**: the mediabunny demux/decode path itself
  (`AudioBufferSink.buffers(absStart,absEnd)` via the persistent streaming
  `Input`) was left untouched - the 0.1.6 architecture note already
  states the access pattern "isn't strictly sequential (seeks jump the
  requested window around within a run)" and sizes the stream cache
  (`RUN_STREAM_CACHE_BYTES`, 64MiB) accordingly. Whether it actually
  serves a window at 3220s correctly when fed live post-seek clusters in
  the SAME run/Input (no new init segment) is the real question that only
  a live run can answer - this is the primary thing to confirm during
  0.1.14 verification, not something to guess-fix here.

### 2. Infinite empty-window loop (severe CPU waste)

`[PM-WINDOW] mediaSpan=[2640.00,2645.00) words=0` repeated EVERY ~3s for
18 MINUTES straight (03:17->03:35, ~350 attempts) - content-side coverage
showed `[2640-2645]` covered, but offscreen kept re-picking the EXACT SAME
span. Confirmed the per-buffer coverage merge (`for (const wb of wrapped)
mergeRangeInto(s.covered, wb.timestamp, ...)`) already runs UNCONDITIONALLY
regardless of word count - silence was already "covered" by that code path,
so this wasn't a naive "empty result never merged" bug. The most likely
explanation is a decoded-buffer-timestamp discrepancy specific to that
position (never fully isolated without live bytes) that left the buffers'
OWN reported spans not landing inside `[2640.00,2645.00)` closely enough to
satisfy `firstUncoveredPoint` for that EXACT window, so `pickNextWindow`
kept re-selecting it identically forever.

Rather than chase that one discrepancy blind, added a bounded, self-logging
escape hatch in `transcribeWindow`: `s.windowAttempts` (a `Map` keyed by the
exact `"start,end"` pair) counts attempts; if the SAME exact span is
attempted `WINDOW_LOOP_THRESHOLD` (3) times and still doesn't register as
covered after the normal merge, it's force-marked covered outright and a
loud `[PM-WINDOW-LOOP]` alarm fires via `notifyTab`. A resolved span's
counter is deleted (keeps the map bounded over a long session). A few
wasted seconds beats an 18-minute silent CPU-burning loop, and it's now
impossible for this class of bug to go unnoticed again.

**Verification status**: both fixes complete, `node build.js` bundles
clean, `node --check` passes on all plain-JS files. The range-aware picker
logic is unit-verified in isolation (forward jump into a disjoint range,
backward seek into a hole, jump beyond all known ranges, cold start - all
4 cases behave correctly). **Not yet run live** - needs the reload below,
then a jump-heavy scenario at human pacing: multiple >2min forward jumps
and backward jumps on a real video, asserting coverage reaches the playhead
within ~8s of each jump (per the coordinator's ask), with specific
attention to whether mediabunny's sink correctly serves the post-seek
region within the SAME run (see item 1's note above) and confirming no
`[PM-WINDOW-LOOP]` fires in normal playback (a loud alarm here would mean
the timestamp-discrepancy root cause from item 2 is still live and worth
digging into further, even though the loop itself is now bounded).

## 0.1.15: four-audit fix batch (backend, page-side, scenario matrix, elegance) + status pill/counting

Large consolidated batch from four adversarial audits, ranked, plus a
mid-batch feature addition (status pill + mute counting). Grouped by
severity below; "Your files only" - nothing in `shared/wordlist.js`,
`captions.js`, or `popup/` was touched.

**CRITICAL**

1. **`getTranscriber` cached a REJECTED promise forever** (`offscreen-src.js`)
   - one flaky model fetch permanently killed transcription for the whole
   browser session (every later call just re-returned the same rejected
   promise). Fixed with `.catch(() => { transcriberPromises.delete(id); throw e; })`,
   mirroring `trackReadyPromise`'s existing retry pattern.

**HIGH**

2. **`changeType` was treated as a video change** (`capture.js`) - posted a
   full `'reset'`, which `resetSession()` turns into `releaseMute()`
   (unmuting an ACTIVE word mute mid-utterance, audible) and wiped
   otherwise-valid `session.intervals`/`coveredIntervals` on a mere codec/
   bitrate switch. Fixed: only `segmentCount = 0` (capture-side codec
   bookkeeping) resets - the next append is correctly flagged `isInit=true`
   so offscreen starts a fresh demux run (expected/fine), but session-level
   coverage/word-dedupe (which already spans run boundaries by design) is
   untouched.
3. **`port.onDisconnect` deleted `portsByTabId[tabId]` unconditionally**
   (`background.js`) - a reconnect race (old port's disconnect firing after
   a new port for the same tab was already stored) could delete the NEWER,
   live port. Fixed: only delete if the map still holds THIS exact port.
4. **Memory leak trio**:
   - (a) `s.runs` (`offscreen-src.js`) was never pruned - every run's
     mediabunny `Input`/stream (each with up to 64MiB of its own cache)
     stayed alive for the whole session. New `closeRun()` helper; keeps
     current + previous run, closes/drops anything older.
   - (b) No `chrome.tabs.onRemoved` cleanup - closing a tab left its
     offscreen session resident forever. New listener in `background.js`
     forwards a `pm-tab-closed` message to offscreen, reusing (now
     run-closing) `dropSessionsForTab`.
   - (c) `s.allWords`/`s.emittedKeys` (`offscreen-src.js`) were uncapped -
     capped to a trailing `ALL_WORDS_CAP` (2000) window; resync only needs
     recent words (coverage is tracked entirely separately in `s.covered`).
5. **Armed end-of-interval timer released mute WITHOUT tick()'s coverage
   check** (`content.js`'s `armSchedule`) - released purely on
   `!inMutedInterval()`, a real audio leak in an uncovered region if the
   playhead had also drifted there (worst backgrounded, where this armed
   timer could be the ONLY thing firing). Now mirrors tick()'s exact
   condition: `!inMutedInterval(t) && !(safeMode && !isCovered(t))`.

**MEDIUM**

6. Added a `'play'` listener (`content.js`) to re-arm `armSchedule()` -
   previously only `seeking`/`ratechange` did, so a pause/resume left every
   armed delay computed against the pre-pause `currentTime`, stale by
   however long the pause lasted.
7. `maybeProcess`'s loop (`offscreen-src.js`) now rechecks `s.disabled` (and
   the new `s.unanalyzable`, see item 13) every iteration, not just before
   the loop starts - each `transcribeWindow` await is a real yield point
   where `pm_enabled` could flip mid-loop.
8. `pm_model` silently reverted to `DEFAULT_MODEL` after an offscreen
   respawn (e.g. `onInstalled`'s force-recreate) since model config was only
   ever re-pushed on the next video-change `reset`. Fixed: `background.js`
   tracks `videoIdByTabId` and calls `resendModelConfigToAllTabs()`
   whenever `ensureOffscreenDocument()` actually creates a fresh doc.
9. **Backgrounded-tab protection** (`content.js`): rAF suspends/throttles
   heavily while hidden, but audio keeps playing. Split `tick()`'s
   enforcement logic into `runTickLogic()` (callable without also enqueuing
   more rAF chains) and added a `visibilitychange` listener that runs it
   immediately on hiding, then a `1s setInterval` backstop for as long as
   the tab stays hidden (audible tabs are exempt from Chrome's "intensive
   throttling" of background timers, so this keeps firing reliably) -
   killed on visible again.
10. **Repeated-lyric under-muting**: `collapseHallucinationLoops`
    (`offscreen-src.js`) would drop genuine repeated profanity (a 6+x
    chorus swear looks structurally identical to a hallucination loop).
    offscreen-src.js has no access to `shared/wordlist.js` (isolated-world
    only, not ours to touch), so added a small, independent, deliberately
    conservative `HALLUCINATION_PROFANITY_GUARD` stem regex used ONLY to
    decide "never collapse this cycle" - a real match/mute decision still
    happens downstream in content.js via the actual wordlist. Asymmetric on
    purpose: a false negative here just falls back to pre-0.1.15 collapsing
    behavior; a false positive costs a few extra tokens at worst. Unit-
    verified: a 8x "fuck" chorus is left fully intact; a non-profane 10x
    "yeah" loop still collapses normally.
11. **Serialized transcriber calls** (`offscreen-src.js`): a simple
    promise-chain mutex (`runSerialized`) now guarantees at most one
    `transcriber()` call in flight at a time, globally - concurrent multi-
    tab inference sharing one pipeline instance was unverified-safe.
    `modelRtf`'s timer starts only once a call actually begins executing
    (not when queued), so it still measures real model compute, not
    queue-wait time behind another tab's window.
12. **postMessage bridge hardening**: the public `window.postMessage`
    broadcast `capture.js`->`content.js` segment/reset messages used
    exclusively was, by construction, readable AND forgeable by any page
    script with its own `'message'` listener (a forged `'segment'`, or
    worse, manufactured coverage defeating safe mode). `capture.js` (runs
    first, document_start, MAIN world, listed first in `manifest.json`)
    now creates a `MessageChannel` and hands `content.js` a private port via
    a one-time handshake - safe because Chrome guarantees document_start
    content scripts run before the page's own scripts can register a
    competing listener (the same trust assumption this whole extension
    already depends on for patching `MediaSource.prototype` before
    YouTube's player code runs). Once acknowledged, ALL further traffic is
    trusted ONLY over the private port; the public broadcast handler stops
    processing anything once the port is confirmed. Falls back to the
    public path if the handshake ever fails, so hardening can't become a
    single point of failure for the whole extension. (A simpler "random
    nonce over the public channel" alternative was considered and rejected:
    since the public broadcast is visible to every listener on `window`,
    a nonce delivered over it is trivially readable by the same adversarial
    script it's meant to stop - a private channel is the only approach that
    actually changes anything.)
13. **DRM/undecodable content**: if the exact same window fails
    `sink.buffers()` 3 times in a row (`SINK_ERROR_THRESHOLD`), it's
    structurally undecodable (protected content is the expected real cause
    - mediabunny can demux the container but the audio samples themselves
    are encrypted), not a transient "not enough data yet". New
    `markUnanalyzable()` (`offscreen-src.js`) stops `maybeProcess` for that
    session entirely and sends `pm-unanalyzable` -> `background.js` relays
    -> `content.js` releases any safe-mode mute/pause immediately, sets
    `session.unanalyzable` (suppresses safe-mode-uncovered muting/pausing
    permanently for that video via `runTickLogic`'s `uncovered` check), and
    shows a small on-player notice - never leaves a rented/protected movie
    permanently muted with no way to actually protect it.

**CLEANUP (elegance audit)**

14. Deleted content.js's fallback wordlist/matching path (~55 LOC -
    `isProfane`/`FALLBACK_WORDS`/the no-PMWordlist branch of `findMatches`)
    and the fallback settings object/legacy `deriveMode`-based migration
    path (~another chunk) - `manifest.json`'s `content_scripts` entry lists
    `shared/wordlist.js` before `content.js` in the SAME `js` array, and
    Chrome guarantees files within one entry's `js` array execute in that
    order, so `globalThis.PMWordlist` is always present; neither path was
    ever actually reachable. `currentSettings()` now reads
    `PMWordlist.settings.catchupMode`/`.safeMode` directly, trusting the
    wordlist agent's own contract-guaranteed derivation instead of
    re-deriving a duplicate copy of the same logic. Deleted `pm_timeOffsetMs`
    (~15 LOC) - the 0.1.7 manual calibration knob was never actually
    measured/set away from 0; the debug overlay's raw per-word timestamps
    already give everything needed to measure a real offset if one is ever
    found. Deleted `s.bufferedEndS` and the `bufferedEnd` wire field
    end-to-end (`capture.js` -> `content.js` -> `background.js` ->
    `offscreen-src.js`, ~15 LOC) - fully superseded by 0.1.14's
    `s.bufferedRanges` interval set; `lastBufferedGrowthWall` now updates
    off the same `growthAbsStart`/`growthAbsEnd` presence check that already
    gates `s.bufferedRanges`' own merge.
15. **Log collapse**: `[PM-CHAIN]` (`capture.js`) now logs only on an actual
    state change (a new disjoint buffered range, or the container-timecode/
    buffered-growth cross-check disagreeing beyond
    `CHAIN_LOG_CROSS_CHECK_SLACK_S`) plus a periodic summary every 25
    segments or 5s, instead of unconditionally every single append.
    `[PM-CHECK]`/`[PM-RESAMPLE]` (`offscreen-src.js`) now only log on
    genuine disagreement/mismatch (the `-WARN` variants already did; the
    unconditional per-window `[PM-CHECK]`/`[PM-RESAMPLE]` lines are
    deleted). This IMPROVES the flight-recorder's actual time coverage -
    the ring buffer was evicting in ~2 minutes under the old unconditional
    volume, which worked against its own "reconstruct what happened"
    purpose.

**Feature addition: status pill + mute counting** (mid-batch, folded in)

- **Status pill** (`content.js`): a small, separate-from-the-debug-overlay,
  always-on indicator - bottom-right, ~11px, `pointer-events:none`, updated
  at ~2Hz (`renderStatusPill`/`setStatusPillActive`/`computeStatusState`).
  Three states: `🛡 Protected` (coverage extends >=5s past the playhead,
  checked via `isCovered(t) && isCovered(t+5)` - independent of the
  configured catch-up strategy, since coverage is an objective fact about
  the pipeline regardless of how it's currently being protected), `🛡
  Analyzing…` (playhead in or within that 5s lookahead of an uncovered
  region), `🛡 Off` (only on `session.unanalyzable`, item 13's hard-failure
  state). Appends `· N muted` once `session.mutedCount > 0`. Hideable via
  new `pm_showStatus` (default true, read the same way as
  `pm_debugOverlay`); hidden entirely whenever `pm_enabled` is false (same
  gate as the debug overlay and analyzing overlay).
- **Mute counting** (`content.js`): `session.mutedCount` increments once per
  matched interval per actual playthrough - tracked via
  `session.activeMuteCountKey` (set while the playhead is inside a given
  interval, cleared on leaving it), gated on the REAL `video.muted` DOM
  state (not just `session.forcedMute`) so it reflects whether muting was
  actually applied regardless of which mechanism caused it. A re-entry into
  the same interval later (seek back, replay) counts again - this is a
  per-playthrough count, not a per-video-ever-seen count. Each counted mute
  logs a `[PM-COUNT]` line (labeled with the word count for phrase matches)
  immediately alongside the existing `MUTE engaged`/`released` lines, so the
  counter and the log always agree, per the explicit ask.
- **Lifetime stats** (`content.js` -> `chrome.storage.local`, schema kept
  EXACTLY as specified for the popup): `pm_stats: {totalMuted,
  videosProtected}`. `totalMuted` increments by the counted-interval count;
  `videosProtected` increments once per video on its first counted mute
  (`session.lifetimeVideoCounted`). Buffered in `pendingStatsDelta` and
  flushed at most every 10s (`STATS_FLUSH_MS`) via `setTimeout`, plus
  unconditionally on `pagehide` (so a throttled-but-pending delta isn't
  lost if the page goes away first). Uses `chrome.storage.local`, not
  `sync`, per the explicit write-rate-limit reasoning. Known, accepted
  limitation: the get-then-set flush isn't atomic across multiple tabs
  writing concurrently (a genuine race could under-count under heavy
  multi-tab use) - acceptable for a best-effort stats counter, not
  something billing-critical; not engineered around further here.

**DEFERRED** (per the coordinator's explicit instruction - noted, not done):
a `computeDesiredState` state-machine refactor of `tick()`/`runTickLogic()`
(staged behind harness tests later); wasm variant trim in `build.js` (needs
live instrumentation of which variant actually loads first, not done this
pass); SSAI/live-stream support (wontfix for now); `all_frames` embeds
(product call pending).

**Verification status**: every fix above is syntax-checked
(`node --check`) and bundles clean (`node build.js`). Unit-verified in
isolation where feasible without live bytes: the hallucination profanity
guard (chorus-swearing case + non-profane-loop case, both correct). Items
2/3/5/6/7/8/9/12/13 and the status pill/counting feature are logic changes
that need a LIVE run to confirm - no live verification has happened yet
this pass. **Needs, at human pacing once reloaded**: (1) the standing
0.1.14 jump-heavy verification (multiple >2min forward/backward jumps,
coverage reaching the playhead within ~8s of each); (2) a quick multi-tab
smoke test (two videos open simultaneously, confirm both transcribe
correctly with the new serialized-transcriber mutex in place, no starvation
of either tab); (3) visual confirmation of the status pill's three states
and the `pm_showStatus` toggle; (4) a changeType-triggering quality switch
(if reproducible) confirming an active word mute is NOT interrupted; (5)
`verify/caption_correlate.mjs` median/IQR sync numbers.

## 0.1.16: URGENT - appendBuffer-is-async regression (total pipeline failure) + Whisper Web Worker migration

### 1. Root cause: `SourceBuffer.appendBuffer()` is asynchronous - `.buffered` doesn't update until `updateend`

A 0.1.15 log (resume at 3257 on `o-7Fvkq-Nug`) showed offscreen repeating
`[PM-NO-WINDOW] no captured audio range at or ahead of currentTime` forever,
while capture.js logged `rangesBefore==rangesAfter` and `growth=none` on
EVERY line. Root cause, confirmed against historical logs going all the way
back: `capture.js`'s `appendBuffer` hook diffed `this.buffered` **immediately
after calling the original `appendBuffer`**, but `appendBuffer()` is async -
the browser does not actually apply the append (and grow `.buffered`) until
the SourceBuffer's own `'updateend'` event fires. Reading `.buffered`
synchronously right after the call reads the OLD, pre-append ranges every
single time - `growth` has been `none` on every appended segment for this
codebase's entire history. This was harmless while nothing downstream
actually depended on `growthAbsStart`/`growthAbsEnd` for anything other than
the `[PM-CHECK]` cross-check log (a log line that's ALWAYS said "n/a" -
which, in hindsight, should have been the tell). **0.1.14's picker redesign
made this fatal for the first time**: it feeds `s.bufferedRanges` - the
picker's sole source of "what audio is available" - exclusively from
`growthAbsStart`/`growthAbsEnd`. With growth always empty, `s.bufferedRanges`
never grew, and offscreen produced ZERO transcription windows, ever, on any
video. 0.1.14 was verified only with a unit-test harness using synthetic
growth values fed directly to the picker function in isolation - this was
the first real live run of that code path, and it immediately surfaced the
bug the synthetic tests couldn't: they never exercised the actual
`findGrowth()` call against real (stale) `.buffered` state.

**Fix (`capture.js`)**: `rangesBefore` is still snapshotted synchronously
(correct - it reflects real pre-append state at the moment of the call).
Everything that needs the POST-append state (`rangesAfter`, `growth`, the
eviction-captured-range merge, the `[PM-CHAIN]` log, and `post()` itself) is
now deferred into a small FIFO queue (`pendingAppends`) drained by a
`'updateend'` listener on the SourceBuffer, at which point `.buffered` has
actually updated. `finishAppendProcessing()` does the deferred work using
the queued item's captured-at-append-time fields (`segmentCount`, `isInit`,
`localTicks`/`localTimeSec`, the raw bytes) plus the NOW-correct
`rangesAfter`/`growth`. A defensive (expected to be dead-code-in-practice)
fallback handles the case where `sb.updating` is somehow already `false`
immediately after the call, processing inline instead of waiting for an
event that already fired. Ad-skip detection stays synchronous at append
time (an ad segment is dropped outright - it never needs growth info since
it's never posted).

This also retroactively explains and fixes a SECOND long-standing bug: the
0.1.13 capture-miss eviction mechanism's `evictionState.captured` tracking
(used to decide whether a buffered-but-uncaptured span exists) was ALSO fed
exclusively from `growth`, and was therefore ALSO silently broken this
entire time - the eviction mechanism could never correctly distinguish
"captured" from "not captured" because "captured" (via growth) never
registered as true for anything. This is now fixed for free by the same
change.

Two fix options were on the table; (a) (queue-and-defer to `updateend`,
implemented above) was chosen over (b) (deriving availability from decoded
data directly, e.g. from mediabunny's own cluster-timecode/decode progress,
removing the picker's dependency on growth entirely). (b) is arguably more
in the "media time in, media time out" spirit and was evaluated, but
requires the picker to know "what's been fed to the demuxer" in media time
BEFORE a decode attempt happens - mediabunny doesn't expose that as a
ready-made signal, and building one would mean tracking cluster timecodes
independently of decode, a nontrivial new mechanism. Given this was a
LIVE, TOTAL pipeline failure, (a) was shipped as the safe, bounded,
well-understood fix; (b) remains a candidate for a future round if the
`updateend`-queue approach ever proves insufficient.

### 2. Whisper inference moved to a dedicated Web Worker (popup paint fix)

Separate live user report: clicking the extension icon took ~15s for the
popup to paint. Diagnosis: extension pages can share a renderer process,
and Whisper inference (`onnxruntime-web` WASM, `numThreads=1`, no proxy) ran
in multi-second SYNCHRONOUS bursts on the offscreen document's own main
thread - starving the popup's own load/paint in that shared process.

Two routes were available: (a) turn on `env.backends.onnx.wasm.proxy`
(onnxruntime-web's own built-in worker-offload mode) if its internal proxy
worker can load from a packaged file rather than a blob (MV3's CSP blocks
blob workers, which is exactly why proxy was left off originally - this was
the never-verified open question), or (b) hand-roll a dedicated worker
ourselves. Inspected `node_modules/onnxruntime-web`'s bundled output
directly: its pthread/threading worker uses `new Worker(new
URL(import.meta.url), {type:'module'})` (not blob-based, promising), but
tracing exactly how the SEPARATE `wasm.proxy` inference-offload worker gets
instantiated through the minified bundle was not something that could be
confirmed with confidence without a live test - and a live test of route
(a) risks silently breaking transcription entirely if wrong, which is far
worse than the status quo. **Chose route (b)**, hand-rolled, as the lower-
risk, fully-verifiable-by-code-review option:

- **New `src/whisper-worker-src.js`**, bundled to `dist/whisper.worker.js`
  via a second `esbuild.build()` call in `build.js` (kept as two separate
  builds, not one multi-entry build, so each output keeps its existing
  fixed filename - `offscreen.html` and the `new Worker(...)` call site
  both reference these paths directly). This file owns `transformers.js`'s
  `pipeline`/`env` entirely now (moved out of `offscreen-src.js`, which no
  longer imports `@huggingface/transformers` at all) - model loading
  (`getTranscriber`, with the 0.1.15 rejected-promise-cache fix carried
  over intact) and the actual `transcriber(...)` call both run here, off
  the offscreen document's main thread.
- **Scope kept deliberately narrow**: ONLY model load + inference moved.
  Demux (mediabunny) stays in `offscreen-src.js`'s main thread - WebCodecs
  decode is comparatively fast/non-blocking in practice (the diagnosed
  bottleneck is specifically Whisper's synchronous WASM inference, not
  demux), and mediabunny's `Input`/`ReadableStreamSource`/`AudioBufferSink`
  objects aren't transferable across a worker boundary anyway - moving
  demux into the worker too would mean re-architecting session/run state
  across two execution contexts for zero benefit toward the actual
  diagnosed problem. `windowToFloat16k`'s output (a plain, fully-resampled
  Float32Array with zero live mediabunny state left in it) is the natural,
  self-contained hand-off point.
- **Transferred, not copied**: `float16k`'s own buffer is transferred into
  the worker via `postMessage(msg, [float16k.buffer])` - the array is
  detached/unusable on the main-thread side afterward, which is safe
  because `transcribeWindow` never reads it again post-transfer. The
  per-word RMS energy sanity check (`rmsAt`), which used to run against
  `float16k` back on the main thread after transcription, now runs INSIDE
  the worker instead (where the PCM actually still is) and is returned
  per-chunk as `rms`, consumed via `tok.rms` in the word-building loop.
- **The worker has NO `chrome.*` API access** (deliberately not needed) -
  the wasm path base is handed over once in an `'init'` message from the
  main thread (which already has `chrome.runtime.getURL`), avoiding any
  dependency on uncertain worker-context extension-API availability.
- The 0.1.15 serialization mutex (`runSerialized`/`transcribeChain`) stays
  in `offscreen-src.js`'s main thread, now wrapping `transcribeInWorker(...)`
  calls instead of direct `transcriber(...)` calls - since the worker is a
  single dedicated thread anyway, this just avoids racing multiple
  in-flight `requestId` responses against each other for no benefit; it's
  unchanged in spirit from the 0.1.15 design.
- Request/response correlation is a simple incrementing `requestId` map
  (`pendingWorkerRequests`) - no ordering assumptions relied upon beyond
  what the mutex above already guarantees (at most one request in flight).

**Verification status**: both regression items are code-complete,
`node build.js` produces both `dist/offscreen.bundle.js` (now ~600KB,
transformers.js removed) and `dist/whisper.worker.js` (~1.4MB, contains
transformers.js), and all plain-JS files pass `node --check`. **Per the
standing constraint that only the user can trigger a `chrome://extensions`
reload, and that no prior code version's changes are visible until that
reload happens, the "windows actually produced" live check the coordinator
explicitly required for this fix could NOT be performed before requesting
the reload this time either** - there was no way to test 0.1.16's actual
behavior against the live, currently-loaded 0.1.15 code. This is flagged
explicitly (rather than silently skipped) per the coordinator's "no more
synthetic-only verification for picker changes" directive: the very next
action after this reload is confirmed must be watching a real session's
log for actual `[PM-WINDOW]` lines (not just `[PM-NO-WINDOW]`) appearing
after a big forward seek, before reporting this fix as verified.

## 0.1.17: cold-window aim fix, model preload, [PM-CATCHUP-TIME] metric, padding presets

0.1.16 confirmed working live by the user (mutes firing correctly, counter
working, growth fix good). Remaining complaint: ~20s uncovered->covered
after seeks. Their log decomposed it into two compounding causes, both
fixed here.

### 1. First window aimed at the wrong end of the captured range

A seek to t=3289 produced a first window of `[3280.00,3285.00)` - the
START of the freshly-captured range, entirely BEHIND the actual playhead
by the time transcription finished (playhead had reached ~3294 by then).
This wasted the single coldest, slowest window (see item 2 - model load
was ALSO being paid inline on this exact window) on audio already passed,
which the user would never hear protection for and gains nothing from
having transcribed promptly.

Fixed in `pickNextWindow` (`offscreen-src.js`): on any cold-start window
(first window of a session, or one opening a new disjoint region), the
picked `start` is now floored at `max(targetRange.start, currentTime - 1)`
- never at the captured range's own start when that's far behind the
playhead. If the ENTIRE currently-captured range is behind the playhead
(nothing usable near/ahead of it yet), the window is deferred outright
(`[PM-NO-WINDOW] cold-behind-playhead`) rather than wasting a slow cold
window on stale audio - safe mode's muting already protects the user while
waiting, and the next segment or two normally closes this gap within a
second or so. Audio behind the playhead is lowest priority by design now:
useful only for rewind protection, which can wait until ahead-coverage is
comfortable.

### 2. Model load cost paid inline on the first real window

`[PM-MODEL]` logged at the first window; that window's `wallMs=7634` for
5s of audio (rtf 1.53) vs. a steady-state ~0.2 rtf once warm - the
Whisper model's own load time was being paid INSIDE the first window's
timing, compounding item 1's problem (the slowest possible window landed
on the least useful audio).

Fixed in `whisper-worker-src.js`: `getTranscriber(DEFAULT_MODEL)` now
fires immediately (fire-and-forget) as soon as the worker receives its
`'init'` message at boot - the model is warm before any video/window ever
needs it, well before a user even navigates to a page. Re-fired via a new
`'preload'` worker message whenever `pm_model` actually changes
(`offscreen-src.js`'s `pm-config` handler), so switching models in the
popup warms the NEW one proactively too instead of paying that cost
inline on the next window after the switch.

### 3. `[PM-CATCHUP-TIME]` - the metric is now directly visible

Added to `content.js`: the `'seeking'` handler records
`session.catchupMeasureStart`/`catchupMeasureTargetT` whenever a seek lands
somewhere uncovered (a trivial/already-covered seek isn't measured - the
catch-up time is meaningless there). `runTickLogic()` checks
`isCovered(t)` every frame and, on the first frame it goes true, logs
`[PM-CATCHUP-TIME] seek to t=X.XX -> covered at t=Y.YY in Z.ZZs` and clears
the pending measurement - deliberately checked against plain `isCovered(t)`
rather than the `uncovered` variable (which also folds in `safeMode`/
`unanalyzable` state unrelated to the actual thing being timed). This is
now a `TLOG` line, so it shows up in every Copy Logs paste automatically -
target per the coordinator: ≤5s with a warm model (segments arrive ~1s
apart, a 5s cold window at ~0.2 rtf takes ~1-1.5s).

### Small addition: padding presets (`PMWordlist.settings.padding`)

The wordlist agent added an 8th settings key, `padding` ("tight"/"normal"/
"wide", default "normal"), consumed in `content.js`'s
`applyWordsToIntervals` via a new `currentPadding()` helper mapping to
lead/trail seconds: tight=0.15/0.10, normal=0.35/0.25 (unchanged from
before), wide=0.60/0.45. Read fresh per call (that function already runs
once per incoming window) - no `onChanged` wiring needed: existing armed
intervals keep whatever padding they were built with, new windows just
pick up whatever's current the next time matches are built. The
`strictness` settings key (consumed entirely inside `PMWordlist` matching)
needed no pipeline change - this file already reads individual named
settings keys rather than validating the object's shape/key count, so
extra keys are inherently non-breaking. Active padding now logged in
`[PM-SESSION]`.

### Verification status - live attempt blocked, documented plainly

Attempted the requested live verification (seek several times in a real
tab, read `[PM-CATCHUP-TIME]`; the still-owed 0.1.16 popup-paint-under-load
check; the standing jump-heavy/two-tab/caption-correlation checks) via
`claude-in-chrome` against the one connected browser
(`list_connected_browsers` showed exactly one, `isLocal: true`). Navigated
to the regression video (`o-7Fvkq-Nug`) in a new background tab, set
`volume=0` immediately per the standing protocol. Found: **no
`[PM-...]`-tagged console output at all** across two full page loads (only
a single unrelated YouTube-internal log line ever appeared), and **no
status-pill DOM element** (`🛡`-containing text, which the 0.1.15 status
pill renders on any video page whenever `pm_enabled`+`pm_showStatus`,
independent of transcription state) anywhere in the page - i.e. the
extension's content script does not appear to be active on this tab in
this connected browser at all, separate from anything this patch changed.
The player itself also appeared stuck at a fixed timestamp (50:00) across
two ~8s waits with no advancement, though that may be an unrelated
loading/throttling issue for this specific tab. Given no PM signal
whatsoever (not even pre-0.1.17 baseline behavior), this reads as "wrong
browser/profile connected" or "extension not loaded on this tab" rather
than a code regression - but this could NOT be distinguished with
confidence from here, so **no live verification claim is being made for
0.1.17 or for the still-owed 0.1.16 items**. Flagging explicitly rather
than silently skipping, per the standing "no unverified success claims"
rule. All code is syntax-checked and both bundles build cleanly
(`node build.js`); the cold-start-floor logic follows directly from the
already-unit-verified `pickNextWindow` range-selection logic (0.1.14) with
one additional floor/defer branch, not independently re-verified in
isolation this pass.

**Needed before any of this can be marked verified**: confirm which
Chrome window/profile actually has the unpacked extension loaded (the user
may need to point `claude-in-chrome` at that specific window, or confirm
there's only one Chrome instance and something else is wrong), then repeat
the reload + live seek-heavy + popup-paint + two-tab + caption-correlation
pass in that session.

## 0.1.18: eager warm-up, generation-based seek preemption, aim-ahead sizing, actionable status pill

User's 0.1.17 cold-start paste measured `[PM-CATCHUP-TIME]` at 13.30s and
15.93s - the preload+aim fixes from 0.1.17 alone were insufficient. Root
cause analysis of that paste found THREE compounding causes on top of the
already-fixed items; all fixed here, plus a UX request to make the status
pill actionable.

### 1. Stale cross-refresh work (the biggest single contributor)

A first window completed with `wallMs=131129` (131 SECONDS) aimed at
`[3363,3379)` - the PREVIOUS page-session's playhead region. Root cause: a
plain page REFRESH of the SAME video does not change capture.js's own
tracked video id, so its `'reset'` message (sent only on an ACTUAL
video-id change) never fires - the offscreen session for that
tabId:videoId key survived the refresh, in-flight/queued work and all,
and drained into the new page load, blocking the transcribe lane for 7+
seconds just from ONE stale window (let alone the full backlog).

Fixed: `content.js` now sends a `reset` unconditionally at its OWN
startup (`resetSession(currentVideoIdFromLocation())`, called right after
`connectPort()`) - i.e. on every page load, not just a detected video-id
change, so offscreen always starts a tab clean regardless of whether
capture.js thinks the video id moved. Paired with a new per-session
**generation counter** (`s.generation`) in `offscreen-src.js`:
`dropSessionsForTab` bumps it on the (about-to-be-deleted) session object
before deleting it from the map, so an already-in-flight closure (a
running `maybeProcess` loop or `transcribeWindow` call from before the
reset - can't be aborted mid-WASM-call) sees the bump and discards its own
work (`[PM-STALE]`) instead of applying a stale result to what's supposed
to be a fresh session.

### 2. No seek preemption + a duplicate pick

A second seek waited ~8s for an old-region window (`[3497,3509]`,
`wallMs=43000` including queue) to finish before the new playhead region
got picked at all. Fixed with the SAME generation mechanism: `content.js`'s
`'seeking'` handler now sends a `{type:'seek'}` port message; offscreen's
`pm-seek` handler bumps `s.generation` (coverage/session state untouched -
"seek keeps everything" is unaffected) and immediately re-kicks
`maybeProcess(s)`. `maybeProcess`'s loop captures its OWN `loopGeneration`
and stops picking any FURTHER windows the moment it notices a bump - the
one already-dispatched window still has to finish (unabortable), but the
loop no longer keeps grinding through a whole backlog of now-irrelevant
old-region windows first, bounding the worst-case wait to roughly one
window's own compute time.

Separately, the SAME paste showed `[2520.17,2525.17)` transcribed TWICE
back-to-back (its own `[PM-TIMELINE-ALARM]` fired on the resulting
near-duplicate text) - the picker had no way to know a span was already
dispatched and not yet reflected in `s.covered`. Fixed with
`s.inFlightWindows` (a `Set` of in-flight `"start,end"` keys, added/removed
around each `transcribeWindow` call in `maybeProcess`'s loop) folded into a
new `coverageViewForPicking(s)` used ONLY for picking decisions (never
mutating `s.covered` itself, which must stay the true, transcription-
confirmed coverage) - the picker now skips past an in-flight span exactly
like it already skips past a genuinely-covered one. Unit-verified in
isolation: a picker call starting exactly at an in-flight span's boundary
correctly returns the point just past it, not the span itself.

### 3. Aim ahead, not behind - rtf-aware cold window sizing

A cold window `[3334,3339)` was correctly aimed at the playhead AT PICK
TIME, but the playhead had moved to 3341 by the time transcription
finished - the window's own END must be ahead of the playhead-at-
completion to be useful at all. `pickNextWindow`'s cold-start branch now
grows the baseline 2.5s micro window (see below) using the session's last
measured compute-only rtf, solving `windowDuration * (1 - rtf) >= gap +
margin` for `windowDuration` (clamped rtf range 0.15-0.7 so a slow/cold
measurement can't produce a negative/absurd required size - falls back to
a generously large, still WINDOW_S-capped window in that case rather than
doing fragile math with an rtf near or above 1). Unit-verified: a warm
model (rtf 0.2) with a small gap keeps the 2.5s baseline; the formula
scales up correctly as gap/rtf increase, always capped at `WINDOW_S`.

### 4. wallMs split into decodeMs/queueMs/computeMs

`wallMs`-derived `rtf` was showing 3-8 right next to `modelRtf` of 0.2-0.5
in the SAME paste - almost all of the gap was QUEUE wait (a stale
session's backlog competing for the shared worker mutex), not compute, but
`wallMs` alone couldn't show that. `transcribeWindow` now tracks
`decodeMs` (demux+resample), `queueMs` (wait for the worker mutex to free
up), and `computeMs` (the worker's own round trip) separately, threaded
through `pm-words-result` -> `background.js` -> content.js's
`[PM-WINDOW]` log line alongside the existing `wallMs`/`rtf`/`modelRtf`.

### 5. Eager warm-up + [PM-WARM] visibility

Re-audited the "offscreen doc + worker created on demand" theory:
`background.js` already calls `ensureOffscreenDocument()` unconditionally
at top-level script load AND on `onStartup`/`onInstalled` - NOT gated on
any tab/port event - so the worker (and its boot-time model preload) was
already starting as early as technically possible. What was genuinely
missing was VISIBILITY: that warm-up happened before any session/tab
existed to log through, so a Copy Logs paste could never confirm it
happened or how long it took. Fixed: the worker now measures
`workerSpawnMs` (script start to `'init'` received) and `modelLoadMs`
(init to model ready) and reports them via a new `'warm-ready'` message;
`offscreen-src.js` buffers this (`warmInfo`) and surfaces it as
`[PM-WARM]` to the FIRST session created after boot (`logWarmToSession`,
called from `getOrCreateSession` for a new session, and looped over all
sessions when `warm-ready` itself arrives) - whichever happens first. This
is presentation of already-eager behavior, not a new warm-up mechanism;
the real fixes for "still uncovered too long" are items 1-4 above.

### 6. Micro first window: 2.5s (was 5s)

`COLD_START_WINDOW_S` cut from 5 to 2.5 - with a warm model (~0.2 rtf),
that's first coverage in ~0.5s of compute. Grows per item 3's rtf-aware
sizing when needed.

### UX addition: actionable status pill

User feedback: the plain "Analyzing…" state gave no signal on whether
pausing-and-waiting would help (audio already captured, just queued) or
whether continued playback was needed (to make YouTube fetch further).
Replaced with four data-driven states, computed entirely from data
`content.js` already receives (no new pipeline plumbing - this is
presentation only, per the explicit framing):
- **Protected** - unchanged, coverage extends >=5s past the playhead.
- **"Analyzing - safe to pause (~Ns)"** - the playhead's own region IS in
  `session.bufferedRanges` (a new content.js-side mirror of the same
  interval-set concept offscreen tracks, built here purely from
  `growthAbsStart`/`growthAbsEnd` already flowing through the segment
  relay - no new message) and just hasn't been transcribed yet. ETA =
  remaining-uncovered-audio-in-that-range × last measured rtf (from
  `addWords`' own `computeMs`/`modelRtf`), capped at 30s, recomputed at
  the pill's existing ~2Hz render cadence.
- **"Buffering + analyzing…"** - not captured yet, but a segment landed
  within the last 3s (`session.lastBufferedGrowthWall`, mirrored the same
  way) - still fine to wait.
- **"Press play to load audio"** - not captured, and no capture growth for
  4s+ - YouTube has stopped fetching (e.g. paused before the buffer
  reached this position); the one state actually needing user action.
- **Off** - unchanged (DRM/unanalyzable).

**Verification status**: all six backend items are syntax-checked
(`node --check`) and both bundles build cleanly (`node build.js`). Unit-
verified in isolation (standalone Node harness): the rtf-aware cold-window
formula across warm/cold/pathological rtf inputs, the uncovered-duration-
within-a-range helper (used both by the picker's fully-covered check and
the new status pill ETA), and the in-flight-aware coverage view correctly
letting the picker skip past an already-dispatched span. **Live
verification attempted again this pass and still blocked**: retried the
`claude-in-chrome` check from the previous round (new background tab,
`volume=0` immediately, regression video) - same result as before, zero
`[PM-...]` console output and no status-pill DOM element found after two
separate attempts across two different page loads. This is the SAME
unresolved "automation browser doesn't show the extension active"
condition flagged last round, not a new finding - still not distinguishable
from here as a wrong-profile/window issue vs. anything else. No live
verification claim is made for 0.1.18, the actionable status pill's three
new states, or any of the still-outstanding 0.1.16 items (popup-paint,
jump-heavy, two-tab, caption-correlation) for the same reason.

## 0.1.19: status pill judges playhead horizon, not whole backlog

User-diagnosed bug: the pill stuck on "Analyzing - safe to pause (~Ns)"
during ordinary protected playback. Root cause, confirmed by the user's own
read of `computeStatusState()`: the "captured, just queued" ETA branch
computed `uncoveredDurationWithin(session.coveredIntervals, t,
playheadRange.end)` - `playheadRange.end` is the end of the whole captured
(buffered) span at the playhead, which normally extends far ahead of the
playhead by design (buffering intentionally leads transcription, per the
architecture notes) and is essentially never fully transcribed yet. So the
ETA (and, on the two-point `isCovered(t) && isCovered(t+5)` "Protected"
check, potentially the state itself) was judged against that whole backlog
instead of the ~5s window that actually determines whether it's safe to
keep watching uninterrupted.

Fixed in `content.js`'s `computeStatusState()`:
- New `PROTECT_MARGIN` (5s, was an inline literal) names the lookahead
  window explicitly.
- **"Protected"** is now `uncoveredDurationWithin(coveredIntervals, t, t +
  PROTECT_MARGIN) <= COVERAGE_EPS` - a real "is this whole window covered"
  check (via the existing `uncoveredDurationWithin` helper) rather than two
  independent point checks (`isCovered(t)` and `isCovered(t+5)`), which
  could not detect a gap in between the two endpoints.
- **"Analyzing - safe to pause (~Ns)"**'s ETA now sums uncovered duration
  only within `[t, min(t + PROTECT_MARGIN, playheadRange.end)]` - bounded
  by the protection horizon, never by however far capture has buffered
  ahead. During normal playback this converges to "Protected" as soon as
  the horizon itself is transcribed, instead of never converging because
  the backlog behind it never empties.
- "Buffering + analyzing…" / "Press play to load audio" are unchanged
  (already playhead-local via `bufferedRanges`/`lastBufferedGrowthWall`) -
  only the two branches above were reading the whole backlog.

Not re-verified live (no working `claude-in-chrome` session against this
regression this pass) - `node --check content.js` passes; the change is
presentation-only over already-existing data (`coveredIntervals`,
`bufferedRanges`), same as 0.1.18's original pill design.

## 0.1.20: sequential-decoder run boundary on backward seek, location-based loop breaker, mode-independent stall watchdog

A 0.1.18 Copy Logs paste (backward scrub on `o-7Fvkq-Nug`, `catchupMode="play"`)
surfaced three real bugs, all fixed here. Positive signal preserved from
that same paste: `[PM-CATCHUP-TIME]` down to 7.76s cold (was 13-16s in
0.1.17), `[PM-WARM]` confirms the model is ready before any session starts,
`[PM-STALE]` generation-discard is working, and `[PM-FIRST-COVERAGE]`'s
breakdown correctly shows compute (4.4s of 4.5s) - not queueing or demux -
dominating first coverage; a one-off tiny warmup inference at preload time
(burning in the WASM kernels before the first real window ever needs one)
is a cheap candidate win for later, not done this pass.

### 1. Covered-span re-transcription loop (regression from 0.1.18)

Spans `[2587.02,2593.69)` and `[2587.02,~2590.9)` were each re-transcribed
~5x, alternating, over 40s - mostly 0-word results - despite content.js
already showing coverage `[2587.0-2593.7]`. Traced to the SAME stuck
location as the original 0.1.14 "18-minute loop" bug, but the 0.1.14
loop-breaker (`s.windowAttempts`, keyed on the EXACT `(absStart,absEnd)`
pair) never caught it this time: 0.1.18's rtf-aware cold-window growth
(`pickNextWindow`'s `neededS` math) sizes a cold window off
`s.lastKnownRtf`, which updates after every attempt - including a 0-word
one that still "successfully" decoded - so each retry at the same stuck
START got a slightly different rtf estimate and therefore a different exact
END, defeating the exact-span key even though it was genuinely the same
stuck spot every time. (`coverageViewForPicking`'s in-flight bookkeeping
itself was audited and is correct - in-flight keys are added/removed
symmetrically around `transcribeWindow`, and the loop-breaker checks real
`s.covered`, not the in-flight view - so that was not an independent
contributor here.)

**Fix (`offscreen-src.js`, `transcribeWindow`)**: the loop-breaker now keys
on a rounded START LOCATION (`Math.round(absStart / LOOP_START_BUCKET_S) *
LOOP_START_BUCKET_S`, 1s buckets) and checks only a small anchor window
right at that start, instead of the exact `(absStart,absEnd)` pair - robust
to the end drifting attempt to attempt for the same stuck location, while
different (forward-progressing) starts still get separate counters. Same
`WINDOW_LOOP_THRESHOLD` (3) and force-cover-and-alarm behavior as before.
Unit-verified in isolation: a simulated stuck start with three different
exact end values (matching the live paste's shape) force-covers on the 3rd
attempt; a normally-resolving window and a forward-progressing next window
both leave no stale counters and never trip the breaker.

The most common REAL cause of a decode landing away from its requested
span in the first place is fixed separately below (item 2) - this
loop-breaker fix is defense-in-depth so the same regression class can't
recur silently even if some other cause produces the same symptom later.

### 2. Backward seek → undecodable forever (sequential-decoder mismatch)

Seeking 2588 → 2464.94 captured segments fine (`seg=44 NEW-RANGE
[2460,2466.7)`, ranges grew to `[2460-2510]`), but produced dozens of
`[PM-SKIP] no decodable audio in this run at that time yet`. Root cause:
the backward-seek bytes landed on the SAME SourceBuffer as the forward
playback that preceded it, so `segmentCount` never reset and `isInit`
stayed `false` - nothing told offscreen a new demux run was needed - but
offscreen's mediabunny `Input` for that run is a persistent, SEQUENTIAL
streaming decoder (see "0.1.6": `ReadableStreamSource` feeding one `Input`
across the run's whole lifetime). Once it had consumed cluster timestamps
for 2580-2670, it structurally could not rewind to serve 2460-2510 from
the SAME stream.

**Fix**: a timeline DISCONTINUITY now opens a new run exactly like a real
init segment does, reusing capture.js's own already-computed NEW-RANGE
growth detection (`findGrowth`'s `isNewRange`) rather than adding any new
wire message. `capture.js` now caches the real init segment's bytes per
SourceBuffer lifetime (`cachedInitBytes`, set whenever `segmentCount===1`).
In `finishAppendProcessing`, whenever growth reports a NEW-RANGE that isn't
itself already a real init segment (`!item.isInit`), it resends the cached
init bytes as a synthetic `isInit:true` segment (`isSyntheticRunBoundary:
true`) immediately before the real one - offscreen's existing `pm-segment`
handler already treats `isInit:true` as "open a fresh run"
(`newRun()`/`s.currentRun`), so no changes were needed on that side at all.
The old run is left for the existing 0.1.15 pruning (`KEEP_RUNS=2`) to
reclaim; session-level coverage/word-dedupe (`s.covered`, `s.allWords`)
already span run boundaries by design and are untouched. Applied uniformly
to ANY disjoint NEW-RANGE (forward or backward), not just backward - a
forward jump within one SourceBuffer has the same "no fresh init segment"
shape (the original 0.1.14 "jump forward = uncovered forever" bug), and
even though a forward jump's bytes are less likely to break the sequential
decoder in practice, opening a fresh run for it too is strictly safer than
relying on direction, at the cost of one extra pruned-eventually run.
Unit-verified in isolation: `findGrowth` on the reported before/after
buffered-range snapshots correctly reports the backward jump as a
NEW-RANGE (and ordinary in-place growth as NOT one); the discontinuity gate
correctly fires only on NEW-RANGE-without-its-own-init and never
double-fires on a genuine init segment.

### 3. Pipeline death with no revival in "play" mode

After the skip storm, zero further transcription windows for 3+ minutes -
nothing but SW-idle port reconnects. Confirmed `maybeProcess(s)` in
`offscreen-src.js` is already called unconditionally at the end of every
`pm-segment` message regardless of catch-up mode (offscreen has no concept
of `catchupMode` at all) - that path was not broken. The real gap was in
`content.js`'s stall watchdog: `stalling` was gated on `uncovered`, and
`uncovered = settings.safeMode && !isCovered(t) && !session.unanalyzable` -
`safeMode` is derived as `catchupMode !== 'play'` (see 0.1.18's
`pm_catchupMode` note), so in `catchupMode: "play"` mode `uncovered` (and
therefore `stalling`) could NEVER be true, no matter how long the pipeline
had genuinely died. "play" mode had no recovery path at all.

**Fix (`content.js`, `runTickLogic`)**: the watchdog's own `stalling` input
is now computed independently of `safeMode`/`catchupMode` -
`playheadUncovered = !isCovered(t) && !session.unanalyzable` - AND requires
that audio is actually CAPTURED at the playhead already, via the same
`session.bufferedRanges` interval set the 0.1.18/0.1.19 status pill already
mirrors from `growthAbsStart`/`growthAbsEnd`. The captured-audio condition
matters: without it this would fire constantly whenever the playhead is
simply ahead of capture itself (normal - nothing to restart yet), not only
when audio genuinely exists and transcription isn't happening. The
mode-specific "is a restart-worthy state even possible right now"
sub-condition (`!video.paused` for play/mute, `catchupPausedByUs`/
`!video.paused` for pause mode) is unchanged. `requestStallRecovery()`
itself only sends `{type:'restart'}` and an eviction-check ping - it never
engages mute - so "play" mode now gets pipeline recovery without ever being
muted by this path, per the explicit requirement. `settings.safeMode`
itself, and every muting/pausing decision elsewhere in `runTickLogic`, are
completely unchanged - this only widens what can trigger a `restart`
request.

**Verification status**: all three fixes are syntax-checked (`node
--check` on the plain-JS files; an ES-module check on `offscreen-src.js`)
and `node build.js` bundles clean. Unit-verified in isolation (standalone
Node harness, no live bytes): `findGrowth`'s NEW-RANGE detection on the
exact reported before/after ranges, the discontinuity gate's on/off cases,
and the location-bucketed loop breaker's stuck-vs-resolved-vs-forward-
progressing cases - all pass. **Not yet run live** - no working
`claude-in-chrome` session against this regression this pass (noted
plainly, not glossed over); the next verification step is a real backward
scrub on `o-7Fvkq-Nug` in `catchupMode: "play"`, confirming (1) no
`[PM-SKIP] no decodable audio` storm after a backward seek (should now
show a `[PM-RUN-BOUNDARY]` line instead), (2) no repeated re-transcription
of the same location (should show at most a couple of attempts before
either resolving normally or a single `[PM-WINDOW-LOOP]` alarm), and (3) a
forced stall (e.g. throttle the tab) in "play" mode actually produces a
`[PM-STALL]`/restart within ~15s instead of silence.

## 0.1.21: silent AAC/fMP4 hang (bounded stage timeouts) + live-stream pill candor

A 0.1.20 live user session hit a LIVE STREAM (`videoId=/live/yCTJQrXt9x8`,
`audio/mp4` with `codecs="mp4a.40.2"` - the fMP4/AAC path flagged as
"never exercised" in every prior version's Known Gaps section, now finally
exercised for real). Capture worked correctly (segments landed, ranges
grew, 0.1.20's run-boundary fired correctly on the seek) - but offscreen
produced ZERO windows, ZERO skips, and ZERO errors for 2+ minutes after one
initial `[PM-NO-WINDOW]`. Two fixes.

### 1. Silent death: bounded stage timeouts around the demux/decode path

**Traced by elimination, not guessed.** Every existing failure path in
`transcribeWindow` (`offscreen-src.js`) was audited against the "zero
skips, zero errors" evidence:
- `getPrimaryAudioTrack()` resolving with a falsy track logs its own
  `[PM-SKIP]` - never seen, so track resolution didn't fail that way.
- `sink.buffers()` throwing is caught and logs `[PM-SKIP]`/`[PM-DEMUX-ERR]`
  - never seen either.
- `s.processing` staying `true` forever (masking the stall from
  content.js's watchdog, since `sendHeartbeat`'s `setInterval` keeps firing
  regardless of what `maybeProcess`'s `for(;;)` loop is actually stuck
  awaiting) is consistent with everything observed: a single attempt stuck
  inside an **unsettled promise with no rejection at all**.

The only remaining explanation is a promise from mediabunny/WebCodecs
(`getPrimaryAudioTrack()`, `track.getSampleRate()`, or the
`sink.buffers()` decode generator) that simply never resolves NOR rejects
on this specific container/codec combination. This is a real gap in what
this file can audit from outside a third-party library's internals - MP4
box-header parsing (`readMetadata()`'s box-scanning loop, the
`Mp4InputFormat`/`WebMInputFormat` format-sniffing checks, and
`AudioBufferSink`'s WebCodecs-backed decode) were all read end-to-end this
pass looking for a concrete bug (does anything require WebM-specific
fields? does the fragmented-MP4 "moof without moov requires
`InputOptions.initInput`" throw path apply here? - no: every run here
always starts with a real cached init segment, own or resent per 0.1.20's
run-boundary fix, so a `moov` should always be found first) - nothing
conclusively reproducible was found without a live AAC/fMP4 session to
step through, which this pass didn't have (WebCodecs is a real-browser API
with no Node polyfill available in this environment, so a from-scratch
fMP4/AAC fixture couldn't actually be run against mediabunny's real decode
path here either - noted plainly rather than faked).

**Fix, scoped to what this file CAN own**: per the standing "every
did-not-attempt must surface" rule, a hang with no rejection can't be
caught with a plain `try/catch` - so `transcribeWindow` now races the three
highest-risk mediabunny calls (`getPrimaryAudioTrack()`,
`track.getSampleRate()`, and the whole `sink.buffers()` decode loop, each
wrapped as one bounded unit) against a new `withStageTimeout()` helper
(`STAGE_TIMEOUT_MS` = 25s, well above any legitimate stage per the
measured RTF table). A timeout converts "silently hangs forever" into a
loud `[PM-HANG]` diag within a bounded time, REGARDLESS of the underlying
reason - this makes the failure mode visible and recoverable without fully
root-causing mediabunny's internals blind. `run.trackReadyPromise` itself
is left untouched on a track-ready timeout (only OUR wait on it is
bounded) so a genuinely-slow-but-eventually-resolving promise still gets
picked up for free by the next attempt. Repeated hangs/errors on the exact
same window (`s.sinkErrorAttempts`, reused from 0.1.15's DRM-detection
counter, now covers both a thrown decode error AND a stage timeout under
one `SINK_ERROR_THRESHOLD`-gated counter) still eventually call
`markUnanalyzable()` rather than retrying a permanently-broken combination
forever, loudly, every 25s. A `[PM-STAGE]` breadcrumb now also logs once
per run right before the track-ready await starts, so a future paste shows
exactly which stage a stuck attempt is in even before a hang fully
materializes.

**Explicitly NOT fixed this pass** (documented, not silently dropped): the
worker-side `transcribeInWorker()` call (the actual Whisper inference,
serialized globally via `runSerialized`'s promise-chain mutex) is NOT
wrapped in a stage timeout. A hang there is architecturally worse than the
demux-stage hangs fixed above - the global mutex chain itself would stay
blocked even if our own await timed out, wedging transcription for EVERY
tab, not just the live-stream one, and unwedging it safely (e.g. resetting
the chain out from under an unabortable worker call) needs more care than
this pass had room for. The live evidence (zero skips before ever reaching
this stage) points at the demux side, not this one, so it was left alone
rather than risk a partial, worse-than-nothing fix. Flagged as a known
residual gap below.

### 2. Live-stream pill candor (no full live-stream support - deferred by design)

Per the coordinator's explicit scope: do NOT attempt full live-stream
support. Two plain, narrow changes:

- **Detection** (`content.js`, `isLiveStream()`): `video.duration ===
  Infinity` (the standard, spec-level HTML5 signal for a live stream, not
  YouTube-specific) as the primary check, OR-ed with YouTube's own
  `#movie_player.ytp-live` class as a defensive fallback in case some live
  variant ever reports a finite duration.
- **Pill** (`computeStatusState()`): a live stream now short-circuits
  straight to a new `{kind:'live'}` state, rendered as `🛡 Live - limited
  support`, BEFORE any of the coverage-horizon math runs - the existing
  "Protected"/"Analyzing - safe to pause (~Ns)" states both implicitly
  promise something (a real ETA, or "nothing to do") that doesn't hold the
  same way against a moving live edge with no fixed end and a coverage
  backlog that may never fully close.
- **Transcription itself is unchanged** - the pipeline already does
  best-effort transcription against whatever DVR/buffered window exists,
  with no special-casing needed; this pass only stops the pill from lying
  about what that best-effort protection actually guarantees. Muting/
  pause-catchup logic in `runTickLogic()` is also unchanged - safe mode can
  still mute/pause against a live stream's uncovered regions exactly as it
  always has (this is the accepted, documented limitation of "limited
  support," not silently patched over).

**Verification status**: `node --check content.js`, an ES-module check on
`offscreen-src.js`, and `node build.js` all pass. Unit-verified in
isolation (standalone Node harness, no mediabunny/WebCodecs dependency
needed for this specific piece): `withStageTimeout()` converts a
never-settling promise into a loud, correctly-labeled rejection within its
bound, lets a fast-resolving promise through untouched, propagates a
genuine rejection's real message unmodified (not masked by the timeout
machinery), and clears its timer promptly on the fast path (no leaked
timer). `isLiveStream()`'s own logic is a two-line pure check not
exercised by a separate harness - trivial enough to read-verify directly.
**Not verified live** - no working `claude-in-chrome` session against a
real live stream this pass, and (per above) no way to run a real AAC/fMP4
decode through mediabunny/WebCodecs outside an actual browser either. The
next live pass should confirm: (1) the same live-stream session now
produces a `[PM-STAGE]`/`[PM-HANG]` line within ~25s instead of eternal
silence, (2) `s.sinkErrorAttempts`-driven `markUnanalyzable()` eventually
fires (and the pill correctly falls back to `Off`, taking priority over
`Live`, per `computeStatusState()`'s existing `unanalyzable` check running
first) if the hang is genuinely permanent for this stream, (3) the pill
shows `Live - limited support` immediately on any live video regardless of
coverage state, and (4) whether the underlying AAC/fMP4 hang is EVER
actually just a slow-but-real resolve (i.e., whether raising
`STAGE_TIMEOUT_MS` alone would have "fixed" it) - worth checking once a
`[PM-HANG]` line is actually captured, since that would redirect the real
fix toward "give it longer" rather than "something is actually stuck."

## 0.1.22: end-of-video horizon clamp (pill stuck "Analyzing" forever at the end)

User-reported: the pill showed "Analyzing" forever at the END of a video,
even once everything real had actually finished transcribing. Root cause:
`computeStatusState()`'s `horizonEnd = t + PROTECT_MARGIN` (0.1.19's
"whole-window-covered" Protected check) extends past `video.duration` in
the final `PROTECT_MARGIN` (5s) seconds of any video - audio that doesn't
exist and can never be captured/covered - so
`uncoveredDurationWithin(coveredIntervals, t, horizonEnd)` could never
reach `<= COVERAGE_EPS` even with the entire real video fully transcribed,
because the phantom `[duration, horizonEnd)` slice always contributes
uncovered duration. The pill then fell through to the `analyzing-safe`
branch's ETA math (bounded to `Math.min(horizonEnd, playheadRange.end)`,
which DOES happen to clamp near `duration` in practice via
`playheadRange.end` - which is why this showed as a stuck "Analyzing", not
a wrong ETA number) - permanently, since nothing could ever make the FIRST
(unclamped) check succeed.

**Fix (`content.js`, `computeStatusState`)**: `horizonEnd` is now clamped to
`Math.min(t + PROTECT_MARGIN, video.duration)` whenever `video.duration` is
finite (a live stream - `duration === Infinity` - already short-circuits
to the `live` pill state earlier in this same function, from 0.1.21, before
this code ever runs). Every downstream use of `horizonEnd` - the
`protected` check right below, and the ETA's existing `Math.min(horizonEnd,
playheadRange.end)` - inherits the clamp automatically from the single
assignment. Once the clamped horizon collapses to `<= t` (playhead at or
past the last coverable point), `uncoveredDurationWithin`'s own `hi <= lo`
case naturally returns 0 uncovered duration with no separate near-the-end
special case needed - which also means the `buffering`/`needs-play`
branches (only reached after the `protected` check fails) can never
mis-fire for a region past the end either, satisfying the "never claim
'press play to load audio' for a region past the end" requirement for
free from the same one-line fix.

**Audited the safe-mode mute/pause-catchup path for the same trap, per the
coordinator's explicit ask** - every mute/pause/resume decision in
`runTickLogic()`, `handleCatchupModeChanged()`, `pauseForCatchup()`, and
`resumeFromCatchup()` uses a plain `isCovered(t)` (or
`isCovered(video.currentTime)`) POINT check at the exact playhead, never a
`[t, t+margin]` horizon look-ahead - confirmed by grepping every
`isCovered(` call site in `content.js`. Since `t` itself is always real,
coverable audio (never past `duration`), these paths were never exposed to
the phantom-past-the-end gap the pill was - muting/pause-catchup correctly
releases as soon as transcription reaches the playhead itself, with no
change needed. This matches the coordinator's own hunch ("isCovered(t)
point checks are probably fine") - confirmed rather than assumed.

**Verification status**: `node --check content.js` passes. Unit-verified
in isolation (standalone Node harness re-implementing the exact clamp +
`uncoveredDurationWithin` decision logic, matching the real
`computeStatusState` line-for-line): a fully-transcribed video at
t=119.5/duration=120 now reads `Protected` instead of the reported stuck
`Analyzing`; t exactly at `duration` with zero coverage still reads
`Protected` (nothing left to cover); a genuine, real, well-before-the-end
uncovered gap is unaffected by the clamp and still reads `Analyzing`; a
live (`Infinity` duration) video leaves the clamp itself a no-op (matching
that `isLiveStream()` is what actually gates it in real code); and a
worst-case "nothing buffered or covered at all, exactly at the end" scenario
still resolves to `Protected`, never `needs-play`. **Not verified live** -
no browser session this pass; the next live pass should confirm the pill
actually flips to `Protected` in the final seconds of a real video, not
just in the isolated harness's model of the logic.

## 0.1.23: fed-data clamp + end-of-stream flush (fixes the idle-loop AND the AAC hang), structural idle-gate choke point

Two coordinator messages, superseding each other: the first asked to
trace why maybeProcess's loop went idle (a fresh video, paused at t=2.01,
captured-but-uncovered audio sitting at [2.5,5.06)) with zero diagnostics
for 5+s; the second arrived with the ACTUAL live evidence that explains
both this bug and 0.1.21's AAC/fMP4 mystery in one shot: `"[PM-SKIP]
window [2.51,19.60) skipped: sink.buffers ... stage 'decode' did not
settle within 25000ms (hung promise)"` - requested while only `[0,5.06]`
had actually reached the run's demux stream, and the same hang recurred
twice more at the true end of the video (`[55.61,63.40)`, where the stream
is never closed so mediabunny can't flush trailing samples). Root cause
class: **we request decode ranges beyond what's actually been fed to the
run's stream** - `ReadableStreamSource._read()` has no way to distinguish
"no more data YET" from "no more data EVER" until the stream is explicitly
closed, so it just waits, forever, for bytes that either haven't arrived
yet or (at end-of-video) never will.

### 1. Fed-data clamp - the actual root cause of the reported idle loop

`pickNextWindow`'s `high` bound came from `targetRange.end` - pulled from
`s.bufferedRanges`, a SESSION-level interval set merged across every
segment ever reported. This can legitimately race ahead of what any ONE
specific run's own demux stream has actually been fed (the exact mechanism
by which they diverge wasn't fully pinned down blind - investigated the
0.1.20 spurious-run-boundary heuristic, message-ordering across the
async capture→content→background→offscreen relay, and mediabunny's own
ISOBMFF/EBML format-detection paths as candidates without conclusively
proving one; the live evidence made the exact cause moot - see "Not fully
root-caused" below). Fix: track `run.fedEnd` - the ACTUAL furthest
absolute video-time a run's stream has been fed, updated ONLY from bytes
really appended to that specific run (the same `growthAbsEnd` that also
feeds `s.bufferedRanges`, but scoped per-run instead of session-wide).
`pickNextWindow(s, run)` (now takes `run` as a second parameter, passed
from `maybeProcess`'s already-in-scope `s.currentRun`) clamps `high` to
`run.fedEnd - DECODE_FED_GUARD_S` (0.25s) whenever the run's stream isn't
yet closed - never requesting a decode range beyond verified fed data. If
nothing has been fed to the run at all yet, the clamp evaluates to
`-Infinity`, correctly deferring rather than requesting anything. A new
`not-yet-fed-to-run` diag reason (distinct from the pre-existing
`not-enough-buffered`) names this specific case when it's the active
limiting factor, per the "defer with a mandatory idle-reason diag instead
of requesting" instruction.

### 2. End-of-stream flush - the true-end-of-video variant

The final window (`[55.61,63.40)`, duration 63.8) hung twice for a
DIFFERENT reason than item 1: fed data genuinely HAD reached the end, but
the run's `ReadableStream` is never `close()`d while a video could still
receive more bytes - so mediabunny's demuxer has no signal that it's safe
to flush trailing samples, and a request for the true tail hangs waiting
for bytes that will never come. Fix: `maybeCloseRunAtEndOfStream(s)`, run
on a new lightweight 2s `setInterval` (nothing else re-triggers on pure
"went quiet forever" - every other check in this file piggybacks on the
next segment arriving, but there IS no next segment once capture has
genuinely finished) - once a run's `fedEnd` reaches within
`EOF_CLOSE_SLACK_S` (1.0s) of `video.duration` (relayed end-to-end from
`capture.js` through `content.js`/`background.js`, new `duration` field on
the segment message - read ONLY for this end-of-stream check, never for
timestamp construction, per the "media time in, media time out" doctrine)
AND capture has reported no further growth for `EOF_CLOSE_QUIET_MS` (3s),
`closeRunStream(run)` (a new helper, closes JUST the stream controller -
distinct from the existing `closeRun()`, which also nulls track/sink/input
for PRUNING and is never used again) closes the run's stream and re-kicks
`maybeProcess(s)` so the now-flushable tail window gets picked up. Also
handles the "may already, verify" ask: a run superseded by a NEW init
segment (real OR 0.1.20's synthetic run-boundary) now explicitly calls
`closeRunStream()` on the OLD run immediately at supersession time, rather
than leaving its stream open until the 0.1.15 `KEEP_RUNS=2` pruning
eventually tears it down fully - confirmed via a fresh read of the code
that pruning alone did NOT close it promptly before this fix.

### 3. Structural idle-gate choke point (the observability invariant, enforced this time)

Independently of the fed-data root cause, tracing this bug by reading code
found THREE genuinely silent-to-the-tab exit paths in `maybeProcess`'s
loop and `transcribeWindow` (a `s.disabled`/`s.unanalyzable` bare `break`
with no log at all, and TWO generation-mismatch checks using plain `log()`
- this document's own console, invisible from the tab's console/Copy Logs
output the rest of this file's observability convention is built around)
- any of which could have produced the exact reported symptom on its own.
Per the explicit ask, this is now fixed STRUCTURALLY rather than by
patching each path found: every exit from `maybeProcess`'s loop funnels
through ONE choke point. Each iteration starts by setting
`exitGate = 'unknown-gate'` (so ANY `break` - even a hypothetical future
one that forgets to name itself - still gets attributed to something,
never silence) and a per-branch `exitGate`/`exitDetail`; after the loop,
`reportIdleGate(s, exitGate, exitDetail)` independently RE-DERIVES whether
there's genuinely uncovered-and-captured audio within `WORK_CHECK_HORIZON_S`
(5s, mirroring content.js's own `PROTECT_MARGIN`) of the playhead via
`hasUncoveredCapturedWorkNearPlayhead(s)` - using `s.bufferedRanges`/
`s.covered` directly, never trusting the call site to have logged
correctly - and ONLY THEN alarms (throttled 5s per gate via
`[PM-IDLE-GATE]`). A legitimate exit (nothing left to do) stays silent;
only an exit that's ACTUALLY leaving real work on the table alarms,
regardless of which specific gate caused it, present or future.

### 4. Debug overlay / pill coverage-semantics alignment

The debug overlay's `coverage=` line only ever showed the PLAYHEAD POINT's
coverage (`isCovered(t)`), while the status pill (0.1.19) judges the whole
`[t, t+PROTECT_MARGIN]` horizon - the two surfaces could disagree
confusingly (overlay says "COVERED" the instant `t` itself is covered,
while the pill still shows "Analyzing" because the horizon ahead isn't).
`content.js`'s end-of-video horizon clamp (0.1.22) is now factored into a
shared `clampedHorizonEnd(video, t)`, called by BOTH `computeStatusState`
and `renderDebugOverlay` - they can no longer diverge by construction. The
overlay's `coverage=` line now reads e.g. `COVERED-NOW/horizon 2.5s short`
or `UNCOVERED-NOW/horizon OK` (point state / horizon state, matching the
example in the ask), or `.../horizon n/a (live)` for a live stream.

### 5. Hang-threshold downgrade

Now that the fed-data clamp and end-of-stream flush eliminate the two
known hang-causing races, a genuine stage-timeout HANG should be much
rarer than before - `s.hangAttempts`/`HANG_THRESHOLD` (6) is now a
SEPARATE counter/threshold from `s.sinkErrorAttempts`/`SINK_ERROR_THRESHOLD`
(3, unchanged), which is reserved for genuinely THROWN decode errors
(DRM/undecodable content - still a fast, confident signal).
`withStageTimeout`'s rejection now carries `err.isStageTimeout = true` so
the shared decode-loop catch block (which used to treat a thrown error and
a timeout identically) can route each to its own counter.

### Not fully root-caused

The exact mechanism by which `s.bufferedRanges` (session-level) got ahead
of a specific run's actually-fed data was not conclusively pinned down
blind - the fix (clamp to independently-tracked, per-run ground truth)
is architecturally correct and defensible regardless of the precise
mechanism, but if a future paste shows the SAME symptom recurring even
with `run.fedEnd` in place, the message-ordering theory (capture→content→
background→offscreen is a multi-hop async relay; `chrome.runtime.sendMessage`
calls from `background.js` are NOT guaranteed to preserve order across
separate calls) is the next thing to investigate, followed by the
still-unfixed 0.1.20 spurious-run-boundary heuristic bug found (but not
fixed) during this investigation: `findGrowth()` in `capture.js` reports
`isNewRange: true` for the FIRST-EVER real growth of any fresh video
(`before=[]` makes `.some()` always return false), which fires a spurious
synthetic run-boundary at the SECOND real segment of every video -
harmless in isolation (the new run still gets valid init+cluster data)
but worth fixing for its own sake in a future pass.

**Verification status**: `node --check`/module-check on all touched files,
`node build.js` clean. Unit-verified in isolation (standalone Node
harness, mirroring `pickNextWindow`'s exact fed-clamp math and the
idle-gate choke point's exact logic): the reported bug shape (session
bufferedRanges at 20+, run fedEnd at 5.06) is correctly clamped to never
request beyond `fedEnd - guard`; a run with nothing fed yet correctly
defers with the new `not-yet-fed-to-run` reason; a run whose `fedEnd`
already matches `bufferedRanges` (the normal case) is completely
unaffected by the clamp (byte-identical picked window); a `streamClosed`
run skips the clamp and reaches the true tail; the idle-gate choke point
alarms exactly on the reported scenario, stays silent on a legitimately
resolved exit, and correctly throttles repeated identical-gate alarms
while still firing again once the throttle window passes. All prior
0.1.20/0.1.21/0.1.22 harnesses re-run clean (no regressions). **Not
verified live** - no browser session this pass; the next live pass should
confirm the exact reported repro (fresh video, pause early, watch for
`[PM-WINDOW]` progress past the first window instead of silence) and the
end-of-video tail (watch for `[PM-EOF-FLUSH]` followed by a final
successful window instead of the repeated hang).

## 0.1.24: CRITICAL - findGrowth misread ordinary long-video buffer eviction as a run boundary on every segment

User's log on `CG5i-3-qLPo` (a long video, on 0.1.22 - but this bug lives
in `capture.js`'s `findGrowth`, unchanged since 0.1.20, and is present in
every version between): once the video is long enough, YouTube
continuously TRIMS the SourceBuffer's trailing edge while extending the
front on every append (`rangesBefore=[135.40,808.64] ->
rangesAfter=[136.54,809.50]` - ~1.14s evicted off the START, ~0.86s
appended at the END, every single segment). `findGrowth` matched an
after-range to a before-range by comparing STARTS within 0.5s - correct
when a range only ever grows forward from a fixed start, but the trimmed
start no longer matched at all, so the function fell through to "no
existing range matched" and reported the WHOLE after-range as growth,
flagged `isNewRange: true`. That fired 0.1.20's run-boundary logic on
EVERY SEGMENT - hundreds of demux runs per minute, each superseded by the
next before it could ever transcribe anything: permanent uncovered,
`[PM-STALL]` storm, the pipeline never producing a single word on any
video long enough to trigger eviction (i.e. most of this user's actual
content). **Highest priority - long videos were completely broken.**

### 1. Real interval set-difference, not start-proximity matching

`findGrowth(before, after)` (`capture.js`) now computes actual growth as
`after MINUS before`, per range, matched by OVERLAP rather than exact
start proximity. For each after-range, every before-range it overlaps at
all is subtracted from it - a trimmed front is invisible to growth by
construction (the trimmed span simply isn't part of the after-range to
begin with), leaving only the genuinely new portion (the extended tail).
`isNewRange` is now `true` only when an after-range overlaps NO
before-range at all (a genuine disjoint seek jump); `false` for "same
underlying range, trimmed and/or extended" - which correctly covers both
ordinary growth (no trim) and eviction (trim + extend) as the SAME
non-boundary case. The function also now returns `trimmedS` (how much was
evicted off the front of the matched range, 0 when nothing was trimmed).

### 2. `[PM-TRIM]` debug note

A throttled (5s) `[PM-TRIM]` log line fires whenever `findGrowth` reports
`trimmedS > 0`, so a future paste can visibly distinguish "this append is
just ordinary eviction trim+extend" from an actual run boundary, rather
than the two looking identical the way they used to (both showed up as
"NEW-RANGE" in `[PM-CHAIN]`).

### 3. Sanity backstop: rate-limited run boundaries

Defense-in-depth against this bug CLASS recurring for any other reason in
the future: `instrumentAudioSourceBuffer`'s closure now tracks
`runBoundaryTimestamps`. If more than `RUN_BOUNDARY_RATE_LIMIT_MAX` (3)
run boundaries fire within `RUN_BOUNDARY_RATE_LIMIT_WINDOW_MS` (10s), a
loud `[PM-RUN-BOUNDARY-STORM]` alarm fires once and
`runBoundaryRateLimited` is set (stays tripped for this SourceBuffer's
lifetime - a storm this bad means the classification logic itself is
untrustworthy right now, so re-arming and risking another storm isn't
worth it). Every further discontinuity while tripped logs a
`[PM-RUN-BOUNDARY-SUPPRESSED]` line and feeds into the EXISTING run
instead of opening a new one - degraded (a genuine seek during a storm
might not get its own clean run) but alive beats churn death (transcribing
nothing at all, forever).

**Verification status**: `node --check` passes on all plain-JS files.
Unit-verified in isolation (standalone Node harness, an exact copy of the
new `findGrowth`): the precise reported trim+extend snapshot
(`before=[135.40,808.64]`, `after=[136.54,809.50]`) now yields
`growth=[808.64,809.50)`, `isNewRange=false`, `trimmedS≈1.14` - no run
boundary; a 50-step simulated sequence of consecutive trim+extend appends
(the actual reported failure shape - fires on EVERY segment) produces
ZERO run boundaries; ordinary forward-only growth (no trim) is unaffected
(byte-identical to before); the 0.1.20 genuine-backward-seek NEW-RANGE
case still correctly fires a boundary (no regression); a scenario with
BOTH an ordinary trimmed range and a genuinely disjoint new range in the
same snapshot correctly classifies each independently; the rate-limiter
backstop trips after exactly 3 boundaries within the window, alarms once,
and suppresses everything after. All prior 0.1.20-0.1.23 harnesses
re-run clean (no regressions). **Not verified live** - no browser session
this pass.

**User note**: the reporting user is on 0.1.22 (skipped 0.1.23's
mid-video-idle-loop fix, which is unrelated but also real). They need to
reload from 0.1.22 straight to 0.1.24 - two versions behind, not one.

## 0.1.25: multilingual support (language detection + model switching)

New feature, agreed design (coordinator/user). Goal: keep the ENGLISH
default fully unchanged (base.en, eagerly preloaded, zero added cost) while
adding real support for non-English videos via a second, multilingual
model and a per-video language-detection pass.

### transformers.js does NOT support language auto-detection - verified, not assumed

The design brief's "cheap approach" (`language: null` to get transformers.js
to auto-detect) does not work with the installed library. Confirmed by
reading `node_modules/@huggingface/transformers` (v4.2.0 - the latest
published version; there is no newer release with this feature) directly:
`WhisperForConditionalGeneration._retrieve_init_tokens` contains a literal
`// TODO: Implement language detection` and falls back to forcing English
whenever `generation_config.language` isn't set; the ASR pipeline wrapper
does the same (`kwargs.language ?? 'en'`) one layer up. So `language: null`
silently transcribes as English rather than detecting anything, and there
is no higher-level "detect API" exposed anywhere in this version either.

**Verified, working alternative** (tested end-to-end in a real, throwaway
Node script this session - network fetch + `onnxruntime-node` + the actual
`Xenova/whisper-tiny` model, not simulated): bypass `generate()` entirely
and call the model directly for ONE decoder step - exactly what Whisper's
own reference `detect_language()` does. `model({input_features,
decoder_input_ids: [[decoder_start_token_id]]})` (the raw model instance,
not `.generate()`) runs the encoder once and the decoder for exactly one
step with nothing forced, returning logits at that position; restricting
those logits to the token ids in `model.generation_config.lang_to_id`
(present and populated - confirmed live) and taking the argmax gives a
real detected language. Confirmed working: correct tensor shapes
(`input_features` `[1,80,3000]`, output `logits` `[1,1,51865]`), `lang_to_id`
populated with 99 real language tokens, and a plausible argmax result on
synthetic audio. Real-speech detection ACCURACY wasn't independently
re-verified beyond this (Whisper's language-ID head is a well-established,
widely-used capability - the mechanism, not the model's own accuracy, was
the actual unknown here).

### Design: two multilingual models, not one, to protect the English path

1. **`Xenova/whisper-base`** (multilingual sibling of the .en default,
   confirmed to ship `alignment_heads` - word timestamps ARE supported) -
   used for actual TRANSCRIPTION once a video is confirmed non-English.
2. **`Xenova/whisper-tiny`** (also multilingual) - used ONLY for the cheap
   one-shot detection probe above, never for real transcription (its own
   `alignment_heads` support was not checked - irrelevant for a single
   decoder step with no word-timestamp output requested).

Splitting these matters: if detection required loading the FULL
multilingual model on every session's first window (as a literal reading
of "run the first window through the multilingual model" would imply),
EVERY video - including the vast majority that are English - would pay an
extra model download/warm-up before its first window, directly regressing
the existing eager-preloaded base.en fast path. Instead: **the first
window's actual transcription always runs on `s.modelId` (base.en by
default) exactly as before 0.1.25**, completely unaffected by any of this;
the small `lang-detect` probe model runs ADDITIONALLY (not instead), fire-
and-forget, off the SAME window's audio. Only once detection confirms
non-English does the (lazy) full multilingual model ever get pulled in, for
window 2 onward. This is a deliberate, documented DEVIATION from the
literal brief wording (which itself hedged with "probably fine to keep")
in service of its own explicit "no English regression" requirement.

### Implementation

- **`src/whisper-worker-src.js`**: `MODEL_IDS` gains `multilingual` and
  `lang-detect`. New `handleDetectLanguage(msg)` implements the manual
  single-decoder-step probe above, replying `{type:'lang-result', language,
  score}` or `{type:'lang-error', error}`.
- **`src/offscreen-src.js`**: new `detectLanguageInWorker(float16k)` bridge
  (mirrors `transcribeInWorker`, but deliberately does NOT transfer
  `float16k`'s buffer - the caller still needs it afterward for the
  window's own real transcribe call; a one-time structured-clone copy, paid
  once per session). New session fields: `multilingualEnabled` (from
  `pm_multilingual`, default true), `languageState`
  (`'pending'|'detecting'|'resolved'`), `detectedLanguage`. In
  `transcribeWindow`, on a session's first window only (`languageState ===
  'pending'`, guarded off entirely when `multilingualEnabled` is false OR
  the user already manually forced `pm_model = 'multilingual'` - nothing to
  detect toward there), detection is kicked off fire-and-forget (never
  awaited, never blocks that window's own transcription) through the SAME
  `runSerialized` worker mutex every transcribe call already uses (it's the
  same single-threaded worker). Once resolved: English keeps `s.modelId`
  forever; non-English switches EVERY SUBSEQUENT window's `effectiveModelId`
  to `'multilingual'` and lazily preloads it. **Pinned per video** - a
  mid-video language switch is NOT handled (explicit, accepted limitation
  per the design brief), only a genuine video-id change (a fresh session)
  re-triggers detection.
- **Plumbing to content.js**: `pm-words-result` now carries `language`
  (current `s.detectedLanguage`, null until resolved) and `model`
  (`effectiveModelId`, for RTF telemetry) on EVERY window, not just the
  first - this is the authoritative source content.js reads from.
  `pm-resync-result` carries `language` too (so a port-reconnect resync
  doesn't lose it). A dedicated one-shot `pm-language`/`'language'` message
  is ALSO sent the instant detection resolves, purely as a snappier-UI nice-
  to-have - not relied on alone, since (per 0.1.23's own finding) ordering
  between two separate `chrome.runtime.sendMessage` calls from offscreen
  isn't guaranteed.
- **`content.js`**: new `applyDetectedLanguage(videoId, language)` - sets
  `session.language`, calls `PMWordlist.setLanguage(lang)` defensively
  (only if the wordlist agent's method exists - it may not have shipped
  yet), and ONLY on an actual value change (never redundantly on every
  window once resolved, and never on a stale/other video's message). Status
  pill: shows the language once known and non-English, e.g. "🛡 Protected ·
  es" (omitted for English and for the `Off` state).
- **`background.js`**: `sendModelConfig` now also reads `pm_multilingual`
  (default true) alongside `pm_model`, same once-per-video-reset cadence as
  the existing model setting (a mid-video toggle takes effect on the NEXT
  video, matching `pm_model`'s existing behavior - not treated as needing
  faster reactivity). New `pm-language` relay. `[PM] window ...` and
  `[PM-WINDOW]` log lines both now include `model=` for at-a-glance
  per-model RTF filtering (item 5's "RTF telemetry per model," implemented
  as a log-line tag rather than a new per-model data structure - consistent
  with this codebase's existing "just log it" telemetry convention).
- **`pm_multilingual` setting itself is NOT implemented here** - it's read
  (default true) but the popup toggle is explicitly the wordlist agent's to
  add, per the coordinator's framing ("wordlist agent adds the toggle").
  Until it exists, the feature is simply always-on with no way to disable
  from the UI (still fully functional; `chrome.storage.sync.set({pm_multilingual:
  false})` from the console works today if needed before the toggle ships).

**Verification status**: `node --check`/module-check on all touched files,
`node build.js` clean (both bundles). The manual language-ID mechanism was
verified end-to-end for real (network + real model, not simulated) in a
throwaway Node script this session - see above. The PURE decision logic
(`effectiveModelId` resolution across every state combination: pending,
resolved-English, resolved-non-English, `pm_multilingual=false`, user-
forced `modelId='multilingual'`, detection failure fallback; and
`applyDetectedLanguage`'s change-only-on-real-change/stale-video-ignored
idempotency) is unit-verified in a standalone Node harness mirroring the
real code exactly - all pass. All prior 0.1.20-0.1.24 harnesses re-run
clean (no regressions). **Not verified live against a real Spanish video**
- no working browser session this pass to reload the extension into (the
standing constraint: only the user can trigger a `chrome://extensions`
reload, and 0.1.25's code isn't visible to the currently-loaded extension
until that happens) - noted plainly rather than claimed. The next live
pass should confirm: (1) an English video shows zero latency/behavior
change from pre-0.1.25 (the core regression-safety claim), (2) a real
Spanish/non-English video's `[PM-LANG]` line reports a plausible detected
language and switches window 2+ to the multilingual model, (3) the pill
shows the language marker, and (4) `PMWordlist.setLanguage` actually gets
called once the wordlist agent's method exists.

## Known gaps

- **`shared/wordlist.js` `pm_wordlist:undefined`-default bug** (finding #2
  above) - blocks any custom word list until fixed upstream.
- Scenario 2's tail (confirming "shit" specifically at t≈64s, and "fuck" at
  t≈2549s) not yet re-confirmed against a real, logged-in Chrome profile -
  see "Round 2" above; this is the immediate next step, pending the
  extension reload.
- `run.timeOffset` now has a drift cross-check and self-correction (see
  Round 2), but it is still a heuristic relative to two ground-truth signals
  (anchorTime, bufferedEnd) rather than a byte-exact mapping - it is
  possible for an offset to be wrong by less than the 0.5s slack and never
  trigger a correction. Not observed in testing so far.
- Whether the reported severe word-timestamp smear on `tiny` is actually
  fixed (vs. merely reduced) by switching to `base`, or whether it traces to
  something else entirely (the resample-rate/decode-gap checks added this
  round, or tiny-model alignment-head collapse specifically), is not yet
  determined - needs the `[PM-RESAMPLE]`/`[PM-ANCHOR]`/`[PM-ENERGY]` evidence
  from a real run to distinguish.
- **fMP4/AAC path exercised for the first time in 0.1.21** (a live stream,
  `audio/mp4`/`mp4a.40.2`) and found to silently hang somewhere inside
  mediabunny/WebCodecs's demux/decode with no thrown error - bounded stage
  timeouts made that failure loud (0.1.21). **Likely actually fixed by
  0.1.23**: the live stream's own access pattern (a moving live edge,
  playback typically starting somewhere into an already-large DVR buffer)
  begins requesting decode ranges beyond fed data almost immediately -
  exactly the same "request beyond what's actually been fed to the run's
  stream" root cause class 0.1.23's `run.fedEnd` clamp fixes for ordinary
  VOD. Not independently re-verified live against a real live stream this
  pass (no browser session) - the next live-stream session should confirm
  whether `[PM-HANG]`/`[PM-UNANALYZABLE]` still fires there at all now, or
  whether it was this same bug the whole time. `ADTS` (bare AAC, no MP4
  container) remains fully unexercised regardless.
- **0.1.21's stage-timeout guard intentionally does NOT cover the
  worker-side `transcribeInWorker()` call** - a hang there would still wedge
  the global cross-tab transcribe mutex even with a local timeout on our
  own await, and unwedging that safely needs more design than this pass had
  room for. If a FUTURE live session shows heartbeats continuing forever
  with genuinely zero `[PM-WINDOW]`/`[PM-STAGE]`/`[PM-HANG]` progress across
  ALL tabs (not just one), that's the signature to look for here.
- No explicit test of `SourceBuffer.changeType` firing mid-session (quality
  switch) - the reset-on-changeType behavior is implemented but unverified
  live.

## 0.1.28: persistent dev log (`pm_devlog`) - evidence that outlives the tab

The recurring question "why did word X get through on video Y?" was
unanswerable after the fact. Everything needed to answer it existed at
the time - the analyzed windows, the matches in each, the padded mute
intervals, which regions played uncovered - but it lived only in this
file's tab-lifetime console ring buffer, recoverable only if the user
clicked "Copy logs" *before* navigating away. By the time anyone asks,
the evidence is gone.

New module `shared/devlog.js` (owned jointly with the censor side; the
schema, size guard, batching design, privacy posture and the popup's
"Copy debug log" export are documented in full in CENSOR_NOTES.md's
"FEATURE: persistent dev log" section and in `devlog.js`'s own header).
It is loaded in the isolated-world `content_scripts` entry between
`shared/wordlist.js` and `content.js`, so `globalThis.PMDevlog` is
present for the same reason `PMWordlist` is. Pipeline-side notes only,
here:

- **Every call goes through this file's local `devlog(method, a, b)`
  guard**, which swallows anything thrown. The dev log is diagnostic
  scaffolding and must never be able to break muting - the same posture
  as the `PMWordlist.setLanguage` call in `applyDetectedLanguage`.
- **`TERROR()` itself is the error hook.** `ringAppend` now returns the
  formatted line, and `TERROR` hands that line to `devlog('logError')`,
  so every error this file already logged is persisted with no new call
  sites to keep in sync. Two error classes arrive as *messages* rather
  than thrown exceptions and so are logged explicitly at their handlers:
  the relayed offscreen `diag` text (skipped windows, demux failures,
  stall notices) and the `unanalyzable` verdict. The `diag` channel also
  carries routine progress chatter, so `DEVLOG_DIAG_NOISE_RE` filters out
  `[PM-STAGE]`/`[PM-MODEL]`/`[PM-WARM]`/`[PM-LANG]`/`[PM-FIRST-COVERAGE]`
  - the first live 0.1.28 run put 17 entries in one video's `errors`, all
  of them progress notices, which would eventually push real failures out
  of the capped list. It is a deny-list of known-informational prefixes,
  not an allow-list of known-bad ones: `[PM-SKIP]`, `[PM-HANG]`,
  `[PM-STALL]`, `[PM-ERROR]`, `[PM-DEMUX-ERR]`, `[PM-NO-WINDOW]`,
  `[PM-IDLE-GATE]` and anything unrecognized are all kept, so the worst
  case is noise rather than blindness.
- **Errors logged before the first session exists are not lost.**
  `connectPort()` can `TERROR` during startup, *before* the first
  `resetSession()` - the failure of the pipeline to come up at all being
  the single most diagnostic error class there is. `devlog.js` buffers
  up to 20 pre-session errors and attaches them to the first entry.
- **`applyWordsToIntervals` now also returns `matched[]`** - `{word, t}`
  with the *unpadded* start time. It could not be recovered downstream:
  the intervals it already returned get padded, then `mergeIntervals`
  concatenates overlapping intervals' `word` labels with `'+'`, so by
  the time they reach `session.intervals` they no longer say which
  individual word was found where.
- **Catch-up gaps** (`trackDevlogGap`, called from `runTickLogic`) record
  stretches of media time that PLAYED while the playhead was uncovered.
  Judged against `playheadUncovered`, **not** the `uncovered` variable
  earlier in that function: `uncovered` folds in `settings.safeMode`
  (derived as `catchupMode !== 'play'`), so it is *always false in
  `"play"` mode* - the exact mode whose leak this measures. Same class of
  trap as 0.1.20 bug #3, where the stall watchdog could never fire in
  play mode for this same reason. Gaps are recorded in every mode with
  `mode` named, so the record answers both "what did play mode let
  through" and "what would it have let through if I switched to it". A
  gap closes on coverage arriving, playback stopping, a catch-up mode
  change, a playhead jump (>1s delta, or backwards - a seek ends the
  contiguous stretch, and the `seeking` handler closes it explicitly so
  the recorded end is the pre-seek position), session reset, or
  `pagehide`.
- **`pagehide` ordering matters.** `devlog.js` registers its own
  `pagehide` flush at load time, i.e. *before* this file's - so this
  file's handler closes the open gap and calls `devlog('flushNow')`
  itself, otherwise the last (and often longest) gap would be missing
  from the final write.
- **Write cost**: at most one `chrome.storage.local` read-modify-write
  per 5s per tab, plus one on video change and one on `pagehide`. The
  in-memory state is one video's entry, never the whole ring.

### 0.1.28 live verification (real Chrome, `npm run verify` profile)

The Playwright harness itself did not reach its own ANALYSIS phase this
run - scenario 1 hit the documented `sink.buffers` decode hang
(`[PM-SKIP]` x6 -> `[PM-UNANALYZABLE]` on window `[51.85,59.60)`), which
wedges the shared cross-tab transcribe lane, and scenario 2 then made no
transcription progress at all. That is the known unfixed failure mode
already recorded at the end of the 0.1.21 notes ("0.1.21's stage-timeout
guard intentionally does NOT cover the worker-side `transcribeInWorker()`
call") and is unrelated to this release: nothing in 0.1.28 touches
`capture.js`, `background.js`, `offscreen*` or `dist/*`.

The dev log itself was verified directly against that run's profile
(`Local Extension Settings/<extid>/000003.log`), which is arguably a
better check than the harness's own assertions - it is the real
`chrome.storage.local` value written by real Chrome:

- Both videos present in the ring, correct ids and resolved titles
  ("Steve Jobs' 2005 Stanford Commencement Address - YouTube"), i.e. the
  `logVideoInfoOnce` title refinement works - at `startVideo` time the
  title was still the pre-navigation one.
- Settings snapshot recorded the harness's seeded state plainly:
  `{"strictness":"custom","wordlistSource":"strictness:custom","wordCount":3,...}`
  - source and count, no word list.
- 4 windows on the Stanford video, the 4th carrying
  `matches: [{word:"college.", t:39.89}, {word:"college", t:44.45}]` and
  `muteIntervals: [{39.54,41.1},{44.1,45.2}]` - the 0.35s lead pad is
  visible in the arithmetic, and both intervals match the `MUTE engaged`
  lines in the same run's console output.
- One catch-up gap: `{start: 0, end: 19.58, mode: "mute"}` - the opening
  stretch that played before coverage caught up, which is exactly what
  `"play"` mode would have let through unchecked.
- Whole log: **4432 bytes** for two videos, i.e. ~1.7% of the 256KB cap.
- `pm_devlog` was written 15 times across ~10 minutes of playback across
  two tabs - consistent with the 5s batching, not per-event writes.

## 0.1.29: word-list model change, as seen from the pipeline

The censor-side redesign (built-in lists hidden, user words additive -
full detail in CENSOR_NOTES.md "Hidden lists & parental lock") is almost
invisible from here: `PMWordlist.findMatches` still matches against
whatever `_state.wordlist` resolved to, which is now `tier + the user's
own words` instead of `tier OR the user's own words`. Nothing in the
audio path needed to change for that.

Two things did:

- **`PMWordlist.settings` gained an 11th key**, `additionalWordCount` -
  a COUNT, not the words (the settings object's no-arrays contract is
  intact). `content.js` reads it in `devlogSettingsSnapshot()`.
- **The dev log's `wordlistSource` now names both halves**:
  `"tier:strict+own:3"` rather than `"strictness:strict"`. A bare tier
  name stopped being a sufficient answer to "could word X even have been
  in the active list" the moment the list became a sum of two sources -
  and that question is the entire reason the dev log exists. The
  snapshot also carries `additionalWordCount` as its own field.

The parental lock (`pm_lock`) is popup-only by explicit decision and is
consulted nowhere in the content scripts. Worth knowing when reading a
dev log from a locked install: the settings snapshot is still recorded
normally, because the lock gates *changing* settings, not reading them.

## 0.1.30: onboarding + growth surfaces (pipeline-adjacent notes only)

The release is almost entirely popup/onboarding-side (see CENSOR_NOTES.md
"Onboarding, plain limits & growth surfaces"). Two things touch this
side of the codebase:

- **`background.js` gained a second `onInstalled` listener** - separate
  from the offscreen-lifecycle one above it, because they share no state
  and Chrome runs both. It stamps `pm_installedAt` once and, on a genuine
  `install` only, opens `onboarding/onboarding.html` in a tab. No
  `chrome.tabs` permission was added or is needed: `tabs.create` is
  available to every extension, and this reads nothing about any tab.
- **`engageMute()` now carries the MUTE-NEVER-BLEEP rule in a comment**,
  because that function is the one place it could be violated. The Family
  Movie Act (17 U.S.C. §110(11)) protects making portions of a work
  imperceptible during a private performance; it does not protect adding
  audio, which a bleep tone is. `video.muted = true` and nothing else is
  the legal basis this whole extension stands on - do not mix in a tone,
  a beep, or replacement audio, however much nicer it might sound.

Nothing in the audio path, the offscreen document, or the word-matching
path changed.

## 0.1.32: health monitor (graceful failure)

The pipeline's silent-failure mode is now surfaced. Full reasoning and
the reason-code table are in CENSOR_NOTES.md "Graceful failure (health
monitor)"; the pipeline-side facts:

- **Three inputs, all of which this file already had.** `windowsCompleted`
  increments in `addWords` (a window coming back at all is THE evidence
  the pipeline works end to end, counted even when it matched nothing),
  `audioSegments` increments at the capture relay (so it means exactly
  "audio reached the extension", which is what `no-audio-intercepted` is
  about), and fatal causes are classified out of the existing offscreen
  `diag` relay by `PMHealth.classifyDiag`. The fourth input, accumulated
  playback, is measured in `samplePlayback`.
- **Playback time, not wall time.** A video paused for ten minutes has
  had no chance to be analyzed, and judging it on wall time is the most
  obvious false alarm available. The per-sample clamp
  (`HEALTH_SAMPLE_CLAMP_MS`) matters for the same reason the backgrounded
  -tab backstop exists: rAF stops entirely while the tab is hidden, so an
  unclamped delta would book an hour of "playback" in one sample on
  return, crossing the threshold on evidence never collected.
- **Evaluation runs before the enabled-gate** in `runTickLogic` so the
  clock and the verdict stay current independently of the mute/pause
  decisions; `evaluateHealth` throttles itself, so the per-frame cost is
  one comparison until a verdict is due. While disabled, the playback
  sample baseline is reset so re-enabling does not instantly trip the
  threshold on time the pipeline never had.
- **The pill's warning state ignores `pm_showStatus`** (but not
  `pm_enabled`). `setStatusPillActive` now takes a tone and rebuilds the
  element when it changes, since a tone change needs re-styling and not
  just a new label.
- **`showPlayerNotice(text, kind)`** was factored out of the old
  unanalyzable-only notice so the livestream notice is the same code
  rather than a second near-copy.
- **A `chrome.runtime.onMessage` listener** answers the popup's
  `pm-health-query`. It is the first such listener in this file; it
  responds synchronously and returns undefined.

## 0.1.33: Shorts gating, badge, milestone pill

Pipeline-side notes only; the full round is in CENSOR_NOTES.md "Shorts,
trademark, two-tier reports, growth surfaces".

- **Shorts** are now a documented limit rather than a silent no-op. The
  detection is `location.pathname.indexOf('/shorts/') === 0` in
  `isShortsPage()`, fed to the health core as `isShorts` and checked
  before `isLive`. Nothing in the capture or transcription path changed:
  the finding was that the EXISTING behaviour cannot work there (pathname
  -derived videoId means every swipe RESETs and discards coverage;
  analysis trails playback by seconds against a 15-60s looping clip;
  `resolveRealVideo` prefers the watch-page player container). The notice
  flag is page-scoped, not on the session, precisely because every swipe
  makes a new session.
- **Badge messaging**: `evaluateHealth` now posts `{type:'pm-health',
  status}` to the service worker on every transition, including recovery,
  which is what clears the tab badge. Fire and forget, wrapped, since a
  badge is never worth throwing into the mute pipeline for.
- **Milestone pill**: one `pm-milestone-check` message per page, asked
  from the health tick and skipped entirely when `pm_showStatus` is off so
  the one-shot latch is not consumed for someone who would never see it.
  The service worker owns the latch and stamps it as it answers.
- **`setStatusPillActive` gained a third tone** (`milestone`) alongside
  `normal` and `warning`; it still rebuilds the element on a tone change,
  since a tone needs re-styling and not just a new label.
- **background.js now `importScripts('shared/moments.js')`** so the SW and
  the popup cannot disagree about what "eligible" means, and takes the
  `alarms` permission for a twice-daily recheck of the 7-day install gate,
  the one input that changes with no event to hook.

## 0.1.34: field-test fixes (lifecycle, hang escalation, promise accountability)

First real field test, two devlogs. Full write-up in CENSOR_NOTES.md "what
the first field test found"; the pipeline-side specifics:

- **`closeRun()` now sets `run.closed` before nulling.** The two crashes in
  the log were an in-flight `transcribeWindow` reading fields that teardown
  had nulled under it. `abortReasonFor()` + `abortIfGone()` check at every
  await boundary (entry, track-ready, get-sample-rate, pre-decode, decode)
  and return false WITHOUT touching `hangAttempts`/`sinkErrorAttempts`. A
  teardown must never count toward `markUnanalyzable`, or a race turns
  protection off for decodable content.
- **Hang escalation ladder**, hangs only (a thrown decode error is still the
  fast confident DRM signal and keeps its short path): `HANG_REBUILD_AT`=2
  calls `rebuildRunDecodePipeline()` (drops cached track/sink/nativeRate so
  the next attempt builds fresh ones over the same Input and the same fed
  bytes), `HANG_SKIP_AT`=3 pushes the span to `s.skippedSpans` and advances,
  `HANG_THRESHOLD`=6 unchanged as the final fallback.
- **`s.skippedSpans` feeds `coverageViewForPicking` only.** Same mechanism
  `inFlightWindows` already used: a picker-side view that is never
  `s.covered`. Coverage means analyzed, and marking a failed decode as
  covered would silently unmute it in mute/pause catch-up.
- **`s.dropped`** distinguishes a session teardown from a seek. Both stale
  checkpoints (post-decode and post-worker) now keep the result across a
  seek unless `isCovered(s, absStart, absEnd)` says another window beat it.
  The post-worker one is where the field log burned two full
  transcriptions of the same 2.5s span.
- **Content side**: `session.etaPromise` is the pill's ETA ledger, driven by
  `PMHealth.openOrKeepPromise` / `promiseEscalated` / `promiseAgeMs`, and
  fed into `evaluateHealth` as `promiseAgeMs`/`promiseEtaMs`. `needs-play`
  now requires `video.paused`. `refreshPillSoon()` coalesces event-driven
  renders through a microtask so a burst (play + seeking + a window
  landing) is one render, and `addWords` calls it so coverage and the label
  change in the same instant.
