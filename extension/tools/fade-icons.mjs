// Renders icons/off/icon{16,32,48,128}.png: the colour icons at 35% opacity
// with alpha preserved. This is the toolbar icon for "not filtering here"
// (non-YouTube tabs, Shorts, livestreams, toggle off). Re-run after any
// change to icons/icon*.png:
//
//   node tools/fade-icons.mjs
//
// Uses the Playwright checkout in the niche-sites repo purely as a renderer;
// nothing here ships. Paths are absolute on purpose so the command works
// from any cwd.
import { chromium } from '/Users/nathanaeldesmond2026/Desktop/niche-sites/node_modules/playwright/index.mjs';
import fs from 'node:fs';
const SRC='/Users/nathanaeldesmond2026/Desktop/profanity-muter-clean/extension/icons';
const OUT='/Users/nathanaeldesmond2026/Desktop/profanity-muter-clean/extension/icons/off';
const b=await chromium.launch({channel:'chromium'});
for(const size of [16,32,48,128]){
  const ctx=await b.newContext({viewport:{width:size,height:size},deviceScaleFactor:1});
  const p=await ctx.newPage();
  const data=fs.readFileSync(`${SRC}/icon${size}.png`).toString('base64');
  await p.setContent(`<body style="margin:0;background:transparent"><img src="data:image/png;base64,${data}" style="display:block;width:${size}px;height:${size}px;opacity:0.35"></body>`);
  await p.screenshot({path:`${OUT}/icon${size}.png`,omitBackground:true,clip:{x:0,y:0,width:size,height:size}});
  await ctx.close();
}
await b.close(); console.log('done');
