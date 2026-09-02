// scripts/model-manifest.mjs
//
// One source of truth for which model files the shipped extension needs
// bundled, shared by the fetch step (fetch-models.mjs), the build-artifact
// check (verify/check-models.mjs), and the unit test
// (test/model_manifest_test.js). If these ever disagree, a build could
// pass its check while shipping a model the worker cannot load.
//
// The three repos are the only ones the shipped code can reach:
//   base.en        the English default (DEFAULT_MODEL)
//   tiny           the language-gate probe (multilingual)
//   base           the model a confirmed non-English switch uses, paired
//                  with the per-language wordlist packs in shared/packs/
// Non-English support is a working feature (the gate swaps to the detected
// language's curated pack), so all three are bundled for a fully offline
// package. whisper-tiny.en and whisper-small.en appear in MODEL_IDS but no
// UI can select them, so they are deliberately excluded.
//
// The file list is the fp32 variant transformers.js@4.2.0 fetches for a
// Whisper ASR pipeline with dtype 'fp32' (verified by recording a clean
// pipeline() load). fp32 weights carry no dtype suffix.

export const MODEL_REPOS = [
  'Xenova/whisper-base.en',
  'Xenova/whisper-tiny',
  'Xenova/whisper-base'
];

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
