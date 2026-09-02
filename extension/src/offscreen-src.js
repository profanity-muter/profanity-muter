// offscreen-src.js - bundled into dist/offscreen.bundle.js (see build.js).
// Runs in the MV3 offscreen document (only place ONNX/transformers.js and
// WebCodecs decode work reliably for this pipeline - see
// ../../spike-whisper/SPIKE_NOTES.md and ../../spike-capture/SPIKE_NOTES.md).
//
// GOVERNING PRINCIPLE (0.1.10 redirect): "media time in, media time out."
// The WebM container is the only clock. YouTube's audio SourceBuffer runs on
// the media presentation timeline - the SAME timeline as video.currentTime
// (spike-capture originally confirmed this: buffered.end() tracks
// currentTime directly, no offset/scale correction needed). mediabunny,
// decoding the SAME bytes via the SAME container format, reports that exact
// same timeline in its AudioBuffer timestamps - untouched, unrebased. So a
// decoded window's own timestamps ARE absolute video time; word_abs =
// window's own reported timestamp + word's offset within it. No currentTime,
// no bufferedEnd, no wall clock, and no per-run offset estimation anywhere
// in timestamp construction - all of that (0.1.6-0.1.9's anchor/measured-
// offset machinery) was solving a problem that didn't exist, and at least
// one version of it (0.1.8) leaked wall-clock processing delay into the
// timeline as a side effect. capture.js's buffered-range-growth measurement
// is kept ONLY as a logged cross-check against the container's own EBML
// Cluster>Timecode (do they roughly agree? if not, something upstream is
// genuinely wrong and worth knowing about) - it is never an input to any
// timestamp computed here.
//
// Data model: audio bytes for one video are NOT one endlessly-growing single
// stream. YouTube starts a fresh SourceBuffer (fresh init segment) when it
// needs to fetch audio for a big forward seek/resume, so bytes are split
// into "runs" (one per init segment seen), each independently demuxed via
// mediabunny. Since every run's timestamps are already absolute, coverage/
// word-dedupe live at the SESSION level (spanning run boundaries
// transparently) rather than per-run.
// 0.1.15: transformers.js's `pipeline`/`env` (and the onnxruntime-web MV3/
// CSP env config that used to live here) moved entirely to
// src/whisper-worker-src.js - model load + inference now run in a dedicated
// Web Worker, not on this document's own main thread. See that file's
// header for the full diagnosis (popup paint starvation) and why the split
// is exactly at the transcribe step.
import { Input, ReadableStreamSource, AudioBufferSink, WEBM, MP4, ADTS } from 'mediabunny';
// 0.1.37: the language-switch gate. Plain script attaching globalThis
// .PMLanguage; imported for its side effect so the bundle carries one
// implementation of the rule rather than a second copy of it here.
import '../shared/language.js';
// 0.1.40: the decode timeout ladder and the iterator disposal contract.
// Imported for its side effect (it attaches globalThis.PMDecode) so the
// shipped path is the same code the Node tests exercise.
import '../shared/decode.js';
// 0.1.41: run topology (boundary classification, playhead-aware
// retirement). Imported for its side effect, like the others, so the
// shipped decision is the tested one.
import '../shared/runs.js';

// 'small' added 0.1.13 as an opt-in accuracy tier (per the quiet-speech-
// recall investigation) - Xenova/whisper-small.en is confirmed on the Hub to
// ship alignment_heads in its generation_config.json (same basis tiny/base
// were confirmed on), so word timestamps are supported. RTF cost is
// UNVERIFIED live (no real-Chrome run has selected it yet) - expect roughly
// ~2x base's cost by parameter-count scaling (base ~74M vs small ~244M
// params); base's own measured RTF headroom (~0.13-0.29 steady-state per
// PIPELINE_NOTES) suggests small should still fit comfortably under 1.0,
// but this is an estimate, not a measurement - re-verify before
// recommending it broadly.
// MULTILINGUAL SUPPORT (0.1.25) - 'multilingual' (Xenova/whisper-base,
// confirmed on the Hub to ship alignment_heads, same basis as the .en
// models) is used for actual transcription once a video is detected as
// non-English; 'lang-detect' (Xenova/whisper-tiny, also multilingual) is a
// separate, smaller model used ONLY for the one-shot language-ID probe (see
// whisper-worker-src.js's detectLanguage), never for real transcription.
// Kept in sync with whisper-worker-src.js's own copy of this table.
const MODEL_IDS = {
  tiny: 'Xenova/whisper-tiny.en',
  base: 'Xenova/whisper-base.en',
  small: 'Xenova/whisper-small.en',
  multilingual: 'Xenova/whisper-base',
  'lang-detect': 'Xenova/whisper-tiny'
};
// Default changed tiny -> base: live user testing showed severe word-timestamp
// smear on tiny (CLAMP warnings for 5-15s "words" dozens of times/minute on
// noisy multi-speaker content); base's alignment heads are materially more
// reliable and RTF headroom (~3x realtime) easily covers YouTube's 10-35s
// buffered lookahead. pm_model still lets a session opt into tiny or small.
const DEFAULT_MODEL = 'base';
const WINDOW_S = 18;
const OVERLAP_S = 2;
const MIN_NEW_S = 6; // don't bother transcribing until this much new audio is buffered
const TAIL_SAFETY_S = 0.4; // stay this far behind bufferedEnd (last cluster may be incomplete)
const HEARTBEAT_MS = 4000; // sent while a transcription attempt is genuinely in progress, so the stall watchdog can tell "slow" from "stuck"
const RUN_STREAM_CACHE_BYTES = 64 * 1024 * 1024; // generous: our access pattern isn't strictly sequential (seeks jump around within a run)
const CHECK_SLACK_S = 1.0; // cross-check tolerance between EBML-parsed local time and buffered-growth time

function log(...args) {
  console.log('[PM-OFFSCREEN]', ...args);
}

// Tab-visible diagnostics: any state that can block coverage indefinitely
// (a skipped window, a demux error, a run stuck with no audio track) must be
// visible from the TAB's own console, not just the offscreen document's
// (which nothing but this file's own devtools panel can see - invisible to
// the user, invisible to automation reading the tab). Routed through
// background.js to the right tab's port.
function notifyTab(s, text) {
  log(text);
  chrome.runtime.sendMessage({ type: 'pm-diag', tabId: s.tabId, videoId: s.videoId, text }).catch(() => {});
}

function base64ToUint8(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- Whisper worker bridge (0.1.15 perf fix) ---------------------------
// Model load + inference now run in a DEDICATED WEB WORKER
// (dist/whisper.worker.js, see src/whisper-worker-src.js's header for the
// full diagnosis/rationale) instead of on this document's own main thread.
// Live user report: clicking the extension icon took ~15s to paint the
// popup - extension pages can share a renderer process, and Whisper's
// synchronous multi-second WASM bursts (onnxruntime-web, numThreads=1, no
// proxy) starved the popup's own load/paint in that same process. This
// offscreen document is now just a thin router around the worker for the
// transcribe step specifically; everything else (mediabunny demux,
// session/run/coverage state) is unchanged and still lives here (see that
// file's header for why the split is at exactly this point).
const whisperWorker = new Worker(chrome.runtime.getURL('dist/whisper.worker.js'));
whisperWorker.postMessage({ type: 'init', wasmPathsBase: chrome.runtime.getURL('dist/') });
let nextWorkerRequestId = 1;
const pendingWorkerRequests = new Map(); // requestId -> {resolve, reject}

// Eager warm-up visibility (0.1.18): the worker/model load already starts
// as early as technically possible (this whole file's top-level code runs
// the instant the offscreen document is created, which background.js does
// unconditionally at SW boot/onStartup/onInstalled - NOT gated on any tab
// opening a video). But that warmth was previously invisible: it happened
// before any session/tab existed to notifyTab() through, so a Copy Logs
// paste could never actually confirm it happened, let alone how long it
// took. `warmInfo` buffers the timing until the FIRST session of this
// offscreen document's lifetime is created, at which point it's surfaced
// into THAT tab's ring buffer - see logWarmToSession() and its call site
// in getOrCreateSession().
let warmInfo = null; // {workerSpawnMs, modelLoadMs, readyAtWall} once known
function logWarmToSession(s) {
  if (!warmInfo) return;
  const sinceReadyS = ((Date.now() - warmInfo.readyAtWall) / 1000).toFixed(1);
  notifyTab(
    s,
    '[PM-WARM] worker spawn=' + warmInfo.workerSpawnMs + 'ms model load=' + warmInfo.modelLoadMs +
      'ms (ready ' + sinceReadyS + 's before this session started)'
  );
}

whisperWorker.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === 'worker-error') {
    broadcastDiag('[whisper-worker] ' + msg.text);
    return;
  }
  if (msg.type === 'warm-ready') {
    warmInfo = { workerSpawnMs: msg.workerSpawnMs, modelLoadMs: msg.modelLoadMs, readyAtWall: Date.now() };
    log('[PM-WARM] worker spawn=' + warmInfo.workerSpawnMs + 'ms model load=' + warmInfo.modelLoadMs + 'ms');
    for (const s of sessions.values()) logWarmToSession(s);
    return;
  }
  const pending = pendingWorkerRequests.get(msg.requestId);
  if (!pending) return;
  pendingWorkerRequests.delete(msg.requestId);
  // 0.1.25: 'lang-result' is the success shape for a detect-language
  // request, alongside 'result' for a transcribe request - both just
  // resolve with the whole message; 'lang-error' rejects the same way
  // 'error' already does.
  if (msg.type === 'result' || msg.type === 'lang-result') pending.resolve(msg);
  else pending.reject(new Error(msg.error || 'unknown whisper worker error'));
};
whisperWorker.onerror = (ev) => {
  broadcastDiag('whisper worker onerror: ' + (ev.message || ev));
};

// Transfers `float16k`'s own buffer into the worker (0.1.15: "transfer, not
// copy" - this ~1.1MB-per-18s-window array is detached from this thread by
// the transfer, which is safe here because the caller (transcribeWindow)
// never reads float16k again after this call; the per-word RMS energy
// check that used to run against it on this side now runs INSIDE the
// worker instead, which is why the worker's result carries `rms` per
// chunk).
function transcribeInWorker(modelId, float16k, options) {
  return new Promise((resolve, reject) => {
    const requestId = nextWorkerRequestId++;
    pendingWorkerRequests.set(requestId, { resolve, reject });
    whisperWorker.postMessage({ type: 'transcribe', requestId, modelId, float16k, options }, [float16k.buffer]);
  });
}

// Language-ID bridge (0.1.25) - NOT transferred: unlike transcribeInWorker
// above, the caller (transcribeWindow) still needs `float16k` afterward for
// the window's own real transcribe call, so this must leave the original
// array usable (a plain postMessage without a transfer list structured-
// clones it instead of detaching it - a one-time copy cost paid only once
// per session, on the first window).
function detectLanguageInWorker(float16k) {
  return new Promise((resolve, reject) => {
    const requestId = nextWorkerRequestId++;
    pendingWorkerRequests.set(requestId, { resolve, reject });
    whisperWorker.postMessage({ type: 'detect-language', requestId, float16k });
  });
}

// Simple promise-chain mutex (0.1.15) serializing every transcribeInWorker()
// call across ALL sessions/tabs sharing this offscreen document - the
// worker is a single dedicated thread, so this guarantees at most one
// transcribe request in flight at a time, globally.
let transcribeChain = Promise.resolve();
function runSerialized(fn) {
  const run = transcribeChain.then(fn, fn);
  transcribeChain = run.then(
    () => {},
    () => {}
  ); // never let one call's rejection break the chain for later calls
  return run;
}

// --- per (tabId, videoId) session -------------------------------------------
const sessions = new Map(); // key "tabId:videoId" -> session

// Any uncaught error here must not stay invisible in this document's own
// (user-inaccessible) console - broadcast to every known session's tab.
function broadcastDiag(text) {
  log('[UNCAUGHT]', text);
  for (const s of sessions.values()) {
    chrome.runtime.sendMessage({ type: 'pm-diag', tabId: s.tabId, videoId: s.videoId, text: '[PM-OFFSCREEN] ' + text }).catch(() => {});
  }
}
self.addEventListener('error', (ev) => {
  broadcastDiag('uncaught error: ' + (ev.message || ev) + (ev.filename ? ' (' + ev.filename + ':' + ev.lineno + ')' : ''));
});
self.addEventListener('unhandledrejection', (ev) => {
  broadcastDiag('unhandled rejection: ' + String(ev.reason));
});

function sessionKey(tabId, videoId) {
  return tabId + ':' + videoId;
}

// A run's demux state (mediabunny Input/track/sink) is created ONCE and fed
// incrementally via a ReadableStreamSource, instead of being rebuilt from a
// fresh flat byte buffer on every single window attempt. The earlier
// (BufferSource + `.slice()` the whole run + `new Input(...)`) approach cost
// grew with TOTAL RUN LENGTH, not window size - on a long-running video
// (tab open 25+ minutes, one continuous run) each attempt eventually took
// longer than the stall-watchdog timeout, which then killed and restarted it
// before it ever finished. See PIPELINE_NOTES.md "0.1.6".
function newRun() {
  const run = {
    nativeRate: null,
    streamController: null,
    input: null,
    track: null,
    sink: null,
    trackReadyPromise: null,
    // 0.1.23 - see PIPELINE_NOTES "0.1.23": a live session requested
    // sink.buffers(2.51,19.60) while this run's stream had actually only
    // been fed bytes through 5.06s, hanging forever (ReadableStreamSource
    // waits indefinitely for bytes that haven't arrived instead of
    // erroring - it has no way to know "no more is coming yet" vs. "no
    // more will EVER come"). `fedEnd` is the ground truth for what THIS
    // run's stream has actually been fed (updated only from bytes really
    // appended to it - see the pm-segment handler), decoupled from
    // s.bufferedRanges (session-level, can legitimately be ahead of any
    // one specific run). `streamClosed` is set once we've explicitly
    // closed this run's stream (end-of-stream flush, or superseded by a
    // new run) - once true, the fed-data clamp in pickNextWindow is no
    // longer needed, since a genuinely closed stream reports "no more
    // data" cleanly instead of hanging.
    // 0.1.41: the START of what this run has been fed. fedEnd alone could
    // say how far a run reached but never where it began, so nothing could
    // ask the question that matters after a seek storm: can this run serve
    // the playhead at all?
    fedStart: null,
    fedEnd: null,
    streamClosed: false
  };
  const stream = new ReadableStream({
    start(controller) {
      run.streamController = controller;
    }
  });
  run.input = new Input({
    source: new ReadableStreamSource(stream, { maxCacheSize: RUN_STREAM_CACHE_BYTES }),
    formats: [WEBM, MP4, ADTS]
  });
  return run;
}

// Closes JUST a run's underlying stream (0.1.23) - distinct from closeRun()
// below, which fully tears down track/sink/input for PRUNING (the run is
// never used again). This is used when a run is still the one we intend to
// decode from (the final tail window of a finished run, or a run that was
// just superseded but might still be read from momentarily) but we know for
// certain no MORE bytes are coming - closing lets mediabunny/WebCodecs see
// a definite end and flush trailing samples instead of waiting forever.
// Idempotent (checks streamClosed first) and safe to call on an
// already-closed/never-open stream.
function closeRunStream(run) {
  if (!run || run.streamClosed) return;
  try {
    if (run.streamController) run.streamController.close();
  } catch (e) {
    // already closed/errored elsewhere - fine, this is just cleanup
  }
  run.streamClosed = true;
}

// Releases a superseded run's demux state (0.1.15 memory-leak fix - see the
// pruning call site in the pm-segment handler). Closing the stream lets the
// ReadableStreamSource drop its cache; nulling the rest lets everything else
// (Input, track, sink) become GC-eligible once nothing else references it.
function closeRun(run) {
  closeRunStream(run);
  // 0.1.34: flag the teardown BEFORE nulling. An in-flight transcribeWindow
  // still holds this exact run object across its awaits, and nulling the
  // fields under it produced the two crashes in the user's field log:
  // "Cannot read properties of null (reading 'getPrimaryAudioTrack')" and
  // "...(reading 'buffers')". Those were never real decode failures, they
  // were a torn-down run being read by work that had not noticed yet. The
  // flag lets that work abort quietly and, importantly, NOT count the abort
  // against the hang/error thresholds that lead to markUnanalyzable.
  run.closed = true;
  run.track = null;
  run.sink = null;
  run.input = null;
  run.streamController = null;
}

// RMS energy of the decoded window audio at a given time span (relative to
// the start of the float16k array passed to Whisper) - a cheap sanity signal
// for whether a word's timestamp is sitting on real speech, independent of
// any timeline mapping entirely (both float16k and the word offset are in
// the same window-local coordinate space).
// Word-level 4-grams of a window's raw transcript text, lowercased - used by
// the timeline-shift self-check below. Two windows sharing an unusually high
// fraction of these almost certainly mean the SAME audio got decoded/
// transcribed twice under two different claimed absolute spans (a timeline
// bug), not genuinely repeated dialogue - real conversational repetition is
// much shorter than a whole 4-word run repeating wholesale across an entire
// 16-18s window.
function fourGrams(wordTexts) {
  const grams = new Set();
  for (let i = 0; i + 4 <= wordTexts.length; i++) {
    grams.add(wordTexts.slice(i, i + 4).join(' ').toLowerCase());
  }
  return grams;
}

// Whisper decoder repetition-loop collapse (0.1.13): a live window emitted
// "it's him" ~40 times consecutively with degenerate timestamps (many
// zero-duration, one token with end BEFORE start entirely outside the
// window) - classic decoder degeneration on ambiguous/quiet audio, not real
// speech. Detects a cycle of length 1 or 2 (single word, or a two-word
// phrase) repeating more than HALLUCINATION_REPEAT_THRESHOLD times
// consecutively, keeps only the first couple of cycles (a short genuine
// repetition like "no, no, no" is not lost) and drops the rest.
const HALLUCINATION_REPEAT_THRESHOLD = 5;
const HALLUCINATION_KEEP_CYCLES = 2;
function normalizeTokenText(t) {
  return t.toLowerCase().replace(/[^a-z0-9']/g, '');
}

// Repeated-lyric under-muting guard (0.1.15): a genuinely repeated swear in
// a chorus ("fuck fuck fuck fuck fuck fuck...") looks structurally IDENTICAL
// to a hallucination loop - collapsing it would under-mute real profanity,
// which is strictly worse than the CPU/log-noise cost of a hallucination
// loop going uncollapsed. offscreen-src.js has no access to
// shared/wordlist.js (it only loads in content.js's isolated world, and
// isn't ours to touch) so this is a deliberately small, independent,
// conservative stem list used ONLY to decide "never collapse this" - not a
// replacement for the real wordlist, which still does the actual
// match/mute decision downstream in content.js. False negatives here (a
// profane word this list misses) just fall back to the pre-0.1.13 behavior
// of collapsing it; false positives (declining to collapse something that
// wasn't actually profane) cost a few extra transcribed/logged tokens at
// worst - asymmetric on purpose, safety-first.
const HALLUCINATION_PROFANITY_GUARD = /fuck|shit|bitch|ass(?:hole)?|damn|hell|bastard|cunt|dick|pussy|cock|nigg|whore|slut|twat|prick|cum\b/i;
function cycleLooksProfane(tokens, i, cycleLen) {
  for (let k = 0; k < cycleLen; k++) {
    if (HALLUCINATION_PROFANITY_GUARD.test(tokens[i + k].text)) return true;
  }
  return false;
}
function collapseHallucinationLoops(tokens) {
  const out = [];
  let hallucination = null;
  let i = 0;
  while (i < tokens.length) {
    let matchedCycle = 0;
    for (const cycleLen of [1, 2]) {
      if (i + cycleLen * (HALLUCINATION_REPEAT_THRESHOLD + 1) > tokens.length) continue;
      let ok = true;
      for (let rep = 1; rep <= HALLUCINATION_REPEAT_THRESHOLD && ok; rep++) {
        for (let k = 0; k < cycleLen; k++) {
          if (normalizeTokenText(tokens[i + rep * cycleLen + k].text) !== normalizeTokenText(tokens[i + k].text)) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        matchedCycle = cycleLen;
        break;
      }
    }
    if (matchedCycle && cycleLooksProfane(tokens, i, matchedCycle)) {
      // Never collapse a repeated-profanity cycle - pass every occurrence
      // through untouched so downstream muting sees (and mutes) all of
      // them, not just the first couple.
      matchedCycle = 0;
    }
    if (matchedCycle) {
      let repeats = HALLUCINATION_REPEAT_THRESHOLD;
      for (;;) {
        let extends_ = true;
        for (let k = 0; k < matchedCycle; k++) {
          const idx = i + repeats * matchedCycle + k;
          if (idx >= tokens.length || normalizeTokenText(tokens[idx].text) !== normalizeTokenText(tokens[i + k].text)) {
            extends_ = false;
            break;
          }
        }
        if (!extends_) break;
        repeats++;
      }
      const totalConsumed = repeats * matchedCycle;
      const keepCount = Math.min(totalConsumed, matchedCycle * HALLUCINATION_KEEP_CYCLES);
      for (let k = 0; k < keepCount; k++) out.push(tokens[i + k]);
      hallucination = { repeats, phrase: tokens.slice(i, i + matchedCycle).map((t) => t.text).join(' ') };
      i += totalConsumed;
    } else {
      out.push(tokens[i]);
      i++;
    }
  }
  return { tokens: out, hallucination };
}

// rmsAt() moved to whisper-worker-src.js (0.1.15) - float16k's buffer is
// TRANSFERRED into the worker for the transcribe call (never copied), so
// it's no longer available on this side afterward to compute RMS against;
// the worker computes it itself (it already has the PCM right there) and
// returns it per chunk instead. See transcribeWindow's use of `chunk.rms`.

function getOrCreateSession(tabId, videoId) {
  const key = sessionKey(tabId, videoId);
  let s = sessions.get(key);
  if (!s) {
    s = {
      tabId,
      videoId,
      runs: [],
      currentRun: null,
      currentTimeS: 0,
      covered: [], // merged [{start,end}] in ABSOLUTE video time, session-wide (spans run boundaries)
      allWords: [], // every word ever emitted, absolute video time - for resync after a port drop
      emittedKeys: new Set(),
      lastWindowGrams: null, // this run's previous window's word 4-grams, for the timeline-shift self-check (see transcribeWindow)
      lastWindowSpan: null,
      lastSegWallTime: Date.now(),
      lastBufferedGrowthWall: Date.now(), // last time s.bufferedRanges actually grew - used by pickNextWindow's tiny-tail deferral to detect "run has gone quiet, this really is the end"
      hadFirstWindow: false, // cold-start detection in pickNextWindow - cleared per session, not per run (a seek into a new run is still "cold" relative to session-level coverage)
      disabled: false, // pm_enabled=false (0.1.13) - see pm-disable/pm-enable handlers
      bufferedRanges: [], // merged [{start,end}] in ABSOLUTE video time - real interval set of what our hook has actually captured (see pickNextWindow); 0.1.15 deleted the old single-scalar bufferedEndS entirely
      windowAttempts: new Map(), // rounded-start-location key -> attempt count, for the stuck-location loop-breaker (0.1.14, made location-based in 0.1.20 - see transcribeWindow's loop-breaker section for why exact-span keying stopped catching this)
      sinkErrorAttempts: new Map(), // "start.toFixed(2),end.toFixed(2)" -> consecutive THROWN sink.buffers() decode-error count, for DRM/undecodable detection (0.1.15) - a fast, confident signal, unchanged threshold
      hangAttempts: new Map(), // "start.toFixed(2),end.toFixed(2)" -> consecutive stage-TIMEOUT (no thrown error at all) count, separate map/threshold from sinkErrorAttempts (0.1.21, split out 0.1.23) - a hang is now a much rarer signal after the fed-data clamp + end-of-stream-flush fixes (see pickNextWindow/maybeCloseRunAtEndOfStream), so it gets a higher threshold before giving up rather than sharing the DRM-detection map's fast one
      videoDurationS: null, // 0.1.23 - video.duration, relayed from capture.js; used ONLY for end-of-stream run-close detection (maybeCloseRunAtEndOfStream), never for timestamp construction
      unanalyzable: false, // set true once DRM/undecodable content is detected - maybeProcess stops entirely, content.js releases safe-mode muting for this session
      processing: false,
      pendingRerun: false,
      modelId: DEFAULT_MODEL, // the user's configured ENGLISH model (tiny/base/small/multilingual) - unaffected by auto language-switching below; the model actually used for a given window is resolved fresh each time (see transcribeWindow's effectiveModelId)
      // MULTILINGUAL SUPPORT (0.1.25) - see PIPELINE_NOTES "0.1.25".
      // `multilingualEnabled` mirrors pm_multilingual (default true, set via
      // pm-config); when false, this session behaves exactly as before -
      // always `modelId`, detection never runs. `languageState` starts
      // 'pending' (detection not yet attempted); the FIRST window of a
      // session (before any real coverage exists) triggers a cheap,
      // separate-model language-ID probe (never delaying that window's own
      // transcription, which still runs on `modelId` as normal) and moves
      // to 'detecting', then 'resolved' once the probe's result lands.
      // Detection is pinned for the WHOLE video once resolved - a mid-video
      // language switch is a known, accepted limitation (see PIPELINE_NOTES).
      multilingualEnabled: true,
      languageState: 'pending',
      detectedLanguage: null, // e.g. 'en', 'es' - null until languageState becomes 'resolved'
      // 0.1.37: the gate's accumulating state (confidence + consecutive
      // agreement). See shared/language.js for why a single confident-
      // looking probe is not enough to leave English.
      languageGate: globalThis.PMLanguage ? globalThis.PMLanguage.newState() : null,
      // Generation counter (0.1.18) - bumped on a page-load reset (dropped
      // entirely, see dropSessionsForTab) or a seek (pm-seek, in place -
      // coverage/state untouched). maybeProcess's loop and transcribeWindow
      // both capture their OWN generation at start and compare against the
      // session's CURRENT value before picking further windows / applying
      // results - a stale in-flight WASM call (can't be aborted mid-call)
      // still runs to completion, but its result is discarded rather than
      // applied once superseded, and no further old-generation windows get
      // queued behind it. See PIPELINE_NOTES "0.1.18" for the live bug this
      // fixes (a page refresh's stale session blocking the new one for 7s+).
      generation: 0,
      dropped: false, // set by dropSessionsForTab; a generation bump alone means a seek, which does NOT invalidate already-decoded audio
      // Spans this session has given up decoding (0.1.34 hang escalation).
      // Excluded from PICKING only, via coverageViewForPicking - never added
      // to s.covered, because coverage means "analyzed" and claiming that
      // for audio we failed to decode would silently unmute it in the
      // mute/pause catch-up modes. The user stays protected; the picker just
      // stops re-attempting a span that has already wedged the decoder.
      skippedSpans: [],
      inFlightWindows: new Set(), // "start.toFixed(2),end.toFixed(2)" currently dispatched to transcribeWindow - prevents the picker from re-picking a span whose result hasn't landed yet
      lastKnownRtf: null, // rolling estimate (last computeMs-based rtf) used to size cold-start windows so they finish AHEAD of the playhead - see pickNextWindow
      // [PM-FIRST-COVERAGE] breakdown milestones (0.1.18) - set once each,
      // guarded by !firstCoverageLogged; logged as one line the moment the
      // first window's coverage is applied. See the call sites below.
      firstSegCapturedAt: null,
      firstSegRelayedAt: null,
      firstWindowPickedAt: null,
      firstWindowDecodedAt: null,
      firstWindowWordsAt: null,
      firstCoverageLogged: false
    };
    sessions.set(key, s);
    log('new session', key);
    logWarmToSession(s); // no-op if the worker/model isn't warm yet - see whisperWorker.onmessage's 'warm-ready' handler
  }
  return s;
}

function dropSessionsForTab(tabId) {
  for (const key of Array.from(sessions.keys())) {
    if (key.startsWith(tabId + ':')) {
      const s = sessions.get(key);
      s.dropped = true; // 0.1.34: distinguishes "this session is gone" from "the playhead moved" - see the stale-result handling in transcribeWindow
      s.generation++; // bump BEFORE deleting (0.1.18) - any in-flight closure still holding a reference to this exact object (a running maybeProcess loop or transcribeWindow call from before the reset) sees this and discards its own work instead of applying it to a session that's supposed to be gone
      for (const run of s.runs) closeRun(run); // close every run's demux state, not just prune - the whole session is going away
      sessions.delete(key);
    }
  }
  log('dropped sessions for tab', tabId);
}

function appendToRun(run, bytes) {
  try {
    run.streamController.enqueue(bytes);
  } catch (e) {
    log('appendToRun: stream enqueue failed (run stream likely errored/closed):', String(e));
  }
}

function mergeRangeInto(list, start, end) {
  list.push({ start, end });
  list.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const cur of list) {
    const last = merged[merged.length - 1];
    if (last && cur.start <= last.end + 0.05) last.end = Math.max(last.end, cur.end);
    else merged.push({ start: cur.start, end: cur.end });
  }
  list.length = 0;
  list.push(...merged);
  return list;
}

function firstUncoveredPoint(intervals, lo, hi) {
  let p = lo;
  for (const iv of intervals) {
    if (iv.end <= p) continue;
    if (iv.start > p) return p;
    p = iv.end;
    if (p >= hi) return null;
  }
  return p < hi ? p : null;
}

// Loudness normalization (0.1.13): quiet passages were under-driving
// Whisper's recall (missed words entirely, not just mistimed). Simple peak
// normalization to a target level, applied to the final 16kHz window PCM
// (after any resample, so the gain reflects the actual samples Whisper
// sees). Deliberately conservative: a window at or above TARGET_PEAK
// already is left untouched (gain=1, most normal-volume speech), and a
// window with almost NO signal (near-total silence) is also left alone -
// amplifying pure noise floor to full scale would just manufacture false
// "speech" for Whisper to hallucinate on, which is the opposite of the
// goal. MAX_GAIN caps how far a genuinely-quiet-but-real passage gets
// boosted, for the same reason.
const NORMALIZE_TARGET_PEAK = 0.9;
const NORMALIZE_MIN_PEAK = 0.02;
const NORMALIZE_MAX_GAIN = 8;
function normalizeLoudness(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < NORMALIZE_MIN_PEAK || peak >= NORMALIZE_TARGET_PEAK) return { gain: 1, peak };
  const gain = Math.min(NORMALIZE_MAX_GAIN, NORMALIZE_TARGET_PEAK / peak);
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return { gain, peak };
}

// Downmix + resample a set of WrappedAudioBuffers (their .timestamp is
// already absolute video time, per the governing principle above) covering
// [absStart, absEnd) into one 16kHz mono Float32Array whose sample 0
// corresponds to absStart.
async function windowToFloat16k(wrappedBuffers, absStart, absEnd, nativeRate) {
  const nativeLen = Math.ceil((absEnd - absStart) * nativeRate);
  const native = new Float32Array(nativeLen);
  for (const wb of wrappedBuffers) {
    const buf = wb.buffer;
    const chans = buf.numberOfChannels;
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < chans; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / chans;
    }
    const offset = Math.round((wb.timestamp - absStart) * nativeRate);
    for (let i = 0; i < mono.length; i++) {
      const idx = offset + i;
      if (idx >= 0 && idx < native.length) native[idx] = mono[i];
    }
  }
  let result;
  if (nativeRate === 16000) {
    result = native;
  } else {
    const targetLen = Math.ceil((absEnd - absStart) * 16000);
    const offlineCtx = new OfflineAudioContext(1, targetLen, 16000);
    const srcBuffer = offlineCtx.createBuffer(1, native.length, nativeRate);
    srcBuffer.copyToChannel(native, 0);
    const src = offlineCtx.createBufferSource();
    src.buffer = srcBuffer;
    src.connect(offlineCtx.destination);
    src.start();
    const rendered = await offlineCtx.startRendering();
    result = rendered.getChannelData(0).slice();
  }
  const norm = normalizeLoudness(result);
  if (norm.gain !== 1) {
    log('[PM-NORMALIZE] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') peak=' + norm.peak.toFixed(4) + ' -> gain=' + norm.gain.toFixed(2) + 'x');
  }
  return result;
}

// Pick the next window to transcribe, in ABSOLUTE video time, prioritizing
// coverage near the current playhead first so seeks/resumes (forward past
// the buffer, or backward into already-covered territory) get covered
// quickly, then extending lookahead once caught up. Session-level coverage
// means this works the same regardless of which run currently owns the
// bytes for that time range.
// Observability (0.1.12): a live user log showed 60+s of buffered audio
// with ZERO [PM-WINDOW] attempts and no skip reason anywhere - every silent
// `return null` here (and the `if (!run) break` in maybeProcess) is a "did
// not attempt because X" that the standing rule requires to surface in the
// tab's own console. Throttled per-session so a genuinely stuck state
// doesn't spam (this fires on every maybeProcess call, which happens on
// every appended segment), but a real block is now guaranteed visible
// within NO_WINDOW_DIAG_THROTTLE_MS.
const NO_WINDOW_DIAG_THROTTLE_MS = 5000;
function logNoWindowReason(s, key, reason) {
  const now = Date.now();
  const lastByKey = s.lastNoWindowDiagWall || (s.lastNoWindowDiagWall = {});
  if (lastByKey[key] && now - lastByKey[key] < NO_WINDOW_DIAG_THROTTLE_MS) return;
  lastByKey[key] = now;
  notifyTab(s, '[PM-NO-WINDOW] ' + reason);
}

// Cold-start (0.1.13): user reported ~10s to first coverage after a session
// start/seek - the FIRST window landing at a fresh, disjoint point still had
// to wait for a full WINDOW_S(18s) worth of audio to buffer AND be
// transcribed before the user got any protection near where they just
// landed. A small first window gets useful coverage (and, more importantly,
// engages safe-mode protection) much sooner; normal WINDOW_S resumes right
// after. "Cold" is detected structurally rather than via an explicit
// seek/start event (which offscreen isn't directly told about): the very
// first window of a session, OR any window whose start isn't immediately
// adjacent to existing coverage (i.e. it's opening a new, disjoint region -
// exactly what a seek/resume produces), counts as cold.
// MICRO FIRST WINDOW (0.1.18): cut from 5s to 2.5s of audio - with a warm
// model (~0.2 rtf steady-state), that's first coverage in ~0.5s of compute
// once the model is actually warm (see the eager-preload fix). Growable
// per COLD_START_RTF_MARGIN_S below when the measured rtf says 2.5s alone
// wouldn't finish ahead of the playhead.
const COLD_START_WINDOW_S = 2.5;
const COLD_START_MIN_NEW_S = 1.5;
const COLD_START_ADJACENCY_S = 3;
// AIM AHEAD, NOT BEHIND (0.1.18): a live log showed a cold window picked
// correctly at the playhead (t=3334) but the playhead had moved to 3341 by
// the time it finished - a window is only useful if its OWN END is still
// ahead of the playhead once compute finishes. Grow the cold window (up to
// full WINDOW_S) using the session's last measured compute-only rtf so
// `window_duration * (1 - rtf) >= gap + margin` holds - i.e. the window
// outruns the playhead by at least COLD_START_RTF_MARGIN_S once transcribed.
// rtf is clamped well below 1 (COLD_START_RTF_CLAMP_MAX) so a slow/cold
// measurement can't produce a negative or absurd required size - in that
// case just fall back to a generously large (but still capped) window
// rather than doing fragile math with a >=1 rtf.
const COLD_START_RTF_MARGIN_S = 1;
const COLD_START_RTF_CLAMP_MIN = 0.15;
const COLD_START_RTF_CLAMP_MAX = 0.7;
// Tiny-tail-window deferral (0.1.13): a live log showed a 0.05s window
// attempted at rtf=68 - fixed per-call overhead (model warmup already paid,
// but demux/resample/generate call overhead) completely dominates a sliver
// that small, for near-zero transcription value. Defer the tail case too
// (previously exempted outright via `end < high`) until either enough new
// audio has batched in, or the run has genuinely gone quiet for a few
// seconds (implying this really is the last bit that will ever arrive, e.g.
// end of video) - otherwise it'll just be picked up, larger, next time.
const MIN_TAIL_S = 2;
const TAIL_STALL_MS = 3000;
const WINDOW_LOOP_THRESHOLD = 3; // same exact [absStart,absEnd) attempted this many times without ever registering covered -> force-cover and alarm (see transcribeWindow)
const ALL_WORDS_CAP = 2000; // trailing-window cap for s.allWords/s.emittedKeys - see the memory-leak note at the trim site
const SINK_ERROR_THRESHOLD = 3; // same exact window THROWING a decode error this many times in a row -> DRM/undecodable, see markUnanalyzable
// 0.1.34 hang escalation. The field log showed the same window hanging
// twice at 25s each with no change of approach, and the old ladder would
// have repeated it four more times: 150 seconds of a wedged decoder
// producing nothing, with the pill still promising a result. Repeating an
// identical doomed operation is not a retry strategy.
//
//   attempt HANG_REBUILD_AT: rebuild this run's decode pipeline (drop the
//     cached track/sink so the next attempt constructs fresh ones over the
//     same Input). A wedged AudioBufferSink generator is exactly the shape
//     of failure that a rebuild can clear, and it is cheap.
//   attempt HANG_SKIP_AT:  give up on this SPAN and advance. The span goes
//     into s.skippedSpans (picker-only, never coverage) so the pipeline
//     makes progress past it instead of wedging forever on it.
//   HANG_THRESHOLD:        unchanged final fallback - if windows keep
//     hanging even after rebuilding and advancing, the content itself is
//     the problem and the session is marked unanalyzable.
// 0.1.40: recovery is now cheap, so it happens sooner. With the iterator
// leak fixed a hang should be rare, and when one does happen the rebuild is
// the repair most likely to clear it, so there is no reason to sit through
// a second identical wait before trying it.
const HANG_REBUILD_AT = globalThis.PMDecode ? globalThis.PMDecode.HANG_REBUILD_AT : 1;
const HANG_SKIP_AT = globalThis.PMDecode ? globalThis.PMDecode.HANG_SKIP_AT : 2;
const HANG_THRESHOLD = 6; // 0.1.23: same exact window HANGING (stage timeout, no thrown error) this many times in a row -> unanalyzable - higher than SINK_ERROR_THRESHOLD on purpose: after the 0.1.23 fed-data clamp + end-of-stream-flush fixes, a genuine hang should be much rarer, so a couple of stray timeouts shouldn't give up as fast as a confident thrown DRM-style error does

// Stage-timeout guard (0.1.21) - a live user session on a LIVE STREAM
// (audio/mp4, codecs="mp4a.40.2" - the never-before-exercised AAC/fMP4
// path) produced ZERO windows, ZERO skips, and ZERO errors for 2+ minutes
// after one initial [PM-NO-WINDOW]. Traced by elimination against every
// existing error/skip path in this function (see PIPELINE_NOTES "0.1.21"):
// getPrimaryAudioTrack() resolving with a falsy track would have logged its
// own [PM-SKIP] (never seen), and sink.buffers() throwing would have hit
// the try/catch below (also never seen) - so nothing in THIS file's own
// code ever threw or rejected. The only remaining explanation is a promise
// from mediabunny/WebCodecs (getPrimaryAudioTrack, track.getSampleRate, or
// the sink.buffers() decode generator) that simply never settles - a class
// of failure this file cannot fully audit from outside a third-party
// library's internals, and one the standing "every did-not-attempt must
// surface" rule cannot honor with a plain try/catch, since nothing ever
// throws. A bounded timeout converts "silently hangs forever" into
// "loudly fails within STAGE_TIMEOUT_MS", regardless of the underlying
// reason - this is the deliberate, scoped fix here: make the failure mode
// visible and recoverable rather than fully root-causing mediabunny's
// internals (which would need a live AAC/fMP4 repro this pass didn't have).
const STAGE_TIMEOUT_MS = 25000; // generously above any legitimate stage per the measured RTF table (steady-state well under 1x realtime)
// 0.1.35: the FIRST attempt gets a much shorter leash. The 25s figure was
// chosen when a timeout meant "give up on this window", so it had to be
// generous enough never to punish a slow machine. Since 0.1.34 the second
// attempt rebuilds the decode pipeline, which is cheap and is the thing
// most likely to actually clear a wedged decoder, so waiting 25s before
// trying the one repair we have is pure dead time: the user's worst-case
// stall was 25s + 25s before anything changed. Ten seconds is still far
// above any legitimate decode of a sub-20s window (measured RTF is well
// under 1x realtime), and post-rebuild attempts keep the full 25s so a
// genuinely slow machine is never penalized for being slow.
// 0.1.40: 3s, down from 10s. At these window sizes a decode that is going
// to settle settles in well under a second (the measured RTF table is far
// under 1x realtime), so ten seconds was not patience, it was ten seconds
// of a wedged decoder before anything happened. Post-rebuild attempts keep
// the full 25s below, so a genuinely slow machine is never punished for
// being slow: the short leash applies only to the FIRST try, where the
// cheap repair is one step away.
const STAGE_TIMEOUT_FIRST_MS = globalThis.PMDecode ? globalThis.PMDecode.STAGE_TIMEOUT_FIRST_MS : 3000;
function stageTimeoutMsFor(attemptsSoFar) {
  return globalThis.PMDecode
    ? globalThis.PMDecode.stageTimeoutMsFor(attemptsSoFar)
    : (attemptsSoFar > 0 ? STAGE_TIMEOUT_MS : STAGE_TIMEOUT_FIRST_MS);
}
function withStageTimeout(promise, label, timeoutMs) {
  const limitMs = typeof timeoutMs === 'number' ? timeoutMs : STAGE_TIMEOUT_MS;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('stage "' + label + '" did not settle within ' + limitMs + 'ms (hung promise, not a thrown error)');
      err.isStageTimeout = true; // 0.1.23: lets callers route a genuine hang to a SEPARATE counter/threshold than a real thrown decode error - see HANG_THRESHOLD
      reject(err);
    }, limitMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function markUnanalyzable(s, reason) {
  if (s.unanalyzable) return; // already marked, don't spam
  s.unanalyzable = true;
  notifyTab(s, '[PM-UNANALYZABLE] ' + reason + ' - giving up on transcription for this video; releasing safe-mode protection rather than leaving it muted forever with no way to actually analyze it');
  chrome.runtime.sendMessage({ type: 'pm-unanalyzable', tabId: s.tabId, videoId: s.videoId }).catch(() => {});
}

// RANGE-AWARE, PLAYHEAD-FIRST window picker (0.1.14). Root cause of "jump
// forward = uncovered forever": availability used to be modeled as ONE
// monotonic scalar (s.bufferedEndS, `Math.max`-accumulated across every
// segment). A big forward seek within the SAME SourceBuffer produces NO new
// init segment (isInit stays false - nothing resets anything), so capture.js
// correctly recorded a brand-new, DISJOINT range far ahead of the old one
// (confirmed live: ranges [2640-2860] and [3220-3310+] both growing,
// segs 144-229 all landing) - but the scalar model has no way to represent
// "there are two separate available regions"; it just silently ignored the
// new one whenever it happened to be summarized behind a stale read,
// permanently reporting "not enough buffered audio" for a region that was
// actually fully buffered and waiting. Fix: track availability as a real
// interval set (`s.bufferedRanges`, merged from every segment's own
// growthAbsStart/growthAbsEnd - literally the span OUR hook watched land,
// not a derived scalar), and always pick from the range CONTAINING
// currentTime, or - if the playhead has jumped somewhere not buffered yet -
// the NEAREST range ahead of it. Never a linear frontier that can only ever
// grow from where it last was.
// In-flight-aware coverage view (0.1.18): a live log showed the EXACT same
// span [2520.17,2525.17) picked and transcribed twice back-to-back (its own
// [PM-TIMELINE-ALARM] fired on the resulting near-duplicate text) - the
// picker had no way to know a span was already dispatched and not yet
// applied to s.covered. Folding `s.inFlightWindows` into the coverage view
// used for picking (never into `s.covered` itself, which must stay the
// TRUE, transcription-confirmed coverage) makes the picker skip past
// anything already in flight, the same way it already skips past
// genuinely-covered spans.
// Is [start,end) already fully inside s.covered? Used by the 0.1.34
// stale-result handling to tell "this decode is still worth keeping" from
// "another window beat us to it". Tolerant by a hair, since coverage spans
// come from float timestamps.
function isCovered(s, start, end) {
  const EPS = 0.05;
  let cursor = start;
  const spans = s.covered.slice().sort((a, b) => a.start - b.start);
  for (const iv of spans) {
    if (iv.end <= cursor + EPS) continue;
    if (iv.start > cursor + EPS) return false; // a hole before this span
    cursor = Math.max(cursor, iv.end);
    if (cursor >= end - EPS) return true;
  }
  return cursor >= end - EPS;
}

function coverageViewForPicking(s) {
  const skipped = s.skippedSpans || [];
  if (s.inFlightWindows.size === 0 && skipped.length === 0) return s.covered;
  const extra = [];
  for (const key of s.inFlightWindows) {
    const idx = key.indexOf(',');
    extra.push({ start: parseFloat(key.slice(0, idx)), end: parseFloat(key.slice(idx + 1)) });
  }
  // Skipped spans count as "do not pick again" but NOT as coverage - see
  // the skippedSpans comment in the session initializer.
  for (const sp of skipped) extra.push({ start: sp.start, end: sp.end });
  return s.covered.concat(extra).sort((a, b) => a.start - b.start);
}

// DECODE_FED_GUARD_S (0.1.23): see PIPELINE_NOTES "0.1.23" - a live session
// requested sink.buffers(2.51,19.60) while the run's stream had actually
// only been fed audio through 5.06s. ReadableStreamSource._read() has no
// way to distinguish "no more data YET" from "no more data EVER" until the
// stream is explicitly closed, so it just waits - forever, if the extra
// bytes never arrive within the caller's own patience. `targetRange.end`
// (from s.bufferedRanges, SESSION-level, merged across every segment ever
// reported) can legitimately race ahead of what any ONE specific run's own
// stream has actually been fed - this guard keeps window requests within
// what's verifiably already in the run's stream.
const DECODE_FED_GUARD_S = 0.25;

function pickNextWindow(s, run) {
  const ct = s.currentTimeS;
  let containing = null;
  let nearestAhead = null;
  for (const r of s.bufferedRanges) {
    if (ct >= r.start - OVERLAP_S && ct < r.end) {
      containing = r;
      break;
    }
    if (r.start >= ct && (!nearestAhead || r.start < nearestAhead.start)) nearestAhead = r;
  }
  const targetRange = containing || nearestAhead;
  if (!targetRange) {
    logNoWindowReason(s, 'no-range-at-playhead', 'no captured audio range at or ahead of currentTime=' + ct.toFixed(2) + ' yet');
    return null;
  }

  const lowBound = Math.max(targetRange.start, ct - OVERLAP_S);
  const bufferedHigh = targetRange.end - TAIL_SAFETY_S;
  let high = bufferedHigh;
  // Fed-data clamp (0.1.23) - see DECODE_FED_GUARD_S above. Skipped once the
  // run's stream has been explicitly closed (end-of-stream flush, or
  // superseded by a newer run) - a closed stream reports "no more data"
  // cleanly instead of hanging, so there's nothing left to guard against.
  let fedClampActive = false;
  if (run && !run.streamClosed) {
    const fedHigh = run.fedEnd != null ? run.fedEnd - DECODE_FED_GUARD_S : -Infinity;
    if (fedHigh < high) {
      high = fedHigh;
      fedClampActive = true;
    }
  }
  if (high <= lowBound) {
    logNoWindowReason(
      s,
      fedClampActive ? 'not-yet-fed-to-run' : 'not-enough-buffered',
      fedClampActive
        ? ('session-level buffered range reaches ' + bufferedHigh.toFixed(2) + ' but this run has only actually been fed audio through ' +
            (run.fedEnd != null ? run.fedEnd.toFixed(2) : 'nothing yet') +
            ' - deferring rather than requesting a decode range beyond fed data (would hang forever, see PIPELINE_NOTES "0.1.23")')
        : ('range [' + targetRange.start.toFixed(2) + ',' + targetRange.end.toFixed(2) + ') at the playhead not far enough ahead yet (currentTimeS=' + ct.toFixed(2) + ')')
    );
    return null;
  }

  const coverageView = coverageViewForPicking(s);
  let start = firstUncoveredPoint(coverageView, lowBound, high);
  if (start == null) {
    // Fully covered (or in-flight) so far within this range - extend
    // forward WITHIN THE SAME RANGE only (never jump to some other,
    // unrelated buffered region just because it happens to be later in the
    // list's ordering).
    let maxCoveredInRange = targetRange.start;
    for (const iv of coverageView) {
      if (iv.start < targetRange.end && iv.end > targetRange.start) maxCoveredInRange = Math.max(maxCoveredInRange, iv.end);
    }
    start = Math.max(maxCoveredInRange, lowBound);
    if (start >= high) {
      logNoWindowReason(s, 'fully-covered', 'fully covered (or in flight) up to the available buffer in range [' + lowBound.toFixed(2) + ',' + high.toFixed(2) + ') - nothing new to transcribe right now');
      return null;
    }
  }

  const nearExistingCoverage = s.covered.some((iv) => Math.abs(iv.end - start) < COLD_START_ADJACENCY_S);
  const isColdStart = !s.hadFirstWindow || !nearExistingCoverage;

  if (isColdStart) {
    // FIX (0.1.17): a live seek (to t=3289) showed the FIRST window aimed at
    // [3280.00,3285.00) - the very START of the freshly-captured range,
    // entirely BEHIND the playhead by the time transcription finished
    // (playhead had reached ~3294 by then) - wasting the coldest, slowest
    // window (paid model-load cost, see item 2) on audio the user had
    // already passed and would never hear (mute) or need (it's gone).
    // Audio behind the playhead is lowest priority - useful only for
    // rewind protection, which can wait until ahead-coverage is
    // comfortable. Force the cold window to start at most 1s behind
    // currentTime, never at the captured range's own start.
    const coldFloor = Math.max(targetRange.start, ct - 1);
    if (coldFloor >= high) {
      // The entire currently-captured range is behind the playhead - there
      // is NOTHING to usefully transcribe near/ahead of it yet. Defer
      // rather than burn a slow cold window on stale audio; safe mode's
      // muting already protects the user while waiting for capture to
      // reach the playhead (normally just the next segment or two).
      logNoWindowReason(
        s,
        'cold-behind-playhead',
        'captured range [' + targetRange.start.toFixed(2) + ',' + targetRange.end.toFixed(2) +
          ') is entirely behind the playhead (currentTimeS=' + ct.toFixed(2) + ') - deferring rather than wasting a cold window on already-passed audio'
      );
      return null;
    }
    if (coldFloor > start) start = coldFloor;
  }

  let targetWindowS = isColdStart ? COLD_START_WINDOW_S : WINDOW_S;
  if (isColdStart) {
    // AIM AHEAD, NOT BEHIND (0.1.18): grow the baseline micro window if the
    // measured rtf says it wouldn't finish ahead of the playhead. Solving
    // `windowDuration * (1 - rtf) >= gap + margin` for windowDuration, where
    // `gap` is how far `start` already sits behind `ct` (small given the
    // coldFloor fix above, but not always exactly 0).
    const rtfEstimate = Math.min(COLD_START_RTF_CLAMP_MAX, Math.max(COLD_START_RTF_CLAMP_MIN, s.lastKnownRtf || COLD_START_RTF_CLAMP_MIN));
    const gap = Math.max(0, ct - start);
    const neededS = (gap + COLD_START_RTF_MARGIN_S) / (1 - rtfEstimate);
    if (neededS > targetWindowS) targetWindowS = Math.min(WINDOW_S, neededS);
  }
  const minNewS = isColdStart ? COLD_START_MIN_NEW_S : MIN_NEW_S;

  const end = Math.min(start + targetWindowS, high);
  const size = end - start;
  if (size < minNewS && end < high) {
    logNoWindowReason(s, 'below-min-new', 'only ' + size.toFixed(2) + 's of new audio available (< ' + minNewS + 's), waiting for more before attempting a window');
    return null;
  }
  if (size < MIN_TAIL_S && end >= high) {
    const stalledLongEnough = Date.now() - (s.lastBufferedGrowthWall || 0) > TAIL_STALL_MS;
    if (!stalledLongEnough) {
      logNoWindowReason(s, 'tiny-tail-deferred', 'tail window only ' + size.toFixed(2) + 's (< MIN_TAIL_S=' + MIN_TAIL_S + 's) - deferring until more audio batches in or the run appears finished');
      return null;
    }
  }
  if (size <= 0) return null;
  return { start, end, isColdStart };
}

// Why an in-flight transcribe should stop, or null to carry on (0.1.34).
// Checked at every await boundary in transcribeWindow: the underlying run
// can be torn down (closeRun) or the session dropped at any of them, and
// reading a nulled field afterwards is what produced the field log's two
// TypeErrors.
function abortReasonFor(s, run, myGeneration) {
  if (s.dropped) return 'session-dropped';
  if (run && run.closed) return 'run-closed';
  // A bare generation bump is a SEEK. That does not invalidate audio that
  // has already been decoded, so it is deliberately not an abort here; the
  // result handling further down decides whether to keep it.
  return null;
}

// Rebuild a run's decode pipeline in place: drop the cached track/sink so
// the next attempt constructs fresh ones over the SAME Input and the same
// already-fed bytes. Cheap compared with rebuilding the Input, and it is
// the layer the observed hang lives in.
function rebuildRunDecodePipeline(run) {
  if (!run) return;
  run.track = null;
  run.sink = null;
  run.trackReadyPromise = null;
  run.nativeRate = null;
}

async function transcribeWindow(s, run, absStart, absEnd) {
  const t0 = performance.now();
  // Generation guard (0.1.18) - captured at entry; checked again right
  // before applying any result. A stale in-flight call from a prior
  // generation (a page-refresh reset, or a seek) can't be aborted mid-call,
  // but its result is discarded rather than applied once superseded - see
  // dropSessionsForTab()/the pm-seek handler for where generation bumps.
  const myGeneration = s.generation;

  // Track/sink are resolved ONCE per run and cached - re-fetching the
  // primary audio track is cheap once resolved, but constructing a fresh
  // Input/re-parsing from scratch (the old approach) is not. See newRun().
  const windowKeyForErrors = absStart.toFixed(2) + ',' + absEnd.toFixed(2);

  // 0.1.34: one shared abort path. Returns false WITHOUT touching the
  // hang/error counters, because a torn-down run is not evidence that this
  // window is undecodable, and letting teardown push a session toward
  // markUnanalyzable would disable protection over a bookkeeping race.
  const abortIfGone = (stage) => {
    const why = abortReasonFor(s, run, myGeneration);
    if (!why) return false;
    log('[PM-ABORT] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') stopped at ' + stage + ': ' + why);
    return true;
  };

  if (abortIfGone('entry')) return false;

  if (!run.track) {
    if (!run.trackReadyPromise) {
      if (!run.input) {
        // The exact crash from the field log, now a quiet abort.
        log('[PM-ABORT] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') stopped at track-resolve: run input already released');
        return false;
      }
      notifyTab(s, '[PM-STAGE] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') resolving audio track for this run…');
      run.trackReadyPromise = run.input
        .getPrimaryAudioTrack()
        .then((t) => {
          run.track = t;
          if (t) run.sink = new AudioBufferSink(t);
          return t;
        })
        .catch((e) => {
          notifyTab(s, '[PM-DEMUX-ERR] ' + String(e) + ' (will retry with more data)');
          run.trackReadyPromise = null; // allow retry on next call
          return null;
        });
    }
    let track;
    try {
      // Stage-timeout guard (0.1.21) - see the withStageTimeout comment
      // above: getPrimaryAudioTrack() can hang with no rejection at all on
      // an as-yet-unaudited container/codec path (confirmed live on an
      // AAC/fMP4 live stream). run.trackReadyPromise itself is left
      // untouched on timeout (not nulled) - if it genuinely resolves later,
      // the NEXT attempt picks it up for free; only our own wait on it here
      // is bounded.
      track = await withStageTimeout(
        run.trackReadyPromise,
        'track-ready',
        stageTimeoutMsFor(s.hangAttempts.get(windowKeyForErrors) || 0)
      );
    } catch (e) {
      // Teardown during the await looks like a timeout to us; it is not a
      // hang, so it must not be counted as one.
      if (abortIfGone('track-ready')) return false;
      // 0.1.23: hangs get their OWN counter/threshold (s.hangAttempts /
      // HANG_THRESHOLD), separate from s.sinkErrorAttempts's fast
      // DRM-detection threshold - see HANG_THRESHOLD's own comment for why.
      const hangCount = (s.hangAttempts.get(windowKeyForErrors) || 0) + 1;
      s.hangAttempts.set(windowKeyForErrors, hangCount);
      if (hangCount >= HANG_THRESHOLD) {
        markUnanalyzable(s, 'window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') track resolution hung ' + hangCount + 'x in a row: ' + String(e));
      } else {
        notifyTab(s, '[PM-HANG] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') ' + String(e && e.message ? e.message : e) + ' (' + hangCount + '/' + HANG_THRESHOLD + ')');
      }
      return false;
    }
    if (!track) {
      notifyTab(s, '[PM-SKIP] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') skipped: no audio track found yet for this run');
      return false;
    }
  }
  if (run.nativeRate == null) {
    try {
      run.nativeRate = await withStageTimeout(
        run.track.getSampleRate(),
        'get-sample-rate',
        stageTimeoutMsFor(s.hangAttempts.get(windowKeyForErrors) || 0)
      );
    } catch (e) {
      if (abortIfGone('get-sample-rate')) return false;
      const hangCount = (s.hangAttempts.get(windowKeyForErrors) || 0) + 1;
      s.hangAttempts.set(windowKeyForErrors, hangCount);
      if (hangCount >= HANG_THRESHOLD) {
        markUnanalyzable(s, 'window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') get-sample-rate hung ' + hangCount + 'x in a row: ' + String(e));
      } else {
        notifyTab(s, '[PM-HANG] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') ' + String(e && e.message ? e.message : e) + ' (' + hangCount + '/' + HANG_THRESHOLD + ')');
      }
      return false;
    }
  }
  if (abortIfGone('pre-decode')) return false;
  const nativeRate = run.nativeRate;
  const sink = run.sink;
  // Owned so the timeout path can close it; see the decode block below.
  let decodeIterator = null;
  let decodeAborted = false;
  if (!sink) {
    // The second field-log crash ("Cannot read properties of null (reading
    // 'buffers')"), now a quiet abort rather than a thrown TypeError that
    // surfaced as a scary [PM-ERROR] and a wasted skip count.
    log('[PM-ABORT] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') stopped at decode: run sink already released');
    return false;
  }
  const wrapped = [];
  try {
    // ROOT CAUSE OF THE CHRONIC DECODE HANG (0.1.40). Read this before
    // touching the decode path again.
    //
    // The old code was:
    //
    //     await withStageTimeout((async () => {
    //       for await (const wb of sink.buffers(a, b)) wrapped.push(wb);
    //     })(), 'decode', ms);
    //
    // On timeout, withStageTimeout rejects and we move on. But the async
    // IIFE keeps running, still suspended inside `for await`, and the
    // iterator is never closed. That is not a harmless leak, because of how
    // mediabunny builds these iterators (dist/modules/src/media-sink.js,
    // mediaSamplesInRange):
    //
    //   * EVERY buffers() call creates its OWN AudioDecoder, and closes it
    //     only in the `.finally()` of an internal pump task.
    //   * That pump only finishes when the range ends naturally or the
    //     consumer calls iterator.return(), which sets terminated/ended and
    //     releases its waits.
    //   * The pump applies backpressure: once sampleQueue fills, it blocks
    //     on `await queueDequeue`, which only the consumer's next() call
    //     resolves.
    //
    // So an abandoned iterator parks forever holding a live AudioDecoder
    // and a queue of unclosed AudioData objects. WebCodecs decoders are a
    // finite resource, so each abandoned decode makes the NEXT one likelier
    // to stall, which times out, which abandons another. That is the
    // "roughly every other window" density in the field log: a
    // self-amplifying cascade, and 0.1.21's timeout guard, meant to bound
    // the failure, is what turned one stall into a chain of them.
    //
    // The fix is to own the iterator and always close it. Abandoning it is
    // the bug; the timeout is fine.
    decodeIterator = sink.buffers(absStart, absEnd)[Symbol.asyncIterator]();
    const budgetMs = stageTimeoutMsFor(s.hangAttempts.get(windowKeyForErrors) || 0);
    const drain = globalThis.PMDecode
      ? await globalThis.PMDecode.drainWithTimeout(decodeIterator, { timeoutMs: budgetMs })
      : { values: [], timedOut: true, error: null };
    // drainWithTimeout owns the teardown, so by the time it resolves the
    // iterator is closed whichever way it ended.
    decodeIterator = null;
    if (drain.error) throw drain.error;
    if (drain.timedOut) {
      const timeoutErr = new Error(
        'stage "decode" did not settle within ' + budgetMs + 'ms (hung promise, not a thrown error)'
      );
      timeoutErr.isStageTimeout = true;
      throw timeoutErr;
    }
    for (let i = 0; i < drain.values.length; i++) wrapped.push(drain.values[i]);
  } catch (e) {
    // DRM/undecodable-content detection (0.1.15) vs. silent-hang detection
    // (0.1.21, split into its OWN counter/threshold in 0.1.23 - see
    // HANG_THRESHOLD's comment): a THROWN decode error (protected/DRM
    // content is the expected real-world cause) is a fast, confident
    // signal - SINK_ERROR_THRESHOLD stays low. A stage TIMEOUT (no thrown
    // error - an unaudited container/codec path, OR the exact fed-data-
    // beyond-what's-fed race this version's clamp is meant to prevent in
    // the first place) is now expected to be much rarer, so it gets the
    // higher HANG_THRESHOLD before giving up. Either way, repeated failure
    // on the SAME exact window isn't a transient "not enough data yet" -
    // give up on this session entirely rather than retrying forever,
    // releasing safe-mode muting via `pm-unanalyzable` (see below) so
    // content that will never decode is never left permanently muted with
    // no way to actually protect it.
    // Belt and braces: drainWithTimeout already closed the iterator on
    // every path it owns. This covers a throw from anywhere else in the
    // block (the sink.buffers() call itself, say) that left one open.
    decodeAborted = true;
    if (decodeIterator) {
      try {
        await decodeIterator.return();
      } catch (disposeErr) {
        log('[PM-DECODE] iterator teardown threw (continuing): ' + String(disposeErr));
      }
      decodeIterator = null;
    }
    if (abortIfGone('decode')) return false;
    const isHang = !!(e && e.isStageTimeout);
    const attempts = isHang ? s.hangAttempts : s.sinkErrorAttempts;
    const threshold = isHang ? HANG_THRESHOLD : SINK_ERROR_THRESHOLD;
    const errCount = (attempts.get(windowKeyForErrors) || 0) + 1;
    attempts.set(windowKeyForErrors, errCount);
    const span = 'window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ')';
    if (errCount >= threshold) {
      markUnanalyzable(s, span + ' failed to decode ' + errCount + 'x in a row (' + (isHang ? 'hang' : 'thrown error') + '): ' + String(e));
      return false;
    }
    // 0.1.34 escalation ladder for HANGS only. A thrown decode error is a
    // fast, confident DRM-style signal and keeps its original short path;
    // a hang is the wedged-decoder case, where repeating the identical
    // request is what the field log showed being useless.
    if (isHang && errCount === HANG_REBUILD_AT) {
      rebuildRunDecodePipeline(run);
      notifyTab(s, '[PM-REBUILD] ' + span + ' hung ' + errCount + 'x: rebuilding this run\'s decode pipeline before the next attempt');
      return false;
    }
    if (isHang && errCount >= HANG_SKIP_AT) {
      // Skip and advance. The span is excluded from PICKING only: it is
      // never added to coverage, so content.js still treats this audio as
      // unanalyzed and mute/pause catch-up still protects it. What changes
      // is that the pipeline stops re-attempting it and gets on with the
      // rest of the video.
      s.skippedSpans.push({ start: absStart, end: absEnd });
      notifyTab(s, '[PM-GIVEUP] ' + span + ' hung ' + errCount + 'x even after a pipeline rebuild: skipping this span and advancing (it stays UNANALYZED, not marked covered)');
      return false;
    }
    notifyTab(s, '[PM-SKIP] ' + span + ' skipped: sink.buffers ' + (isHang ? 'hang' : 'error') + ' (' + errCount + '/' + threshold + '): ' + String(e && e.message ? e.message : e));
    return false;
  }
  decodeIterator = null; // completed naturally: the pump closed its own decoder
  s.sinkErrorAttempts.delete(windowKeyForErrors); // a successful decode clears any prior error/hang count for this exact span
  s.hangAttempts.delete(windowKeyForErrors);
  if (wrapped.length === 0) {
    notifyTab(s, '[PM-SKIP] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') skipped: no decodable audio in this run at that time yet (waiting for more data)');
    return false;
  }

  // Slicing resilience (0.1.11): NEVER assume the decoded buffers cover the
  // full requested [absStart,absEnd) window just because that's what we
  // asked sink.buffers() for - a byte gap in the run's stream (a dropped/
  // missing segment, or mediabunny simply not having decoded that far yet)
  // must surface as an actual, smaller coverage span, not be silently
  // treated as "the whole window is covered". Each wrapped AudioBuffer
  // carries mediabunny's own decoded timestamp (container time, untouched)
  // - that is the ONLY source of truth for what was actually covered.
  let actualMinStart = wrapped[0].timestamp;
  let actualMaxEnd = wrapped[0].timestamp + wrapped[0].buffer.duration;
  for (const wb of wrapped) {
    const wStart = wb.timestamp;
    const wEnd = wb.timestamp + wb.buffer.duration;
    if (wStart < actualMinStart) actualMinStart = wStart;
    if (wEnd > actualMaxEnd) actualMaxEnd = wEnd;
  }
  const coverStart = Math.max(absStart, actualMinStart);
  const coverEnd = Math.min(absEnd, actualMaxEnd);
  const COVERAGE_GAP_SLACK_S = 0.5;
  if (coverEnd < absEnd - COVERAGE_GAP_SLACK_S || coverStart > absStart + COVERAGE_GAP_SLACK_S) {
    notifyTab(
      s,
      '[PM-COVERAGE-GAP] requested window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) +
        ') but decoded audio only actually spans [' + coverStart.toFixed(2) + ',' + coverEnd.toFixed(2) +
        ') - treating the shortfall as a real gap (will be revisited), not marking the full requested window covered'
    );
  }

  // Resample-rate sanity check against INDEPENDENT ground truth (not just
  // re-deriving "expected" from the same formula as "actual", which can
  // never fail). nativeRate is what we tell the WebAudio resampler the
  // source rate is - if it's wrong (e.g. codec misreport), the resampler
  // silently stretches/shrinks the whole timeline, which would systematically
  // shift every downstream timestamp. Cross-check it against the actual
  // decoded audio: sum each wrapped buffer's own (rate-independent) duration
  // and compare to the span it claims to cover via timestamps.
  // Log collapse (0.1.15): this used to log an unconditional [PM-RESAMPLE]
  // line on EVERY window (already redundant with [PM-WINDOW]'s own
  // mediaSpan) - the ring buffer evicts in ~2 minutes under that volume,
  // which is worse for the actual "flight recorder" goal than only logging
  // when something is actually wrong. Both -WARN checks below already only
  // fire on genuine disagreement/mismatch; that's the only case worth a
  // log line here now.
  const decodedDurationSum = wrapped.reduce((acc, wb) => acc + wb.buffer.duration, 0);
  const claimedSpan = wrapped.length ? wrapped[wrapped.length - 1].timestamp + wrapped[wrapped.length - 1].duration - wrapped[0].timestamp : 0;
  if (nativeRate !== 48000) {
    log('[PM-RESAMPLE-WARN] unexpected nativeRate=' + nativeRate + ' (Opus/WebM is normally 48000Hz) - a wrong rate here would silently corrupt the WebAudio resample and shift every timestamp downstream');
  }
  if (Math.abs(decodedDurationSum - claimedSpan) > 0.5) {
    log('[PM-RESAMPLE-WARN] decoded buffer durations do not sum to their own claimed timestamp span (gap/overlap in decode) - decodedDurationSum=' + decodedDurationSum.toFixed(3) + ' claimedSpan=' + claimedSpan.toFixed(3));
  }

  const float16k = await windowToFloat16k(wrapped, absStart, absEnd, nativeRate);
  const tDecoded = performance.now();
  // [PM-FIRST-COVERAGE] milestone (0.1.18): "decoded" - see the full
  // breakdown log at the end of this function.
  if (!s.firstCoverageLogged && s.firstWindowDecodedAt == null) s.firstWindowDecodedAt = Date.now();

  if (s.generation !== myGeneration) {
    // 0.1.34: a generation bump is NOT automatically a reason to throw
    // decoded audio away. The field log showed [0.00,2.50) decoded in full
    // (computeMs=3613), discarded for a generation change, re-decoded, and
    // discarded again: the same seconds of audio transcribed twice and used
    // zero times, while the user waited.
    //
    // The distinction that matters is WHY the generation moved. A dropped
    // session (page refresh, video change) means this audio belongs to a
    // video nobody is watching any more, so it must go. A SEEK means the
    // playhead moved within the same video: the audio at [absStart,absEnd)
    // is exactly as valid as it was a second ago, and the only cost of
    // keeping it is a worker call that has already been paid for. If the
    // span is somehow covered by now, drop it as redundant instead.
    if (s.dropped) {
      log('[PM-STALE] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') abandoned after decode: session dropped');
      return false;
    }
    if (isCovered(s, absStart, absEnd)) {
      log('[PM-STALE] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') abandoned after decode: already covered by another window');
      return false;
    }
    log('[PM-STALE-KEPT] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') generation changed (' + myGeneration + ' -> ' + s.generation + ') but the audio is unchanged and still uncovered: keeping the decoded result');
  }

  // Model-in-use is tab-visible exactly once per session (0.1.13) - per the
  // standing "nothing that affects behavior stays invisible" rule, and
  // specifically to let a live session's log confirm what DEFAULT_MODEL
  // actually resolved to (the whole point of the tiny->base 0.1.6 change was
  // moot if a build somehow still defaulted to tiny).
  if (!s.loggedModel) {
    s.loggedModel = true;
    const resolvedId = MODEL_IDS[s.modelId] ? s.modelId : DEFAULT_MODEL;
    notifyTab(s, '[PM-MODEL] using model="' + resolvedId + '" (' + MODEL_IDS[resolvedId] + '), default="' + DEFAULT_MODEL + '"' + (resolvedId !== DEFAULT_MODEL ? ' [overridden via pm_model]' : ''));
  }

  // MULTILINGUAL DETECTION (0.1.25) - see PIPELINE_NOTES "0.1.25" for the
  // full design/tradeoff writeup. Kicked off (fire-and-forget, never
  // awaited here) exactly once per session, on the FIRST window only -
  // `s.languageState` flips 'pending' -> 'detecting' right away so a
  // fast-following second window (or a second tab's session) can never
  // double-fire it. Deliberately does NOT block or change THIS window's own
  // transcription, which still runs on `s.modelId` (base.en by default,
  // already eagerly warm - see the boot preload) exactly as before 0.1.25:
  // this is the "no English regression" requirement - the common (English)
  // case pays ZERO added latency or model download on window 1. Detection
  // uses a SEPARATE, smaller 'lang-detect' model (never `s.modelId`, never
  // 'multilingual') via a single cheap decoder step (see
  // whisper-worker-src.js's handleDetectLanguage) - not a full
  // transcription - so its cost is small even though it's an extra model
  // load. Skipped entirely if multilingual support is off (pm_multilingual)
  // or the user already explicitly forced `modelId` to 'multilingual'
  // themselves (nothing to detect toward in that case - they're already
  // covering every language). Routed through the SAME `runSerialized`
  // worker mutex as every transcribe call (see below) since it shares the
  // same single-threaded worker.
  const langApi = globalThis.PMLanguage;
  const wantsProbe =
    s.multilingualEnabled &&
    s.modelId !== 'multilingual' &&
    s.languageState !== 'detecting' &&
    (!langApi || langApi.shouldProbe(s.languageGate));
  if (wantsProbe) {
    s.languageState = 'detecting';
    runSerialized(() => detectLanguageInWorker(float16k))
      .then((res) => {
        const observed = res && res.language ? res.language : null;
        const score = res && res.score != null ? res.score : null;
        // 0.1.37: a probe is now an OBSERVATION, not a verdict. The gate
        // decides whether it is enough to act on. See shared/language.js:
        // the field log switched this session to Korean on one probe at
        // score 13.18, which swapped the word list to a 66-entry Korean
        // pack and stopped every English profanity from matching.
        const verdict = langApi
          ? langApi.decide(s.languageGate, { language: observed, score: score })
          : { state: null, action: observed && observed !== 'en' ? 'switch' : 'hold', language: observed || 'en', reason: 'no-gate' };
        if (verdict.state) s.languageGate = verdict.state;
        s.languageState = 'resolved';

        const acted = verdict.action === 'switch' || verdict.action === 'revert';
        if (acted) s.detectedLanguage = verdict.language;
        const lang = s.detectedLanguage || 'en';
        const usingModel = lang === 'en' ? s.modelId : 'multilingual';
        notifyTab(
          s,
          '[PM-LANG] observed=' + (observed || 'none') +
            (score != null ? ' score=' + score.toFixed(2) : '') +
            ' action=' + verdict.action + ' (' + verdict.reason + ')' +
            ' active=' + lang + ' model=' + usingModel
        );
        // Every decision reaches the devlog, including the holds: the whole
        // problem with the field case was one line saying what happened and
        // nothing saying why.
        chrome.runtime.sendMessage({
          type: 'pm-language-decision',
          tabId: s.tabId,
          videoId: s.videoId,
          observed: observed,
          score: score,
          action: verdict.action,
          reason: verdict.reason,
          active: lang,
          model: usingModel
        }).catch(() => {});
        if (acted && lang !== 'en') {
          // Lazy load (per spec): only pull in the FULL multilingual model
          // once we actually know we need it - fired here so window 2
          // doesn't have to pay the load cost fully inline (may still
          // partially overlap if window 2 arrives before this finishes;
          // getTranscriber's own promise cache makes that safe/free either
          // way, it just awaits the same in-flight load).
          whisperWorker.postMessage({ type: 'preload', modelId: 'multilingual' });
        }
        // Only a real switch or revert is pushed to the tab: a hold means
        // nothing changed, and telling content.js otherwise would swap its
        // word list on a decision this module declined to make.
        if (acted) {
          chrome.runtime.sendMessage({ type: 'pm-language', tabId: s.tabId, videoId: s.videoId, language: lang }).catch(() => {});
        }
      })
      .catch((e) => {
        // Detection failing must never block or break transcription itself
        // - fall back to the English default, exactly as if detection had
        // never run, and say so loudly (this is a real, if rare, failure
        // mode worth knowing about, not something to silently swallow).
        notifyTab(s, '[PM-LANG] detection failed, staying on English default: ' + String(e && e.message ? e.message : e));
        s.languageState = 'resolved';
        // Deliberately does NOT pin detectedLanguage to 'en': leaving it
        // null keeps the English default active while allowing a later
        // probe to still find a genuinely non-English video.
        if (s.languageGate) s.languageGate.observations = (s.languageGate.observations || 0) + 1;
      });
  }
  // Resolve which model THIS window actually transcribes with. Window 1
  // (languageState still 'pending'/'detecting' at this point, since the
  // above never awaits) always uses `s.modelId` - the detection result
  // literally cannot exist yet. From languageState 'resolved' onward, a
  // non-English detection switches every subsequent window to the full
  // multilingual model; English (or multilingual disabled, or the user's
  // own explicit 'multilingual' override) stays on `s.modelId` throughout.
  const effectiveModelId =
    s.multilingualEnabled && s.languageState === 'resolved' && s.detectedLanguage && s.detectedLanguage !== 'en'
      ? 'multilingual'
      : s.modelId;

  // Serialized across ALL sessions/tabs (0.1.15): the worker is a single
  // dedicated thread, so a simple promise-chain mutex guarantees at most
  // one transcribe request in flight at a time, globally, rather than
  // racing several windows' requestId responses against each other for no
  // benefit (the worker would just process them one at a time internally
  // anyway). The wall-clock timer starts only once this call actually
  // BEGINS executing (not when it's enqueued behind another tab's window),
  // so modelRtf keeps measuring real transcribe time, not queue-wait.
  const tBeforeQueue = performance.now(); // wallMs SPLIT (0.1.18) - see queueMs/computeMs below
  let tTranscribeStart = 0;
  const workerResult = await runSerialized(() => {
    tTranscribeStart = performance.now();
    return transcribeInWorker(effectiveModelId, float16k, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      // Repetition mitigation (0.1.13), best-effort: each window is already
      // its own independent transcribe call with no prior window's text fed
      // back in, so cross-window conditioning is already effectively off
      // (transformers.js's ASR pipeline doesn't expose a direct
      // condition_on_previous_text toggle to set this explicitly). A SINGLE
      // window's own decode can still degenerate into a repetition loop on
      // ambiguous/quiet audio (the "it's him" x40 case) - no_repeat_ngram_size
      // is passed through in case the underlying generate() call honors it;
      // NOT verified against this exact transformers.js version, so the
      // guaranteed defense is collapseHallucinationLoops() below, not this.
      no_repeat_ngram_size: 3
    });
  });
  const transcribeMs = performance.now() - tTranscribeStart;
  // wallMs SPLIT (0.1.18): a live paste showed wallMs-derived rtf of 3-8
  // right next to modelRtf of 0.2-0.5 - almost all of it was QUEUE wait (a
  // stale/superseded session's own backlog competing for the same shared
  // worker), not compute, but wallMs alone couldn't show that. decodeMs
  // covers demux+resample (t0 to just after windowToFloat16k); queueMs is
  // strictly the wait for the worker mutex to free up; computeMs is the
  // worker's own round trip (== transcribeMs).
  const decodeMs = tDecoded - t0;
  const queueMs = tTranscribeStart - tBeforeQueue;
  const computeMs = transcribeMs;

  if (s.generation !== myGeneration) {
    // 0.1.34: this is the exact line the user's field log hit twice on the
    // SAME span - a full transcription (computeMs=3613) thrown away for a
    // generation change, re-decoded, re-transcribed, thrown away again.
    // Two rounds of the most expensive work in the extension, zero
    // coverage produced, while the pill promised progress.
    //
    // A dropped session still discards: that audio belongs to a video
    // nobody is watching. A SEEK does not, because seeking does not change
    // what the audio at [absStart,absEnd) contains. The one thing worth
    // re-checking is whether the span became covered while we were in the
    // worker, in which case applying it would produce a duplicate window
    // (the near-duplicate symptom [PM-TIMELINE-ALARM] once caught).
    if (s.dropped) {
      notifyTab(
        s,
        '[PM-STALE] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') result discarded: session dropped while transcribing - decodeMs=' +
          Math.round(decodeMs) + ' queueMs=' + Math.round(queueMs) + ' computeMs=' + Math.round(computeMs)
      );
      return false;
    }
    if (isCovered(s, absStart, absEnd)) {
      notifyTab(
        s,
        '[PM-STALE] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') result discarded: span already covered while transcribing - decodeMs=' +
          Math.round(decodeMs) + ' queueMs=' + Math.round(queueMs) + ' computeMs=' + Math.round(computeMs)
      );
      return false;
    }
    notifyTab(
      s,
      '[PM-STALE-KEPT] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') survived a generation change (' +
        myGeneration + ' -> ' + s.generation + ') while transcribing: the audio is unchanged and still uncovered, so the result is applied instead of recomputed'
    );
  }

  // [PM-FIRST-COVERAGE] milestone (0.1.18): "words returned".
  if (!s.firstCoverageLogged && s.firstWindowWordsAt == null) s.firstWindowWordsAt = Date.now();

  // float16k's buffer was TRANSFERRED into the worker above - it must never
  // be read again on this side (it's detached/zero-length now). `output`
  // below carries everything needed, including per-chunk `rms` (computed
  // inside the worker, where the PCM actually still is).
  const output = { text: workerResult.text, chunks: workerResult.chunks };
  const audioDurationS = absEnd - absStart;
  // rtf-aware cold-window sizing (0.1.18) feeds off this - track a rolling
  // "last known" compute-only rtf so the NEXT cold window (a future seek)
  // can size itself to actually outrun the playhead. Simple last-value,
  // not an average - the aim-ahead math already clamps it to a sane range.
  s.lastKnownRtf = computeMs / 1000 / audioDurationS;
  // Accounting fix (0.1.11): `rtf` used to be transcribeMs-only (the model
  // call's own throughput) while the `wallMs` logged right alongside it in
  // [PM-WINDOW] is the FULL time since transcribeWindow started, including
  // demux/track-ready wait and resample - e.g. wallMs=26681 with rtf=0.276
  // implied the model took ~5s on an 18s window, which was true, but the
  // other ~21.7s of real latency (waiting on data/decode) was invisible from
  // that same log line, misleadingly suggesting the pipeline was keeping up
  // in real time when it was not. `rtf` is now computed from `wallMs` - the
  // same basis as the number it's logged next to - so the two are always
  // consistent and the ratio directly answers "is this attempt, start to
  // finish, keeping up with playback speed?". The model-only figure is kept
  // as `modelRtf` for anyone specifically diagnosing transcription throughput
  // vs. demux/queueing latency.
  const modelRtf = transcribeMs / 1000 / audioDurationS;

  log(
    'transcript [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') video-time (container timestamp, untouched), modelMs=' +
      Math.round(transcribeMs) + ' modelRtf=' + modelRtf.toFixed(3) + ':',
    output.text
  );

  // Transcript sanity filter (0.1.13): a live window emitted "it's him"
  // ~40x with degenerate timestamps - many zero-duration words (normal/
  // common from Whisper, NOT dropped) plus one token with end BEFORE start
  // entirely (s=2700.455 e=2671.095), outside the window's own span. Filter
  // BEFORE anything downstream (dedupe, mute-interval building, AND the
  // timeline-shift check below) ever sees these, in two passes: (1) drop
  // tokens that are structurally nonsensical or wildly outside this
  // window's own time span, (2) collapse decoder repetition loops.
  const WINDOW_TOKEN_SLACK_BEFORE_S = 1;
  const WINDOW_TOKEN_SLACK_AFTER_S = 2;
  const windowDurationS = absEnd - absStart;
  let droppedInverted = 0, droppedOutOfRange = 0;
  const rawTokens = [];
  for (const chunk of output.chunks || []) {
    const text = (chunk.text || '').trim();
    if (!text) continue;
    const [wLocalStart, wLocalEndRaw] = chunk.timestamp || [null, null];
    if (wLocalStart == null) continue;
    if (wLocalEndRaw != null && wLocalEndRaw < wLocalStart) {
      droppedInverted++; // end before start - nonsensical, cannot be salvaged
      continue;
    }
    const wLocalEnd = wLocalEndRaw != null ? wLocalEndRaw : wLocalStart + 0.3; // zero-duration is common/normal from Whisper - kept, not dropped
    if (wLocalStart < -WINDOW_TOKEN_SLACK_BEFORE_S || wLocalStart > windowDurationS + WINDOW_TOKEN_SLACK_AFTER_S) {
      droppedOutOfRange++; // claimed timestamp falls outside [windowStart-1, windowEnd+2] - not plausibly this window's own audio
      continue;
    }
    rawTokens.push({ text, wLocalStart, wLocalEnd, rms: chunk.rms });
  }
  if (droppedInverted || droppedOutOfRange) {
    log(
      '[PM-SANITY] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') dropped ' + droppedInverted +
        ' inverted (end<start) and ' + droppedOutOfRange + ' out-of-window-range token(s)'
    );
  }
  const { tokens: sanitizedTokens, hallucination } = collapseHallucinationLoops(rawTokens);
  if (hallucination) {
    notifyTab(
      s,
      '[PM-HALLUCINATION] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') repeated "' + hallucination.phrase +
        '" ' + hallucination.repeats + 'x consecutively - kept the first couple, dropped the rest (Whisper decoder degeneration, not real speech)'
    );
  }

  // Timeline-shift self-check (0.1.11): if two CONSECUTIVE windows for this
  // session produce near-identical text, that's almost always proof the same
  // audio got decoded/labeled twice under different claimed absolute spans
  // (a timeline bug - e.g. the exact "consecutive windows transcribed nearly
  // identical dialogue" symptom from the dropped-segment bug) rather than
  // genuinely repeated dialogue. Measured via shared 4-grams so short,
  // legitimate repeated phrases ("no, no, no") don't false-positive. Uses
  // the SANITIZED tokens (post-hallucination-collapse) so a decoder
  // repetition loop can't itself masquerade as (or drown out) a real
  // timeline-shift signal.
  const windowWordTexts = sanitizedTokens.map((t) => t.text);
  const currentGrams = fourGrams(windowWordTexts);
  if (s.lastWindowGrams && currentGrams.size > 0 && s.lastWindowGrams.size > 0) {
    let shared = 0;
    for (const g of currentGrams) if (s.lastWindowGrams.has(g)) shared++;
    const denom = Math.min(currentGrams.size, s.lastWindowGrams.size);
    const similarity = denom > 0 ? shared / denom : 0;
    if (similarity > 0.6) {
      notifyTab(
        s,
        '[PM-TIMELINE-ALARM] consecutive windows are ' + Math.round(similarity * 100) +
          '% overlapping by 4-gram (prevWindow=[' + s.lastWindowSpan + '] thisWindow=[' +
          absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ')) - almost certainly the SAME audio ' +
          'decoded twice under a shifted timeline, not real repeated dialogue'
      );
    }
  }
  s.lastWindowGrams = currentGrams;
  s.lastWindowSpan = absStart.toFixed(2) + ',' + absEnd.toFixed(2);

  const words = [];
  const energyReport = [];
  for (const tok of sanitizedTokens) {
    const text = tok.text;
    const wLocalStart = tok.wLocalStart;
    const wLocalEndResolved = tok.wLocalEnd;
    // MEDIA TIME IN, MEDIA TIME OUT: word_abs = window's own absolute start
    // (absStart, which came straight from mediabunny's wrapped[].timestamp,
    // the container's own clock) + word's offset within the window. No
    // currentTime, no bufferedEnd, no measured/guessed offset anywhere here.
    const videoStart = absStart + wLocalStart;
    const videoEnd = absStart + wLocalEndResolved;
    // Computed inside the worker (0.1.15) - float16k's buffer was
    // transferred there for the transcribe call and is no longer readable
    // on this side. See whisper-worker-src.js's rmsAt.
    const rms = tok.rms != null ? tok.rms : 0;
    energyReport.push(text + ':' + rms.toFixed(3));
    const dedupeKey = text.toLowerCase() + '@' + videoStart.toFixed(1);
    if (s.emittedKeys.has(dedupeKey)) continue;
    s.emittedKeys.add(dedupeKey);
    const wordEntry = { word: text, start: videoStart, end: videoEnd };
    words.push(wordEntry);
    s.allWords.push(wordEntry);
  }
  // Cheap energy sanity signal: a word sitting on near-silence (RMS well
  // below typical speech, roughly <0.01 for 16-bit-equivalent float PCM)
  // means Whisper's own within-window timing is likely wrong.
  const lowEnergy = energyReport.filter((e) => parseFloat(e.split(':')[1]) < 0.01);
  if (lowEnergy.length) log('[PM-ENERGY] low-RMS (likely mistimed) words:', lowEnergy.join(' '));

  // Memory leak fix (0.1.15): s.allWords (and its s.emittedKeys dedupe set)
  // were uncapped - every word transcribed for the entire session lifetime
  // stayed resident. Resync (the only consumer of s.allWords - see
  // pm-resync below) only actually needs recent words plus current
  // coverage, which is tracked completely separately in s.covered anyway,
  // so trimming old entries never loses coverage information. Cap to a
  // sane trailing window and clean the matching dedupe keys so that set
  // doesn't leak either.
  if (s.allWords.length > ALL_WORDS_CAP) {
    const dropped = s.allWords.splice(0, s.allWords.length - ALL_WORDS_CAP);
    for (const w of dropped) s.emittedKeys.delete(w.word.toLowerCase() + '@' + w.start.toFixed(1));
  }

  const wallMs = performance.now() - t0;
  const rtf = wallMs / 1000 / audioDurationS; // see modelRtf note above - consistent basis with wallMs
  const lagMs = Date.now() - s.lastSegWallTime;

  try {
    await chrome.runtime.sendMessage({
      type: 'pm-words-result',
      tabId: s.tabId,
      videoId: s.videoId,
      words,
      // Send the ACTUALLY-decoded span, not the requested [absStart,absEnd) -
      // content.js's own coveredIntervals (which gates safe-mode muting)
      // is built directly from these; reporting the full requested window
      // regardless of what was really decoded is exactly the "silent
      // compaction" bug (see [PM-COVERAGE-GAP] above).
      windowStartS: coverStart,
      windowEndS: coverEnd,
      wallMs,
      rtf,
      modelRtf,
      decodeMs,
      queueMs,
      computeMs,
      lagMs,
      // 0.1.25: current detected language (null until resolved, 'en' or a
      // real code thereafter - pinned per video, see languageState above)
      // and the model THIS window actually ran on, so content.js/the pill
      // always has the latest without needing a separate message to have
      // landed first (the dedicated 'pm-language' push, sent once right
      // when detection resolves, is a snappier-UI nice-to-have on top of
      // this, not the only source of truth).
      language: s.detectedLanguage,
      model: effectiveModelId
    });
  } catch (e) {
    log('sendMessage(pm-words-result) failed:', String(e));
  }

  // Coverage is merged per ACTUALLY-decoded buffer span (own timestamps),
  // not the requested window - see the [PM-COVERAGE-GAP] check above. This
  // also naturally handles an internal gap between two decoded buffers
  // within the same window (mergeRangeInto won't bridge a real hole), so a
  // future pickNextWindow() call will pick that hole back up instead of it
  // being silently treated as covered.
  for (const wb of wrapped) {
    mergeRangeInto(s.covered, wb.timestamp, wb.timestamp + wb.buffer.duration);
  }

  // [PM-FIRST-COVERAGE] (0.1.18): one-line, per-stage breakdown of the cold
  // path - captured -> relayed -> picked -> decoded -> words -> covered -
  // logged ONCE, the first time a session's coverage is actually applied,
  // so any future paste shows exactly where startup time goes instead of
  // requiring guesswork across capture.js/content.js/background.js/this
  // file. Milestones are best-effort Date.now() wall-clock stamps set at
  // each stage's own call site (see getOrCreateSession's pm-segment
  // handler for captured/relayed, pickNextWindow's caller in maybeProcess
  // for picked, and this function for decoded/words) - all within the same
  // browser process, so directly comparable despite crossing JS contexts.
  if (!s.firstCoverageLogged) {
    s.firstCoverageLogged = true;
    const m = {
      captured: s.firstSegCapturedAt,
      relayed: s.firstSegRelayedAt,
      picked: s.firstWindowPickedAt,
      decoded: s.firstWindowDecodedAt,
      words: s.firstWindowWordsAt,
      covered: Date.now()
    };
    const stageOrder = ['captured', 'relayed', 'picked', 'decoded', 'words', 'covered'];
    const parts = [];
    for (let i = 1; i < stageOrder.length; i++) {
      const prevKey = stageOrder[i - 1], curKey = stageOrder[i];
      const delta = m[curKey] != null && m[prevKey] != null ? m[curKey] - m[prevKey] : null;
      parts.push(prevKey + '->' + curKey + '=' + (delta != null ? Math.round(delta) : 'NA') + 'ms');
    }
    const totalMs = m.captured != null ? m.covered - m.captured : null;
    notifyTab(s, '[PM-FIRST-COVERAGE] ' + parts.join(' ') + ' total=' + (totalMs != null ? Math.round(totalMs) : 'NA') + 'ms');
  }

  // Loop-breaker (0.1.14, made LOCATION-BASED in 0.1.20): a live session
  // attempted the EXACT SAME window ([2640.00,2645.00), words=0) every ~3s
  // for 18 minutes (~350 attempts) - the per-buffer coverage merge above
  // already runs unconditionally regardless of word count (silence IS
  // coverage), so this wasn't a "word count gated the merge" bug; something
  // about the decoded buffers' OWN reported timestamps at that specific
  // position apparently never actually landed inside [absStart,absEnd)
  // closely enough to satisfy firstUncoveredPoint for THIS exact span, so
  // pickNextWindow kept re-selecting it identically forever.
  //
  // 0.1.20 REGRESSION FOUND (bug #1): a live paste showed [2587.02,2593.69)
  // and [2587.02,~2590.9) each re-transcribed ~5x alternately over 40s -
  // same STUCK LOCATION as the original 0.1.14 bug, but the exact-span key
  // above never accumulated attempts because the exact END kept changing
  // between attempts. Root cause: 0.1.18's rtf-aware cold-window growth
  // (pickNextWindow's `neededS` math) sizes a cold window off `s.lastKnownRtf`,
  // which is updated after EVERY attempt (including a 0-word one that still
  // decoded "successfully") - so each retry at the same stuck START got a
  // slightly different rtf estimate and therefore a different exact END,
  // defeating the exact-(absStart,absEnd) key even though it was genuinely
  // the same stuck spot every time (itself usually caused by a decode
  // producing buffers whose own timestamps don't actually land where
  // requested - see bug #2's run-boundary fix, which addresses the most
  // common real cause of that mismatch: feeding a timeline-discontinuous
  // append into a run whose sequential demuxer had already moved past it).
  // Fix: key the breaker on a rounded START LOCATION instead of the exact
  // span, and only check whether a small anchor window right at that start
  // is still uncovered - this is robust to the end drifting attempt to
  // attempt for the same stuck location, while still leaving genuinely
  // different (forward-progressing) window starts as separate counters.
  const LOOP_START_BUCKET_S = 1;
  const locKey = (Math.round(absStart / LOOP_START_BUCKET_S) * LOOP_START_BUCKET_S).toFixed(1);
  const anchorEnd = Math.min(absEnd, absStart + LOOP_START_BUCKET_S);
  if (firstUncoveredPoint(s.covered, absStart, anchorEnd) !== null) {
    const attempts = (s.windowAttempts.get(locKey) || 0) + 1;
    s.windowAttempts.set(locKey, attempts);
    if (attempts >= WINDOW_LOOP_THRESHOLD) {
      notifyTab(
        s,
        '[PM-WINDOW-LOOP] location near ' + absStart.toFixed(2) + ' attempted ' + attempts +
          'x (latest span [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ')) without ever registering as covered ' +
          '(likely a decoded-timestamp mismatch at this exact position) - force-marking covered to break the loop'
      );
      mergeRangeInto(s.covered, absStart, anchorEnd);
      s.windowAttempts.delete(locKey);
    }
  } else {
    s.windowAttempts.delete(locKey); // resolved normally - don't let the map grow unbounded over a long session
  }

  return true;
}

function sendHeartbeat(s) {
  chrome.runtime.sendMessage({ type: 'pm-heartbeat', tabId: s.tabId, videoId: s.videoId }).catch(() => {});
}

// OBSERVABILITY CHOKE POINT (0.1.23) - see PIPELINE_NOTES "0.1.23": a live
// session showed maybeProcess's loop go completely silent (no [PM-WINDOW],
// no [PM-NO-WINDOW], no skip) for 5+s despite captured, uncovered audio
// sitting available within the playhead horizon. The loop had SEVERAL exit
// paths that used plain log() (this document's own console) instead of
// notifyTab() (tab-visible) - invisible from the tab's own console/Copy
// Logs output, which the rest of this file's observability convention is
// built around. Rather than patch each individual silent path found this
// pass (and trust every FUTURE gate added to this loop to remember to log
// correctly), every exit from the loop below now funnels through this ONE
// choke point, which independently RE-DERIVES "is there actually
// uncovered-and-captured work being left on the table right now" and, if
// so, ALWAYS names the specific gate that stopped - a future gate that
// forgets to log explicitly can no longer idle silently, because this
// choke point doesn't trust any call site to have logged correctly; it
// checks the real state itself.
const IDLE_GATE_DIAG_THROTTLE_MS = 5000;
// Mirrors content.js's own "playhead horizon" concept (PROTECT_MARGIN, 5s)
// so the two surfaces agree on what "work available near the playhead"
// means - see the debug-overlay alignment note in content.js for the other
// half of this.
const WORK_CHECK_HORIZON_S = 5;
function hasUncoveredCapturedWorkNearPlayhead(s) {
  const ct = s.currentTimeS;
  const horizonEnd = ct + WORK_CHECK_HORIZON_S;
  for (const r of s.bufferedRanges) {
    const lo = Math.max(r.start, ct);
    const hi = Math.min(r.end, horizonEnd);
    if (hi <= lo) continue; // this captured range doesn't reach the playhead horizon
    if (firstUncoveredPoint(s.covered, lo, hi) !== null) return true;
  }
  return false;
}
function reportIdleGate(s, gateName, detail) {
  if (!hasUncoveredCapturedWorkNearPlayhead(s)) return; // nothing left to do near the playhead right now - this exit is legitimate, not a bug, don't alarm
  const now = Date.now();
  const lastByGate = s.lastIdleGateDiagWall || (s.lastIdleGateDiagWall = {});
  if (lastByGate[gateName] && now - lastByGate[gateName] < IDLE_GATE_DIAG_THROTTLE_MS) return;
  lastByGate[gateName] = now;
  notifyTab(s, '[PM-IDLE-GATE] maybeProcess stopped (' + gateName + ') while captured-but-uncovered audio exists within ' + WORK_CHECK_HORIZON_S + 's of the playhead: ' + detail);
}

async function maybeProcess(s) {
  if (s.disabled || s.unanalyzable) return; // pm_enabled=false (0.1.13), or DRM/undecodable content (0.1.15) - idle, no transcription CPU
  if (s.processing) {
    s.pendingRerun = true;
    return;
  }
  s.processing = true;
  // Heartbeat while genuinely working, so content.js's stall watchdog can
  // tell "this attempt is just slow" from "nothing is happening at all" -
  // without this, a long attempt (large window, cold model, CPU contention)
  // gets killed by the watchdog before it can ever finish, restarting
  // forever. Sent immediately (don't make content.js wait a full interval
  // for the first sign of life) plus on a timer for the duration of work.
  sendHeartbeat(s);
  const heartbeatTimer = setInterval(() => sendHeartbeat(s), HEARTBEAT_MS);
  // Generation guard (0.1.18): captured once per maybeProcess() invocation.
  // A page-refresh reset or a seek bumps s.generation - this loop stops
  // picking any FURTHER windows as soon as it notices (checked every
  // iteration, same reasoning as the disabled/unanalyzable check above),
  // rather than grinding through a whole backlog of now-irrelevant windows
  // before the new playhead region ever gets a turn. See dropSessionsForTab
  // and the pm-seek handler for where generation actually bumps, and
  // transcribeWindow for the belt-and-suspenders check on the RESULT of an
  // already-in-flight call that can't be aborted mid-way.
  const loopGeneration = s.generation;
  // Choke-point bookkeeping (0.1.23): every iteration starts by naming a
  // generic fallback gate - since the loop only ever exits via `break`,
  // this guarantees `exitGate` is ALWAYS something meaningful by the time
  // the loop ends, even for a hypothetical future `break` that forgets to
  // name itself. Set to null right before a successful iteration's normal
  // continue (bottom of the loop body) so a clean re-loop doesn't leave a
  // stale gate name lying around for reportIdleGate() to (mis)report later.
  let exitGate = null, exitDetail = '';
  try {
    for (;;) {
      exitGate = 'unknown-gate';
      exitDetail = '(a loop-exit path did not name itself - see maybeProcess source)';
      // Re-checked every iteration (0.1.15): pm_enabled could flip false
      // mid-loop (each transcribeWindow await is a real yield point) - the
      // top-of-function check alone only caught it BEFORE the loop started,
      // so a session disabled mid-catch-up would keep burning CPU on
      // already-queued windows for the rest of that loop.
      if (s.disabled) { exitGate = 'disabled'; exitDetail = 'pm_enabled=false'; break; }
      if (s.unanalyzable) { exitGate = 'unanalyzable'; exitDetail = 'DRM/undecodable content - transcription given up for this session'; break; }
      if (s.generation !== loopGeneration) {
        log('[PM-STALE] maybeProcess loop stopping: generation changed (' + loopGeneration + ' -> ' + s.generation + ')');
        exitGate = 'generation-changed';
        exitDetail = 'generation ' + loopGeneration + ' -> ' + s.generation + ' (a seek or reset superseded this loop)';
        break;
      }
      const run = s.currentRun;
      if (!run) {
        logNoWindowReason(s, 'no-run', 'no active byte run yet for this session (no init segment captured) - nothing to transcribe until one arrives');
        exitGate = 'no-run';
        exitDetail = 'no active byte run yet for this session';
        break;
      }
      const target = pickNextWindow(s, run);
      if (!target) {
        exitGate = 'no-target';
        exitDetail = 'pickNextWindow found nothing to pick (see its own [PM-NO-WINDOW] reason above, if any)';
        break;
      }
      // [PM-FIRST-COVERAGE] milestone (0.1.18): "picked" - the first time
      // ANY window gets picked for this session. Calls are strictly
      // sequential within this loop (each fully awaited before the next
      // pick), so this is unambiguously the window whose own
      // decoded/words/covered milestones get set inside transcribeWindow.
      if (!s.firstCoverageLogged && s.firstWindowPickedAt == null) s.firstWindowPickedAt = Date.now();
      // In-flight marking (0.1.18): see coverageViewForPicking() - this is
      // what lets the picker skip past a span already dispatched instead of
      // re-picking the exact same one before its result has landed (a live
      // [PM-TIMELINE-ALARM] caught this happening to [2520.17,2525.17)).
      const inFlightKey = target.start.toFixed(2) + ',' + target.end.toFixed(2);
      s.inFlightWindows.add(inFlightKey);
      let ok;
      try {
        ok = await transcribeWindow(s, run, target.start, target.end);
      } finally {
        s.inFlightWindows.delete(inFlightKey);
      }
      if (!ok) {
        exitGate = 'transcribe-failed';
        exitDetail = 'transcribeWindow returned false for [' + target.start.toFixed(2) + ',' + target.end.toFixed(2) + ') (see its own diag above, if any)';
        break;
      }
      s.hadFirstWindow = true; // cold-start window sizing only applies until the first one actually lands
      exitGate = null; // this iteration completed normally and is about to loop again - no exit to report yet
    }
  } catch (e) {
    exitGate = null; // already loudly reported via [PM-ERROR] below - the choke point would be redundant
    notifyTab(s, '[PM-ERROR] maybeProcess: ' + String(e && e.stack ? e.stack : e));
  } finally {
    if (exitGate) reportIdleGate(s, exitGate, exitDetail);
    clearInterval(heartbeatTimer);
    s.processing = false;
    if (s.pendingRerun) {
      s.pendingRerun = false;
      maybeProcess(s);
    }
  }
}

// END-OF-STREAM FLUSH (0.1.23) - see PIPELINE_NOTES "0.1.23" item 2. A
// run's ReadableStream is normally never closed while a video is loading
// (more bytes could always arrive), which means mediabunny's demuxer has no
// way to know it's safe to flush trailing samples near the TRUE end of a
// video - a final-tail window request there would hang forever waiting for
// bytes that will never come (the same failure CLASS as the fed-data-clamp
// bug above, just at the opposite end: "no more data is EVER coming" rather
// than "not enough has arrived YET"). Once a run's fed data has reached
// close to the video's own duration AND capture has reported no further
// growth for a few seconds, explicitly close the run's stream controller so
// mediabunny sees a clean, definite end - the final tail window can then
// decode (and correctly report "nothing more exists past here" rather than
// hang) normally. Nothing here re-triggers on its own from a message (there
// IS no further message once capture has genuinely gone quiet for good), so
// this needs its own lightweight timer rather than piggybacking on
// pm-segment like every other check in this file.
const EOF_CLOSE_SLACK_S = 1.0; // fed-through-duration counts as "reached the end" within this much
const EOF_CLOSE_QUIET_MS = 3000; // no further buffered growth for this long -> capture is genuinely done, not just between segments
function maybeCloseRunAtEndOfStream(s) {
  const run = s.currentRun;
  if (!run || run.streamClosed || run.fedEnd == null) return;
  if (s.videoDurationS == null) return; // unknown (still loading) or a live stream (Infinity, filtered out when set - see the pm-segment handler)
  if (run.fedEnd < s.videoDurationS - EOF_CLOSE_SLACK_S) return;
  if (Date.now() - (s.lastBufferedGrowthWall || 0) < EOF_CLOSE_QUIET_MS) return;
  closeRunStream(run);
  notifyTab(
    s,
    '[PM-EOF-FLUSH] run stream closed (fed through ' + run.fedEnd.toFixed(2) + 's, duration=' + s.videoDurationS.toFixed(2) +
      's, quiet ' + Math.round((Date.now() - s.lastBufferedGrowthWall) / 1000) + 's) - letting mediabunny flush trailing samples for the tail window'
  );
  maybeProcess(s); // re-kick in case a tail window was previously deferred waiting for exactly this
}
setInterval(() => {
  for (const s of sessions.values()) {
    try {
      maybeCloseRunAtEndOfStream(s);
    } catch (e) {
      log('maybeCloseRunAtEndOfStream error:', String(e));
    }
  }
}, 2000);

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'pm-reset') {
    dropSessionsForTab(msg.tabId);
    return;
  }

  if (msg.type === 'pm-seek') {
    // Seek preemption (0.1.18) - see content.js's 'seeking' handler and
    // this session's `generation` field for the full mechanism. Coverage/
    // run state is untouched; this only invalidates in-flight/queued work
    // and immediately re-kicks maybeProcess so the new playhead region
    // gets picked right away instead of waiting behind it.
    const key = sessionKey(msg.tabId, msg.videoId);
    const s = sessions.get(key);
    if (s) {
      s.generation++;
      if (typeof msg.currentTime === 'number' && !Number.isNaN(msg.currentTime)) s.currentTimeS = msg.currentTime;
      maybeProcess(s);
    }
    return;
  }

  if (msg.type === 'pm-tab-closed') {
    // Memory leak fix (0.1.15): closing a YouTube tab previously left its
    // session (bytes, runs, coverage, word history) resident in the
    // offscreen document forever - nothing ever told offscreen the tab was
    // gone. background.js forwards chrome.tabs.onRemoved here.
    dropSessionsForTab(msg.tabId);
    return;
  }

  if (msg.type === 'pm-config') {
    const s = getOrCreateSession(msg.tabId, msg.videoId);
    if (msg.model) {
      const changed = s.modelId !== msg.model;
      s.modelId = msg.model;
      // Preload fix (0.1.17): warm the newly-selected model proactively on
      // a pm_model change, same as the boot-time preload - don't wait for
      // the next window to pay that cost inline. Cheap to fire even when
      // unchanged (getTranscriber's own cache makes a repeat call a no-op),
      // but only bother when it actually changed.
      if (changed) whisperWorker.postMessage({ type: 'preload', modelId: msg.model });
    }
    // 0.1.25 - pm_multilingual (default true), re-sent alongside pm_model on
    // every video reset per background.js's sendModelConfig. Only read as a
    // boolean (never re-triggers detection mid-video if toggled - detection
    // is pinned once resolved for the video regardless).
    if (typeof msg.multilingual === 'boolean') s.multilingualEnabled = msg.multilingual;
    return;
  }

  if (msg.type === 'pm-disable') {
    // pm_enabled=false (0.1.13): idle this session's transcription CPU -
    // segments may keep flowing in briefly (content.js stops relaying them
    // once its own onChanged handler fires, but that's a separate context/
    // message boundary, so a few could still land in flight) but
    // maybeProcess must not pick any new window while disabled. The model
    // itself stays warm (transcriberPromises is module-level, not
    // per-session) - no need to re-load it on re-enable.
    const key = sessionKey(msg.tabId, msg.videoId);
    const s = sessions.get(key);
    if (s) s.disabled = true;
    return;
  }

  if (msg.type === 'pm-enable') {
    const s = getOrCreateSession(msg.tabId, msg.videoId);
    s.disabled = false;
    maybeProcess(s);
    return;
  }

  if (msg.type === 'pm-restart') {
    // Stall-recovery kick from content.js's watchdog. content.js only sends
    // this when BOTH coverage hasn't grown AND no heartbeat has arrived
    // recently - so by the time we get here, a genuinely-alive attempt
    // should be rare. Still, double-check `s.processing` before tearing
    // anything down: forcibly resetting state out from under an in-flight
    // transcribeWindow call would let it keep running to completion in
    // parallel with a freshly-started maybeProcess loop, racing on the same
    // session's mutable state - worse than just waiting. Since 0.1.10 there
    // is no offset to "re-resolve" (timestamps are trusted straight from the
    // container) - a stall is purely a throughput/wedge issue, so this just
    // re-kicks the processing loop.
    const key = sessionKey(msg.tabId, msg.videoId);
    const s = sessions.get(key);
    if (!s) {
      log('[PM-STALL] restart requested but no session found for', key);
      return;
    }
    if (s.processing) {
      log('[PM-STALL] restart requested for', key, 'but a transcription attempt is genuinely in progress (heartbeating) - ignoring, not killing live work');
      return;
    }
    // 0.1.41: a re-run of the picker cannot fix a wrong run mapping.
    //
    // The field case: the storm backstop fed audio from ~1560 into a run
    // anchored around 1590. Window [1565.73,1572.39) skipped forever with
    // "no decodable audio in this run at that time yet". The stall detector
    // fired correctly at 15s and asked for a restart, and the restart re-ran
    // maybeProcess against the same poisoned mapping, so it skipped
    // identically. Toothless for this failure class, because waiting helps a
    // slow pipeline and can never help a run that does not hold the audio.
    //
    // So: ask first whether the current run can serve the playhead at all.
    // If it cannot, the repair is a NEW RUN for that region, which only
    // capture.js can start (it holds the cached init bytes). Requesting one
    // is the difference between a restart that re-reads the same wrong map
    // and one that redraws it.
    const runsApi = globalThis.PMRuns;
    const cur = s.currentRun;
    const curSpan = cur && cur.fedStart != null && cur.fedEnd != null
      ? { start: cur.fedStart, end: cur.fedEnd }
      : null;
    const canServe = runsApi && s.currentTimeS != null
      ? runsApi.runCanServe(curSpan, s.currentTimeS)
      : true;
    const servedByAnotherRun = runsApi && s.currentTimeS != null
      ? s.runs.some((r) => r !== cur && runsApi.runCanServe(
          r.fedStart != null && r.fedEnd != null ? { start: r.fedStart, end: r.fedEnd } : null,
          s.currentTimeS
        ))
      : false;

    if (!canServe && !servedByAnotherRun) {
      notifyTab(
        s,
        '[PM-STALL] no run can decode the playhead at ' +
          (s.currentTimeS != null ? s.currentTimeS.toFixed(2) : 'unknown') +
          ' (current run ' + (curSpan ? '[' + curSpan.start.toFixed(2) + ',' + curSpan.end.toFixed(2) + ')' : 'has been fed nothing') +
          ') - requesting a fresh run for this region rather than re-running the picker over the same mapping'
      );
      chrome.runtime.sendMessage({
        type: 'pm-request-run-rebuild',
        tabId: s.tabId,
        videoId: s.videoId,
        atS: s.currentTimeS
      }).catch(() => {});
      // Still re-kick: if capture.js cannot oblige (no cached init bytes
      // yet, say) the picker at least gets its chance.
      maybeProcess(s);
      return;
    }

    notifyTab(s, '[PM-STALL] restart requested for ' + key + ' - no attempt in progress, forcing maybeProcess re-run');
    maybeProcess(s);
    return;
  }

  if (msg.type === 'pm-resync') {
    // content.js reconnected after a port drop - resend everything we have
    // for this session (words computed while the port was down must not be
    // silently lost) rather than relying on it having seen every incremental
    // 'pm-words-result' message.
    const key = sessionKey(msg.tabId, msg.videoId);
    const s = sessions.get(key);
    if (s) {
      log('[PM-RESYNC] resending', s.allWords.length, 'words and', s.covered.length, 'covered intervals for', key);
      chrome.runtime
        .sendMessage({ type: 'pm-resync-result', tabId: msg.tabId, videoId: msg.videoId, words: s.allWords, coveredIntervals: s.covered, language: s.detectedLanguage })
        .catch(() => {});
    }
    return;
  }

  if (msg.type === 'pm-segment') {
    const s = getOrCreateSession(msg.tabId, msg.videoId);
    // [PM-FIRST-COVERAGE] milestone 1/2 (0.1.18): the FIRST segment this
    // session ever sees. msg.wallTime is capture.js's own Date.now() at the
    // moment of capture (MAIN world); this handler's Date.now() is when it
    // actually landed here after the base64 relay through content.js and
    // background.js - the gap between the two is the actual relay latency.
    if (s.firstSegCapturedAt == null) {
      s.firstSegCapturedAt = typeof msg.wallTime === 'number' ? msg.wallTime : Date.now();
      s.firstSegRelayedAt = Date.now();
    }
    const bytes = base64ToUint8(msg.dataB64);

    if (msg.isInit) {
      // 0.1.23: a run superseded by a new one is never going to be fed
      // more bytes - close JUST its stream (not the full closeRun() teardown
      // used by the KEEP_RUNS pruning below, since it might still be read
      // from momentarily for a backward-seek-adjacent window) so mediabunny
      // sees a definite end for it instead of its stream sitting open
      // forever with nothing left to feed it.
      if (s.currentRun) closeRunStream(s.currentRun);
      const run = newRun();
      s.runs.push(run);
      s.currentRun = run;
      log('new byte run #' + s.runs.length);
      // Memory leak fix (0.1.15): s.runs was never pruned - every run's
      // Input/stream (each with up to RUN_STREAM_CACHE_BYTES=64MiB of its
      // own cache) stayed alive for the whole session. A session with many
      // seeks/resumes (many init segments) would accumulate them all
      // forever. Keep only the current run plus the immediately-previous
      // one (a backward seek shortly after a run switch can still
      // legitimately want the previous run's still-cached bytes); close
      // and drop anything older.
      // 0.1.41: retire by distance from the playhead, not by age. FIFO was
      // right when runs arrived one at a time; after a seek storm the
      // OLDEST run can be exactly the one holding the region the playhead
      // just came back to, and dropping it recreates the undecodable-audio
      // outage from the other direction. The run serving the playhead, and
      // the run currently being fed, are never candidates.
      const runsApi = globalThis.PMRuns;
      const keepRuns = runsApi ? runsApi.KEEP_RUNS : 2;
      while (s.runs.length > keepRuns) {
        let victimIdx = 0;
        if (runsApi) {
          victimIdx = runsApi.selectRunToRetire({
            runs: s.runs.map((r) => ({
              span: r.fedStart != null && r.fedEnd != null ? { start: r.fedStart, end: r.fedEnd } : null,
              isCurrent: r === s.currentRun
            })),
            playheadT: s.currentTimeS,
            maxRuns: keepRuns
          });
        }
        if (victimIdx < 0) break; // everything left is playhead-relevant
        const victim = s.runs[victimIdx];
        notifyTab(
          s,
          '[PM-RUN-RETIRE] closing run ' + (victim.fedStart != null
            ? '[' + victim.fedStart.toFixed(2) + ',' + (victim.fedEnd != null ? victim.fedEnd.toFixed(2) : '?') + ')'
            : '(nothing fed)') + ' - furthest from the playhead at ' +
            (s.currentTimeS != null ? s.currentTimeS.toFixed(2) : 'unknown')
        );
        s.runs.splice(victimIdx, 1);
        closeRun(victim);
      }
    }
    if (s.currentRun) {
      appendToRun(s.currentRun, bytes);
      // Fed-data ground truth (0.1.23) - see DECODE_FED_GUARD_S/
      // pickNextWindow's fed-data clamp: `run.fedEnd` tracks how far THIS
      // run's stream has actually been fed real audio, from the SAME
      // growthAbsEnd value that also feeds s.bufferedRanges (session-level)
      // just below - but scoped to the run that ACTUALLY received these
      // bytes, so it can never race ahead the way the session-level value
      // apparently can. A synthetic run-boundary segment (0.1.20) carries no
      // growth (null), so it correctly does not advance fedEnd on its own -
      // only the real segment that follows it does.
      if (typeof msg.growthAbsEnd === 'number' && !Number.isNaN(msg.growthAbsEnd)) {
        s.currentRun.fedEnd = s.currentRun.fedEnd == null ? msg.growthAbsEnd : Math.max(s.currentRun.fedEnd, msg.growthAbsEnd);
      }
      if (typeof msg.growthAbsStart === 'number' && !Number.isNaN(msg.growthAbsStart)) {
        s.currentRun.fedStart = s.currentRun.fedStart == null
          ? msg.growthAbsStart
          : Math.min(s.currentRun.fedStart, msg.growthAbsStart);
      }
      // Cross-check ONLY (never an input to any timestamp): does the
      // container's own EBML Cluster>Timecode (capture.js's localTimeSec)
      // roughly agree with the independently-measured buffered-range growth
      // (growthAbsStart)? If they disagree beyond CHECK_SLACK_S, something
      // upstream is genuinely wrong (e.g. an ad segment slipping through, or
      // a real container/browser bug) and worth surfacing - but we do NOT
      // use this to compute any word timestamp.
      // Log collapse (0.1.15): only log when they actually DISAGREE - an
      // unconditional per-segment line here was pure noise at normal append
      // rates (every segment, forever) and, per the elegance audit, was
      // actively working against the ring buffer's "flight recorder" job by
      // evicting genuinely useful history in ~2 minutes.
      if (msg.localTimeSec != null && msg.growthAbsStart != null) {
        const delta = msg.growthAbsStart - msg.localTimeSec;
        if (Math.abs(delta) > CHECK_SLACK_S) {
          log(
            '[PM-CHECK] seg=' + msg.segIndex + ' localTimeSec=' + msg.localTimeSec.toFixed(3) +
              ' growthAbsStart=' + msg.growthAbsStart.toFixed(3) + ' delta=' + delta.toFixed(3) +
              ' *** DISAGREEMENT beyond ' + CHECK_SLACK_S + 's ***'
          );
        }
      }
    } else {
      log('segment received before an init segment; dropping');
    }

    if (typeof msg.currentTime === 'number' && !Number.isNaN(msg.currentTime)) {
      s.currentTimeS = msg.currentTime;
    }
    // End-of-stream detection input (0.1.23) - used ONLY by
    // maybeCloseRunAtEndOfStream below, never for timestamp construction
    // (per the "media time in, media time out" doctrine). A live stream
    // reports Infinity here and is correctly never treated as "reachable".
    if (typeof msg.duration === 'number' && !Number.isNaN(msg.duration) && isFinite(msg.duration)) {
      s.videoDurationS = msg.duration;
    }
    // Real interval-set availability (0.1.14) - every segment's own
    // growthAbsStart/growthAbsEnd (this append's actual contribution to the
    // buffered timeline, from capture.js's own buffered-range-growth
    // measurement) is merged in directly. This is what makes a disjoint
    // range from a big forward/backward seek within one SourceBuffer
    // (no new init segment - isInit stays false, nothing else would ever
    // notice) visible to pickNextWindow at all. capture.js only includes
    // this pair when its own findGrowth() detected genuine growth, so its
    // mere presence here already means "new audio actually arrived" - no
    // separate before/after comparison needed (0.1.15: this replaced the
    // deleted single-scalar s.bufferedEndS, which this same growth check
    // used to gate lastBufferedGrowthWall on).
    if (typeof msg.growthAbsStart === 'number' && typeof msg.growthAbsEnd === 'number' && !Number.isNaN(msg.growthAbsStart) && !Number.isNaN(msg.growthAbsEnd)) {
      mergeRangeInto(s.bufferedRanges, msg.growthAbsStart, msg.growthAbsEnd);
      s.lastBufferedGrowthWall = Date.now();
    }
    s.lastSegWallTime = Date.now();
    maybeProcess(s);
  }
});

log('offscreen document ready, world=offscreen, models=' + JSON.stringify(MODEL_IDS));
