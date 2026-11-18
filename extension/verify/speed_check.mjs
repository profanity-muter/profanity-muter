// verify/speed_check.mjs - the 0.1.65 setup computer check in real headless
// Chromium with the unpacked extension, the real model and real code.
//
//   A  fresh install: onboarding opens with ?firstRun=1, the check runs by
//      itself, "ok" with a plausible ratio, pm_speedCheck stored, no pause.
//      Reopened later: the stored result shows with "Check again", no re-run.
//   D  onboarding tab closed mid-check: the result is still recorded.
//   C  a real YouTube video is still analyzed after the check, and a check
//      asked for while it plays answers "busy" instead of taking the worker.
//   B  too slow, through the real measurement: CDP cannot throttle a
//      dedicated worker ("Operation is only supported for pages, not
//      workers"), so the extension's renderer process (offscreen document +
//      Whisper worker) is moved to macOS background QoS (`taskpolicy -b`,
//      efficiency cores, throttled) right after launch. Nothing in the
//      extension is stubbed. Then: notice, flag, offscreen closed, popup
//      notice copy, "Continue with captions only" keeps the pause, "Try audio
//      muting anyway" brings the document and the Whisper worker back.
//
//   PM_PLAYWRIGHT=<path to playwright/index.mjs> [PM_SHOTS=<dir>] node verify/speed_check.mjs
// Part C uses real YouTube (network), like verify/run_wake.mjs. macOS only (taskpolicy).
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PM_PLAYWRIGHT ? pathToFileURL(process.env.PM_PLAYWRIGHT).href : 'playwright');
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.PM_SHOTS || null;
const VIDEO = 'UF8uR6Z6KLc';
const T0 = Date.now();
const sec = (t) => ((Date.now() - (t || T0)) / 1000).toFixed(1);
const say = (...a) => console.log(`[${sec().padStart(6)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; say('ok  ', name); } else { fail++; say('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(300);
  }
}

async function launch(tag) {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-speed-' + tag + '-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const startedAt = Date.now();
  const ctx = await chromium.launchPersistentContext(prof, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--remote-debugging-port=${port}`,
      '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run']
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
  const lines = [];
  sw.on('console', (m) => lines.push(m.text()));
  const extId = sw.url().split('/')[2];
  const local = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys);
  return {
    ctx, sw, prof, port, lines, extId, startedAt,
    record: async () => (await local(['pm_speedCheck'])).pm_speedCheck || null,
    flag: async () => (await local(['pm_autoPausedSlow'])).pm_autoPausedSlow || null,
    offscreen: () => sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length),
    // The offscreen document's only dedicated worker is Whisper's (Chromium lists it with no url).
    whisperWorker: async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).some((t) => t.type === 'worker'),
    // Model loads seen in pm_memlog (offscreen emits a 'model-loaded' sample when Whisper is warm).
    modelLoads: async () => (JSON.stringify((await local(['pm_memlog'])).pm_memlog || null).match(/"model-loaded"/g) || []).length,
    onboarding: () => waitFor(async () => ctx.pages().find((p) => /onboarding\.html/.test(p.url())), 15000),
    url: (p) => `chrome-extension://${extId}/${p}`
  };
}

const view = (page) => page.evaluate(() => {
  const el = document.getElementById('ob-speed');
  const vis = (e) => !!e && !e.classList.contains('pm-hidden') && e.offsetParent !== null;
  const btn = (id) => { const b = document.getElementById(id); return vis(b) ? b.textContent : null; };
  return {
    state: el.getAttribute('data-state'), visible: vis(el), text: el.innerText,
    title: document.getElementById('ob-speed-title').textContent,
    body: document.getElementById('ob-speed-body').textContent,
    buttons: ['ob-speed-captions', 'ob-speed-try', 'ob-speed-remove', 'ob-speed-again', 'ob-speed-start'].map(btn).filter(Boolean),
    nextEnabled: !document.getElementById('ob-next').disabled
  };
});

async function shoot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark']) {
    for (const width of [1100, 390]) {
      await page.emulateMedia({ colorScheme: scheme });
      // Viewport grown to the whole document rather than fullPage: the nav is
      // position:fixed, and a fullPage capture paints it over the middle.
      await page.setViewportSize({ width, height: width > 500 ? 900 : 844 });
      const h = await page.evaluate(() => document.documentElement.scrollHeight);
      await page.setViewportSize({ width, height: Math.max(h, width > 500 ? 900 : 844) });
      await sleep(150);
      await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}-${width}.png`) });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1100, height: 900 });
}

// Every extension renderer of this browser -> background QoS. Returns the pids.
function demote(prof, done) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command=']).toString().split('\n').map((l) => l.trim().split(/\s+/));
  const browser = rows.find((r) => r.join(' ').includes(prof) && !r.join(' ').includes('--type='));
  if (!browser) return done;
  for (const r of rows) {
    if (r[1] === browser[0] && r.join(' ').includes('--extension-process') && !done.includes(r[0])) {
      execFileSync('taskpolicy', ['-b', '-p', r[0]]);
      done.push(r[0]);
    }
  }
  return done;
}

const WHY = "Profanity Muter is fully private: it runs only on your device and never sends anything you watch or hear anywhere. That means it uses your computer's own processing power";
const out = {};
try {
  // ======================= A: fresh install, ok =======================
  say('--- A: fresh install');
  const A = await launch('a');
  const ob = await A.onboarding();
  check('A onboarding opened on install with ?firstRun=1', !!ob && /firstRun=1/.test(ob.url()), ob && ob.url());
  await ob.setViewportSize({ width: 1100, height: 900 });
  const v0 = await waitFor(async () => { const v = await view(ob); return v.visible ? v : null; }, 5000);
  check('A the check starts by itself (running or already done)', v0 && ['running', 'ok'].includes(v0.state), v0);
  check('A Next is not blocked while it runs', v0 && v0.nextEnabled);
  const rec = await waitFor(A.record, 200000);
  out.freshInstallToVerdictS = rec ? ((rec.at - A.startedAt) / 1000).toFixed(1) : null;
  out.okRecord = rec;
  check('A verdict ok', rec && rec.verdict === 'ok', rec);
  check('A plausible ratio on this Mac (0.02..0.7)', rec && rec.ratio > 0.02 && rec.ratio <= 0.7, rec && rec.ratio);
  check('A loadMs, cores and memory recorded', rec && rec.loadMs > 0 && rec.cores > 0 && rec.memGb > 0, rec);
  const heard = A.lines.find((l) => /PM-SPEEDCHECK/.test(l) && /heard=/.test(l));
  out.heard = heard;
  check('A the real model transcribed the bundled clip', !!heard && /garden/i.test(heard), heard);
  const vOk = await waitFor(async () => { const v = await view(ob); return v.state === 'ok' ? v : null; }, 5000);
  check('A onboarding shows "This computer can keep up."', vOk && vOk.text.trim() === 'This computer can keep up.', vOk);
  check('A pm_autoPausedSlow not set', !(await A.flag()));
  check('A offscreen document still up', (await A.offscreen()) === 1);
  await shoot(ob, 'ok');

  // Reopened later: stored result + "Check again", no automatic re-run.
  const ob2 = await A.ctx.newPage();
  await ob2.goto(A.url('onboarding/onboarding.html'));
  const vPast = await waitFor(async () => { const v = await view(ob2); return v.visible ? v : null; }, 5000);
  check('A reopened guide shows the stored result with Check again', vPast && vPast.state === 'ok' && vPast.buttons.includes('Check again'), vPast);
  await sleep(3000);
  check('A reopened guide did not re-run the check', (await A.record()).at === rec.at);
  await ob2.close();

  // ======================= D: tab closed mid-check =======================
  say('--- D: onboarding closed mid-check');
  await A.sw.evaluate(() => chrome.storage.local.remove('pm_speedCheck'));
  const ob3 = await A.ctx.newPage();
  await ob3.goto(A.url('onboarding/onboarding.html?firstRun=1'));
  const vRun = await waitFor(async () => { const v = await view(ob3); return v.state === 'running' ? v : null; }, 5000);
  check('D check running', !!vRun, vRun);
  await ob3.close();
  const recD = await waitFor(A.record, 120000);
  check('D result still recorded after the tab closed', recD && recD.verdict === 'ok', recD);

  // ======================= C: a real video after the check =======================
  say('--- C: real YouTube video after an ok check');
  await ob.close().catch(() => {});
  const yt = await A.ctx.newPage();
  await yt.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const consent = yt.locator('button:has-text("Accept all"), button:has-text("Reject all")');
  if (await consent.first().isVisible({ timeout: 2000 }).catch(() => false)) await consent.first().click().catch(() => {});
  await yt.waitForSelector('video', { timeout: 30000 });
  for (let i = 0; i < 30; i++) {
    const ad = await yt.evaluate(() => { const b = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern'); if (b) b.click(); return !!document.querySelector('.ad-showing'); });
    if (!ad) break; await sleep(1000);
  }
  await yt.evaluate(() => document.querySelector('video').play().catch(() => {}));
  const winBefore = A.lines.filter((l) => /\[PM\] window start=/.test(l)).length;
  const gotWin = await waitFor(async () => A.lines.filter((l) => /\[PM\] window start=/.test(l)).length > winBefore + 1, 90000);
  out.youtubeWindows = A.lines.filter((l) => /\[PM\] window start=/.test(l)).slice(0, 3);
  check('C a real video is analyzed after the check (2+ windows)', !!gotWin, out.youtubeWindows);
  const busy = await A.sw.evaluate(() => startSpeedCheck());
  check('C a check asked for during playback answers busy', busy && busy.status === 'busy', busy);
  await yt.close();

  // Borderline is rendered from a stored record (no machine here measures 0.7..1.0 on demand).
  await A.sw.evaluate(() => chrome.storage.local.set({ pm_speedCheck: { at: Date.now(), verdict: 'borderline', reason: null, ratio: 0.82, windowMs: 14760, loadMs: 2100, cores: 4, memGb: 4 } }));
  const obB = await A.ctx.newPage();
  await obB.goto(A.url('onboarding/onboarding.html'));
  const vB = await waitFor(async () => { const v = await view(obB); return v.state === 'borderline' ? v : null; }, 5000);
  check('borderline copy', vB && vB.text.indexOf('This computer can keep up, but only just. Muting may fall behind when other programs are busy.') === 0, vB);
  await shoot(obB, 'borderline');
  await A.ctx.close();

  // ======================= B: too slow, real measurement =======================
  say('--- B: too slow (extension renderer on background QoS)');
  const B = await launch('b');
  const pids = [];
  for (let i = 0; i < 40; i++) { demote(B.prof, pids); if (pids.length) break; await sleep(100); }
  out.demotedPids = pids.slice();
  check('B extension renderer moved to background QoS', pids.length > 0, pids);
  const obS = await B.onboarding();
  await obS.setViewportSize({ width: 1100, height: 900 });
  demote(B.prof, pids);
  const vR = await waitFor(async () => { const v = await view(obS); return v.state === 'running' ? v : null; }, 10000);
  check('B running state shows the calm progress line', vR && /Checking that this computer can keep up/.test(vR.text), vR);
  if (vR) await shoot(obS, 'running');
  // Move on while it runs: Next works, and the result must follow the reader.
  await obS.click('#ob-next');
  const recS = await waitFor(B.record, 260000);
  out.slowRecord = recS;
  out.slowCheckS = recS ? ((recS.at - B.startedAt) / 1000).toFixed(1) : null;
  check('B verdict too-slow from the real ratio', recS && recS.verdict === 'too-slow' && recS.reason === 'ratio' && recS.ratio > 1, recS);
  const flag = await B.flag();
  check('B pm_autoPausedSlow set, marked setup-check, with the ratio', flag && flag.source === 'setup-check' && flag.ratio === recS.ratio, flag);
  check('B offscreen document closed (Whisper memory freed)', (await waitFor(async () => (await B.offscreen()) === 0, 10000)) === true);
  const onStep2 = await waitFor(() => obS.evaluate(() => { const e = document.getElementById('ob-speed'); return e.closest('#ob-step-2') && e.offsetParent !== null && e.getAttribute('data-state') === 'too-slow'; }), 10000);
  check('B the notice followed the reader to step 2', onStep2 === true);
  if (SHOTS) await obS.screenshot({ path: path.join(SHOTS, 'too-slow-on-step2-light-1100.png') });
  await obS.click('#ob-back');
  const vS = await waitFor(async () => { const v = await view(obS); return v.state === 'too-slow' && v.visible ? v : null; }, 10000);
  check('B notice title', vS && vS.title === 'This computer is probably too slow for audio muting', vS);
  check('B notice reason uses the approved privacy wording and says captions still work', vS && vS.body.indexOf(WHY) === 0 && /Captions are still censored/.test(vS.body), vS && vS.body);
  check('B three choices', vS && JSON.stringify(vS.buttons) === JSON.stringify(['Continue with captions only', 'Try audio muting anyway', 'Remove extension']), vS && vS.buttons);
  check('B Next still enabled', vS && vS.nextEnabled);
  out.slowNotice = vS;
  await shoot(obS, 'too-slow');

  const pop = await B.ctx.newPage();
  await pop.goto(B.url('popup/popup.html'));
  const popText = await waitFor(() => pop.evaluate(() => { const e = document.getElementById('pm-slow'); return e && !e.classList.contains('pm-hidden') ? e.innerText : null; }), 5000);
  out.popupNotice = popText;
  check('B popup shows its paused notice, worded for a setup check', !!popText && /check during setup/.test(popText) && !/right now/.test(popText), popText);
  await pop.close();

  const atBefore = flag.at;
  await obS.click('#ob-speed-captions');
  await sleep(1500);
  const vC = await view(obS);
  check('B "Continue with captions only" keeps the pause', ((await B.flag()) || {}).at === atBefore && (await B.offscreen()) === 0, await B.flag());
  check('B and collapses to a confirmation', /Audio muting is paused and captions are still censored/.test(vC.text) && !vC.buttons.includes('Try audio muting anyway'), vC);
  await shoot(obS, 'too-slow-chosen');

  await obS.reload();
  const vAgain = await waitFor(async () => { const v = await view(obS); return v.state === 'too-slow' && v.buttons.length ? v : null; }, 10000);
  check('B reopened: notice with choices and Check again', vAgain && vAgain.buttons.includes('Try audio muting anyway') && vAgain.buttons.includes('Check again'), vAgain);
  const loadsBefore = await B.modelLoads();
  await obS.click('#ob-speed-try');
  const back = await waitFor(async () => !(await B.flag()) && (await B.offscreen()) === 1 && (await B.whisperWorker()) && (await B.modelLoads()) > loadsBefore, 60000);
  const backState = { flag: await B.flag(), offscreen: await B.offscreen(), worker: await B.whisperWorker(), loadsBefore, loadsAfter: await B.modelLoads(),
    targets: (await (await fetch(`http://127.0.0.1:${B.port}/json/list`)).json()).map((t) => t.type + ' ' + t.url + ' ' + t.title) };
  out.tryAnyway = backState;
  check('B "Try audio muting anyway" clears the flag; offscreen + Whisper worker come back, model reloaded', back === true, backState);
  const vT = await waitFor(async () => { const v = await view(obS); return /chose to try/.test(v.text) ? v : null; }, 5000);
  check('B copy follows the real state after trying anyway', !!vT, vT);
  await obS.click('#ob-speed-captions');
  const repaused = await waitFor(async () => { const f = await B.flag(); return f && f.source === 'setup-check' && (await B.offscreen()) === 0; }, 10000);
  check('B "Continue with captions only" after trying re-pauses and closes the document', repaused === true);
  await B.ctx.close();
} catch (e) {
  fail++;
  say('ERROR', String(e && e.stack || e));
}
console.log('\n=== RESULT ===\n' + JSON.stringify(out, null, 1));
console.log(`speed_check: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
