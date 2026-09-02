// verify/verify-offline.mjs
//
// End-to-end proof that the extension can transcribe with NO network and
// with remote model loading hard-off. This is the pre-listing blocker's
// acceptance test: if transformers.js can load the bundled fp32 weights
// from models/ under the exact env flags the worker ships with, then the
// packaged extension does too.
//
//   node verify/verify-offline.mjs
//
// It mirrors the worker's runtime config: allowLocalModels=true,
// allowRemoteModels=false, localModelPath -> extension/models/. To make
// "no network" a fact and not just a config flag, global fetch is replaced with one
// that throws on any huggingface.co (or any http) URL, so a regression that
// reintroduces a remote fetch fails here loudly instead of silently
// phoning home in production.
//
// It runs on onnxruntime-node (device 'cpu') rather than the browser wasm
// runtime, because this harness is about MODEL FILE COMPLETENESS AND
// LOCALITY, not the wasm runtime (which build.js already copies locally and
// which the browser harness exercises). The dtype and the file set are
// identical to what ships.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';
import { MODEL_REPOS, MODEL_FILES } from '../scripts/model-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const MODELS = path.join(EXT, 'models');

let failures = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log('  ok   ' + name);
  } else {
    failures++;
    console.error('  FAIL ' + name + (extra !== undefined ? ' :: ' + extra : ''));
  }
}

// --- 1. the bundled files are all present -------------------------------
const REPOS = MODEL_REPOS;
const FILES = MODEL_FILES;
console.log('models present:');
let totalBytes = 0;
for (const repo of REPOS) {
  for (const f of FILES) {
    const p = path.join(MODELS, repo, f);
    const ok = fs.existsSync(p);
    if (ok) totalBytes += fs.statSync(p).size;
    check(repo + '/' + f, ok, ok ? undefined : 'missing - run scripts/fetch-models.mjs');
  }
}
console.log('  total models/ size: ' + (totalBytes / 1048576).toFixed(1) + ' MB');

// --- 2. no remote fetch is even reachable -------------------------------
// Replace fetch so any network attempt is an immediate, loud failure. If a
// model file were missing OR remote loading were somehow still on, the load
// below would try the network and trip this.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = typeof url === 'string' ? url : (url && url.url) || String(url);
  throw new Error('BLOCKED network fetch during offline verify: ' + u);
};

// --- 3. the worker's exact env, remote OFF ------------------------------
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.localModelPath = MODELS + path.sep;
// Do not let a stray filesystem cache satisfy a load that the packaged
// extension would satisfy from models/ - point it somewhere empty.
env.cacheDir = path.join(EXT, 'verify', '.no-such-cache');

// --- 4. a real transcription on the default English path ----------------
function readWavMono16k(p) {
  const buf = fs.readFileSync(p);
  // Minimal PCM16 mono 16k WAV reader (the test asset is exactly that).
  const dataOffset = 44;
  const samples = (buf.length - dataOffset) / 2;
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return out;
}

const wavPath = path.resolve(EXT, '..', 'spike-whisper', 'assets', 'test.wav');

async function main() {
  console.log('\noffline load + transcription (remote hard-off):');
  try {
    const transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-base.en', {
      dtype: 'fp32',
      device: 'cpu'
    });
    check('base.en loaded from models/ with allowRemoteModels=false', true);

    if (fs.existsSync(wavPath)) {
      const audio = readWavMono16k(wavPath);
      const out = await transcriber(audio, { chunk_length_s: 30 });
      const text = (out && out.text ? out.text : '').trim();
      check('base.en produced a transcript', text.length > 0, JSON.stringify(text).slice(0, 80));
      console.log('    transcript: ' + JSON.stringify(text.slice(0, 100)));
    } else {
      check('test wav present for transcription', false, wavPath);
    }
  } catch (e) {
    check('base.en offline transcription', false, e && e.message ? e.message : String(e));
  }

  // Every bundled model must load offline, including the multilingual one a
  // non-English detection switches to. The gate probes with tiny and, on a
  // confirmed non-English video, transcribes with 'multilingual'
  // (Xenova/whisper-base) and matches against that language's pack - so the
  // whole non-English path is offline only if this model is.
  for (const repo of REPOS) {
    if (repo === 'Xenova/whisper-base.en') continue; // already loaded and transcribed above
    try {
      await pipeline('automatic-speech-recognition', repo, { dtype: 'fp32', device: 'cpu' });
      check(repo + ' loaded offline', true);
    } catch (e) {
      check(repo + ' loaded offline', false, e && e.message ? e.message : String(e));
    }
  }

  // The per-language wordlist packs the non-English path matches against
  // are shipped in shared/packs/ and were already local; confirm a sample
  // is present so the non-English path is local end to end (model + pack).
  const koPack = path.join(EXT, 'shared', 'packs', 'ko.json');
  check('a language pack (ko.json) is bundled for the non-English path', fs.existsSync(koPack));

  globalThis.fetch = realFetch;
  console.log('\nverify-offline: ' + (failures === 0 ? 'PASS' : failures + ' FAILURE(S)'));
  process.exit(failures === 0 ? 0 : 1);
}

main();
