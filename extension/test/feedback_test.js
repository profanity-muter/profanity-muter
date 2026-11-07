// test/feedback_test.js: timing + URL logic for the feedback nudge.
"use strict";
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { PMFeedback: F } = require(path.join(__dirname, "..", "shared", "feedback.js"));
const D = F.DAY;
let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error("FAIL: " + name + "\n  " + e.message); process.exit(1); } }

t("url carries only from and v", () => {
  assert.strictEqual(F.url("uninstall", "0.1.61"), "https://profanity-muter.github.io/feedback/?from=uninstall&v=0.1.61");
  assert.strictEqual(F.url("paused", "0.1.61"), "https://profanity-muter.github.io/feedback/?from=paused&v=0.1.61");
});
t("audioOff", () => {
  assert.strictEqual(F.audioOff({}), false);
  assert.strictEqual(F.audioOff({ pm_enabled: true, pm_muteAudio: true }), false);
  assert.strictEqual(F.audioOff({ pm_enabled: false }), true);
  assert.strictEqual(F.audioOff({ pm_muteAudio: false }), true);
});
t("offSincePatch", () => {
  assert.deepStrictEqual(F.offSincePatch(undefined, true, 5), { set: 5 });
  assert.strictEqual(F.offSincePatch(3, true, 5), null);
  assert.deepStrictEqual(F.offSincePatch(3, false, 5), { remove: true });
  assert.strictEqual(F.offSincePatch(undefined, false, 5), null);
});
t("nudgeDue: 7 day gate", () => {
  const now = 100 * D;
  assert.strictEqual(F.nudgeDue(undefined, undefined, now), false);
  assert.strictEqual(F.nudgeDue(now - 7 * D + 1, undefined, now), false);
  assert.strictEqual(F.nudgeDue(now - 7 * D, undefined, now), true);
});
t("nudgeDue: snooze", () => {
  const now = 100 * D;
  assert.strictEqual(F.nudgeDue(now - 20 * D, now + 1, now), false);
  assert.strictEqual(F.nudgeDue(now - 20 * D, now, now), true);
});
t("background wires the uninstall url", () => {
  const bg = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  assert.ok(/setUninstallURL\(\s*globalThis\.PMFeedback\.url\('uninstall'/.test(bg));
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.deepStrictEqual(m.permissions, ["storage", "offscreen"]);
  assert.deepStrictEqual(m.host_permissions, ["https://www.youtube.com/*"]);
});
console.log("feedback_test.js: " + n + "/" + n + " passed");
