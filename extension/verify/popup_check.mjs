// verify/popup_check.mjs
// Headless popup verification: loads popup/popup.html in real Chromium
// with chrome.storage stubbed, drives the UI, and asserts what the user
// actually ends up seeing and what actually reaches storage.
//
//   npm run verify:popup     (~5 seconds, headless, no network)
//
// Why this exists alongside the Node unit tests: the unit tests cover the
// pure cores (the migration table in shared/wordlist.js, the lock gate in
// shared/lock.js), but the two properties that matter most in 0.1.29 are
// properties of the RENDERED PAGE, and neither is reachable from a pure
// test:
//
//   1. The built-in lists' contents never appear on screen. Asserted
//      literally, against document.body.innerText.
//   2. A locked popup does not write. Asserted the way a determined kid
//      would actually try it — by clearing the `disabled` attribute from
//      devtools and dispatching the change event anyway, which must still
//      write nothing, because the enforcement is in persistSettings and
//      not in the DOM state.
//
// Unlike verify/run_playwright.mjs (headful, real YouTube, minutes, a
// Whisper model download), this touches nothing outside the popup page —
// so it is cheap enough to run on every change to popup/, shared/lock.js
// or the word-list resolution.
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const URL = pathToFileURL(path.join(EXT, 'popup', 'popup.html')).href;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

const stub = (initialSync, initialLocal) => `
  window.__pmSync = ${JSON.stringify(initialSync)};
  window.__pmLocal = ${JSON.stringify(initialLocal || {})};
  window.__pmWrites = [];
  function area(bag, label) {
    return {
      get(keys, cb) {
        const out = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in bag) out[k] = bag[k]; });
        setTimeout(() => cb(out), 0);
      },
      set(obj, cb) {
        window.__pmWrites.push({ area: label, keys: Object.keys(obj), obj: JSON.parse(JSON.stringify(obj)) });
        Object.assign(bag, JSON.parse(JSON.stringify(obj)));
        if (cb) setTimeout(cb, 0);
      },
      remove(key, cb) {
        window.__pmWrites.push({ area: label, remove: key });
        delete bag[key];
        if (cb) setTimeout(cb, 0);
      }
    };
  }
  window.chrome = {
    runtime: { lastError: undefined, getManifest: () => ({ version: '0.1.29' }) },
    storage: {
      sync: area(window.__pmSync, 'sync'),
      local: area(window.__pmLocal, 'local'),
      onChanged: { addListener() {} }
    }
  };
`;

async function open(browser, sync, local) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(stub(sync, local));
  await page.goto(URL);
  await page.waitForTimeout(150);
  return { page, errors };
}

const snapshot = () => ({
  textarea: document.getElementById('pm-wordlist').value,
  modeNote: document.getElementById('pm-wordlist-mode-note').textContent.trim(),
  level: [...document.getElementsByName('pm-strictness')].find(r => r.checked)?.value,
  maskedText: document.getElementById('pm-masked-list').textContent.trim(),
  enabledDisabled: document.getElementById('pm-enabled').disabled,
  saveDisabled: document.getElementById('pm-save').disabled,
  copyDisabled: document.getElementById('pm-copy-devlog').disabled,
  toggleMaskDisabled: document.getElementById('pm-toggle-mask').disabled,
  resetStatsDisabled: document.getElementById('pm-reset-stats').disabled,
  lockSetupHidden: document.getElementById('pm-lock-setup').classList.contains('pm-hidden'),
  lockLockedHidden: document.getElementById('pm-lock-locked').classList.contains('pm-hidden'),
  lockUnlockedHidden: document.getElementById('pm-lock-unlocked').classList.contains('pm-hidden'),
  lockStatus: document.getElementById('pm-lock-status').textContent.trim(),
  status: document.getElementById('pm-status').textContent.trim()
});

const browser = await chromium.launch();

// ---- 1. fresh install ----
{
  const { page, errors } = await open(browser, {});
  const s = await page.evaluate(snapshot);
  check('fresh: no page errors', errors.length === 0, errors);
  check('fresh: textarea EMPTY (no built-ins on screen)', s.textarea === '', s.textarea.slice(0, 80));
  check('fresh: level strict', s.level === 'strict', s.level);
  check('fresh: mode note', s.modeNote === 'Strict list, plus 0 of your own', s.modeNote);
  check('fresh: masked empty copy mentions built-in still on', /built-in list is still on/.test(s.maskedText), s.maskedText);
  check('fresh: lock setup panel shown', s.lockSetupHidden === false && s.lockLockedHidden === true);
  check('fresh: controls enabled', s.enabledDisabled === false && s.saveDisabled === false);
  // No built-in word must appear anywhere in the rendered page.
  const leak = await page.evaluate(() => document.body.innerText.toLowerCase().includes('fuck') || document.body.innerText.toLowerCase().includes('shit'));
  check('fresh: no built-in word text anywhere in the DOM', leak === false);
  await page.close();
}

// ---- 2. legacy custom migration ----
{
  const { page, errors } = await open(browser, { pm_strictness: 'custom', pm_wordlist: ['alpha', 'beta gamma'] });
  const s = await page.evaluate(snapshot);
  check('legacy: no page errors', errors.length === 0, errors);
  check('legacy: level none', s.level === 'none', s.level);
  check('legacy: textarea has their list', s.textarea === 'alpha\nbeta gamma', s.textarea);
  check('legacy: mode note', s.modeNote === 'No built-in list, plus 2 of your own', s.modeNote);
  check('legacy: masked shows shapes not words', s.maskedText.includes('*****') && !s.maskedText.includes('alpha'), s.maskedText);
  await page.close();
}

// ---- 3. save writes the new key, never the deprecated one ----
{
  const { page } = await open(browser, { pm_strictness: 'custom', pm_wordlist: ['alpha'] });
  const hiddenBefore = await page.evaluate(() => document.getElementById('pm-wordlist').classList.contains('pm-hidden'));
  check('save: textarea is masked until asked', hiddenBefore === true);
  await page.click('#pm-toggle-mask');
  await page.fill('#pm-wordlist', 'alpha\nzeta');
  await page.click('#pm-save');
  await page.waitForTimeout(100);
  const w = await page.evaluate(() => window.__pmWrites);
  const last = w[w.length - 1];
  check('save: writes pm_additionalWords', last.obj.pm_additionalWords?.join(',') === 'alpha,zeta', last.obj.pm_additionalWords);
  check('save: never writes pm_wordlist', w.every(x => !x.keys || !x.keys.includes('pm_wordlist')), w.map(x => x.keys));
  check('save: level unchanged by saving words', last.obj.pm_strictness === 'none', last.obj.pm_strictness);
  const stored = await page.evaluate(() => window.__pmSync.pm_wordlist);
  check('save: deprecated pm_wordlist left intact for rollback', JSON.stringify(stored) === '["alpha"]', stored);
  await page.close();
}

// ---- 4. restore defaults ----
{
  const { page } = await open(browser, { pm_strictness: 'none', pm_additionalWords: ['alpha'] });
  await page.click('#pm-restore');
  await page.waitForTimeout(100);
  const s = await page.evaluate(snapshot);
  check('restore: level back to strict', s.level === 'strict', s.level);
  check('restore: own words cleared', s.textarea === '', s.textarea);
  const stored = await page.evaluate(() => window.__pmSync);
  check('restore: persisted immediately', stored.pm_strictness === 'strict' && stored.pm_additionalWords.length === 0, stored);
  await page.close();
}

// ---- 5. locked state ----
{
  // Build a real record using the page's own PMLock, then reload with it.
  const { page: p0 } = await open(browser, {});
  const record = await p0.evaluate(() => window.PMLock.create('hunter2'));
  await p0.close();

  const { page, errors } = await open(browser, { pm_lock: record, pm_strictness: 'standard' });
  let s = await page.evaluate(snapshot);
  check('locked: no page errors', errors.length === 0, errors);
  check('locked: locked panel shown', s.lockLockedHidden === false && s.lockSetupHidden === true && s.lockUnlockedHidden === true);
  check('locked: settings controls disabled', s.enabledDisabled === true && s.saveDisabled === true && s.toggleMaskDisabled === true && s.resetStatsDisabled === true);
  check('locked: Copy debug log stays ENABLED', s.copyDisabled === false);

  const writesBefore = await page.evaluate(() => window.__pmWrites.length);
  // Force a change past the disabled attribute, exactly as a determined
  // kid with devtools would: the central guard must still refuse.
  await page.evaluate(() => {
    const el = document.getElementById('pm-enabled');
    el.disabled = false;
    el.checked = false;
    el.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(100);
  const writesAfter = await page.evaluate(() => window.__pmWrites.length);
  s = await page.evaluate(snapshot);
  check('locked: a forced change writes NOTHING', writesAfter === writesBefore, { writesBefore, writesAfter });
  check('locked: and says why', /Locked/.test(s.status), s.status);

  // Wrong password.
  await page.fill('#pm-lock-password', 'wrong');
  await page.click('#pm-lock-unlock');
  await page.waitForTimeout(150);
  s = await page.evaluate(snapshot);
  check('locked: wrong password rejected', s.lockStatus === 'Wrong password', s.lockStatus);
  check('locked: still locked', s.saveDisabled === true);

  // Right password.
  await page.fill('#pm-lock-password', 'hunter2');
  await page.click('#pm-lock-unlock');
  await page.waitForTimeout(150);
  s = await page.evaluate(snapshot);
  check('unlock: controls enabled', s.enabledDisabled === false && s.saveDisabled === false);
  check('unlock: unlocked panel shown', s.lockUnlockedHidden === false && s.lockLockedHidden === true);

  const n = await page.evaluate(() => window.__pmWrites.length);
  await page.click('#pm-strictness-none');
  await page.waitForTimeout(100);
  const n2 = await page.evaluate(() => window.__pmWrites.length);
  check('unlock: writes now go through', n2 > n, { n, n2 });

  // Remove password.
  await page.click('#pm-lock-remove');
  await page.waitForTimeout(150);
  s = await page.evaluate(snapshot);
  const lockGone = await page.evaluate(() => !('pm_lock' in window.__pmSync));
  check('remove: pm_lock deleted', lockGone);
  check('remove: setup panel back', s.lockSetupHidden === false);
  await page.close();
}

// ---- 6. setting a password ----
{
  const { page } = await open(browser, {});
  await page.fill('#pm-lock-new', 'abc');
  await page.fill('#pm-lock-confirm', 'abc');
  await page.click('#pm-lock-set');
  await page.waitForTimeout(150);
  let s = await page.evaluate(snapshot);
  check('setpw: too short rejected', s.lockStatus === 'Use at least 4 characters', s.lockStatus);

  await page.fill('#pm-lock-new', 'abcd');
  await page.fill('#pm-lock-confirm', 'abce');
  await page.click('#pm-lock-set');
  await page.waitForTimeout(150);
  s = await page.evaluate(snapshot);
  check('setpw: mismatch rejected', s.lockStatus === "Passwords don't match", s.lockStatus);

  await page.fill('#pm-lock-new', 'abcd');
  await page.fill('#pm-lock-confirm', 'abcd');
  await page.click('#pm-lock-set');
  await page.waitForTimeout(200);
  s = await page.evaluate(snapshot);
  const rec = await page.evaluate(() => window.__pmSync.pm_lock);
  check('setpw: record stored with salt+hash', !!rec && rec.salt.length === 32 && rec.hash.length === 64, rec);
  check('setpw: plaintext never stored', JSON.stringify(rec).indexOf('abcd') === -1);
  check('setpw: parent stays unlocked in this session', s.enabledDisabled === false && s.lockUnlockedHidden === false);
  await page.close();
}

await browser.close();
console.log(`popup_check: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
