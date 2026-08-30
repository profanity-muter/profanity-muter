// Focused verification for the run.timeOffset drift fix + pause-catchup mode
// + mid-playback safe-mode toggle, on the regression video (o-7Fvkq-Nug).
// Separate from run_playwright.mjs (scenarios 1/2) to iterate on this fix
// quickly without re-running the whole suite.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-offset-check-'));
const VIDEO_URL = 'https://www.youtube.com/watch?v=o-7Fvkq-Nug';
const SEEK_A = Number(process.env.PM_SEEK_A || 55);
const SEEK_B = Number(process.env.PM_SEEK_B || 2540);
const PLAY_MS_A = Number(process.env.PM_PLAY_MS_A || 60000);
const PLAY_MS_B = Number(process.env.PM_PLAY_MS_B || 60000);
const TOGGLE_PLAY_MS = Number(process.env.PM_TOGGLE_PLAY_MS || 30000);

function nowTag() {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

async function main() {
  console.log('Profile:', PROFILE_DIR);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--no-first-run',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion,TabDiscarding'
    ]
  });

  const allLines = [];
  function log(tag, text) {
    const line = `[${nowTag()}] ${tag} ${text}`;
    allLines.push(line);
    console.log(line);
  }
  context.on('page', (p) => {
    p.on('console', (msg) => log('[offscreen?]', msg.text()));
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  if (!sw) {
    console.error('No service worker — aborting');
    await context.close();
    process.exit(1);
  }
  sw.on('console', (msg) => log('[bg]', msg.text()));
  const extId = sw.url().split('/')[2];

  const settingsPage = await context.newPage();
  await settingsPage.goto(`chrome-extension://${extId}/popup/popup.html`).catch(() => {});
  await settingsPage.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.storage.sync.set({ pm_enabled: true, pm_safeMode: true, pm_muteAudio: true, pm_wordlist: [], pm_catchupMode: 'mute' }, resolve)
      )
  );
  await settingsPage.close();

  const page = await context.newPage();
  page.on('console', (msg) => log('[page]', msg.text()));

  console.log('\n=== Navigating to', VIDEO_URL, '===');
  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('video', { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => document.querySelector('video')?.play().catch(() => {}));

  async function retrySeekAndCollect(targetT, playMs, label) {
    console.log(`\n--- ${label}: retry-seeking to t=${targetT}, collecting ${playMs}ms ---`);
    const samples = [];
    const deadline = Date.now() + playMs;
    let landed = false;
    while (Date.now() < deadline) {
      const state = await page
        .evaluate(
          ({ t, alreadyLanded }) => {
            var skipBtn = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern');
            if (skipBtn) skipBtn.click();
            var v = document.querySelector('video');
            var adShowing = !!document.querySelector('.ad-showing, .ytp-ad-player-overlay');
            if (!v) return null;
            var dur = v.duration;
            var target = isFinite(dur) && dur > 0 ? Math.min(t, Math.max(0, dur - 10)) : t;
            if (v.paused && !adShowing) v.play().catch(function () {});
            var justLanded = !alreadyLanded && !adShowing && Math.abs(v.currentTime - target) < 3;
            if (!alreadyLanded && !adShowing && !justLanded) v.currentTime = target;
            return { t: v.currentTime, duration: dur, paused: v.paused, muted: v.muted, adShowing: adShowing, justLanded: justLanded, target: target };
          },
          { t: targetT, alreadyLanded: landed }
        )
        .catch(() => null);
      if (state) {
        samples.push({ wall: Date.now(), ...state });
        if (state.justLanded && !landed) {
          landed = true;
          console.log(`${label}: landed at t=${state.t.toFixed(2)} (requested ${state.target.toFixed(2)}, duration=${state.duration})`);
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`${label}: landed overall = ${landed}, final t = ${samples.length ? samples[samples.length - 1].t.toFixed(2) : 'NA'}`);
    return { samples, landed };
  }

  const resultA = await retrySeekAndCollect(SEEK_A, PLAY_MS_A, 'REGION-A(~55-75s)');
  const resultB = await retrySeekAndCollect(SEEK_B, PLAY_MS_B, 'REGION-B(~2540-2560s)');

  // --- Mid-playback safe-mode toggle: turn OFF, then back ON, and confirm
  // unmute follows within a few seconds once coverage genuinely spans the
  // playhead (not just because safeMode is off).
  console.log('\n--- SAFE-MODE TOGGLE: OFF -> ON mid-playback ---');
  // chrome.storage is only reachable from an extension-context page, not a
  // regular web page's page.evaluate (even with a content script injected
  // into it) — must go through the extension settings page, same as initial
  // seeding.
  const togglePage = await context.newPage();
  await togglePage.goto(`chrome-extension://${extId}/popup/popup.html`).catch(() => {});
  await togglePage.evaluate(() => new Promise((r) => chrome.storage.sync.set({ pm_safeMode: false }, r)));
  await new Promise((r) => setTimeout(r, 2000));
  const toggleOnWall = Date.now();
  await togglePage.evaluate(() => new Promise((r) => chrome.storage.sync.set({ pm_safeMode: true }, r)));
  await togglePage.close().catch(() => {});
  console.log('safeMode re-enabled at wall=' + toggleOnWall);
  const toggleSamples = [];
  const toggleDeadline = Date.now() + TOGGLE_PLAY_MS;
  while (Date.now() < toggleDeadline) {
    const state = await page.evaluate(() => {
      var v = document.querySelector('video');
      return v ? { t: v.currentTime, muted: v.muted, paused: v.paused } : null;
    }).catch(() => null);
    if (state) toggleSamples.push({ wall: Date.now(), ...state });
    await new Promise((r) => setTimeout(r, 500));
  }

  await page.close().catch(() => {});

  // ==== Analysis ====
  console.log('\n\n================ OFFSET/DRIFT ANALYSIS ================\n');
  const anchorLines = allLines.filter((l) => l.includes('[PM-ANCHOR]'));
  const driftLines = allLines.filter((l) => l.includes('[PM-DRIFT]'));
  const resampleWarnLines = allLines.filter((l) => l.includes('[PM-RESAMPLE-WARN]'));
  const energyLines = allLines.filter((l) => l.includes('[PM-ENERGY]'));
  const clampLines = allLines.filter((l) => l.includes('CLAMP word='));
  const stallLines = allLines.filter((l) => l.includes('PM-STALL'));
  const muteLines = allLines.filter((l) => l.includes('MUTE engaged') || l.includes('MUTE released') || l.includes('PAUSE-CATCHUP'));
  const invalidateLines = allLines.filter((l) => l.includes('invalidate'));
  const resyncLines = allLines.filter((l) => l.includes('RESYNC') || l.includes('resync'));

  console.log('[PM-ANCHOR] lines:', anchorLines.length);
  anchorLines.forEach((l) => console.log('  ', l));
  console.log('\n[PM-DRIFT] lines (corrections applied):', driftLines.length);
  driftLines.forEach((l) => console.log('  ', l));
  console.log('\n[PM-RESAMPLE-WARN] lines:', resampleWarnLines.length);
  resampleWarnLines.slice(0, 10).forEach((l) => console.log('  ', l));
  console.log('\n[PM-ENERGY] low-RMS lines:', energyLines.length);
  energyLines.slice(0, 10).forEach((l) => console.log('  ', l));
  console.log('\nCLAMP (word-timestamp smear) lines:', clampLines.length);
  clampLines.slice(0, 15).forEach((l) => console.log('  ', l));
  console.log('\nSTALL lines:', stallLines.length);
  stallLines.forEach((l) => console.log('  ', l));
  console.log('\ninvalidate/resync lines:', invalidateLines.length + resyncLines.length);
  invalidateLines.concat(resyncLines).forEach((l) => console.log('  ', l));

  console.log('\n--- Raw transcript windows overlapping REGION-A [' + SEEK_A + ',' + (SEEK_A + 20) + ') ---');
  const winRe = /\[PM\] window start=([\d.]+) end=([\d.]+)/;
  const allWindowLines = allLines.filter((l) => l.includes('[bg]') && l.includes('[PM] window'));
  allWindowLines.forEach((l) => {
    const m = l.match(winRe);
    if (m) {
      const start = parseFloat(m[1]), end = parseFloat(m[2]);
      if (end > SEEK_A - 5 && start < SEEK_A + 25) console.log('  ', l);
    }
  });
  console.log('\n--- Raw transcript windows overlapping REGION-B [' + SEEK_B + ',' + (SEEK_B + 20) + ') ---');
  allWindowLines.forEach((l) => {
    const m = l.match(winRe);
    if (m) {
      const start = parseFloat(m[1]), end = parseFloat(m[2]);
      if (end > SEEK_B - 5 && start < SEEK_B + 25) console.log('  ', l);
    }
  });

  console.log('\n--- All mute/pause-catchup lines ---');
  muteLines.forEach((l) => console.log('  ', l));

  console.log('\n--- Safe-mode re-enable -> unmute latency ---');
  const firstAfterToggle = toggleSamples[0];
  const firstUnmuted = toggleSamples.find((s) => !s.muted);
  if (firstUnmuted) {
    console.log('Unmuted within', ((firstUnmuted.wall - toggleOnWall) / 1000).toFixed(1) + 's of re-enabling safeMode. t=' + firstUnmuted.t.toFixed(2));
  } else {
    console.log('Never observed unmuted in the', TOGGLE_PLAY_MS, 'ms after re-enabling safeMode. Samples:', JSON.stringify(toggleSamples.slice(0, 10)));
  }

  fs.writeFileSync(path.join(__dirname, 'last_offset_check.log'), allLines.join('\n'));
  await context.close();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
