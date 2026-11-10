// test/refresh_notice_test.js
// Node unit tests for shared/refresh_notice.js: when the popup tells the
// user to refresh a YouTube tab, and which tabs the setup page offers to
// refresh. Run with: node test/refresh_notice_test.js (or npm test).
"use strict";

const assert = require("assert");
const path = require("path");
const { PMRefreshNoticeCore: R } = require(path.join(__dirname, "..", "shared", "refresh_notice.js"));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + name + "\n      " + e.message); }
}

const YT = { id: 3, url: "https://www.youtube.com/watch?v=abc" };

test("youtube url detection", () => {
  assert.strictEqual(R.isYouTubeUrl("https://www.youtube.com/"), true);
  assert.strictEqual(R.isYouTubeUrl("https://www.youtube.com/watch?v=x"), true);
  assert.strictEqual(R.isYouTubeUrl("https://m.youtube.com/watch"), false);
  assert.strictEqual(R.isYouTubeUrl("https://example.com/https://www.youtube.com/"), false);
  assert.strictEqual(R.isYouTubeUrl(undefined), false);
  assert.strictEqual(R.isYouTubeUrl(null), false);
});

test("youtube tab with no content script (message failed) needs a refresh", () => {
  assert.strictEqual(R.needsRefresh(YT, undefined, true), true);
});

test("youtube tab whose content script reports an invalidated context needs a refresh", () => {
  assert.strictEqual(R.needsRefresh(YT, { contextInvalid: true }, false), true);
});

test("youtube tab that answered normally needs nothing", () => {
  assert.strictEqual(R.needsRefresh(YT, { status: "ok" }, false), false);
  assert.strictEqual(R.needsRefresh(YT, { status: "unhealthy", message: "x" }, false), false);
});

test("non-youtube tab never shows the notice, even when the message failed", () => {
  assert.strictEqual(R.needsRefresh({ id: 1, url: "https://example.com/" }, undefined, true), false);
  assert.strictEqual(R.needsRefresh({ id: 1, url: "chrome://extensions" }, undefined, true), false);
});

test("url undefined (no host access to the tab) falls back to showing nothing", () => {
  assert.strictEqual(R.needsRefresh({ id: 1 }, undefined, true), false);
  assert.strictEqual(R.needsRefresh({ id: 1, url: undefined }, { contextInvalid: true }, false), false);
});

test("missing tab shows nothing", () => {
  assert.strictEqual(R.needsRefresh(null, undefined, true), false);
});

test("tabsToRefresh keeps only tabs with an id", () => {
  assert.deepStrictEqual(R.tabIds([{ id: 4 }, { id: 9 }, {}, null]), [4, 9]);
  assert.deepStrictEqual(R.tabIds([]), []);
  assert.deepStrictEqual(R.tabIds(undefined), []);
});

test("copy has no em-dash and is plain", () => {
  const all = Object.values(R.COPY).join(" ");
  assert.ok(all.indexOf(String.fromCharCode(0x2014)) === -1);
  assert.strictEqual(R.COPY.popupNotice, "Refresh this page to start filtering.");
  assert.strictEqual(R.COPY.popupButton, "Refresh page");
  assert.strictEqual(R.COPY.setupLine, "You have YouTube open already. Refresh it so Profanity Muter can start.");
  assert.strictEqual(R.COPY.setupButton, "Refresh YouTube tabs");
});

console.log("refresh_notice_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed > 0) process.exit(1);
