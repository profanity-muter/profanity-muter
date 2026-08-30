// Verify the capture.js MAIN-world MediaSource hook actually intercepts
// YouTube's audio SourceBuffer appends and can decode them.
const path = require('path');
const { chromium } = require('playwright');

const EXT_DIR = __dirname;
const VIDEO_URL = process.argv[2] || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const RUN_MS = 30000;
const PROFILE_DIR = path.join(__dirname, '.pw-profile');

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  });

  const page = context.pages()[0] || (await context.newPage());

  const captureLines = [];
  const errLines = [];
  const allLines = [];

  page.on('console', (msg) => {
    const text = msg.text();
    allLines.push(text);
    if (text.startsWith('[CAPTURE-ERR]')) {
      errLines.push(text);
      console.log('ERR:', text);
    } else if (text.startsWith('[CAPTURE]')) {
      captureLines.push(text);
      console.log('CAP:', text);
    }
  });

  page.on('pageerror', (err) => {
    console.log('PAGEERROR:', err.message);
  });

  console.log('Navigating to', VIDEO_URL);
  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Try to dismiss consent dialogs if present (best effort, non-fatal).
  try {
    const consentBtn = page.locator(
      'button:has-text("Accept all"), button:has-text("I agree"), button:has-text("Reject all")'
    );
    if (await consentBtn.first().isVisible({ timeout: 5000 })) {
      await consentBtn.first().click({ timeout: 5000 });
      console.log('Dismissed consent dialog');
    }
  } catch (e) {
    console.log('No consent dialog dismissed (ok):', e.message);
  }

  // Ensure playback starts.
  try {
    await page.waitForSelector('video', { timeout: 20000 });
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.muted = true;
        v.play().catch(() => {});
      }
    });
  } catch (e) {
    console.log('Could not find/play video element:', e.message);
  }

  console.log(`Collecting console output for ${RUN_MS / 1000}s...`);
  await page.waitForTimeout(RUN_MS);

  // Nudge play again in case autoplay was blocked initially.
  try {
    const state = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { paused: v.paused, currentTime: v.currentTime, readyState: v.readyState } : null;
    });
    console.log('Video state:', JSON.stringify(state));
  } catch (e) {
    console.log('Could not read video state:', e.message);
  }

  console.log('\n--- SUMMARY ---');
  console.log('Total console lines:', allLines.length);
  console.log('[CAPTURE] lines:', captureLines.length);
  console.log('[CAPTURE-ERR] lines:', errLines.length);

  const withDecoded = captureLines.filter((l) => {
    const m = l.match(/decodedSec=([0-9.]+)/);
    return m && parseFloat(m[1]) > 0;
  });
  console.log('[CAPTURE] lines with decodedSec > 0:', withDecoded.length);
  withDecoded.slice(0, 5).forEach((l) => console.log('  ', l));

  const aheadVals = captureLines
    .map((l) => {
      const m = l.match(/aheadSec=([0-9.-]+)/);
      return m ? parseFloat(m[1]) : NaN;
    })
    .filter((v) => !isNaN(v));
  if (aheadVals.length) {
    console.log('aheadSec min/max/avg:', Math.min(...aheadVals), Math.max(...aheadVals), (
      aheadVals.reduce((a, b) => a + b, 0) / aheadVals.length
    ).toFixed(2));
  }

  const success = withDecoded.length >= 2;
  console.log('\nRESULT:', success ? 'SUCCESS' : 'FAILURE');

  await context.close();
  process.exit(success ? 0 : 1);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
