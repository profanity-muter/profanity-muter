// test/badge_test.js
// Node unit tests for shared/badge.js: the whole toolbar decision table.
//
// Run with: node test/badge_test.js   (or npm test, from extension/)
//
// This file is table-driven because the badge IS a table, and because its
// failure mode is silence. The 0.1.56 field report was a user who could not
// tell whether she was protected, and the reason was a state that produced
// no badge text. A row-per-state table is the only way to assert that every
// state produces something, including states nobody thought about: the
// fallthrough row below is the test that would have caught the original bug.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMBadgeCore } = require(path.join(__dirname, "..", "shared", "badge.js"));

const B = PMBadgeCore;

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

// A tab that is on a watch page with the extension on. Each row below
// changes exactly one thing about it.
function watching(extra) {
  return Object.assign({ isWatchPage: true, enabled: true, mutedCount: 0 }, extra || {});
}

// ---- the decision table --------------------------------------------------
//
// Every row of the 0.1.56 spec, in priority order. `label` is what the row
// is for, so a failure names the user-visible behaviour rather than an
// input shape.
const TABLE = [
  {
    label: "health failure in this tab outranks everything",
    state: watching({ healthStatus: "unhealthy", presented: "protected", mutedCount: 12 }),
    text: "!",
    color: B.COLOR_HEALTH,
    iconSet: B.ICON_COLOR
  },
  {
    label: "health failure outranks a routine state too",
    state: watching({ healthStatus: "unhealthy", presented: "analyzing" }),
    text: "!",
    color: B.COLOR_HEALTH,
    iconSet: B.ICON_COLOR
  },
  {
    label: "not a YouTube watch page: silent and faded",
    state: { isWatchPage: false, enabled: true },
    text: "",
    color: null,
    iconSet: B.ICON_OFF
  },
  {
    label: "no state reported at all: silent and faded",
    state: {},
    text: "",
    color: null,
    iconSet: B.ICON_OFF
  },
  {
    label: "extension disabled: silent and faded",
    state: watching({ enabled: false, presented: "off" }),
    text: "",
    color: null,
    iconSet: B.ICON_OFF
  },
  {
    label: "the pill says off: silent and faded",
    state: watching({ presented: "off" }),
    text: "",
    color: null,
    iconSet: B.ICON_OFF
  },
  {
    label: "documented limit, Shorts: silent and faded",
    state: watching({ presented: "shorts" }),
    text: "",
    color: null,
    iconSet: B.ICON_OFF
  },
  {
    label: "documented limit, livestream: silent and faded",
    state: watching({ presented: "live" }),
    text: "",
    color: null,
    iconSet: B.ICON_OFF
  },
  {
    label: "analyzing: amber ellipsis",
    state: watching({ presented: "analyzing" }),
    text: B.TEXT_WORKING,
    color: B.COLOR_WORKING,
    iconSet: B.ICON_COLOR
  },
  {
    label: "waiting for play: amber ellipsis",
    state: watching({ presented: "needs-play" }),
    text: B.TEXT_WORKING,
    color: B.COLOR_WORKING,
    iconSet: B.ICON_COLOR
  },
  {
    label: "another tab is being filtered: amber ellipsis",
    state: watching({ presented: "other-tab" }),
    text: B.TEXT_WORKING,
    color: B.COLOR_WORKING,
    iconSet: B.ICON_COLOR
  },
  {
    label: "a presented state nobody has thought of yet: amber, never blank",
    state: watching({ presented: "some-future-state" }),
    text: B.TEXT_WORKING,
    color: B.COLOR_WORKING,
    iconSet: B.ICON_COLOR
  },
  {
    label: "on a watch page with no pill state yet: amber, never blank",
    state: watching({ presented: null }),
    text: B.TEXT_WORKING,
    color: B.COLOR_WORKING,
    iconSet: B.ICON_COLOR
  },
  {
    label: "protected, nothing muted yet: green ON",
    state: watching({ presented: "protected", mutedCount: 0 }),
    text: "ON",
    color: B.COLOR_PROTECTED,
    iconSet: B.ICON_COLOR
  },
  {
    label: "protected, one word muted: green 1",
    state: watching({ presented: "protected", mutedCount: 1 }),
    text: "1",
    color: B.COLOR_PROTECTED,
    iconSet: B.ICON_COLOR
  },
  {
    label: "protected, many words muted: green count",
    state: watching({ presented: "protected", mutedCount: 37 }),
    text: "37",
    color: B.COLOR_PROTECTED,
    iconSet: B.ICON_COLOR
  },
  {
    label: "protected, count at the cap: green 99",
    state: watching({ presented: "protected", mutedCount: 99 }),
    text: "99",
    color: B.COLOR_PROTECTED,
    iconSet: B.ICON_COLOR
  },
  {
    label: "protected, count past the cap: green 99+",
    state: watching({ presented: "protected", mutedCount: 4000 }),
    text: "99+",
    color: B.COLOR_PROTECTED,
    iconSet: B.ICON_COLOR
  }
];

TABLE.forEach(function (row) {
  test("badgeState: " + row.label, () => {
    const d = B.badgeState(row.state);
    assert.strictEqual(d.text, row.text, "text");
    assert.strictEqual(d.color, row.color, "color");
    assert.strictEqual(d.iconSet, row.iconSet, "iconSet");
  });
});

// ---- the rules the table implies -----------------------------------------

test("badgeState never returns undefined for any shape", () => {
  [undefined, null, {}, { presented: 7 }, { isWatchPage: "yes" }].forEach(function (s) {
    const d = B.badgeState(s);
    assert.strictEqual(typeof d.text, "string");
    assert.ok(d.iconSet === B.ICON_COLOR || d.iconSet === B.ICON_OFF);
  });
});

test("every badge string fits Chrome's four-character budget", () => {
  // Chrome truncates past about four characters, and a truncated count is
  // worse than no count: it is a wrong number.
  [B.TEXT_HEALTH, B.TEXT_WORKING, B.TEXT_PROTECTED_ZERO, B.COUNT_CAP_TEXT].forEach(function (t) {
    assert.ok(t.length <= B.MAX_BADGE_CHARS, JSON.stringify(t));
  });
  [0, 1, 9, 10, 99, 100, 1e9].forEach(function (n) {
    assert.ok(B.countText(n).length <= B.MAX_BADGE_CHARS, String(n));
  });
});

test("the working text is one ellipsis glyph, not three periods", () => {
  assert.strictEqual(B.TEXT_WORKING, "…");
  assert.strictEqual(B.TEXT_WORKING.length, 1);
});

test("countText treats junk and zero as ON rather than showing a zero", () => {
  // A green "0" reads as a score. The thing reported is protection.
  [0, -4, NaN, null, undefined, "x"].forEach(function (n) {
    assert.strictEqual(B.countText(n), "ON", String(n));
  });
  assert.strictEqual(B.countText(3.7), "3", "a fractional count floors rather than showing a decimal");
});

test("green means protected and nothing else means green", () => {
  // If green ever appears on a state that is not protected, the one colour
  // a user can read at a glance stops meaning anything.
  const greens = TABLE.filter(function (r) { return r.color === B.COLOR_PROTECTED; });
  greens.forEach(function (r) {
    assert.strictEqual(r.state.presented, "protected", r.label);
    assert.notStrictEqual(r.state.healthStatus, "unhealthy", r.label);
  });
  assert.ok(greens.length >= 5, "the green rows are actually covered");
});

test("a faded icon is always silent, and a badge always rides a colour icon", () => {
  // Text on a greyed-out icon would be the extension talking about a tab it
  // is not working on.
  TABLE.forEach(function (row) {
    const d = B.badgeState(row.state);
    if (d.iconSet === B.ICON_OFF) {
      assert.strictEqual(d.text, "", row.label);
      assert.strictEqual(d.color, null, row.label);
    } else {
      assert.notStrictEqual(d.text, "", row.label);
      assert.ok(typeof d.color === "string", row.label);
    }
  });
});

test("health outranks every other row, checked against the whole table", () => {
  // The priority promise has held since 0.1.33 and moved here with the
  // code in 0.1.56. Asserted by replaying every row with a health failure
  // laid over it rather than by trusting the branch order.
  TABLE.forEach(function (row) {
    const broken = Object.assign({}, row.state, { healthStatus: "unhealthy" });
    const d = B.badgeState(broken);
    assert.strictEqual(d.text, B.TEXT_HEALTH, row.label);
    assert.strictEqual(d.color, B.COLOR_HEALTH, row.label);
  });
});

test("only 'unhealthy' badges: the other health statuses are not faults", () => {
  // UNSUPPORTED is a limit and PENDING/OK say nothing worth a mark.
  ["unsupported", "pending", "ok", null, undefined].forEach(function (status) {
    const d = B.badgeState(watching({ healthStatus: status, presented: "protected", mutedCount: 2 }));
    assert.strictEqual(d.text, "2", String(status));
  });
});

// ---- summary -------------------------------------------------------------

console.log("badge_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
