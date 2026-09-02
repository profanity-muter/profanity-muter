// whisper-worker-src.js - bundled into dist/whisper.worker.js via build.js.
// Runs Whisper model load + inference in a DEDICATED WEB WORKER, off the
// offscreen document's main thread (0.1.15 perf fix).
//
// Diagnosis (live user report): clicking the extension icon took ~15s for
// the popup to paint. Extension pages can share a renderer process, and
// Whisper inference (onnxruntime-web WASM, numThreads=1, no proxy) ran in
// multi-second SYNCHRONOUS bursts on the offscreen document's own main
// thread - starving the popup's load/paint in that same shared process.
//
// A packaged worker FILE (not a blob) is required: MV3's CSP blocks blob
// workers, which is exactly why onnxruntime-web's own `wasm.proxy` option
// was left off historically (its internal proxy-worker's loading mechanism
// was the original, unverified blocker candidate - see spike-whisper notes).
// This hand-rolled worker sidesteps that uncertainty entirely: we own this
// file directly, esbuild packages it as a real extension resource
// (dist/whisper.worker.js), and `new Worker(chrome.runtime.getURL(...))`
// from an extension page loading its own packaged resource is unambiguously
// same-origin, never a blob.
//
// SCOPE - deliberately narrow: only model loading + the transcribe() call
// live here. Demux (mediabunny) stays in offscreen-src.js's main thread:
// WebCodecs decode is comparatively fast/non-blocking in practice (the
// diagnosed bottleneck is specifically Whisper's synchronous WASM inference,
// not demux), and mediabunny's Input/ReadableStreamSource/AudioBufferSink
// objects aren't transferable across a worker boundary anyway - splitting
// demux into the worker would mean re-architecting session/run state across
// two execution contexts for no benefit toward the actual diagnosed problem.
// The fully-decoded, fully-resampled window PCM (windowToFloat16k's output -
// a plain Float32Array with zero live mediabunny state left in it) is the
// natural, self-contained hand-off point: transferred in as a Transferable
// (its own .buffer), never copied. This worker has NO chrome.* API access
// (deliberately not needed) - the wasm path base is handed over once in an
// 'init' message from the main thread, which already has chrome.runtime.
import { pipeline, env, Tensor } from '@huggingface/transformers';

// Eager warm-up timing (0.1.18) - as early in this file's own execution as
// possible, so `workerSpawnMs` (below) measures genuine worker-script-start-
// to-init latency, not anything this file does before reaching here.
const workerScriptStartWall = performance.now();

function log(...args) {
  console.log('[PM-WHISPER-WORKER]', ...args);
}

self.addEventListener('error', (ev) => {
  self.postMessage({ type: 'worker-error', text: 'uncaught error: ' + (ev.message || ev) });
});
self.addEventListener('unhandledrejection', (ev) => {
  self.postMessage({ type: 'worker-error', text: 'unhandled rejection: ' + String(ev.reason) });
});

// Kept in sync with offscreen-src.js's own copy - small, static lookup
// tables, not worth a shared-module import for this size. See that file's
// header for the 'small' model's alignment_heads/RTF notes.
// MULTILINGUAL SUPPORT (0.1.25): 'multilingual' (Xenova/whisper-base, the
// multilingual sibling of the .en default - confirmed on the Hub to ship
// alignment_heads, so word timestamps ARE supported for real transcription)
// is used for actual transcription once a video is detected as non-English.
// 'lang-detect' (Xenova/whisper-tiny, ALSO multilingual) is a SEPARATE,
// smaller model used ONLY for the one-shot language-ID probe below - never
// for real transcription, so its own alignment_heads support is irrelevant
// and was not checked. Keeping detection on the smallest model and real
// non-English transcription on the better 'multilingual' model means the
// (majority) English case pays zero extra cost: base.en stays the eagerly-
// preloaded default (see the boot preload below), completely unaffected by
// any of this - the "no English regression" requirement - and only a
// video that's actually NOT English ever pulls in the larger model at all.
const MODEL_IDS = {
  tiny: 'Xenova/whisper-tiny.en',
  base: 'Xenova/whisper-base.en',
  small: 'Xenova/whisper-small.en',
  multilingual: 'Xenova/whisper-base',
  'lang-detect': 'Xenova/whisper-tiny'
};
const DEFAULT_MODEL = 'base';

env.backends.onnx.wasm.proxy = false; // we ARE the dedicated thread now; onnxruntime-web's own proxy would just add another hop
env.backends.onnx.wasm.numThreads = 1;
env.allowLocalModels = false;
env.useBrowserCache = true;

let wasmPathsBase = null;

// Rejected-promise cache-poisoning fix (carried over from offscreen-src.js's
// 0.1.15 fix, now applied here since model loading lives in this worker):
// one flaky model fetch must not permanently kill transcription for the
// rest of the browser session - evict the cache entry on failure so the
// NEXT call gets a fresh attempt.
const transcriberPromises = new Map(); // modelId -> Promise<pipeline>
function getTranscriber(modelId) {
  const id = MODEL_IDS[modelId] ? modelId : DEFAULT_MODEL;
  if (!transcriberPromises.has(id)) {
    const t0 = performance.now();
    transcriberPromises.set(
      id,
      pipeline('automatic-speech-recognition', MODEL_IDS[id], {
        dtype: 'fp32', // quantized decoder hits an onnxruntime-web MatMulNBits bug (see spike notes)
        device: 'wasm'
      })
        .then((t) => {
          log('model loaded (' + id + ') in', Math.round(performance.now() - t0), 'ms');
          return t;
        })
        .catch((e) => {
          transcriberPromises.delete(id);
          throw e;
        })
    );
  }
  return transcriberPromises.get(id);
}

// Identical formula to offscreen-src.js's rmsAt - duplicated here (not
// imported) since it's a tiny pure function and the two files now run in
// separate execution contexts with separate copies of the window PCM
// (float16k is transferred INTO this worker, never available back on the
// main thread afterward - see the header above), so the energy check has
// to happen here, where the PCM actually is, and the result sent back
// alongside the transcript instead.
function rmsAt(float16k, localStartInWindow, localEndInWindow, sampleRate) {
  const s = Math.max(0, Math.floor(localStartInWindow * sampleRate));
  const e = Math.min(float16k.length, Math.ceil(localEndInWindow * sampleRate));
  if (e <= s) return 0;
  let sum = 0;
  for (let i = s; i < e; i++) sum += float16k[i] * float16k[i];
  return Math.sqrt(sum / (e - s));
}

// LANGUAGE DETECTION (0.1.25) - see PIPELINE_NOTES "0.1.25" for the full
// investigation. transformers.js 4.2.0 (the latest published version, and
// the one this extension ships) does NOT implement automatic language
// detection for Whisper: `WhisperForConditionalGeneration._retrieve_init_tokens`
// literally contains `// TODO: Implement language detection` and silently
// defaults to English whenever `language` isn't explicitly passed, both at
// the raw model level and in the ASR pipeline wrapper (`kwargs.language ??
// 'en'`) - confirmed by reading the installed package's source directly,
// not assumed. So `language: null` (the coordinator's suggested "cheap
// approach") does NOT work with this library version; there is no
// higher-level "detect API" to call either.
//
// Verified, working alternative (tested end-to-end in a standalone Node
// script against the real Xenova/whisper-tiny model before shipping this):
// bypass `generate()` (and its forced-English init tokens) entirely and
// call the model directly for ONE decoder step. This is exactly the
// mechanism Whisper's own reference `detect_language()` uses - no beam
// search, no full generation, just:
//   1. Run the encoder once on the window's audio features.
//   2. Feed `decoder_input_ids = [[decoder_start_token_id]]` (i.e. just
//      `<|startoftranscript|>`, nothing forced after it) through the
//      decoder for a single step.
//   3. Read the logits at that one position, restricted to the language
//      token ids in `model.generation_config.lang_to_id` (a real mapping
//      shipped in every multilingual Whisper checkpoint's own generation
//      config - confirmed present on Xenova/whisper-tiny), and take the
//      argmax.
// `model({input_features, decoder_input_ids})` (calling the pipeline's
// underlying model instance directly, not `model.generate()`) runs exactly
// steps 1+2 via transformers.js's own seq2seq_forward and returns logits
// for step 3 - confirmed by reading modeling_utils.js's seq2seq_forward,
// which computes encoder_outputs then decodes the given decoder_input_ids
// with ZERO of generate()'s init-token forcing logic in the way.
async function handleDetectLanguage(msg) {
  const { requestId, float16k } = msg;
  try {
    const transcriber = await getTranscriber('lang-detect');
    const model = transcriber.model;
    const processor = transcriber.processor;
    const langToId = model.generation_config && model.generation_config.lang_to_id;
    if (!langToId || Object.keys(langToId).length === 0) {
      // Should not happen for a real multilingual checkpoint - surfaced
      // loudly rather than silently defaulting, since a silent default here
      // would be exactly the "no English regression but also no detection
      // ever works" failure mode this whole feature is meant to avoid.
      self.postMessage({ type: 'lang-result', requestId, language: null, reason: 'lang-detect model has no lang_to_id (not a multilingual checkpoint?)' });
      return;
    }
    const inputs = await processor(float16k);
    const decoderStartTokenId = model.generation_config.decoder_start_token_id ?? model.config.decoder_start_token_id;
    const decoderInputIds = new Tensor('int64', [BigInt(decoderStartTokenId)], [1, 1]);
    const out = await model({ input_features: inputs.input_features, decoder_input_ids: decoderInputIds });
    const data = out.logits.data; // [1,1,vocab], flat - index directly by token id
    let bestTok = null, bestScore = -Infinity;
    for (const [tok, id] of Object.entries(langToId)) {
      const score = data[Number(id)];
      if (score > bestScore) {
        bestScore = score;
        bestTok = tok;
      }
    }
    // Token text is like "<|es|>" - strip the Whisper special-token braces
    // down to the plain ISO-ish code content.js/PMWordlist expect.
    const language = bestTok ? bestTok.replace(/[<|>]/g, '') : null;
    self.postMessage({ type: 'lang-result', requestId, language, score: bestScore });
  } catch (e) {
    self.postMessage({ type: 'lang-error', requestId, error: String(e && e.stack ? e.stack : e) });
  }
}

// Inferences performed by THIS worker instance. Resets on respawn, which
// is exactly the boundary the warm-up question is about.
let inferenceCount = 0;

async function handleTranscribe(msg) {
  const { requestId, modelId, float16k, options } = msg;
  try {
    // 0.1.43: split model resolution from inference. 0.1.42 concluded that
    // early windows are slow because of runtime warm-up, but said so as a
    // hypothesis, because computeMs bundles "waiting for the model to be
    // ready" with "running the model". Separating them settles it from a
    // user's paste: high resolveMs means loading, high inferMs on an
    // already-resolved model means genuine warm-up.
    const tResolve = performance.now();
    const transcriber = await getTranscriber(modelId);
    const modelResolveMs = performance.now() - tResolve;
    const t0 = performance.now();
    const output = await transcriber(float16k, options);
    const transcribeMs = performance.now() - t0;
    inferenceCount++;
    const chunks = (output.chunks || []).map((chunk) => {
      const [ls, leRaw] = chunk.timestamp || [null, null];
      let rms = null;
      if (ls != null) rms = rmsAt(float16k, ls, leRaw != null ? leRaw : ls + 0.3, 16000);
      return { text: chunk.text, timestamp: chunk.timestamp, rms };
    });
    self.postMessage({
      type: 'result',
      requestId,
      text: output.text,
      chunks,
      transcribeMs,
      modelResolveMs,
      inferenceIndex: inferenceCount
    });
  } catch (e) {
    self.postMessage({ type: 'error', requestId, error: String(e && e.stack ? e.stack : e) });
  }
}

// Preload fix (0.1.17/0.1.18): a live seek showed the FIRST window paying
// the model's own load cost inline - wallMs=7634 for a 5s cold-start window
// (rtf 1.53) vs. a steady-state ~0.2 rtf once warm. Fire getTranscriber()
// immediately at boot (fire-and-forget - the returned promise isn't
// awaited here; the first REAL transcribe request just awaits the SAME
// already-in-flight or already-resolved promise via getTranscriber's own
// cache) so the model is warm before any video/window ever needs it. This
// worker itself is created as soon as background.js creates the offscreen
// document - unconditionally at SW boot/onInstalled/onStartup, NOT gated
// on any tab opening a video - so in practice this preload usually starts
// warming well before the user has even navigated to a page, let alone
// pressed play. Re-fired whenever pm_model changes (see the 'preload'
// message below), so switching models in the popup warms the NEW one
// proactively too, instead of paying that cost on the next window after
// the switch. `reportWarm` is only set for the boot preload - see the
// 'warm-ready' message this produces, surfaced to whichever tab starts a
// session first via offscreen-src.js's logWarmToSession().
function preload(modelId, reportWarm) {
  const t0 = performance.now();
  getTranscriber(modelId)
    .then(() => {
      if (reportWarm) {
        self.postMessage({ type: 'warm-ready', workerSpawnMs: reportWarm.workerSpawnMs, modelLoadMs: Math.round(performance.now() - t0) });
      }
    })
    .catch((e) => {
      log('preload(' + modelId + ') failed (will retry on next real request):', String(e));
    });
}

self.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || !msg.type) return;
  if (msg.type === 'init') {
    wasmPathsBase = msg.wasmPathsBase;
    env.backends.onnx.wasm.wasmPaths = wasmPathsBase;
    const workerSpawnMs = Math.round(performance.now() - workerScriptStartWall);
    log('initialized, wasmPathsBase=' + wasmPathsBase + ', workerSpawnMs=' + workerSpawnMs);
    preload(DEFAULT_MODEL, { workerSpawnMs });
    return;
  }
  if (msg.type === 'preload') {
    preload(msg.modelId);
    return;
  }
  if (msg.type === 'transcribe') {
    handleTranscribe(msg);
  }
  if (msg.type === 'detect-language') {
    handleDetectLanguage(msg);
  }
});

log('whisper worker ready');
