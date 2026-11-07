// Scans every file the store zip ships for remote code/model hosts. CWS
// rejected 0.1.59 (Blue Argon) over a dead CDN default string in a library.
// Used by test/no_remote_code_test.js and scripts/make-zip.mjs.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INCLUDE = [
  'manifest.json', 'background.js', 'captions.js', 'capture.js', 'content.js',
  'offscreen.html', 'shared', 'dist', 'models', 'icons', 'popup', 'report', 'onboarding',
];
const BAD = [
  /(?:jsdelivr|unpkg|cdnjs|esm\.sh|skypack)\.(?:net|com|org|dev|io|cloudflare\.com)/i,
  /cdn\.jsdelivr|cdnjs\.cloudflare|esm\.sh\/|cdn\.skypack/i,
  /https?:\/\/(?:www\.)?(?:huggingface|hf)\.co/i,
  /raw\.githubusercontent/i,
  /https?:\/\/[^\s"'`)]*\.(?:m?js|wasm)(?=[\s"'`)?#;,]|$)/i,
];
const SKIP_EXT = /\.(png|jpe?g|gif|ico|webp|onnx|ttf|woff2?)$/i;

function* walk(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) { yield p; return; }
  for (const f of fs.readdirSync(p)) if (!f.startsWith('.')) yield* walk(path.join(p, f));
}

// Returns [{file, snippet}]; empty means clean.
function scan() {
  const hits = [];
  for (const entry of INCLUDE) {
    for (const file of walk(path.join(ROOT, entry))) {
      if (SKIP_EXT.test(file)) continue;
      const text = fs.readFileSync(file, 'latin1');
      for (const re of BAD) {
        const m = re.exec(text);
        if (m) hits.push({ file: path.relative(ROOT, file), snippet: text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, ' ') });
      }
    }
  }
  return hits;
}

module.exports = { INCLUDE, scan };
