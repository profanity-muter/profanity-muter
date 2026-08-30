# Spike: on-device Whisper transcription with word timestamps in an MV3 offscreen document

Verdict: **works**. Verified end-to-end with Playwright (`chromium.launchPersistentContext` +
`--load-extension`): the extension's offscreen document runs `@huggingface/transformers`
(bundled with esbuild, no CDN/blob-worker code) against `onnxruntime-web` (WASM), transcribes a
locally-generated 33s test WAV with `return_timestamps: 'word'`, and correctly flags planted
target words with sane, monotonically increasing timestamps. Evidence: `run_wasm_warm_final.log`,
`run_wasm_cold_final.log`, `last_result.json` (all in this directory).

## Numbers (Xenova/whisper-tiny.en, dtype fp32, device wasm, 33.28s test clip)

| Run | Model load | Transcribe wall time | RTF (wall/audio) |
|---|---|---|---|
| Cold (fresh profile, model downloaded from HF) | 5586 ms | 9247 ms | 0.278 |
| Warm (model cached via Cache Storage) | 872-1729 ms | 5875-8654 ms | 0.177-0.260 |
| WebGPU, cold | 6102 ms | 7146 ms | 0.215 |

All RTFs are well under the 0.5 success bar. Model download was ~151 MB (fp32
`encoder_model.onnx` 32.9 MB + `decoder_model_merged.onnx` 118.6 MB), cached by the browser's
Cache Storage API after the first run (that's data, not code — allowed under MV3).

## Word-timestamp quality

Spot-checked against the source script (generated with macOS `say`, so timing is
deterministic and known):

- `darn` (from "Well, **darn** it, I dropped my coffee...", first sentence) -> `start=0.9 end=1.14`.
  Correct — first word-ish, right after "Well,".
- `shoot` (from "Oh, **shoot**.", second sentence) -> `start=4.12 end=4.32`. Correct — lines up
  with the second sentence boundary.
- `darn` (from "**Darn**, I forgot my umbrella...", 6th sentence, roughly halfway through the
  clip) -> `start=17.68 end=18.12`. Correct — about halfway through the 33s clip, matching
  sentence position.
- `shoot` (from "She said, **shoot**, we are going to miss the train...") -> `start=21.22
  end=21.36`. Correct — right after "she said,".

All chunk timestamps in the full transcript (`last_result.json`) are monotonically increasing
and land on sensible word/sentence boundaries throughout the clip — no drift or garbling
observed. Verdict: word-level timestamps from `return_timestamps: 'word'` are usable as-is for
a profanity muter's mute-window calculation.

One accuracy caveat, not a pipeline bug: the word "Crikey" (an unusual interjection for a
speech model) was transcribed as "Krikey" by the tiny model both times it was spoken, so the
simple exact-match wordlist check in this spike missed those 2 of the planted 3 target words
(4 of the intended 6 target-word occurrences were caught: 2x "darn", 2x "shoot"). This is an
ASR accuracy/vocabulary issue for the tiny model on uncommon words — not a timestamp-quality or
architecture problem. The real implementation should not rely on exact string match; a
profanity list needs fuzzy/phonetic matching or a larger model for uncommon target words.

## CSP / MV3 bundling gotchas hit (and fixes)

1. **transformers.js defaults to loading onnxruntime-web's WASM runtime from jsdelivr
   (`https://cdn.jsdelivr.net/npm/onnxruntime-web@.../dist/`).** That's remote code and is
   blocked by MV3's extension CSP (`script-src 'self'`). Fix: copy the onnxruntime-web WASM/mjs
   files from `node_modules/onnxruntime-web/dist/` into the extension's `dist/` folder and set
   `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("dist/")` before creating the
   pipeline. Needed **all** of the `ort-wasm-simd-threaded*.{mjs,wasm}` variants (plain, `.jsep`,
   `.jspi`, `.asyncify`) — the runtime picks a variant based on feature detection at load time
   and the wrong single-variant copy fails with `Failed to fetch dynamically imported module`.
2. **`WebAssembly.instantiate` needs `'wasm-unsafe-eval'` in the extension pages CSP.** Default
   MV3 CSP (`script-src 'self'; object-src 'self'`) is not enough; had to add an explicit
   `content_security_policy.extension_pages` with `script-src 'self' 'wasm-unsafe-eval'`.
3. **Blob-worker path**: onnxruntime-web can spin up a proxy worker via a `blob:` URL
   (`new Worker(blobURL, {type:'module'})`) when `wasm.proxy` is true, and a pthread worker via
   `new Worker(new URL(import.meta.url), ...)` when multithreading is enabled — both are
   incompatible with MV3 CSP / bundling. Fix: explicitly set `env.backends.onnx.wasm.proxy =
   false` and `env.backends.onnx.wasm.numThreads = 1`. In practice the library already defaults
   `numThreads` to 1 when the page isn't `crossOriginIsolated` (true for an offscreen doc), so
   this is mostly belt-and-suspenders — but set it explicitly, don't rely on the default.
4. **Web-accessible resources**: the bundled `dist/*.wasm` and `dist/*.mjs` files, and the test
   audio (`assets/test.wav`), must be declared in `web_accessible_resources` or the extension's
   own offscreen document can't `fetch()`/dynamic-`import()` them by URL.
5. **Quantized model exports don't all work.** Both `onnx-community/whisper-base.en` and
   `Xenova/whisper-base.en`'s `q8`/`uint8`/`int8` decoder exports (`decoder_model_merged*.onnx`)
   fail to create an ONNX Runtime Web session with: `Can't create a session. ... qdq_actions.cc:137
   TransposeDQWeightsForMatMulNBits Missing required scale: model.decoder.embed_tokens.weight_...`.
   This reproduced identically across two different model repos with three different quant dtype
   settings, so it looks like a real compatibility gap between this onnxruntime-web build
   (`1.26.0-dev.20260416-b7804b056c`, pinned by `@huggingface/transformers`) and the QDQ
   MatMulNBits weight-tied embedding layer in these particular quantized Whisper decoder
   exports — not something fixable from the extension side. **Workaround: use `dtype: "fp32"`**
   (or per-submodel dtype overrides that avoid the quantized decoder). Costs ~3x the download
   size vs quantized, but works reliably and RTF is still comfortably under budget.
6. **`return_timestamps: 'word'` needs the model's `generation_config.json` to have
   `alignment_heads`, and the decoder ONNX graph needs to actually export cross-attentions.**
   `onnx-community/whisper-base.en` (a newer re-export) threw `Model outputs must contain cross
   attentions to extract timestamps. This is most likely because the model was not exported with
   output_attentions=True`, even in fp32. Switching to `Xenova/whisper-tiny.en` (the original
   transformers.js-era export, confirmed to have `alignment_heads` in its
   `generation_config.json`) fixed this immediately. **Lesson: pick a model repo from the
   `Xenova/*` family (or otherwise verify `alignment_heads` + cross-attention outputs) if word
   timestamps are required** — not every ONNX Whisper re-upload supports them.
7. **`chrome.storage` is not available in an offscreen document's `chrome` object.** Confirmed
   by logging `Object.keys(chrome)` inside the offscreen doc: only `loadTimes`, `csi`, and
   `runtime` are present, even though the same extension's `storage` permission is declared and
   a normal extension page (`probe.html`) sees `chrome.storage` fine. This matches the task
   brief's fallback guidance: **the offscreen document must `chrome.runtime.sendMessage()` its
   result to the background service worker, which does the `chrome.storage.local.set()`.**
   Don't assume offscreen docs have full extension API parity with other extension pages.

## Verification methodology

- `run_playwright.mjs` launches a persistent Chromium context with the extension loaded via
  `--load-extension`, waits for the service worker, opens a plain extension page
  (`probe.html`) to poll `chrome.storage.local` (chosen over trying to read the offscreen
  document's own console/target directly, which proved unreliable — this matches the task's
  suggested fallback), and asserts: non-empty transcript text, at least one `[HIT]`, and
  RTF < 0.5.
- Real console output (both from the offscreen document directly, via `context.on('page')`,
  and relayed through the background service worker's `console.log`) was captured in the log
  files for auditability — every `[WHISPER]`-prefixed line is real inference output, not a
  fabricated success message.

## Recommendations for the real implementation

- **Model**: start with `Xenova/whisper-tiny.en`, `dtype: "fp32"`, `device: "wasm"`. It already
  hits RTF ~0.2-0.28 on this hardware — comfortably fast enough for a background/queued
  transcription pass on a YouTube video, and avoids the quantized-decoder compatibility bug
  above entirely. Only reach for `whisper-base.en` if tiny's word-error-rate on real YouTube
  audio (music, cross-talk, accents) proves too weak — it will cost roughly 2-3x the compute
  and ~280 MB fp32 download instead of ~150 MB, and (per gotcha #6) you'd need to verify
  `alignment_heads` exist for whatever repo you pick, since not all base.en re-exports do.
  If a smaller download matters more than avoiding the quant bug, it's worth filing/checking
  upstream `onnxruntime-web` / `@huggingface/transformers` issues for the MatMulNBits scale bug
  before giving up on quantization — it may already be fixed in a newer pinned version by the
  time the real feature is built.
- **Device**: WASM is the safe default (works everywhere, this spike's primary verified path).
  WebGPU worked without any extra fighting in this spike (`device: "webgpu"` — RTF 0.215,
  comparable to WASM) and is worth using opportunistically (`device: "webgpu"` with a
  try/catch fallback to `"wasm"` on unsupported hardware), but WASM should stay the
  guaranteed-to-work path since not all Chrome installs will have WebGPU enabled/capable.
- **Matching**: do not rely on exact string matching against Whisper's raw output — the
  "Crikey"→"Krikey" miss in this spike shows the ASR will misspell/mishear uncommon words.
  The real profanity matcher needs either a curated list of the exact target words with their
  ASR-transcribed variants (Whisper's English vocabulary is fairly memorized), fuzzy/edit-distance
  matching, or a normalization pass — plain lowercase+strip-punctuation (as used in this spike)
  is not sufficient on its own.
- **Bundling checklist for the real build** (all confirmed necessary here): bundle
  `@huggingface/transformers` with esbuild (or similar) into a single local file; copy all
  `ort-wasm-simd-threaded*.{mjs,wasm}` variants from `onnxruntime-web/dist` into the extension
  and point `env.backends.onnx.wasm.wasmPaths` at them; set `wasm.proxy = false`; add
  `'wasm-unsafe-eval'` to `content_security_policy.extension_pages`; declare bundled
  wasm/mjs/model-adjacent files in `web_accessible_resources`; run all inference in an offscreen
  document (`reasons: ["DOM_PARSER"]` was sufficient here) and communicate results back to the
  service worker via `chrome.runtime.sendMessage` rather than assuming the offscreen doc has
  direct `chrome.storage` access.

## Files in this spike

- `manifest.json`, `background.js`, `offscreen.html`, `probe.html` — the MV3 extension.
- `src/offscreen-src.js` — the actual spike logic (model load, audio decode, transcribe,
  wordlist check, timing, result relay).
- `dist/offscreen.bundle.js` — esbuild output (bundled `@huggingface/transformers` + spike
  logic). Rebuild with:
  `npx esbuild src/offscreen-src.js --bundle --format=iife --platform=browser --target=chrome110 --outfile=dist/offscreen.bundle.js`
- `dist/ort-wasm-simd-threaded*.{mjs,wasm}` — onnxruntime-web runtime files copied locally
  (see gotcha #1).
- `assets/test.wav` — 33.28s, 16kHz mono test clip generated with `say -o test.aiff "..."` then
  `ffmpeg -ar 16000 -ac 1` (script embedded in this file's history; regenerate via the `say`
  command in the task if needed).
- `run_playwright.mjs` — the Playwright verification harness. Run with `node run_playwright.mjs`
  (needs `npx playwright install chromium` once). Exit code 0 = success criteria met.
- `run_wasm_cold_final.log`, `run_wasm_warm_final.log`, `last_result.json` — real captured
  output from verification runs (wasm device, the committed default).
- `last_result_webgpu.json` — real captured output from a `device: "webgpu"` run (noted in
  numbers table above; the committed `src/offscreen-src.js` defaults to `device: "wasm"`).
