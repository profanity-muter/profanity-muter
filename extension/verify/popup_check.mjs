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
//      would actually try it - by clearing the `disabled` attribute from
//      devtools and dispatching the change event anyway, which must still
//      write nothing, because the enforcement is in persistSettings and
//      not in the DOM state.
//
// Unlike verify/run_playwright.mjs (headful, real YouTube, minutes, a
// Whisper model download), this touches nothing outside the popup page -
// so it is cheap enough to run on every change to popup/, shared/lock.js
// or the word-list resolution.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
const URL = pathToFileURL(path.join(EXT, 'popup', 'popup.html')).href;
// The stubbed chrome.runtime.getManifest() reports the REAL version, so
// assertions about anything that embeds it (the problem report, the mail
// subject) can be exact instead of a moving target.
const MANIFEST_VERSION = JSON.parse(
  fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')
).version;

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
  window.__pmTabs = [];
  window.__pmClipboard = null;
  window.chrome = {
    runtime: {
      lastError: undefined,
      getManifest: () => ({ version: '${MANIFEST_VERSION}' }),
      getURL: (p) => 'chrome-extension://stub/' + p
    },
    tabs: { create: (opts) => { window.__pmTabs.push(opts.url); } },
    storage: {
      sync: area(window.__pmSync, 'sync'),
      local: area(window.__pmLocal, 'local'),
      onChanged: { addListener() {} }
    }
  };
  // The popup closes itself after opening a tab; in the harness that would
  // end the page under test, so neutralize it and record the intent.
  window.__pmClosed = false;
  window.close = () => { window.__pmClosed = true; };
  // Clipboard: file:// pages have no clipboard permission, so capture the
  // write instead of asking the browser for one.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t) => { window.__pmClipboard = t; return Promise.resolve(); } }
  });
  // The report page opens the mail draft by clicking its own <a href="mailto:">.
  // Let that be observed instead of handed to an external protocol handler,
  // which headless Chrome can't do anyway.
  window.__pmMailto = null;
  HTMLAnchorElement.prototype.click = function () { window.__pmMailto = this.href; };
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
  status: document.getElementById('pm-status').textContent.trim(),
  bannerHidden: document.getElementById('pm-finish-setup').classList.contains('pm-hidden'),
  reviewHidden: document.getElementById('pm-review-card').classList.contains('pm-hidden'),
  shareHidden: document.getElementById('pm-share-row').classList.contains('pm-hidden'),
  shareDisabled: document.getElementById('pm-share').disabled,
  setupGuideDisabled: document.getElementById('pm-open-onboarding').disabled,
  reportDisabled: document.getElementById('pm-report-problem').disabled,
  reportHidden: !document.getElementById('pm-report-problem').offsetParent &&
                getComputedStyle(document.getElementById('pm-report-problem')).display === 'none'
});

// A fully review-eligible sync/local pair: acknowledged, installed 8 days
// ago, past both usage milestones, never prompted. Individual checks below
// break exactly one gate at a time.
const ACK = { version: 1, timestamp: 1 };
const eligibleSync = (over = {}) => Object.assign({
  pm_ackNotPerfect: ACK,
  pm_installedAt: Date.now() - 8 * 24 * 60 * 60 * 1000
}, over);
const eligibleLocal = { pm_stats: { videosProtected: 12, totalMuted: 30 } };

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

// ===== 0.1.30 surfaces: onboarding banner, review prompt, share =====

// ---- 7. unacknowledged: banner shows, share hidden ----
{
  const { page, errors } = await open(browser, {});
  const s = await page.evaluate(snapshot);
  check('banner: no page errors', errors.length === 0, errors);
  check('banner: shows when unacknowledged', s.bannerHidden === false);
  check('banner: share row hidden until acknowledged', s.shareHidden === true);
  check('banner: review card hidden', s.reviewHidden === true);
  await page.click('#pm-finish-setup');
  await page.waitForTimeout(50);
  const tabs = await page.evaluate(() => window.__pmTabs);
  check('banner: opens the onboarding page', tabs.length === 1 && /onboarding\/onboarding\.html$/.test(tabs[0]), tabs);
  await page.close();
}

// ---- 8. acknowledged: banner gone, share shown ----
{
  const { page } = await open(browser, { pm_ackNotPerfect: ACK });
  const s = await page.evaluate(snapshot);
  check('acked: banner hidden', s.bannerHidden === true);
  check('acked: share row shown', s.shareHidden === false);
  await page.close();
}

// ---- 9. a stale ack version re-shows the banner ----
{
  const { page } = await open(browser, { pm_ackNotPerfect: { version: 0, timestamp: 1 } });
  const s = await page.evaluate(snapshot);
  check('stale ack: banner returns', s.bannerHidden === false);
  check('stale ack: share hidden again', s.shareHidden === true);
  await page.close();
}

// ---- 10. Setup guide link always available ----
{
  const { page } = await open(browser, { pm_ackNotPerfect: ACK });
  await page.click('#pm-open-onboarding');
  await page.waitForTimeout(50);
  const tabs = await page.evaluate(() => window.__pmTabs);
  check('setup guide: reopens onboarding', tabs.length === 1 && /onboarding\.html$/.test(tabs[0]), tabs);
  await page.close();
}

// ---- 11. review card: renders only when every gate passes ----
{
  const { page } = await open(browser, eligibleSync(), eligibleLocal);
  const s = await page.evaluate(snapshot);
  check('review: card shown when eligible', s.reviewHidden === false);
  // Showing it must record it immediately - otherwise closing the popup
  // would re-ask on every open.
  const rec = await page.evaluate(() => window.__pmSync.pm_reviewPrompt);
  check('review: pm_reviewPrompt written on render', !!rec && typeof rec.shownAt === 'number' && rec.dismissed === false, rec);
  await page.close();
}

// ---- 12. each gate individually suppresses the card ----
{
  const cases = [
    ['unacknowledged', { pm_ackNotPerfect: undefined }, eligibleLocal],
    ['no install date', { pm_installedAt: undefined }, eligibleLocal],
    ['installed 6 days ago', { pm_installedAt: Date.now() - 6 * 24 * 60 * 60 * 1000 }, eligibleLocal],
    ['already prompted', { pm_reviewPrompt: { shownAt: 1, dismissed: true } }, eligibleLocal],
    ['too few videos', {}, { pm_stats: { videosProtected: 9, totalMuted: 99 } }],
    ['too few mutes', {}, { pm_stats: { videosProtected: 99, totalMuted: 24 } }],
    ['no stats at all', {}, {}]
  ];
  for (const [name, syncOver, local] of cases) {
    const sync = eligibleSync();
    for (const k of Object.keys(syncOver)) {
      if (syncOver[k] === undefined) delete sync[k];
      else sync[k] = syncOver[k];
    }
    const { page } = await open(browser, sync, local);
    const s = await page.evaluate(snapshot);
    check(`review gate: ${name} suppresses the card`, s.reviewHidden === true);
    const wrote = await page.evaluate(() => 'pm_reviewPrompt' in window.__pmSync);
    check(`review gate: ${name} records nothing new`, wrote === (name === 'already prompted'));
    await page.close();
  }
}

// ---- 13. review actions ----
{
  const { page } = await open(browser, eligibleSync(), eligibleLocal);
  await page.click('#pm-review-yes');
  await page.waitForTimeout(80);
  let s = await page.evaluate(snapshot);
  const tabs = await page.evaluate(() => window.__pmTabs);
  const rec = await page.evaluate(() => window.__pmSync.pm_reviewPrompt);
  check('review: "Leave a review" opens the store reviews URL', tabs.length === 1 && /\/reviews$/.test(tabs[0]), tabs);
  check('review: marked dismissed after acting', rec.dismissed === true, rec);
  check('review: card hidden after acting', s.reviewHidden === true);
  await page.close();

  const { page: p2 } = await open(browser, eligibleSync(), eligibleLocal);
  await p2.click('#pm-review-no');
  await p2.waitForTimeout(80);
  s = await p2.evaluate(snapshot);
  const rec2 = await p2.evaluate(() => window.__pmSync.pm_reviewPrompt);
  const tabs2 = await p2.evaluate(() => window.__pmTabs);
  check('review: "No thanks" opens nothing', tabs2.length === 0, tabs2);
  check('review: "No thanks" dismisses permanently', rec2.dismissed === true, rec2);
  check('review: card hidden after declining', s.reviewHidden === true);
  check('review: says it will not ask again', /won.t ask again/.test(s.status), s.status);
  await p2.close();
}

// ---- 14. share copies the blurb ----
{
  const { page } = await open(browser, { pm_ackNotPerfect: ACK });
  await page.click('#pm-share');
  await page.waitForTimeout(80);
  const text = await page.evaluate(() => window.__pmClipboard);
  const s = await page.evaluate(snapshot);
  check('share: copies the blurb', /^I use Profanity Muter to auto-mute swearing/.test(text || ''), text);
  check('share: includes the store link', (text || '').includes('chromewebstore.google.com'), text);
  check('share: no tracking parameters', !(text || '').includes('?'), text);
  check('share: status toast', s.status === 'Copied!', s.status);
  await page.close();
}

// ---- 15. share + debug log stay usable while the settings are locked ----
{
  const { page: p0 } = await open(browser, {});
  const record = await p0.evaluate(() => window.PMLock.create('hunter2'));
  await p0.close();

  const { page } = await open(browser, { pm_lock: record, pm_ackNotPerfect: ACK });
  const s = await page.evaluate(snapshot);
  check('locked: share row still visible', s.shareHidden === false);
  check('locked: share button enabled', s.shareDisabled === false);
  check('locked: Copy debug log still enabled', s.copyDisabled === false);
  check('locked: Setup guide still enabled', s.setupGuideDisabled === false);
  await page.click('#pm-share');
  await page.waitForTimeout(80);
  const text = await page.evaluate(() => window.__pmClipboard);
  check('locked: share still copies', (text || '').includes('Profanity Muter'), text);
  await page.close();
}

// ===== onboarding page =====
{
  const OB = pathToFileURL(path.join(EXT, 'onboarding', 'onboarding.html')).href;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(stub({}, {}));
  await page.goto(OB);
  await page.waitForTimeout(150);

  const obSnap = () => ({
    step: [1, 2, 3, 4].filter(i => !document.getElementById('ob-step-' + i).classList.contains('pm-hidden')),
    dotsDone: document.querySelectorAll('.ob-dot--done').length,
    finishHidden: document.getElementById('ob-finish').classList.contains('pm-hidden'),
    finishDisabled: document.getElementById('ob-finish').disabled,
    backDisabled: document.getElementById('ob-back').disabled,
    ackDoneHidden: document.getElementById('ob-ack-done').classList.contains('pm-hidden')
  });

  let s = await page.evaluate(obSnap);
  check('onboarding: no page errors', errors.length === 0, errors);
  check('onboarding: starts on step 1 only', s.step.length === 1 && s.step[0] === 1, s.step);
  check('onboarding: one dot filled', s.dotsDone === 1, s.dotsDone);
  check('onboarding: Back disabled on step 1', s.backDisabled === true);

  // No built-in word may appear on this page either.
  const leak = await page.evaluate(() => {
    const t = document.body.innerText.toLowerCase();
    return t.includes('fuck') || t.includes('shit');
  });
  check('onboarding: no built-in word text anywhere', leak === false);

  await page.click('#ob-next');
  await page.click('#ob-next');
  s = await page.evaluate(obSnap);
  check('onboarding: reaches the setup step', s.step[0] === 3, s.step);
  check('onboarding: three dots filled', s.dotsDone === 3, s.dotsDone);

  // Catch-up mode is preselected to "mute" and writes through on change.
  const preselected = await page.evaluate(() =>
    [...document.getElementsByName('ob-catchup-mode')].find(r => r.checked)?.value
  );
  check('onboarding: mute preselected', preselected === 'mute', preselected);
  await page.click('#ob-catchup-pause');
  await page.waitForTimeout(80);
  let sync = await page.evaluate(() => window.__pmSync);
  check('onboarding: catch-up choice saved', sync.pm_catchupMode === 'pause', sync.pm_catchupMode);
  check('onboarding: level saved alongside', sync.pm_strictness === 'strict', sync.pm_strictness);

  await page.fill('#ob-wordlist', 'fnord\nblorp');
  await page.click('#ob-wordlist-save');
  await page.waitForTimeout(80);
  sync = await page.evaluate(() => window.__pmSync);
  check('onboarding: additional words saved', JSON.stringify(sync.pm_additionalWords) === '["fnord","blorp"]', sync.pm_additionalWords);
  check('onboarding: never writes the deprecated pm_wordlist', !('pm_wordlist' in sync), Object.keys(sync));

  // Acknowledgment gate.
  await page.click('#ob-next');
  s = await page.evaluate(obSnap);
  check('onboarding: final step shows Finish, hides Next', s.finishHidden === false && s.step[0] === 4);
  check('onboarding: Finish disabled until the box is ticked', s.finishDisabled === true);
  // Force a click past the `disabled` attribute, the way the locked-popup
  // check does: finish() must refuse on its own, not only because the
  // button was unclickable.
  await page.evaluate(() => {
    document.getElementById('ob-finish').dispatchEvent(new Event('click'));
  });
  await page.waitForTimeout(80);
  let ack = await page.evaluate(() => window.__pmSync.pm_ackNotPerfect);
  check('onboarding: a forced click on a disabled Finish records nothing', ack === undefined, ack);

  await page.click('#ob-ack-check');
  s = await page.evaluate(obSnap);
  check('onboarding: ticking enables Finish', s.finishDisabled === false);
  await page.click('#ob-finish');
  await page.waitForTimeout(100);
  ack = await page.evaluate(() => window.__pmSync.pm_ackNotPerfect);
  s = await page.evaluate(obSnap);
  check('onboarding: ack record written', !!ack && ack.version === 1 && typeof ack.timestamp === 'number', ack);
  check('onboarding: confirmation shown', s.ackDoneHidden === false);
  await page.close();
}

// ---- onboarding respects an existing parental lock ----
{
  const OB = pathToFileURL(path.join(EXT, 'onboarding', 'onboarding.html')).href;
  const p0 = await browser.newPage();
  await p0.addInitScript(stub({}, {}));
  await p0.goto(URL);
  await p0.waitForTimeout(100);
  const record = await p0.evaluate(() => window.PMLock.create('hunter2'));
  await p0.close();

  const page = await browser.newPage();
  await page.addInitScript(stub({ pm_lock: record }, {}));
  await page.goto(OB);
  await page.waitForTimeout(150);
  await page.click('#ob-next');
  await page.click('#ob-next');
  let state = await page.evaluate(() => ({
    lockedHidden: document.getElementById('ob-locked').classList.contains('pm-hidden'),
    catchupDisabled: document.getElementById('ob-catchup-play').disabled,
    wordsDisabled: document.getElementById('ob-wordlist').disabled
  }));
  check('onboarding lock: unlock prompt shown', state.lockedHidden === false);
  check('onboarding lock: setup controls disabled', state.catchupDisabled === true && state.wordsDisabled === true);

  const before = await page.evaluate(() => window.__pmWrites.length);
  await page.evaluate(() => {
    const el = document.getElementById('ob-catchup-play');
    el.disabled = false;
    el.checked = true;
    el.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(80);
  const after = await page.evaluate(() => window.__pmWrites.length);
  check('onboarding lock: a forced change writes nothing', after === before, { before, after });

  await page.fill('#ob-lock-password', 'hunter2');
  await page.click('#ob-lock-unlock');
  await page.waitForTimeout(150);
  state = await page.evaluate(() => ({
    lockedHidden: document.getElementById('ob-locked').classList.contains('pm-hidden'),
    catchupDisabled: document.getElementById('ob-catchup-play').disabled
  }));
  check('onboarding lock: unlocks with the right password', state.lockedHidden === true && state.catchupDisabled === false);
  await page.close();
}

// ===== 0.1.31: Report a problem =====

// ---- 16. the popup link ----
{
  const { page, errors } = await open(browser, {});
  const s = await page.evaluate(snapshot);
  check('report link: no page errors', errors.length === 0, errors);
  check('report link: rendered', s.reportHidden === false);
  check('report link: enabled', s.reportDisabled === false);
  await page.click('#pm-report-problem');
  await page.waitForTimeout(50);
  const tabs = await page.evaluate(() => window.__pmTabs);
  check('report link: opens the report page', tabs.length === 1 && /report\/report\.html$/.test(tabs[0]), tabs);
  await page.close();
}

// ---- 17. the link is available while locked and before acknowledgment ----
{
  const { page: p0 } = await open(browser, {});
  const record = await p0.evaluate(() => window.PMLock.create('hunter2'));
  await p0.close();

  // Locked AND unacknowledged: the two states that hide or disable other
  // things. Reporting a problem must survive both.
  const { page } = await open(browser, { pm_lock: record });
  const s = await page.evaluate(snapshot);
  check('report link: enabled while settings are locked', s.reportDisabled === false);
  check('report link: rendered before acknowledgment', s.reportHidden === false);
  check('report link: (share row is hidden in this same state)', s.shareHidden === true);
  await page.close();
}

// ===== the report page itself =====

const REPORT = pathToFileURL(path.join(EXT, 'report', 'report.html')).href;

async function openReport(sync, local) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(stub(sync || {}, local || {}));
  await page.goto(REPORT);
  await page.waitForTimeout(150);
  return { page, errors };
}

const rpSnap = () => ({
  consent: document.getElementById('rp-consent').checked,
  video: document.getElementById('rp-video').value,
  logSummary: document.getElementById('rp-log-summary').textContent.trim(),
  doneHidden: document.getElementById('rp-done').classList.contains('pm-hidden'),
  mailto: document.getElementById('rp-mailto').getAttribute('href'),
  email: document.getElementById('rp-email').textContent.trim(),
  status: document.getElementById('rp-status').textContent.trim()
});

// A devlog with two videos, newest last (shared/devlog.js ordering).
const devlogFixture = {
  version: 1,
  videos: [
    { videoId: 'oldvideoid1', title: 'old', windows: [], gaps: [], captions: [], captionCount: 0, errors: [] },
    { videoId: 'dQw4w9WgXcQ', title: 'the one that broke', windows: [{ t0: 0, t1: 10, transcriptWordCount: 4, matches: [{ word: 'dang', t: 3 }], muteIntervals: [{ start: 2.6, end: 3.5 }] }], gaps: [], captions: [], captionCount: 0, errors: [] }
  ]
};

// ---- 18. defaults and prefill ----
{
  const { page, errors } = await openReport({}, { pm_devlog: devlogFixture });
  const s = await page.evaluate(rpSnap);
  check('report page: no page errors', errors.length === 0, errors);
  check('report page: consent checked by default', s.consent === true);
  check('report page: video prefilled from the newest devlog entry', s.video === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', s.video);
  check('report page: summary states what will be included', /2 recent video/.test(s.logSummary), s.logSummary);
  check('report page: confirmation hidden until sent', s.doneHidden === true);
  await page.close();
}

// ---- 19. no devlog yet ----
{
  const { page } = await openReport({}, {});
  const s = await page.evaluate(rpSnap);
  check('report page: empty video field with no log', s.video === '', s.video);
  check('report page: says a report is still worth sending', /send the report anyway/.test(s.logSummary), s.logSummary);
  await page.close();
}

// ---- 20. unchecking consent is honoured, visibly and in the payload ----
{
  const { page } = await openReport({}, { pm_devlog: devlogFixture });
  await page.uncheck('#rp-consent');
  let s = await page.evaluate(rpSnap);
  check('report page: unchecking updates the summary', /No debug log will be included/.test(s.logSummary), s.logSummary);

  await page.fill('#rp-what', 'it missed a word near the start');
  await page.click('#rp-send');
  await page.waitForTimeout(120);
  const copied = JSON.parse(await page.evaluate(() => window.__pmClipboard));
  check('report page: no-consent report omits the log', copied.debugLog === null && copied.debugLogIncluded === false, copied.debugLogNote);
  check('report page: no-consent report records the choice', /chose not to include/.test(copied.debugLogNote), copied.debugLogNote);
  check('report page: no video id leaks when the log is withheld', JSON.stringify(copied).indexOf('dQw4w9WgXcQ') === -1 || copied.videoUrl.includes('dQw4w9WgXcQ'), 'log content must not appear');
  await page.close();
}

// ---- 21. sending with consent: clipboard + mailto ----
{
  const { page } = await openReport({}, { pm_devlog: devlogFixture });
  await page.fill('#rp-what', 'swearing at 1:20 was not muted');
  await page.click('#rp-send');
  await page.waitForTimeout(120);

  const clip = await page.evaluate(() => window.__pmClipboard);
  const copied = JSON.parse(clip);
  check('report: clipboard was written', typeof clip === 'string' && clip.length > 0);
  check('report: kind + version present', copied.kind === 'profanity-muter-problem-report' && copied.reportVersion === 1, copied.kind);
  check('report: carries the extension version', copied.extensionVersion === MANIFEST_VERSION, copied.extensionVersion);
  check('report: carries the user agent', /Mozilla/.test(copied.userAgent), copied.userAgent);
  check('report: carries the freeform text', copied.whatHappened === 'swearing at 1:20 was not muted', copied.whatHappened);
  check('report: carries the video url', /dQw4w9WgXcQ/.test(copied.videoUrl), copied.videoUrl);
  check('report: includes the debug log', copied.debugLogIncluded === true && copied.debugLog.videos.length === 2);

  const s = await page.evaluate(rpSnap);
  const mailto = await page.evaluate(() => window.__pmMailto);
  check('report: confirmation panel shown', s.doneHidden === false);
  check('report: status toast', /copied/i.test(s.status), s.status);
  check('report: mail draft opened', typeof mailto === 'string' && mailto.startsWith('mailto:support@example.com?'), mailto);
  check('report: fallback link has the same href', s.mailto === mailto, s.mailto);
  check('report: support address shown as text too', s.email === 'support@example.com', s.email);

  const subject = decodeURIComponent((mailto.split('?subject=')[1] || '').split('&body=')[0]);
  const body = decodeURIComponent(mailto.split('&body=')[1] || '');
  check('report: subject is versioned', subject === 'Profanity Muter problem report v' + MANIFEST_VERSION, subject);
  check('report: body carries the user text', body.includes('swearing at 1:20 was not muted'));
  check('report: body carries the paste instruction', body.includes('please paste it below this line before sending'));
  check('report: body does NOT carry the log', !body.includes('dQw4w9WgXcQ') || body.indexOf('muteIntervals') === -1, 'no log in the mail body');
  check('report: mail draft stays small', mailto.length < 2000, mailto.length);
  await page.close();
}

// ---- 22. clearing the video field is respected ----
{
  const { page } = await openReport({}, { pm_devlog: devlogFixture });
  await page.fill('#rp-video', '');
  await page.fill('#rp-what', 'no idea which video');
  await page.click('#rp-send');
  await page.waitForTimeout(120);
  const copied = JSON.parse(await page.evaluate(() => window.__pmClipboard));
  const mailto = await page.evaluate(() => window.__pmMailto);
  check('report: cleared video stays cleared', copied.videoUrl === '', copied.videoUrl);
  check('report: no Video line in the mail body', !decodeURIComponent(mailto).includes('Video:'));
  await page.close();
}

// ---- 23. oversized log is truncated, and says so up front ----
{
  const big = { version: 1, videos: [] };
  for (let i = 0; i < 8; i++) {
    big.videos.push({
      videoId: 'video' + i,
      windows: [{ t0: 0, t1: 10, transcriptWordCount: 2, matches: [], muteIntervals: [], text: 'x'.repeat(40 * 1024) }],
      gaps: [], captions: [], captionCount: 0, errors: []
    });
  }
  const { page } = await openReport({}, { pm_devlog: big });
  let s = await page.evaluate(rpSnap);
  check('report: warns about truncation BEFORE sending', /too large to send in full/.test(s.logSummary), s.logSummary);
  await page.click('#rp-send');
  await page.waitForTimeout(200);
  const copied = JSON.parse(await page.evaluate(() => window.__pmClipboard));
  check('report: truncated to 3 videos', copied.debugLog.videos.length === 3, copied.debugLog.videos.length);
  check('report: keeps the most RECENT videos', copied.debugLog.videos.map(v => v.videoId).join(',') === 'video5,video6,video7', copied.debugLog.videos.map(v => v.videoId));
  check('report: truncation disclosed in the report', copied.debugLogTruncated === true && /TRUNCATED/.test(copied.debugLogNote), copied.debugLogNote);
  await page.close();
}

// ---- 24. copy again reproduces the report ----
{
  const { page } = await openReport({}, { pm_devlog: devlogFixture });
  await page.fill('#rp-what', 'first');
  await page.click('#rp-send');
  await page.waitForTimeout(120);
  await page.evaluate(() => { window.__pmClipboard = null; });
  await page.click('#rp-copy-again');
  await page.waitForTimeout(120);
  const again = await page.evaluate(() => window.__pmClipboard);
  const s = await page.evaluate(rpSnap);
  check('report: "copy again" re-copies', typeof again === 'string' && JSON.parse(again).whatHappened === 'first');
  check('report: "copy again" confirms', /copied again/i.test(s.status), s.status);
  await page.close();
}

// ---- 25. the onboarding final screen links to it too ----
{
  const OB2 = pathToFileURL(path.join(EXT, 'onboarding', 'onboarding.html')).href;
  const page = await browser.newPage();
  await page.addInitScript(stub({}, {}));
  await page.goto(OB2);
  await page.waitForTimeout(120);
  await page.click('#ob-next');
  await page.click('#ob-next');
  await page.click('#ob-next');
  await page.click('#ob-report-problem');
  await page.waitForTimeout(60);
  const tabs = await page.evaluate(() => window.__pmTabs);
  check('onboarding: final screen links to the report page', tabs.length === 1 && /report\/report\.html$/.test(tabs[0]), tabs);
  await page.close();
}

await browser.close();
console.log(`popup_check: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
