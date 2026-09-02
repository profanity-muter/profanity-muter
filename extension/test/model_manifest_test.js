// test/model_manifest_test.js
// Unit tests for the bundled-model manifest (scripts/model-manifest.mjs).
//
// Run with: node test/model_manifest_test.js  (or npm test, from extension/)
//
// The manifest is the contract between what fetch-models.mjs downloads, what
// check-models.mjs verifies, and what the worker can load offline. 0.1.46
// made it VARIANT-aware (PM_VARIANT, see scripts/variant.mjs): both the
// english (~280MB, base.en only) and multilingual (~707MB, three repos)
// builds come from this one codebase, so these tests pin the model set for
// BOTH variants plus the fp32 file-set property that is variant-independent.
//
// model-manifest.mjs reads PM_VARIANT at evaluation time, so each variant is
// loaded through a fresh dynamic import with a cache-busting query after
// setting the env var. Because dynamic-import evaluation is deferred, the
// tests run STRICTLY SEQUENTIALLY (await each import before touching the env
// again), so no two variants ever race on process.env. This file is
// CommonJS like the rest of the suite.

"use strict";

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    console.error("FAIL: " + name);
    console.error("      " + (e && e.message ? e.message : String(e)));
  }
}

const MANIFEST_URL = pathToFileURL(
  path.join(__dirname, "..", "scripts", "model-manifest.mjs")
).href;

// Load the manifest as it evaluates under a given PM_VARIANT. The query
// string busts the ESM module cache so the top-level variant check re-runs.
// Callers MUST await this before mutating the env again.
let bust = 0;
function loadManifest(variant) {
  if (variant === undefined) delete process.env.PM_VARIANT;
  else process.env.PM_VARIANT = variant;
  return import(MANIFEST_URL + "?v=" + String(variant) + "-" + bust++);
}

async function main() {
  await test("english variant bundles ONLY base.en", async () => {
    const m = await loadManifest("english");
    assert.deepStrictEqual(m.MODEL_REPOS, ["Xenova/whisper-base.en"]);
  });

  await test("english variant never references the multilingual repos (tiny/base)", async () => {
    // The whole point of the ~280MB build: no whisper-tiny probe and no
    // whisper-base multilingual transcriber are bundled or loadable.
    const m = await loadManifest("english");
    assert.ok(!m.MODEL_REPOS.includes("Xenova/whisper-tiny"), "tiny excluded");
    assert.ok(!m.MODEL_REPOS.includes("Xenova/whisper-base"), "base excluded");
  });

  await test("multilingual variant bundles the three reachable repos", async () => {
    const m = await loadManifest("multilingual");
    assert.deepStrictEqual(m.MODEL_REPOS, [
      "Xenova/whisper-base.en",
      "Xenova/whisper-tiny",
      "Xenova/whisper-base"
    ]);
  });

  await test("neither variant bundles the dead accuracy-tier models", async () => {
    // whisper-tiny.en and whisper-small.en are in MODEL_IDS but unreachable
    // (no UI sets pm_model to them) in both builds.
    const e = await loadManifest("english");
    const ml = await loadManifest("multilingual");
    for (const m of [e, ml]) {
      assert.ok(!m.MODEL_REPOS.includes("Xenova/whisper-tiny.en"), "tiny.en excluded");
      assert.ok(!m.MODEL_REPOS.includes("Xenova/whisper-small.en"), "small.en excluded");
    }
  });

  await test("the default variant (no PM_VARIANT) is english", async () => {
    const m = await loadManifest(undefined);
    assert.deepStrictEqual(m.MODEL_REPOS, ["Xenova/whisper-base.en"]);
  });

  await test("the file set is the fp32 variant, with no quantized suffix", async () => {
    // dtype 'fp32' -> no suffix. A quantized file name slipping in here
    // would fetch weights the worker's fp32 pipeline never asks for, and
    // (worse) omit the ones it does. This is a shipping build, so no
    // compare-only fp16/q8 files either.
    const m = await loadManifest("english");
    assert.ok(m.MODEL_FILES.includes("onnx/encoder_model.onnx"));
    assert.ok(m.MODEL_FILES.includes("onnx/decoder_model_merged.onnx"));
    m.MODEL_FILES.forEach((f) => {
      assert.ok(!/_quantized|_int8|_fp16|_q4|_q8/.test(f), "no quantized variant: " + f);
    });
  });

  await test("the config and tokenizer files a Whisper pipeline needs are listed", async () => {
    const m = await loadManifest("english");
    ["config.json", "tokenizer.json", "tokenizer_config.json",
     "generation_config.json", "preprocessor_config.json"].forEach((f) => {
      assert.ok(m.MODEL_FILES.includes(f), "missing " + f);
    });
  });

  await test("expectedModelPaths is the full repo x file cross product", async () => {
    const m = await loadManifest("multilingual");
    const paths = m.expectedModelPaths();
    assert.strictEqual(paths.length, m.MODEL_REPOS.length * m.MODEL_FILES.length);
    assert.ok(paths.includes("Xenova/whisper-base.en/onnx/decoder_model_merged.onnx"));
    assert.strictEqual(new Set(paths).size, paths.length);
  });

  await test("the stub threshold is large enough to catch an LFS pointer", async () => {
    // Git LFS pointer files are ~130 bytes; a real onnx weight is tens of
    // MB. Anything in between should still be treated as broken.
    const m = await loadManifest("english");
    assert.ok(m.MIN_ONNX_BYTES >= 10000, "threshold " + m.MIN_ONNX_BYTES);
  });

  console.log("model_manifest_test.js: " + passed + "/" + (passed + failed) + " passed");
  if (failed) process.exit(1);
}

main();
