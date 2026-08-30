// offscreen-src.js — bundled into dist/offscreen.bundle.js (see build.js).
// Runs in the MV3 offscreen document (only place ONNX/transformers.js and
// WebCodecs decode work reliably for this pipeline — see
// ../../spike-whisper/SPIKE_NOTES.md and ../../spike-capture/SPIKE_NOTES.md).
//
// GOVERNING PRINCIPLE (0.1.10 redirect): "media time in, media time out."
// The WebM container is the only clock. YouTube's audio SourceBuffer runs on
// the media presentation timeline — the SAME timeline as video.currentTime
// (spike-capture originally confirmed this: buffered.end() tracks
// currentTime directly, no offset/scale correction needed). mediabunny,
// decoding the SAME bytes via the SAME container format, reports that exact
// same timeline in its AudioBuffer timestamps — untouched, unrebased. So a
// decoded window's own timestamps ARE absolute video time; word_abs =
// window's own reported timestamp + word's offset within it. No currentTime,
// no bufferedEnd, no wall clock, and no per-run offset estimation anywhere
// in timestamp construction — all of that (0.1.6-0.1.9's anchor/measured-
// offset machinery) was solving a problem that didn't exist, and at least
// one version of it (0.1.8) leaked wall-clock processing delay into the
// timeline as a side effect. capture.js's buffered-range-growth measurement
// is kept ONLY as a logged cross-check against the container's own EBML
// Cluster>Timecode (do they roughly agree? if not, something upstream is
// genuinely wrong and worth knowing about) — it is never an input to any
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
// src/whisper-worker-src.js — model load + inference now run in a dedicated
// Web Worker, not on this document's own main thread. See that file's
// header for the full diagnosis (popup paint starvation) and why the split
// is exactly at the transcribe step.
import { Input, ReadableStreamSource, AudioBufferSink, WEBM, MP4, ADTS } from 'mediabunny';

// 'small' added 0.1.13 as an opt-in accuracy tier (per the quiet-speech-
// recall investigation) — Xenova/whisper-small.en is confirmed on the Hub to
// ship alignment_heads in its generation_config.json (same basis tiny/base
// were confirmed on), so word timestamps are supported. RTF cost is
// UNVERIFIED live (no real-Chrome run has selected it yet) — expect roughly
// ~2x base's cost by parameter-count scaling (base ~74M vs small ~244M
// params); base's own measured RTF headroom (~0.13-0.29 steady-state per
// PIPELINE_NOTES) suggests small should still fit comfortably under 1.0,
// but this is an estimate, not a measurement — re-verify before
// recommending it broadly.
const MODEL_IDS = { tiny: 'Xenova/whisper-tiny.en', base: 'Xenova/whisper-base.en', small: 'Xenova/whisper-small.en' };
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
// (which nothing but this file's own devtools panel can see — invisible to
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
// popup — extension pages can share a renderer process, and Whisper's
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
// unconditionally at SW boot/onStartup/onInstalled — NOT gated on any tab
// opening a video). But that warmth was previously invisible: it happened
// before any session/tab existed to notifyTab() through, so a Copy Logs
// paste could never actually confirm it happened, let alone how long it
// took. `warmInfo` buffers the timing until the FIRST session of this
// offscreen document's lifetime is created, at which point it's surfaced
// into THAT tab's ring buffer — see logWarmToSession() and its call site
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
  if (msg.type === 'result') pending.resolve(msg);
  else pending.reject(new Error(msg.error || 'unknown whisper worker error'));
};
whisperWorker.onerror = (ev) => {
  broadcastDiag('whisper worker onerror: ' + (ev.message || ev));
};

// Transfers `float16k`'s own buffer into the worker (0.1.15: "transfer, not
// copy" — this ~1.1MB-per-18s-window array is detached from this thread by
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

// Simple promise-chain mutex (0.1.15) serializing every transcribeInWorker()
// call across ALL sessions/tabs sharing this offscreen document — the
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
// (user-inaccessible) console — broadcast to every known session's tab.
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
// grew with TOTAL RUN LENGTH, not window size — on a long-running video
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
    trackReadyPromise: null
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

// Releases a superseded run's demux state (0.1.15 memory-leak fix — see the
// pruning call site in the pm-segment handler). Closing the stream lets the
// ReadableStreamSource drop its cache; nulling the rest lets everything else
// (Input, track, sink) become GC-eligible once nothing else references it.
function closeRun(run) {
  try {
    if (run.streamController) run.streamController.close();
  } catch (e) {
    // already closed/errored elsewhere — fine, this is just cleanup
  }
  run.track = null;
  run.sink = null;
  run.input = null;
  run.streamController = null;
}

// RMS energy of the decoded window audio at a given time span (relative to
// the start of the float16k array passed to Whisper) — a cheap sanity signal
// for whether a word's timestamp is sitting on real speech, independent of
// any timeline mapping entirely (both float16k and the word offset are in
// the same window-local coordinate space).
// Word-level 4-grams of a window's raw transcript text, lowercased — used by
// the timeline-shift self-check below. Two windows sharing an unusually high
// fraction of these almost certainly mean the SAME audio got decoded/
// transcribed twice under two different claimed absolute spans (a timeline
// bug), not genuinely repeated dialogue — real conversational repetition is
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
// window) — classic decoder degeneration on ambiguous/quiet audio, not real
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
// to a hallucination loop — collapsing it would under-mute real profanity,
// which is strictly worse than the CPU/log-noise cost of a hallucination
// loop going uncollapsed. offscreen-src.js has no access to
// shared/wordlist.js (it only loads in content.js's isolated world, and
// isn't ours to touch) so this is a deliberately small, independent,
// conservative stem list used ONLY to decide "never collapse this" — not a
// replacement for the real wordlist, which still does the actual
// match/mute decision downstream in content.js. False negatives here (a
// profane word this list misses) just fall back to the pre-0.1.13 behavior
// of collapsing it; false positives (declining to collapse something that
// wasn't actually profane) cost a few extra transcribed/logged tokens at
// worst — asymmetric on purpose, safety-first.
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
      // Never collapse a repeated-profanity cycle — pass every occurrence
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

// rmsAt() moved to whisper-worker-src.js (0.1.15) — float16k's buffer is
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
      allWords: [], // every word ever emitted, absolute video time — for resync after a port drop
      emittedKeys: new Set(),
      lastWindowGrams: null, // this run's previous window's word 4-grams, for the timeline-shift self-check (see transcribeWindow)
      lastWindowSpan: null,
      lastSegWallTime: Date.now(),
      lastBufferedGrowthWall: Date.now(), // last time s.bufferedRanges actually grew — used by pickNextWindow's tiny-tail deferral to detect "run has gone quiet, this really is the end"
      hadFirstWindow: false, // cold-start detection in pickNextWindow — cleared per session, not per run (a seek into a new run is still "cold" relative to session-level coverage)
      disabled: false, // pm_enabled=false (0.1.13) — see pm-disable/pm-enable handlers
      bufferedRanges: [], // merged [{start,end}] in ABSOLUTE video time — real interval set of what our hook has actually captured (see pickNextWindow); 0.1.15 deleted the old single-scalar bufferedEndS entirely
      windowAttempts: new Map(), // rounded-start-location key -> attempt count, for the stuck-location loop-breaker (0.1.14, made location-based in 0.1.20 — see transcribeWindow's loop-breaker section for why exact-span keying stopped catching this)
      sinkErrorAttempts: new Map(), // "start.toFixed(2),end.toFixed(2)" -> consecutive sink.buffers() error count, for DRM/undecodable detection (0.1.15)
      unanalyzable: false, // set true once DRM/undecodable content is detected — maybeProcess stops entirely, content.js releases safe-mode muting for this session
      processing: false,
      pendingRerun: false,
      modelId: DEFAULT_MODEL,
      // Generation counter (0.1.18) — bumped on a page-load reset (dropped
      // entirely, see dropSessionsForTab) or a seek (pm-seek, in place —
      // coverage/state untouched). maybeProcess's loop and transcribeWindow
      // both capture their OWN generation at start and compare against the
      // session's CURRENT value before picking further windows / applying
      // results — a stale in-flight WASM call (can't be aborted mid-call)
      // still runs to completion, but its result is discarded rather than
      // applied once superseded, and no further old-generation windows get
      // queued behind it. See PIPELINE_NOTES "0.1.18" for the live bug this
      // fixes (a page refresh's stale session blocking the new one for 7s+).
      generation: 0,
      inFlightWindows: new Set(), // "start.toFixed(2),end.toFixed(2)" currently dispatched to transcribeWindow — prevents the picker from re-picking a span whose result hasn't landed yet
      lastKnownRtf: null, // rolling estimate (last computeMs-based rtf) used to size cold-start windows so they finish AHEAD of the playhead — see pickNextWindow
      // [PM-FIRST-COVERAGE] breakdown milestones (0.1.18) — set once each,
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
    logWarmToSession(s); // no-op if the worker/model isn't warm yet — see whisperWorker.onmessage's 'warm-ready' handler
  }
  return s;
}

function dropSessionsForTab(tabId) {
  for (const key of Array.from(sessions.keys())) {
    if (key.startsWith(tabId + ':')) {
      const s = sessions.get(key);
      s.generation++; // bump BEFORE deleting (0.1.18) — any in-flight closure still holding a reference to this exact object (a running maybeProcess loop or transcribeWindow call from before the reset) sees this and discards its own work instead of applying it to a session that's supposed to be gone
      for (const run of s.runs) closeRun(run); // close every run's demux state, not just prune — the whole session is going away
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
// window with almost NO signal (near-total silence) is also left alone —
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
// with ZERO [PM-WINDOW] attempts and no skip reason anywhere — every silent
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
// start/seek — the FIRST window landing at a fresh, disjoint point still had
// to wait for a full WINDOW_S(18s) worth of audio to buffer AND be
// transcribed before the user got any protection near where they just
// landed. A small first window gets useful coverage (and, more importantly,
// engages safe-mode protection) much sooner; normal WINDOW_S resumes right
// after. "Cold" is detected structurally rather than via an explicit
// seek/start event (which offscreen isn't directly told about): the very
// first window of a session, OR any window whose start isn't immediately
// adjacent to existing coverage (i.e. it's opening a new, disjoint region —
// exactly what a seek/resume produces), counts as cold.
// MICRO FIRST WINDOW (0.1.18): cut from 5s to 2.5s of audio — with a warm
// model (~0.2 rtf steady-state), that's first coverage in ~0.5s of compute
// once the model is actually warm (see the eager-preload fix). Growable
// per COLD_START_RTF_MARGIN_S below when the measured rtf says 2.5s alone
// wouldn't finish ahead of the playhead.
const COLD_START_WINDOW_S = 2.5;
const COLD_START_MIN_NEW_S = 1.5;
const COLD_START_ADJACENCY_S = 3;
// AIM AHEAD, NOT BEHIND (0.1.18): a live log showed a cold window picked
// correctly at the playhead (t=3334) but the playhead had moved to 3341 by
// the time it finished — a window is only useful if its OWN END is still
// ahead of the playhead once compute finishes. Grow the cold window (up to
// full WINDOW_S) using the session's last measured compute-only rtf so
// `window_duration * (1 - rtf) >= gap + margin` holds — i.e. the window
// outruns the playhead by at least COLD_START_RTF_MARGIN_S once transcribed.
// rtf is clamped well below 1 (COLD_START_RTF_CLAMP_MAX) so a slow/cold
// measurement can't produce a negative or absurd required size — in that
// case just fall back to a generously large (but still capped) window
// rather than doing fragile math with a >=1 rtf.
const COLD_START_RTF_MARGIN_S = 1;
const COLD_START_RTF_CLAMP_MIN = 0.15;
const COLD_START_RTF_CLAMP_MAX = 0.7;
// Tiny-tail-window deferral (0.1.13): a live log showed a 0.05s window
// attempted at rtf=68 — fixed per-call overhead (model warmup already paid,
// but demux/resample/generate call overhead) completely dominates a sliver
// that small, for near-zero transcription value. Defer the tail case too
// (previously exempted outright via `end < high`) until either enough new
// audio has batched in, or the run has genuinely gone quiet for a few
// seconds (implying this really is the last bit that will ever arrive, e.g.
// end of video) — otherwise it'll just be picked up, larger, next time.
const MIN_TAIL_S = 2;
const TAIL_STALL_MS = 3000;
const WINDOW_LOOP_THRESHOLD = 3; // same exact [absStart,absEnd) attempted this many times without ever registering covered -> force-cover and alarm (see transcribeWindow)
const ALL_WORDS_CAP = 2000; // trailing-window cap for s.allWords/s.emittedKeys — see the memory-leak note at the trim site
const SINK_ERROR_THRESHOLD = 3; // same exact window failing sink.buffers() this many times in a row -> DRM/undecodable, see markUnanalyzable

function markUnanalyzable(s, reason) {
  if (s.unanalyzable) return; // already marked, don't spam
  s.unanalyzable = true;
  notifyTab(s, '[PM-UNANALYZABLE] ' + reason + ' — giving up on transcription for this video; releasing safe-mode protection rather than leaving it muted forever with no way to actually analyze it');
  chrome.runtime.sendMessage({ type: 'pm-unanalyzable', tabId: s.tabId, videoId: s.videoId }).catch(() => {});
}

// RANGE-AWARE, PLAYHEAD-FIRST window picker (0.1.14). Root cause of "jump
// forward = uncovered forever": availability used to be modeled as ONE
// monotonic scalar (s.bufferedEndS, `Math.max`-accumulated across every
// segment). A big forward seek within the SAME SourceBuffer produces NO new
// init segment (isInit stays false — nothing resets anything), so capture.js
// correctly recorded a brand-new, DISJOINT range far ahead of the old one
// (confirmed live: ranges [2640-2860] and [3220-3310+] both growing,
// segs 144-229 all landing) — but the scalar model has no way to represent
// "there are two separate available regions"; it just silently ignored the
// new one whenever it happened to be summarized behind a stale read,
// permanently reporting "not enough buffered audio" for a region that was
// actually fully buffered and waiting. Fix: track availability as a real
// interval set (`s.bufferedRanges`, merged from every segment's own
// growthAbsStart/growthAbsEnd — literally the span OUR hook watched land,
// not a derived scalar), and always pick from the range CONTAINING
// currentTime, or — if the playhead has jumped somewhere not buffered yet —
// the NEAREST range ahead of it. Never a linear frontier that can only ever
// grow from where it last was.
// In-flight-aware coverage view (0.1.18): a live log showed the EXACT same
// span [2520.17,2525.17) picked and transcribed twice back-to-back (its own
// [PM-TIMELINE-ALARM] fired on the resulting near-duplicate text) — the
// picker had no way to know a span was already dispatched and not yet
// applied to s.covered. Folding `s.inFlightWindows` into the coverage view
// used for picking (never into `s.covered` itself, which must stay the
// TRUE, transcription-confirmed coverage) makes the picker skip past
// anything already in flight, the same way it already skips past
// genuinely-covered spans.
function coverageViewForPicking(s) {
  if (s.inFlightWindows.size === 0) return s.covered;
  const extra = [];
  for (const key of s.inFlightWindows) {
    const idx = key.indexOf(',');
    extra.push({ start: parseFloat(key.slice(0, idx)), end: parseFloat(key.slice(idx + 1)) });
  }
  return s.covered.concat(extra).sort((a, b) => a.start - b.start);
}

function pickNextWindow(s) {
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
  const high = targetRange.end - TAIL_SAFETY_S;
  if (high <= lowBound) {
    logNoWindowReason(
      s,
      'not-enough-buffered',
      'range [' + targetRange.start.toFixed(2) + ',' + targetRange.end.toFixed(2) + ') at the playhead not far enough ahead yet (currentTimeS=' + ct.toFixed(2) + ')'
    );
    return null;
  }

  const coverageView = coverageViewForPicking(s);
  let start = firstUncoveredPoint(coverageView, lowBound, high);
  if (start == null) {
    // Fully covered (or in-flight) so far within this range — extend
    // forward WITHIN THE SAME RANGE only (never jump to some other,
    // unrelated buffered region just because it happens to be later in the
    // list's ordering).
    let maxCoveredInRange = targetRange.start;
    for (const iv of coverageView) {
      if (iv.start < targetRange.end && iv.end > targetRange.start) maxCoveredInRange = Math.max(maxCoveredInRange, iv.end);
    }
    start = Math.max(maxCoveredInRange, lowBound);
    if (start >= high) {
      logNoWindowReason(s, 'fully-covered', 'fully covered (or in flight) up to the available buffer in range [' + lowBound.toFixed(2) + ',' + high.toFixed(2) + ') — nothing new to transcribe right now');
      return null;
    }
  }

  const nearExistingCoverage = s.covered.some((iv) => Math.abs(iv.end - start) < COLD_START_ADJACENCY_S);
  const isColdStart = !s.hadFirstWindow || !nearExistingCoverage;

  if (isColdStart) {
    // FIX (0.1.17): a live seek (to t=3289) showed the FIRST window aimed at
    // [3280.00,3285.00) — the very START of the freshly-captured range,
    // entirely BEHIND the playhead by the time transcription finished
    // (playhead had reached ~3294 by then) — wasting the coldest, slowest
    // window (paid model-load cost, see item 2) on audio the user had
    // already passed and would never hear (mute) or need (it's gone).
    // Audio behind the playhead is lowest priority — useful only for
    // rewind protection, which can wait until ahead-coverage is
    // comfortable. Force the cold window to start at most 1s behind
    // currentTime, never at the captured range's own start.
    const coldFloor = Math.max(targetRange.start, ct - 1);
    if (coldFloor >= high) {
      // The entire currently-captured range is behind the playhead — there
      // is NOTHING to usefully transcribe near/ahead of it yet. Defer
      // rather than burn a slow cold window on stale audio; safe mode's
      // muting already protects the user while waiting for capture to
      // reach the playhead (normally just the next segment or two).
      logNoWindowReason(
        s,
        'cold-behind-playhead',
        'captured range [' + targetRange.start.toFixed(2) + ',' + targetRange.end.toFixed(2) +
          ') is entirely behind the playhead (currentTimeS=' + ct.toFixed(2) + ') — deferring rather than wasting a cold window on already-passed audio'
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
      logNoWindowReason(s, 'tiny-tail-deferred', 'tail window only ' + size.toFixed(2) + 's (< MIN_TAIL_S=' + MIN_TAIL_S + 's) — deferring until more audio batches in or the run appears finished');
      return null;
    }
  }
  if (size <= 0) return null;
  return { start, end, isColdStart };
}

async function transcribeWindow(s, run, absStart, absEnd) {
  const t0 = performance.now();
  // Generation guard (0.1.18) — captured at entry; checked again right
  // before applying any result. A stale in-flight call from a prior
  // generation (a page-refresh reset, or a seek) can't be aborted mid-call,
  // but its result is discarded rather than applied once superseded — see
  // dropSessionsForTab()/the pm-seek handler for where generation bumps.
  const myGeneration = s.generation;

  // Track/sink are resolved ONCE per run and cached — re-fetching the
  // primary audio track is cheap once resolved, but constructing a fresh
  // Input/re-parsing from scratch (the old approach) is not. See newRun().
  if (!run.track) {
    if (!run.trackReadyPromise) {
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
    const track = await run.trackReadyPromise;
    if (!track) {
      notifyTab(s, '[PM-SKIP] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') skipped: no audio track found yet for this run');
      return false;
    }
  }
  if (run.nativeRate == null) run.nativeRate = await run.track.getSampleRate();
  const nativeRate = run.nativeRate;
  const sink = run.sink;
  const windowKeyForErrors = absStart.toFixed(2) + ',' + absEnd.toFixed(2);
  const wrapped = [];
  try {
    for await (const wb of sink.buffers(absStart, absEnd)) wrapped.push(wb);
  } catch (e) {
    // DRM/undecodable-content detection (0.1.15): if the SAME exact window
    // fails to decode 3 times in a row, this isn't a transient "not enough
    // data yet" — it's structurally undecodable (protected/DRM content is
    // the expected real-world cause: mediabunny can demux the container but
    // the actual audio samples are encrypted). Give up on this session
    // entirely rather than retrying forever against a video that will never
    // decode — releases safe-mode muting via `pm-unanalyzable` (see below)
    // so a rented/protected movie is never left permanently muted with no
    // way to actually protect it.
    const errCount = (s.sinkErrorAttempts.get(windowKeyForErrors) || 0) + 1;
    s.sinkErrorAttempts.set(windowKeyForErrors, errCount);
    if (errCount >= SINK_ERROR_THRESHOLD) {
      markUnanalyzable(s, 'window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') failed to decode ' + errCount + 'x in a row: ' + String(e));
    } else {
      notifyTab(s, '[PM-SKIP] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') skipped: sink.buffers error (' + errCount + '/' + SINK_ERROR_THRESHOLD + '): ' + String(e));
    }
    return false;
  }
  s.sinkErrorAttempts.delete(windowKeyForErrors); // a successful decode clears any prior error count for this exact span
  if (wrapped.length === 0) {
    notifyTab(s, '[PM-SKIP] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') skipped: no decodable audio in this run at that time yet (waiting for more data)');
    return false;
  }

  // Slicing resilience (0.1.11): NEVER assume the decoded buffers cover the
  // full requested [absStart,absEnd) window just because that's what we
  // asked sink.buffers() for — a byte gap in the run's stream (a dropped/
  // missing segment, or mediabunny simply not having decoded that far yet)
  // must surface as an actual, smaller coverage span, not be silently
  // treated as "the whole window is covered". Each wrapped AudioBuffer
  // carries mediabunny's own decoded timestamp (container time, untouched)
  // — that is the ONLY source of truth for what was actually covered.
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
        ') — treating the shortfall as a real gap (will be revisited), not marking the full requested window covered'
    );
  }

  // Resample-rate sanity check against INDEPENDENT ground truth (not just
  // re-deriving "expected" from the same formula as "actual", which can
  // never fail). nativeRate is what we tell the WebAudio resampler the
  // source rate is — if it's wrong (e.g. codec misreport), the resampler
  // silently stretches/shrinks the whole timeline, which would systematically
  // shift every downstream timestamp. Cross-check it against the actual
  // decoded audio: sum each wrapped buffer's own (rate-independent) duration
  // and compare to the span it claims to cover via timestamps.
  // Log collapse (0.1.15): this used to log an unconditional [PM-RESAMPLE]
  // line on EVERY window (already redundant with [PM-WINDOW]'s own
  // mediaSpan) — the ring buffer evicts in ~2 minutes under that volume,
  // which is worse for the actual "flight recorder" goal than only logging
  // when something is actually wrong. Both -WARN checks below already only
  // fire on genuine disagreement/mismatch; that's the only case worth a
  // log line here now.
  const decodedDurationSum = wrapped.reduce((acc, wb) => acc + wb.buffer.duration, 0);
  const claimedSpan = wrapped.length ? wrapped[wrapped.length - 1].timestamp + wrapped[wrapped.length - 1].duration - wrapped[0].timestamp : 0;
  if (nativeRate !== 48000) {
    log('[PM-RESAMPLE-WARN] unexpected nativeRate=' + nativeRate + ' (Opus/WebM is normally 48000Hz) — a wrong rate here would silently corrupt the WebAudio resample and shift every timestamp downstream');
  }
  if (Math.abs(decodedDurationSum - claimedSpan) > 0.5) {
    log('[PM-RESAMPLE-WARN] decoded buffer durations do not sum to their own claimed timestamp span (gap/overlap in decode) — decodedDurationSum=' + decodedDurationSum.toFixed(3) + ' claimedSpan=' + claimedSpan.toFixed(3));
  }

  const float16k = await windowToFloat16k(wrapped, absStart, absEnd, nativeRate);
  const tDecoded = performance.now();
  // [PM-FIRST-COVERAGE] milestone (0.1.18): "decoded" — see the full
  // breakdown log at the end of this function.
  if (!s.firstCoverageLogged && s.firstWindowDecodedAt == null) s.firstWindowDecodedAt = Date.now();

  if (s.generation !== myGeneration) {
    // Superseded (page reset or seek) while demuxing — don't even bother
    // queuing the expensive worker call for a window nobody wants anymore.
    log('[PM-STALE] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') abandoned after decode: generation changed (' + myGeneration + ' -> ' + s.generation + ')');
    return false;
  }

  // Model-in-use is tab-visible exactly once per session (0.1.13) — per the
  // standing "nothing that affects behavior stays invisible" rule, and
  // specifically to let a live session's log confirm what DEFAULT_MODEL
  // actually resolved to (the whole point of the tiny->base 0.1.6 change was
  // moot if a build somehow still defaulted to tiny).
  if (!s.loggedModel) {
    s.loggedModel = true;
    const resolvedId = MODEL_IDS[s.modelId] ? s.modelId : DEFAULT_MODEL;
    notifyTab(s, '[PM-MODEL] using model="' + resolvedId + '" (' + MODEL_IDS[resolvedId] + '), default="' + DEFAULT_MODEL + '"' + (resolvedId !== DEFAULT_MODEL ? ' [overridden via pm_model]' : ''));
  }
  // Serialized across ALL sessions/tabs (0.1.15): the worker is a single
  // dedicated thread, so a simple promise-chain mutex guarantees at most
  // one transcribe request in flight at a time, globally, rather than
  // racing several windows' requestId responses against each other for no
  // benefit (the worker would just process them one at a time internally
  // anyway). The wall-clock timer starts only once this call actually
  // BEGINS executing (not when it's enqueued behind another tab's window),
  // so modelRtf keeps measuring real transcribe time, not queue-wait.
  const tBeforeQueue = performance.now(); // wallMs SPLIT (0.1.18) — see queueMs/computeMs below
  let tTranscribeStart = 0;
  const workerResult = await runSerialized(() => {
    tTranscribeStart = performance.now();
    return transcribeInWorker(s.modelId, float16k, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      // Repetition mitigation (0.1.13), best-effort: each window is already
      // its own independent transcribe call with no prior window's text fed
      // back in, so cross-window conditioning is already effectively off
      // (transformers.js's ASR pipeline doesn't expose a direct
      // condition_on_previous_text toggle to set this explicitly). A SINGLE
      // window's own decode can still degenerate into a repetition loop on
      // ambiguous/quiet audio (the "it's him" x40 case) — no_repeat_ngram_size
      // is passed through in case the underlying generate() call honors it;
      // NOT verified against this exact transformers.js version, so the
      // guaranteed defense is collapseHallucinationLoops() below, not this.
      no_repeat_ngram_size: 3
    });
  });
  const transcribeMs = performance.now() - tTranscribeStart;
  // wallMs SPLIT (0.1.18): a live paste showed wallMs-derived rtf of 3-8
  // right next to modelRtf of 0.2-0.5 — almost all of it was QUEUE wait (a
  // stale/superseded session's own backlog competing for the same shared
  // worker), not compute, but wallMs alone couldn't show that. decodeMs
  // covers demux+resample (t0 to just after windowToFloat16k); queueMs is
  // strictly the wait for the worker mutex to free up; computeMs is the
  // worker's own round trip (== transcribeMs).
  const decodeMs = tDecoded - t0;
  const queueMs = tTranscribeStart - tBeforeQueue;
  const computeMs = transcribeMs;

  if (s.generation !== myGeneration) {
    // Superseded while the (unabortable) worker call was in flight — the
    // result is real, but for a playhead nobody's at anymore. Discard
    // rather than apply/log it as a real window (this is exactly the
    // near-duplicate-window symptom a live [PM-TIMELINE-ALARM] caught).
    notifyTab(
      s,
      '[PM-STALE] window [' + absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ') result discarded: generation changed (' +
        myGeneration + ' -> ' + s.generation + ') while transcribing — decodeMs=' + Math.round(decodeMs) +
        ' queueMs=' + Math.round(queueMs) + ' computeMs=' + Math.round(computeMs)
    );
    return false;
  }

  // [PM-FIRST-COVERAGE] milestone (0.1.18): "words returned".
  if (!s.firstCoverageLogged && s.firstWindowWordsAt == null) s.firstWindowWordsAt = Date.now();

  // float16k's buffer was TRANSFERRED into the worker above — it must never
  // be read again on this side (it's detached/zero-length now). `output`
  // below carries everything needed, including per-chunk `rms` (computed
  // inside the worker, where the PCM actually still is).
  const output = { text: workerResult.text, chunks: workerResult.chunks };
  const audioDurationS = absEnd - absStart;
  // rtf-aware cold-window sizing (0.1.18) feeds off this — track a rolling
  // "last known" compute-only rtf so the NEXT cold window (a future seek)
  // can size itself to actually outrun the playhead. Simple last-value,
  // not an average — the aim-ahead math already clamps it to a sane range.
  s.lastKnownRtf = computeMs / 1000 / audioDurationS;
  // Accounting fix (0.1.11): `rtf` used to be transcribeMs-only (the model
  // call's own throughput) while the `wallMs` logged right alongside it in
  // [PM-WINDOW] is the FULL time since transcribeWindow started, including
  // demux/track-ready wait and resample — e.g. wallMs=26681 with rtf=0.276
  // implied the model took ~5s on an 18s window, which was true, but the
  // other ~21.7s of real latency (waiting on data/decode) was invisible from
  // that same log line, misleadingly suggesting the pipeline was keeping up
  // in real time when it was not. `rtf` is now computed from `wallMs` — the
  // same basis as the number it's logged next to — so the two are always
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
  // ~40x with degenerate timestamps — many zero-duration words (normal/
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
        '" ' + hallucination.repeats + 'x consecutively — kept the first couple, dropped the rest (Whisper decoder degeneration, not real speech)'
    );
  }

  // Timeline-shift self-check (0.1.11): if two CONSECUTIVE windows for this
  // session produce near-identical text, that's almost always proof the same
  // audio got decoded/labeled twice under different claimed absolute spans
  // (a timeline bug — e.g. the exact "consecutive windows transcribed nearly
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
          absStart.toFixed(2) + ',' + absEnd.toFixed(2) + ')) — almost certainly the SAME audio ' +
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
    // Computed inside the worker (0.1.15) — float16k's buffer was
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
  // were uncapped — every word transcribed for the entire session lifetime
  // stayed resident. Resync (the only consumer of s.allWords — see
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
  const rtf = wallMs / 1000 / audioDurationS; // see modelRtf note above — consistent basis with wallMs
  const lagMs = Date.now() - s.lastSegWallTime;

  try {
    await chrome.runtime.sendMessage({
      type: 'pm-words-result',
      tabId: s.tabId,
      videoId: s.videoId,
      words,
      // Send the ACTUALLY-decoded span, not the requested [absStart,absEnd) —
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
      lagMs
    });
  } catch (e) {
    log('sendMessage(pm-words-result) failed:', String(e));
  }

  // Coverage is merged per ACTUALLY-decoded buffer span (own timestamps),
  // not the requested window — see the [PM-COVERAGE-GAP] check above. This
  // also naturally handles an internal gap between two decoded buffers
  // within the same window (mergeRangeInto won't bridge a real hole), so a
  // future pickNextWindow() call will pick that hole back up instead of it
  // being silently treated as covered.
  for (const wb of wrapped) {
    mergeRangeInto(s.covered, wb.timestamp, wb.timestamp + wb.buffer.duration);
  }

  // [PM-FIRST-COVERAGE] (0.1.18): one-line, per-stage breakdown of the cold
  // path — captured -> relayed -> picked -> decoded -> words -> covered —
  // logged ONCE, the first time a session's coverage is actually applied,
  // so any future paste shows exactly where startup time goes instead of
  // requiring guesswork across capture.js/content.js/background.js/this
  // file. Milestones are best-effort Date.now() wall-clock stamps set at
  // each stage's own call site (see getOrCreateSession's pm-segment
  // handler for captured/relayed, pickNextWindow's caller in maybeProcess
  // for picked, and this function for decoded/words) — all within the same
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
  // for 18 minutes (~350 attempts) — the per-buffer coverage merge above
  // already runs unconditionally regardless of word count (silence IS
  // coverage), so this wasn't a "word count gated the merge" bug; something
  // about the decoded buffers' OWN reported timestamps at that specific
  // position apparently never actually landed inside [absStart,absEnd)
  // closely enough to satisfy firstUncoveredPoint for THIS exact span, so
  // pickNextWindow kept re-selecting it identically forever.
  //
  // 0.1.20 REGRESSION FOUND (bug #1): a live paste showed [2587.02,2593.69)
  // and [2587.02,~2590.9) each re-transcribed ~5x alternately over 40s —
  // same STUCK LOCATION as the original 0.1.14 bug, but the exact-span key
  // above never accumulated attempts because the exact END kept changing
  // between attempts. Root cause: 0.1.18's rtf-aware cold-window growth
  // (pickNextWindow's `neededS` math) sizes a cold window off `s.lastKnownRtf`,
  // which is updated after EVERY attempt (including a 0-word one that still
  // decoded "successfully") — so each retry at the same stuck START got a
  // slightly different rtf estimate and therefore a different exact END,
  // defeating the exact-(absStart,absEnd) key even though it was genuinely
  // the same stuck spot every time (itself usually caused by a decode
  // producing buffers whose own timestamps don't actually land where
  // requested — see bug #2's run-boundary fix, which addresses the most
  // common real cause of that mismatch: feeding a timeline-discontinuous
  // append into a run whose sequential demuxer had already moved past it).
  // Fix: key the breaker on a rounded START LOCATION instead of the exact
  // span, and only check whether a small anchor window right at that start
  // is still uncovered — this is robust to the end drifting attempt to
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
          '(likely a decoded-timestamp mismatch at this exact position) — force-marking covered to break the loop'
      );
      mergeRangeInto(s.covered, absStart, anchorEnd);
      s.windowAttempts.delete(locKey);
    }
  } else {
    s.windowAttempts.delete(locKey); // resolved normally — don't let the map grow unbounded over a long session
  }

  return true;
}

function sendHeartbeat(s) {
  chrome.runtime.sendMessage({ type: 'pm-heartbeat', tabId: s.tabId, videoId: s.videoId }).catch(() => {});
}

async function maybeProcess(s) {
  if (s.disabled || s.unanalyzable) return; // pm_enabled=false (0.1.13), or DRM/undecodable content (0.1.15) — idle, no transcription CPU
  if (s.processing) {
    s.pendingRerun = true;
    return;
  }
  s.processing = true;
  // Heartbeat while genuinely working, so content.js's stall watchdog can
  // tell "this attempt is just slow" from "nothing is happening at all" —
  // without this, a long attempt (large window, cold model, CPU contention)
  // gets killed by the watchdog before it can ever finish, restarting
  // forever. Sent immediately (don't make content.js wait a full interval
  // for the first sign of life) plus on a timer for the duration of work.
  sendHeartbeat(s);
  const heartbeatTimer = setInterval(() => sendHeartbeat(s), HEARTBEAT_MS);
  // Generation guard (0.1.18): captured once per maybeProcess() invocation.
  // A page-refresh reset or a seek bumps s.generation — this loop stops
  // picking any FURTHER windows as soon as it notices (checked every
  // iteration, same reasoning as the disabled/unanalyzable check above),
  // rather than grinding through a whole backlog of now-irrelevant windows
  // before the new playhead region ever gets a turn. See dropSessionsForTab
  // and the pm-seek handler for where generation actually bumps, and
  // transcribeWindow for the belt-and-suspenders check on the RESULT of an
  // already-in-flight call that can't be aborted mid-way.
  const loopGeneration = s.generation;
  try {
    for (;;) {
      // Re-checked every iteration (0.1.15): pm_enabled could flip false
      // mid-loop (each transcribeWindow await is a real yield point) — the
      // top-of-function check alone only caught it BEFORE the loop started,
      // so a session disabled mid-catch-up would keep burning CPU on
      // already-queued windows for the rest of that loop.
      if (s.disabled || s.unanalyzable) break;
      if (s.generation !== loopGeneration) {
        log('[PM-STALE] maybeProcess loop stopping: generation changed (' + loopGeneration + ' -> ' + s.generation + ')');
        break;
      }
      const run = s.currentRun;
      if (!run) {
        logNoWindowReason(s, 'no-run', 'no active byte run yet for this session (no init segment captured) — nothing to transcribe until one arrives');
        break;
      }
      const target = pickNextWindow(s);
      if (!target) break;
      // [PM-FIRST-COVERAGE] milestone (0.1.18): "picked" — the first time
      // ANY window gets picked for this session. Calls are strictly
      // sequential within this loop (each fully awaited before the next
      // pick), so this is unambiguously the window whose own
      // decoded/words/covered milestones get set inside transcribeWindow.
      if (!s.firstCoverageLogged && s.firstWindowPickedAt == null) s.firstWindowPickedAt = Date.now();
      // In-flight marking (0.1.18): see coverageViewForPicking() — this is
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
      if (!ok) break;
      s.hadFirstWindow = true; // cold-start window sizing only applies until the first one actually lands
    }
  } catch (e) {
    notifyTab(s, '[PM-ERROR] maybeProcess: ' + String(e && e.stack ? e.stack : e));
  } finally {
    clearInterval(heartbeatTimer);
    s.processing = false;
    if (s.pendingRerun) {
      s.pendingRerun = false;
      maybeProcess(s);
    }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'pm-reset') {
    dropSessionsForTab(msg.tabId);
    return;
  }

  if (msg.type === 'pm-seek') {
    // Seek preemption (0.1.18) — see content.js's 'seeking' handler and
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
    // offscreen document forever — nothing ever told offscreen the tab was
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
      // a pm_model change, same as the boot-time preload — don't wait for
      // the next window to pay that cost inline. Cheap to fire even when
      // unchanged (getTranscriber's own cache makes a repeat call a no-op),
      // but only bother when it actually changed.
      if (changed) whisperWorker.postMessage({ type: 'preload', modelId: msg.model });
    }
    return;
  }

  if (msg.type === 'pm-disable') {
    // pm_enabled=false (0.1.13): idle this session's transcription CPU —
    // segments may keep flowing in briefly (content.js stops relaying them
    // once its own onChanged handler fires, but that's a separate context/
    // message boundary, so a few could still land in flight) but
    // maybeProcess must not pick any new window while disabled. The model
    // itself stays warm (transcriberPromises is module-level, not
    // per-session) — no need to re-load it on re-enable.
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
    // recently — so by the time we get here, a genuinely-alive attempt
    // should be rare. Still, double-check `s.processing` before tearing
    // anything down: forcibly resetting state out from under an in-flight
    // transcribeWindow call would let it keep running to completion in
    // parallel with a freshly-started maybeProcess loop, racing on the same
    // session's mutable state — worse than just waiting. Since 0.1.10 there
    // is no offset to "re-resolve" (timestamps are trusted straight from the
    // container) — a stall is purely a throughput/wedge issue, so this just
    // re-kicks the processing loop.
    const key = sessionKey(msg.tabId, msg.videoId);
    const s = sessions.get(key);
    if (!s) {
      log('[PM-STALL] restart requested but no session found for', key);
      return;
    }
    if (s.processing) {
      log('[PM-STALL] restart requested for', key, 'but a transcription attempt is genuinely in progress (heartbeating) — ignoring, not killing live work');
      return;
    }
    notifyTab(s, '[PM-STALL] restart requested for ' + key + ' - no attempt in progress, forcing maybeProcess re-run');
    maybeProcess(s);
    return;
  }

  if (msg.type === 'pm-resync') {
    // content.js reconnected after a port drop — resend everything we have
    // for this session (words computed while the port was down must not be
    // silently lost) rather than relying on it having seen every incremental
    // 'pm-words-result' message.
    const key = sessionKey(msg.tabId, msg.videoId);
    const s = sessions.get(key);
    if (s) {
      log('[PM-RESYNC] resending', s.allWords.length, 'words and', s.covered.length, 'covered intervals for', key);
      chrome.runtime
        .sendMessage({ type: 'pm-resync-result', tabId: msg.tabId, videoId: msg.videoId, words: s.allWords, coveredIntervals: s.covered })
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
    // background.js — the gap between the two is the actual relay latency.
    if (s.firstSegCapturedAt == null) {
      s.firstSegCapturedAt = typeof msg.wallTime === 'number' ? msg.wallTime : Date.now();
      s.firstSegRelayedAt = Date.now();
    }
    const bytes = base64ToUint8(msg.dataB64);

    if (msg.isInit) {
      const run = newRun();
      s.runs.push(run);
      s.currentRun = run;
      log('new byte run #' + s.runs.length);
      // Memory leak fix (0.1.15): s.runs was never pruned — every run's
      // Input/stream (each with up to RUN_STREAM_CACHE_BYTES=64MiB of its
      // own cache) stayed alive for the whole session. A session with many
      // seeks/resumes (many init segments) would accumulate them all
      // forever. Keep only the current run plus the immediately-previous
      // one (a backward seek shortly after a run switch can still
      // legitimately want the previous run's still-cached bytes); close
      // and drop anything older.
      const KEEP_RUNS = 2;
      while (s.runs.length > KEEP_RUNS) closeRun(s.runs.shift());
    }
    if (s.currentRun) {
      appendToRun(s.currentRun, bytes);
      // Cross-check ONLY (never an input to any timestamp): does the
      // container's own EBML Cluster>Timecode (capture.js's localTimeSec)
      // roughly agree with the independently-measured buffered-range growth
      // (growthAbsStart)? If they disagree beyond CHECK_SLACK_S, something
      // upstream is genuinely wrong (e.g. an ad segment slipping through, or
      // a real container/browser bug) and worth surfacing — but we do NOT
      // use this to compute any word timestamp.
      // Log collapse (0.1.15): only log when they actually DISAGREE — an
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
    // Real interval-set availability (0.1.14) — every segment's own
    // growthAbsStart/growthAbsEnd (this append's actual contribution to the
    // buffered timeline, from capture.js's own buffered-range-growth
    // measurement) is merged in directly. This is what makes a disjoint
    // range from a big forward/backward seek within one SourceBuffer
    // (no new init segment — isInit stays false, nothing else would ever
    // notice) visible to pickNextWindow at all. capture.js only includes
    // this pair when its own findGrowth() detected genuine growth, so its
    // mere presence here already means "new audio actually arrived" — no
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
