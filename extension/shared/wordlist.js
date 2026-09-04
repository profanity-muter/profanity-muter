// shared/wordlist.js
// Plain script (NOT an ES module) - loaded as the first isolated-world
// content script, before captions.js. Defines globalThis.PMWordlist.
//
// Storage schema (chrome.storage.sync):
//   pm_enabled        boolean   default true  - master on/off
//   pm_additionalWords string[] default unset -> [] - the user's OWN
//                                words, ADDED ON TOP of the built-in tier
//                                selected by pm_strictness. This is the
//                                only word-list key the popup writes as
//                                of 0.1.29, and the only one whose
//                                contents are ever displayed in the UI.
//                                The built-in lists' contents are never
//                                shown anywhere. See "pm_strictness
//                                (LEVEL) + pm_additionalWords (ADDITIVE)"
//                                in resolveSettingsFromStorage for the
//                                full migration table off the old schema.
//   pm_wordlist       string[]  DEPRECATED as of 0.1.29, read-only
//                                (migration path). Under the old schema
//                                this was the user's REPLACEMENT list,
//                                active only while pm_strictness was
//                                "custom". It is now only read to migrate
//                                a pre-0.1.29 install onto
//                                pm_additionalWords, and is deliberately
//                                left untouched in storage afterwards so
//                                a rollback finds it intact. Once
//                                pm_additionalWords has been saved, this
//                                key is never an active source again.
//   pm_muteAudio      boolean   default true  - audio-pipeline toggle
//   pm_censorCaptions boolean   default true  - caption-censoring toggle
//   pm_catchupMode    "mute" | "pause" | "play"  default "play" - the
//                                ONE setting for what happens in parts
//                                of the video not yet analyzed:
//                                  "mute"  - mute audio until caught up
//                                  "pause" - pause playback (full
//                                            protection: nothing
//                                            unanalyzed ever plays)
//                                  "play"  - let it play unanalyzed
//                                            (old "safe mode off")
//                                Any other/invalid stored value
//                                defaults to "play". The popup no
//                                longer writes pm_safeMode at all -
//                                this single setting replaced it.
//   pm_safeMode       boolean   DEPRECATED, read-only (migration path).
//                                No longer written by the popup. Only
//                                consulted when pm_catchupMode has
//                                never been saved: a legacy
//                                `pm_safeMode === false` migrates to
//                                `pm_catchupMode: "play"` (preserving
//                                the user's old choice) instead of the
//                                "mute" default. See
//                                resolveSettingsFromStorage.
//   pm_debugOverlay   boolean   default false - shows an on-player
//                                diagnostic overlay (consumed by the
//                                audio pipeline's content.js, not by
//                                this file) with live analysis status.
//   pm_showStatus     boolean   default true - shows an on-player
//                                status pill (consumed by the audio
//                                pipeline's content.js, not by this
//                                file). Distinct from pm_debugOverlay:
//                                this is a lightweight always-on-by-
//                                default status indicator, not the
//                                opt-in diagnostic overlay.
//   pm_strictness     "none" | "standard" | "strict"  default "strict".
//                                The LEVEL: how much of the BUILT-IN list
//                                is switched on.
//                                  "none"     -> no built-in words at all
//                                  "standard" -> CORE_WORDLIST only
//                                  "strict"   -> DEFAULT_WORDLIST (CORE
//                                                + EXTENDED euphemisms/
//                                                mishears/religious
//                                                exclamations)
//                                The active list is ALWAYS this tier PLUS
//                                pm_additionalWords, deduped - the user's
//                                words are additive, never a replacement
//                                (0.1.29 redesign; before that, a third
//                                mode "custom" replaced the built-ins with
//                                pm_wordlist, which both required showing
//                                the built-in contents in the UI to edit
//                                them and froze the user out of future
//                                list updates).
//                                "custom" is NO LONGER a valid level; it
//                                is still understood as a legacy stored
//                                value and migrated (see the full
//                                migration table in
//                                resolveSettingsFromStorage - including
//                                why legacy "custom" with no saved list
//                                migrates to "strict", not "none").
//   pm_onboarded      boolean  default false - the onboarding tab has been
//                                AUTO-OPENED once (set by background.js on
//                                a genuine install). NOT the same as
//                                "finished onboarding" - see
//                                pm_ackNotPerfect.
//   pm_ackNotPerfect  {version, timestamp} | absent - the user explicitly
//                                acknowledged that this extension will not
//                                catch every word. Gates the popup's
//                                "Finish setup" banner (shown until it
//                                exists) and its share row (shown only
//                                once it does).
//   pm_installedAt    number (epoch ms) | absent - install time, stamped
//                                once by background.js. Gates the review
//                                prompt's 7-day rule.
//   pm_reviewPrompt   {shownAt, dismissed} | absent - the review prompt
//                                has been shown. Its existence alone
//                                means it is never shown again.
//                                pm_onboarded/pm_ackNotPerfect/
//                                pm_installedAt/pm_reviewPrompt are all
//                                owned by shared/moments.js plus the popup
//                                and onboarding pages - deliberately NOT
//                                in this file's STORAGE_KEYS and NOT part
//                                of the PMWordlist.settings contract:
//                                nothing in the matching path or the
//                                content scripts consults any of them.
//                                Note there is likewise NO storage key for
//                                the 0.1.32 health monitor: health is
//                                per-tab, per-video and transient, so the
//                                popup asks the active tab's content
//                                script directly rather than reading a
//                                value that a second tab could clobber or
//                                that could outlive what it describes.
//                                The durable record is the `health` array
//                                in each pm_devlog entry. See
//                                shared/health.js and CENSOR_NOTES.md.
//                                Note there is NO storage key for problem
//                                reports (0.1.31's "Report a problem"):
//                                a report is assembled in memory, put on
//                                the clipboard and handed to the user's
//                                mail client. Nothing about it is
//                                persisted, and nothing is transmitted by
//                                the extension itself.
//   (0.1.34 adds no new storage keys: the promise ledger is per-session
//   in-memory state on the content script, and the health verdict it
//   produces is recorded in pm_devlog through the existing health array.)
//   pm_milestoneShown {shownAt} | absent - one-shot latch for the
//                                on-player milestone pill ("N videos
//                                protected"), shown once ever. Owned by
//                                shared/moments.js + background.js.
//   pm_lock           {salt: string, hash: string} | absent - the
//                                optional PARENTAL LOCK (0.1.29). When
//                                present, the popup opens with every
//                                setting disabled until the password is
//                                entered; unlock lasts for that popup
//                                session only. Owned entirely by
//                                shared/lock.js and popup/popup.js, which
//                                read/write it directly - deliberately
//                                NOT in this file's STORAGE_KEYS and NOT
//                                part of the PMWordlist.settings contract,
//                                since nothing in the matching path or
//                                the content scripts consults it. hash is
//                                SHA-256(salt + password), hex; the
//                                plaintext password is never stored. It
//                                is a deterrent, not security - see
//                                shared/lock.js's header.
//   pm_devlogVerbose  boolean  default false - when true, the persistent
//                                dev log (shared/devlog.js, key pm_devlog
//                                in chrome.storage.LOCAL) also stores each
//                                analyzed window's FULL transcript text,
//                                not just its matched words. Off by
//                                default for privacy (a verbatim
//                                transcript of everything watched) and
//                                size (transcripts dominate the log's
//                                256KB budget). Owned entirely by
//                                shared/devlog.js, which reads it
//                                directly - it is deliberately NOT in
//                                this file's STORAGE_KEYS and NOT part of
//                                the PMWordlist.settings contract: it is
//                                a debugging escape hatch with no popup
//                                UI, set from the extension console with
//                                chrome.storage.sync.set({pm_devlogVerbose:
//                                true}), not a user-facing setting.
//   pm_padding        "tight" | "normal" | "wide"  default "normal" -
//                                how much surrounding audio the mute
//                                interval pads around a matched word.
//                                Consumed entirely by the audio
//                                pipeline's content.js for its interval
//                                math; this file only stores/validates/
//                                exposes the setting.
//
// chrome.storage.LOCAL (separate area, not synced - see popup/popup.js):
//   pm_stats   {totalMuted: number, videosProtected: number}  written by
//              the audio pipeline; may be absent (popup shows zeros).
//              Not read or written by this file.
//   pm_devlog  {version: 1, videos: Entry[]}  the persistent dev log -
//              a ring buffer of the last 10 videos watched (analyzed
//              windows + their matched words, padded mute intervals,
//              unanalyzed-playback gaps, caption censor events, errors),
//              capped at ~256KB serialized. Written by shared/devlog.js
//              from content.js/captions.js; read by the popup's "Copy
//              debug log" button. Not read or written by this file - see
//              shared/devlog.js's header for the full Entry schema and
//              the reasoning behind what it does and doesn't store (it
//              never stores the word list, and only stores transcripts
//              when pm_devlogVerbose is on).
//
// This file is written so the pure matching logic works with zero
// dependency on chrome.* - see PMWordlistCore below - so it can be
// required/loaded directly under Node for unit tests. The chrome.storage
// wiring is all guarded so a page/context without chrome.* never throws.

(function (root) {
  "use strict";

  // Curated default list. Real, editable content (not a placeholder) -
  // the popup loads this verbatim into its textarea the first time
  // pm_wordlist has never been saved. Alphabetized. Deliberately
  // excludes a handful of common-word-derivative entries (e.g.
  // "tosser"/"beaner"/"cracker") whose suffix-stemmed roots collide
  // with ordinary English words ("toss"/"bean"/"crack[er]") - see
  // CENSOR_NOTES.md "Default list & known collisions" for the full
  // rationale and the accepted collisions we kept anyway (e.g. "ass",
  // "hell", "chink", "dyke", "tranny", "retard" also have innocuous
  // senses; over-censoring beats under-censoring for this product).
  var DEFAULT_WORDLIST = [
    "anal", "anus", "arse", "arsehole", "ass", "assface", "asshat",
    "asshead", "asshole", "asswipe", "ballsack", "bastard", "biatch",
    "bitch", "bloody", "blowjob", "bollocks", "boob", "boobs", "bugger",
    "bullshit", "camwhore", "chickenshit", "chink", "clusterfuck", "cock",
    "cocksucker", "crap", "crappy", "cum", "cumming", "cumshot", "cunnilingus", "cunt",
    "dammit", "damn", "dang", "deepthroat", "dick", "dickhead", "dickwad",
    "dickweed", "dildo", "dipshit", "douche", "douchebag", "dumbass",
    "dumbfuck", "dyke", "effing", "fag", "faggot", "fellatio", "flippin",
    "flipping", "freaken", "freaking",
    "fricken", "frickin", "fricking", "friggen", "friggin", "fuck", "fucker", "fuckface",
    "fuckhead", "fucking", "fuckwit", "gangbang", "god damn", "goddam",
    "goddamn", "goddamnit", "gook", "gosh", "handjob", "heck", "hell",
    "holy shit", "horseshit", "jackass", "jackoff", "jerkoff",
    "gism", "jesus christ", "jism", "jiz", "jizz", "kike", "motherfucker", "nigga", "nigger",
    "nutsack", "oh god", "oh my god", "oh my gosh", "orgy", "piece of shit",
    "piss", "porn", "pornography", "prick", "pussy", "retard", "rimjob",
    "screw", "shit", "shitbag", "shite", "shitface", "shithead", "shitstain",
    "shitty", "shut the fuck up", "slut", "slutty", "son of a bitch", "spaz",
    "smegma", "spic", "splooge", "spooge", "threesome", "tit", "tits", "titty", "tranny", "twat",
    "twatwaffle", "vibrator", "wank", "wanker", "wetback", "what the fuck",
    "whore"
  ];

  // EXTENDED_WORDLIST is the subset of DEFAULT_WORDLIST that's
  // euphemisms/ASR-mishears/religious exclamations rather than clear
  // profanity/slurs/crude terms - the two groups pm_strictness ("standard"
  // vs "strict") switches between. CORE_WORDLIST is everything else,
  // computed below by filtering EXTENDED_WORDLIST out of DEFAULT_WORDLIST
  // (so there's one source of truth for the full list's contents; this
  // array only decides which of those entries count as "extended").
  var EXTENDED_WORDLIST = [
    "dang", "effing", "flippin", "flipping", "freaken", "freaking",
    "fricken", "frickin", "fricking", "friggen", "friggin",
    "god damn", "goddam", "goddamn", "goddamnit", "gosh", "heck",
    "jesus christ", "oh god", "oh my god", "oh my gosh"
  ];
  var EXTENDED_SET = new Set(EXTENDED_WORDLIST);
  var CORE_WORDLIST = DEFAULT_WORDLIST.filter(function (w) {
    return !EXTENDED_SET.has(w);
  });

  // ---- Category tagging (0.1.51) ------------------------------------------
  //
  // Every built-in word is tagged with exactly one of five categories, so
  // the popup's Activity dashboard can show a per-type breakdown (how much
  // of what a user muted was profanity vs slurs vs religious exclamations
  // vs euphemisms) and a most-muted list. Crude/sexual terms fold into
  // "profanity" (there is no separate "crude" bucket). User-added words are
  // category "custom", assigned at match time - never listed here.
  //
  // ASR-mishear entries are NOT a category: a mishear is attributed to the
  // REAL word it stands in for. In this list that means the mishear spelling
  // shares the category of the word it is a mishear of (e.g. the "jism"/
  // "jiz"/"jizz"/"gism" cluster all sit in profanity beside their root).
  //
  // The five categories, and the buckets are defined by EXCEPTION: slurs,
  // religious exclamations and euphemisms are listed explicitly; everything
  // else in DEFAULT_WORDLIST is "profanity". This keeps one source of truth
  // (DEFAULT_WORDLIST) for the contents and three small, auditable sets for
  // the non-profanity tags.
  //
  // Judgment calls worth naming:
  //   * "retard"/"spaz" are tagged slur (ableist slurs), not profanity.
  //   * "damn"/"dammit"/"hell" are tagged religious (damnation/the place),
  //     even though they are clear enough to live in the Standard tier.
  //   * "bloody" and "screw" are tagged euphemism (minced/softened oaths).
  //   * "gosh"/"oh my gosh" are euphemism (minced "god"); "oh god"/"oh my
  //     god"/"jesus christ"/the "goddamn" cluster are religious.
  var CATEGORIES = ["profanity", "slur", "religious", "euphemism", "custom"];

  var SLUR_WORDS = [
    "chink", "dyke", "fag", "faggot", "gook", "kike", "nigga", "nigger",
    "spic", "tranny", "wetback", "retard", "spaz"
  ];
  var RELIGIOUS_WORDS = [
    "damn", "dammit", "hell", "god damn", "goddam", "goddamn", "goddamnit",
    "jesus christ", "oh god", "oh my god"
  ];
  var EUPHEMISM_WORDS = [
    "dang", "effing", "flippin", "flipping", "freaken", "freaking",
    "fricken", "frickin", "fricking", "friggen", "friggin", "gosh", "heck",
    "oh my gosh", "bloody", "screw"
  ];

  // word (lowercased, space-normalized) -> category. Built once from the
  // three exception sets; DEFAULT_WORDLIST entries absent from all three
  // are "profanity".
  var WORD_CATEGORY = (function () {
    var map = Object.create(null);
    function tag(list, cat) {
      for (var i = 0; i < list.length; i++) {
        map[list[i].toLowerCase().replace(/\s+/g, " ")] = cat;
      }
    }
    // profanity first as the default for every default entry, then the
    // three exception sets overwrite the ones they own.
    for (var i = 0; i < DEFAULT_WORDLIST.length; i++) {
      map[DEFAULT_WORDLIST[i].toLowerCase().replace(/\s+/g, " ")] = "profanity";
    }
    tag(SLUR_WORDS, "slur");
    tag(RELIGIOUS_WORDS, "religious");
    tag(EUPHEMISM_WORDS, "euphemism");
    return map;
  })();

  // The category of a single list entry. Built-in words return their tag;
  // anything not in the built-in map is a user-added word -> "custom".
  function categoryOfWord(word) {
    if (typeof word !== "string") return "custom";
    var key = word.toLowerCase().trim().replace(/\s+/g, " ");
    return WORD_CATEGORY[key] || "custom";
  }

  // pm_strictness (0.1.29 redesign): a three-way LEVEL selecting how much
  // of the built-in list is switched on. Default "strict".
  //   "none"     -> no built-in words at all
  //   "standard" -> CORE_WORDLIST only (clear profanity/slurs/crude terms)
  //   "strict"   -> DEFAULT_WORDLIST (CORE + EXTENDED, the full defaults)
  //
  // The user's own words are no longer a MODE that replaces the built-ins
  // - they are ADDITIVE, stored separately in pm_additionalWords, and the
  // active list is always `tier(level) + additionalWords` (deduped). This
  // replaced the old third mode, "custom", which meant "use pm_wordlist
  // INSTEAD of the built-ins".
  //
  // Two product reasons for the change, in this order:
  //   1. The built-in lists' CONTENTS must never be shown in the UI. Under
  //      the old model the only way to add one word was to switch to
  //      "custom", which seeded the textarea with the entire built-in list
  //      for the user to edit - i.e. the feature REQUIRED displaying a
  //      screenful of slurs to anyone who wanted to add "poop". With an
  //      additive list, the popup shows the user's own words and nothing
  //      else, ever.
  //   2. Adding a word silently cost you every future update to the
  //      built-in lists, because your snapshot of them became the whole
  //      list. Additive words keep tracking the shipped tier.
  //
  // "custom" is no longer a valid stored level, but is still UNDERSTOOD by
  // resolveSettingsFromStorage as a legacy value to migrate off - see the
  // full migration table there.
  var STRICTNESS_MODES = ["none", "standard", "strict"];
  var LEGACY_STRICTNESS_CUSTOM = "custom";
  var DEFAULT_STRICTNESS = "strict"; // over-censoring beats under-censoring

  // The built-in tier for a level. "none" is a real, supported choice: the
  // user gets exactly their own words and nothing else.
  function tierWordlist(level) {
    if (level === "none") return [];
    if (level === "standard") return CORE_WORDLIST;
    return DEFAULT_WORDLIST; // "strict"
  }

  // Active list = built-in tier + the user's additional words, deduped.
  //
  // Dedupe is case-insensitive and whitespace-normalized because that is
  // how matching itself treats entries (normalizeToken/buildStemSet
  // lowercase everything) - without it, a user adding "Damn" while on the
  // strict tier would produce two entries that stem identically, which is
  // harmless for matching but makes every count shown in the UI wrong by
  // one. Tier entries win position (they come first); the user's list
  // keeps its own order after that. Non-strings and blank lines are
  // dropped rather than trusted, since additionalWords comes straight from
  // a free-text textarea.
  function mergeWordlists(tier, additional) {
    var out = [];
    var seen = new Set();
    function add(list) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var entry = list[i];
        if (typeof entry !== "string") continue;
        var trimmed = entry.trim().replace(/\s+/g, " ");
        if (!trimmed) continue;
        var key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
      }
    }
    add(tier);
    add(additional);
    return out;
  }

  // Whitelist ("Always allow") subtraction (0.1.51). Given the effective
  // active list (tier + additional) and the user's allow list, remove every
  // allowed word so it plays even though it is on the built-in list. This is
  // where "allow beats block" is enforced: because the subtraction runs on
  // the ALREADY-MERGED list (tier + the user's own added words), an entry
  // the user both added AND allowed is removed here and therefore plays.
  //
  // Removing an entry also removes its stems from the matcher's stem set
  // (buildStemSet runs on this subtracted list), so an allowed word's
  // inflections ("damns" when "damn" is allowed) stop matching too - the
  // symmetric mirror of how blocking a word covers its inflections.
  // Matching is case-insensitive and whitespace-normalized, so the compare
  // keys must be as well.
  function subtractWords(list, allow) {
    if (!Array.isArray(allow) || allow.length === 0) {
      return Array.isArray(list) ? list.slice() : [];
    }
    var deny = new Set();
    for (var i = 0; i < allow.length; i++) {
      if (typeof allow[i] !== "string") continue;
      var k = allow[i].trim().replace(/\s+/g, " ").toLowerCase();
      if (k) deny.add(k);
    }
    var out = [];
    for (var j = 0; j < list.length; j++) {
      var entry = list[j];
      if (typeof entry !== "string") continue;
      var key = entry.trim().replace(/\s+/g, " ").toLowerCase();
      if (deny.has(key)) continue;
      out.push(entry);
    }
    return out;
  }

  // Sanitize a raw pm_additionalWords value into a clean string[]. Applied
  // on every read, so a hand-edited or partially-corrupted stored value
  // can never put non-strings into the matcher.
  function sanitizeAdditionalWords(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    var seen = new Set();
    for (var i = 0; i < raw.length; i++) {
      if (typeof raw[i] !== "string") continue;
      var trimmed = raw[i].trim().replace(/\s+/g, " ");
      if (!trimmed) continue;
      var key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
    return out;
  }

  var PADDING_MODES = ["tight", "normal", "wide"];
  var DEFAULT_PADDING = "normal";

  // 0.1.46 (English-only): this build filters English speech only. The
  // matching engine keeps a per-list matchConfig, but English is now the
  // one and only configuration (EN_MATCH_CONFIG). The 0.1.25 multilingual
  // pack architecture (on-demand shared/packs/<lang>.json loading and the
  // language-switch pipeline that drove it) has been removed; that work now
  // lives in a separate multilingual repo. pm_strictness (standard/strict)
  // and the user's custom pm_wordlist are the English word-list controls.
  var EN_MATCH_CONFIG = {
    stemming: "en-suffix",
    foldDiacritics: false,
    substringMode: false,
    wildcards: true
  };

  var CAPTION_PLACEHOLDER = "[ __ ]";

  var SUFFIXES = ["ing", "es", "ed", "er", "s", "y"];

  // Minimum length a suffix-stripped stem must have to be kept. Without
  // this, short entries like "ass" would strip their trailing "s" down
  // to "as" - a common, entirely innocent English word - and flag it.
  var MIN_STEM_LENGTH = 3;

  // Explicit safe-word override, checked before any stem-set lookup.
  //
  // The MIN_STEM_LENGTH guard above catches short-stem collisions in
  // general, but it can't catch every case: an ordinary, extremely
  // common word can independently strip (via its OWN "-er"/"-ing"/etc.
  // suffix) down to a stem long enough to survive that guard, yet still
  // happen to coincide with an unrelated profane list entry. The
  // concrete case that surfaced this: adding the euphemism "dang"
  // (4 letters, itself intentionally profane as a whole word) means
  // ordinary "danger" - an extremely common, entirely innocent word -
  // now also strips via the "-er" suffix rule to "dang" and would
  // otherwise be flagged. This is a structural risk of any
  // suffix-stripping stemmer as the word list grows: the fix isn't to
  // avoid useful short euphemism entries, it's to name the specific
  // innocent collision and hard-exclude it. Add to this set only when
  // a real, verified collision like this is found (see CENSOR_NOTES.md
  // "ASR-mishear / euphemism additions" for the discovery + reasoning);
  // it is NOT a general-purpose dictionary and should stay small.
  // Found via a full /usr/share/dict/words collision scan (see
  // CENSOR_NOTES.md "Collision scan" for methodology + counts):
  //   - "danger"/"dangers" strip via "-er"/(none) to a short euphemism
  //     entry.
  //   - "blood"/"blooded" strip via a mild-profanity entry's own "-y"
  //     suffix stripping (that entry -> its root -> "blood").
  //   - "buggy" strips via another entry's "-er"-stripped root -> "-y".
  //   - "cumin" (the spice - a real cooking-content risk) strips via
  //     the dropped-g heuristic to a 3-letter slang entry.
  //   - "spiced"/"spicer"/"spicing"/"spicy" (all common cooking-content
  //     words) strip via "-ed"/"-er"/"-ing"/"-y" to a slur entry's
  //     4-letter root.
  // Every one of these is an extremely common, zero-ambiguity English
  // word with no real profane double-meaning - unlike some other
  // scan hits (documented separately in CENSOR_NOTES.md as accepted,
  // over-censoring-is-fine collisions) which retain a plausible link
  // to their root entry.
  var SAFE_WORDS = new Set([
    "blood",
    "blooded",
    "buggy",
    "cumin",
    "danger",
    "dangers",
    "spiced",
    "spicer",
    "spicing",
    "spicy",
    "flip", "flipped", "flips",
  ]);

  // Strip leading/trailing punctuation/whitespace, lowercase. Asterisks
  // are treated as meaningful "core" characters (wildcard markers), not
  // punctuation, so they survive normalization - see isProfaneCore.
  // A trailing apostrophe (e.g. "fuckin'") is also stripped, since it's
  // almost always a dropped-g marker or a stray quote rather than part
  // of the word itself.
  //
  // Uses Unicode property escapes (\p{L}/\p{N}, "core" = any letter/digit
  // in any language, not just a-z0-9) so this works correctly for
  // non-English packs (accented Spanish "coño", etc.) without changing
  // English behavior at all (\p{L} already covers a-z; ASCII digits are
  // \p{N}). foldDiacritics (per the active pack's matchConfig, default
  // false - preserves exact pre-pack-architecture behavior when omitted)
  // additionally strips combining diacritical marks via NFD
  // decomposition, so e.g. "coño"/"dios" match consistently regardless
  // of accents in the source text vs. the word-list entry.
  function normalizeToken(token, foldDiacritics) {
    if (typeof token !== "string") return "";
    var s = token.toLowerCase();
    if (foldDiacritics) {
      s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }
    return s
      .replace(/^[^\p{L}\p{N}'*]+/u, "")
      .replace(/[^\p{L}\p{N}'*]+$/u, "")
      .replace(/'+$/, "");
  }

  // Return the set of "stems" for a normalized word: the word itself,
  // the word with any of the common suffixes stripped off (only when
  // the result is long enough to still be meaningful - see
  // MIN_STEM_LENGTH), and - for dropped-g forms like "fuckin"/"goin" -
  // the "g"-restored form and its own ing-stripped stem. This is
  // intentionally simple (no linguistic correctness), just enough to
  // let "damns"/"damned"/"damning" match "damn", and "fuckin"/"fuckin'"
  // match "fucking"/"fuck", in both directions (applied to both list
  // entries and input tokens).
  // matchConfig controls whether suffix-stemming applies at all -
  // defaults to EN_MATCH_CONFIG ("en-suffix") when omitted, so every
  // pre-existing call site (which always passed just `word`) keeps
  // producing byte-for-byte the same stems as before the pack
  // architecture existed. Community-tier packs (matchConfig.stemming ===
  // "none") have no per-language stemmer built, so a "stem" is just the
  // word itself - the pack's own data file is expected to list common
  // inflected forms explicitly instead (this is what the curated
  // Spanish pack does).
  function stemsOf(word, matchConfig) {
    matchConfig = matchConfig || EN_MATCH_CONFIG;
    if (matchConfig.stemming !== "en-suffix") return [word];
    var stems = [word];
    for (var i = 0; i < SUFFIXES.length; i++) {
      var suf = SUFFIXES[i];
      if (word.length > suf.length + 1 && word.slice(-suf.length) === suf) {
        var stripped = word.slice(0, -suf.length);
        if (stripped.length >= MIN_STEM_LENGTH) stems.push(stripped);
      }
    }
    // Dropped-g: a word ending "in" (but not already "ing") is treated
    // as if it were spelled with the g, e.g. "fuckin" -> "fucking",
    // which then also yields "fuck" via the "ing" suffix rule above.
    if (word.length > MIN_STEM_LENGTH && /in$/.test(word) && !/ing$/.test(word)) {
      var withG = word + "g";
      stems.push(withG);
      var gStripped = withG.slice(0, -SUFFIXES[0].length); // strip "ing"
      if (gStripped.length >= MIN_STEM_LENGTH) stems.push(gStripped);
    }
    return stems;
  }

  // ---- Wildcard ("*") matching, for partially-censored captions like
  // Whisper's "s***", "sh*t", or "f***ing" ----
  //
  // Rules (documented, deliberately biased toward over-censoring):
  //  1. Aligned wildcard: token and candidate must be the SAME length;
  //     every non-'*' character in the token must equal the character
  //     at that position in the candidate (case-insensitive). E.g.
  //     "sh*t" (len 4) aligns against "shit" (len 4); "f***ing" (len 7)
  //     aligns against "fucking" (len 7).
  //  2. First-letter-only shorthand: a token that is one real letter
  //     followed by nothing but asterisks (e.g. "f***", "a**", "s***")
  //     matches ANY candidate stem starting with that same letter whose
  //     length is within +/-1 of the token's length. This is looser on
  //     purpose - a bare "f***" gives no positional information beyond
  //     "starts with f, is about this long", so we err toward matching
  //     (over-censoring) rather than requiring an exact-length aligned
  //     match. Rule 1 already covers the same-length case; rule 2 only
  //     adds the +/-1 length tolerance on top of it.
  function tokenHasWildcard(word) {
    return word.indexOf("*") !== -1;
  }

  function isFirstLetterAllAsterisks(word) {
    return word.length >= 2 && /^[a-z][*]+$/.test(word);
  }

  function wildcardAlignedMatch(token, candidate) {
    if (token.length !== candidate.length) return false;
    for (var i = 0; i < token.length; i++) {
      var ch = token[i];
      if (ch === "*") continue;
      if (ch !== candidate[i]) return false;
    }
    return true;
  }

  function isProfaneWildcard(token, stemSet) {
    var candidates = Array.from(stemSet);
    if (isFirstLetterAllAsterisks(token)) {
      var letter = token[0];
      var lenLo = token.length - 1;
      var lenHi = token.length + 1;
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (c.charAt(0) === letter && c.length >= lenLo && c.length <= lenHi) {
          return true;
        }
      }
      return false;
    }
    for (var j = 0; j < candidates.length; j++) {
      if (wildcardAlignedMatch(token, candidates[j])) return true;
    }
    return false;
  }

  // Build a Set of every stem of every list entry (single-token entries
  // only - multi-word phrases are handled separately by censorText).
  // matchConfig defaults to EN_MATCH_CONFIG when omitted - see stemsOf.
  function buildStemSet(wordlist, matchConfig) {
    matchConfig = matchConfig || EN_MATCH_CONFIG;
    var set = new Set();
    for (var i = 0; i < wordlist.length; i++) {
      var entry = normalizeToken(wordlist[i], matchConfig.foldDiacritics);
      if (!entry) continue;
      if (!matchConfig.substringMode && entry.indexOf(" ") !== -1) continue; // phrase, skip here
      var stems = stemsOf(entry, matchConfig);
      for (var j = 0; j < stems.length; j++) set.add(stems[j]);
    }
    return set;
  }

  // Category attribution maps (0.1.51). Parallel to buildStemSet /
  // buildPhraseIndex, but keyed so a match can be traced back to the list
  // entry it came from and that entry's category. `categoryFn(entry)`
  // returns the category for a given list entry (built-in words get their
  // tag, user-added words get "custom"); it is injected rather than closed
  // over so the pure core stays testable without the WORD_CATEGORY table.
  //
  // buildStemCategory: stem -> {category, canonical}. `canonical` is the
  // normalized list entry that owns the stem, used for the most-muted
  // display (so "damns" is attributed to "damn"). First entry to claim a
  // stem wins, matching buildStemSet's own first-wins behavior.
  function buildStemCategory(wordlist, matchConfig, categoryFn) {
    matchConfig = matchConfig || EN_MATCH_CONFIG;
    var map = new Map();
    for (var i = 0; i < wordlist.length; i++) {
      var raw = wordlist[i];
      var entry = normalizeToken(raw, matchConfig.foldDiacritics);
      if (!entry) continue;
      if (!matchConfig.substringMode && entry.indexOf(" ") !== -1) continue;
      var cat = categoryFn ? categoryFn(raw) : "profanity";
      var stems = stemsOf(entry, matchConfig);
      for (var j = 0; j < stems.length; j++) {
        if (!map.has(stems[j])) map.set(stems[j], { category: cat, canonical: entry });
      }
    }
    return map;
  }

  // buildPhraseCategory: normalized phrase string -> {category, canonical}.
  function buildPhraseCategory(wordlist, matchConfig, categoryFn) {
    matchConfig = matchConfig || EN_MATCH_CONFIG;
    var map = new Map();
    for (var i = 0; i < wordlist.length; i++) {
      var raw = wordlist[i];
      var entry = normalizeSpaces(raw, matchConfig.foldDiacritics);
      if (!entry || entry.indexOf(" ") === -1) continue;
      if (!map.has(entry)) {
        map.set(entry, {
          category: categoryFn ? categoryFn(raw) : "profanity",
          canonical: entry
        });
      }
    }
    return map;
  }

  // Look up the category + canonical entry for a single matched token,
  // given a stemCategory map. Returns null when nothing is found (e.g. a
  // wildcard match, which carries no exact stem) so callers can fall back.
  function attributeToken(token, stemCategory, matchConfig) {
    if (!stemCategory) return null;
    matchConfig = matchConfig || EN_MATCH_CONFIG;
    var norm = normalizeToken(token, matchConfig.foldDiacritics);
    if (!norm) return null;
    var stems = stemsOf(norm, matchConfig);
    for (var i = 0; i < stems.length; i++) {
      if (stemCategory.has(stems[i])) return stemCategory.get(stems[i]);
    }
    return null;
  }

  // Substring matching, for languages with no reliable whitespace word
  // boundaries (matchConfig.substringMode - Chinese/Japanese/Thai/Korean
  // community packs). `stemSet` here holds whole (possibly multi-
  // character) list entries verbatim (no stemming), and `norm` is the
  // already-normalized token/text being checked; a match is any entry
  // appearing anywhere inside it.
  function isProfaneSubstring(norm, stemSet) {
    if (!norm) return false;
    var it = stemSet.values();
    var next = it.next();
    while (!next.done) {
      var entry = next.value;
      if (entry && norm.indexOf(entry) !== -1) return true;
      next = it.next();
    }
    return false;
  }

  // Substring-mode packs (no reliable word boundaries) don't use the
  // phrase machinery at all - a multi-character list entry already
  // matches as a substring via isProfaneSubstring, so "phrases" would be
  // redundant with the plain stem set for those packs.
  function buildPhraseList(wordlist, matchConfig) {
    matchConfig = matchConfig || EN_MATCH_CONFIG;
    var phrases = [];
    if (matchConfig.substringMode) return phrases;
    for (var i = 0; i < wordlist.length; i++) {
      var entry = normalizeSpaces(wordlist[i], matchConfig.foldDiacritics);
      if (entry && entry.indexOf(" ") !== -1) phrases.push(entry);
    }
    // Longest first so overlapping phrases match the most specific one.
    phrases.sort(function (a, b) { return b.length - a.length; });
    return phrases;
  }

  function normalizeSpaces(s, foldDiacritics) {
    if (typeof s !== "string") return "";
    var out = s.toLowerCase().trim().replace(/\s+/g, " ");
    if (foldDiacritics) {
      out = out.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }
    return out;
  }

  // Index phrases by their first (normalized) word, so findMatchesCore
  // only ever compares against phrases that could plausibly start at
  // the current token - O(tokens) overall rather than O(tokens *
  // phrases). Each bucket is sorted longest-first (by word count) so
  // the longest phrase starting at a position wins.
  function buildPhraseIndex(wordlist, matchConfig) {
    var index = new Map();
    var phrases = buildPhraseList(wordlist, matchConfig);
    for (var i = 0; i < phrases.length; i++) {
      var words = phrases[i].split(" ");
      var first = words[0];
      if (!index.has(first)) index.set(first, []);
      index.get(first).push(words);
    }
    index.forEach(function (bucket) {
      bucket.sort(function (a, b) { return b.length - a.length; });
    });
    return index;
  }

  // findMatchesCore(tokens, stemSet, phraseIndex, matchConfig) ->
  // [{index, length}]
  //
  // `tokens` is an array of already-transcribed words in order (as the
  // audio pipeline produces them). Returns one entry per match - either
  // a multi-word phrase (length = word count) or a single profane word
  // (length = 1, via the same isProfane/wildcard logic as isProfane()).
  // Linear time: each token does one Map lookup plus, at most, a short
  // scan of same-first-word phrase candidates. matchConfig defaults to
  // EN_MATCH_CONFIG when omitted (pre-pack-architecture call sites).
  // catMaps (0.1.51, optional): {stem, phrase} category maps built by
  // buildStemCategory/buildPhraseCategory. When present, each returned
  // match also carries `category` (one of CATEGORIES) and `word` (the
  // canonical list entry), so the audio pipeline can attribute the mute for
  // the Activity dashboard. Omitted -> the extra fields are simply absent
  // and every existing 4-arg call site is byte-for-byte unchanged.
  function findMatchesCore(tokens, stemSet, phraseIndex, matchConfig, catMaps) {
    matchConfig = matchConfig || EN_MATCH_CONFIG;
    var stemCat = catMaps && catMaps.stem;
    var phraseCat = catMaps && catMaps.phrase;
    var matches = [];
    if (!Array.isArray(tokens) || tokens.length === 0) return matches;

    var normTokens = new Array(tokens.length);
    for (var t = 0; t < tokens.length; t++) {
      normTokens[t] = normalizeToken(tokens[t], matchConfig.foldDiacritics);
    }

    for (var i = 0; i < tokens.length; i++) {
      var norm = normTokens[i];
      if (!norm) continue;

      var candidates = phraseIndex ? phraseIndex.get(norm) : null;
      var matchedPhrase = false;

      if (candidates && candidates.length) {
        for (var c = 0; c < candidates.length; c++) {
          var words = candidates[c];
          if (i + words.length > tokens.length) continue;
          var ok = true;
          for (var k = 1; k < words.length; k++) {
            if (normTokens[i + k] !== words[k]) {
              ok = false;
              break;
            }
          }
          if (ok) {
            var pm = { index: i, length: words.length };
            if (phraseCat) {
              var pinfo = phraseCat.get(words.join(" "));
              if (pinfo) {
                pm.category = pinfo.category;
                pm.word = pinfo.canonical;
              }
            }
            matches.push(pm);
            matchedPhrase = true;
            break; // bucket is longest-first
          }
        }
      }

      if (!matchedPhrase && isProfaneCore(tokens[i], stemSet, matchConfig)) {
        var sm = { index: i, length: 1 };
        if (stemCat) {
          var sinfo = attributeToken(tokens[i], stemCat, matchConfig);
          if (sinfo) {
            sm.category = sinfo.category;
            sm.word = sinfo.canonical;
          } else {
            // Wildcard/first-letter matches carry no exact stem; attribute
            // to profanity with the normalized token as the label rather
            // than dropping the match from the breakdown entirely.
            sm.category = "profanity";
            sm.word = normalizeToken(tokens[i], matchConfig.foldDiacritics);
          }
        }
        matches.push(sm);
      }
    }

    return matches;
  }

  // Is `word` (a single token, possibly with punctuation) profane
  // against the given stem set? Tokens containing '*' are routed to
  // the wildcard matcher (see rules documented above) instead of exact
  // stem lookup - only when matchConfig.wildcards is true. matchConfig
  // defaults to EN_MATCH_CONFIG when omitted, so every pre-existing
  // 2-arg call site keeps its exact prior behavior.
  function isProfaneCore(word, stemSet, matchConfig) {
    matchConfig = matchConfig || EN_MATCH_CONFIG;
    var norm = normalizeToken(word, matchConfig.foldDiacritics);
    if (!norm) return false;
    // SAFE_WORDS is an English-specific set of verified stemming-collision
    // fixes (see its own comment above) - only meaningful for the "en"
    // pack's suffix-stemming matcher, not other-language packs.
    if (matchConfig.stemming === "en-suffix" && SAFE_WORDS.has(norm)) {
      return false;
    }
    if (matchConfig.substringMode) {
      return isProfaneSubstring(norm, stemSet);
    }
    if (matchConfig.wildcards && tokenHasWildcard(norm)) {
      return isProfaneWildcard(norm, stemSet);
    }
    var stems = stemsOf(norm, matchConfig);
    for (var i = 0; i < stems.length; i++) {
      if (stemSet.has(stems[i])) return true;
    }
    return false;
  }

  // Unicode-aware "core word character" regex pieces, used by both
  // censorWord and censorTextCore's tokenizer. \p{L}/\p{N} (any
  // letter/digit in any language) replaces the old plain a-z0-9 class so
  // non-English packs' accented/non-Latin text censors correctly - for
  // English this is exactly equivalent (\p{L} already covers a-z, case
  // included, so the old /i flag is no longer even needed here).
  var CORE_CHAR_CLASS = "\\p{L}\\p{N}'*";
  var NON_CORE_CHAR_CLASS = "^" + CORE_CHAR_CLASS;
  var CENSOR_WORD_RE = new RegExp(
    "^([" + NON_CORE_CHAR_CLASS + "]*)([" + CORE_CHAR_CLASS + "]*)([" + NON_CORE_CHAR_CLASS + "]*)$",
    "u"
  );
  var TOKEN_SCAN_RE = new RegExp(
    "[" + CORE_CHAR_CLASS + "]+(?:[" + NON_CORE_CHAR_CLASS + "]*)",
    "gu"
  );

  function censorWord(word) {
    // Preserve any leading/trailing punctuation, censor the core token.
    // Asterisks are treated as part of the "core" (not punctuation) so
    // an already partially-censored token like "sh*t" is recognized as
    // one 4-character core and fully re-censored to "s***".
    var m = word.match(CENSOR_WORD_RE);
    if (!m) return word;
    var lead = m[1], core = m[2], trail = m[3];
    if (!core) return word;
    // Use Array.from (not .length/slice) so a censored word with
    // multi-code-unit characters (rare, but \p{L} can match astral-plane
    // letters) still censors the whole visible character correctly.
    var coreChars = Array.from(core);
    return lead + coreChars[0] + "*".repeat(Math.max(coreChars.length - 1, 1)) + trail;
  }

  // censorTextCore(text, stemSet, phrases, matchConfig) - matchConfig
  // defaults to EN_MATCH_CONFIG when omitted (pre-pack-architecture call
  // sites keep exact prior behavior). Substring-mode packs (no reliable
  // word boundaries - CJK/Thai community packs) skip the token-regex
  // path entirely and instead scan the raw text for each list entry as
  // a literal substring, longest-first so overlapping entries censor as
  // their most specific match.
  function censorTextCore(text, stemSet, phrases, matchConfig) {
    matchConfig = matchConfig || EN_MATCH_CONFIG;
    if (typeof text !== "string" || !text) return text;

    var result = text;

    // 1. YouTube auto-caption profanity placeholder is always censored.
    result = result.split(CAPTION_PLACEHOLDER).join("[ *** ]");

    if (matchConfig.substringMode) {
      var entries = Array.from(stemSet).sort(function (a, b) { return b.length - a.length; });
      for (var e = 0; e < entries.length; e++) {
        var entry = entries[e];
        if (!entry) continue;
        var subRe = new RegExp(escapeRegExp(entry), "gi");
        result = result.replace(subRe, function (match) {
          var chars = Array.from(match);
          return chars[0] + "*".repeat(Math.max(chars.length - 1, 1));
        });
      }
      return result;
    }

    // 2. Multi-word phrases (case-insensitive, whitespace-normalized).
    for (var i = 0; i < phrases.length; i++) {
      var phrase = phrases[i];
      var re = new RegExp(escapeRegExp(phrase).replace(/ /g, "\\s+"), "gi");
      result = result.replace(re, function (match) {
        return censorPhrase(match);
      });
    }

    // 3. Single-token words (asterisks count as core word characters so
    // already partially-censored tokens like "sh*t" are matched as one
    // token rather than split on the asterisk).
    result = result.replace(TOKEN_SCAN_RE, function (token) {
      // token here is a word plus any trailing punctuation glued to it by
      // the regex; re-split via censorWord's own punctuation handling.
      if (isProfaneCore(token, stemSet, matchConfig)) {
        return censorWord(token);
      }
      return token;
    });

    return result;
  }

  function censorPhrase(phrase) {
    var words = phrase.split(/(\s+)/);
    return words
      .map(function (w) {
        if (/^\s+$/.test(w) || !w) return w;
        return censorWord(w);
      })
      .join("");
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Storage key names, single source of truth for both the array-form
  // chrome.storage.sync.get() call and resolveSettingsFromStorage()'s
  // defaulting below.
  var STORAGE_KEYS = [
    "pm_enabled",
    "pm_wordlist",
    "pm_safeMode",
    "pm_muteAudio",
    "pm_censorCaptions",
    "pm_catchupMode",
    "pm_debugOverlay",
    "pm_showStatus",
    "pm_strictness",
    "pm_additionalWords",
    "pm_allowWords",
    "pm_padding"
  ];

  var CATCHUP_MODES = ["mute", "pause", "play"];
  var DEFAULT_CATCHUP_MODE = "play";

  // Pure defaulting logic for raw chrome.storage.sync.get() results.
  //
  // IMPORTANT: chrome.storage.sync.get() must be called with the ARRAY
  // form (a list of key names), never the "defaults object" form with
  // an `undefined`-valued key. Chrome's defaults-object form works by
  // merging the *own enumerable keys* of the object you pass in with
  // whatever storage returns - but a key whose value is `undefined`
  // is, for all practical purposes, treated as absent from that
  // request (this was the exact bug reported: pm_wordlist: undefined
  // in the defaults object meant `items.pm_wordlist` came back
  // `undefined` on EVERY call, even when a real custom list had been
  // saved, so a saved list silently had no effect). Doing our own
  // defaulting here, on the raw result of the array-form get(), avoids
  // that trap entirely and is unit-testable without chrome.* at all.
  //
  // A saved EMPTY array for pm_wordlist ([]) is honored as "no words"
  // - only a truly absent/undefined pm_wordlist falls back to
  // DEFAULT_WORDLIST (see rebuildFrom's matching comment).
  //
  // pm_catchupMode + legacy pm_safeMode migration:
  //   1. A valid, explicitly saved pm_catchupMode ("mute"/"pause"/
  //      "play") always wins outright.
  //   2. Otherwise, if pm_catchupMode has never been saved but the
  //      legacy pm_safeMode was explicitly saved as `false` (the user
  //      had turned safe mode off under the old two-setting schema),
  //      migrate that choice forward as catchupMode "play" - old
  //      "safe mode off" meant unanalyzed audio plays, which is
  //      exactly what "play" means now. This runs ONCE, implicitly,
  //      every time settings are resolved until the user picks a
  //      catch-up mode explicitly (at which point rule 1 takes over
  //      permanently since pm_catchupMode becomes saved).
  //   3. Otherwise (nothing saved at all, or pm_catchupMode is
  //      corrupted/mistyped/wrong-type) default to "mute".
  // pm_safeMode itself is no longer written by the popup - it is only
  // ever read here, for this migration.
  //
  // `safeMode` is kept in the returned shape too, but it is now a
  // DERIVED boolean (`catchupMode !== "play"`), not read independently
  // from storage - this preserves the PMWordlist.settings.safeMode
  // contract that content.js (the audio-pipeline agent's file) already
  // consumes, unchanged, even though there's no longer a separate
  // pm_safeMode toggle in the popup.
  //
  // pm_debugOverlay defaults to false (unlike the other booleans, which
  // default to true) - it's an opt-in diagnostic aid, off unless the
  // user explicitly turns it on.
  //
  // pm_showStatus defaults to true (like most other booleans, unlike
  // pm_debugOverlay) - it's a lightweight on-player status pill shown
  // by default, not an opt-in diagnostic.
  //
  // pm_strictness (LEVEL) + pm_additionalWords (ADDITIVE) - 0.1.29
  // ---------------------------------------------------------------
  // The active English list is always:
  //
  //     mergeWordlists(tierWordlist(level), additionalWords)
  //
  // i.e. the built-in tier for the level ("none" -> nothing, "standard"
  // -> CORE_WORDLIST, "strict" -> CORE + EXTENDED) plus the user's own
  // words, deduped. There is no longer a mode in which the user's list
  // REPLACES the built-ins; "custom" is gone as a level and survives only
  // as a legacy value to migrate off.
  //
  // Resolution order (same "explicit value wins, else migrate off a
  // legacy signal, else default" pattern used for pm_catchupMode above):
  //
  //   1. pm_additionalWords is a saved array -> the migration has already
  //      happened (or the user has saved words under the new schema).
  //      Use it verbatim (after sanitizing), and take the level from a
  //      valid saved pm_strictness, defaulting to "strict". A stale
  //      legacy pm_strictness of "custom" alongside it still maps to
  //      "none" (rule 2a's mapping), so a half-migrated storage state
  //      can't silently re-enable a tier the user had switched off.
  //
  //   2. pm_additionalWords has NEVER been saved -> migrate, from
  //      whatever the pre-0.1.29 schema left behind. `hasSavedWordlist`
  //      means Array.isArray(pm_wordlist) - true even for [], which was
  //      an intentionally-emptied list under the old rules.
  //
  //      a. pm_strictness === "custom" (legacy) AND a saved pm_wordlist
  //         -> level "none", additionalWords = pm_wordlist.
  //         EXACTLY equivalent: "custom" meant "pm_wordlist verbatim,
  //         built-ins ignored", and "none" + those same words is the
  //         same resulting list, including the empty case.
  //
  //      b. pm_strictness === "custom" (legacy) with NO saved
  //         pm_wordlist -> level "strict", additionalWords = [].
  //         This preserves the OLD safety net exactly: that edge case
  //         (custom selected, nothing ever saved) fell back to
  //         DEFAULT_WORDLIST rather than to an empty list, and level
  //         "strict" with no additions IS DEFAULT_WORDLIST. Mapping it
  //         to "none" instead would silently disable all filtering for
  //         these users - the one migration outcome that must never
  //         happen.
  //
  //      c. pm_strictness === "none"/"standard"/"strict" (valid new
  //         level, or an untouched pre-existing "standard"/"strict")
  //         -> keep that level, additionalWords = []. Any saved
  //         pm_wordlist is IGNORED, exactly as it was ignored in those
  //         modes before.
  //
  //      d. pm_strictness never saved / corrupted / wrong type, but a
  //         saved pm_wordlist exists -> level "none", additionalWords =
  //         pm_wordlist. This is the pre-strictness-feature schema (a
  //         saved list and nothing else), which used to migrate to
  //         "custom" and therefore meant "that list, no built-ins" -
  //         "none" + that list is the identical outcome.
  //
  //      e. Nothing saved at all -> level "strict", additionalWords =
  //         [], i.e. the full DEFAULT_WORDLIST. Unchanged default.
  //
  // pm_wordlist is deliberately left UNTOUCHED in storage by all of the
  // above (nothing here writes, and the popup no longer writes it
  // either). It is no longer an active source once pm_additionalWords
  // has been saved - it is kept purely so a rollback to 0.1.28 finds the
  // user's old list exactly where it left it.
  //
  // pm_padding is a simple, independent three-way setting with no
  // interaction with anything else - validated and defaulted exactly
  // like pm_catchupMode, just with no migration path (there was no
  // prior padding concept to migrate from).
  function resolveSettingsFromStorage(items) {
    items = items || {};

    var catchupMode;
    if (CATCHUP_MODES.indexOf(items.pm_catchupMode) !== -1) {
      catchupMode = items.pm_catchupMode;
    } else if (items.pm_safeMode === false) {
      catchupMode = "play"; // migration: legacy safe-mode-off
    } else {
      catchupMode = DEFAULT_CATCHUP_MODE;
    }

    // ---- level + additional words (see the migration table above) ----
    var hasSavedWordlist = Array.isArray(items.pm_wordlist);
    var hasSavedAdditional = Array.isArray(items.pm_additionalWords);
    var isValidLevel = STRICTNESS_MODES.indexOf(items.pm_strictness) !== -1;
    var isLegacyCustom = items.pm_strictness === LEGACY_STRICTNESS_CUSTOM;

    var strictness;
    var additionalWords;

    if (hasSavedAdditional) {
      // Rule 1: already on the new schema.
      additionalWords = sanitizeAdditionalWords(items.pm_additionalWords);
      strictness = isValidLevel
        ? items.pm_strictness
        : isLegacyCustom
          ? "none" // half-migrated storage: never re-enable a switched-off tier
          : DEFAULT_STRICTNESS;
    } else if (isLegacyCustom && hasSavedWordlist) {
      // Rule 2a: "custom" + a saved list -> the same list, no built-ins.
      strictness = "none";
      additionalWords = sanitizeAdditionalWords(items.pm_wordlist);
    } else if (isLegacyCustom) {
      // Rule 2b: "custom" with nothing ever saved fell back to the FULL
      // built-in list. Preserve that, not an empty list.
      strictness = DEFAULT_STRICTNESS;
      additionalWords = [];
    } else if (isValidLevel) {
      // Rule 2c: an explicit level wins; any legacy pm_wordlist was
      // already being ignored in these modes and stays ignored.
      strictness = items.pm_strictness;
      additionalWords = [];
    } else if (hasSavedWordlist) {
      // Rule 2d: pre-strictness-feature schema - a saved list meant "that
      // list, no built-ins".
      strictness = "none";
      additionalWords = sanitizeAdditionalWords(items.pm_wordlist);
    } else {
      // Rule 2e: nothing saved at all.
      strictness = DEFAULT_STRICTNESS;
      additionalWords = [];
    }

    // Whitelist (0.1.51). Subtracted from the merged tier+additional list
    // so allowed words play even when they are on the built-in list, and
    // even when the user also added them ("allow beats block"). The raw
    // allow list is also returned for the popup to render.
    var allowWords = sanitizeAdditionalWords(items.pm_allowWords);
    var wordlist = subtractWords(
      mergeWordlists(tierWordlist(strictness), additionalWords),
      allowWords
    );

    var padding = PADDING_MODES.indexOf(items.pm_padding) !== -1
      ? items.pm_padding
      : DEFAULT_PADDING;

    return {
      enabled: items.pm_enabled !== false,
      safeMode: catchupMode !== "play",
      muteAudio: items.pm_muteAudio !== false,
      censorCaptions: items.pm_censorCaptions !== false,
      catchupMode: catchupMode,
      debugOverlay: items.pm_debugOverlay === true,
      showStatus: items.pm_showStatus !== false,
      strictness: strictness,
      padding: padding,
      // The user's OWN words, resolved/migrated and sanitized - what the
      // popup renders in "My additional words". Never contains built-ins.
      additionalWords: additionalWords,
      // The "Always allow" list (0.1.51), sanitized. What the popup renders
      // as the whitelist chips; subtracted from `wordlist` above.
      allowWords: allowWords,
      // The EFFECTIVE list: tier + additionalWords, deduped. This is what
      // matching uses; it is never displayed anywhere in the UI.
      wordlist: wordlist
    };
  }

  // ---- Public "core" API (pure, no chrome.*) ----
  var PMWordlistCore = {
    DEFAULT_WORDLIST: DEFAULT_WORDLIST,
    CAPTION_PLACEHOLDER: CAPTION_PLACEHOLDER,
    normalizeToken: normalizeToken,
    stemsOf: stemsOf,
    buildStemSet: buildStemSet,
    buildPhraseList: buildPhraseList,
    buildPhraseIndex: buildPhraseIndex,
    buildStemCategory: buildStemCategory,
    buildPhraseCategory: buildPhraseCategory,
    attributeToken: attributeToken,
    categoryOfWord: categoryOfWord,
    CATEGORIES: CATEGORIES,
    WORD_CATEGORY: WORD_CATEGORY,
    SLUR_WORDS: SLUR_WORDS,
    RELIGIOUS_WORDS: RELIGIOUS_WORDS,
    EUPHEMISM_WORDS: EUPHEMISM_WORDS,
    subtractWords: subtractWords,
    isProfaneCore: isProfaneCore,
    censorTextCore: censorTextCore,
    findMatchesCore: findMatchesCore,
    resolveSettingsFromStorage: resolveSettingsFromStorage,
    STORAGE_KEYS: STORAGE_KEYS,
    CATCHUP_MODES: CATCHUP_MODES,
    DEFAULT_CATCHUP_MODE: DEFAULT_CATCHUP_MODE,
    CORE_WORDLIST: CORE_WORDLIST,
    EXTENDED_WORDLIST: EXTENDED_WORDLIST,
    STRICTNESS_MODES: STRICTNESS_MODES,
    DEFAULT_STRICTNESS: DEFAULT_STRICTNESS,
    LEGACY_STRICTNESS_CUSTOM: LEGACY_STRICTNESS_CUSTOM,
    tierWordlist: tierWordlist,
    mergeWordlists: mergeWordlists,
    sanitizeAdditionalWords: sanitizeAdditionalWords,
    PADDING_MODES: PADDING_MODES,
    DEFAULT_PADDING: DEFAULT_PADDING,
    EN_MATCH_CONFIG: EN_MATCH_CONFIG,
    isProfaneSubstring: isProfaneSubstring
  };

  // ---- Stateful wrapper wired to chrome.storage.sync ----
  var state = {
    enabled: true,
    muteAudio: true,
    censorCaptions: true,
    safeMode: true,
    catchupMode: DEFAULT_CATCHUP_MODE,
    debugOverlay: false,
    showStatus: true,
    strictness: DEFAULT_STRICTNESS,
    padding: DEFAULT_PADDING,
    matchConfig: EN_MATCH_CONFIG,
    // The user's own additive words (pm_additionalWords), resolved by
    // resolveSettingsFromStorage. Kept on _state (not on `settings`,
    // which is contractually free of arrays) for the popup to render.
    additionalWords: [],
    // The "Always allow" list (0.1.51), for the popup to render.
    allowWords: [],
    wordlist: DEFAULT_WORDLIST.slice(),
    stemSet: buildStemSet(DEFAULT_WORDLIST, EN_MATCH_CONFIG),
    phrases: buildPhraseList(DEFAULT_WORDLIST, EN_MATCH_CONFIG),
    phraseIndex: buildPhraseIndex(DEFAULT_WORDLIST, EN_MATCH_CONFIG),
    // Category attribution maps (0.1.51), kept in lockstep with the three
    // above via rebuildFrom. Built from the same active wordlist so a
    // match's category reflects exactly what is being filtered.
    stemCategory: buildStemCategory(DEFAULT_WORDLIST, EN_MATCH_CONFIG, categoryOfWord),
    phraseCategory: buildPhraseCategory(DEFAULT_WORDLIST, EN_MATCH_CONFIG, categoryOfWord)
  };

  // Minimal, stable-shape settings object handed to other content
  // scripts (the audio pipeline's content.js reads PMWordlist.settings
  // directly). Deliberately exactly these ten keys - no internal
  // Set/Map/array fields - so consumers can safely read or even
  // serialize it without pulling in wordlist/stemSet/phrase internals.
  // The SAME object reference is mutated in place on every refresh()
  // so a reference a consumer captured once stays live.
  var settings = {
    enabled: true,
    muteAudio: true,
    censorCaptions: true,
    safeMode: true,
    catchupMode: DEFAULT_CATCHUP_MODE,
    debugOverlay: false,
    showStatus: true,
    strictness: DEFAULT_STRICTNESS,
    padding: DEFAULT_PADDING,
    // 0.1.29: how many words the user added on top of the built-in tier.
    // A COUNT, not the array - `settings` stays free of arrays/Sets so
    // consumers can serialize it (content.js's dev-log settings snapshot
    // reads exactly this, and must never carry word-list contents).
    additionalWordCount: 0
  };

  function hasChromeStorage() {
    return (
      typeof chrome !== "undefined" &&
      chrome &&
      chrome.storage &&
      chrome.storage.sync &&
      typeof chrome.storage.sync.get === "function"
    );
  }

  // Note: pm_wordlist is respected AS-IS (even an empty array, meaning
  // "no words") whenever the key has actually been saved. Built-in
  // defaults are only used when the key has never been saved at all
  // (items.pm_wordlist === undefined - see refresh()'s storage.get
  // default below). matchConfig defaults to EN_MATCH_CONFIG (so plain
  // rebuildFrom(list) calls, as before the pack architecture, are
  // unaffected).
  function rebuildFrom(list, matchConfig) {
    matchConfig = matchConfig || EN_MATCH_CONFIG;
    var wl = Array.isArray(list) ? list : DEFAULT_WORDLIST;
    state.matchConfig = matchConfig;
    state.wordlist = wl;
    state.stemSet = buildStemSet(wl, matchConfig);
    state.phrases = buildPhraseList(wl, matchConfig);
    state.phraseIndex = buildPhraseIndex(wl, matchConfig);
    state.stemCategory = buildStemCategory(wl, matchConfig, categoryOfWord);
    state.phraseCategory = buildPhraseCategory(wl, matchConfig, categoryOfWord);
  }

  function refresh() {
    if (!hasChromeStorage()) {
      return Promise.resolve(state);
    }
    return new Promise(function (resolve) {
      try {
        // Array form, NOT the "defaults object" form - see
        // resolveSettingsFromStorage's comment for why. Defaulting is
        // applied ourselves, in code, on the raw result.
        chrome.storage.sync.get(STORAGE_KEYS, function (items) {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(state);
            return;
          }
          var resolved = resolveSettingsFromStorage(items);
          state.enabled = resolved.enabled;
          state.safeMode = resolved.safeMode;
          state.muteAudio = resolved.muteAudio;
          state.censorCaptions = resolved.censorCaptions;
          state.catchupMode = resolved.catchupMode;
          state.debugOverlay = resolved.debugOverlay;
          state.showStatus = resolved.showStatus;
          state.strictness = resolved.strictness;
          state.padding = resolved.padding;
          state.additionalWords = resolved.additionalWords;
          state.allowWords = resolved.allowWords;
          rebuildFrom(resolved.wordlist, EN_MATCH_CONFIG);

          settings.enabled = resolved.enabled;
          settings.safeMode = resolved.safeMode;
          settings.muteAudio = resolved.muteAudio;
          settings.censorCaptions = resolved.censorCaptions;
          settings.catchupMode = resolved.catchupMode;
          settings.debugOverlay = resolved.debugOverlay;
          settings.showStatus = resolved.showStatus;
          settings.strictness = resolved.strictness;
          settings.padding = resolved.padding;
          settings.additionalWordCount = resolved.additionalWords.length;

          resolve(state);
        });
      } catch (e) {
        resolve(state);
      }
    });
  }

  function isProfane(word) {
    if (!state.enabled) return false;
    return isProfaneCore(word, state.stemSet, state.matchConfig);
  }

  function censorText(text) {
    if (!state.enabled) return text;
    return censorTextCore(text, state.stemSet, state.phrases, state.matchConfig);
  }

  // findMatches(tokens) -> [{index, length}] against the live settings
  // (respects pm_enabled the same way isProfane/censorText do - when
  // disabled, no matches are reported). Intended for the audio
  // pipeline: tokens is an array of already-transcribed words in
  // order; each result covers either one profane word or one matched
  // multi-word phrase from the English word list.
  function findMatches(tokens) {
    if (!state.enabled) return [];
    return findMatchesCore(tokens, state.stemSet, state.phraseIndex, state.matchConfig, {
      stem: state.stemCategory,
      phrase: state.phraseCategory
    });
  }

  // Wire up live updates, guarded for contexts without chrome.*.
  if (hasChromeStorage() && chrome.storage.onChanged) {
    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== "sync") return;
        if (
          changes.pm_enabled ||
          changes.pm_wordlist ||
          changes.pm_safeMode ||
          changes.pm_muteAudio ||
          changes.pm_censorCaptions ||
          changes.pm_catchupMode ||
          changes.pm_debugOverlay ||
          changes.pm_showStatus ||
          changes.pm_strictness ||
          changes.pm_additionalWords ||
          changes.pm_allowWords ||
          changes.pm_padding
        ) {
          refresh();
        }
      });
    } catch (e) {
      // ignore - non-fatal if listener registration fails
    }
  }

  // Kick off an initial load (no-op resolves immediately if chrome.* absent).
  refresh();

  root.PMWordlist = {
    isProfane: isProfane,
    censorText: censorText,
    findMatches: findMatches,
    refresh: refresh,
    // Live settings snapshot for other content scripts (e.g. content.js
    // reading pm_muteAudio) - always in sync with the last refresh().
    // Exactly {enabled, muteAudio, censorCaptions, safeMode,
    // catchupMode, debugOverlay, showStatus, strictness, padding,
    // additionalWordCount}, no internal Set/Map/array fields.
    // additionalWordCount (0.1.29) is a COUNT, never the words - the
    // user's own list lives on _state.additionalWords.
    settings: settings,
    // exposed for the popup and for tests; not part of the "required" contract
    _state: state,
    _core: PMWordlistCore
  };

  // Also expose the core for Node-based unit testing via module.exports,
  // without turning this file into an ES module.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMWordlistCore: PMWordlistCore, DEFAULT_WORDLIST: DEFAULT_WORDLIST };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
