#!/usr/bin/env node
// Build the Chrome Web Store upload: profanity-muter-<version>.zip next to
// the repo, containing only what the installed extension needs.
//
//   npm run package && node scripts/make-zip.mjs
//
// Ships: manifest, the content/background scripts, shared/, dist/ (bundles +
// ORT wasm), models/ (fetched by scripts/fetch-models.mjs), icons, popup,
// report, onboarding, offscreen.html. Leaves out sources, tests, tooling,
// notes, node_modules. Refuses to run if models/ is missing, since a zip
// without the model is the 0.1.43 store incident again.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const OUT = path.resolve(ROOT, '..', `profanity-muter-${manifest.version}.zip`);

const INCLUDE = [
  'manifest.json', 'background.js', 'captions.js', 'capture.js', 'content.js',
  'offscreen.html', 'shared', 'dist', 'models', 'icons', 'popup', 'report', 'onboarding',
];

for (const entry of INCLUDE) {
  if (!fs.existsSync(path.join(ROOT, entry))) {
    console.error(`missing ${entry}. Run "npm run package" first.`);
    process.exit(1);
  }
}
const modelFiles = fs.readdirSync(path.join(ROOT, 'models'));
if (!modelFiles.length) {
  console.error('models/ is empty. Run "npm run package" first.');
  process.exit(1);
}

if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
execFileSync('zip', ['-qr', '-X', OUT, ...INCLUDE, '-x', '*.DS_Store', '-x', '*/.*'], { cwd: ROOT, stdio: 'inherit' });

const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`wrote ${OUT} (${mb} MB, manifest version ${manifest.version})`);
