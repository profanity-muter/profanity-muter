// shared/stats.js
// Plain script (NOT an ES module). Defines globalThis.PMStats. Loaded by
// popup/popup.html (to read/summarize) and by content.js (to record). Like
// shared/wordlist.js and shared/lock.js, the pure core here has zero
// dependency on chrome.* or the DOM (see PMStatsCore) so it can be
// require()d directly under Node for unit tests.
//
// WHAT THIS IS
// ------------
// The bounded, LOCAL-ONLY activity store behind the popup's Activity
// dashboard (0.1.51). It records, per calendar day, how many words were
// muted, how many videos were protected, a per-category breakdown
// (profanity / slur / religious / euphemism / custom), and a capped
// per-word count for the "most muted" list. The popup summarizes it over
// three ranges: 24h (today), 7d (the last seven calendar days), and
// all-time.
//
// PRIVACY
// -------
// Everything here lives in chrome.storage.LOCAL and is NEVER uploaded - the
// extension's no-telemetry promise holds. The only strings stored are the
// user's own added words and the built-in list's canonical entries (the
// same entries that already ship in shared/wordlist.js); no transcript
// text, no URLs, no video ids.
//
// BOUNDED BY DESIGN
// -----------------
// Three caps keep this from growing without limit no matter how much a user
// watches:
//   * days: only the most recent MAX_DAYS calendar buckets are kept (older
//     ones are dropped - the 24h and 7d ranges never look past 7 days, and
//     all-time is served by a separate running rollup that needs no history).
//   * per-day word maps: capped to MAX_WORDS_PER_DAY entries, lowest counts
//     pruned first.
//   * the all-time word map: capped to MAX_WORDS_ALLTIME entries (>= the 100
//     the popup shows), lowest counts pruned first.
// Category counts are five fixed keys and cannot grow. A day bucket is a
// handful of small integers plus a capped word map, so the whole store is
// kilobytes even for a heavy multi-year user.

(function (root) {
  "use strict";

  var STORAGE_KEY = "pm_activity";
  var VERSION = 1;
  var CATEGORIES = ["profanity", "slur", "religious", "euphemism", "custom"];

  // Retention: 7d is the widest windowed range, so 7 would be the strict
  // minimum; a little slack (covering a rolling 24h that spans a midnight
  // and giving the "most muted over 7d" merge a full week of buckets even
  // as a new day starts) without being unbounded.
  var MAX_DAYS = 10;
  var MAX_WORDS_PER_DAY = 120;
  var MAX_WORDS_ALLTIME = 300;
  var TOP_WORDS_LIMIT = 100; // what the popup's "most muted (top N)" shows

  // Ranges the popup offers. rangeDays drives the windowed ("24h"/"7d")
  // summaries; "all" is served by the running rollup instead.
  var RANGES = ["24h", "7d", "all"];
  var RANGE_DAYS = { "24h": 1, "7d": 7 };

  function isFiniteNum(n) {
    return typeof n === "number" && isFinite(n);
  }

  function n0(v) {
    var x = Number(v);
    return isFiniteNum(x) && x > 0 ? Math.floor(x) : 0;
  }

  // Local calendar date "YYYY-MM-DD" for a timestamp. Local, not UTC, so a
  // user's "today" matches their wall clock (the range labels are for a
  // person looking at their own day, not a server).
  function dayKey(now) {
    var d = new Date(typeof now === "number" ? now : Date.now());
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return y + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
  }

  function emptyCats() {
    var c = {};
    for (var i = 0; i < CATEGORIES.length; i++) c[CATEGORIES[i]] = 0;
    return c;
  }

  function emptyBucket() {
    return { muted: 0, videos: 0, cats: emptyCats(), words: {} };
  }

  function emptyStore() {
    return { v: VERSION, allTime: emptyBucket(), days: {} };
  }

  function normalizeCats(raw) {
    var out = emptyCats();
    if (raw && typeof raw === "object") {
      for (var i = 0; i < CATEGORIES.length; i++) {
        out[CATEGORIES[i]] = n0(raw[CATEGORIES[i]]);
      }
    }
    return out;
  }

  function normalizeWords(raw, cap) {
    var out = {};
    if (!raw || typeof raw !== "object") return out;
    var keys = Object.keys(raw);
    var pairs = [];
    for (var i = 0; i < keys.length; i++) {
      var c = n0(raw[keys[i]]);
      if (c > 0) pairs.push([keys[i], c]);
    }
    if (pairs.length > cap) {
      pairs.sort(function (a, b) { return b[1] - a[1]; });
      pairs = pairs.slice(0, cap);
    }
    for (var j = 0; j < pairs.length; j++) out[pairs[j][0]] = pairs[j][1];
    return out;
  }

  function normalizeBucket(raw, wordCap) {
    var b = emptyBucket();
    if (raw && typeof raw === "object") {
      b.muted = n0(raw.muted);
      b.videos = n0(raw.videos);
      b.cats = normalizeCats(raw.cats);
      b.words = normalizeWords(raw.words, wordCap);
    }
    return b;
  }

  // Defensive parse of whatever is in storage into a valid store. A
  // corrupted or absent value reads as an empty store rather than throwing.
  function normalizeStore(raw) {
    var store = emptyStore();
    if (!raw || typeof raw !== "object") return store;
    store.allTime = normalizeBucket(raw.allTime, MAX_WORDS_ALLTIME);
    if (raw.days && typeof raw.days === "object") {
      var keys = Object.keys(raw.days);
      // Keep only the most recent MAX_DAYS by date string (ISO dates sort
      // lexicographically, so a plain sort is chronological).
      keys.sort();
      if (keys.length > MAX_DAYS) keys = keys.slice(keys.length - MAX_DAYS);
      for (var i = 0; i < keys.length; i++) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(keys[i])) continue;
        store.days[keys[i]] = normalizeBucket(raw.days[keys[i]], MAX_WORDS_PER_DAY);
      }
    }
    return store;
  }

  function pruneWords(words, cap) {
    var keys = Object.keys(words);
    if (keys.length <= cap) return words;
    var pairs = keys.map(function (k) { return [k, words[k]]; });
    pairs.sort(function (a, b) { return b[1] - a[1]; });
    var out = {};
    for (var i = 0; i < cap; i++) out[pairs[i][0]] = pairs[i][1];
    return out;
  }

  function bumpBucket(bucket, category, word, isNewVideo, wordCap) {
    bucket.muted += 1;
    if (isNewVideo) bucket.videos += 1;
    var cat = CATEGORIES.indexOf(category) !== -1 ? category : "profanity";
    bucket.cats[cat] = (bucket.cats[cat] || 0) + 1;
    if (typeof word === "string" && word) {
      var key = word.toLowerCase();
      bucket.words[key] = (bucket.words[key] || 0) + 1;
      if (Object.keys(bucket.words).length > wordCap + 20) {
        // Prune lazily (only once we drift past the cap) so the common path
        // is a single increment, not a full sort every mute.
        bucket.words = pruneWords(bucket.words, wordCap);
      }
    }
  }

  // Record one mute. Returns the updated store (the input is normalized and
  // mutated defensively, never trusted in place). `event`:
  //   { category, word, isNewVideo, now }
  // `isNewVideo` is true exactly once per protected video (the caller owns
  // that signal - it already tracks "first mute for this video" for the
  // legacy pm_stats.videosProtected counter), so videos are counted without
  // this module ever storing a video id.
  function recordMute(store, event) {
    store = normalizeStore(store);
    event = event || {};
    var dk = dayKey(event.now);
    if (!store.days[dk]) store.days[dk] = emptyBucket();
    bumpBucket(store.days[dk], event.category, event.word, event.isNewVideo, MAX_WORDS_PER_DAY);
    bumpBucket(store.allTime, event.category, event.word, event.isNewVideo, MAX_WORDS_ALLTIME);

    // Drop day buckets older than the retention window.
    var keys = Object.keys(store.days);
    if (keys.length > MAX_DAYS) {
      keys.sort();
      var drop = keys.slice(0, keys.length - MAX_DAYS);
      for (var i = 0; i < drop.length; i++) delete store.days[drop[i]];
    }
    return store;
  }

  // The last N calendar-day keys ending today (most recent first is not
  // needed - we sum them). Includes days with no bucket (they contribute
  // zero), so "7d" always means a full seven-day window.
  function recentDayKeys(now, count) {
    var out = [];
    var base = new Date(typeof now === "number" ? now : Date.now());
    for (var i = 0; i < count; i++) {
      var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
      out.push(dayKey(d.getTime()));
    }
    return out;
  }

  function mergeInto(target, bucket) {
    target.muted += bucket.muted;
    target.videos += bucket.videos;
    for (var i = 0; i < CATEGORIES.length; i++) {
      target.cats[CATEGORIES[i]] += bucket.cats[CATEGORIES[i]] || 0;
    }
    var keys = Object.keys(bucket.words);
    for (var j = 0; j < keys.length; j++) {
      target.words[keys[j]] = (target.words[keys[j]] || 0) + bucket.words[keys[j]];
    }
  }

  function topWords(words, limit) {
    var pairs = Object.keys(words).map(function (k) { return { word: k, count: words[k] }; });
    pairs.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.word < b.word ? -1 : a.word > b.word ? 1 : 0;
    });
    return pairs.slice(0, limit);
  }

  // Summarize the store over a range for the popup. Returns:
  //   { muted, videos, cats: {profanity,slur,religious,euphemism,custom},
  //     top: [{word, count}, ...] (up to TOP_WORDS_LIMIT) }
  // Category order in `cats` is CATEGORIES order; the popup decides display.
  function summarize(store, range, now) {
    store = normalizeStore(store);
    if (RANGES.indexOf(range) === -1) range = "all";
    var agg;
    if (range === "all") {
      agg = normalizeBucket(store.allTime, MAX_WORDS_ALLTIME);
    } else {
      agg = emptyBucket();
      var days = recentDayKeys(now, RANGE_DAYS[range]);
      for (var i = 0; i < days.length; i++) {
        if (store.days[days[i]]) mergeInto(agg, store.days[days[i]]);
      }
    }
    return {
      muted: agg.muted,
      videos: agg.videos,
      cats: agg.cats,
      top: topWords(agg.words, TOP_WORDS_LIMIT)
    };
  }

  var PMStatsCore = {
    STORAGE_KEY: STORAGE_KEY,
    VERSION: VERSION,
    CATEGORIES: CATEGORIES,
    RANGES: RANGES,
    RANGE_DAYS: RANGE_DAYS,
    MAX_DAYS: MAX_DAYS,
    MAX_WORDS_PER_DAY: MAX_WORDS_PER_DAY,
    MAX_WORDS_ALLTIME: MAX_WORDS_ALLTIME,
    TOP_WORDS_LIMIT: TOP_WORDS_LIMIT,
    dayKey: dayKey,
    emptyStore: emptyStore,
    emptyBucket: emptyBucket,
    normalizeStore: normalizeStore,
    recordMute: recordMute,
    recentDayKeys: recentDayKeys,
    summarize: summarize,
    topWords: topWords
  };

  root.PMStats = {
    STORAGE_KEY: STORAGE_KEY,
    CATEGORIES: CATEGORIES,
    RANGES: RANGES,
    summarize: summarize,
    normalizeStore: normalizeStore,
    recordMute: recordMute,
    emptyStore: emptyStore,
    _core: PMStatsCore
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMStatsCore: PMStatsCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
