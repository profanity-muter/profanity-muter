#!/usr/bin/env node
// verify/pages_dark_check.mjs
// Browser-level guard for the full pages under a dark-mode OS.
//
// Loads onboarding and report with prefers-color-scheme: dark, walks every
// onboarding step, and fails if any visible control (input, textarea,
// select, button) is dark-filled on a light page, or if its text contrast
// against its own fill is below WCAG AA (4.5:1). This is what a dark-mode
// Mac shows the user; light-only screenshots cannot catch it, which is how
// the "Set it up" inputs shipped navy-on-paper for two releases.
//
//   node verify/pages_dark_check.mjs
//   PM_PLAYWRIGHT=/path/to/node_modules/playwright node verify/pages_dark_check.mjs
//
// Needs a Chromium: `npx playwright install chromium` once, or point
// PM_PLAYWRIGHT at a checkout that has one.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pw = await import(process.env.PM_PLAYWRIGHT || 'playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const SHIM = `
  (function(){var mem={sync:{},local:{}};function area(n){return{get:function(k,cb){var out={};(Array.isArray(k)?k:typeof k==="string"?[k]:Object.keys(k||{})).forEach(function(x){if(x in mem[n])out[x]=mem[n][x];else if(k&&typeof k==="object"&&!Array.isArray(k))out[x]=k[x];});if(cb)cb(out);return Promise.resolve(out);},set:function(o,cb){Object.assign(mem[n],o);if(cb)cb();return Promise.resolve();},remove:function(k,cb){(Array.isArray(k)?k:[k]).forEach(function(x){delete mem[n][x]});if(cb)cb();return Promise.resolve();}}}
  window.chrome={storage:{sync:area("sync"),local:area("local"),onChanged:{addListener:function(){}}},runtime:{getURL:function(p){return p},lastError:undefined,sendMessage:function(){},onMessage:{addListener:function(){}},getManifest:function(){return {version:"0"}}},tabs:{create:function(){}},action:{getUserSettings:function(cb){var r={isOnToolbar:false};if(cb)cb(r);return Promise.resolve(r);}}};
  })();`;

function lum([r, g, b]) {
  const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
// Chromium reports some computed colours as color(srgb r g b [/ a]) with
// 0..1 channels, and others as rgb()/rgba() with 0..255 channels.
function channels(s) {
  const m = s.match(/-?\d+(\.\d+)?/g) || [];
  return { vals: m.map(Number), unit: /^color\(srgb/.test(s) ? 1 : 255 };
}
function rgb(s) { const c = channels(s); return c.vals.slice(0, 3).map((v) => (c.unit === 1 ? v * 255 : v)); }
function alpha(s) { const c = channels(s); return c.vals.length >= 4 ? c.vals[3] : 1; }

const problems = [];
const browser = await pw.chromium.launch({ channel: process.env.PM_CHANNEL || 'chromium' });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 820 }, colorScheme: 'dark' });
await ctx.addInitScript(SHIM);
const page = await ctx.newPage();

async function audit(label) {
  const rows = await page.evaluate(() => {
    const vis = (e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    return [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]), textarea, select, button')]
      .filter(vis)
      // Disabled controls are exempt from contrast requirements (WCAG 1.4.3).
      .filter((e) => !e.disabled)
      .map((e) => { const c = getComputedStyle(e); return { id: e.id || e.className || e.tagName, tag: e.tagName.toLowerCase(), bg: c.backgroundColor, fg: c.color, bodyBg }; });
  });
  for (const r of rows) {
    const body = rgb(r.bodyBg), fg = rgb(r.fg);
    // A transparent fill shows the page through it: judge against the page.
    const bg = alpha(r.bg) === 0 ? body : rgb(r.bg);
    const filled = alpha(r.bg) > 0;
    // A dark FIELD on a light page is the bug this guards (the popup's dark
    // tokens leaking onto a paper page). A dark button is a design choice
    // (primary buttons are navy on purpose); it only has to stay readable.
    if (filled && r.tag !== 'button' && lum(body) > 0.5 && lum(bg) < 0.25) {
      problems.push(`${label}: ${r.id} is dark-filled (${r.bg}) on a light page`);
    }
    if (fg.length === 3 && contrast(fg, bg) < 4.5) {
      problems.push(`${label}: ${r.id} text contrast ${contrast(fg, bg).toFixed(2)} (${r.fg} on ${r.bg})`);
    }
  }
  return rows.length;
}

// Onboarding: every step.
await page.goto(pathToFileURL(path.join(ROOT, 'onboarding', 'onboarding.html')).href);
await page.waitForTimeout(400);
let checked = 0;
for (let step = 1; step <= 8; step++) {
  const title = await page.evaluate(() => [...document.querySelectorAll('h2,h1')].filter((e) => e.offsetParent !== null).map((e) => e.innerText.trim()).join(' | '));
  checked += await audit('onboarding[' + title + ']');
  const next = page.locator('button:visible').filter({ hasText: /^(next|continue|got it|skip|i understand|start)/i }).first();
  if (!(await next.count()) || !(await next.isEnabled())) break;
  await next.click();
  await page.waitForTimeout(300);
}

// Report page.
await page.goto(pathToFileURL(path.join(ROOT, 'report', 'report.html')).href);
await page.waitForTimeout(400);
checked += await audit('report');

await browser.close();

if (problems.length) {
  console.error('pages_dark_check: ' + problems.length + ' problem(s) across ' + checked + ' controls');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('pages_dark_check: ' + checked + ' controls checked under prefers-color-scheme: dark, all light and readable');
