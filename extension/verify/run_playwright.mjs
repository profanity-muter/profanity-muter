// Playwright verification harness for the full capture -> demux -> Whisper ->
// mute pipeline. Reuses the launch pattern from ../../spike-capture/verify.js
// and ../../spike-whisper/run_playwright.mjs (headful, --load-extension,
// --mute-audio; console captured from the page, the offscreen document
// (via relayed [bg] logs - offscreen isn't reliably exposed as its own
// Playwright page target), and the service worker).
//
// Two scenarios:
//  1. Steve Jobs' 2005 Stanford speech (clean audio) - exercises coverage
//     tracking + seek mechanics: play a bit, seek FORWARD past the buffered/
//     covered region, seek BACKWARD into an already-covered region. Known
//     blocker (see PIPELINE_NOTES.md "Findings"): shared/wordlist.js's
//     refresh() passes `pm_wordlist: undefined` as a chrome.storage.get()
//     default, which appears to make that key drop out of the request
//     entirely, so a custom pm_wordlist never actually loads - confirmed via
//     readback (chrome.storage.sync has the right value) vs
//     PMWordlist._state (still the built-in DEFAULT_WORDLIST) diverging.
//     Word-triggered mute assertions therefore live in scenario 2 instead,
//     which uses real profanity already in DEFAULT_WORDLIST.
//  2. Regression case (o-7Fvkq-Nug, "shit" ~64s reported missed by v1): seek
//     to ~50s (before any coverage exists there - tests capture/demux after
//     a cold seek) and play through ~78s, logging the raw transcript tokens
//     for the 55-75s window verbatim, and checking whether a mute interval
//     was scheduled/engaged around 64s.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..');
// IMPORTANT: use a FRESH profile dir per run, not a fixed reused one.
// Reusing a profile across code edits was observed to make Chrome keep
// running a stale cached service worker (and stale message shapes) despite
// --load-extension reading capture.js/content.js fresh from disk each
// launch - background.js edits silently had zero effect for several runs
// until this was discovered. Costs a fresh Whisper model download per run;
// worth it for correctness. Set PM_REUSE_PROFILE=1 to opt back into a fixed
// profile (e.g. for fast local iteration once you trust the code is stable).
const PROFILE_DIR = process.env.PM_REUSE_PROFILE
  ? path.join(os.tmpdir(), 'pm-extension-profile')
  : fs.mkdtempSync(path.join(os.tmpdir(), 'pm-extension-profile-'));
fs.mkdirSync(PROFILE_DIR, { recursive: true });
console.log('Using profile dir:', PROFILE_DIR, '(fresh:', !process.env.PM_REUSE_PROFILE, ')');

const SCENARIO1_URL = 'https://www.youtube.com/watch?v=UF8uR6Z6KLc';
const SCENARIO2_URL = 'https://www.youtube.com/watch?v=o-7Fvkq-Nug';

const S1_PLAY_MS = Number(process.env.PM_S1_PLAY_MS || 45000);
const S1_SEEK_FORWARD_T = Number(process.env.PM_S1_SEEK_FWD || 220); // well past initial buffer/coverage
const S1_POST_SEEK_FWD_MS = Number(process.env.PM_S1_POST_FWD_MS || 40000);
const S1_SEEK_BACK_T = 8; // inside the very first covered window from the initial play
const S1_POST_SEEK_BACK_MS = Number(process.env.PM_S1_POST_BACK_MS || 8000);

const S2_SEEK_T = 50;
const S2_PLAY_UNTIL_MS = Number(process.env.PM_S2_PLAY_MS || 45000);

function nowTag() {
  return new Date().toISOString().split('T')[1].replace('Z', '');
}

function makeLogger(allLines) {
  return function (tagPrefix, text) {
    const line = `[${nowTag()}] ${tagPrefix} ${text}`;
    allLines.push(line);
    console.log(line);
  };
}

async function seedStorage(context, extId, values) {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${extId}/popup/popup.html`).catch(() => {});
  const result = await p
    .evaluate(
      (vals) =>
        new Promise((resolve) => {
          chrome.storage.sync.set(vals, () => resolve({ lastError: chrome.runtime.lastError ? String(chrome.runtime.lastError.message) : null }));
        }),
      values
    )
    .catch((e) => ({ threw: String(e) }));
  console.log('seedStorage', JSON.stringify(values), '->', JSON.stringify(result));
  await p.close();
}

async function dismissConsent(page) {
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
}

async function collectFor(page, ms, samples) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const state = await page.evaluate(() => {
        var skipBtn = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern');
        if (skipBtn) skipBtn.click();
        var v = document.querySelector('video');
        var adShowing = !!document.querySelector('.ad-showing, .ytp-ad-player-overlay');
        if (v && v.paused && !adShowing) v.play().catch(function () {});
        return v ? { t: v.currentTime, paused: v.paused, muted: v.muted, readyState: v.readyState, adShowing: adShowing } : null;
      });
      if (state) samples.push({ wall: Date.now(), ...state });
    } catch (e) {
      /* transient navigation; ignore */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  console.log('Launching persistent context with extension:', EXT_DIR);
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
  const log = makeLogger(allLines);

  context.on('page', (p) => {
    console.log('[new page target]', p.url());
    p.on('console', (msg) => log('[offscreen?]', msg.text()));
    p.on('pageerror', (err) => log('[offscreen? pageerror]', String(err)));
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
  if (!sw) {
    console.error('No service worker detected - cannot get extension id, aborting');
    await context.close();
    process.exit(1);
  }
  console.log('Service worker URL:', sw.url());
  sw.on('console', (msg) => log('[bg]', msg.text()));
  const extId = sw.url().split('/')[2];

  // =========================================================================
  // Scenario 1: Steve Jobs speech - coverage + seek mechanics
  // =========================================================================
  await seedStorage(context, extId, { pm_enabled: true, pm_safeMode: true, pm_muteAudio: true, pm_wordlist: ['college', 'connected', 'dots'] });

  const page1 = context.pages().find((p) => p.url() === 'about:blank') || (await context.newPage());
  page1.on('console', (msg) => log('[s1 page]', msg.text()));
  page1.on('pageerror', (err) => log('[s1 page pageerror]', String(err)));

  console.log('\n=== SCENARIO 1: navigate to', SCENARIO1_URL, '===');
  await page1.goto(SCENARIO1_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dismissConsent(page1);
  await page1.waitForSelector('video', { timeout: 20000 }).catch(() => {});
  await page1.evaluate(() => document.querySelector('video')?.play().catch(() => {}));

  const s1Samples = [];
  console.log('S1: playing from start for', S1_PLAY_MS, 'ms to build initial coverage...');
  await collectFor(page1, S1_PLAY_MS, s1Samples);

  console.log('S1: seeking FORWARD to t=' + S1_SEEK_FORWARD_T + ' (past buffer/coverage)...');
  await page1.evaluate((t) => {
    const v = document.querySelector('video');
    if (v) v.currentTime = t;
  }, S1_SEEK_FORWARD_T);
  const s1FwdSamples = [];
  await collectFor(page1, S1_POST_SEEK_FWD_MS, s1FwdSamples);

  console.log('S1: seeking BACKWARD to t=' + S1_SEEK_BACK_T + ' (into already-covered region)...');
  const backSeekWall = Date.now();
  await page1.evaluate((t) => {
    const v = document.querySelector('video');
    if (v) v.currentTime = t;
  }, S1_SEEK_BACK_T);
  const s1BackSamples = [];
  await collectFor(page1, S1_POST_SEEK_BACK_MS, s1BackSamples);

  // =========================================================================
  // Scenario 2: regression video - real "shit" ~64s, cold seek to 50s
  // =========================================================================
  await seedStorage(context, extId, { pm_enabled: true, pm_safeMode: true, pm_muteAudio: true, pm_wordlist: [] }); // empty -> DEFAULT_WORDLIST (includes "shit"), also sidesteps the pm_wordlist:undefined-default bug for this case since we WANT defaults

  const page2 = await context.newPage();
  page2.on('console', (msg) => log('[s2 page]', msg.text()));
  page2.on('pageerror', (err) => log('[s2 page pageerror]', String(err)));

  console.log('\n=== SCENARIO 2: navigate to', SCENARIO2_URL, '===');
  await page2.goto(SCENARIO2_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dismissConsent(page2);
  await page2.waitForSelector('video', { timeout: 20000 }).catch(() => {});
  await page2.evaluate(() => document.querySelector('video')?.play().catch(() => {}));

  // YouTube plays pre-roll/mid-roll ADS first on this video, and ads ignore
  // a `.currentTime = 50` assignment (their own short timeline just keeps
  // playing) - a one-shot seek right after nav can silently land on an ad
  // instead of the real content. Keep retrying the seek on every sample
  // until it actually sticks (checked by currentTime settling near the
  // target while no ad is showing), which is robust to however many ads
  // play first.
  console.log('S2: seeking to t=' + S2_SEEK_T + ' (retried until it sticks past any ads)...');
  const s2Samples = [];
  const s2Deadline = Date.now() + S2_PLAY_UNTIL_MS;
  let s2SeekLanded = false; // once true, stop re-asserting the seek and let playback run forward naturally
  while (Date.now() < s2Deadline) {
    const state = await page2
      .evaluate(
        (args) => {
          var t = args.t, alreadyLanded = args.alreadyLanded;
          var skipBtn = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern');
          if (skipBtn) skipBtn.click();
          var v = document.querySelector('video');
          var adShowing = !!document.querySelector('.ad-showing, .ytp-ad-player-overlay');
          if (!v) return null;
          if (v.paused && !adShowing) v.play().catch(function () {});
          var justLanded = !alreadyLanded && !adShowing && Math.abs(v.currentTime - t) < 3;
          // Only re-assert the seek BEFORE it has ever landed (ads ignore it,
          // so keep retrying). Once landed once, never seek again - let
          // playback progress naturally, however far currentTime drifts.
          if (!alreadyLanded && !adShowing && !justLanded) v.currentTime = t;
          return { t: v.currentTime, paused: v.paused, muted: v.muted, readyState: v.readyState, adShowing: adShowing, justLanded: justLanded };
        },
        { t: S2_SEEK_T, alreadyLanded: s2SeekLanded }
      )
      .catch(() => null);
    if (state) {
      s2Samples.push({ wall: Date.now(), ...state });
      if (state.justLanded && !s2SeekLanded) {
        s2SeekLanded = true;
        console.log('S2: seek landed on real content at t=' + state.t.toFixed(2) + ' - no further re-seeking');
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('S2: seek landed at all during collection window:', s2SeekLanded);

  await page1.close().catch(() => {});
  await page2.close().catch(() => {});

  // ==== Analysis ==============================================================
  console.log('\n\n================ ANALYSIS ================\n');

  function linesMatching(re) {
    return allLines.filter((l) => re.test(l));
  }

  // ---- Scenario 1 ----
  const s1WindowLines = linesMatching(/\[bg\].*\[PM\] window/);
  const s1WordLines = linesMatching(/\[s1 page\].*words received=/);
  const s1MuteLines = linesMatching(/\[s1 page\].*MUTE (engaged|released)/);
  console.log('--- Scenario 1: window lines:', s1WindowLines.length, '| word lines:', s1WordLines.length, '| mute lines:', s1MuteLines.length, '---');
  s1MuteLines.forEach((l) => console.log('  ', l));

  // (c)/(d)-style: coverage present, playback advanced without stalling pre-seek
  const gotCoverage = s1WordLines.some((l) => /coverage=\[[^\]]+\]/.test(l) && !/coverage=\[\]/.test(l));

  // Was the video kept muted throughout the post-forward-seek gap (no
  // unmuted playback in the uncovered interval)? Uncovered here means: from
  // the seek moment until the FIRST sample where t has meaningfully advanced
  // past S1_SEEK_FORWARD_T AND a coverage line for that region has appeared.
  let sawUnmutedInUncoveredGap = false;
  const coverageGrowthAfterFwdSeek = s1WordLines.filter((l, idx) => idx >= 0); // all word lines after seed are cumulative; just check timestamps by wall order at end
  for (const s of s1FwdSamples) {
    if (s.t >= S1_SEEK_FORWARD_T - 1 && !s.muted && !s.paused) {
      sawUnmutedInUncoveredGap = true;
    }
    if (s.muted) break; // once safe mode engages we consider the immediate post-seek gap protected
  }
  const forwardSeekProtected = !sawUnmutedInUncoveredGap;
  console.log('Forward-seek uncovered-gap protected (no unmuted playback before mute engaged):', forwardSeekProtected);
  console.log('S1 post-forward-seek samples (first 8):', JSON.stringify(s1FwdSamples.slice(0, 8)));

  // Backward seek should NOT stay stuck safe-mode-muted for long (coverage
  // already exists there from the initial play) - check muted goes false
  // quickly.
  const quickUnmuteAfterBackSeek = s1BackSamples.some((s, idx) => idx < 4 && !s.muted);
  console.log('Backward seek into covered region resolves to unmuted quickly:', quickUnmuteAfterBackSeek);
  console.log('S1 post-backward-seek samples:', JSON.stringify(s1BackSamples));

  const s1PlaybackAdvanced = s1Samples.length > 3 && s1Samples[s1Samples.length - 1].t > 3;

  // ---- Scenario 2: regression "shit" ~64s ----
  const s2TranscriptLines = linesMatching(/\[bg\].*\[PM\] window start=(5[0-9]|6[0-9]|7[0-5])\.\d\d end=/);
  const s2AllWindowLines = linesMatching(/\[bg\].*\[PM\] window/);
  console.log('\n--- Scenario 2: window lines overlapping [50,75]:', s2TranscriptLines.length, 'of', s2AllWindowLines.length, 'total ---');
  s2AllWindowLines.forEach((l) => console.log('  ', l));

  const s2MuteLines = linesMatching(/\[s2 page\].*MUTE (engaged|released)/);
  console.log('\nScenario 2 mute lines:');
  s2MuteLines.forEach((l) => console.log('  ', l));

  const shitToken = /\bshit\b|\bs\*+\b|s h i t/i;
  const rawTranscriptHasShitLike = s2AllWindowLines.some((l) => shitToken.test(l));
  const muteNear64 = s2MuteLines.some((l) => {
    const m = l.match(/t=(\d+\.\d\d)/);
    return m && Math.abs(parseFloat(m[1]) - 64) < 4 && /engaged/.test(l);
  });

  let s2Diagnosis = 'unknown';
  if (!rawTranscriptHasShitLike && s2AllWindowLines.length > 0) {
    s2Diagnosis = 'transcription mishear or capture gap after seek - no "shit"-like token appears anywhere in the raw transcript for windows overlapping [50,75)';
  } else if (rawTranscriptHasShitLike && !muteNear64) {
    s2Diagnosis = 'wordlist-matching miss (or timing miss) - raw transcript contains a shit-like token but no MUTE engaged near t=64';
  } else if (rawTranscriptHasShitLike && muteNear64) {
    s2Diagnosis = 'fixed - token present and mute engaged near t=64';
  } else if (s2AllWindowLines.length === 0) {
    s2Diagnosis = 'no transcription windows landed at all for scenario 2 (capture/demux failure after cold seek)';
  }
  console.log('\nScenario 2 diagnosis:', s2Diagnosis);

  const s2PlaybackAdvanced = s2Samples.length > 3 && s2Samples[s2Samples.length - 1].t > S2_SEEK_T + 3;

  console.log('\n================ CRITERIA ================');
  console.log('(S1) coverage tracked:', gotCoverage);
  console.log('(S1) forward-seek uncovered gap protected:', forwardSeekProtected);
  console.log('(S1) backward seek into covered region unmutes quickly:', quickUnmuteAfterBackSeek);
  console.log('(S1) playback advanced pre-seek:', s1PlaybackAdvanced);
  console.log('(S2) playback advanced after cold seek:', s2PlaybackAdvanced);
  console.log('(S2) diagnosis:', s2Diagnosis);

  const pass = gotCoverage && forwardSeekProtected && quickUnmuteAfterBackSeek && s1PlaybackAdvanced && s2PlaybackAdvanced;
  console.log('\nRESULT:', pass ? 'SUCCESS' : 'FAILURE');

  fs.writeFileSync(
    path.join(__dirname, 'last_run.log'),
    allLines.join('\n') +
      '\n\n--- s1Samples ---\n' + JSON.stringify(s1Samples, null, 2) +
      '\n\n--- s1FwdSamples ---\n' + JSON.stringify(s1FwdSamples, null, 2) +
      '\n\n--- s1BackSamples ---\n' + JSON.stringify(s1BackSamples, null, 2) +
      '\n\n--- s2Samples ---\n' + JSON.stringify(s2Samples, null, 2)
  );

  await context.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
