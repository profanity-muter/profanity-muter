// shared/lifecycle.js
// Plain script (NOT an ES module). Defines globalThis.PMLifecycle and, under
// Node, module.exports = { PMLifecycle } for test/lifecycle_test.js.
// Loaded by importScripts() in background.js and bundled into the offscreen
// document (src/offscreen-src.js).
//
// WHY THIS EXISTS (0.1.59)
// ------------------------
// Field data (4 days of real use): the offscreen document stayed alive the
// whole time, holding ~1.4GB (Whisper WASM) around the clock, and its JS heap
// grew because every open YouTube tab kept a session (two byte runs of up to
// 64MiB cache each, every word, every dedupe key) until the tab closed. Pure
// decision functions live here so they can be tested without a browser:
//   - idleStep:          when may the service worker close the offscreen doc
//   - selectEvictions:   which per-tab sessions the offscreen doc should free
//   - isSessionVideoId:  which pages may open a session at all
//   - diagGate:          rate limit for repeated steady-state diag lines
(function (root) {
  "use strict";

  var MIN = 60 * 1000;
  var IDLE_TEARDOWN_MS = 10 * MIN; // no tab PLAYING for this long -> close the offscreen doc
  var SESSION_IDLE_MS = 10 * MIN; // a session untouched this long is freed
  var MAX_INACTIVE_SESSIONS = 2; // backstop: sessions of tabs the pipeline is not serving
  var DIAG_REPEAT_MS = 10 * MIN; // same steady-state diag line at most this often
  var DIAG_FLAP_MS = 5000; // a changed reason is still throttled this hard

  // A real watch page has a bare 11-char style id ("v" param). capture.js
  // falls back to location.pathname when there is no "v", which is what made
  // channel pages ("/@name") and the home page ("/") open sessions. Shorts
  // ("/shorts/<id>") are an explicit unsupported state (health.js SHORTS), so
  // they do not open one either.
  function isSessionVideoId(id) {
    return typeof id === "string" && id.length > 0 && id.charAt(0) !== "/";
  }

  // state: { playing: {tabId: bool}, idleSince: ms|null }
  // Returns { idleSince, teardown }. idleSince starts the moment the last
  // playing tab stops (or the first time we look with nothing playing) and
  // clears as soon as any tab plays. Paused-but-open tabs never hold it open.
  function idleStep(state, now, idleMs) {
    state = state || {};
    var limit = typeof idleMs === "number" ? idleMs : IDLE_TEARDOWN_MS;
    var playing = state.playing || {};
    var any = false;
    for (var k in playing) if (playing[k] === true) { any = true; break; }
    if (any) return { idleSince: null, teardown: false };
    var since = typeof state.idleSince === "number" ? state.idleSince : now;
    return { idleSince: since, teardown: now - since >= limit };
  }

  // sessions: [{key, lastTouchWall, serving, processing}]. Returns keys to
  // free. A session mid-transcription is never chosen (it is picked up on a
  // later sweep), since dropping it would orphan an in-flight WASM call.
  function selectEvictions(sessions, now, opts) {
    opts = opts || {};
    var idleMs = typeof opts.idleMs === "number" ? opts.idleMs : SESSION_IDLE_MS;
    var maxInactive = typeof opts.maxInactive === "number" ? opts.maxInactive : MAX_INACTIVE_SESSIONS;
    var out = {};
    var keep = [];
    sessions.forEach(function (s) {
      if (s.processing) return;
      if (now - s.lastTouchWall >= idleMs) out[s.key] = true;
      else if (!s.serving) keep.push(s);
    });
    keep.sort(function (a, b) { return b.lastTouchWall - a.lastTouchWall; });
    keep.slice(maxInactive).forEach(function (s) { out[s.key] = true; });
    return Object.keys(out);
  }

  // state is a plain object kept per session: {lastKey, wall: {key: ms}}.
  // Logs when the reason changes (but not faster than DIAG_FLAP_MS per key),
  // and repeats an unchanged reason at most once per DIAG_REPEAT_MS.
  function diagGate(state, key, now, opts) {
    opts = opts || {};
    var repeatMs = typeof opts.repeatMs === "number" ? opts.repeatMs : DIAG_REPEAT_MS;
    var flapMs = typeof opts.flapMs === "number" ? opts.flapMs : DIAG_FLAP_MS;
    var wall = state.wall || (state.wall = {});
    var last = wall[key];
    var ok;
    if (last == null) ok = true;
    else if (state.lastKey !== key) ok = now - last >= flapMs;
    else ok = now - last >= repeatMs;
    if (ok) { wall[key] = now; state.lastKey = key; }
    return ok;
  }

  root.PMLifecycle = {
    IDLE_TEARDOWN_MS: IDLE_TEARDOWN_MS,
    SESSION_IDLE_MS: SESSION_IDLE_MS,
    MAX_INACTIVE_SESSIONS: MAX_INACTIVE_SESSIONS,
    DIAG_REPEAT_MS: DIAG_REPEAT_MS,
    isSessionVideoId: isSessionVideoId,
    idleStep: idleStep,
    selectEvictions: selectEvictions,
    diagGate: diagGate
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMLifecycle: root.PMLifecycle };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
