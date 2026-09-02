// shared/lock.js
// Plain script (NOT an ES module), loaded by popup/popup.html only -
// nothing in the content-script path consults the lock, so it is
// deliberately absent from manifest.json's content_scripts. Defines
// globalThis.PMLock.
//
// WHAT THIS IS
// ------------
// An optional parental lock over the popup's settings. When
// chrome.storage.sync's `pm_lock` is present, the popup opens with every
// setting disabled and asks for a password; entering it correctly unlocks
// the settings for THAT POPUP SESSION ONLY (closing the popup re-locks -
// there is no persisted "unlocked" flag, deliberately: a persisted one
// would survive the parent walking away).
//
// WHAT THIS IS NOT
// ----------------
// It is a DETERRENT, not security, and the UI says so in as many words.
// Everything here runs in the child's own browser profile: anyone who can
// open chrome://extensions can inspect the popup, clear the extension's
// storage, or simply remove the extension. The lock raises the effort of
// changing a setting from "one click" to "know that chrome://extensions
// exists and be willing to visibly wipe the extension" - which is the
// entire product goal. Do not describe it, in code or in copy, as
// anything stronger. A forgotten password is not recoverable: the plain
// answer is "remove and re-add the extension (or clear its storage)",
// and that is exactly what the popup's caption says.
//
// Storage schema (chrome.storage.sync):
//   pm_lock  {salt: string, hash: string} | absent
//            salt - 16 random bytes, hex (32 chars)
//            hash - SHA-256(salt + password), hex (64 chars)
//            The plaintext password is NEVER stored, anywhere. Sync (not
//            local) so a lock set on one device roams with the profile,
//            like every other setting.
//
// The salt exists for one plain reason: it stops the stored hash of a
// common password ("1234") from being recognizable at a glance, and stops
// two devices/families with the same password from sharing a hash. It is
// NOT meaningful protection against an offline attacker with the storage
// dump - a single SHA-256 pass is trivially brute-forceable against a
// short password. Key stretching (PBKDF2/scrypt) would change that, and
// was deliberately skipped: the threat model here is a curious child with
// access to the machine, for whom clearing storage is already easier than
// cracking anything.
//
// Like shared/wordlist.js and shared/devlog.js, the pure logic here works
// with zero dependency on chrome.* or the DOM - see PMLockCore - so it
// can be require()d directly under Node for unit tests. WebCrypto is
// reached through injectable parameters (a `subtle` and a
// `getRandomValues`) rather than closed over, so the tests exercise the
// real hashing path against Node's own WebCrypto rather than a mock.

(function (root) {
  "use strict";

  // Short enough not to be a nuisance for a parent typing on a phone-sized
  // popup, long enough that "1" isn't a password. Not a security control
  // - see the header.
  var MIN_PASSWORD_LENGTH = 4;

  // ======================================================================
  // PURE CORE - no chrome.*, no DOM, no ambient crypto. Exported for Node.
  // ======================================================================

  function toHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      out += h.length === 1 ? "0" + h : h;
    }
    return out;
  }

  // Is this a well-formed lock record? Anything else (absent, a leftover
  // partial write, a hand-edited value) is treated as NO LOCK rather than
  // as a lock nobody can open - the failure mode of a corrupted record
  // must be "settings are editable again", never "this profile is bricked
  // until you reinstall".
  function isLockRecord(value) {
    return !!(
      value &&
      typeof value === "object" &&
      typeof value.salt === "string" &&
      value.salt.length > 0 &&
      typeof value.hash === "string" &&
      value.hash.length > 0
    );
  }

  // Validate a new password + confirmation. Returns {ok: true} or
  // {ok: false, error: "..."} with a message the popup shows verbatim.
  function validateNewPassword(password, confirmation) {
    if (typeof password !== "string" || !password) {
      return { ok: false, error: "Enter a password" };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, error: "Use at least " + MIN_PASSWORD_LENGTH + " characters" };
    }
    if (password !== confirmation) {
      return { ok: false, error: "Passwords don't match" };
    }
    return { ok: true };
  }

  // Length-independent string compare. Genuinely constant-time comparison
  // is not achievable in JS and would be pointless here anyway (the
  // attacker already holds the hash if they can read storage) - this is
  // just a plain equality check written so it reads as deliberate
  // rather than as an oversight.
  function hashesEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  // SHA-256(salt + password) -> hex, via an injected WebCrypto `subtle`.
  // Rejects (rather than resolving to something useless) when subtle is
  // missing, so callers make an explicit decision about the no-crypto
  // case instead of silently storing a broken record.
  function hashPassword(salt, password, subtle) {
    if (!subtle || typeof subtle.digest !== "function") {
      return Promise.reject(new Error("WebCrypto subtle unavailable"));
    }
    var encoder = new TextEncoder();
    var data = encoder.encode(String(salt) + String(password));
    return Promise.resolve(subtle.digest("SHA-256", data)).then(function (buf) {
      return toHex(new Uint8Array(buf));
    });
  }

  // 16 random bytes as hex, via an injected getRandomValues.
  function makeSaltHex(getRandomValues) {
    if (typeof getRandomValues !== "function") {
      throw new Error("WebCrypto getRandomValues unavailable");
    }
    var bytes = new Uint8Array(16);
    getRandomValues(bytes);
    return toHex(bytes);
  }

  // Build a fresh {salt, hash} record for `password`.
  function createRecord(password, subtle, getRandomValues) {
    var salt;
    try {
      salt = makeSaltHex(getRandomValues);
    } catch (e) {
      return Promise.reject(e);
    }
    return hashPassword(salt, password, subtle).then(function (hash) {
      return { salt: salt, hash: hash };
    });
  }

  // Does `password` open `record`? Resolves false (never rejects) for a
  // malformed record, so a corrupted lock reads as "no valid lock" at
  // every layer.
  function verifyRecord(record, password, subtle) {
    if (!isLockRecord(record)) return Promise.resolve(false);
    return hashPassword(record.salt, password, subtle).then(
      function (hash) {
        return hashesEqual(hash, record.hash);
      },
      function () {
        return false;
      }
    );
  }

  // The central lock gate. `true` means a settings write may proceed.
  //
  // This is the ONE place the rule lives: a write is allowed when there is
  // no valid lock record at all, or when this popup session has been
  // unlocked. Everything that persists a setting routes through the
  // popup's single persistSettings() funnel, which asks this - no
  // per-handler checks to keep in sync, and a future options page inherits
  // the rule by using the same funnel.
  function mayWriteSettings(lockRecord, unlockedThisSession) {
    if (!isLockRecord(lockRecord)) return true;
    return unlockedThisSession === true;
  }

  var PMLockCore = {
    MIN_PASSWORD_LENGTH: MIN_PASSWORD_LENGTH,
    toHex: toHex,
    isLockRecord: isLockRecord,
    validateNewPassword: validateNewPassword,
    hashesEqual: hashesEqual,
    hashPassword: hashPassword,
    makeSaltHex: makeSaltHex,
    createRecord: createRecord,
    verifyRecord: verifyRecord,
    mayWriteSettings: mayWriteSettings
  };

  // ======================================================================
  // BROWSER WIRING - the same core with this context's WebCrypto bound in.
  // ======================================================================

  function subtleOrNull() {
    if (typeof crypto === "undefined" || !crypto) return null;
    return crypto.subtle || null;
  }

  function randomOrNull() {
    if (typeof crypto === "undefined" || !crypto) return null;
    if (typeof crypto.getRandomValues !== "function") return null;
    return function (arr) {
      return crypto.getRandomValues(arr);
    };
  }

  // Can this context set a lock at all? Extension pages are secure
  // contexts so crypto.subtle is there in practice; guarded anyway (the
  // devlog.js posture - a missing capability degrades the feature, never
  // breaks the popup). When false, the popup hides the lock control and
  // says why rather than offering a button that can't work.
  function available() {
    return !!subtleOrNull() && !!randomOrNull();
  }

  root.PMLock = {
    MIN_PASSWORD_LENGTH: MIN_PASSWORD_LENGTH,
    available: available,
    isLockRecord: isLockRecord,
    validateNewPassword: validateNewPassword,
    mayWriteSettings: mayWriteSettings,
    create: function (password) {
      return createRecord(password, subtleOrNull(), randomOrNull());
    },
    verify: function (record, password) {
      return verifyRecord(record, password, subtleOrNull());
    },
    // exposed for tests; not part of the contract the popup uses
    _core: PMLockCore
  };

  // Also expose the core for Node-based unit testing via module.exports,
  // without turning this file into an ES module (same pattern as
  // shared/wordlist.js and shared/devlog.js).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMLockCore: PMLockCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
