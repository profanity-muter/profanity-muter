import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const EXT_DIR = path.resolve(process.cwd());
// Reuse a fixed profile dir (not a fresh mkdtemp each run) so the HF model
// cache (Cache Storage) survives between iterations while we debug.
const userDataDir = path.join(os.tmpdir(), "whisper-spike-profile");
fs.mkdirSync(userDataDir, { recursive: true });

async function main() {
  console.log("Launching persistent context with extension:", EXT_DIR);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      "--no-first-run",
    ],
  });

  context.on("page", (p) => {
    console.log("[new page target]", p.url());
    p.on("console", (msg) => console.log("[offscreen console]", msg.text()));
    p.on("pageerror", (err) => console.log("[offscreen pageerror]", err));
  });

  // Give the service worker + offscreen doc time to spin up and start the run.
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  }
  console.log("Service worker URL:", sw.url());
  sw.on("console", (msg) => console.log("[bg console]", msg.text()));
  const extId = sw.url().split("/")[2];

  // Open a normal extension page so we can poll chrome.storage.local for the
  // result written by the offscreen document (simplest reliable channel,
  // since offscreen-document console/page targets aren't always exposed the
  // same way as regular pages).
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/probe.html`);
  const hasChrome = await page.evaluate(() => typeof chrome !== "undefined" && !!chrome.storage);
  console.log("probe page chrome.storage available:", hasChrome);
  // The profile is reused across runs (to keep the HF model cache warm), so
  // clear any stale result left behind by a previous run before polling.
  await page.evaluate(() => chrome.storage.local.remove(["whisperSpikeResult"]));

  console.log("Polling chrome.storage.local for whisperSpikeResult (this runs real inference, can take a while)...");
  const start = Date.now();
  const timeoutMs = 5 * 60 * 1000;
  let result = null;
  while (Date.now() - start < timeoutMs) {
    result = await page.evaluate(async () => {
      return await new Promise((resolve) => {
        chrome.storage.local.get(["whisperSpikeResult"], (r) => resolve(r.whisperSpikeResult || null));
      });
    });
    if (result) break;
    await new Promise((r) => setTimeout(r, 2000));
    process.stdout.write(".");
  }
  console.log("\n");

  if (!result) {
    console.error("TIMED OUT waiting for whisperSpikeResult in chrome.storage.local");
    process.exitCode = 1;
  } else {
    console.log("=== RESULT ===");
    console.log(JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(EXT_DIR, "last_result.json"), JSON.stringify(result, null, 2));

    const pass =
      result.ok &&
      result.text &&
      result.text.trim().length > 0 &&
      result.hits &&
      result.hits.length > 0 &&
      result.rtf != null &&
      result.rtf < 0.5;
    console.log("SUCCESS CRITERIA MET:", pass);
    process.exitCode = pass ? 0 : 1;
  }

  await context.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
