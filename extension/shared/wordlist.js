// shared/wordlist.js
// Plain script (NOT an ES module) — loaded as the first isolated-world
// content script, before captions.js. Defines globalThis.PMWordlist.
//
// Storage schema (chrome.storage.sync):
//   pm_enabled        boolean   default true  — master on/off
//   pm_wordlist       string[]  default unset -> built-in DEFAULT_WORDLIST
//                                (once saved, respected as-is, even [])
//   pm_muteAudio      boolean   default true  — audio-pipeline toggle
//   pm_censorCaptions boolean   default true  — caption-censoring toggle
//   pm_catchupMode    "mute" | "pause" | "play"  default "mute" — the
//                                ONE setting for what happens in parts
//                                of the video not yet analyzed:
//                                  "mute"  — mute audio until caught up
//                                  "pause" — pause playback (full
//                                            protection: nothing
//                                            unanalyzed ever plays)
//                                  "play"  — let it play unanalyzed
//                                            (old "safe mode off")
//                                Any other/invalid stored value
//                                defaults to "mute". The popup no
//                                longer writes pm_safeMode at all —
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
//   pm_debugOverlay   boolean   default false — shows an on-player
//                                diagnostic overlay (consumed by the
//                                audio pipeline's content.js, not by
//                                this file) with live analysis status.
//   pm_showStatus     boolean   default true — shows an on-player
//                                status pill (consumed by the audio
//                                pipeline's content.js, not by this
//                                file). Distinct from pm_debugOverlay:
//                                this is a lightweight always-on-by-
//                                default status indicator, not the
//                                opt-in diagnostic overlay.
//
// chrome.storage.LOCAL (separate area, not synced — see popup/popup.js):
//   pm_stats   {totalMuted: number, videosProtected: number}  written by
//              the audio pipeline; may be absent (popup shows zeros).
//              Not read or written by this file.
//
// This file is written so the pure matching logic works with zero
// dependency on chrome.* — see PMWordlistCore below — so it can be
// required/loaded directly under Node for unit tests. The chrome.storage
// wiring is all guarded so a page/context without chrome.* never throws.

(function (root) {
  "use strict";

  // Curated default list. Real, editable content (not a placeholder) —
  // the popup loads this verbatim into its textarea the first time
  // pm_wordlist has never been saved. Alphabetized. Deliberately
  // excludes a handful of common-word-derivative entries (e.g.
  // "tosser"/"beaner"/"cracker") whose suffix-stemmed roots collide
  // with ordinary English words ("toss"/"bean"/"crack[er]") — see
  // CENSOR_NOTES.md "Default list & known collisions" for the full
  // rationale and the accepted collisions we kept anyway (e.g. "ass",
  // "hell", "chink", "dyke", "tranny", "retard" also have innocuous
  // senses; over-censoring beats under-censoring for this product).
  var DEFAULT_WORDLIST = [
    "anal", "anus", "arse", "arsehole", "ass", "assface", "asshat",
    "asshead", "asshole", "asswipe", "ballsack", "bastard", "biatch",
    "bitch", "bloody", "blowjob", "bollocks", "boob", "boobs", "bugger",
    "bullshit", "camwhore", "chickenshit", "chink", "clusterfuck", "cock",
    "cocksucker", "crap", "crappy", "cum", "cumming", "cunnilingus", "cunt",
    "dammit", "damn", "dang", "deepthroat", "dick", "dickhead", "dickwad",
    "dickweed", "dildo", "dipshit", "douche", "douchebag", "dumbass",
    "dumbfuck", "dyke", "effing", "fag", "faggot", "fellatio", "freaking",
    "frickin", "fricking", "friggin", "fuck", "fucker", "fuckface",
    "fuckhead", "fucking", "fuckwit", "gangbang", "god damn", "goddam",
    "goddamn", "goddamnit", "gook", "gosh", "handjob", "heck", "hell",
    "holy shit", "horseshit", "jackass", "jackoff", "jerkoff",
    "jesus christ", "jizz", "kike", "motherfucker", "nigga", "nigger",
    "nutsack", "oh god", "oh my god", "oh my gosh", "orgy", "piece of shit",
    "piss", "porn", "pornography", "prick", "pussy", "retard", "rimjob",
    "screw", "shit", "shitbag", "shite", "shitface", "shithead", "shitstain",
    "shitty", "shut the fuck up", "slut", "slutty", "son of a bitch", "spaz",
    "spic", "threesome", "tit", "tits", "titty", "tranny", "twat",
    "twatwaffle", "vibrator", "wank", "wanker", "wetback", "what the fuck",
    "whore"
  ];

  var CAPTION_PLACEHOLDER = "[ __ ]";

  var SUFFIXES = ["ing", "es", "ed", "er", "s", "y"];

  // Minimum length a suffix-stripped stem must have to be kept. Without
  // this, short entries like "ass" would strip their trailing "s" down
  // to "as" — a common, entirely innocent English word — and flag it.
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
  // ordinary "danger" — an extremely common, entirely innocent word —
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
  //   - "cumin" (the spice — a real cooking-content risk) strips via
  //     the dropped-g heuristic to a 3-letter slang entry.
  //   - "spiced"/"spicer"/"spicing"/"spicy" (all common cooking-content
  //     words) strip via "-ed"/"-er"/"-ing"/"-y" to a slur entry's
  //     4-letter root.
  // Every one of these is an extremely common, zero-ambiguity English
  // word with no real profane double-meaning — unlike some other
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
    "spicy"
  ]);

  // Strip leading/trailing punctuation/whitespace, lowercase. Asterisks
  // are treated as meaningful "core" characters (wildcard markers), not
  // punctuation, so they survive normalization — see isProfaneCore.
  // A trailing apostrophe (e.g. "fuckin'") is also stripped, since it's
  // almost always a dropped-g marker or a stray quote rather than part
  // of the word itself.
  function normalizeToken(token) {
    if (typeof token !== "string") return "";
    return token
      .toLowerCase()
      .replace(/^[^a-z0-9'*]+/i, "")
      .replace(/[^a-z0-9'*]+$/i, "")
      .replace(/'+$/, "");
  }

  // Return the set of "stems" for a normalized word: the word itself,
  // the word with any of the common suffixes stripped off (only when
  // the result is long enough to still be meaningful — see
  // MIN_STEM_LENGTH), and — for dropped-g forms like "fuckin"/"goin" —
  // the "g"-restored form and its own ing-stripped stem. This is
  // intentionally simple (no linguistic correctness), just enough to
  // let "damns"/"damned"/"damning" match "damn", and "fuckin"/"fuckin'"
  // match "fucking"/"fuck", in both directions (applied to both list
  // entries and input tokens).
  function stemsOf(word) {
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
  //     purpose — a bare "f***" gives no positional information beyond
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
  // only — multi-word phrases are handled separately by censorText).
  function buildStemSet(wordlist) {
    var set = new Set();
    for (var i = 0; i < wordlist.length; i++) {
      var entry = normalizeToken(wordlist[i]);
      if (!entry || entry.indexOf(" ") !== -1) continue; // phrase, skip here
      var stems = stemsOf(entry);
      for (var j = 0; j < stems.length; j++) set.add(stems[j]);
    }
    return set;
  }

  function buildPhraseList(wordlist) {
    var phrases = [];
    for (var i = 0; i < wordlist.length; i++) {
      var entry = normalizeSpaces(wordlist[i]);
      if (entry && entry.indexOf(" ") !== -1) phrases.push(entry);
    }
    // Longest first so overlapping phrases match the most specific one.
    phrases.sort(function (a, b) { return b.length - a.length; });
    return phrases;
  }

  function normalizeSpaces(s) {
    if (typeof s !== "string") return "";
    return s.toLowerCase().trim().replace(/\s+/g, " ");
  }

  // Index phrases by their first (normalized) word, so findMatchesCore
  // only ever compares against phrases that could plausibly start at
  // the current token — O(tokens) overall rather than O(tokens *
  // phrases). Each bucket is sorted longest-first (by word count) so
  // the longest phrase starting at a position wins.
  function buildPhraseIndex(wordlist) {
    var index = new Map();
    var phrases = buildPhraseList(wordlist);
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

  // findMatchesCore(tokens, stemSet, phraseIndex) -> [{index, length}]
  //
  // `tokens` is an array of already-transcribed words in order (as the
  // audio pipeline produces them). Returns one entry per match — either
  // a multi-word phrase (length = word count) or a single profane word
  // (length = 1, via the same isProfane/wildcard logic as isProfane()).
  // Linear time: each token does one Map lookup plus, at most, a short
  // scan of same-first-word phrase candidates.
  function findMatchesCore(tokens, stemSet, phraseIndex) {
    var matches = [];
    if (!Array.isArray(tokens) || tokens.length === 0) return matches;

    var normTokens = new Array(tokens.length);
    for (var t = 0; t < tokens.length; t++) {
      normTokens[t] = normalizeToken(tokens[t]);
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
            matches.push({ index: i, length: words.length });
            matchedPhrase = true;
            break; // bucket is longest-first
          }
        }
      }

      if (!matchedPhrase && isProfaneCore(tokens[i], stemSet)) {
        matches.push({ index: i, length: 1 });
      }
    }

    return matches;
  }

  // Is `word` (a single token, possibly with punctuation) profane
  // against the given stem set? Tokens containing '*' are routed to
  // the wildcard matcher (see rules documented above) instead of exact
  // stem lookup.
  function isProfaneCore(word, stemSet) {
    var norm = normalizeToken(word);
    if (!norm) return false;
    if (SAFE_WORDS.has(norm)) return false;
    if (tokenHasWildcard(norm)) {
      return isProfaneWildcard(norm, stemSet);
    }
    var stems = stemsOf(norm);
    for (var i = 0; i < stems.length; i++) {
      if (stemSet.has(stems[i])) return true;
    }
    return false;
  }

  function censorWord(word) {
    // Preserve any leading/trailing punctuation, censor the core token.
    // Asterisks are treated as part of the "core" (not punctuation) so
    // an already partially-censored token like "sh*t" is recognized as
    // one 4-character core and fully re-censored to "s***".
    var m = word.match(/^([^a-z0-9'*]*)([a-z0-9'*]*)([^a-z0-9'*]*)$/i);
    if (!m) return word;
    var lead = m[1], core = m[2], trail = m[3];
    if (!core) return word;
    return lead + core[0] + "*".repeat(Math.max(core.length - 1, 1)) + trail;
  }

  function censorTextCore(text, stemSet, phrases) {
    if (typeof text !== "string" || !text) return text;

    var result = text;

    // 1. YouTube auto-caption profanity placeholder is always censored.
    result = result.split(CAPTION_PLACEHOLDER).join("[ *** ]");

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
    result = result.replace(/[A-Za-z0-9'*]+(?:[^\sA-Za-z0-9'*]*)/g, function (token) {
      // token here is a word plus any trailing punctuation glued to it by
      // the regex; re-split via censorWord's own punctuation handling.
      if (isProfaneCore(token, stemSet)) {
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
    "pm_showStatus"
  ];

  var CATCHUP_MODES = ["mute", "pause", "play"];
  var DEFAULT_CATCHUP_MODE = "mute";

  // Pure defaulting logic for raw chrome.storage.sync.get() results.
  //
  // IMPORTANT: chrome.storage.sync.get() must be called with the ARRAY
  // form (a list of key names), never the "defaults object" form with
  // an `undefined`-valued key. Chrome's defaults-object form works by
  // merging the *own enumerable keys* of the object you pass in with
  // whatever storage returns — but a key whose value is `undefined`
  // is, for all practical purposes, treated as absent from that
  // request (this was the exact bug reported: pm_wordlist: undefined
  // in the defaults object meant `items.pm_wordlist` came back
  // `undefined` on EVERY call, even when a real custom list had been
  // saved, so a saved list silently had no effect). Doing our own
  // defaulting here, on the raw result of the array-form get(), avoids
  // that trap entirely and is unit-testable without chrome.* at all.
  //
  // A saved EMPTY array for pm_wordlist ([]) is honored as "no words"
  // — only a truly absent/undefined pm_wordlist falls back to
  // DEFAULT_WORDLIST (see rebuildFrom's matching comment).
  //
  // pm_catchupMode + legacy pm_safeMode migration:
  //   1. A valid, explicitly saved pm_catchupMode ("mute"/"pause"/
  //      "play") always wins outright.
  //   2. Otherwise, if pm_catchupMode has never been saved but the
  //      legacy pm_safeMode was explicitly saved as `false` (the user
  //      had turned safe mode off under the old two-setting schema),
  //      migrate that choice forward as catchupMode "play" — old
  //      "safe mode off" meant unanalyzed audio plays, which is
  //      exactly what "play" means now. This runs ONCE, implicitly,
  //      every time settings are resolved until the user picks a
  //      catch-up mode explicitly (at which point rule 1 takes over
  //      permanently since pm_catchupMode becomes saved).
  //   3. Otherwise (nothing saved at all, or pm_catchupMode is
  //      corrupted/mistyped/wrong-type) default to "mute".
  // pm_safeMode itself is no longer written by the popup — it is only
  // ever read here, for this migration.
  //
  // `safeMode` is kept in the returned shape too, but it is now a
  // DERIVED boolean (`catchupMode !== "play"`), not read independently
  // from storage — this preserves the PMWordlist.settings.safeMode
  // contract that content.js (the audio-pipeline agent's file) already
  // consumes, unchanged, even though there's no longer a separate
  // pm_safeMode toggle in the popup.
  //
  // pm_debugOverlay defaults to false (unlike the other booleans, which
  // default to true) — it's an opt-in diagnostic aid, off unless the
  // user explicitly turns it on.
  //
  // pm_showStatus defaults to true (like most other booleans, unlike
  // pm_debugOverlay) — it's a lightweight on-player status pill shown
  // by default, not an opt-in diagnostic.
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

    return {
      enabled: items.pm_enabled !== false,
      safeMode: catchupMode !== "play",
      muteAudio: items.pm_muteAudio !== false,
      censorCaptions: items.pm_censorCaptions !== false,
      catchupMode: catchupMode,
      debugOverlay: items.pm_debugOverlay === true,
      showStatus: items.pm_showStatus !== false,
      wordlist: Array.isArray(items.pm_wordlist) ? items.pm_wordlist : DEFAULT_WORDLIST
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
    isProfaneCore: isProfaneCore,
    censorTextCore: censorTextCore,
    findMatchesCore: findMatchesCore,
    resolveSettingsFromStorage: resolveSettingsFromStorage,
    STORAGE_KEYS: STORAGE_KEYS,
    CATCHUP_MODES: CATCHUP_MODES,
    DEFAULT_CATCHUP_MODE: DEFAULT_CATCHUP_MODE
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
    wordlist: DEFAULT_WORDLIST.slice(),
    stemSet: buildStemSet(DEFAULT_WORDLIST),
    phrases: buildPhraseList(DEFAULT_WORDLIST),
    phraseIndex: buildPhraseIndex(DEFAULT_WORDLIST)
  };

  // Minimal, stable-shape settings object handed to other content
  // scripts (the audio pipeline's content.js reads PMWordlist.settings
  // directly). Deliberately exactly these seven keys — no internal
  // Set/Map/array fields — so consumers can safely read or even
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
    showStatus: true
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
  // (items.pm_wordlist === undefined — see refresh()'s storage.get
  // default below).
  function rebuildFrom(list) {
    var wl = Array.isArray(list) ? list : DEFAULT_WORDLIST;
    state.wordlist = wl;
    state.stemSet = buildStemSet(wl);
    state.phrases = buildPhraseList(wl);
    state.phraseIndex = buildPhraseIndex(wl);
  }

  function refresh() {
    if (!hasChromeStorage()) {
      return Promise.resolve(state);
    }
    return new Promise(function (resolve) {
      try {
        // Array form, NOT the "defaults object" form — see
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
          rebuildFrom(resolved.wordlist);

          settings.enabled = resolved.enabled;
          settings.safeMode = resolved.safeMode;
          settings.muteAudio = resolved.muteAudio;
          settings.censorCaptions = resolved.censorCaptions;
          settings.catchupMode = resolved.catchupMode;
          settings.debugOverlay = resolved.debugOverlay;
          settings.showStatus = resolved.showStatus;

          resolve(state);
        });
      } catch (e) {
        resolve(state);
      }
    });
  }

  function isProfane(word) {
    if (!state.enabled) return false;
    return isProfaneCore(word, state.stemSet);
  }

  function censorText(text) {
    if (!state.enabled) return text;
    return censorTextCore(text, state.stemSet, state.phrases);
  }

  // findMatches(tokens) -> [{index, length}] against the live settings
  // (respects pm_enabled the same way isProfane/censorText do — when
  // disabled, no matches are reported). Intended for the audio
  // pipeline: tokens is an array of already-transcribed words in
  // order; each result covers either one profane word or one matched
  // multi-word phrase from the word list.
  function findMatches(tokens) {
    if (!state.enabled) return [];
    return findMatchesCore(tokens, state.stemSet, state.phraseIndex);
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
          changes.pm_showStatus
        ) {
          refresh();
        }
      });
    } catch (e) {
      // ignore — non-fatal if listener registration fails
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
    // reading pm_muteAudio) — always in sync with the last refresh().
    // Exactly {enabled, muteAudio, censorCaptions, safeMode,
    // catchupMode, debugOverlay, showStatus}, no internal Set/Map/array
    // fields.
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
