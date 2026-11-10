// verify/tabs_perm_check.mjs
// Real headless Chromium with the unpacked extension and its CURRENT
// permissions (storage + offscreen, host youtube.com only). Proves the
// assumptions behind the 0.1.62 refresh notice:
//   1. tab.url is readable for a youtube.com tab and hidden for others,
//      with no "tabs" permission.
//   2. chrome.tabs.query({url}) finds open YouTube tabs.
//   3. A YouTube tab that was already open BEFORE the extension was installed
//      (loaded mid-run over CDP) has no content script: sendMessage fails.
//      This is the same state an update leaves behind.
//   4. chrome.tabs.reload works and the fresh page's content script answers.
// Youtube is served from a local route stub; no network is used.
//
//   PM_PLAYWRIGHT=/path/to/playwright/index.mjs node verify/tabs_perm_check.mjs
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PM_PLAYWRIGHT || 'playwright');
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) pass++; else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
check('manifest permissions are exactly storage + offscreen',
  JSON.stringify(manifest.permissions) === '["storage","offscreen"]', manifest.permissions);
check('manifest hosts are youtube only',
  JSON.stringify(manifest.host_permissions) === '["https://www.youtube.com/*"]', manifest.host_permissions);

// Persistent (non-incognito) profile: extension pages do not load in a
// Playwright incognito-style context. A second CDP connection is used only
// to call Extensions.loadUnpacked mid-run.
const PORT = 9400 + Math.floor(Math.random() * 400);
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-tabs-'));
const ctx = await chromium.launchPersistentContext(userDir, {
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--headless=new', '--enable-unsafe-extension-debugging', `--remote-debugging-port=${PORT}`]
});
const page = (html) => ({ status: 200, contentType: 'text/html', body: html });
await ctx.route('https://www.youtube.com/**', (r) => r.fulfill(page('<title>yt</title><body>yt</body>')));
await ctx.route('https://example.com/**', (r) => r.fulfill(page('<title>ex</title><body>ex</body>')));

// Tabs first, extension second.
const yt = await ctx.newPage();
await yt.goto('https://www.youtube.com/watch?v=abc');
const ex = await ctx.newPage();
await ex.goto('https://example.com/');

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const cdp = await browser.newBrowserCDPSession();
const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT });
await new Promise((r) => setTimeout(r, 1500));

const ui = await ctx.newPage();
await ui.goto(`chrome-extension://${extId}/popup/popup.html`);

const ask = (id) => ui.evaluate((tid) => new Promise((res) => chrome.tabs.sendMessage(tid, { type: 'pm-health-query' }, (resp) => {
  res({ resp: resp || null, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
})), id);

const p = await ui.evaluate(async () => {
  const all = await chrome.tabs.query({});
  const byUrl = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  const ytTab = byUrl[0];
  return {
    ytCount: byUrl.length,
    ytId: ytTab && ytTab.id,
    ytUrl: ytTab && ytTab.url,
    otherUrls: all.filter((t) => !(ytTab && t.id === ytTab.id)).map((t) => t.url === undefined ? 'undefined' : t.url),
    hasTabsPerm: await chrome.permissions.contains({ permissions: ['tabs'] })
  };
});
check('tabs permission is not held', p.hasTabsPerm === false);
check('query({url}) finds the already-open YouTube tab', p.ytCount === 1, p.ytCount);
check('tab.url readable for the YouTube tab', p.ytUrl === 'https://www.youtube.com/watch?v=abc', p.ytUrl);
check('tab.url hidden for the non-host tab (no tabs permission in effect)',
  p.otherUrls.includes('undefined') && !p.otherUrls.includes('https://example.com/'), p.otherUrls);

const before = await ask(p.ytId);
check('tab open before install: no content script, sendMessage fails', before.err !== null && before.resp === null, before);

await ui.evaluate((id) => chrome.tabs.reload(id), p.ytId);
await yt.waitForLoadState('load');
await new Promise((r) => setTimeout(r, 1200));
const healed = await ask(p.ytId);
check('chrome.tabs.reload works without the tabs permission; fresh page answers', !!(healed.resp && !healed.err), healed);

await browser.close().catch(() => {});
await ctx.close();
fs.rmSync(userDir, { recursive: true, force: true });
console.log(`tabs_perm_check: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
