// shared/language.js
// Plain script (NOT an ES module), loaded as an isolated-world content
// script before content.js, imported by the offscreen bundle, and
// require()d by test/language_test.js. Defines globalThis.PMLanguage.
//
// WHY THIS GATE EXISTS
// --------------------
// A field log showed the extension deciding a plainly English video was
// Korean, from a single probe, with no confirmation and no way back:
//
//   [PM-LANG] detected=ko score=13.18 model=multilingual
//             (switching subsequent windows to the multilingual model)
//
// A correct detection on comparable content scored 19.76. So the wrong
// answer was taken at two thirds the confidence of a right one, and acted
// on immediately and permanently for that video.
//
// WHAT A WRONG SWITCH ACTUALLY COSTS. Two things, and the second is the
// serious one:
//
//   1. Throughput. The switch moves transcription to the multilingual
//      model: measured computeMs went from ~4000 to as high as 13983, and
//      catch-up time from ~6s to 19.07s. In pause-until-ready that is the
//      user sitting through three times the wait.
//
//   2. PROTECTION. The detected language also swaps the active word list to
//      that language's pack. The Korean pack is 66 entries of Korean. On an
//      English video, after a ko misdetection, "fuck", "shit", "asshole"
//      and "bitch" all stop matching: verified directly against the shipped
//      pack. The filter silently stops filtering, on exactly the content it
//      was installed for, and says "Protected" while doing it.
//
// That asymmetry drives every rule here. Switching AWAY from English can
// disable protection, so it must be earned. Switching BACK to English
// restores the safe default, so it must be easy.
//
//   * A switch needs CONFIDENCE: score >= MIN_SWITCH_SCORE.
//   * A switch needs CORROBORATION: the same language, twice in a row.
//     A single probe on a single window is one opinion about a few seconds
//     of audio, and music, an accent or a quiet passage can produce a
//     confident wrong one.
//   * A revert to English needs only one observation, at a lower bar,
//     because being wrong in that direction costs a slower model at worst
//     and never costs protection.

(function (root) {
  "use strict";

  // Calibrated against the only two field scores we have: a correct
  // en=19.76 and an incorrect ko=13.18. The bar sits between them with room
  // on both sides, so the observed false positive cannot pass and a
  // genuinely non-English video scoring anywhere near the observed correct
  // range still can. Two data points is thin calibration, which is exactly
  // why the consecutive-agreement rule below carries most of the weight:
  // it does not depend on the threshold being precisely right.
  var MIN_SWITCH_SCORE = 16;

  // Reverting to English is the safe direction, so it is cheaper. It still
  // needs SOME confidence, or noise would flap the model back and forth.
  var MIN_REVERT_SCORE = 12;

  // How many consecutive agreeing observations before leaving English.
  var CONSECUTIVE_REQUIRED = 2;

  var DEFAULT_LANGUAGE = "en";

  function newState() {
    return {
      active: DEFAULT_LANGUAGE, // what the pipeline is currently using
      streakLang: null, // the language currently accumulating agreement
      streakCount: 0,
      observations: 0
    };
  }

  // decide(state, observation) -> {state, action, language, reason, score}
  //
  // action is one of:
  //   "switch"    - leave English for observation.language
  //   "revert"    - return to English
  //   "hold"      - no change (with `reason` saying why)
  //
  // The caller persists the returned state and acts only on switch/revert.
  // Every outcome, including holds, is worth recording: the field log's
  // whole problem was that a decision this consequential left one line
  // saying what it did and nothing saying why.
  function decide(state, observation) {
    var s = state && typeof state === "object" ? state : newState();
    var next = {
      active: s.active || DEFAULT_LANGUAGE,
      streakLang: s.streakLang || null,
      streakCount: s.streakCount || 0,
      observations: (s.observations || 0) + 1
    };
    var obs = observation || {};
    var lang = typeof obs.language === "string" && obs.language ? obs.language : null;
    var score = typeof obs.score === "number" && isFinite(obs.score) ? obs.score : null;

    if (!lang) {
      next.streakLang = null;
      next.streakCount = 0;
      return { state: next, action: "hold", language: next.active, reason: "no-detection", score: score };
    }

    // Back to English: the safe default, so one decent observation is
    // enough. Deliberately asymmetric with the switch path above; see the
    // header for why being wrong in this direction is cheap.
    if (lang === DEFAULT_LANGUAGE) {
      next.streakLang = null;
      next.streakCount = 0;
      if (next.active === DEFAULT_LANGUAGE) {
        return { state: next, action: "hold", language: DEFAULT_LANGUAGE, reason: "already-english", score: score };
      }
      if (score == null || score < MIN_REVERT_SCORE) {
        return { state: next, action: "hold", language: next.active, reason: "revert-low-confidence", score: score };
      }
      next.active = DEFAULT_LANGUAGE;
      return { state: next, action: "revert", language: DEFAULT_LANGUAGE, reason: "confident-english", score: score };
    }

    // A non-English candidate. Confidence first: a low-scoring guess does
    // not even get to start a streak, or two weak guesses in a row would
    // add up to a switch that neither of them earned.
    if (score == null || score < MIN_SWITCH_SCORE) {
      next.streakLang = null;
      next.streakCount = 0;
      return { state: next, action: "hold", language: next.active, reason: "low-confidence", score: score };
    }

    if (lang === next.active) {
      next.streakLang = null;
      next.streakCount = 0;
      return { state: next, action: "hold", language: next.active, reason: "already-active", score: score };
    }

    next.streakCount = next.streakLang === lang ? next.streakCount + 1 : 1;
    next.streakLang = lang;

    if (next.streakCount < CONSECUTIVE_REQUIRED) {
      return {
        state: next,
        action: "hold",
        language: next.active,
        reason: "awaiting-corroboration",
        score: score
      };
    }

    next.active = lang;
    next.streakLang = null;
    next.streakCount = 0;
    return { state: next, action: "switch", language: lang, reason: "confirmed", score: score };
  }

  // Should another probe be run? Detection is not free (it loads a separate
  // small model and shares the single worker thread), so it runs on the
  // first few windows only, and stops early once a switch is settled.
  var MAX_PROBES = 3;

  function shouldProbe(state, maxProbes) {
    var s = state || newState();
    var limit = typeof maxProbes === "number" ? maxProbes : MAX_PROBES;
    return (s.observations || 0) < limit;
  }

  var PMLanguageCore = {
    MIN_SWITCH_SCORE: MIN_SWITCH_SCORE,
    MIN_REVERT_SCORE: MIN_REVERT_SCORE,
    CONSECUTIVE_REQUIRED: CONSECUTIVE_REQUIRED,
    MAX_PROBES: MAX_PROBES,
    DEFAULT_LANGUAGE: DEFAULT_LANGUAGE,
    newState: newState,
    decide: decide,
    shouldProbe: shouldProbe
  };

  root.PMLanguage = PMLanguageCore;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMLanguageCore: PMLanguageCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
