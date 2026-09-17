// test/page_theme_test.js
// The full pages (onboarding, report) are designed light and only go dark
// under an explicit [data-theme="dark"], which nothing sets. popup.css,
// which they load first for its control styles, darkens its --pm-* tokens
// under prefers-color-scheme: dark on its own. Unless the page shell pins
// every one of those tokens back to light, a dark-mode Mac shows navy
// controls on a paper page. That happened twice: report page (2026-09-04,
// fixed with a page-scoped override) and the onboarding "Set it up" step
// (2026-09-17, same bug, never covered by the first fix).
//
// This test makes the pin structural: every token popup.css darkens must be
// re-declared in onboarding.css's `:root:not([data-theme="dark"])` block,
// with the SAME value popup.css uses for light. Add a dark token to
// popup.css without pinning it here and this fails.
//
// Run with: node test/page_theme_test.js   (or npm test, from extension/)

"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const popup = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.css"), "utf8");
const shell = fs.readFileSync(path.join(__dirname, "..", "onboarding", "onboarding.css"), "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error("FAIL: " + name);
    console.error("      " + (e && e.message ? e.message : String(e)));
  }
}

function block(css, selectorRe) {
  const m = css.match(new RegExp(selectorRe.source + "\\s*\\{([^}]*)\\}", "m"));
  return m ? m[1] : null;
}
function tokens(body) {
  const out = {};
  const re = /(--pm-[a-z-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2].trim();
  return out;
}

const popupLight = tokens(block(popup, /:root/));
const popupDark = tokens(block(popup, /:root\[data-theme="dark"\]/));
const pinned = tokens(block(shell, /:root:not\(\[data-theme="dark"\]\)/));

test("popup.css still defines light and dark token sets", () => {
  assert.ok(Object.keys(popupLight).length >= 10, "light tokens");
  assert.ok(Object.keys(popupDark).length >= 10, "dark tokens");
});

test("the page shell pins every token popup.css darkens", () => {
  for (const name of Object.keys(popupDark)) {
    assert.ok(name in pinned, name + " is darkened by popup.css but not pinned in onboarding.css");
  }
});

test("each pin uses popup.css's own light value", () => {
  for (const name of Object.keys(pinned)) {
    assert.strictEqual(pinned[name], popupLight[name], name);
  }
});

test("the shell tells native controls the page is light", () => {
  const body = block(shell, /:root:not\(\[data-theme="dark"\]\)/);
  assert.ok(/color-scheme:\s*light;/.test(body), "color-scheme: light missing");
});

test("no page-level dark token block is unguarded", () => {
  // The shell may only darken under [data-theme="dark"]. A bare
  // prefers-color-scheme block here would reintroduce OS-driven darkness.
  assert.ok(!/@media\s*\(prefers-color-scheme:\s*dark\)/.test(shell),
    "onboarding.css must not react to prefers-color-scheme");
});

console.log("page_theme_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
