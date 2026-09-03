// scripts/model-manifest.mjs
//
// One source of truth for which model files the shipped extension needs
// bundled, shared by the fetch step (fetch-models.mjs), the build-artifact
// check (verify/check-models.mjs), and the unit test
// (test/model_manifest_test.js). If these ever disagree, a build could
// pass its check while shipping a model the worker cannot load.
//
// 0.1.46 (English-only): the shipped extension loads exactly one model,
// base.en, the English transcriber, ~280MB. The 0.1.25 multilingual path (a
// whisper-tiny language probe plus a whisper-base multilingual transcriber)
// was removed and now lives in a separate multilingual repo. whisper-tiny.en
// and whisper-small.en never had a UI to select them, so they are excluded
// too.
//
// The file list is the fp32 variant transformers.js@4.2.0 fetches for a
// Whisper ASR pipeline with dtype 'fp32' (verified by recording a clean
// pipeline() load). fp32 weights carry no dtype suffix. This is a shipping
// build, so only the fp32 weights are bundled (no compare-only fp16/q8).

export const MODEL_REPOS = ['Xenova/whisper-base.en'];

export const MODEL_FILES = [
  'config.json',
  'tokenizer_config.json',
  'tokenizer.json',
  'generation_config.json',
  'preprocessor_config.json',
  'onnx/encoder_model.onnx',
  'onnx/decoder_model_merged.onnx'
];

// An ONNX weight smaller than this is almost certainly an LFS pointer or an
// error page, not a real model. Used to reject a broken download or a
// half-populated models/ dir.
export const MIN_ONNX_BYTES = 100000;

// Every (repo, file) pair that must exist under models/.
export function expectedModelPaths() {
  const out = [];
  for (const repo of MODEL_REPOS) {
    for (const file of MODEL_FILES) out.push(repo + '/' + file);
  }
  return out;
}
