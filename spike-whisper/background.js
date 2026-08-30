// MV3 service worker. ONNX runtime / transformers.js does not work reliably
// inside the service worker context, so all inference happens in an
// offscreen document instead. This worker's only job is to create that
// document and relay/store its results.

let creatingOffscreen;

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["DOM_PARSER"],
    justification: "Run on-device Whisper (ONNX/transformers.js) transcription spike.",
  });
  await creatingOffscreen;
  creatingOffscreen = null;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "whisper-log") {
    console.log("[WHISPER][bg-relay]", ...message.args);
  } else if (message?.type === "whisper-done") {
    console.log("[WHISPER][bg-relay] run finished. ok =", message.result?.ok);
    // Offscreen documents don't have chrome.storage in their `chrome` object
    // (only chrome.runtime is exposed there), so the offscreen doc posts its
    // result here via sendMessage and the service worker - which does have
    // full API access - persists it for Playwright/anything else to read.
    chrome.storage.local.set({ whisperSpikeResult: message.result }).then(
      () => console.log("[WHISPER][bg-relay] stored result in chrome.storage.local"),
      (err) => console.error("[WHISPER][bg-relay] failed to store result:", err)
    );
  }
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument();
});

// Belt-and-suspenders: kick it off as soon as the service worker itself
// spins up (e.g. right after the extension is loaded via --load-extension).
ensureOffscreenDocument();
