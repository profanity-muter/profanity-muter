// verify/check-models.mjs
//
// Fast build-artifact gate: every bundled model file is present and no ONNX
// weight is a stub. Runs no inference, so it is cheap enough to sit in the
// verify step; verify-offline.mjs is the slower proof that they actually
// load and transcribe with the network off.
//
//   node verify/check-models.mjs
//
// Exit non-zero if the packaged extension would ship an incomplete models/
// directory, which under allowRemoteModels=false means a video that cannot
// be transcribed at all.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_REPOS, MODEL_FILES, MIN_ONNX_BYTES } from '../scripts/model-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS = path.join(__dirname, '..', 'models');

let failures = 0;
let totalBytes = 0;

for (const repo of MODEL_REPOS) {
  for (const file of MODEL_FILES) {
    const p = path.join(MODELS, repo, file);
    if (!fs.existsSync(p)) {
      console.error('  MISSING ' + repo + '/' + file);
      failures++;
      continue;
    }
    const size = fs.statSync(p).size;
    totalBytes += size;
    if (file.endsWith('.onnx') && size < MIN_ONNX_BYTES) {
      console.error('  STUB    ' + repo + '/' + file + ' (' + size + ' bytes)');
      failures++;
    }
  }
}

console.log('check-models: ' + (totalBytes / 1048576).toFixed(1) + ' MB across ' + MODEL_REPOS.length + ' repos');
if (failures) {
  console.error('check-models: ' + failures + ' problem(s) - run scripts/fetch-models.mjs');
  process.exit(1);
}
console.log('check-models: all bundled model files present');
