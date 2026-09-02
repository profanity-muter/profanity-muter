import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
await page.addInitScript(() => {
  const store = {};
  globalThis.chrome = {
    storage: {
      sync: { get: (k, cb) => cb ? cb(store) : Promise.resolve(store), set: (o, cb) => { Object.assign(store, o); cb && cb(); } },
      local: { get: (k, cb) => cb ? cb({}) : Promise.resolve({}), set: (o, cb) => cb && cb() },
      onChanged: { addListener: () => {} },
    },
    runtime: { getManifest: () => ({ version: '0.1.32' }), lastError: null, sendMessage: () => {}, },
    tabs: { create: () => {} },
  };
});
const url = pathToFileURL(process.argv[2] || 'onboarding/onboarding.html').href;
await page.goto(url);
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/ob_step1.png', fullPage: false });
// advance to step 2 (limits) and 3 (setup)
for (const [i, name] of [[2,'ob_step2'],[3,'ob_step3'],[4,'ob_step4']]) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /continue|next/i.test(b.innerText));
    btn && btn.click();
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/tmp/${name}.png`, fullPage: false });
}
await browser.close();
console.log('shots done');
