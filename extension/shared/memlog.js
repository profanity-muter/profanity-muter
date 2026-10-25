// shared/memlog.js
// Plain script (NOT an ES module). Defines globalThis.PMMemlog and, under
// Node, module.exports = { PMMemlog } for unit tests (test/memlog_test.js).
// Loaded three ways: importScripts() in background.js (which persists the
// series), require()d by esbuild into the offscreen document and the
// Whisper worker bundles (which sample), and by the popup (which reads it
// for "Copy debug log").
//
// WHY THIS EXISTS (0.1.57)
// ------------------------
// A field report had the background renderer (offscreen doc + Whisper
// worker) at 2.2GB RSS after 21h of Chrome uptime. The devlog recorded
// pipeline events but no memory, so a steady per-window leak could not be
// told apart from one big plateau. This module records the numbers that
// separate them. WebAssembly linear memory never shrinks, so it is the key
// figure; it is read by wrapping WebAssembly.Memory / instantiate BEFORE
// onnxruntime-web loads (see installWasmProbe).
//
// Storage: chrome.storage.local key `pm_memlog`, written only by
// background.js. Shape (all bounded, see caps below):
//   { version: 1,
//     recent: Sample[]   1 per minute, newest last   (RECENT_CAP, ~2h)
//     mid:    Sample[]   >= 5 min apart              (MID_CAP,   ~12h)
//     old:    Sample[]   >= 15 min apart             (OLD_CAP,   ~12h)
//     events: Sample[]   respawn / create / teardown (EVENT_CAP) }
// A sample falling off `recent` is promoted to `mid` if it is >= 5 min
// after the newest `mid` entry (else dropped); same rule mid -> old at 15
// min. Total span is therefore ~26h at worst-case ~60KB serialized.
//
// Sample = { t: wall ms, k: kind, why?: string,
//   w: worker   { wasm: MB linear memory (all wasm Memory objects, summed),
//                 peak: MB, n: Memory count, ju/jt: JS heap used/total MB,
//                 win: windows since worker start, age: worker age s,
//                 stale: s since this worker snapshot was taken },
//   o: offscreen { ju/jt: JS heap MB, age: doc age s,
//                 c: caches { ses, runs, runMB (bytes fed to run streams,
//                 each capped at the 64MB stream cache), words, keys,
//                 maps, pend, infl, skip } } }

(function (root) {
  "use strict";

  var SCHEMA_VERSION = 1;
  var RECENT_CAP = 120;
  var MID_CAP = 144;
  var OLD_CAP = 48;
  var EVENT_CAP = 60;
  var MID_GAP_MS = 5 * 60 * 1000;
  var OLD_GAP_MS = 15 * 60 * 1000;
  var MB = 1048576;

  function mb(bytes) {
    if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return null;
    return Math.round((bytes / MB) * 10) / 10;
  }

  function num(n) {
    return typeof n === "number" && isFinite(n) ? n : null;
  }

  // performance.memory is Chrome-only and (in some contexts) absent.
  function jsHeap(perf) {
    var m = perf && perf.memory;
    if (!m) return { used: null, total: null };
    return { used: num(m.usedJSHeapSize), total: num(m.totalJSHeapSize) };
  }

  function emptyLog() {
    return { version: SCHEMA_VERSION, recent: [], mid: [], old: [], events: [] };
  }

  function arr(a) { return Array.isArray(a) ? a.slice() : []; }

  function normalize(raw) {
    if (!raw || typeof raw !== "object") return emptyLog();
    return {
      version: SCHEMA_VERSION,
      recent: arr(raw.recent),
      mid: arr(raw.mid),
      old: arr(raw.old),
      events: arr(raw.events)
    };
  }

  // Offer `sample` to a tier. Accepted only if >= gap after the tier's
  // newest entry. Returns the entry evicted from the front (if the tier
  // overflowed) so the caller can cascade it to the next, coarser tier.
  function promote(tier, sample, gap, cap) {
    var last = tier[tier.length - 1];
    if (last && sample.t - last.t < gap) return null;
    tier.push(sample);
    return tier.length > cap ? tier.shift() : null;
  }

  // Add one sample. 'tick'/'win' go into the tiered series; anything else
  // (create, respawn, teardown...) goes into the event list so a burst of
  // respawns can never evict the long-term series, and vice versa.
  function append(log, sample) {
    var out = normalize(log);
    if (!sample || typeof sample !== "object") return out;
    if (sample.k === "tick" || sample.k === "win") {
      out.recent.push(sample);
      while (out.recent.length > RECENT_CAP) {
        var fell = out.recent.shift();
        var evicted = promote(out.mid, fell, MID_GAP_MS, MID_CAP);
        if (evicted) {
          promote(out.old, evicted, OLD_GAP_MS, OLD_CAP);
        }
      }
    } else {
      out.events.push(sample);
      while (out.events.length > EVENT_CAP) out.events.shift();
    }
    return out;
  }

  function flatten(log) {
    var l = normalize(log);
    return l.old.concat(l.mid, l.recent);
  }

  function buildSample(kind, wall, worker, offscreen, why) {
    var s = { t: wall, k: kind };
    if (why != null) s.why = String(why).slice(0, 120);
    if (worker) {
      s.w = {
        wasm: mb(worker.wasmBytes),
        peak: mb(worker.wasmPeak),
        n: num(worker.wasmN),
        ju: mb(worker.jsUsed),
        jt: mb(worker.jsTotal),
        win: num(worker.windows),
        age: num(worker.ageS),
        stale: num(worker.staleS)
      };
    }
    if (offscreen) {
      s.o = {
        ju: mb(offscreen.jsUsed),
        jt: mb(offscreen.jsTotal),
        age: num(offscreen.ageS),
        c: offscreen.caches || null
      };
    }
    return s;
  }

  // ---- WebAssembly memory probe -------------------------------------------
  // onnxruntime-web keeps its Emscripten module private, so the linear
  // memory is reached by observing WebAssembly itself: wrap the Memory
  // constructor (memory created in JS and imported) and
  // instantiate/instantiateStreaming (memory exported by the module). Must
  // be installed before onnxruntime-web is evaluated. `WA` is injectable so
  // tests do not mutate the real global.
  var MAX_TRACKED = 8;

  function installWasmProbe(WA) {
    var empty = { stats: function () { return { bytes: null, n: 0, peak: null }; } };
    if (!WA || typeof WA !== "object") return empty;
    if (WA.__pmMemProbe) return WA.__pmMemProbe;
    var mems = [];
    var peak = 0;

    function track(m) {
      if (!m || mems.indexOf(m) !== -1 || mems.length >= MAX_TRACKED) return;
      mems.push(m);
    }
    function trackExports(res) {
      try {
        var inst = res && res.instance ? res.instance : res;
        var ex = inst && inst.exports;
        if (!ex) return;
        for (var k in ex) {
          if (typeof WebAssembly !== "undefined" && ex[k] instanceof WebAssembly.Memory) track(ex[k]);
        }
      } catch (e) {}
    }

    if (typeof WA.Memory === "function") {
      var RealMemory = WA.Memory;
      WA.Memory = new Proxy(RealMemory, {
        construct: function (target, args, newTarget) {
          var m = Reflect.construct(target, args, newTarget === WA.Memory ? target : newTarget);
          track(m);
          return m;
        }
      });
    }
    ["instantiate", "instantiateStreaming"].forEach(function (name) {
      var real = WA[name];
      if (typeof real !== "function") return;
      WA[name] = function () {
        var p = real.apply(this, arguments);
        if (p && typeof p.then === "function") p.then(trackExports, function () {});
        return p;
      };
    });

    var probe = {
      stats: function () {
        var total = 0;
        for (var i = 0; i < mems.length; i++) {
          try { total += mems[i].buffer.byteLength; } catch (e) {}
        }
        if (total > peak) peak = total;
        return { bytes: mems.length ? total : null, n: mems.length, peak: mems.length ? peak : null };
      }
    };
    try { WA.__pmMemProbe = probe; } catch (e) {}
    return probe;
  }

  root.PMMemlog = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    RECENT_CAP: RECENT_CAP,
    MID_CAP: MID_CAP,
    OLD_CAP: OLD_CAP,
    EVENT_CAP: EVENT_CAP,
    mb: mb,
    jsHeap: jsHeap,
    emptyLog: emptyLog,
    normalize: normalize,
    append: append,
    flatten: flatten,
    buildSample: buildSample,
    installWasmProbe: installWasmProbe
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMMemlog: root.PMMemlog };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
