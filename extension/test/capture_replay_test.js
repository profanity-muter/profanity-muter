// test/capture_replay_test.js - runs the REAL capture.js in a vm with a fake MSE and proves
// the 0.1.63 re-feed: a rebuild (stall recovery, idle wake, session GC) re-posts the init
// segment AND the retained media segments that cover the playhead, so a run created after
// the audio was already appended is decodable immediately instead of only after new appends.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + name + "\n      " + (e && e.stack ? e.stack : e)); }
}

function load() {
  const posts = [];
  const listeners = {};
  const video = { currentTime: 0, duration: 900 };
  class FakeSB {
    constructor() { this.updating = false; this.ranges = []; this.l = {}; }
    get buffered() { const r = this.ranges; return { length: r.length, start: (i) => r[i][0], end: (i) => r[i][1] }; }
    addEventListener(n, f) { (this.l[n] = this.l[n] || []).push(f); }
    appendBuffer() { this.updating = true; }
    changeType() {}
  }
  class FakeMS { addSourceBuffer() { return new FakeSB(); } }
  const sandbox = {
    console: { log: (...a) => { if (process.env.DBG) console.log(...a); }, warn() {}, error() {} },
    setInterval: () => 0, setTimeout, Promise, Map, Set, JSON, Object, Array, Math, Number, String, Error,
    Uint8Array, ArrayBuffer, URLSearchParams,
    Date,
    location: { search: "?v=abcdefghijk", pathname: "/watch", href: "https://www.youtube.com/watch?v=abcdefghijk", origin: "https://www.youtube.com" },
    document: {
      querySelector: () => video, querySelectorAll: () => [video], getElementById: () => null,
      addEventListener() {}
    },
    MessageChannel: class { constructor() { this.port1 = { postMessage: (m) => posts.push(m), set onmessage(f) {} }; this.port2 = {}; } },
    MediaSource: FakeMS
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  sandbox.postMessage = () => {};
  sandbox.addEventListener = (n, f) => { (listeners[n] = listeners[n] || []).push(f); };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "capture.js"), "utf8"), sandbox, { filename: "capture.js" });
  const sb = new sandbox.MediaSource().addSourceBuffer('audio/webm; codecs="opus"');
  const append = (tag, endS, ct) => {
    const prevEnd = sb.ranges.length ? sb.ranges[sb.ranges.length - 1][1] : 0;
    video.currentTime = ct;
    sb.appendBuffer(new Uint8Array([tag, tag, tag]));
    sb.ranges = [[0, endS]]; sb.updating = false;
    (sb.l.updateend || []).forEach((f) => f());
    return prevEnd;
  };
  const segPosts = () => posts.filter((m) => m.type === "segment");
  const rebuild = (atS) => listeners.message.forEach((f) => f({ source: vm.runInContext('window', sandbox), data: { __pmToCapture: "PM_CONTENT", type: "force-run-boundary", atS } }));
  return { posts, sb, append, segPosts, rebuild, video };
}

test("rebuild re-posts init then the retained segments that cover the playhead", () => {
  const h = load();
  h.append(1, 5, 0);   // init (isInit)
  h.append(2, 10, 0);  // [5,10)
  h.append(3, 15, 6);  // [10,15)
  h.append(4, 20, 6);  // [15,20)
  const before = h.segPosts().length;
  assert.strictEqual(before, 4);
  h.video.currentTime = 12;
  h.rebuild(12);
  const replay = h.segPosts().slice(before);
  assert.strictEqual(replay[0].isInit, true, "replay opens with an init segment");
  assert.deepStrictEqual(Array.from(new Uint8Array(replay[0].bytes)), [1, 1, 1], "init bytes are the cached real init");
  const media = replay.slice(1);
  assert.deepStrictEqual(media.map((m) => Array.from(new Uint8Array(m.bytes))[0]), [3, 4], "only segments reaching the playhead, in order");
  media.forEach((m) => { assert.strictEqual(m.isInit, false); assert.strictEqual(m.currentTime, 12, "stamped with the live playhead"); });
  assert.ok(h.posts.some((m) => m.type === "run-topology" && m.event === "rebuilt"));
});

test("a rebuild with nothing retained for the playhead still posts just the init", () => {
  const h = load();
  h.append(1, 5, 0);
  const before = h.segPosts().length;
  h.rebuild(300);
  const replay = h.segPosts().slice(before);
  assert.strictEqual(replay.length, 1);
  assert.strictEqual(replay[0].isInit, true);
});

test("retained bytes are capped (oldest dropped first)", () => {
  const h = load();
  h.append(1, 5, 0);
  const big = new Uint8Array(4 * 1024 * 1024);
  for (let i = 0; i < 12; i++) { // 48 MB offered, cap is far below that
    big[0] = 10 + i;
    h.sb.appendBuffer(big);
    h.sb.ranges = [[0, 10 + i * 5]]; h.sb.updating = false;
    (h.sb.l.updateend || []).forEach((f) => f());
  }
  const before = h.segPosts().length;
  h.rebuild(0);
  const replayed = h.segPosts().slice(before).length - 1;
  assert.ok(replayed >= 1 && replayed < 12, "replayed " + replayed);
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
