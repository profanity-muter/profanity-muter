// background.js — MV3 service worker. Owns the offscreen document (Whisper +
// demux run there, see spike-whisper/SPIKE_NOTES.md — inference does not work
// reliably in a service worker) and routes segment bytes / transcript results
// between each tab's content.js port and the single shared offscreen doc.
//
// The service worker itself is expendable: MV3 idles it after ~30s and Chrome
// respawns it on the next event (onConnect/onMessage). Session state that
// must survive a respawn (accumulated audio bytes, coverage, dedupe) lives in
// the offscreen document, not here — this file only routes and can be torn
// down and rebuilt freely.
'use strict';

var portsByTabId = new Map(); // tabId -> chrome.runtime.Port
var videoIdByTabId = new Map(); // tabId -> last known videoId (0.1.15: needed to re-push pm-config on offscreen respawn without waiting for a video change)
var creatingOffscreen = null;

// Any error in this file must not stay invisible in the SW's own
// (user-inaccessible) console — broadcast to every connected tab so it
// shows up in the "Copy logs" output.
function broadcastDiag(text) {
  console.error('[PM-BG]', text);
  portsByTabId.forEach(function (port) {
    try {
      port.postMessage({ type: 'diag', text: '[PM-BG] ' + text });
    } catch (e) {}
  });
}
self.addEventListener('error', function (ev) {
  broadcastDiag('uncaught error: ' + (ev.message || ev) + (ev.filename ? ' (' + ev.filename + ':' + ev.lineno + ')' : ''));
});
self.addEventListener('unhandledrejection', function (ev) {
  broadcastDiag('unhandled rejection: ' + String(ev.reason));
});

async function ensureOffscreenDocument() {
  var existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Streaming WebM demux + on-device Whisper transcription for profanity muting.'
    })
    .then(function () {
      // A genuinely FRESH offscreen document was just created — any prior
      // in-memory session state (including every session's modelId) is
      // gone. Previously this only got re-pushed on the next video-change
      // 'reset' message, so a respawn (e.g. onInstalled's force-recreate)
      // silently reverted every already-open tab back to DEFAULT_MODEL
      // until the user happened to navigate. Re-push pm_model to every
      // currently-connected tab right away instead.
      resendModelConfigToAllTabs();
    })
    .catch(function (e) {
      // Most common benign case: a create raced with an already-open doc.
      console.warn('[PM-BG] ensureOffscreenDocument create failed (may already exist):', String(e));
    });
  await creatingOffscreen;
  creatingOffscreen = null;
}

function resendModelConfigToAllTabs() {
  videoIdByTabId.forEach(function (videoId, tabId) {
    if (portsByTabId.has(tabId)) sendModelConfig(tabId, videoId);
  });
}
// Belt-and-suspenders against a stale offscreen document surviving a reload:
// onInstalled fires specifically on an extension install/update/reload (not
// on routine SW idle-respawns), so force-close any existing offscreen doc
// there before recreating — guarantees a fresh one running the CURRENT
// code, rather than possibly reusing an old one still running pre-reload
// logic (best-effort; closeDocument() throwing "no such document" is fine).
chrome.runtime.onInstalled.addListener(function () {
  chrome.offscreen
    .closeDocument()
    .catch(function () {})
    .then(ensureOffscreenDocument);
});
ensureOffscreenDocument();
chrome.runtime.onStartup.addListener(ensureOffscreenDocument);

function sendModelConfig(tabId, videoId) {
  try {
    // pm_multilingual (0.1.25, default true — the wordlist agent owns the
    // popup toggle for this) read the same way pm_model already is: once
    // per video reset, not reactively mid-video (matches pm_model's own
    // existing behavior — a mid-video toggle takes effect on the NEXT video).
    chrome.storage.sync.get({ pm_model: 'base', pm_multilingual: true }, function (items) {
      if (chrome.runtime.lastError) return;
      chrome.runtime
        .sendMessage({ type: 'pm-config', tabId: tabId, videoId: videoId, model: items.pm_model, multilingual: items.pm_multilingual })
        .catch(function () {});
    });
  } catch (e) {}
}

chrome.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'pm-content') return;
  var tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
  if (tabId == null) return;
  portsByTabId.set(tabId, port);
  console.log('[PM-BG] content port connected, tabId=' + tabId);

  ensureOffscreenDocument();

  port.onMessage.addListener(function (msg) {
    if (!msg || !msg.type) return;
    if (msg.videoId) videoIdByTabId.set(tabId, msg.videoId); // see resendModelConfigToAllTabs()
    if (msg.type === 'reset') {
      chrome.runtime.sendMessage({ type: 'pm-reset', tabId: tabId, videoId: msg.videoId }).catch(function () {});
      ensureOffscreenDocument().then(function () {
        sendModelConfig(tabId, msg.videoId);
      });
    } else if (msg.type === 'restart') {
      console.warn('[PM] [PM-STALL] restart requested by content.js, tabId=' + tabId + ' videoId=' + msg.videoId);
      ensureOffscreenDocument().then(function () {
        chrome.runtime.sendMessage({ type: 'pm-restart', tabId: tabId, videoId: msg.videoId }).catch(function () {});
      });
    } else if (msg.type === 'seek') {
      // Seek preemption (0.1.18): bump this session's generation counter in
      // offscreen so any in-flight/queued work for the OLD playhead region
      // gets its result discarded (or stops picking further old-region
      // windows) rather than blocking the new position behind a backlog.
      // Session/coverage state itself is untouched.
      ensureOffscreenDocument().then(function () {
        chrome.runtime.sendMessage({ type: 'pm-seek', tabId: tabId, videoId: msg.videoId, currentTime: msg.currentTime }).catch(function () {});
      });
    } else if (msg.type === 'resync') {
      // content.js just (re)connected its port (fresh page load, or
      // recovering from a port drop) — ask offscreen to resend everything it
      // holds for this session so nothing computed while disconnected is lost.
      ensureOffscreenDocument().then(function () {
        chrome.runtime.sendMessage({ type: 'pm-resync', tabId: tabId, videoId: msg.videoId }).catch(function () {});
      });
    } else if (msg.type === 'segment') {
      chrome.runtime
        .sendMessage({
          type: 'pm-segment',
          tabId: tabId,
          videoId: msg.videoId,
          mime: msg.mime,
          isInit: msg.isInit,
          segIndex: msg.segIndex,
          currentTime: msg.currentTime,
          duration: msg.duration,
          localTimeSec: msg.localTimeSec,
          growthAbsStart: msg.growthAbsStart,
          growthAbsEnd: msg.growthAbsEnd,
          growthIsNewRange: msg.growthIsNewRange,
          wallTime: msg.wallTime,
          dataB64: msg.dataB64
        })
        .catch(function (e) {
          // Offscreen doc may have been reclaimed; recreate and drop this
          // one segment (the next appendBuffer will retry on a fresh doc).
          console.error('[PM-BG] failed to forward segment to offscreen, recreating doc', e);
          ensureOffscreenDocument();
        });
    } else if (msg.type === 'disable' || msg.type === 'enable') {
      // pm_enabled=false (0.1.13): idle the session's transcription CPU
      // entirely rather than just having content.js stop acting on results
      // — offscreen keeps running the model-warm-up/model-cache machinery
      // (cheap, no per-window work), it just stops picking new windows.
      ensureOffscreenDocument().then(function () {
        chrome.runtime.sendMessage({ type: 'pm-' + msg.type, tabId: tabId, videoId: msg.videoId }).catch(function () {});
      });
    }
  });

  port.onDisconnect.addListener(function () {
    // Only delete if the map still holds THIS exact port (0.1.15 fix): a
    // reconnect race (old port's onDisconnect firing AFTER a new port for
    // the same tabId has already been onConnect'd and stored) could
    // otherwise delete the NEWER, live port's map entry out from under it.
    if (portsByTabId.get(tabId) === port) portsByTabId.delete(tabId);
    console.log('[PM-BG] content port disconnected, tabId=' + tabId);
  });
});

// Memory leak fix (0.1.15): closing a YouTube tab previously left its
// offscreen session (bytes, runs, coverage, word history) resident forever
// — nothing ever told offscreen the tab was gone. No need to spin up a
// fresh offscreen doc just to tell it this; if none exists there's nothing
// to clean up either.
chrome.tabs.onRemoved.addListener(function (tabId) {
  portsByTabId.delete(tabId);
  videoIdByTabId.delete(tabId);
  chrome.runtime.sendMessage({ type: 'pm-tab-closed', tabId: tabId }).catch(function () {});
});

// Results/logs come back from the offscreen doc via sendMessage (offscreen
// docs cannot open runtime.connect ports to other extension contexts) and get
// routed to the right tab's port by tabId.
chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'pm-words-result') {
    var port = portsByTabId.get(msg.tabId);
    if (port) {
      try {
        port.postMessage({
          type: 'words',
          videoId: msg.videoId,
          words: msg.words,
          windowStartS: msg.windowStartS,
          windowEndS: msg.windowEndS,
          wallMs: msg.wallMs,
          rtf: msg.rtf,
          modelRtf: msg.modelRtf,
          decodeMs: msg.decodeMs,
          queueMs: msg.queueMs,
          computeMs: msg.computeMs,
          language: msg.language, // 0.1.25
          model: msg.model
        });
      } catch (e) {
        console.warn('[PM-BG] failed to relay words to content.js (port likely stale):', String(e));
      }
    }
    console.log(
      '[PM] window start=' + msg.windowStartS.toFixed(2) + ' end=' + msg.windowEndS.toFixed(2) +
        ' model=' + (msg.model || 'NA') + // 0.1.25 -- RTF telemetry per model: filter this log by `model=` to see per-model rtf/modelRtf
        ' wallMs=' + Math.round(msg.wallMs) + ' words=' + msg.words.length +
        ' decodeMs=' + (msg.decodeMs != null ? Math.round(msg.decodeMs) : 'NA') +
        ' queueMs=' + (msg.queueMs != null ? Math.round(msg.queueMs) : 'NA') +
        ' computeMs=' + (msg.computeMs != null ? Math.round(msg.computeMs) : 'NA') +
        ' rtf=' + (msg.rtf != null ? msg.rtf.toFixed(3) : 'NA') +
        ' modelRtf=' + (msg.modelRtf != null ? msg.modelRtf.toFixed(3) : 'NA') +
        ' lagMs=' + Math.round(msg.lagMs) +
        ' text=[' + msg.words.map(function (w) { return w.word; }).join(' ') + ']'
    );
  } else if (msg.type === 'pm-heartbeat') {
    var hbPort = portsByTabId.get(msg.tabId);
    if (hbPort) {
      try {
        hbPort.postMessage({ type: 'heartbeat', videoId: msg.videoId });
      } catch (e) {
        /* stale port; next heartbeat or coverage growth will resolve it */
      }
    }
  } else if (msg.type === 'pm-diag') {
    // Tab-visible diagnostics: anything offscreen determined could block
    // coverage indefinitely (a skipped window, a demux error, a stall) —
    // routed to the tab's own console so it's never silently invisible.
    var diagPort = portsByTabId.get(msg.tabId);
    if (diagPort) {
      try {
        diagPort.postMessage({ type: 'diag', videoId: msg.videoId, text: msg.text });
      } catch (e) {
        /* stale port; not critical, offscreen's own console still has it */
      }
    }
  } else if (msg.type === 'pm-unanalyzable') {
    // DRM/undecodable content (0.1.15): offscreen gave up transcribing this
    // video entirely — relay to content.js so it can release safe-mode
    // muting and show a player notice, rather than leaving a rented/
    // protected video permanently muted with no way to actually analyze it.
    var uaPort = portsByTabId.get(msg.tabId);
    if (uaPort) {
      try {
        uaPort.postMessage({ type: 'unanalyzable', videoId: msg.videoId });
      } catch (e) {
        console.warn('[PM-BG] failed to relay unanalyzable:', String(e));
      }
    }
  } else if (msg.type === 'pm-resync-result') {
    var syncPort = portsByTabId.get(msg.tabId);
    if (syncPort) {
      try {
        syncPort.postMessage({ type: 'resync-result', videoId: msg.videoId, words: msg.words, coveredIntervals: msg.coveredIntervals, language: msg.language });
      } catch (e) {
        console.warn('[PM-BG] failed to relay resync-result:', String(e));
      }
    }
    console.log('[PM-BG] resync-result relayed:', (msg.words || []).length, 'words,', (msg.coveredIntervals || []).length, 'covered intervals');
  } else if (msg.type === 'pm-language') {
    // 0.1.25: sent once, right when detection resolves — a snappier-UI
    // nice-to-have on top of the language field already carried on every
    // 'words'/'resync-result' message (that's the authoritative source;
    // this is not relied upon alone, since ordering between two separate
    // sendMessage calls isn't guaranteed — see PIPELINE_NOTES "0.1.23"'s
    // ordering caveat).
    var langPort = portsByTabId.get(msg.tabId);
    if (langPort) {
      try {
        langPort.postMessage({ type: 'language', videoId: msg.videoId, language: msg.language });
      } catch (e) {
        /* not critical -- the next words/resync message carries it too */
      }
    }
  } else if (msg.type === 'pm-log') {
    console.log('[PM-OFFSCREEN]', msg.text);
  }
});
