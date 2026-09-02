// build.js - bundles src/offscreen-src.js (mediabunny + our demux/transcribe
// orchestration logic) into dist/offscreen.bundle.js, and src/whisper-worker-
// src.js (0.1.15 perf fix: Whisper model load + inference, moved off the
// offscreen document's main thread into a dedicated Web Worker - see that
// file's header) into dist/whisper.worker.js. Two separate esbuild.build()
// calls (not one multi-entry build) so each output keeps its own fixed,
// existing filename - offscreen.html and the Worker() constructor call
// both reference these paths directly.
//
// 0.1.46: this step also materializes the build VARIANT (PM_VARIANT, see
// scripts/variant.mjs) into two places, BEFORE esbuild runs so the bundles
// pick it up:
//   1. shared/build-config.js - the runtime flag (englishOnly) esbuild
//      inlines into the offscreen bundle and the worker.
//   2. manifest.json "name" - the store-facing name ("Profanity Muter" vs
//      "Profanity Muter (Multilingual)").
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

async function main() {
  fs.mkdirSync(DIST, { recursive: true });

  // variant.mjs is the single source of truth; imported dynamically because
  // this file is CommonJS and that module is ESM.
  const { getVariant, isEnglishOnly, STORE_NAME } = await import('./scripts/variant.mjs');
  const variant = getVariant();
  const englishOnly = isEnglishOnly();

  // 1. Generate the runtime flag the bundles read. Overwrites the committed
  // english default; a multilingual build leaves it englishOnly:false.
  const configPath = path.join(ROOT, 'shared', 'build-config.js');
  fs.writeFileSync(
    configPath,
    '// shared/build-config.js\n' +
      '//\n' +
      '// GENERATED at build time by build.js from PM_VARIANT. Do not hand-edit: a\n' +
      '// build overwrites it. The committed copy is the english default so the\n' +
      '// repo always has a valid runtime config even before a build runs and so a\n' +
      '// plain english build produces no diff here.\n' +
      '//\n' +
      '// This is imported (and inlined) into the offscreen bundle and the whisper\n' +
      '// worker by esbuild, so the runtime learns its variant with zero storage\n' +
      '// reads or message round-trips. When englishOnly is true the language gate\n' +
      '// and multilingual model routing are switched off: every window transcribes\n' +
      '// as English with base.en and neither whisper-tiny nor whisper-base is ever\n' +
      '// loaded. When false, the full 0.1.25 multilingual behavior is active.\n' +
      'export const BUILD_CONFIG = { englishOnly: ' + String(englishOnly) + ' };\n'
  );
  console.log('build-config.js: englishOnly=' + englishOnly + ' (PM_VARIANT=' + variant + ')');

  // 2. Inject the store name into manifest.json. Targeted single-field
  // replace (not a JSON reformat) so the rest of the file is untouched; the
  // english default already matches, so an english build makes no diff.
  const manifestPath = path.join(ROOT, 'manifest.json');
  const mtext = fs.readFileSync(manifestPath, 'utf8');
  const name = STORE_NAME[variant];
  const patched = mtext.replace(/("name":\s*")[^"]*(")/, '$1' + name + '$2');
  if (patched !== mtext) fs.writeFileSync(manifestPath, patched);
  console.log('manifest name: ' + JSON.stringify(name));

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

  await Promise.all([buildOffscreen, buildWorker]);
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
