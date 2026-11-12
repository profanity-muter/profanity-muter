// Headless wake/park reproduction on REAL YouTube (0.1.63). No production hook:
// the idle teardown is forced by backdating background.js's own idleState in the
// service worker and calling its real idleCheck() (same closeDocument path).
//   PM_PLAYWRIGHT=<path to playwright/index.mjs> node verify/run_wake.mjs paused|spa [--json out.json]
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PM_PLAYWRIGHT ? pathToFileURL(process.env.PM_PLAYWRIGHT).href : 'playwright');
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.argv[2] || 'paused';
const VIDEO = 'UF8uR6Z6KLc';
const t0 = Date.now();
const lines = [];
const rel = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const log = (tag, text) => lines.push(`[${rel()}] ${tag} ${text}`);
const say = (...a) => console.log(`[${rel()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-wake-'));
const ctx = await chromium.launchPersistentContext(prof, {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run']
});
let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
sw.on('console', (m) => log('[bg]', m.text()));
const extId = sw.url().split('/')[2];
ctx.on('page', (p) => { p.on('console', (m) => log('[page]', m.text())); });

const swEval = (fn, arg) => sw.evaluate(fn, arg);
const offscreenOpen = () => swEval(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0);
async function forceTeardown() {
  // Same state transition as 10 idle minutes with nobody playing, through the real idleCheck().
  await swEval(async () => { idleState.idleSince = Date.now() - 11 * 60000; await idleCheck(); });
  for (let i = 0; i < 20 && (await offscreenOpen()); i++) await sleep(250);
  return { open: await offscreenOpen(), parked: await swEval(() => idleState.parked) };
}
async function health(page) {
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup/popup.html`).catch(() => {});
  const r = await pop.evaluate(() => new Promise((res) => chrome.tabs.query({ url: '*://www.youtube.com/*' }, (tabs) => {
    const t = tabs.find((x) => x.active) || tabs[0];
    chrome.tabs.sendMessage(t.id, { type: 'pm-health-query' }, (resp) => res(resp || { err: String(chrome.runtime.lastError && chrome.runtime.lastError.message) }));
  })));
  await pop.close();
  return r;
}
const windows = () => lines.filter((l) => /\[PM\] window start=/.test(l));
const state = (page) => page.evaluate(() => { const v = document.querySelector('video'); return v ? { t: +v.currentTime.toFixed(1), paused: v.paused, bufEnd: v.buffered.length ? +v.buffered.end(v.buffered.length - 1).toFixed(1) : null } : null; });
async function skipAds(page) {
  for (let i = 0; i < 30; i++) {
    const ad = await page.evaluate(() => { const b = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern'); if (b) b.click(); return !!document.querySelector('.ad-showing'); });
    if (!ad) return; await sleep(1000);
  }
}
const out = { mode: MODE };
try {
  const page = await ctx.newPage();
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  const consent = page.locator('button:has-text("Accept all"), button:has-text("Reject all")');
  if (await consent.first().isVisible({ timeout: 2000 }).catch(() => false)) await consent.first().click().catch(() => {});

  if (MODE === 'spa') {
    // Home page first. Park while sitting on the home page (nothing playing), then navigate in-page.
    out.teardown = await forceTeardown();
    say('parked on home:', JSON.stringify(out.teardown));
    // Logged-out home has no feed: SPA-search for the video, hover its result so the inline
    // preview plays (the field state: play begins on a non-watch page), then click it (real SPA nav).
    await page.locator('input[name="search_query"], input#search').first().fill(VIDEO);
    await page.keyboard.press('Enter');
    await page.waitForSelector('ytd-video-renderer a#thumbnail', { timeout: 20000 });
    const thumb = page.locator('ytd-video-renderer a#thumbnail').first();
    await thumb.hover({ force: true, timeout: 5000 }).catch(() => {}); await sleep(4000);
    out.homePreview = await state(page);
    say('results-page preview video state:', JSON.stringify(out.homePreview));
    await page.locator('ytd-video-renderer a#video-title').first().click();
    await page.waitForFunction((id) => location.search.includes(id), VIDEO, { timeout: 30000 }).catch(() => {});
    out.spaNav = await page.evaluate(() => ({ url: location.href, navEntries: performance.getEntriesByType('navigation').length }));
    await skipAds(page);
  } else {
    await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('video', { timeout: 20000 });
    await skipAds(page);
    await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
    await sleep(20000); // build real coverage + buffer ahead
    say('before pause', JSON.stringify(await state(page)), 'windows', windows().length);
    await page.evaluate(() => document.querySelector('video').pause());
    await sleep(2000);
    out.teardown = await forceTeardown();
    say('parked after pause:', JSON.stringify(out.teardown));
    await sleep(3000);
    await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
  }
  const pressWall = Date.now();
  const winBefore = windows().length;
  say('PLAY pressed, state', JSON.stringify(await state(page)));
  if (MODE !== 'spa') await page.evaluate(() => document.querySelector('video').play().catch(() => {}));
  let firstWinAt = null;
  for (let i = 0; i < 70; i++) {
    await sleep(1000);
    if (!firstWinAt && windows().length > winBefore) { firstWinAt = Date.now(); say('first window after wake:', windows()[winBefore]); }
    if (i % 10 === 9) say('t+' + (i + 1) + 's', JSON.stringify(await state(page)), 'newWindows', windows().length - winBefore, 'offscreen', await offscreenOpen());
  }
  out.offscreenAfter = await offscreenOpen();
  out.newWindows = windows().length - winBefore;
  out.firstWindowMsAfterPlay = firstWinAt ? firstWinAt - pressWall : null;
  out.health = await health(page);
  out.finalState = await state(page);
  out.wakeLines = lines.filter((l) => /IDLE-WAKE|IDLE-TEARDOWN|NO-WINDOW|PM-SKIP|RUN-REBUILD|segment received before|rebuilt|new byte run/.test(l)).slice(0, 40);
  out.devlog = await swEval(async () => { const o = await chrome.storage.local.get('pm_devlog'); const v = (o.pm_devlog && o.pm_devlog.videos) || []; return v.slice(-2).map((e) => JSON.stringify(e).slice(0, 1500)); });
} catch (e) { out.error = String(e && e.stack || e); }
console.log('\n=== RESULT ===\n' + JSON.stringify(out, null, 1));
const i = process.argv.indexOf('--json'); if (i > 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify({ out, lines }, null, 1));
await ctx.close();
process.exit(out.newWindows > 0 ? 0 : 2);
