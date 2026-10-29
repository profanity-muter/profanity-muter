// test/offscreen_gc_test.js - runs the REAL src/offscreen-src.js (bundled with
// esbuild into a vm context with stubbed chrome/Worker) and proves the
// 0.1.59 session lifecycle: counters in the PM-MEM sample drop when a session
// goes idle, on the inactive-session cap, on navigation and on tab close; a
// late message for a left video does not resurrect a session; a freshly
// created mid-stream session asks capture.js for a new run; and repeated
// PM-NO-WINDOW lines are rate limited.
"use strict";
const assert = require("assert");
const path = require("path");
const vm = require("vm");
const esbuild = require("esbuild");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + name + "\n      " + (e && e.stack ? e.stack : e)); }
}

async function load() {
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, "..", "src", "offscreen-src.js")],
    bundle: true, format: "iife", platform: "browser", target: "chrome110", write: false, logLevel: "silent"
  });
  const code = out.outputFiles[0].text;
  const state = { clock: 1_800_000_000_000, sent: [], listeners: [], intervals: [] };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => 0, clearTimeout() {},
    setInterval: (fn, ms) => { state.intervals.push([fn, ms]); return 0; },
    clearInterval() {},
    performance: { now: () => state.clock, memory: { usedJSHeapSize: 1e6, totalJSHeapSize: 2e6 } },
    document: { visibilityState: "visible" },
    Worker: class { constructor() { this.onmessage = null; } postMessage() {} terminate() {} },
    chrome: {
      runtime: {
        getURL: (p) => "chrome-extension://x/" + p,
        onMessage: { addListener: (fn) => state.listeners.push(fn) },
        sendMessage: (m) => { state.sent.push(m); return Promise.resolve(); }
      }
    },
    TextEncoder, TextDecoder, URL, Uint8Array, ArrayBuffer, Promise, Map, Set, Math, JSON, Object, Array, Number, String, Error, Symbol,
    ReadableStream, WritableStream: globalThis.WritableStream, TransformStream: globalThis.TransformStream,
    atob: globalThis.atob, btoa: globalThis.btoa, queueMicrotask,
    Date: class extends Date { static now() { return state.clock; } }
  };
  sandbox.self = sandbox; sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.addEventListener = () => {}; sandbox.WebAssembly = globalThis.WebAssembly;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "offscreen.bundle.js" });
  const send = (msg) => state.listeners.forEach((fn) => fn(msg, {}, () => {}));
  const tick = () => state.intervals.filter(([, ms]) => ms === 60000).forEach(([fn]) => fn());
  const counters = () => {
    state.clock += 61000; // past MEM_MIN_GAP so the throttled tick sample is emitted
    const before = state.sent.length;
    tick();
    const mem = state.sent.slice(before).filter((m) => m.type === "pm-mem").pop();
    return mem && mem.sample.o.c;
  };
  return { state, send, tick, counters };
}

const initSeg = (tabId, videoId, isInit, extra) => Object.assign({
  type: "pm-segment", tabId, videoId, isInit, segIndex: 0, currentTime: 5,
  dataB64: Buffer.from("not really webm").toString("base64")
}, extra || {});
const open = (h, tabId, videoId) => {
  h.send({ type: "pm-reset", tabId, videoId });
  h.send({ type: "pm-config", tabId, videoId, model: "base" });
  h.send(initSeg(tabId, videoId, true));
};
const MIN = 60 * 1000;

(async () => {
  await test("idle sessions are freed: ses/runs counters drop to zero", async () => {
    const h = await load();
    open(h, 1, "aaaaaaaaaaa"); open(h, 2, "bbbbbbbbbbb");
    let c = h.counters();
    assert.strictEqual(c.ses, 2); assert.strictEqual(c.runs, 2);
    h.state.clock += 11 * MIN;
    c = h.counters();
    assert.strictEqual(c.ses, 0); assert.strictEqual(c.runs, 0);
  });

  await test("inactive-session cap keeps 2, the served tab is untouched", async () => {
    const h = await load();
    for (let t = 1; t <= 5; t++) { open(h, t, "v" + t + "xxxxxxxxxx"); h.state.clock += 1000; }
    h.send({ type: "pm-active-tab", tabId: 5 });
    const c = h.counters();
    assert.strictEqual(c.ses, 3); // tab 5 (serving) + 2 newest inactive
    assert.strictEqual(c.runs, 3);
  });

  await test("navigation (pm-reset) frees the old video and a late segment does not resurrect it", async () => {
    const h = await load();
    open(h, 1, "oldvideo0001");
    assert.strictEqual(h.counters().ses, 1);
    h.send({ type: "pm-reset", tabId: 1, videoId: "/@channel" }); // left for a channel page
    assert.strictEqual(h.counters().ses, 0);
    h.send(initSeg(1, "oldvideo0001", false)); // late straggler for the video it left
    assert.strictEqual(h.counters().ses, 0);
  });

  await test("tab close frees the session", async () => {
    const h = await load();
    open(h, 7, "closevideo01");
    h.send({ type: "pm-tab-closed", tabId: 7 });
    assert.strictEqual(h.counters().ses, 0);
  });

  await test("a mid-stream segment into an empty offscreen asks capture.js for a new run", async () => {
    const h = await load();
    h.send({ type: "pm-config", tabId: 3, videoId: "wakevideo001", model: "base" });
    h.send(initSeg(3, "wakevideo001", false, { currentTime: 123 }));
    const req = h.state.sent.filter((m) => m.type === "pm-request-run-rebuild");
    assert.strictEqual(req.length, 1);
    assert.strictEqual(req[0].atS, 123);
  });

  await test("repeated PM-NO-WINDOW lines are logged once, then only after 10 minutes", async () => {
    const h = await load();
    open(h, 4, "nowindow0001");
    const noWin = () => h.state.sent.filter((m) => m.type === "pm-diag" && /PM-NO-WINDOW/.test(m.text)).length;
    for (let i = 0; i < 6; i++) { h.send(initSeg(4, "nowindow0001", false)); h.state.clock += 60 * 1000; }
    const n1 = noWin();
    assert.ok(n1 >= 1 && n1 <= 2, "first burst logged " + n1); // 'no-range' style reason, maybe plus one state change
    for (let i = 0; i < 6; i++) { h.send(initSeg(4, "nowindow0001", false)); h.state.clock += 60 * 1000; }
    assert.ok(noWin() - n1 <= 1, "second burst added " + (noWin() - n1));
  });

  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
