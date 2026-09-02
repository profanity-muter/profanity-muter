// shared/build-config.global.js
//
// GENERATED at build time by build.js from PM_VARIANT. Do not hand-edit: a
// build overwrites it. The committed copy is the english default.
//
// This is the CLASSIC-SCRIPT form of shared/build-config.js, for pages that
// load plain <script> tags and cannot import the ESM module (the popup, and
// the content-script world). It attaches globalThis.PM_BUILD_CONFIG so those
// scripts can read the build variant. When englishOnly is true the popup
// hides the multilingual-only affordances (the "Filter other languages"
// toggle and the detected-language note), which are inert in that build.
globalThis.PM_BUILD_CONFIG = { englishOnly: true };
