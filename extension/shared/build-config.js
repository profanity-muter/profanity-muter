// shared/build-config.js
//
// GENERATED at build time by build.js from PM_VARIANT. Do not hand-edit: a
// build overwrites it. The committed copy is the english default so the
// repo always has a valid runtime config even before a build runs and so a
// plain english build produces no diff here.
//
// This is imported (and inlined) into the offscreen bundle and the whisper
// worker by esbuild, so the runtime learns its variant with zero storage
// reads or message round-trips. When englishOnly is true the language gate
// and multilingual model routing are switched off: every window transcribes
// as English with base.en and neither whisper-tiny nor whisper-base is ever
// loaded. When false, the full 0.1.25 multilingual behavior is active.
export const BUILD_CONFIG = { englishOnly: true };
