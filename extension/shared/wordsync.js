// shared/wordsync.js
// Plain script (NOT an ES module): content-script helper loaded before
// content.js, and require()d by test/wordsync_test.js. Defines globalThis.PMWordSync.
//
// When the user edits the word list mid-video, audio that was already
// analyzed has to be re-checked against the new list. The transcript is
// already held by the offscreen document (s.allWords), so this costs no new
// audio work: content.js asks for one resync and rebuilds its mute intervals.
//
// Idle cost is zero. The scheduler holds a timer only during the half second
// after a relevant edit, and keeps no data.
(function (root) {
  "use strict";

  var WATCHED = ["pm_additionalWords", "pm_strictness", "pm_allowWords"];

  // opts: refresh() -> Promise that resolves once the word list has reloaded;
  // post() sends the resync request; setTimeout/clearTimeout injectable.
  function createScheduler(opts) {
    var timer = null;
    var set = opts.setTimeout || setTimeout;
    var clear = opts.clearTimeout || clearTimeout;
    function fire() {
      timer = null;
      // Wait for the list to finish reloading: PMWordlist updates off the
      // same storage event asynchronously, so posting earlier would rebuild
      // against the old list.
      Promise.resolve(opts.refresh()).then(opts.post, opts.post);
    }
    function notify(changes, area) {
      if (area !== "sync" || !changes) return;
      var hit = false;
      for (var i = 0; i < WATCHED.length; i++) if (changes[WATCHED[i]]) hit = true;
      if (!hit) return;
      if (timer !== null) clear(timer);
      timer = set(fire, opts.delayMs == null ? 500 : opts.delayMs);
    }
    return { notify: notify };
  }

  function merge(list) {
    var sorted = list.slice().sort(function (a, b) { return a.start - b.start; });
    var merged = [];
    for (var i = 0; i < sorted.length; i++) {
      var cur = sorted[i];
      var last = merged[merged.length - 1];
      if (last && cur.start <= last.end) {
        last.end = Math.max(last.end, cur.end);
        if (last.word.indexOf(cur.word) === -1) last.word = last.word + "+" + cur.word;
      } else {
        merged.push({ start: cur.start, end: cur.end, word: cur.word, category: cur.category, canonical: cur.canonical });
      }
    }
    return merged;
  }

  // Rebuild mute intervals from the retained transcript. Offscreen keeps only
  // a trailing window of words, so intervals that end before the first
  // retained word are kept as they are rather than silently dropped.
  // activeKey is content.js's "already counted this mute" marker; it follows
  // the interval under the playhead so a rebuild never counts a mute twice.
  function rebuild(o) {
    var words = o.words || [];
    var kept = [];
    if (words.length) {
      var first = Infinity;
      for (var i = 0; i < words.length; i++) if (words[i].start < first) first = words[i].start;
      for (var j = 0; j < o.oldIntervals.length; j++) if (o.oldIntervals[j].end <= first) kept.push(o.oldIntervals[j]);
    } else {
      kept = o.oldIntervals.slice();
    }
    var intervals = merge(kept.concat(words.length ? o.applyWords(words).intervals : []));
    var activeKey = null;
    if (o.activeKey != null) {
      for (var k = 0; k < intervals.length; k++) {
        if (o.playhead >= intervals[k].start && o.playhead < intervals[k].end) { activeKey = o.keyOf(intervals[k]); break; }
      }
    }
    return { intervals: intervals, activeKey: activeKey };
  }

  var core = { createScheduler: createScheduler, rebuild: rebuild, merge: merge, WATCHED: WATCHED };
  root.PMWordSync = core;
  if (typeof module !== "undefined" && module.exports) module.exports = { PMWordSyncCore: core };
})(typeof globalThis !== "undefined" ? globalThis : this);
