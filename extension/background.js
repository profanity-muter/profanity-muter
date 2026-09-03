// background.js - MV3 service worker. Owns the offscreen document (Whisper +
// demux run there, see spike-whisper/SPIKE_NOTES.md - inference does not work
// reliably in a service worker) and routes segment bytes / transcript results
// between each tab's content.js port and the single shared offscreen doc.
//
// The service worker itself is expendable: MV3 idles it after ~30s and Chrome
// respawns it on the next event (onConnect/onMessage). Session state that
// must survive a respawn (accumulated audio bytes, coverage, dedupe) lives in
// the offscreen document, not here - this file only routes and can be torn
// down and rebuilt freely.
'use strict';

// shared/moments.js is a plain script attaching globalThis.PMMoments;
// importScripts is how an MV3 service worker loads one. Used for the badge
// and milestone decisions so the SW and the popup cannot disagree about
// what "eligible" means (0.1.33).
try {
  importScripts('shared/moments.js', 'shared/pill.js');
} catch (e) {
  console.warn('[PM-BG] could not load shared/moments.js:', String(e));
}

var portsByTabId = new Map(); // tabId -> chrome.runtime.Port
var videoIdByTabId = new Map(); // tabId -> last known videoId (0.1.15: needed to re-push pm-config on offscreen respawn without waiting for a video change)
var creatingOffscreen = null;

// Any error in this file must not stay invisible in the SW's own
// (user-inaccessible) console - broadcast to every connected tab so it
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
      // A genuinely FRESH offscreen document was just created - any prior
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
// there before recreating - guarantees a fresh one running the CURRENT
// code, rather than possibly reusing an old one still running pre-reload
// logic (best-effort; closeDocument() throwing "no such document" is fine).
chrome.runtime.onInstalled.addListener(function () {
  chrome.offscreen
    .closeDocument()
    .catch(function () {})
    .then(ensureOffscreenDocument);
});

// ---- first-run onboarding + install date (0.1.30) --------------------------
//
// A SECOND onInstalled listener rather than more code inside the one above:
// that one is about the offscreen document's lifecycle and nothing else, and
// these two concerns share no state. Chrome runs both.
//
// Two jobs, in this order of importance:
//
//  1. pm_installedAt - stamped once, and only if absent. It gates the review
//     prompt's "installed >= 7 days" rule (see shared/moments.js). Written on
//     UPDATE too, not just install, so the ~zero existing 0.1.29 installs get
//     a date at all; the plain consequence is that they wait 7 days from the
//     update rather than from their real install, which is the conservative
//     direction (see moments.js's NOTE ON BACKFILL).
//
//  2. The onboarding tab, opened exactly once, on a genuine `install` only.
//     Never on `update`: an update the user did not ask for is the worst
//     imaginable moment to seize a tab, and doing it would also re-open for
//     everyone on every release. pm_onboarded is set BEFORE the tab is
//     created, so a failure to open can't leave the flag unset and re-trigger
//     on the next install event.
//
// Deliberately no `chrome.tabs` permission is needed or requested:
// chrome.tabs.create is available to every extension; only READING tab
// url/title requires the permission, and this reads nothing.
chrome.runtime.onInstalled.addListener(function (details) {
  var reason = details && details.reason;
  try {
    chrome.storage.sync.get(['pm_installedAt', 'pm_onboarded'], function (items) {
      if (chrome.runtime.lastError) return;
      items = items || {};

      if (typeof items.pm_installedAt !== 'number') {
        chrome.storage.sync.set({ pm_installedAt: Date.now() });
      }

      // Mirrors PMMoments.shouldAutoOpenOnboarding (shared/moments.js),
      // which is the unit-tested statement of this rule. The service
      // worker deliberately does not import that module: it is a two-term
      // boolean, and adding a shared script to the SW's load path to
      // avoid restating it would cost more than it saves. If this rule
      // ever grows a third term, move it here properly.
      if (reason === 'install' && items.pm_onboarded !== true) {
        chrome.storage.sync.set({ pm_onboarded: true }, function () {
          try {
            chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
          } catch (e) {
            console.warn('[PM-BG] could not open onboarding tab:', String(e));
          }
        });
      }
    });
  } catch (e) {
    console.warn('[PM-BG] onInstalled onboarding/install-date step failed:', String(e));
  }
});
ensureOffscreenDocument();
chrome.runtime.onStartup.addListener(ensureOffscreenDocument);


// ---- toolbar badge + milestone (0.1.33) ------------------------------------
//
// The only surface this extension owns that a user sees without opening
// anything, and it needs no permission. See shared/moments.js badgeDecision
// for the priority rule: health outranks the review nudge always, and
// documented limits (livestream, Shorts) never badge at all.
//
// Health is PER TAB, so it uses setBadgeText's tabId form: a broken filter in
// one tab must not mark every other tab. The review nudge is global, being a
// property of the install rather than of any page.
var unhealthyTabs = new Set();
var reviewNudgeActive = false;

function moments() {
  return typeof PMMoments !== 'undefined' ? PMMoments : null;
}

function applyTabBadge(tabId, healthStatus) {
  var m = moments();
  if (!m || tabId == null) return;
  var decision = m.badgeDecision({ healthStatus: healthStatus });
  try {
    chrome.action.setBadgeText({ tabId: tabId, text: decision.text });
    if (decision.color) {
      chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: decision.color });
    }
  } catch (e) {
    // A tab closed between the message and this call throws; harmless.
  }
}

function applyGlobalBadge() {
  var m = moments();
  if (!m) return;
  var decision = m.badgeDecision({ reviewEligible: reviewNudgeActive });
  try {
    chrome.action.setBadgeText({ text: decision.text });
    if (decision.color) chrome.action.setBadgeBackgroundColor({ color: decision.color });
  } catch (e) {}
}

// Read what the review gate needs and decide. Cheap, and only called on a
// stats/settings change or the daily alarm, never in a loop.
function refreshReviewNudge(cb) {
  var m = moments();
  if (!m) return;
  chrome.storage.sync.get(
    ['pm_ackNotPerfect', 'pm_installedAt', 'pm_reviewPrompt', 'pm_milestoneShown'],
    function (syncItems) {
      if (chrome.runtime.lastError) return;
      chrome.storage.local.get(['pm_stats'], function (localItems) {
        if (chrome.runtime.lastError) return;
        var stats = (localItems && localItems.pm_stats) || {};
        var verdict = m.reviewPromptEligibility({
          stats: stats,
          installedAt: syncItems && syncItems.pm_installedAt,
          ack: syncItems && syncItems.pm_ackNotPerfect,
          reviewPrompt: syncItems && syncItems.pm_reviewPrompt,
          now: Date.now()
        });
        reviewNudgeActive = verdict.eligible;
        applyGlobalBadge();
        if (cb) cb(verdict, syncItems || {}, stats);
      });
    }
  );
}

// Recompute when the inputs actually change rather than polling: pm_stats is
// written by content.js as it mutes, and the sync keys change when the popup
// or onboarding writes them.
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.pm_stats) refreshReviewNudge();
  if (area === 'sync' && (changes.pm_reviewPrompt || changes.pm_ackNotPerfect || changes.pm_installedAt)) {
    refreshReviewNudge();
  }
});

// A slow safety net for the one input that changes with no event at all: the
// 7-day install age. Twice a day is plenty for a gate measured in days.
try {
  chrome.alarms.create('pm-review-check', { periodInMinutes: 60 * 12 });
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm && alarm.name === 'pm-review-check') refreshReviewNudge();
  });
} catch (e) {
  // No alarms permission: the storage listener above still covers the common
  // cases, so this degrades rather than breaks.
}

chrome.tabs.onRemoved.addListener(function (tabId) {
  unhealthyTabs.delete(tabId);
});

refreshReviewNudge();

// 0.1.37: every rung reports its outcome back to the tab that asked, so a
// field log distinguishes "the user opened settings three times" from "the
// button did nothing three times". The first field log could not tell those
// apart and cost a round of speculation; the ladder itself turned out to be
// working fine.
function reportUiOutcome(tabId, outcome, detail) {
  if (tabId == null) return;
  var port = portsByTabId.get(tabId);
  if (!port) return;
  try {
    port.postMessage({ type: 'open-ui-outcome', outcome: outcome, detail: detail || '' });
  } catch (e) {}
}

function openExtensionUi(plan, index, tabId) {
  if (!plan || index >= plan.length) {
    reportUiOutcome(tabId, 'exhausted', 'no rung could open the UI');
    return;
  }
  var step = plan[index];
  var next = function (why) {
    reportUiOutcome(tabId, 'rung-failed', step + ': ' + (why || 'unavailable'));
    openExtensionUi(plan, index + 1, tabId);
  };

  if (step === 'action-popup') {
    try {
      var p = chrome.action.openPopup();
      if (p && typeof p.then === 'function') {
        p.then(
          function () { reportUiOutcome(tabId, 'opened-popup', 'chrome.action.openPopup'); },
          function (e) { next(String(e && e.message ? e.message : e)); }
        );
      } else {
        next('no promise returned (unsupported build)');
      }
    } catch (e) {
      next(String(e && e.message ? e.message : e));
    }
    return;
  }
  var url = step === 'popup-tab' ? 'popup/popup.html' : 'onboarding/onboarding.html';
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL(url) }, function () {
      if (chrome.runtime.lastError) next(chrome.runtime.lastError.message);
      else reportUiOutcome(tabId, 'opened-tab', url);
    });
  } catch (e) {
    next(String(e && e.message ? e.message : e));
  }
}

function sendModelConfig(tabId, videoId) {
  try {
    // pm_model read once per video reset, not reactively mid-video (a
    // mid-video change takes effect on the NEXT video).
    chrome.storage.sync.get({ pm_model: 'base' }, function (items) {
      if (chrome.runtime.lastError) return;
      chrome.runtime
        .sendMessage({ type: 'pm-config', tabId: tabId, videoId: videoId, model: items.pm_model })
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
      // recovering from a port drop) - ask offscreen to resend everything it
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
      // - offscreen keeps running the model-warm-up/model-cache machinery
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
// - nothing ever told offscreen the tab was gone. No need to spin up a
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
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  // Health transitions from a tab's content script (0.1.33). Only genuinely
  // broken statuses reach the badge; badgeDecision enforces that.
  if (msg.type === 'pm-health') {
    var healthTabId = sender && sender.tab ? sender.tab.id : null;
    if (healthTabId != null) {
      if (msg.status === 'unhealthy') unhealthyTabs.add(healthTabId);
      else unhealthyTabs.delete(healthTabId);
      applyTabBadge(healthTabId, msg.status);
    }
    return;
  }
  // A content script asking whether to show the one-shot milestone pill. The
  // SW owns the decision because it is the only context that sees both the
  // stats and the latch without the popup being open.
  // The on-player badge asking for the extension UI (0.1.36 addendum).
  //
  // chrome.action.openPopup() is the real thing, opening the actual toolbar
  // popup, but it requires a user gesture and has shipped and unshipped
  // across Chrome versions, so it is ATTEMPTED rather than relied on. The
  // popup page renders fine in a tab (a fixed 320px column reads as a
  // narrow panel rather than breaking), so that is the fallback, with the
  // setup guide as the last resort. The ladder itself is
  // PMMoments-adjacent pure logic in shared/pill.js so its ordering is
  // testable; this is just the execution.
  if (msg.type === 'pm-open-ui') {
    var plan = typeof PMPill !== 'undefined' && PMPill.openUiPlan
      ? PMPill.openUiPlan({})
      : ['action-popup', 'popup-tab', 'onboarding-tab'];
    openExtensionUi(plan, 0, sender && sender.tab ? sender.tab.id : null);
    return;
  }
  if (msg.type === 'pm-milestone-check') {
    var m0 = moments();
    if (!m0) return;
    refreshReviewNudge(function (verdict, syncItems, stats) {
      var show = m0.shouldShowMilestone({
        eligible: verdict.eligible,
        milestoneRecord: syncItems.pm_milestoneShown,
        showStatus: msg.showStatus !== false
      });
      if (!show) {
        sendResponse({ show: false });
        return;
      }
      // Stamp the latch as it is handed out, so two tabs asking at once
      // cannot both show it.
      chrome.storage.sync.set(
        { pm_milestoneShown: m0.makeMilestoneRecord(Date.now()) },
        function () { sendResponse({ show: true, text: m0.milestoneText(stats) }); }
      );
    });
    return true; // async response
  }
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
  } else if (msg.type === 'pm-preempt-decision') {
    // 0.1.42: every preemption decision, including the ones that declined
    // to act, so a paste shows the wager and not just its outcome.
    var preemptPort = portsByTabId.get(msg.tabId);
    if (preemptPort) {
      try {
        preemptPort.postMessage({
          type: 'preempt-decision',
          action: msg.action,
          reason: msg.reason,
          remainingMs: msg.remainingMs,
          costMs: msg.costMs,
          actualCostMs: msg.actualCostMs
        });
      } catch (e) {}
    }
  } else if (msg.type === 'pm-request-run-rebuild' || msg.type === 'pm-run-topology') {
    // 0.1.41: run-topology traffic between offscreen and the tab. The
    // rebuild request travels to content.js, which is the only context that
    // can reach capture.js in the MAIN world where the cached init bytes
    // live; topology events travel the same way so they reach the devlog.
    var runPort = portsByTabId.get(msg.tabId);
    if (runPort) {
      try {
        runPort.postMessage({
          type: msg.type === 'pm-request-run-rebuild' ? 'request-run-rebuild' : 'run-topology',
          videoId: msg.videoId,
          atS: msg.atS,
          event: msg.event,
          reason: msg.reason,
          spanStart: msg.spanStart,
          spanEnd: msg.spanEnd
        });
      } catch (e) {}
    }
  } else if (msg.type === 'pm-diag') {
    // Tab-visible diagnostics: anything offscreen determined could block
    // coverage indefinitely (a skipped window, a demux error, a stall) -
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
    // video entirely - relay to content.js so it can release safe-mode
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
        syncPort.postMessage({ type: 'resync-result', videoId: msg.videoId, words: msg.words, coveredIntervals: msg.coveredIntervals });
      } catch (e) {
        console.warn('[PM-BG] failed to relay resync-result:', String(e));
      }
    }
    console.log('[PM-BG] resync-result relayed:', (msg.words || []).length, 'words,', (msg.coveredIntervals || []).length, 'covered intervals');
  } else if (msg.type === 'pm-log') {
    console.log('[PM-OFFSCREEN]', msg.text);
  }
});
