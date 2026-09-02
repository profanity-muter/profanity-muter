// test/lock_test.js
// Node unit tests for shared/lock.js's pure core: the password hash
// round trip, record validation, and the single settings-write gate the
// popup routes every storage write through.
//
// Run with: node test/lock_test.js   (or npm test, from extension/)
//
// The hashing is tested against REAL WebCrypto (Node's own
// globalThis.crypto.subtle / getRandomValues), not a mock. shared/lock.js
// takes both as injected parameters precisely so this is possible - a
// mocked digest would prove only that the plumbing calls something, not
// that a password set on one day still verifies on another. The
// browser-side wrapper binds this same core to the popup's crypto.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMLockCore } = require(path.join(__dirname, "..", "shared", "lock.js"));

const subtle = globalThis.crypto && globalThis.crypto.subtle;
const getRandomValues =
  globalThis.crypto && globalThis.crypto.getRandomValues
    ? function (arr) { return globalThis.crypto.getRandomValues(arr); }
    : null;

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pending.push(
        result.then(
          function () { passed++; },
          function (e) {
            failed++;
            console.error("FAIL: " + name);
            console.error("      " + (e && e.message ? e.message : String(e)));
          }
        )
      );
      return;
    }
    passed++;
  } catch (e) {
    failed++;
    console.error("FAIL: " + name);
    console.error("      " + (e && e.message ? e.message : String(e)));
  }
}

// ---- environment ---------------------------------------------------------

test("this Node build actually has WebCrypto (otherwise the rest is vacuous)", () => {
  assert.ok(subtle, "crypto.subtle must exist");
  assert.ok(getRandomValues, "crypto.getRandomValues must exist");
});

// ---- hashing -------------------------------------------------------------

test("toHex renders bytes as lowercase two-digit hex, zero-padded", () => {
  assert.strictEqual(PMLockCore.toHex(new Uint8Array([0, 15, 16, 255])), "000f10ff");
});

test("hashPassword produces a stable 64-char SHA-256 hex digest", () =>
  PMLockCore.hashPassword("salt", "hunter2", subtle).then(function (hash) {
    assert.strictEqual(typeof hash, "string");
    assert.strictEqual(hash.length, 64);
    assert.ok(/^[0-9a-f]+$/.test(hash));
    return PMLockCore.hashPassword("salt", "hunter2", subtle).then(function (again) {
      assert.strictEqual(again, hash, "same salt + password must hash identically");
    });
  }));

test("the salt actually participates: same password, different salt, different hash", () =>
  Promise.all([
    PMLockCore.hashPassword("saltA", "hunter2", subtle),
    PMLockCore.hashPassword("saltB", "hunter2", subtle)
  ]).then(function (hashes) {
    assert.notStrictEqual(hashes[0], hashes[1]);
  }));

test("hashPassword rejects rather than inventing a digest when subtle is missing", () =>
  PMLockCore.hashPassword("salt", "pw", null).then(
    function () { throw new Error("should have rejected"); },
    function (e) { assert.ok(/unavailable/i.test(e.message)); }
  ));

test("makeSaltHex returns 16 random bytes as hex, and does not repeat", () => {
  const a = PMLockCore.makeSaltHex(getRandomValues);
  const b = PMLockCore.makeSaltHex(getRandomValues);
  assert.strictEqual(a.length, 32);
  assert.ok(/^[0-9a-f]+$/.test(a));
  assert.notStrictEqual(a, b);
});

test("makeSaltHex throws when getRandomValues is missing", () => {
  assert.throws(function () { PMLockCore.makeSaltHex(null); }, /unavailable/i);
});

// ---- create / verify round trip -----------------------------------------

test("createRecord then verifyRecord: the right password opens it", () =>
  PMLockCore.createRecord("correct horse", subtle, getRandomValues).then(function (record) {
    assert.ok(PMLockCore.isLockRecord(record));
    assert.strictEqual(record.salt.length, 32);
    assert.strictEqual(record.hash.length, 64);
    // The plaintext must appear nowhere in what gets stored.
    assert.strictEqual(JSON.stringify(record).indexOf("correct horse"), -1);
    return PMLockCore.verifyRecord(record, "correct horse", subtle).then(function (ok) {
      assert.strictEqual(ok, true);
    });
  }));

test("verifyRecord rejects the wrong password, including near misses", () =>
  PMLockCore.createRecord("hunter2", subtle, getRandomValues).then(function (record) {
    return Promise.all([
      PMLockCore.verifyRecord(record, "hunter3", subtle),
      PMLockCore.verifyRecord(record, "hunter2 ", subtle),
      PMLockCore.verifyRecord(record, "", subtle),
      PMLockCore.verifyRecord(record, "HUNTER2", subtle)
    ]).then(function (results) {
      assert.deepStrictEqual(results, [false, false, false, false]);
    });
  }));

test("two records for the SAME password differ (salted), and don't cross-verify wrongly", () =>
  Promise.all([
    PMLockCore.createRecord("same", subtle, getRandomValues),
    PMLockCore.createRecord("same", subtle, getRandomValues)
  ]).then(function (records) {
    assert.notStrictEqual(records[0].hash, records[1].hash);
    // Both still open with the right password - the salt is stored with
    // the record, so this must hold.
    return Promise.all([
      PMLockCore.verifyRecord(records[0], "same", subtle),
      PMLockCore.verifyRecord(records[1], "same", subtle)
    ]).then(function (oks) {
      assert.deepStrictEqual(oks, [true, true]);
    });
  }));

test("verifyRecord resolves false (never throws) for a malformed record", () =>
  Promise.all([
    PMLockCore.verifyRecord(null, "pw", subtle),
    PMLockCore.verifyRecord({}, "pw", subtle),
    PMLockCore.verifyRecord({ salt: "abc" }, "pw", subtle),
    PMLockCore.verifyRecord({ salt: "", hash: "" }, "pw", subtle),
    PMLockCore.verifyRecord("nonsense", "pw", subtle)
  ]).then(function (results) {
    assert.deepStrictEqual(results, [false, false, false, false, false]);
  }));

// ---- record shape --------------------------------------------------------

test("isLockRecord accepts only a complete {salt, hash}", () => {
  assert.strictEqual(PMLockCore.isLockRecord({ salt: "a", hash: "b" }), true);
  assert.strictEqual(PMLockCore.isLockRecord({ salt: "a" }), false);
  assert.strictEqual(PMLockCore.isLockRecord({ hash: "b" }), false);
  assert.strictEqual(PMLockCore.isLockRecord({ salt: "", hash: "b" }), false);
  assert.strictEqual(PMLockCore.isLockRecord({ salt: 1, hash: 2 }), false);
  assert.strictEqual(PMLockCore.isLockRecord(null), false);
  assert.strictEqual(PMLockCore.isLockRecord(undefined), false);
});

test("hashesEqual is a plain equality check that tolerates junk input", () => {
  assert.strictEqual(PMLockCore.hashesEqual("abc", "abc"), true);
  assert.strictEqual(PMLockCore.hashesEqual("abc", "abd"), false);
  assert.strictEqual(PMLockCore.hashesEqual("abc", "abcd"), false);
  assert.strictEqual(PMLockCore.hashesEqual(null, "abc"), false);
  assert.strictEqual(PMLockCore.hashesEqual("abc", undefined), false);
});

// ---- password validation -------------------------------------------------

test("validateNewPassword enforces length and confirmation", () => {
  assert.deepStrictEqual(PMLockCore.validateNewPassword("longenough", "longenough"), { ok: true });
  assert.strictEqual(PMLockCore.validateNewPassword("", "").ok, false);
  assert.strictEqual(PMLockCore.validateNewPassword("abc", "abc").ok, false); // < 4
  assert.strictEqual(PMLockCore.validateNewPassword("abcd", "abcd").ok, true);
  assert.strictEqual(PMLockCore.validateNewPassword("abcd", "abce").ok, false);
  assert.strictEqual(PMLockCore.validateNewPassword(null, null).ok, false);
});

test("validateNewPassword returns a message the popup can show verbatim", () => {
  assert.strictEqual(PMLockCore.validateNewPassword("ab", "ab").error, "Use at least 4 characters");
  assert.strictEqual(PMLockCore.validateNewPassword("abcd", "abcde").error, "Passwords don't match");
  assert.strictEqual(PMLockCore.validateNewPassword("", "").error, "Enter a password");
});

// ---- the settings-write gate --------------------------------------------
//
// This is the whole enforcement rule, in the one place it lives. The
// popup's persistSettings() consults exactly this before any write.

test("mayWriteSettings: no lock record at all -> writes allowed", () => {
  assert.strictEqual(PMLockCore.mayWriteSettings(null, false), true);
  assert.strictEqual(PMLockCore.mayWriteSettings(undefined, false), true);
});

test("mayWriteSettings: a valid lock blocks writes until this session unlocks", () => {
  const record = { salt: "a", hash: "b" };
  assert.strictEqual(PMLockCore.mayWriteSettings(record, false), false);
  assert.strictEqual(PMLockCore.mayWriteSettings(record, true), true);
});

test("mayWriteSettings: only a literal true unlocks (no truthy near-misses)", () => {
  const record = { salt: "a", hash: "b" };
  ["yes", 1, {}, [], "true"].forEach(function (v) {
    assert.strictEqual(PMLockCore.mayWriteSettings(record, v), false, String(v));
  });
});

test("mayWriteSettings: a CORRUPTED lock record fails open, not closed", () => {
  // Deliberate: the failure mode of a half-written or hand-edited record
  // must be "settings are editable again", never "this profile is bricked
  // until you reinstall the extension".
  assert.strictEqual(PMLockCore.mayWriteSettings({ salt: "a" }, false), true);
  assert.strictEqual(PMLockCore.mayWriteSettings({}, false), true);
  assert.strictEqual(PMLockCore.mayWriteSettings("nonsense", false), true);
});

// ---- summary -------------------------------------------------------------

Promise.all(pending).then(function () {
  console.log("lock_test.js: " + passed + "/" + (passed + failed) + " passed");
  if (failed) process.exit(1);
});
