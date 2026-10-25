// test/memlog_test.js - unit tests for shared/memlog.js (PM-MEM timeline):
// the tiered bounded series, the compact sample shape, and the WebAssembly
// memory probe. Run with: node test/memlog_test.js (or npm test).
"use strict";
const assert = require("assert");
const path = require("path");
const M = require(path.join(__dirname, "..", "shared", "memlog.js")).PMMemlog;

let passed = 0, failed = 0;
const pending = [];
function fail(name, e) { failed++; console.error("FAIL: " + name + "\n      " + (e && e.message ? e.message : e)); }
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") pending.push(r.then(() => { passed++; }, (e) => fail(name, e)));
    else passed++;
  } catch (e) { fail(name, e); }
}

const MIN = 60 * 1000;

test("mb rounds to 1dp and rejects junk", () => {
  assert.strictEqual(M.mb(1048576 * 10.26), 10.3);
  assert.strictEqual(M.mb(null), null);
  assert.strictEqual(M.mb(NaN), null);
  assert.strictEqual(M.mb(-5), null);
});

test("buildSample is compact and tolerates missing parts", () => {
  const s = M.buildSample("tick", 1000, { wasmBytes: 600 * 1048576, wasmN: 1, jsUsed: 50 * 1048576, jsTotal: 80 * 1048576, windows: 7, ageS: 300 }, { jsUsed: 20 * 1048576, ageS: 900, caches: { ses: 1, runs: 2, runMB: 30.5 } });
  assert.strictEqual(s.t, 1000);
  assert.strictEqual(s.k, "tick");
  assert.strictEqual(s.w.wasm, 600);
  assert.strictEqual(s.w.win, 7);
  assert.strictEqual(s.o.ju, 20);
  assert.strictEqual(s.o.c.runMB, 30.5);
  const bare = M.buildSample("create", 5, null, null);
  assert.strictEqual(bare.k, "create");
  assert.ok(JSON.stringify(s).length < 400);
});

test("append keeps events separate and bounded", () => {
  let log = M.emptyLog();
  for (let i = 0; i < M.EVENT_CAP + 10; i++) log = M.append(log, { t: i, k: "respawn" });
  assert.strictEqual(log.events.length, M.EVENT_CAP);
  assert.strictEqual(log.events[log.events.length - 1].t, M.EVENT_CAP + 9);
  assert.strictEqual(log.recent.length, 0);
});

test("1/min series for 30h stays bounded and spans the whole range", () => {
  let log = M.emptyLog();
  const total = 30 * 60;
  for (let i = 0; i < total; i++) log = M.append(log, { t: i * MIN, k: "tick", n: i });
  const n = log.recent.length + log.mid.length + log.old.length;
  assert.ok(n <= M.RECENT_CAP + M.MID_CAP + M.OLD_CAP, "count " + n);
  assert.strictEqual(log.recent.length, M.RECENT_CAP);
  // newest is the last sample; recent is 1/min
  assert.strictEqual(log.recent[log.recent.length - 1].n, total - 1);
  assert.strictEqual(log.recent[1].t - log.recent[0].t, MIN);
  // coverage of at least 24h from newest back to oldest retained
  const oldest = (log.old[0] || log.mid[0] || log.recent[0]).t;
  assert.ok((total - 1) * MIN - oldest >= 24 * 60 * MIN, "span h " + ((total - 1) * MIN - oldest) / 60 / MIN);
  // tiers are time-ordered oldest first
  const all = M.flatten(log);
  for (let i = 1; i < all.length; i++) assert.ok(all[i].t > all[i - 1].t);
  // mid is ~5 min resolution, old ~15 min
  assert.ok(log.mid[1].t - log.mid[0].t >= 5 * MIN);
  assert.ok(log.old[1].t - log.old[0].t >= 15 * MIN);
  assert.ok(JSON.stringify(log).length < 120 * 1024);
});

test("normalize replaces junk and tolerates partial logs", () => {
  assert.deepStrictEqual(M.normalize("x"), M.emptyLog());
  const n = M.normalize({ version: 1, recent: [{ t: 1 }] });
  assert.strictEqual(n.recent.length, 1);
  assert.deepStrictEqual(n.mid, []);
  assert.deepStrictEqual(n.events, []);
});

test("wasm probe tracks Memory constructed after install and sees growth", () => {
  const WA = { Memory: WebAssembly.Memory, instantiate: WebAssembly.instantiate, Instance: WebAssembly.Instance };
  const probe = M.installWasmProbe(WA);
  assert.strictEqual(probe.stats().n, 0);
  const mem = new WA.Memory({ initial: 2, maximum: 10 });
  assert.ok(mem instanceof WebAssembly.Memory);
  assert.strictEqual(probe.stats().bytes, 2 * 65536);
  mem.grow(3);
  assert.strictEqual(probe.stats().bytes, 5 * 65536);
  assert.strictEqual(probe.stats().peak, 5 * 65536);
  assert.strictEqual(M.installWasmProbe(WA), probe); // idempotent
});

test("wasm probe captures exported memory from instantiate", async () => {
  // (module (memory (export "memory") 3))
  const bytes = new Uint8Array([0,97,115,109,1,0,0,0,5,3,1,0,3,7,10,1,6,109,101,109,111,114,121,2,0]);
  const WA = { Memory: WebAssembly.Memory, instantiate: WebAssembly.instantiate.bind(WebAssembly) };
  const probe = M.installWasmProbe(WA);
  await WA.instantiate(bytes);
  assert.strictEqual(probe.stats().bytes, 3 * 65536);
});

test("wasm probe is safe when WebAssembly is missing", () => {
  const probe = M.installWasmProbe(undefined);
  assert.deepStrictEqual(probe.stats(), { bytes: null, n: 0, peak: null });
});

Promise.all(pending).then(() => {
  console.log("memlog_test.js: " + passed + "/" + (passed + failed) + " passed");
  if (failed) process.exit(1);
});
