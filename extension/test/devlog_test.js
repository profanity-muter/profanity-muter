// test/devlog_test.js
// Node unit tests for shared/devlog.js's pure core (PMDevlogCore) - the
// ring buffer, the size guard, the entry/window shapes, and the caption
// diff. Run with:
//
//   node test/devlog_test.js        (or: npm test, from extension/)
//
// Same pattern as the wordlist tests (CENSOR_NOTES.md "Test results"):
// shared/devlog.js is a plain script, not an ES module, and exposes its
// chrome-free core via module.exports specifically so it can be require()d
// here. Nothing in this file touches chrome.*, the DOM, or timers - if a
// test ever needs to, the thing it is testing has leaked out of the core
// and belongs on the browser-wiring side of that file instead.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMDevlogCore } = require(path.join(__dirname, "..", "shared", "devlog.js"));

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

// Build an entry whose serialized size is dominated by `windowCount`
// windows, each carrying a chunk of transcript text (the verbose-mode
// worst case, and the shape the size guard is written against).
function bigEntry(videoId, windowCount, textLen) {
  const entry = PMDevlogCore.createEntry({
    videoId: videoId,
    title: "video " + videoId,
    version: "0.1.28",
    startedAt: 1000,
    settings: {
      enabled: true,
      strictness: "strict",
      wordlistSource: "strictness:strict",
      wordCount: 123,
      catchupMode: "mute",
      muteAudio: true,
      censorCaptions: true,
      padding: "normal"
    }
  });
  for (let i = 0; i < windowCount; i++) {
    entry.windows.push(
      PMDevlogCore.normalizeWindow(
        {
          t0: i * 10,
          t1: i * 10 + 10,
          transcriptWordCount: 20,
          matches: [{ word: "damn", t: i * 10 + 3 }],
          muteIntervals: [{ start: i * 10 + 2.65, end: i * 10 + 3.5 }],
          text: "x".repeat(textLen)
        },
        true
      )
    );
  }
  return entry;
}

// ---- entry shape ---------------------------------------------------------

test("createEntry produces the documented shape with sane defaults", () => {
  const e = PMDevlogCore.createEntry({ videoId: "abc", version: "0.1.28" });
  assert.strictEqual(e.videoId, "abc");
  assert.strictEqual(e.version, "0.1.28");
  assert.strictEqual(e.title, null);
  assert.strictEqual(typeof e.startedAt, "number");
  assert.deepStrictEqual(e.windows, []);
  assert.deepStrictEqual(e.gaps, []);
  assert.deepStrictEqual(e.captions, []);
  assert.strictEqual(e.captionCount, 0);
  assert.deepStrictEqual(e.errors, []);
  assert.strictEqual(e.truncated, false);
});

test("createEntry coerces a missing videoId rather than storing undefined", () => {
  const e = PMDevlogCore.createEntry({});
  assert.strictEqual(e.videoId, "unknown");
  assert.strictEqual(e.version, "unknown");
});

test("createEntry keeps the settings snapshot verbatim, without the word list", () => {
  const settings = {
    enabled: true,
    strictness: "custom",
    wordlistSource: "strictness:custom",
    wordCount: 3,
    catchupMode: "play",
    muteAudio: false,
    censorCaptions: true,
    padding: "wide"
  };
  const e = PMDevlogCore.createEntry({ videoId: "v", settings: settings });
  assert.deepStrictEqual(e.settings, settings);
  assert.ok(!("wordlist" in e.settings), "settings must never carry the word list itself");
});

// ---- normalizeWindow -----------------------------------------------------

test("normalizeWindow rounds timestamps to 2dp and keeps matches + intervals", () => {
  const w = PMDevlogCore.normalizeWindow(
    {
      t0: 12.340000000000002,
      t1: 22.5,
      transcriptWordCount: 41,
      matches: [{ word: "shit", t: 15.126 }],
      muteIntervals: [{ start: 14.776, end: 15.62 }]
    },
    false
  );
  assert.strictEqual(w.t0, 12.34);
  assert.strictEqual(w.t1, 22.5);
  assert.strictEqual(w.transcriptWordCount, 41);
  assert.deepStrictEqual(w.matches, [{ word: "shit", t: 15.13 }]);
  assert.deepStrictEqual(w.muteIntervals, [{ start: 14.78, end: 15.62 }]);
});

test("normalizeWindow omits transcript text unless verbose", () => {
  const src = { t0: 0, t1: 10, transcriptWordCount: 2, text: "hello there" };
  assert.strictEqual("text" in PMDevlogCore.normalizeWindow(src, false), false);
  assert.strictEqual(PMDevlogCore.normalizeWindow(src, true).text, "hello there");
});

test("normalizeWindow tolerates a window with no matches at all", () => {
  const w = PMDevlogCore.normalizeWindow({ t0: 0, t1: 10, transcriptWordCount: 0 }, false);
  assert.deepStrictEqual(w.matches, []);
  assert.deepStrictEqual(w.muteIntervals, []);
});

test("normalizeWindow maps NaN/absent times to null instead of NaN", () => {
  const w = PMDevlogCore.normalizeWindow({ t0: NaN, t1: undefined }, false);
  assert.strictEqual(w.t0, null);
  assert.strictEqual(w.t1, null);
});

// ---- pushCapped ----------------------------------------------------------

test("pushCapped keeps the newest items, oldest-first", () => {
  const list = [];
  for (let i = 0; i < 10; i++) PMDevlogCore.pushCapped(list, i, 3);
  assert.deepStrictEqual(list, [7, 8, 9]);
});

// ---- ring buffer (mergeEntry) -------------------------------------------

test("mergeEntry appends onto an absent/empty log", () => {
  const log = PMDevlogCore.mergeEntry(undefined, PMDevlogCore.createEntry({ videoId: "a" }));
  assert.strictEqual(log.videos.length, 1);
  assert.strictEqual(log.videos[0].videoId, "a");
  assert.strictEqual(log.version, PMDevlogCore.SCHEMA_VERSION);
});

test("mergeEntry keeps only the 10 most recent videos, oldest evicted first", () => {
  let log = PMDevlogCore.emptyLog();
  for (let i = 0; i < 14; i++) {
    log = PMDevlogCore.mergeEntry(log, PMDevlogCore.createEntry({ videoId: "v" + i }));
  }
  assert.strictEqual(log.videos.length, PMDevlogCore.MAX_VIDEOS);
  assert.strictEqual(log.videos[0].videoId, "v4"); // v0..v3 evicted
  assert.strictEqual(log.videos[9].videoId, "v13");
});

test("mergeEntry upserts by videoId instead of duplicating a re-watch", () => {
  let log = PMDevlogCore.emptyLog();
  log = PMDevlogCore.mergeEntry(log, PMDevlogCore.createEntry({ videoId: "a", title: "first" }));
  log = PMDevlogCore.mergeEntry(log, PMDevlogCore.createEntry({ videoId: "b" }));
  log = PMDevlogCore.mergeEntry(log, PMDevlogCore.createEntry({ videoId: "a", title: "second" }));
  assert.strictEqual(log.videos.length, 2);
  // "a" moved to the newest slot and carries the NEW entry's data.
  assert.strictEqual(log.videos[0].videoId, "b");
  assert.strictEqual(log.videos[1].videoId, "a");
  assert.strictEqual(log.videos[1].title, "second");
});

test("mergeEntry does not mutate the log it was handed", () => {
  const original = PMDevlogCore.emptyLog();
  original.videos.push(PMDevlogCore.createEntry({ videoId: "a" }));
  const next = PMDevlogCore.mergeEntry(original, PMDevlogCore.createEntry({ videoId: "b" }));
  assert.strictEqual(original.videos.length, 1);
  assert.strictEqual(next.videos.length, 2);
});

test("normalizeLog replaces a corrupted/foreign stored value wholesale", () => {
  assert.deepStrictEqual(PMDevlogCore.normalizeLog(null), PMDevlogCore.emptyLog());
  assert.deepStrictEqual(PMDevlogCore.normalizeLog("nonsense"), PMDevlogCore.emptyLog());
  assert.deepStrictEqual(PMDevlogCore.normalizeLog({ videos: "nope" }), PMDevlogCore.emptyLog());
});

// ---- size guard ----------------------------------------------------------

test("enforceSizeCap is a no-op for a log already under budget", () => {
  let log = PMDevlogCore.emptyLog();
  log.videos.push(bigEntry("a", 3, 50));
  const before = JSON.stringify(log);
  const after = PMDevlogCore.enforceSizeCap(log, PMDevlogCore.MAX_BYTES);
  assert.strictEqual(JSON.stringify(after), before);
  assert.strictEqual(after.videos[0].truncated, false);
});

test("enforceSizeCap drops the OLDEST videos first and brings the log under budget", () => {
  let log = PMDevlogCore.emptyLog();
  for (let i = 0; i < 10; i++) log.videos.push(bigEntry("v" + i, 40, 800));
  assert.ok(
    PMDevlogCore.serializedSize(log) > PMDevlogCore.MAX_BYTES,
    "fixture must start over the 256KB budget"
  );
  const capped = PMDevlogCore.enforceSizeCap(log, PMDevlogCore.MAX_BYTES);
  assert.ok(PMDevlogCore.serializedSize(capped) <= PMDevlogCore.MAX_BYTES);
  assert.ok(capped.videos.length < 10, "some videos must have been dropped");
  // Whatever survived is a contiguous, newest-ending slice.
  assert.strictEqual(capped.videos[capped.videos.length - 1].videoId, "v9");
  const firstKeptIndex = 10 - capped.videos.length;
  assert.strictEqual(capped.videos[0].videoId, "v" + firstKeptIndex);
});

test("enforceSizeCap never drops the newest video whole, trimming its oldest windows instead", () => {
  let log = PMDevlogCore.emptyLog();
  // A single video far over the cap by itself: video-dropping can't help.
  log.videos.push(bigEntry("only", 400, 900));
  assert.ok(PMDevlogCore.serializedSize(log) > PMDevlogCore.MAX_BYTES);
  const capped = PMDevlogCore.enforceSizeCap(log, PMDevlogCore.MAX_BYTES);
  assert.strictEqual(capped.videos.length, 1);
  assert.strictEqual(capped.videos[0].videoId, "only");
  assert.ok(PMDevlogCore.serializedSize(capped) <= PMDevlogCore.MAX_BYTES);
  assert.ok(capped.videos[0].windows.length < 400, "windows must have been trimmed");
  assert.strictEqual(capped.videos[0].truncated, true);
  // The OLDEST windows went; the newest (t0 = 3990) is still there.
  assert.strictEqual(
    capped.videos[0].windows[capped.videos[0].windows.length - 1].t0,
    3990
  );
  assert.ok(capped.videos[0].windows[0].t0 > 0, "oldest windows must be the ones dropped");
});

test("enforceSizeCap keeps captionCount even when caption events get trimmed", () => {
  const entry = PMDevlogCore.createEntry({ videoId: "c" });
  entry.captionCount = 900;
  for (let i = 0; i < 400; i++) {
    entry.captions.push({ t: i, original: "damn", censored: "d***" });
  }
  const log = { version: 1, videos: [entry] };
  // A cap small enough that the captions themselves have to go.
  const capped = PMDevlogCore.enforceSizeCap(log, 2000);
  assert.ok(capped.videos[0].captions.length < 400);
  assert.strictEqual(capped.videos[0].captionCount, 900);
  assert.strictEqual(capped.videos[0].truncated, true);
});

test("enforceSizeCap terminates on an entry it cannot shrink below the cap", () => {
  // Nothing droppable left: everything is in the non-list fields.
  const entry = PMDevlogCore.createEntry({ videoId: "x".repeat(5000) });
  const capped = PMDevlogCore.enforceSizeCap({ version: 1, videos: [entry] }, 100);
  assert.strictEqual(capped.videos.length, 1);
});

test("serializedSize reports Infinity for an unserializable log rather than throwing", () => {
  const circular = { version: 1, videos: [] };
  circular.videos.push({ self: circular });
  assert.strictEqual(PMDevlogCore.serializedSize(circular), Infinity);
});

// ---- caption diff --------------------------------------------------------

test("diffCensored returns the changed words only", () => {
  assert.deepStrictEqual(
    PMDevlogCore.diffCensored("what the fuck is this", "what the f*** is this"),
    [{ original: "fuck", censored: "f***" }]
  );
});

test("diffCensored handles a multi-word phrase censored word-by-word", () => {
  assert.deepStrictEqual(
    PMDevlogCore.diffCensored("oh my god that hurt", "o* m* g** that hurt"),
    [
      { original: "oh", censored: "o*" },
      { original: "my", censored: "m*" },
      { original: "god", censored: "g**" }
    ]
  );
});

test("diffCensored returns [] when nothing changed", () => {
  assert.deepStrictEqual(PMDevlogCore.diffCensored("clean text", "clean text"), []);
});

test("diffCensored returns null (count-only) when token counts don't align", () => {
  // substringMode packs can reshape tokens; no per-word attribution is
  // possible, and inventing one would be worse than reporting a count.
  assert.strictEqual(PMDevlogCore.diffCensored("a b c", "a b"), null);
});

test("diffCensored ignores non-string input", () => {
  assert.deepStrictEqual(PMDevlogCore.diffCensored(null, "x"), []);
  assert.deepStrictEqual(PMDevlogCore.diffCensored("x", undefined), []);
});

// ---- summary -------------------------------------------------------------

console.log("devlog_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
