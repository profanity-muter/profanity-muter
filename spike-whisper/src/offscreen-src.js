import { pipeline, env } from "@huggingface/transformers";

// --- MV3 / CSP configuration ---------------------------------------------
// No blob: workers, no remote code. Point the onnxruntime-web backend at
// the wasm/mjs files we bundled locally (dist/) instead of its default
// jsdelivr CDN URLs, and disable the proxy-worker path (which is created
// via a blob: URL and gets blocked by the extension CSP).
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("dist/");
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.numThreads = 1;

// Model weights are fetched at runtime from Hugging Face and cached via the
// Cache API - that's data, not code, so it's allowed under MV3.
env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = "Xenova/whisper-tiny.en";
const TARGET_WORDS = ["darn", "shoot", "crikey"];

function log(...args) {
  console.log("[WHISPER]", ...args);
  chrome.runtime.sendMessage({ type: "whisper-log", args: args.map(String) }).catch(() => {});
}

function normWord(w) {
  return w.toLowerCase().replace(/[^a-z']/g, "");
}

async function decodeWavTo16kFloat32(url) {
  const res = await fetch(url);
  const arrayBuffer = await res.arrayBuffer();
  const audioCtx = new (self.OfflineAudioContext || self.AudioContext)(1, 1, 16000);
  // Decode natively (the WAV is already 16kHz mono, but decodeAudioData
  // handles arbitrary input formats too).
  const decoded = await new Promise((resolve, reject) => {
    audioCtx.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
  });
  let channelData = decoded.getChannelData(0);
  if (decoded.sampleRate !== 16000) {
    // Resample via OfflineAudioContext if the source wasn't already 16k.
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    channelData = rendered.getChannelData(0);
  }
  return { data: channelData, duration: decoded.duration };
}

async function run() {
  const result = {
    ok: false,
    modelLoadMs: null,
    transcribeMs: null,
    audioDurationS: null,
    rtf: null,
    device: "wasm",
    text: null,
    hits: [],
    error: null,
  };
  try {
    log("starting spike run, model =", MODEL_ID);
    log("navigator.gpu available:", !!navigator.gpu);

    const audioUrl = chrome.runtime.getURL("assets/test.wav");
    const { data: audio, duration } = await decodeWavTo16kFloat32(audioUrl);
    result.audioDurationS = duration;
    log("decoded audio: duration=", duration.toFixed(2), "s samples=", audio.length);

    const t0 = performance.now();
    const transcriber = await pipeline("automatic-speech-recognition", MODEL_ID, {
      dtype: "fp32",
      // WASM is the primary verified path for this spike (see SPIKE_NOTES.md).
      // WebGPU also worked with no extra fighting - set device: "webgpu" to try it.
      device: "wasm",
    });
    const t1 = performance.now();
    result.modelLoadMs = t1 - t0;
    log("model loaded in", result.modelLoadMs.toFixed(0), "ms");

    const t2 = performance.now();
    const output = await transcriber(audio, {
      return_timestamps: "word",
      chunk_length_s: 30,
    });
    const t3 = performance.now();
    result.transcribeMs = t3 - t2;
    result.rtf = result.transcribeMs / 1000 / result.audioDurationS;

    log("transcription wall time:", result.transcribeMs.toFixed(0), "ms");
    log("RTF (wall/audio):", result.rtf.toFixed(3));
    log("transcript text:", output.text);

    result.text = output.text;
    result.chunks = (output.chunks || []).map((c) => ({ text: c.text, timestamp: c.timestamp }));

    for (const chunk of output.chunks || []) {
      const w = normWord(chunk.text);
      if (TARGET_WORDS.includes(w)) {
        const [start, end] = chunk.timestamp;
        log(`[HIT] word=${w} start=${start} end=${end}`);
        result.hits.push({ word: w, start, end });
      }
    }

    result.ok = true;
    log("run complete. hits found:", result.hits.length);
  } catch (err) {
    result.error = String(err && err.stack ? err.stack : err);
    log("ERROR:", result.error);
  }

  // Offscreen documents only expose chrome.runtime (no chrome.storage), so
  // hand the result to the service worker, which persists it to
  // chrome.storage.local for Playwright (or anything else) to read.
  try {
    await chrome.runtime.sendMessage({ type: "whisper-done", result });
  } catch (sendErr) {
    log("sendMessage(whisper-done) failed:", String(sendErr));
  }
  return result;
}

run();
