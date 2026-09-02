// test/model_manifest_test.js
// Unit tests for the bundled-model manifest (scripts/model-manifest.mjs).
//
// Run with: node test/model_manifest_test.js  (or npm test, from extension/)
//
// The manifest is the contract between what fetch-models.mjs downloads, what
// check-models.mjs verifies, and what the worker can load offline. These
// tests pin the two properties that would silently break the offline
// promise if they drifted: that the exactly-three reachable models are
// listed and the two dead ones are not, and that the fp32 file set (no
// quantized suffix) is what the manifest names.
//
// model-manifest.mjs is an ES module; this file is CommonJS like the rest
// of the suite, so it loads it through a dynamic import inside an async
// runner.

"use strict";

const assert = require("assert");
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

test("exactly the three reachable repos are bundled", () =>
  loadManifest().then((m) => {
    assert.deepStrictEqual(m.MODEL_REPOS, [
      "Xenova/whisper-base.en",
      "Xenova/whisper-tiny",
      "Xenova/whisper-base"
    ]);
  }));

test("the dead accuracy-tier models are NOT bundled", () =>
  loadManifest().then((m) => {
    // whisper-tiny.en and whisper-small.en are in MODEL_IDS but unreachable
    // (no UI sets pm_model to them). Bundling ~200MB of weights no code can
    // load would be pure dead weight.
    assert.ok(!m.MODEL_REPOS.includes("Xenova/whisper-tiny.en"), "tiny.en excluded");
    assert.ok(!m.MODEL_REPOS.includes("Xenova/whisper-small.en"), "small.en excluded");
  }));

test("the file set is the fp32 variant, with no quantized suffix", () =>
  loadManifest().then((m) => {
    // dtype 'fp32' -> no suffix. A quantized file name slipping in here
    // would fetch weights the worker's fp32 pipeline never asks for, and
    // (worse) omit the ones it does.
    assert.ok(m.MODEL_FILES.includes("onnx/encoder_model.onnx"));
    assert.ok(m.MODEL_FILES.includes("onnx/decoder_model_merged.onnx"));
    m.MODEL_FILES.forEach((f) => {
      assert.ok(!/_quantized|_int8|_fp16|_q4/.test(f), "no quantized variant: " + f);
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
    // No duplicates.
    assert.strictEqual(new Set(paths).size, paths.length);
  }));

test("the stub threshold is large enough to catch an LFS pointer", () =>
  loadManifest().then((m) => {
    // Git LFS pointer files are ~130 bytes; a real onnx weight is tens of
    // MB. Anything in between should still be treated as broken.
    assert.ok(m.MIN_ONNX_BYTES >= 10000, "threshold " + m.MIN_ONNX_BYTES);
  }));

Promise.all(pending).then(() => {
  console.log("model_manifest_test.js: " + passed + "/" + (passed + failed) + " passed");
  if (failed) process.exit(1);
});
