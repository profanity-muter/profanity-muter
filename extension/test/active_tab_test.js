// test/active_tab_test.js
// Node unit tests for shared/active_tab.js: which single YouTube tab the one
// shared analysis pipeline should follow.
//
// Run with: node test/active_tab_test.js   (or npm test, from extension/)
//
// The rule matters because the pipeline is single-threaded and single-model:
// picking the wrong tab starves the video the user is actually watching,
// which is the same silent-failure class as a filter that has stopped
// filtering. These tests hold the priority straight: focus beats play, play
// beats a paused backlog, and a lone tab is always the answer.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMActiveTabCore } = require(path.join(__dirname, "..", "shared", "active_tab.js"));

const A = PMActiveTabCore;

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

function tab(over) {
  return Object.assign({ tabId: 1, playing: false, lastActiveWall: 0 }, over || {});
}

// ---- degenerate cases ------------------------------------------------------

test("no candidates yields null", () => {
  assert.strictEqual(A.choose([], {}), null);
  assert.strictEqual(A.choose(null, {}), null);
  assert.strictEqual(A.choose(undefined, undefined), null);
});

test("a single candidate always wins, whatever its state", () => {
  assert.strictEqual(A.choose([tab({ tabId: 7, playing: false })], {}), 7);
  assert.strictEqual(A.choose([tab({ tabId: 7, playing: true })], { focusedTabId: 999 }), 7);
});

test("candidates without a numeric tabId are ignored", () => {
  const list = [{ tabId: null, playing: true }, tab({ tabId: 4 })];
  assert.strictEqual(A.choose(list, {}), 4);
});

// ---- rule 1: focus wins ----------------------------------------------------

test("the focused YouTube tab wins even while paused", () => {
  const list = [
    tab({ tabId: 1, playing: true, lastActiveWall: 100 }),
    tab({ tabId: 2, playing: false, lastActiveWall: 50 })
  ];
  assert.strictEqual(A.choose(list, { focusedTabId: 2 }), 2);
});

test("focus wins over another tab that is playing", () => {
  const list = [
    tab({ tabId: 1, playing: true, lastActiveWall: 200 }),
    tab({ tabId: 2, playing: false, lastActiveWall: 10 })
  ];
  assert.strictEqual(A.choose(list, { focusedTabId: 2 }), 2);
});

test("a focusedTabId that is not a candidate does not force a null", () => {
  // The user is focused on a non-YouTube tab; a playing YouTube tab still wins.
  const list = [
    tab({ tabId: 1, playing: true, lastActiveWall: 5 }),
    tab({ tabId: 2, playing: false, lastActiveWall: 9 })
  ];
  assert.strictEqual(A.choose(list, { focusedTabId: 555 }), 1);
});

// ---- rule 2: the playing tab wins when focus is elsewhere -------------------

test("with focus elsewhere, the one playing tab is served", () => {
  const list = [
    tab({ tabId: 1, playing: false, lastActiveWall: 900 }),
    tab({ tabId: 2, playing: true, lastActiveWall: 100 })
  ];
  assert.strictEqual(A.choose(list, {}), 2);
});

test("multiple playing tabs: the most recently activated one wins", () => {
  const list = [
    tab({ tabId: 1, playing: true, lastActiveWall: 100 }),
    tab({ tabId: 2, playing: true, lastActiveWall: 300 }),
    tab({ tabId: 3, playing: true, lastActiveWall: 200 })
  ];
  assert.strictEqual(A.choose(list, {}), 2);
});

// ---- rule 3: nothing focused, nothing playing ------------------------------

test("all paused, none focused: hold the most recently activated tab", () => {
  const list = [
    tab({ tabId: 1, playing: false, lastActiveWall: 10 }),
    tab({ tabId: 2, playing: false, lastActiveWall: 40 }),
    tab({ tabId: 3, playing: false, lastActiveWall: 20 })
  ];
  assert.strictEqual(A.choose(list, {}), 2);
});

test("ties break deterministically toward the lowest tabId", () => {
  const list = [
    tab({ tabId: 8, playing: false, lastActiveWall: 0 }),
    tab({ tabId: 3, playing: false, lastActiveWall: 0 })
  ];
  assert.strictEqual(A.choose(list, {}), 3);
});

// ---- the switch: re-binding follows the user -------------------------------

test("switching focus re-binds to the newly focused tab", () => {
  const list = [
    tab({ tabId: 1, playing: true, lastActiveWall: 100 }),
    tab({ tabId: 2, playing: true, lastActiveWall: 100 })
  ];
  assert.strictEqual(A.choose(list, { focusedTabId: 1 }), 1);
  assert.strictEqual(A.choose(list, { focusedTabId: 2 }), 2);
});

test("closing the served tab hands the pipeline to the survivor", () => {
  // Two tabs, tab 2 focused and served. Tab 2 closes; only tab 1 remains.
  const before = [
    tab({ tabId: 1, playing: true, lastActiveWall: 50 }),
    tab({ tabId: 2, playing: false, lastActiveWall: 80 })
  ];
  assert.strictEqual(A.choose(before, { focusedTabId: 2 }), 2);
  const after = [tab({ tabId: 1, playing: true, lastActiveWall: 50 })];
  assert.strictEqual(A.choose(after, { focusedTabId: 2 }), 1);
});

console.log("active_tab_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed > 0) process.exit(1);
