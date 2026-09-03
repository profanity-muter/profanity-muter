// build.js - bundles src/offscreen-src.js (mediabunny + our demux/transcribe
// orchestration logic) into dist/offscreen.bundle.js, and src/whisper-worker-
// src.js (0.1.15 perf fix: Whisper model load + inference, moved off the
// offscreen document's main thread into a dedicated Web Worker - see that
// file's header) into dist/whisper.worker.js. Two separate esbuild.build()
// calls (not one multi-entry build) so each output keeps its own fixed,
// existing filename - offscreen.html and the Worker() constructor call
// both reference these paths directly.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DIST, { recursive: true });

const buildOffscreen = esbuild.build({
  entryPoints: [path.join(ROOT, 'src/offscreen-src.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  outfile: path.join(DIST, 'offscreen.bundle.js')
});

// Classic (non-module) worker script - matches `new Worker(url)` without
// {type:'module'} in offscreen-src.js, avoiding any module-worker MIME/CSP
// nuance for a self-contained bundle that doesn't need ES module semantics.
const buildWorker = esbuild.build({
  entryPoints: [path.join(ROOT, 'src/whisper-worker-src.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  outfile: path.join(DIST, 'whisper.worker.js')
});

Promise.all([buildOffscreen, buildWorker])
  .then(() => {
    console.log('bundled dist/offscreen.bundle.js and dist/whisper.worker.js');
    const ortSrcDir = path.join(ROOT, 'node_modules/onnxruntime-web/dist');
    const files = fs.readdirSync(ortSrcDir).filter((f) => /^ort-wasm-simd-threaded.*\.(mjs|wasm)$/.test(f));
    for (const f of files) {
      fs.copyFileSync(path.join(ortSrcDir, f), path.join(DIST, f));
    }
    console.log('copied', files.length, 'onnxruntime-web wasm runtime files');
    // 0.1.44: the shipped package must carry the bundled models. They are
    // gitignored and fetched by scripts/fetch-models.mjs, so a JS-only dev
    // build legitimately runs without them - warn rather than fail here,
    // and let `npm run package` (fetch + build) and `npm run check-models`
    // be the gates for an actual submission.
    const modelsDir = path.join(ROOT, 'models');
    if (!fs.existsSync(modelsDir)) {
      console.warn('WARNING: models/ is absent - run `npm run fetch-models` before packaging for the store (see CENSOR_NOTES 0.1.44)');
    } else {
      console.log('models/ present (run `npm run check-models` to verify completeness)');
    }
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
