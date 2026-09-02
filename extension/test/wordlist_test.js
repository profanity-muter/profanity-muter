// test/wordlist_test.js
// Node unit tests for shared/wordlist.js's pure core, focused on the
// 0.1.29 word-list redesign: pm_strictness as a three-way LEVEL, the
// user's words as an ADDITIVE list (pm_additionalWords), and the
// migration off every legacy storage shape.
//
// Run with: node test/wordlist_test.js   (or npm test, from extension/)
//
// shared/wordlist.js is a plain script, not an ES module, and exports its
// chrome-free core via module.exports precisely so it can be require()d
// here. Nothing below touches chrome.*, the DOM, or timers.
//
// The migration matrix is the reason this file exists. Every row is a
// real storage shape a 0.1.28-or-earlier install can be sitting in, and
// the invariant being protected is that NOBODY's filtering silently gets
// weaker across the upgrade - the one outcome that would be a genuine
// product failure rather than a cosmetic one.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMWordlistCore, DEFAULT_WORDLIST } = require(
  path.join(__dirname, "..", "shared", "wordlist.js")
);

const {
  resolveSettingsFromStorage,
  tierWordlist,
  mergeWordlists,
  sanitizeAdditionalWords,
  buildStemSet,
  EN_MATCH_CONFIG,
  CORE_WORDLIST,
  EXTENDED_WORDLIST,
  STRICTNESS_MODES,
  DEFAULT_STRICTNESS
} = PMWordlistCore;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error("FAIL: " + name);
    console.error("      " + (e && e.message ? e.message : String(e)));
  }
}

// Would `entry` be caught by this word list? Routed through
// findMatchesCore rather than isProfaneCore because entries can be
// multi-word phrases ("god damn", "son of a bitch"), which isProfaneCore
// - a single-token check - cannot see by design.
function matches(list, entry) {
  const tokens = String(entry).split(/\s+/);
  const found = PMWordlistCore.findMatchesCore(
    tokens,
    buildStemSet(list, EN_MATCH_CONFIG),
    PMWordlistCore.buildPhraseIndex(list, EN_MATCH_CONFIG),
    EN_MATCH_CONFIG
  );
  return found.length > 0;
}

// ---- the level model -----------------------------------------------------

test("STRICTNESS_MODES is the three-way level, defaulting to strict", () => {
  assert.deepStrictEqual(STRICTNESS_MODES, ["none", "standard", "strict"]);
  assert.strictEqual(DEFAULT_STRICTNESS, "strict");
  // "custom" is gone as a level (it survives only as a legacy value the
  // migration understands).
  assert.strictEqual(STRICTNESS_MODES.indexOf("custom"), -1);
});

test("tierWordlist maps each level to its built-in tier", () => {
  assert.deepStrictEqual(tierWordlist("none"), []);
  assert.deepStrictEqual(tierWordlist("standard"), CORE_WORDLIST);
  assert.deepStrictEqual(tierWordlist("strict"), DEFAULT_WORDLIST);
});

test("the standard tier excludes the extended entries, the strict tier includes them", () => {
  EXTENDED_WORDLIST.forEach((w) => {
    assert.strictEqual(CORE_WORDLIST.indexOf(w), -1, w + " should not be in CORE");
    assert.notStrictEqual(DEFAULT_WORDLIST.indexOf(w), -1, w + " should be in DEFAULT");
  });
});

// ---- additive merge ------------------------------------------------------

test("mergeWordlists appends the user's words after the tier", () => {
  const merged = mergeWordlists(["alpha", "beta"], ["gamma"]);
  assert.deepStrictEqual(merged, ["alpha", "beta", "gamma"]);
});

test("mergeWordlists dedupes case-insensitively, keeping the tier's entry", () => {
  const merged = mergeWordlists(["damn"], ["Damn", "poop"]);
  assert.deepStrictEqual(merged, ["damn", "poop"]);
});

test("mergeWordlists normalizes internal whitespace and drops blanks/non-strings", () => {
  const merged = mergeWordlists([], ["  poop  ", "", "   ", null, 7, "two   words", "two words"]);
  assert.deepStrictEqual(merged, ["poop", "two words"]);
});

test("mergeWordlists tolerates non-array inputs", () => {
  assert.deepStrictEqual(mergeWordlists(null, undefined), []);
  assert.deepStrictEqual(mergeWordlists(["a"], "nope"), ["a"]);
});

test("adding a word to the strict tier grows the list by exactly one", () => {
  const merged = mergeWordlists(tierWordlist("strict"), ["fnord"]);
  assert.strictEqual(merged.length, DEFAULT_WORDLIST.length + 1);
  assert.ok(matches(merged, "fnord"));
  assert.ok(matches(merged, "shit"), "built-ins must still match");
});

test("re-adding a word the tier already has does not double-count it", () => {
  const merged = mergeWordlists(tierWordlist("strict"), ["Shit"]);
  assert.strictEqual(merged.length, DEFAULT_WORDLIST.length);
});

test("level none + own words matches only the user's words", () => {
  const merged = mergeWordlists(tierWordlist("none"), ["fnord"]);
  assert.deepStrictEqual(merged, ["fnord"]);
  assert.ok(matches(merged, "fnord"));
  assert.ok(!matches(merged, "shit"), "no built-in tier means no built-in matches");
});

test("standard + a re-added extended word gets that one back without the rest", () => {
  // The EXTENDED tier interaction that matters in practice: a parent who
  // wants "clear profanity, plus 'gosh'" but not the whole euphemism tier.
  const merged = mergeWordlists(tierWordlist("standard"), ["gosh"]);
  assert.strictEqual(merged.length, CORE_WORDLIST.length + 1);
  assert.ok(matches(merged, "gosh"));
  assert.ok(!matches(merged, "heck"), "the rest of the extended tier stays off");
  assert.ok(matches(merged, "shit"), "the core tier is still on");
});

test("sanitizeAdditionalWords cleans a raw stored value", () => {
  assert.deepStrictEqual(
    sanitizeAdditionalWords(["  Poop ", "", 5, null, "poop", "a  b"]),
    ["Poop", "a b"]
  );
  assert.deepStrictEqual(sanitizeAdditionalWords("not an array"), []);
  assert.deepStrictEqual(sanitizeAdditionalWords(undefined), []);
});

// ---- migration matrix ----------------------------------------------------
//
// Each row: [description, stored items, expected level, expected additional
// words, expected effective list]. `EFFECTIVE` is spelled out per row
// rather than derived, so a change to the merge rules can't quietly
// rewrite the expectations too.

const MIGRATIONS = [
  [
    "fresh install (nothing saved)",
    {},
    "strict", [], DEFAULT_WORDLIST
  ],
  [
    "explicit strict",
    { pm_strictness: "strict" },
    "strict", [], DEFAULT_WORDLIST
  ],
  [
    "explicit standard",
    { pm_strictness: "standard" },
    "standard", [], CORE_WORDLIST
  ],
  [
    "explicit none (new level)",
    { pm_strictness: "none" },
    "none", [], []
  ],
  [
    "legacy custom + saved list -> none + that list (identical filtering)",
    { pm_strictness: "custom", pm_wordlist: ["alpha", "beta"] },
    "none", ["alpha", "beta"], ["alpha", "beta"]
  ],
  [
    "legacy custom + deliberately EMPTY saved list -> none + nothing",
    { pm_strictness: "custom", pm_wordlist: [] },
    "none", [], []
  ],
  [
    "legacy custom with NO saved list -> strict (preserves the old safety net)",
    { pm_strictness: "custom" },
    "strict", [], DEFAULT_WORDLIST
  ],
  [
    "standard with an untouched legacy pm_wordlist -> level kept, list still ignored",
    { pm_strictness: "standard", pm_wordlist: ["alpha"] },
    "standard", [], CORE_WORDLIST
  ],
  [
    "strict with an untouched legacy pm_wordlist -> level kept, list still ignored",
    { pm_strictness: "strict", pm_wordlist: ["alpha"] },
    "strict", [], DEFAULT_WORDLIST
  ],
  [
    "pre-strictness schema (saved list, no level) -> none + that list",
    { pm_wordlist: ["alpha", "beta"] },
    "none", ["alpha", "beta"], ["alpha", "beta"]
  ],
  [
    "pre-strictness schema with an empty saved list -> none + nothing",
    { pm_wordlist: [] },
    "none", [], []
  ],
  [
    "corrupted level, no saved list -> default strict",
    { pm_strictness: "bogus" },
    "strict", [], DEFAULT_WORDLIST
  ],
  [
    "corrupted level with a saved list -> treated as the pre-strictness schema",
    { pm_strictness: "bogus", pm_wordlist: ["alpha"] },
    "none", ["alpha"], ["alpha"]
  ],
  [
    "already migrated: additionalWords + a level",
    { pm_strictness: "standard", pm_additionalWords: ["alpha"] },
    "standard", ["alpha"], CORE_WORDLIST.concat(["alpha"])
  ],
  [
    "already migrated: additionalWords with no level -> default strict",
    { pm_additionalWords: ["alpha"] },
    "strict", ["alpha"], DEFAULT_WORDLIST.concat(["alpha"])
  ],
  [
    "half-migrated: additionalWords alongside a stale legacy 'custom' -> none",
    { pm_strictness: "custom", pm_additionalWords: ["alpha"] },
    "none", ["alpha"], ["alpha"]
  ],
  [
    "additionalWords wins outright over a leftover pm_wordlist",
    { pm_additionalWords: ["new"], pm_wordlist: ["old"] },
    "strict", ["new"], DEFAULT_WORDLIST.concat(["new"])
  ],
  [
    "additionalWords is sanitized on read",
    { pm_strictness: "none", pm_additionalWords: ["  Poop ", "", 5, "poop"] },
    "none", ["Poop"], ["Poop"]
  ]
];

MIGRATIONS.forEach(function (row) {
  const [name, items, level, additional, effective] = row;
  test("migration: " + name, () => {
    const r = resolveSettingsFromStorage(items);
    assert.strictEqual(r.strictness, level, "level");
    assert.deepStrictEqual(r.additionalWords, additional, "additionalWords");
    assert.deepStrictEqual(r.wordlist, effective, "effective wordlist");
  });
});

test("migration never leaves a pre-0.1.29 install filtering LESS than before", () => {
  // The invariant behind the matrix, checked directly: for every legacy
  // shape, every word that used to match still matches.
  const legacyShapes = [
    [{}, DEFAULT_WORDLIST],
    [{ pm_strictness: "strict" }, DEFAULT_WORDLIST],
    [{ pm_strictness: "standard" }, CORE_WORDLIST],
    [{ pm_strictness: "custom", pm_wordlist: ["alpha", "beta"] }, ["alpha", "beta"]],
    [{ pm_strictness: "custom" }, DEFAULT_WORDLIST], // old safety-net fallback
    [{ pm_wordlist: ["alpha"] }, ["alpha"]],
    [{ pm_strictness: "standard", pm_wordlist: ["ignored"] }, CORE_WORDLIST]
  ];
  legacyShapes.forEach(function (pair) {
    const [items, oldEffectiveList] = pair;
    const now = resolveSettingsFromStorage(items).wordlist;
    oldEffectiveList.forEach(function (word) {
      assert.ok(
        matches(now, word),
        JSON.stringify(items) + ' used to match "' + word + '" and must still'
      );
    });
  });
});

test("resolve leaves pm_wordlist untouched (it is read-only from 0.1.29 on)", () => {
  const items = { pm_strictness: "custom", pm_wordlist: ["alpha"] };
  resolveSettingsFromStorage(items);
  assert.deepStrictEqual(items.pm_wordlist, ["alpha"]);
  assert.strictEqual("pm_additionalWords" in items, false, "resolve must not write back");
});

test("STORAGE_KEYS covers pm_additionalWords (so refresh() actually reads it)", () => {
  assert.notStrictEqual(PMWordlistCore.STORAGE_KEYS.indexOf("pm_additionalWords"), -1);
  assert.notStrictEqual(PMWordlistCore.STORAGE_KEYS.indexOf("pm_wordlist"), -1);
});

test("unrelated settings still resolve alongside the new keys", () => {
  const r = resolveSettingsFromStorage({
    pm_additionalWords: ["alpha"],
    pm_strictness: "none",
    pm_catchupMode: "play",
    pm_padding: "wide",
    pm_enabled: false,
    pm_multilingual: false
  });
  assert.strictEqual(r.catchupMode, "play");
  assert.strictEqual(r.safeMode, false);
  assert.strictEqual(r.padding, "wide");
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.multilingual, false);
  assert.deepStrictEqual(r.wordlist, ["alpha"]);
});

// ---- summary -------------------------------------------------------------

console.log("wordlist_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
