// scripts/fetch-models.mjs
//
// Build step: download the Whisper model weights that the extension loads,
// into extension/models/, so the shipped package is fully offline and
// carries no remotely-hosted model code. Run before packaging:
//
//     node scripts/fetch-models.mjs
//
// WHY THESE FILES, EXACTLY. src/whisper-worker-src.js loads via
// transformers.js@4.2.0 pipeline() with `dtype: 'fp32'` (the quantized
// decoder hits an onnxruntime-web MatMulNBits bug, see the spike notes),
// so the fp32 ONNX variants are what it fetches at runtime today. The file
// list below was not guessed: it was recorded by running that exact
// pipeline() against a clean cache and observing which files landed. The
// fp32 weights have NO suffix (`encoder_model.onnx`, not
// `encoder_model_quantized.onnx`), which is transformers.js's mapping for
// DATA_TYPES.fp32 -> "".
//
// WHY fp32 IS LARGE. fp32 is four bytes per parameter, so these are far
// bigger than the int8 sizes an earlier estimate assumed (~40/80MB). The
// real total is reported at the end of this script and in CENSOR_NOTES.
// Bundling the fp32 files is the faithful choice: it matches what the
// extension runs today, and changing dtype to shrink the package would be
// a transcription-quality change outside a bundling round's scope.
//
// The local directory layout mirrors the Hub repo id, so the worker can
// keep passing the same `Xenova/...` ids with `env.localModelPath` pointed
// at models/ and transformers.js resolves `models/Xenova/<repo>/<file>`
// with zero id remapping.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_REPOS, MODEL_FILES, MIN_ONNX_BYTES } from './model-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, '..', 'models');

// 0.1.46 (English-only): the shipped code loads exactly one model, base.en
// (~280MB). See scripts/model-manifest.mjs for the reasoning.
const REPOS = MODEL_REPOS;
const FILES = MODEL_FILES;
const BASE = 'https://huggingface.co';

async function download(repo, file) {
  const dest = path.join(MODELS_DIR, repo, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const url = `${BASE}/${repo}/resolve/main/${file}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // A tiny "file" is almost always an LFS pointer or an error page rather
  // than a real weight; fail loudly rather than ship a broken model.
  if (file.endsWith('.onnx') && buf.length < MIN_ONNX_BYTES) {
    throw new Error(`suspiciously small onnx (${buf.length} bytes) for ${url} - LFS pointer?`);
  }
  fs.writeFileSync(dest, buf);
  return buf.length;
}

let grandTotal = 0;
for (const repo of REPOS) {
  let repoTotal = 0;
  for (const file of FILES) {
    process.stdout.write(`  ${repo}/${file} ... `);
    const n = await download(repo, file);
    repoTotal += n;
    console.log(`${(n / 1048576).toFixed(1)} MB`);
  }
  grandTotal += repoTotal;
  console.log(`  = ${repo}: ${(repoTotal / 1048576).toFixed(1)} MB`);
}
console.log(`\nmodels/ total: ${(grandTotal / 1048576).toFixed(1)} MB across ${REPOS.length} repos`);
