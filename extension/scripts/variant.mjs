// scripts/variant.mjs
//
// Build-time variant selector, the ONE source of truth for which build we
// are producing. Shared by the model manifest (scripts/model-manifest.mjs),
// the fetch/build/verify steps, and the store-name injection in build.js.
//
// PM_VARIANT picks the build:
//   "english"      (DEFAULT) base.en only, ~280MB. Store name "Profanity Muter".
//   "multilingual" base.en + whisper-tiny language probe + whisper-base
//                  multilingual transcriber, ~707MB. Store name
//                  "Profanity Muter (Multilingual)".
//
// Both builds come from this same codebase: the multilingual language gate
// and model routing stay in the source and are switched off at runtime for
// the english build via the generated shared/build-config.js (englishOnly).

export function getVariant() {
  const v = (process.env.PM_VARIANT || 'english').toLowerCase();
  if (v !== 'english' && v !== 'multilingual') {
    throw new Error('PM_VARIANT must be "english" or "multilingual", got: ' + JSON.stringify(process.env.PM_VARIANT));
  }
  return v;
}

export function isEnglishOnly() {
  return getVariant() === 'english';
}

export const STORE_NAME = {
  english: 'Profanity Muter',
  multilingual: 'Profanity Muter (Multilingual)'
};
