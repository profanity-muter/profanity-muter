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

const stub = (initialSync, initialLocal, health) => `
  window.__pmSync = ${JSON.stringify(initialSync)};
  window.__pmLocal = ${JSON.stringify(initialLocal || {})};
  // Injected reply for the popup's 'pm-health-query' to the active tab.
  // null means "no content script answered", i.e. not a YouTube tab.
  window.__pmHealth = ${JSON.stringify(health === undefined ? null : health)};
  window.__pmHealthQueries = 0;
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
  window.__pmBadge = [];
  window.__pmClipboard = null;
  window.chrome = {
    runtime: {
      lastError: undefined,
      getManifest: () => ({ version: '${MANIFEST_VERSION}' }),
      getURL: (p) => 'chrome-extension://stub/' + p
    },
    action: {
      setBadgeText: (o) => { window.__pmBadge.push(o); },
      setBadgeBackgroundColor: () => {}
    },
    tabs: {
      create: (opts) => { window.__pmTabs.push(opts.url); },
      query: (q, cb) => { setTimeout(() => cb([{ id: 7 }]), 0); },
      sendMessage: (tabId, msg, cb) => {
        window.__pmHealthQueries++;
        setTimeout(() => {
          if (window.__pmHealth === null) {
            // Mirror Chrome: no receiver sets lastError and calls back
            // with undefined.
            window.chrome.runtime.lastError = { message: 'Could not establish connection.' };
            cb(undefined);
            window.chrome.runtime.lastError = undefined;
            return;
          }
          cb(window.__pmHealth);
        }, 0);
      }
    },
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

async function open(browser, sync, local, health) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(stub(sync, local, health));
  await page.goto(URL);
  await page.waitForTimeout(150);
  return { page, errors };
}

// A whole-page snapshot of the Design C popup (0.1.51).
const snapshot = () => ({
  view: ['home', 'manage', 'playback', 'activity', 'lock']
    .find(v => !document.getElementById('pm-view-' + v).classList.contains('pm-hidden')),
  level: [...document.getElementsByName('pm-strictness')].find(r => r.checked)?.value,
  enabledChecked: document.getElementById('pm-enabled').checked,
  homeMuted: document.getElementById('pm-home-muted').textContent.trim(),
  homeVideos: document.getElementById('pm-home-videos').textContent.trim(),
  homeCatsText: document.getElementById('pm-home-cats').textContent.trim(),
  homeOverlayHidden: document.getElementById('pm-home-overlay').classList.contains('pm-hidden'),
  actOverlayHidden: document.getElementById('pm-act-overlay').classList.contains('pm-hidden'),
  actMuted: document.getElementById('pm-act-muted').textContent.trim(),
  actTopText: document.getElementById('pm-act-top').textContent.trim(),
  lockIconHidden: document.getElementById('pm-lock-icon').classList.contains('pm-hidden'),
  lockIconOpen: document.getElementById('pm-lock-icon').textContent.includes('\u{1F513}'),
  relockHidden: document.getElementById('pm-relock-bar').classList.contains('pm-hidden'),
  lockSetupHidden: document.getElementById('pm-lock-setup').classList.contains('pm-hidden'),
  lockManageHidden: document.getElementById('pm-lock-manage').classList.contains('pm-hidden'),
  homeLockMsg: document.getElementById('pm-home-lockmsg').textContent.trim(),
  status: document.getElementById('pm-status').textContent.trim(),
  bannerHidden: document.getElementById('pm-finish-setup').classList.contains('pm-hidden'),
  reviewHidden: document.getElementById('pm-review-card').classList.contains('pm-hidden'),
  manageSub: document.getElementById('pm-manage-sub').textContent.trim(),
  blockChips: document.getElementById('pm-block-chips').textContent.trim(),
  allowChips: document.getElementById('pm-allow-chips').textContent.trim(),
  copyDisabled: document.getElementById('pm-copy-devlog').disabled,
  shareDisabled: document.getElementById('pm-share').disabled,
  setupGuideDisabled: document.getElementById('pm-open-onboarding').disabled,
  healthHidden: document.getElementById('pm-health').classList.contains('pm-hidden'),
  healthMessage: document.getElementById('pm-health-message').textContent.trim(),
  healthDetail: document.getElementById('pm-health-detail').textContent.trim()
});

const ACK = { version: 1, timestamp: 1 };
const eligibleSync = (over = {}) => Object.assign({
  pm_ackNotPerfect: ACK,
  pm_installedAt: Date.now() - 8 * 24 * 60 * 60 * 1000
}, over);
const eligibleLocal = { pm_stats: { videosProtected: 12, totalMuted: 30 } };

// An activity store fixture with today's counts (all-time = these).
const activityFixture = () => {
  const now = Date.now();
  const d = new Date(now);
  const dk = d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  const bucket = {
    muted: 12, videos: 3,
    cats: { profanity: 7, slur: 1, religious: 3, euphemism: 1, custom: 0 },
    words: { fuckcanon: 5, hell: 3, damn: 2, oops: 2 }
  };
  return { v: 1, allTime: JSON.parse(JSON.stringify(bucket)), days: { [dk]: JSON.parse(JSON.stringify(bucket)) } };
};

const browser = await chromium.launch();

// ---- 1. fresh install ----
{
  const { page, errors } = await open(browser, {});
  const s = await page.evaluate(snapshot);
  check('fresh: no page errors', errors.length === 0, errors);
  check('fresh: lands on home', s.view === 'home', s.view);
  check('fresh: level strict', s.level === 'strict', s.level);
  check('fresh: enabled on by default', s.enabledChecked === true);
  check('fresh: no lock -> no overlay, no padlock', s.homeOverlayHidden === true && s.lockIconHidden === true);
  check('fresh: home summary zeros', s.homeMuted === '0' && s.homeVideos === '0', [s.homeMuted, s.homeVideos]);
  // No built-in word must appear anywhere in the rendered page.
  const leak = await page.evaluate(() => {
    const t = document.body.innerText.toLowerCase();
    return t.includes('fuck') || t.includes('shit');
  });
  check('fresh: no built-in word text anywhere in the DOM', leak === false);
  await page.close();
}

// ---- 2. legacy custom migration surfaces in Manage words ----
{
  const { page } = await open(browser, { pm_strictness: 'custom', pm_wordlist: ['alpha', 'beta gamma'] });
  let s = await page.evaluate(snapshot);
  check('legacy: level none', s.level === 'none', s.level);
  await page.click('#pm-go-manage');
  s = await page.evaluate(snapshot);
  check('legacy: manage view open', s.view === 'manage', s.view);
  check('legacy: block chips show their list', s.blockChips.includes('alpha') && s.blockChips.includes('beta gamma'), s.blockChips);
  check('legacy: manage sub counts', /2 added/.test(s.manageSub), s.manageSub);
  await page.close();
}

// ---- 3. adding a word writes pm_additionalWords, never pm_wordlist ----
{
  const { page } = await open(browser, {});
  await page.click('#pm-go-manage');
  await page.fill('#pm-block-input', 'zeta');
  await page.click('#pm-block-form button[type=submit]');
  await page.waitForTimeout(100);
  const w = await page.evaluate(() => window.__pmWrites);
  const last = w[w.length - 1];
  check('add: writes pm_additionalWords', last.obj.pm_additionalWords?.join(',') === 'zeta', last.obj.pm_additionalWords);
  check('add: never writes pm_wordlist', w.every(x => !x.keys || !x.keys.includes('pm_wordlist')), w.map(x => x.keys));
  const s = await page.evaluate(snapshot);
  check('add: chip shown', s.blockChips.includes('zeta'), s.blockChips);
  await page.close();
}

// ---- 4. Always allow writes pm_allowWords (new whitelist) ----
{
  const { page } = await open(browser, {});
  await page.click('#pm-go-manage');
  await page.fill('#pm-allow-input', 'hell');
  await page.click('#pm-allow-form button[type=submit]');
  await page.waitForTimeout(100);
  let w = await page.evaluate(() => window.__pmWrites);
  let last = w[w.length - 1];
  check('allow: writes pm_allowWords', last.obj.pm_allowWords?.join(',') === 'hell', last.obj.pm_allowWords);
  let s = await page.evaluate(snapshot);
  check('allow: allow chip shown', s.allowChips.includes('hell'), s.allowChips);
  check('allow: sub counts allowed', /1 allowed/.test(s.manageSub), s.manageSub);
  // remove it again
  await page.click('#pm-allow-chips .pm-chip-x');
  await page.waitForTimeout(100);
  w = await page.evaluate(() => window.__pmWrites);
  last = w[w.length - 1];
  check('allow: removal writes empty pm_allowWords', Array.isArray(last.obj.pm_allowWords) && last.obj.pm_allowWords.length === 0, last.obj.pm_allowWords);
  await page.close();
}

// ---- 5. restore defaults (Playback view) ----
{
  const { page } = await open(browser, { pm_strictness: 'none', pm_additionalWords: ['alpha'] });
  await page.click('#pm-go-playback');
  await page.click('#pm-restore');
  await page.waitForTimeout(100);
  const stored = await page.evaluate(() => window.__pmSync);
  check('restore: level back to strict', stored.pm_strictness === 'strict', stored.pm_strictness);
  check('restore: own words cleared', Array.isArray(stored.pm_additionalWords) && stored.pm_additionalWords.length === 0, stored.pm_additionalWords);
  await page.close();
}

// ---- 6. Playback holds every existing setting and saves immediately ----
{
  const { page } = await open(browser, {});
  await page.click('#pm-go-playback');
  await page.click('#pm-catchup-pause');
  await page.waitForTimeout(80);
  let stored = await page.evaluate(() => window.__pmSync);
  check('playback: catch-up choice saved', stored.pm_catchupMode === 'pause', stored.pm_catchupMode);
  await page.click('#pm-padding-wide');
  await page.waitForTimeout(80);
  stored = await page.evaluate(() => window.__pmSync);
  check('playback: padding saved', stored.pm_padding === 'wide', stored.pm_padding);
  // toggles present and functional
  await page.click('#pm-mute-audio');
  await page.waitForTimeout(80);
  stored = await page.evaluate(() => window.__pmSync);
  check('playback: mute audio toggle saved', stored.pm_muteAudio === false, stored.pm_muteAudio);
  await page.close();
}

// ---- 7. Activity dashboard: summary + range toggle + most-muted ----
{
  const { page } = await open(browser, {}, { pm_activity: activityFixture() });
  await page.waitForTimeout(80);
  let s = await page.evaluate(snapshot);
  check('activity: home summary reads all-time totals', s.homeMuted === '12' && s.homeVideos === '3', [s.homeMuted, s.homeVideos]);
  check('activity: home shows category bars', /Profanity/.test(s.homeCatsText), s.homeCatsText);
  await page.click('#pm-summary-tap');
  s = await page.evaluate(snapshot);
  check('activity: tapping the summary opens the full view', s.view === 'activity', s.view);
  check('activity: full view big number', s.actMuted === '12', s.actMuted);
  check('activity: most-muted list rendered', /hell/.test(s.actTopText) && /fuckcanon/.test(s.actTopText), s.actTopText);
  // the range toggle fills the full width (the mockup bug fix): three equal
  // options, summing to the container width with no dead space.
  const widths = await page.evaluate(() => {
    const seg = document.querySelector('.pm-seg--range');
    const opts = [...seg.querySelectorAll('.pm-range-opt')];
    return { container: seg.clientWidth, opts: opts.map(o => o.offsetWidth) };
  });
  const sum = widths.opts.reduce((a, b) => a + b, 0);
  check('activity: range toggle fills the full width (no dead space)', Math.abs(sum - widths.container) <= 2, widths);
  check('activity: three equal-width range options', Math.max(...widths.opts) - Math.min(...widths.opts) <= 1, widths.opts);
  // 24h still counts today's bucket (fixture is today), 7d too.
  await page.click('.pm-range-opt[data-range="24h"]');
  s = await page.evaluate(snapshot);
  check('activity: 24h range drives the numbers', s.actMuted === '12', s.actMuted);
  await page.close();
}

// ---- 8. locked state: summary public, everything else gated ----
{
  const { page: p0 } = await open(browser, {});
  const record = await p0.evaluate(() => window.PMLock.create('hunter2'));
  await p0.close();

  const { page, errors } = await open(browser, { pm_lock: record, pm_strictness: 'standard' }, { pm_activity: activityFixture() });
  let s = await page.evaluate(snapshot);
  check('locked: no page errors', errors.length === 0, errors);
  check('locked: home summary stays public', s.homeMuted === '12' && s.homeVideos === '3', [s.homeMuted, s.homeVideos]);
  check('locked: settings gated behind the overlay', s.homeOverlayHidden === false);
  check('locked: padlock shown and closed', s.lockIconHidden === false && s.lockIconOpen === false);
  check('locked: relock bar hidden while locked', s.relockHidden === true);

  // The master on/off switch stays visible; clicking it to turn off prompts
  // for the password and writes nothing.
  const writesBefore = await page.evaluate(() => window.__pmWrites.length);
  await page.evaluate(() => {
    const el = document.getElementById('pm-enabled');
    el.checked = false;
    el.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(100);
  const writesAfter = await page.evaluate(() => window.__pmWrites.length);
  s = await page.evaluate(snapshot);
  check('locked: clicking the switch off writes nothing', writesAfter === writesBefore, { writesBefore, writesAfter });
  check('locked: the switch reverts to on', s.enabledChecked === true);
  check('locked: and the prompt is surfaced', /password/i.test(s.status), s.status);

  // A forced settings change past the gate still writes nothing (enforcement
  // is in persistSettings, not the DOM state).
  const wb2 = await page.evaluate(() => window.__pmWrites.length);
  await page.evaluate(() => {
    const el = document.getElementById('pm-strictness-none');
    el.checked = true;
    el.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(100);
  const wa2 = await page.evaluate(() => window.__pmWrites.length);
  check('locked: a forced strictness change writes nothing', wa2 === wb2, { wb2, wa2 });

  // Expanded Activity: summary numbers public, per-type + most-muted gated.
  await page.click('#pm-open-activity');
  s = await page.evaluate(snapshot);
  check('locked: activity summary numbers public', s.actMuted === '12', s.actMuted);
  check('locked: activity detail gated', s.actOverlayHidden === false);
  await page.click('#pm-back');

  // Wrong then right password on the home overlay.
  await page.fill('#pm-home-pass', 'wrong');
  await page.click('#pm-home-unlock');
  await page.waitForTimeout(150);
  s = await page.evaluate(snapshot);
  check('locked: wrong password rejected', s.homeLockMsg === 'Wrong password', s.homeLockMsg);
  check('locked: still locked', s.homeOverlayHidden === false);

  await page.fill('#pm-home-pass', 'hunter2');
  await page.click('#pm-home-unlock');
  await page.waitForTimeout(150);
  s = await page.evaluate(snapshot);
  check('unlock: overlay gone', s.homeOverlayHidden === true);
  check('unlock: padlock flips to open', s.lockIconOpen === true);
  check('unlock: relock bar shown', s.relockHidden === false);

  // Now a real settings change goes through. Pick a level that differs from
  // the currently-checked one so the radio actually fires a change event.
  const n = await page.evaluate(() => window.__pmWrites.length);
  await page.click('#pm-strictness-strict');
  await page.waitForTimeout(100);
  const n2 = await page.evaluate(() => window.__pmWrites.length);
  check('unlock: writes now go through', n2 > n, { n, n2 });

  // Lock now relocks immediately.
  await page.click('#pm-lock-now');
  await page.waitForTimeout(80);
  s = await page.evaluate(snapshot);
  check('lock now: relocks immediately', s.homeOverlayHidden === false && s.lockIconOpen === false);
  await page.close();
}

// ---- 9. setting a password from the lock screen ----
{
  const { page } = await open(browser, {});
  await page.click('#pm-go-lock');
  let s = await page.evaluate(snapshot);
  check('setpw: lock setup shown, no lock yet', s.lockSetupHidden === false && s.lockManageHidden === true);

  await page.fill('#pm-lock-new', 'abc');
  await page.fill('#pm-lock-confirm', 'abc');
  await page.click('#pm-lock-set');
  await page.waitForTimeout(120);
  let msg = await page.evaluate(() => document.getElementById('pm-lock-status').textContent.trim());
  check('setpw: too short rejected', /at least 4/.test(msg), msg);

  await page.fill('#pm-lock-new', 'abcd');
  await page.fill('#pm-lock-confirm', 'abcd');
  await page.click('#pm-lock-set');
  await page.waitForTimeout(200);
  const rec = await page.evaluate(() => window.__pmSync.pm_lock);
  check('setpw: record stored with salt+hash', !!rec && rec.salt.length === 32 && rec.hash.length === 64, rec);
  check('setpw: plaintext never stored', JSON.stringify(rec).indexOf('abcd') === -1);
  s = await page.evaluate(snapshot);
  check('setpw: parent stays unlocked this session', s.lockIconOpen === true && s.homeOverlayHidden === true);
  check('setpw: manage panel now shown on the lock screen', s.lockManageHidden === false);
  await page.close();
}

// ---- 10. unacknowledged banner / acknowledged share ----
{
  const { page } = await open(browser, {});
  let s = await page.evaluate(snapshot);
  check('banner: shows when unacknowledged', s.bannerHidden === false);
  check('banner: review card hidden', s.reviewHidden === true);
  await page.click('#pm-finish-setup');
  await page.waitForTimeout(50);
  const tabs = await page.evaluate(() => window.__pmTabs);
  check('banner: opens onboarding', tabs.length === 1 && /onboarding\/onboarding\.html$/.test(tabs[0]), tabs);
  await page.close();

  const { page: p2 } = await open(browser, { pm_ackNotPerfect: ACK });
  const s2 = await p2.evaluate(snapshot);
  check('acked: banner hidden', s2.bannerHidden === true);
  await p2.close();
}

// ---- 11. review card renders only when every gate passes ----
{
  const { page } = await open(browser, eligibleSync(), eligibleLocal);
  const s = await page.evaluate(snapshot);
  check('review: card shown when eligible', s.reviewHidden === false);
  const rec = await page.evaluate(() => window.__pmSync.pm_reviewPrompt);
  check('review: pm_reviewPrompt written on render', !!rec && typeof rec.shownAt === 'number' && rec.dismissed === false, rec);
  await page.close();
}

// ---- 12. share copies the blurb (footer, always ungated) ----
{
  const { page } = await open(browser, { pm_ackNotPerfect: ACK });
  await page.click('#pm-share');
  await page.waitForTimeout(80);
  const text = await page.evaluate(() => window.__pmClipboard);
  check('share: copies the blurb', /^I use Profanity Muter to auto-mute swearing/.test(text || ''), text);
  check('share: includes the store link', (text || '').includes('chromewebstore.google.com'), text);
  await page.close();
}

// ---- 13. footer stays usable while the settings are locked ----
{
  const { page: p0 } = await open(browser, {});
  const record = await p0.evaluate(() => window.PMLock.create('hunter2'));
  await p0.close();

  const { page } = await open(browser, { pm_lock: record, pm_ackNotPerfect: ACK });
  const s = await page.evaluate(snapshot);
  check('locked: Share still enabled', s.shareDisabled === false);
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
    // Step 5 is the 0.1.33 completion view, reached only by finishing.
    step: [1, 2, 3, 4, 5].filter(i => !document.getElementById('ob-step-' + i).classList.contains('pm-hidden')),
    dotsDone: document.querySelectorAll('.ob-dot--done').length,
    finishHidden: document.getElementById('ob-finish').classList.contains('pm-hidden'),
    finishDisabled: document.getElementById('ob-finish').disabled,
    backDisabled: document.getElementById('ob-back').disabled,
    headerHidden: document.querySelector('.ob-header').classList.contains('pm-hidden'),
    navHidden: document.querySelector('.ob-nav').classList.contains('pm-hidden'),
    doneTitle: (document.querySelector('.ob-done-title') || {}).textContent,
    reviewHidden: (document.getElementById('ob-review') || {}).classList
      ? document.getElementById('ob-review').classList.contains('pm-hidden') : true,
    reviewHref: (document.getElementById('ob-review-link') || {}).href,
    pinShown: !!document.querySelector('.ob-pin'),
    ballotShown: !!document.querySelector('.ob-ballot'),
    markAlt: (document.querySelector('.ob-header .ob-mark') || {}).alt
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

  // Catch-up mode is preselected to "play" and writes through on change.
  const preselected = await page.evaluate(() =>
    [...document.getElementsByName('ob-catchup-mode')].find(r => r.checked)?.value
  );
  check('onboarding: play preselected', preselected === 'play', preselected);
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

  // ---- 0.1.33 completion view ----
  check('done: lands on the completion view', s.step.length === 1 && s.step[0] === 5, s.step);
  check('done: large completion headline', /You're all set\./.test(s.doneTitle || ''), s.doneTitle);
  check('done: the stale header goes with it', s.headerHidden === true);
  check('done: the setup nav goes with it', s.navHidden === true);
  check('done: review module shown', s.reviewHidden === false);
  check('done: review CTA points at the store review URL', /\/reviews$/.test(s.reviewHref || ''), s.reviewHref);
  check('done: pin request removed', s.pinShown === false);
  check('done: ballot illustration present', s.ballotShown === true);

  const doneText = await page.evaluate(() => document.getElementById('ob-step-5').innerText);
  check('done: no incentive language anywhere in the ask',
    !/free trial|discount|reward|unlock|premium|coupon|gift/i.test(doneText), doneText);
  check('done: no fake social proof', !/\d+[,\d]*\s+(users|people|installs|reviews)/i.test(doneText), doneText);
  check('done: declining is offered plainly', /Maybe later/.test(doneText), doneText);
  check('done: names the next action', /Open YouTube/.test(doneText), doneText);

  const growthShown = await page.evaluate(() => window.__pmLocal.pm_growth);
  check('done: shown counter recorded', !!growthShown && growthShown.completionReviewShown === 1, growthShown);

  // Declining must retire nothing and must not re-ask.
  await page.click('#ob-review-later');
  await page.waitForTimeout(80);
  let s2 = await page.evaluate(obSnap);
  const afterLater = await page.evaluate(() => ({
    growth: window.__pmLocal.pm_growth,
    prompt: window.__pmSync.pm_reviewPrompt
  }));
  check('done: Maybe later hides the module', s2.reviewHidden === true);
  check('done: Maybe later counts as a dismissal', afterLater.growth.completionReviewDismissed === 1, afterLater.growth);
  check('done: Maybe later retires NOTHING', afterLater.prompt === undefined, afterLater.prompt);

  await page.click('#ob-open-youtube');
  await page.waitForTimeout(60);
  const openedTabs = await page.evaluate(() => window.__pmTabs);
  check('done: Open YouTube opens youtube.com',
    openedTabs.some(u => /^https:\/\/www\.youtube\.com\/$/.test(u)), openedTabs);

  await page.click('#ob-share');
  await page.waitForTimeout(100);
  const shared = await page.evaluate(() => window.__pmClipboard);
  check('done: share copies the standard blurb', /^I use Profanity Muter/.test(shared || ''), shared);
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

// ===== 0.1.31 / 0.1.51: Report a problem =====

// ---- the popup link (0.1.52: on Home, outside the gated region) ----
{
  const { page, errors } = await open(browser, {});
  check('report link: no page errors', errors.length === 0, errors);
  // It lives on Home now, reachable without opening any gated sub-screen.
  const onHome = await page.evaluate(() => {
    const el = document.getElementById('pm-report-problem');
    const home = document.getElementById('pm-view-home');
    const gate = home.querySelector('.pm-gate');
    return {
      present: !!el,
      disabled: el.disabled,
      insideHome: home.contains(el),
      insideGate: gate.contains(el)
    };
  });
  check('report link: present and enabled on Home', onHome.present && onHome.disabled === false, onHome);
  check('report link: sits OUTSIDE the gated region', onHome.insideHome === true && onHome.insideGate === false, onHome);
  await page.click('#pm-report-problem');
  await page.waitForTimeout(50);
  const tabs = await page.evaluate(() => window.__pmTabs);
  check('report link: opens the report page', tabs.length === 1 && /report\/report\.html$/.test(tabs[0]), tabs);
  await page.close();
}

// ---- 0.1.52: Report a problem stays reachable while LOCKED; Copy debug log
//      does not (it exposes watched-video titles, so it is gated on purpose) ----
{
  const { page: p0 } = await open(browser, {});
  const record = await p0.evaluate(() => window.PMLock.create('hunter2'));
  await p0.close();

  const { page, errors } = await open(browser, { pm_lock: record });
  check('locked report: no page errors', errors.length === 0, errors);
  let s = await page.evaluate(snapshot);
  check('locked report: settings are actually locked', s.homeOverlayHidden === false);

  // Report a problem is not blurred/gated and still opens the report page.
  const reportReachable = await page.evaluate(() => {
    const el = document.getElementById('pm-report-problem');
    const gate = document.querySelector('#pm-view-home .pm-gate');
    return { present: !!el, disabled: el.disabled, insideGate: gate.contains(el) };
  });
  check('locked report: Report a problem is reachable (ungated, enabled)',
    reportReachable.present && reportReachable.disabled === false && reportReachable.insideGate === false,
    reportReachable);
  await page.click('#pm-report-problem');
  await page.waitForTimeout(50);
  const tabs = await page.evaluate(() => window.__pmTabs);
  check('locked report: it opens the report page even while locked',
    tabs.length === 1 && /report\/report\.html$/.test(tabs[0]), tabs);
  await page.close();

  // Copy debug log lives in Playback & display, which is behind the lock.
  // The overlay physically covers the drill (pointer events are intercepted),
  // so a real click cannot even reach it; and forcing the handler anyway must
  // still refuse to open Playback (it prompts to unlock instead). Either way
  // the log stays unreachable while locked.
  const { page: page2 } = await open(browser, { pm_lock: record });
  const drillCovered = await page2.evaluate(() => {
    const drill = document.getElementById('pm-go-playback');
    const r = drill.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const overlay = document.getElementById('pm-home-overlay');
    return overlay.contains(top) || top === overlay;
  });
  check('locked report: the Playback drill is physically covered by the lock overlay',
    drillCovered === true);
  await page2.evaluate(() => document.getElementById('pm-go-playback').click());
  await page2.waitForTimeout(50);
  const s2 = await page2.evaluate(snapshot);
  check('locked report: forcing the drill still does not open Playback (Copy debug log gated)',
    s2.view === 'home', s2.view);
  await page2.close();
}

// ---- the health card's report button works whenever it is shown ----
{
  const health = { status: 'unhealthy', message: 'Not muting on this video', detail: 'The analyzer is not running.' };
  const { page } = await open(browser, {}, {}, health);
  await page.waitForTimeout(80);
  const shown = await page.evaluate(() => !document.getElementById('pm-health').classList.contains('pm-hidden'));
  check('report link: health card shown when unhealthy', shown === true);
  await page.click('#pm-health-report');
  await page.waitForTimeout(50);
  const tabs = await page.evaluate(() => window.__pmTabs);
  check('report link: health card report opens the report page', tabs.length === 1 && /report\/report\.html$/.test(tabs[0]), tabs);
  await page.close();
}
// ---- 0.1.52: navy/gold palette, no Chrome-default blue ----
// The selected radio/segmented state is navy ink, the on/off switch "on" is
// the success green, and text links are gold-deep. None of them may render
// the old blue accent (#4f7cff = rgb(79,124,255)).
{
  const { page } = await open(browser, {});
  // Switch "on" track (master switch, on by default): success green.
  const switchBg = await page.evaluate(() => {
    const t = document.querySelector('#pm-enabled:checked + .pm-switch-track');
    return getComputedStyle(t).backgroundColor;
  });
  check('palette: on/off switch "on" is green, not blue',
    switchBg === 'rgb(47, 125, 91)', switchBg);

  // A text link (Setup guide) is gold-deep.
  const linkColor = await page.evaluate(() =>
    getComputedStyle(document.getElementById('pm-open-onboarding')).color);
  check('palette: footer links are gold-deep, not blue',
    linkColor === 'rgb(138, 109, 31)', linkColor);

  // Selected segmented control (Playback: padding "Normal" checked) is navy.
  await page.click('#pm-go-playback');
  const segBg = await page.evaluate(() => {
    const s = document.querySelector('#pm-padding-normal:checked + span');
    return getComputedStyle(s).backgroundColor;
  });
  check('palette: selected segmented state is navy ink, not blue',
    segBg === 'rgb(29, 47, 84)', segBg);

  // No element anywhere paints the old default blue.
  const noBlue = await page.evaluate(() => {
    const blues = ['rgb(79, 124, 255)', 'rgb(109, 147, 255)'];
    return [...document.querySelectorAll('*')].every(el => {
      const cs = getComputedStyle(el);
      return !blues.includes(cs.color) && !blues.includes(cs.backgroundColor);
    });
  });
  check('palette: the old blue accent appears nowhere', noBlue === true);
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
  check('report: mail draft opened', typeof mailto === 'string' && mailto.startsWith('mailto:profanity.muter@gmail.com?'), mailto);
  check('report: fallback link has the same href', s.mailto === mailto, s.mailto);
  check('report: support address shown as text too', s.email === 'profanity.muter@gmail.com', s.email);

  const subject = decodeURIComponent((mailto.split('?subject=')[1] || '').split('&body=')[0]);
  const body = decodeURIComponent(mailto.split('&body=')[1] || '');
  check('report: subject is versioned', subject === 'Profanity Muter problem report v' + MANIFEST_VERSION, subject);
  check('report: body carries the user text', body.includes('swearing at 1:20 was not muted'));
  check('report: body carries the paste instruction', body.includes('paste it below this line before sending'));
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

// ---- completion review: clicking the CTA retires every later ask ----
{
  const OB3 = pathToFileURL(path.join(EXT, 'onboarding', 'onboarding.html')).href;
  const page = await browser.newPage();
  await page.addInitScript(stub({}, {}));
  await page.goto(OB3);
  await page.waitForTimeout(120);
  await page.click('#ob-next');
  await page.click('#ob-next');
  await page.click('#ob-next');
  await page.click('#ob-ack-check');
  await page.click('#ob-finish');
  await page.waitForTimeout(150);
  // Suppress the anchor's navigation; we only care about the side effects.
  await page.evaluate(() => {
    document.getElementById('ob-review-link').addEventListener('click', (e) => e.preventDefault(), true);
  });
  await page.click('#ob-review-link');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => ({
    prompt: window.__pmSync.pm_reviewPrompt,
    growth: window.__pmLocal.pm_growth
  }));
  check('done: clicking the CTA counts the click', after.growth.completionReviewClicked === 1, after.growth);
  check('done: clicking the CTA writes pm_reviewPrompt',
    !!after.prompt && after.prompt.dismissed === true, after.prompt);
  // Which is exactly what makes every later surface stand down.
  const stood = await page.evaluate(() => {
    const M = window.PMMoments;
    const v = M.reviewPromptEligibility({
      stats: { videosProtected: 99, totalMuted: 99 },
      installedAt: Date.now() - 40 * 24 * 3600 * 1000,
      ack: { version: 1, timestamp: 1 },
      reviewPrompt: window.__pmSync.pm_reviewPrompt,
      now: Date.now()
    });
    return { eligible: v.eligible, reason: v.reason };
  });
  check('done: the milestone surfaces are retired by that write',
    stood.eligible === false && stood.reason === 'already-prompted', stood);
  await page.close();
}

// ---- 0.1.36: the popup page must survive being opened as a TAB ----
// The badge's click falls back to opening popup/popup.html in a tab when
// chrome.action.openPopup() is unavailable, so a layout that breaks at tab
// width would turn the fallback into a worse experience than no affordance.
{
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(stub({ pm_ackNotPerfect: ACK }, {}));
  await page.goto(URL);
  await page.waitForTimeout(150);
  const layout = await page.evaluate(() => ({
    bodyWidth: document.body.getBoundingClientRect().width,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    saveVisible: !!document.getElementById('pm-open-onboarding').offsetParent,
    healthPresent: !!document.getElementById('pm-health')
  }));
  check('popup-as-tab: stays a narrow column rather than stretching', layout.bodyWidth <= 400, layout.bodyWidth);
  check('popup-as-tab: no horizontal overflow', layout.overflowX === false);
  check('popup-as-tab: primary controls still rendered', layout.saveVisible === true && layout.healthPresent === true);
  await page.close();
}

// ===== 0.1.32: health warning banner =====
//
// The popup asks the active tab's content script how it is doing, so the
// harness injects that reply (third argument to open()). null means no
// content script answered, which is the not-a-YouTube-tab case.

// ---- 26. no answer from the tab: show nothing ----
{
  const { page, errors } = await open(browser, { pm_ackNotPerfect: ACK }, {}, null);
  const s = await page.evaluate(snapshot);
  check('health: no page errors when no tab answers', errors.length === 0, errors);
  check('health: banner hidden when no content script answers', s.healthHidden === true);
  const queried = await page.evaluate(() => window.__pmHealthQueries);
  check('health: the popup did ask', queried === 1, queried);
  await page.close();
}

// ---- 27. healthy tab: still nothing ----
{
  const { page } = await open(browser, { pm_ackNotPerfect: ACK }, {}, { status: 'ok', reason: null, message: '', detail: '' });
  const s = await page.evaluate(snapshot);
  check('health: banner hidden when the pipeline is ok', s.healthHidden === true);
  await page.close();
}

// ---- 28. unhealthy tab: the warning appears ----
{
  const unhealthy = {
    status: 'unhealthy',
    reason: 'no-audio-intercepted',
    message: "Profanity Muter can't read this video's audio. YouTube may have changed how it delivers audio, or this video is protected. Filtering is off for this video.",
    detail: 'No audio from this video reached the extension.'
  };
  const { page, errors } = await open(browser, { pm_ackNotPerfect: ACK }, {}, unhealthy);
  const s = await page.evaluate(snapshot);
  check('health: no page errors', errors.length === 0, errors);
  check('health: banner shown', s.healthHidden === false);
  check('health: states the consequence, not just the cause', /Filtering is off for this video/.test(s.healthMessage), s.healthMessage);
  check('health: names why it cannot read the audio', /YouTube may have changed how it delivers audio/.test(s.healthMessage), s.healthMessage);
  check('health: shows the cause underneath', s.healthDetail === unhealthy.detail, s.healthDetail);
  const noEmoji = await page.evaluate(() => {
    const t = document.getElementById('pm-health').innerText;
    return !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t);
  });
  check('health: no emoji in the warning', noEmoji === true);

  await page.click('#pm-health-report');
  await page.waitForTimeout(50);
  const tabs = await page.evaluate(() => window.__pmTabs);
  check('health: its Report a problem link opens the report page', tabs.length === 1 && /report\/report\.html$/.test(tabs[0]), tabs);
  await page.close();
}

// ---- 29. the warning outranks the setup banner, and survives the lock ----
{
  const unhealthy = {
    status: 'unhealthy',
    reason: 'model-load-failed',
    message: "Profanity Muter couldn't load its speech model, so this video is NOT being filtered. Reload the page to try again.",
    detail: 'The speech model could not be loaded.'
  };
  // Unacknowledged (so the setup banner is also up) AND locked.
  const { page: p0 } = await open(browser, {});
  const record = await p0.evaluate(() => window.PMLock.create('hunter2'));
  await p0.close();

  const { page } = await open(browser, { pm_lock: record }, {}, unhealthy);
  const s = await page.evaluate(snapshot);
  check('health: shown alongside the setup banner', s.healthHidden === false && s.bannerHidden === false);
  check('health: shown while settings are locked', s.healthHidden === false && s.homeOverlayHidden === false);
  const order = await page.evaluate(() => {
    const h = document.getElementById('pm-health');
    const b = document.getElementById('pm-finish-setup');
    return (h.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  check('health: sits above the setup banner', order === true);
  await page.close();
}

// ---- 30. an unsupported verdict is NOT the alarming banner ----
{
  const live = {
    status: 'unsupported',
    reason: 'livestream-unsupported',
    message: "Livestreams aren't filtered. Profanity Muter needs to analyze audio a little ahead of what you hear, which a live stream doesn't allow.",
    detail: "Live video can't be analyzed ahead of playback."
  };
  const { page } = await open(browser, { pm_ackNotPerfect: ACK }, {}, live);
  const s = await page.evaluate(snapshot);
  check('health: a livestream does not raise the broken-filter banner', s.healthHidden === true);
  await page.close();
}

// ---- 31. a served-elsewhere (multi-tab) verdict is NOT the alarming banner ----
// 0.1.49 active-tab-follow: when another tab is being filtered, this tab's
// health is WAITING, not unhealthy. The popup always queries the ACTIVE tab
// (which is by definition the one being served), so this state should never
// raise the broken-filter banner. The calm, actionable copy lives on the
// on-video badge instead (shared/pill.js "other-tab").
{
  const waiting = {
    status: 'waiting',
    reason: 'served-elsewhere',
    message: "Profanity Muter filters one video at a time, and another tab is being filtered right now. Switch to this tab, or pause the other video, to filter this one.",
    detail: "The shared analyzer is busy with another tab and will switch to this one when you do."
  };
  const { page } = await open(browser, { pm_ackNotPerfect: ACK }, {}, waiting);
  const s = await page.evaluate(snapshot);
  check('health: a served-elsewhere tab does not raise the broken-filter banner', s.healthHidden === true);
  await page.close();
}

await browser.close();
console.log(`popup_check: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
