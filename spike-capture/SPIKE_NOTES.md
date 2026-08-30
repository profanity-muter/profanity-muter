# Spike: capturing YouTube's pre-buffered MSE audio from a Chrome MV3 extension

## Verdict

**Works.** A MAIN-world content script that patches `MediaSource.prototype.addSourceBuffer`
and the returned `SourceBuffer.prototype.appendBuffer` reliably observes YouTube's
audio bytes as they are appended to the media pipeline, seconds to tens of seconds
before the playhead reaches them. Confirmed with real Playwright runs (console
evidence below), not just code review.

## Files

- `manifest.json` — MV3, one content script, `"world": "MAIN"`, `"run_at": "document_start"`,
  matches `https://www.youtube.com/*`, `all_frames: true`.
- `capture.js` — the hook. Patches `addSourceBuffer` to find the audio track by
  mime (`mime.includes("audio")`), then wraps that instance's `appendBuffer`.
  Always calls the original `appendBuffer` first (playback path is untouched),
  then in a try/catch: snapshots `currentTime` / `buffered.end()`, keeps the
  first appended chunk as the init segment, concatenates init+segment and runs
  it through `AudioContext.decodeAudioData`, and logs one `[CAPTURE]` line per
  segment (or `[CAPTURE-ERR]` on failure, including a container sniff of the
  raw bytes so we know what was actually served).
- `verify.js` — Playwright harness. `launchPersistentContext` with
  `--disable-extensions-except=<dir>` and `--load-extension=<dir>` (headful —
  MV3 extensions do not reliably load under `headless: true`), navigates to a
  video, force-mutes/plays it, mute the whole browser via `--mute-audio`, and
  collects console output for 30s. Declares success if 2+ `[CAPTURE]` lines
  show `decodedSec > 0`.

## Observed container/codec

Every run against real `youtube.com/watch` pages served **WebM/Opus**, not
fMP4/AAC:

```
[CAPTURE] audio SourceBuffer detected, mime=audio/webm; codecs="opus"
```

The init segment's first 4 bytes are `1a 45 df a3` — the EBML header — so the
container sniff correctly identifies `webm/matroska (EBML header)`. We did not
observe an `audio/mp4` SourceBuffer in these runs; YouTube evidently preferred
Opus/WebM for this browser/UA. **The implementation must handle both** since
YouTube is known to serve fMP4/AAC in other conditions (older Chromium, some
mobile UAs, DRM'd content) — the mime-sniffing dispatch (webm vs iso-bmff via
first-bytes) is already scaffolded in `sniffContainer()`.

## Lookahead numbers (real, from console evidence)

Test video: Steve Jobs' 2005 Stanford commencement address
(`https://www.youtube.com/watch?v=UF8uR6Z6KLc`, ~15 min, continuous speech).

| currentTime (playhead) | bufferedEnd | aheadSec |
|---|---|---|
| 0.000 | 10.001 | 10.001 |
| 3.086 | 20.001 | 16.915 |
| 9.496 | 30.001 | 20.505 |
| 9.518 | 40.001 | 30.483 |
| 14.785 | 50.001 | 35.216 |

Across two independent 30s runs: **aheadSec ranged 10.0-35.2s and was still
climbing when the run ended** (YouTube keeps extending `buffered.end()` well
past the 30s window we sampled — its documented target is 30s-2min ahead, and
these numbers are consistent with the low end of that and still growing).
Segment (append) duration was consistently **~10s of audio per fetch/append**
for the first two segments (`decodedSec=9.993` twice), then YouTube switches
to a steady-state append cadence of roughly **1-3s of audio per append** for
subsequent chunks — i.e. it front-loads a big first buffer then tops up in
smaller increments.

## How segment time maps to video time (what we actually observed)

`buffered.end()` on the audio `SourceBuffer`, read synchronously inside the
`appendBuffer` hook right after the append call returns, tracks the audio
timeline directly in the video's own time base (same units as
`video.currentTime`) — no offset/scale correction was needed. `aheadSec =
bufferedEnd - video.currentTime` is a correct and sufficient lookahead metric.

We did **not** get a reliable per-append "this segment covers timestamps
[a,b)" from `decodeAudioData` alone — `decodeAudioData` only returns total
duration, not a mapped start time. To get a segment's actual video-timeline
start, the real implementation should either (a) track `buffered.end()` before
and after each append as the segment's `[start, end)` estimate, or (b) parse
WebM Cluster/SimpleBlock timestamps (or `moof`/`tfdt` for fMP4) directly
instead of relying on `decodeAudioData`.

## Gotchas hit

1. **Most individual appends did NOT decode standalone.** Concatenating
   `initSegment + latestChunk` and feeding it to `decodeAudioData` only
   succeeded for a minority of appends (in run 3: 6 of 14 post-init appends
   succeeded, the rest failed with "Unable to decode audio data"). This is a
   real, important finding: WebM Clusters/Opus frames from YouTube's segmenter
   don't always land on a boundary that's self-contained after just an init
   segment — some appended chunks are partial clusters, continuations, or
   otherwise require the *cumulative* byte stream since init, not just the
   latest fragment, to decode. **A production implementation must accumulate
   all bytes since init (or since the last successful decode point) and
   re-attempt/extend the buffer, not decode each append in isolation.** This
   is likely worth switching to a real WebM/Opus demuxer (e.g. parse EBML
   directly and extract raw Opus packets) rather than repeatedly calling
   `decodeAudioData`, which is a blunt, all-or-nothing tool not designed for
   streaming fragments.
2. **MV3 extension `world: "MAIN"` content scripts do load and run before
   YouTube's own JS creates the `MediaSource`**, confirming the
   `document_start` timing works — `[CAPTURE] capture.js installed at
   document_start` always appears before `MediaSource.addSourceBuffer` is
   first called.
3. **Playwright + `headless: true/'new'` did not reliably load the MV3
   extension** in quick testing; used `headless: false` (headful) with
   `--mute-audio` at the Chromium level and `video.muted = true` at the page
   level so it can still run unattended without noise.
4. **No consent/cookie wall appeared** in the fresh Playwright profile for
   `youtube.com/watch` in this environment/region, so the consent-dismissal
   code path in `verify.js` is present but was never exercised — worth
   re-testing in a region/profile where it does appear.
5. **`SourceBuffer.buffered` can throw while the buffer is mid-update** —
   wrapped in its own try/catch so a transient throw doesn't kill the whole
   hook; when it throws we log `bufferedEnd=NA` instead of failing the append.
6. **`decodeAudioData` detaches/consumes its input `ArrayBuffer`.** Because we
   pass a freshly concatenated buffer each time (never the original chunk
   object), this doesn't corrupt anything YouTube's own player is using — but
   it's essential to always copy (`.slice()`) chunk bytes before touching
   them, since `appendBuffer` may receive a view over a buffer YouTube reuses.
7. **Closure-captured loop variable bug (fixed during the spike):** the error
   logger originally referenced the shared, still-mutating `segmentCount`
   variable instead of a per-call snapshot, so segment numbers in
   `[CAPTURE-ERR]` lines from async `.catch` handlers could be wrong/duplicated
   by the time the promise settled. Fixed by capturing `var segIndex =
   segmentCount` synchronously before the async decode call.
8. **AudioContext autoplay/suspension was not actually a problem** in this
   spike — `--autoplay-policy=no-user-gesture-required` plus programmatically
   calling `video.play()` from the page context was enough to get the context
   into `state=running` immediately (logged: `AudioContext created,
   state=running`). Real extension code (no Playwright flag available) should
   still be defensive: create/resume the `AudioContext` on the first user
   gesture (YouTube's own play button click) if `state === 'suspended'`.

## What the real implementation should do differently

- **Don't use `decodeAudioData` per-append for production.** It's a fine
  smoke test but throws away most segments (see gotcha #1) and gives no
  timestamp mapping. Use a streaming WebM (EBML) demuxer to pull out raw Opus
  packets and feed them to a streaming Opus decoder (or feed raw packets
  directly to the ASR model if it accepts Opus), keeping a running byte buffer
  since the init segment rather than decoding chunk-by-chunk in isolation.
  Add the equivalent fMP4/AAC path (already partially there via
  `sniffContainer`) since other conditions may serve mp4.
- **Use `buffered.end()` deltas, not `decodeAudioData` duration, for
  timestamp mapping** — it already lines up with `video.currentTime` with no
  extra math needed.
- **Keep the "always call through to the original `appendBuffer` first"
  pattern** — it worked with zero observed playback impact across all runs
  (video played normally, `readyState=4` throughout) and should stay
  non-negotiable in the real implementation so a bug in ASR/demux code can
  never break YouTube playback.
- **Resume the `AudioContext` on the page's own first user gesture** rather
  than assuming it starts `running`, since a real user session won't have
  Playwright's autoplay-policy flag.

## Reproduction

```
cd ~/Desktop/profanity-muter/spike-capture
npm install
npx playwright install chromium
node verify.js "https://www.youtube.com/watch?v=UF8uR6Z6KLc"
```

Exits 0 (`RESULT: SUCCESS`) when 2+ `[CAPTURE]` lines show `decodedSec > 0`.
Raw console evidence from the runs used for this report is saved in
`/tmp/verify_run1.log`, `/tmp/verify_run2.log`, `/tmp/verify_run3.log` (run 3
is post-bugfix and is the canonical evidence run).
