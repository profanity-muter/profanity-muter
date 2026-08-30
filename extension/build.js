// build.js — bundles src/offscreen-src.js (transformers.js + mediabunny +
// our demux/transcribe logic) into dist/offscreen.bundle.js, and copies the
// onnxruntime-web wasm runtime files next to it (see spike-whisper
// SPIKE_NOTES.md gotcha #1: must be served locally, not from a CDN).
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DIST, { recursive: true });

esbuild
  .build({
    entryPoints: [path.join(ROOT, 'src/offscreen-src.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    outfile: path.join(DIST, 'offscreen.bundle.js')
  })
  .then(() => {
    console.log('bundled dist/offscreen.bundle.js');
    const ortSrcDir = path.join(ROOT, 'node_modules/onnxruntime-web/dist');
    const files = fs.readdirSync(ortSrcDir).filter((f) => /^ort-wasm-simd-threaded.*\.(mjs|wasm)$/.test(f));
    for (const f of files) {
      fs.copyFileSync(path.join(ortSrcDir, f), path.join(DIST, f));
    }
    console.log('copied', files.length, 'onnxruntime-web wasm runtime files');
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
