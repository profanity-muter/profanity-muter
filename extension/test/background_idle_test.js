// test/background_idle_test.js - runs the REAL background.js in a vm with a
// stubbed chrome.* and proves the 0.1.59 idle teardown: closes the offscreen
// document after 10 minutes with no tab PLAYING (paused tabs do not count),
// does not recreate it on unrelated wakes, recreates it on a play event and
// logs the cold start, survives a service-worker restart via
// chrome.storage.session, and ignores channel/home pages.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + name + "\n      " + (e && e.stack ? e.stack : e)); }
}
const MIN = 60 * 1000;
const flush = () => new Promise((r) => setImmediate(r));
const flushAll = async () => { for (let i = 0; i < 8; i++) await flush(); };

// One "browser": storage + the offscreen document live across service-worker restarts.
function makeBrowser() {
  return {
    clock: 1_800_000_000_000,
    session: {}, local: {}, sync: {},
    offscreenOpen: false, creates: 0, closes: 0,
    swListeners: null
  };
}

function startSW(br) {
  const L = { connect: [], runtimeMsg: [], tabsRemoved: [] };
  const evt = (arr) => ({ addListener: (fn) => arr && arr.push(fn) });
  const noop = { addListener() {} };
  const area = (store) => ({
    get: (keys, cb) => {
      const p = (async () => {
      if (typeof keys === "string") keys = [keys];
      const out = {};
      if (Array.isArray(keys)) keys.forEach((k) => { if (k in store) out[k] = JSON.parse(JSON.stringify(store[k])); });
      else if (keys && typeof keys === "object") Object.keys(keys).forEach((k) => { out[k] = k in store ? store[k] : keys[k]; });
      return out;
      })();
      if (typeof cb === "function") { p.then(cb); return undefined; }
      return p;
    },
    set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); }
  });
  const sent = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, Promise, Map, Set, JSON, Object, Array, Math, Number, String, Error,
    Date: class extends Date { static now() { return br.clock; } },
    chrome: {
      storage: { local: area(br.local), sync: Object.assign(area(br.sync), {}), session: area(br.session), onChanged: noop },
      tabs: { onActivated: noop, onUpdated: noop, onRemoved: evt(L.tabsRemoved), create() {} },
      windows: { onFocusChanged: noop },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setIcon() {}, getUserSettings: async () => ({}), openPopup: async () => {} },
      runtime: {
        getURL: (p) => p, getManifest: () => ({ version: "0.1.59" }), lastError: null,
        onConnect: evt(L.connect), onMessage: evt(L.runtimeMsg), onInstalled: noop, onStartup: noop,
        getContexts: async () => (br.offscreenOpen ? [{}] : []),
        sendMessage: async (m) => {
          sent.push(m);
          if (!br.offscreenOpen) throw new Error("Receiving end does not exist");
          if (m.type === "pm-prepare-teardown") return { t: br.clock, k: "teardown", w: { wasm: 1223.5, peak: 1328.1 }, o: { ju: 80 } };
        }
      },
      offscreen: {
        createDocument: async () => { br.offscreenOpen = true; br.creates++; },
        closeDocument: async () => { if (!br.offscreenOpen) throw new Error("none"); br.offscreenOpen = false; br.closes++; }
      }
    }
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), sandbox, { filename: f }));
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), sandbox, { filename: "background.js" });
  const sw = { L, sent, ports: {} };
  sw.connectTab = (tabId) => {
    const handlers = { msg: [], disc: [] };
    const received = [];
    const port = {
      name: "pm-content", sender: { tab: { id: tabId } },
      postMessage(m) { received.push(m); },
      onMessage: { addListener: (f) => handlers.msg.push(f) },
      onDisconnect: { addListener: (f) => handlers.disc.push(f) }
    };
    L.connect.forEach((f) => f(port));
    sw.ports[tabId] = { port, handlers, received, post: (m) => handlers.msg.forEach((f) => f(m)), drop: () => handlers.disc.forEach((f) => f()) };
    return sw.ports[tabId];
  };
  // the offscreen doc's once-a-minute sample, the event that wakes a sleeping worker
  sw.memTick = () => L.runtimeMsg.forEach((f) => f({ type: "pm-mem", sample: { t: br.clock, k: "tick" } }, {}, () => {}));
  sw.warmReady = () => L.runtimeMsg.forEach((f) => f({ type: "pm-warm-ready", workerSpawnMs: 40, modelLoadMs: 900 }, {}, () => {}));
  sw.memEvents = () => ((br.local.pm_memlog || {}).events || []);
  return sw;
}

(async () => {
  await test("no tab playing for 10 minutes closes the offscreen document", async () => {
    const br = makeBrowser();
    const sw = startSW(br); await flushAll();
    assert.strictEqual(br.offscreenOpen, true);
    const t = sw.connectTab(1); await flushAll();
    t.post({ type: "playstate", videoId: "aaaaaaaaaaa", playing: false }); await flushAll();
    br.clock += 9 * MIN; sw.memTick(); await flushAll();
    assert.strictEqual(br.offscreenOpen, true, "still open at 9 min");
    br.clock += 2 * MIN; sw.memTick(); await flushAll();
    assert.strictEqual(br.offscreenOpen, false);
    const ev = sw.memEvents().find((e) => e.k === "idle-teardown");
    assert.ok(ev && /PM-IDLE-TEARDOWN/.test(ev.why), "teardown event recorded");
    assert.strictEqual(ev.w.wasm, 1223.5, "memory snapshot attached");
  });

  await test("a playing tab keeps it open indefinitely", async () => {
    const br = makeBrowser();
    const sw = startSW(br); await flushAll();
    const t = sw.connectTab(1); await flushAll();
    t.post({ type: "playstate", videoId: "aaaaaaaaaaa", playing: true }); await flushAll();
    br.clock += 3 * 60 * MIN; sw.memTick(); await flushAll();
    assert.strictEqual(br.offscreenOpen, true);
  });

  await test("unrelated wakes do not recreate a parked document; a play event does, and logs the cold start", async () => {
    const br = makeBrowser();
    const sw = startSW(br); await flushAll();
    const t = sw.connectTab(1); await flushAll();
    t.post({ type: "playstate", videoId: "aaaaaaaaaaa", playing: false }); await flushAll();
    br.clock += 11 * MIN; sw.memTick(); await flushAll();
    assert.strictEqual(br.offscreenOpen, false);
    t.post({ type: "reset", videoId: "bbbbbbbbbbb" }); await flushAll(); // paused tab navigates
    sw.connectTab(2); await flushAll(); // new paused tab
    assert.strictEqual(br.offscreenOpen, false, "stays parked");
    const creates = br.creates;
    t.post({ type: "playstate", videoId: "bbbbbbbbbbb", playing: true }); await flushAll();
    assert.strictEqual(br.offscreenOpen, true);
    assert.strictEqual(br.creates, creates + 1);
    // the new document gets the per-tab config re-pushed (existing respawn path)
    const cfg = sw.sent.filter((m) => m.type === "pm-config" && m.tabId === 1 && m.videoId === "bbbbbbbbbbb");
    assert.ok(cfg.length >= 1, "pm-config re-pushed for the playing tab");
    br.clock += 1800; sw.warmReady(); await flushAll();
    const wake = sw.memEvents().find((e) => e.k === "idle-wake");
    assert.ok(wake && /coldStart|cold start 1800ms/.test(wake.why), wake && wake.why);
  });

  await test("teardown survives a service-worker restart (state in chrome.storage.session)", async () => {
    const br = makeBrowser();
    let sw = startSW(br); await flushAll();
    let t = sw.connectTab(1); await flushAll();
    t.post({ type: "playstate", videoId: "aaaaaaaaaaa", playing: false }); await flushAll();
    br.clock += 6 * MIN;
    sw = startSW(br); await flushAll(); // worker killed and respawned 6 min in
    t = sw.connectTab(1); await flushAll();
    t.post({ type: "playstate", videoId: "aaaaaaaaaaa", playing: false }); await flushAll();
    br.clock += 5 * MIN; sw.memTick(); await flushAll();
    assert.strictEqual(br.offscreenOpen, false, "idle clock carried across the restart");
    // and a restarted worker does not resurrect a parked document
    sw = startSW(br); await flushAll();
    sw.connectTab(1); await flushAll();
    assert.strictEqual(br.offscreenOpen, false);
  });

  await test("a restored playing tab that never reconnects cannot hold the document open", async () => {
    const br = makeBrowser();
    let sw = startSW(br); await flushAll();
    let t = sw.connectTab(1); await flushAll();
    t.post({ type: "playstate", videoId: "aaaaaaaaaaa", playing: true }); await flushAll();
    br.clock += 5 * MIN;
    sw = startSW(br); await flushAll(); // SW restarted; tab 1 navigated away meanwhile, never reconnects
    br.clock += 40 * 1000; sw.memTick(); await flushAll(); // inside grace: nothing yet
    assert.strictEqual(br.offscreenOpen, true);
    br.clock += 11 * MIN; sw.memTick(); await flushAll(); // idle clock starts here
    br.clock += 11 * MIN; sw.memTick(); await flushAll();
    assert.strictEqual(br.offscreenOpen, false);
  });

  await test("channel and home pages open no offscreen session", async () => {
    const br = makeBrowser();
    const sw = startSW(br); await flushAll();
    const t = sw.connectTab(1); await flushAll();
    sw.sent.length = 0;
    t.post({ type: "reset", videoId: "/@buildwitt" });
    t.post({ type: "segment", videoId: "/", isInit: true, dataB64: "AA==" });
    t.post({ type: "seek", videoId: "/", currentTime: 3 });
    await flushAll();
    assert.deepStrictEqual(sw.sent.filter((m) => ["pm-config", "pm-segment", "pm-seek"].includes(m.type)), []);
    assert.strictEqual(sw.sent.filter((m) => m.type === "pm-reset").length, 1, "reset still releases the previous video");
    t.post({ type: "reset", videoId: "abcdefghijk" }); await flushAll();
    assert.ok(sw.sent.some((m) => m.type === "pm-config" && m.videoId === "abcdefghijk"));
  });

  async function parked(tabs) {
    const br = makeBrowser();
    const sw = startSW(br); await flushAll();
    const ts = tabs.map((id) => sw.connectTab(id));
    await flushAll();
    ts.forEach((t) => t.post({ type: "playstate", videoId: "aaaaaaaaaaa", playing: false }));
    await flushAll();
    br.clock += 11 * MIN; sw.memTick(); await flushAll();
    assert.strictEqual(br.offscreenOpen, false, "parked");
    return { br, sw, ts };
  }

  // 0.1.63: wake is level-triggered. Evidence of an active video wakes the document even
  // when no play-state CHANGE is ever reported (play carried across an SPA navigation).
  await test("an audio segment arriving while parked wakes the document and tells every tab it is reborn", async () => {
    const { br, sw, ts } = await parked([1, 2]);
    ts[0].post({ type: "reset", videoId: "bbbbbbbbbbb" }); await flushAll();
    assert.strictEqual(br.offscreenOpen, false, "a reset alone (paused navigation) stays parked");
    ts[0].post({ type: "segment", videoId: "bbbbbbbbbbb", isInit: false, dataB64: "AA==" }); await flushAll();
    assert.strictEqual(br.offscreenOpen, true, "segment woke it");
    ts.forEach((t) => assert.ok(t.received.some((m) => m.type === "offscreen-reborn"), "tab told to re-feed"));
    br.clock += 1500; sw.warmReady(); await flushAll();
    assert.ok(sw.memEvents().find((e) => e.k === "idle-wake"), "cold start logged");
  });

  await test("a repeated playing=true report (heartbeat) wakes a parked document", async () => {
    const { br, ts } = await parked([1]);
    ts[0].post({ type: "playstate", videoId: "aaaaaaaaaaa", playing: true }); await flushAll();
    assert.strictEqual(br.offscreenOpen, true);
    assert.ok(ts[0].received.some((m) => m.type === "offscreen-reborn"));
  });

  await test("a segment for a home/channel page does not wake a parked document", async () => {
    const { br, ts } = await parked([1]);
    ts[0].post({ type: "segment", videoId: "/", isInit: false, dataB64: "AA==" }); await flushAll();
    assert.strictEqual(br.offscreenOpen, false);
  });

  await test("service-worker restart while parked: the next segment still wakes it", async () => {
    const { br } = await parked([1]);
    const sw2 = startSW(br); await flushAll();
    const t = sw2.connectTab(1); await flushAll();
    assert.strictEqual(br.offscreenOpen, false);
    t.post({ type: "segment", videoId: "bbbbbbbbbbb", isInit: false, dataB64: "AA==" }); await flushAll();
    assert.strictEqual(br.offscreenOpen, true);
  });

  await test("every fresh offscreen document triggers a re-feed request to connected tabs", async () => {
    const br = makeBrowser();
    const sw = startSW(br); await flushAll();
    const t = sw.connectTab(1); await flushAll();
    assert.ok(t.received.length >= 0);
    br.offscreenOpen = false; // document died (crash / reclaimed)
    t.received.length = 0;
    t.post({ type: "reset", videoId: "bbbbbbbbbbb" }); await flushAll();
    assert.strictEqual(br.offscreenOpen, true);
    assert.ok(t.received.some((m) => m.type === "offscreen-reborn"));
  });

  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
