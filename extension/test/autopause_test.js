// test/autopause_test.js
// Runs the real background.js in a vm with a stubbed chrome.* to prove the
// 0.1.58 auto-pause rules:
//   * pm_autoPausedSlow set  -> the offscreen document is NEVER created
//     (no Whisper worker, no model, no CPU)
//   * flag absent            -> it is created as before
//   * flag set while running -> the document is closed
//   * "Try again" (flag removed) -> the document is created again
//   * chronic verdict in pm-pace persistence sets the flag
// and that captions.js has no dependency on the audio pipeline.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) {
    failed++;
    console.error("FAIL: " + name);
    console.error("      " + (e && e.stack ? e.stack : String(e)));
  }
}

function noop() { return undefined; }
function deepStub() {
  const f = function () { return undefined; };
  return new Proxy(f, { get: (_t, k) => (k === "then" ? undefined : deepStub()), apply: () => undefined });
}

function boot(localInitial, nav) {
  const local = Object.assign({}, localInitial || {});
  const state = { created: 0, closed: 0, docs: 0, listeners: [], local, sent: [] };
  const chrome = deepStub();
  const real = {
    offscreen: {
      createDocument: async () => { state.created++; state.docs = 1; },
      closeDocument: async () => { state.closed++; state.docs = 0; }
    },
    runtime: {
      getContexts: async () => (state.docs ? [{}] : []),
      sendMessage: (m) => { state.sent.push(m); return Promise.resolve(m.type === "pm-speed-check-run" && state.docs ? { status: "started" } : undefined); },
      onMessage: { addListener: (fn) => { state.onMessage = fn; } },
      onConnect: { addListener: noop },
      onInstalled: { addListener: noop },
      onStartup: { addListener: noop }
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in state.local) out[k] = state.local[k]; });
          return out;
        },
        set: async (obj) => {
          const changes = {};
          for (const k of Object.keys(obj)) {
            changes[k] = { oldValue: state.local[k], newValue: obj[k] };
            state.local[k] = obj[k];
          }
          state.listeners.forEach((fn) => fn(changes, "local"));
        },
        remove: async (keys) => {
          const changes = {};
          for (const k of [].concat(keys)) {
            changes[k] = { oldValue: state.local[k], newValue: undefined };
            delete state.local[k];
          }
          state.listeners.forEach((fn) => fn(changes, "local"));
        }
      },
      sync: { get: noop, set: noop },
      onChanged: { addListener: (fn) => state.listeners.push(fn) }
    }
  };
  const sandbox = {
    console: { log: noop, warn: noop, error: noop },
    setTimeout, clearTimeout, Promise, Map, Set, Date, JSON, Math, Array, Object, String, Number, Error,
    chrome: new Proxy(real, { get: (t, k) => (k in t ? t[k] : chrome[k]) })
  };
  sandbox.navigator = nav || { deviceMemory: 8, hardwareConcurrency: 8 };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = noop;
  sandbox.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f }));
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), sandbox, { filename: "background.js" });
  return { state, sandbox };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));

(async () => {
  await test("flag absent: offscreen document is created", async () => {
    const { state } = boot({});
    await tick();
    assert.strictEqual(state.created, 1);
  });

  await test("flag set at boot: offscreen document is never created", async () => {
    const { state, sandbox } = boot({ pm_autoPausedSlow: { at: 1 } });
    await tick();
    await sandbox.ensureOffscreenDocument();
    await sandbox.ensureOffscreenDocument();
    assert.strictEqual(state.created, 0, "no document while auto-paused");
  });

  await test("flag set while running: document is closed; Try again recreates it", async () => {
    const { state, sandbox } = boot({});
    await tick();
    assert.strictEqual(state.docs, 1);
    await sandbox.chrome.storage.local.set({ pm_autoPausedSlow: { at: 5 } });
    await tick();
    assert.strictEqual(state.docs, 0, "closed on auto-pause");
    await sandbox.ensureOffscreenDocument();
    assert.strictEqual(state.docs, 0, "still not created while paused");
    await sandbox.chrome.storage.local.remove(["pm_autoPausedSlow", "pm_paceHistory"]);
    await tick();
    assert.strictEqual(state.docs, 1, "Try again re-creates the document");
  });

  await test("pm-pace with 3 chronic videos persists the flag (and is not re-evaluated once set)", async () => {
    const { state } = boot({});
    await tick();
    const send = (id, behind) => state.onMessage({
      type: "pm-pace", tabId: 1, videoId: id, state: "busy", recentRtf: 2,
      video: { analyzedS: 120, behindFrac: behind, medianRtf: behind > 0.5 ? 2 : 0.2, windows: 20 }
    }, {}, () => {});
    send("a", 0.9); await tick();
    send("b", 0.9); await tick();
    assert.ok(!state.local.pm_autoPausedSlow, "2 videos is not enough");
    send("c", 0.9); await tick();
    assert.ok(state.local.pm_autoPausedSlow, "3rd chronic video trips auto-pause");
    assert.strictEqual(state.docs, 0, "document torn down by the trip");
  });

  await test("a fast video in the mix does not trip it", async () => {
    const { state } = boot({});
    await tick();
    const send = (id, behind) => state.onMessage({
      type: "pm-pace", tabId: 1, videoId: id, state: "ok", recentRtf: 0.2,
      video: { analyzedS: 120, behindFrac: behind, medianRtf: 0.2, windows: 20 }
    }, {}, () => {});
    send("a", 0.9); await tick(); send("b", 0.0); await tick(); send("c", 0.9); await tick(); send("d", 0.0); await tick();
    assert.ok(!state.local.pm_autoPausedSlow);
  });

  // ---- 0.1.65 setup computer check -------------------------------------------
  const result = (state, m) => state.onMessage(Object.assign({ type: "pm-speed-check-result", audioS: 18 }, m), {}, () => {});

  await test("speed check ok: result stored, nothing paused, document stays", async () => {
    const { state } = boot({});
    await tick();
    result(state, { windowMs: 3400, loadMs: 2000 }); await tick();
    const r = state.local.pm_speedCheck;
    assert.strictEqual(r.verdict, "ok");
    assert.strictEqual(r.ratio, 0.189);
    assert.strictEqual(r.cores, 8);
    assert.strictEqual(r.memGb, 8);
    assert.strictEqual(r.loadMs, 2000);
    assert.ok(typeof r.at === "number");
    assert.ok(!state.local.pm_autoPausedSlow);
    assert.strictEqual(state.docs, 1);
  });

  await test("speed check too-slow: flag marked setup-check, document closed at once", async () => {
    const { state } = boot({});
    await tick();
    result(state, { windowMs: 27000 }); await tick();
    assert.strictEqual(state.local.pm_speedCheck.verdict, "too-slow");
    assert.strictEqual(state.local.pm_autoPausedSlow.source, "setup-check");
    assert.strictEqual(state.local.pm_autoPausedSlow.ratio, 1.5);
    assert.strictEqual(state.docs, 0, "Whisper torn down by the existing flag machinery");
  });

  await test("speed check: a silent document (onboarding backstop) and a worker error", async () => {
    const { state } = boot({});
    await tick();
    state.onMessage({ type: "pm-speed-check-timeout" }, {}, () => {}); await tick();
    assert.strictEqual(state.local.pm_speedCheck.reason, "timeout");
    assert.ok(state.local.pm_autoPausedSlow);
    const b = boot({});
    await tick();
    result(b.state, { error: "boom" }); await tick();
    assert.strictEqual(b.state.local.pm_speedCheck.verdict, "error");
    assert.ok(!b.state.local.pm_autoPausedSlow, "an error is not a verdict on the computer");
  });

  await test("speed check start: asks the offscreen document and relays its answer", async () => {
    const { state } = boot({});
    await tick();
    let ack;
    state.onMessage({ type: "pm-speed-check-start" }, {}, (r) => { ack = r; });
    await tick(50);
    assert.strictEqual(ack && ack.status, "started");
    assert.ok(state.sent.some((m) => m.type === "pm-speed-check-run"));
  });

  await test("speed check start with 2 GB of memory: too-slow without running the model", async () => {
    const { state } = boot({}, { deviceMemory: 2, hardwareConcurrency: 4 });
    await tick();
    let ack;
    state.onMessage({ type: "pm-speed-check-start" }, {}, (r) => { ack = r; });
    await tick(50);
    assert.strictEqual(ack && ack.status, "started");
    assert.ok(!state.sent.some((m) => m.type === "pm-speed-check-run"), "model never asked to run");
    assert.strictEqual(state.local.pm_speedCheck.reason, "memory");
    assert.strictEqual(state.local.pm_speedCheck.memGb, 2);
    assert.strictEqual(state.local.pm_autoPausedSlow.source, "setup-check");
    assert.strictEqual(state.docs, 0);
  });

  await test("speed check start while paused (Check again): unpauses, recreates the document, runs", async () => {
    const { state } = boot({ pm_autoPausedSlow: { at: 1, source: "setup-check" }, pm_paceHistory: [{ id: "a" }] });
    await tick();
    assert.strictEqual(state.docs, 0);
    let ack;
    state.onMessage({ type: "pm-speed-check-start" }, {}, (r) => { ack = r; });
    await tick(50);
    assert.ok(!state.local.pm_autoPausedSlow && !state.local.pm_paceHistory, "same patch as Try again");
    assert.strictEqual(state.docs, 1);
    assert.strictEqual(ack && ack.status, "started");
  });

  await test("captions.js does not depend on the audio pipeline or the auto-pause state", () => {
    const src = fs.readFileSync(path.join(ROOT, "captions.js"), "utf8");
    assert.ok(!/pm_autoPausedSlow|PMPace|offscreen|audio-paused|runtime\.connect|unanalyzable/.test(src));
  });

  await test("content.js audio-paused handler leaves caption censoring alone", () => {
    const src = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
    const i = src.indexOf("msg.type === 'audio-paused'");
    const handler = src.slice(i, i + 1400);
    assert.ok(!/censorCaption|PMCaptions|captions\./i.test(handler));
  });

  console.log("autopause_test.js: " + passed + "/" + (passed + failed) + " passed");
  if (failed) process.exit(1);
})();
