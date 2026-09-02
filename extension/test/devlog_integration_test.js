// test/devlog_integration_test.js
// Node tests for shared/devlog.js's BROWSER WIRING - the half that
// devlog_test.js deliberately doesn't touch: the in-memory current entry,
// the batched read-modify-write against chrome.storage.local, the
// pm_devlogVerbose gate, and the pre-session error buffer.
//
// Same approach as the wordlist integration tests (CENSOR_NOTES.md "Test
// results"): stub `chrome` and `window` on globalThis BEFORE requiring the
// file, since devlog.js reads storage and registers listeners at load time.
// Storage callbacks fire synchronously here, which keeps the tests free of
// timers - the one thing that is deliberately NOT simulated is the 5s flush
// timer, because every test drives the write explicitly through flushNow()
// and then asserts that nothing else wrote on its own.
//
// Run with: node test/devlog_integration_test.js

"use strict";

const assert = require("assert");
const path = require("path");

// ---- chrome / window stubs (installed before the require below) ----------

const store = { local: {}, sync: {} };
let localSetCount = 0;
const changeListeners = [];

function makeArea(bag, onSet) {
  return {
    get: function (keys, cb) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) {
        if (k in bag) out[k] = bag[k];
      });
      cb(out);
    },
    set: function (obj, cb) {
      Object.keys(obj).forEach(function (k) {
        // Round-trip through JSON the way real storage does, so a test can
        // never accidentally assert against a live object reference the
        // module still holds.
        bag[k] = JSON.parse(JSON.stringify(obj[k]));
      });
      if (onSet) onSet();
      if (cb) cb();
    }
  };
}

globalThis.chrome = {
  runtime: { lastError: undefined, getManifest: function () { return { version: "0.1.28" }; } },
  storage: {
    local: makeArea(store.local, function () { localSetCount++; }),
    sync: makeArea(store.sync),
    onChanged: {
      addListener: function (fn) { changeListeners.push(fn); }
    }
  }
};
globalThis.window = { addEventListener: function () {} };

const { PMDevlogCore } = require(path.join(__dirname, "..", "shared", "devlog.js"));
const PMDevlog = globalThis.PMDevlog;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    // Each test starts from a clean storage + a clean module-side entry.
    store.local = {};
    chrome.storage.local = makeArea(store.local, function () { localSetCount++; });
    localSetCount = 0;
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error("FAIL: " + name);
    console.error("      " + (e && e.message ? e.message : String(e)));
  }
}

function storedLog() {
  return store.local.pm_devlog;
}

// ---- module surface ------------------------------------------------------

test("PMDevlog is defined on globalThis with the documented API", () => {
  assert.ok(PMDevlog, "globalThis.PMDevlog must exist after loading devlog.js");
  ["startVideo", "updateMeta", "logWindow", "logGap", "logCaptionCensor", "logError",
   "setTimeSource", "flushNow"].forEach(function (m) {
    assert.strictEqual(typeof PMDevlog[m], "function", m + " must be a function");
  });
  assert.strictEqual(PMDevlog._core, PMDevlogCore);
});

// ---- write batching ------------------------------------------------------

test("logging does not write to storage on every event", () => {
  PMDevlog.startVideo("batch1", { title: "t", version: "0.1.28", settings: {} });
  const afterStart = localSetCount;
  for (let i = 0; i < 50; i++) {
    PMDevlog.logWindow({ t0: i, t1: i + 1, transcriptWordCount: 5, matches: [], muteIntervals: [] });
  }
  assert.strictEqual(localSetCount, afterStart, "50 windows must not cause 50 writes");
  PMDevlog.flushNow();
  assert.strictEqual(localSetCount, afterStart + 1, "flushNow writes exactly once");
  assert.strictEqual(storedLog().videos[0].windows.length, 50);
});

test("flushNow is a no-op when nothing changed since the last write", () => {
  PMDevlog.startVideo("batch2", {});
  PMDevlog.flushNow();
  const after = localSetCount;
  PMDevlog.flushNow();
  assert.strictEqual(localSetCount, after);
});

// ---- entry content -------------------------------------------------------

test("a video's entry captures settings, windows, gaps, captions and errors", () => {
  PMDevlog.setTimeSource(function () { return 61.5; });
  PMDevlog.startVideo("vid-A", {
    title: "Some Video",
    version: "0.1.28",
    settings: {
      enabled: true,
      strictness: "strict",
      wordlistSource: "strictness:strict",
      wordCount: 120,
      catchupMode: "play",
      muteAudio: true,
      censorCaptions: true,
      padding: "normal"
    }
  });
  PMDevlog.logWindow({
    t0: 60,
    t1: 70,
    transcriptWordCount: 22,
    matches: [{ word: "shit", t: 64.12 }],
    muteIntervals: [{ start: 63.77, end: 64.6 }],
    text: "this is the full transcript"
  });
  PMDevlog.logGap({ start: 70, end: 78.5, mode: "play" });
  PMDevlog.logCaptionCensor("well shit that hurt", "well s*** that hurt");
  PMDevlog.logError("boom");
  PMDevlog.flushNow();

  const e = storedLog().videos[0];
  assert.strictEqual(e.videoId, "vid-A");
  assert.strictEqual(e.title, "Some Video");
  assert.strictEqual(e.version, "0.1.28");
  assert.strictEqual(e.settings.wordlistSource, "strictness:strict");
  assert.strictEqual(e.settings.wordCount, 120);
  assert.ok(!("wordlist" in e.settings));

  assert.strictEqual(e.windows.length, 1);
  assert.deepStrictEqual(e.windows[0].matches, [{ word: "shit", t: 64.12 }]);
  assert.deepStrictEqual(e.windows[0].muteIntervals, [{ start: 63.77, end: 64.6 }]);

  assert.deepStrictEqual(e.gaps, [{ start: 70, end: 78.5, mode: "play" }]);

  assert.strictEqual(e.captionCount, 1);
  assert.deepStrictEqual(e.captions, [{ t: 61.5, original: "shit", censored: "s***" }]);

  assert.strictEqual(e.errors.length, 1);
  assert.strictEqual(e.errors[0].text, "boom");
  assert.strictEqual(e.errors[0].t, 61.5);
});

test("transcripts are withheld unless pm_devlogVerbose is on", () => {
  PMDevlog.startVideo("vid-quiet", {});
  PMDevlog.logWindow({ t0: 0, t1: 10, transcriptWordCount: 3, text: "one two three" });
  PMDevlog.flushNow();
  assert.strictEqual("text" in storedLog().videos[0].windows[0], false);

  // Flip the sync-storage flag the way the popup/console would; the module
  // picks it up through its own onChanged listener.
  assert.ok(changeListeners.length > 0, "devlog.js must register a sync onChanged listener");
  changeListeners.forEach(function (fn) {
    fn({ pm_devlogVerbose: { newValue: true } }, "sync");
  });
  PMDevlog.startVideo("vid-loud", {});
  PMDevlog.logWindow({ t0: 0, t1: 10, transcriptWordCount: 3, text: "one two three" });
  PMDevlog.flushNow();
  const videos = storedLog().videos;
  assert.strictEqual(videos[videos.length - 1].windows[0].text, "one two three");

  // Put it back so later tests see the default.
  changeListeners.forEach(function (fn) {
    fn({ pm_devlogVerbose: { newValue: false } }, "sync");
  });
});

test("zero-length gaps are dropped rather than recorded", () => {
  PMDevlog.startVideo("vid-gap", {});
  PMDevlog.logGap({ start: 10, end: 10 });
  PMDevlog.logGap({ start: 10, end: 9 });
  PMDevlog.logGap({ start: 10, end: 12, mode: "mute" });
  PMDevlog.flushNow();
  assert.deepStrictEqual(storedLog().videos[0].gaps, [{ start: 10, end: 12, mode: "mute" }]);
});

test("a caption pass that changed nothing records nothing", () => {
  PMDevlog.startVideo("vid-clean", {});
  PMDevlog.logCaptionCensor("nothing to see here", "nothing to see here");
  PMDevlog.flushNow();
  // flushNow writes because startVideo already marked the entry dirty; the
  // point is that no caption event was recorded.
  assert.strictEqual(storedLog().videos[0].captionCount, 0);
  assert.deepStrictEqual(storedLog().videos[0].captions, []);
});

// ---- ring behaviour through storage --------------------------------------

test("switching videos flushes the outgoing entry before opening the next", () => {
  PMDevlog.startVideo("first", {});
  PMDevlog.logWindow({ t0: 0, t1: 10, transcriptWordCount: 1 });
  // No explicit flush: starting the next video must persist the previous.
  PMDevlog.startVideo("second", {});
  assert.strictEqual(storedLog().videos.length, 1);
  assert.strictEqual(storedLog().videos[0].videoId, "first");
  assert.strictEqual(storedLog().videos[0].windows.length, 1);
});

test("the ring keeps the last 10 videos across separate flushes", () => {
  for (let i = 0; i < 13; i++) {
    PMDevlog.startVideo("v" + i, {});
    PMDevlog.logWindow({ t0: 0, t1: 5, transcriptWordCount: 1 });
  }
  PMDevlog.flushNow();
  const ids = storedLog().videos.map(function (v) { return v.videoId; });
  assert.strictEqual(ids.length, 10);
  assert.deepStrictEqual(ids, ["v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12"]);
});

test("a re-watch updates the existing entry instead of taking a second slot", () => {
  PMDevlog.startVideo("a", { title: "first pass" });
  PMDevlog.startVideo("b", {});
  PMDevlog.startVideo("a", { title: "second pass" });
  PMDevlog.flushNow();
  const videos = storedLog().videos;
  assert.strictEqual(videos.length, 2);
  assert.strictEqual(videos[1].videoId, "a");
  assert.strictEqual(videos[1].title, "second pass");
});

test("a corrupted pm_devlog in storage is replaced, not merged into", () => {
  store.local.pm_devlog = "not a log at all";
  PMDevlog.startVideo("recovered", {});
  PMDevlog.flushNow();
  assert.strictEqual(storedLog().videos.length, 1);
  assert.strictEqual(storedLog().videos[0].videoId, "recovered");
});

// ---- pre-session errors --------------------------------------------------

test("errors logged before any video starts attach to the first entry", () => {
  // Mirrors content.js reality: connectPort() can TERROR during startup,
  // before its first resetSession() call opens an entry.
  PMDevlog.logError("startup failure");
  PMDevlog.startVideo("late", {});
  PMDevlog.flushNow();
  const errors = storedLog().videos[0].errors;
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].text, "startup failure");
});

// ---- resilience ----------------------------------------------------------

test("a throwing time source degrades to a null timestamp, not an exception", () => {
  PMDevlog.setTimeSource(function () { throw new Error("no video"); });
  PMDevlog.startVideo("vid-notime", {});
  PMDevlog.logError("something");
  PMDevlog.flushNow();
  assert.strictEqual(storedLog().videos[0].errors[0].t, null);
  PMDevlog.setTimeSource(null);
});

test("a storage failure never throws into the caller", () => {
  chrome.storage.local = {
    get: function () { throw new Error("storage exploded"); },
    set: function () { throw new Error("storage exploded"); }
  };
  PMDevlog.startVideo("vid-broken", {});
  PMDevlog.logWindow({ t0: 0, t1: 1, transcriptWordCount: 0 });
  PMDevlog.flushNow(); // must not throw
  assert.ok(true);
});

// ---- summary -------------------------------------------------------------

console.log("devlog_integration_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
