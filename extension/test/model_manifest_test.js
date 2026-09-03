// test/model_manifest_test.js
// Unit tests for the bundled-model manifest (scripts/model-manifest.mjs).
//
// Run with: node test/model_manifest_test.js  (or npm test, from extension/)
//
// The manifest is the contract between what fetch-models.mjs downloads, what
// check-models.mjs verifies, and what the worker can load offline. 0.1.46 is
// English-only: base.en is the ONLY model shipped or loaded (the 0.1.25
// multilingual path moved to a separate repo). These tests pin that single
// model set, the fp32 file set, and - by scanning the worker and offscreen
// source directly - that the runtime MODEL_IDS reference base.en and nothing
// else (no whisper-base, whisper-tiny, or whisper-small).
//
// model-manifest.mjs is an ES module; this file is CommonJS like the rest of
// the suite, so it loads it through a dynamic import inside an async runner.

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      pending.push(
        r.then(
          () => { passed++; },
          (e) => {
            failed++;
            console.error("FAIL: " + name);
            console.error("      " + (e && e.message ? e.message : String(e)));
          }
        )
      );
      return;
    }
    passed++;
  } catch (e) {
    failed++;
    console.error("FAIL: " + name);
    console.error("      " + (e && e.message ? e.message : String(e)));
  }
}

function loadManifest() {
  return import(path.join(__dirname, "..", "scripts", "model-manifest.mjs"));
}

const FORBIDDEN_REPOS = [
  "Xenova/whisper-base",   // the 0.1.25 multilingual transcriber
  "Xenova/whisper-tiny",   // the 0.1.25 language-detect probe
  "Xenova/whisper-tiny.en",
  "Xenova/whisper-small.en"
];

test("only base.en is bundled", () =>
  loadManifest().then((m) => {
    assert.deepStrictEqual(m.MODEL_REPOS, ["Xenova/whisper-base.en"]);
  }));

test("no multilingual or accuracy-tier repo is bundled", () =>
  loadManifest().then((m) => {
    FORBIDDEN_REPOS.forEach((repo) => {
      assert.ok(!m.MODEL_REPOS.includes(repo), repo + " must not be bundled");
    });
  }));

test("the file set is the fp32 variant, with no quantized suffix", () =>
  loadManifest().then((m) => {
    // dtype 'fp32' -> no suffix. A quantized file name slipping in here
    // would fetch weights the worker's fp32 pipeline never asks for, and
    // (worse) omit the ones it does. Shipping build: no compare-only files.
    assert.ok(m.MODEL_FILES.includes("onnx/encoder_model.onnx"));
    assert.ok(m.MODEL_FILES.includes("onnx/decoder_model_merged.onnx"));
    m.MODEL_FILES.forEach((f) => {
      assert.ok(!/_quantized|_int8|_fp16|_q4|_q8/.test(f), "no quantized variant: " + f);
    });
  }));

test("the config and tokenizer files a Whisper pipeline needs are listed", () =>
  loadManifest().then((m) => {
    ["config.json", "tokenizer.json", "tokenizer_config.json",
     "generation_config.json", "preprocessor_config.json"].forEach((f) => {
      assert.ok(m.MODEL_FILES.includes(f), "missing " + f);
    });
  }));

test("expectedModelPaths is the full repo x file cross product", () =>
  loadManifest().then((m) => {
    const paths = m.expectedModelPaths();
    assert.strictEqual(paths.length, m.MODEL_REPOS.length * m.MODEL_FILES.length);
    assert.ok(paths.includes("Xenova/whisper-base.en/onnx/decoder_model_merged.onnx"));
    assert.strictEqual(new Set(paths).size, paths.length);
  }));

test("the stub threshold is large enough to catch an LFS pointer", () =>
  loadManifest().then((m) => {
    // Git LFS pointer files are ~130 bytes; a real onnx weight is tens of
    // MB. Anything in between should still be treated as broken.
    assert.ok(m.MIN_ONNX_BYTES >= 10000, "threshold " + m.MIN_ONNX_BYTES);
  }));

// ---- runtime MODEL_IDS reference only base.en ----------------------------
// The worker and offscreen carry their own MODEL_IDS lookup. A regression
// that reintroduced a multilingual id here would ask for a model that is not
// bundled, so scan the shipped source directly.
["src/whisper-worker-src.js", "src/offscreen-src.js"].forEach((rel) => {
  test(rel + " MODEL_IDS references only base.en", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    assert.ok(src.includes("Xenova/whisper-base.en"), rel + " must load base.en");
    FORBIDDEN_REPOS.forEach((repo) => {
      // Word-boundary-ish check: whisper-base.en must not trip the
      // whisper-base match, so require the id NOT be followed by ".en".
      const re = new RegExp(repo.replace(/[.]/g, "\\.") + "(?![\\w.])", "");
      assert.ok(!re.test(src), rel + " must not reference " + repo);
    });
  });
});

Promise.all(pending).then(() => {
  console.log("model_manifest_test.js: " + passed + "/" + (passed + failed) + " passed");
  if (failed) process.exit(1);
});
