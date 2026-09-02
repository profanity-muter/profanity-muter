// captions.js
// Isolated-world content script, document_start. Loaded AFTER
// shared/wordlist.js and shared/devlog.js (per manifest content_scripts
// order, owned by the other agent), so globalThis.PMWordlist and
// globalThis.PMDevlog are expected to exist by the time this runs.
// Everything is still guarded in case they don't.
//
// Responsibility: censor profanity in YouTube's caption DOM.
//   - Player captions:      .ytp-caption-segment (and its text nodes)
//   - Transcript panel:     ytd-transcript-segment-renderer (when open)
//
// Design notes:
//   - MutationObserver watches document.body for added/changed caption
//     nodes and re-censors on every mutation, since YouTube re-renders
//     caption segments constantly during playback.
//   - To avoid fighting our own writes (infinite observer loop), we
//     compare the node's current text against what censoring it would
//     produce, and only write when it actually changes. We also mark
//     nodes we've already censored via a WeakSet keyed by the exact
//     text we wrote, so a mutation caused by our own textContent
//     assignment is a no-op on the next observer callback.

(function () {
  "use strict";

  var PLAYER_SEGMENT_SELECTOR = ".ytp-caption-segment";
  var TRANSCRIPT_SEGMENT_SELECTOR = "ytd-transcript-segment-renderer";
  // The transcript renderer's visible text lives in this child, per
  // YouTube's current DOM; fall back to the renderer itself if absent.
  var TRANSCRIPT_TEXT_SELECTOR = "#segment-text, .segment-text, yt-formatted-string";

  var lastWrittenText = new WeakMap(); // node -> text we last wrote to it

  function getWordlist() {
    return (typeof globalThis !== "undefined" && globalThis.PMWordlist) || null;
  }

  function isEnabled() {
    var pm = getWordlist();
    if (!pm) return false;
    // PMWordlist internally gates on pm_enabled already (censorText is a
    // no-op passthrough when disabled), but we also short-circuit here
    // to avoid pointless DOM churn/work when the extension - or
    // specifically caption censoring (pm_censorCaptions) - is off.
    // pm_censorCaptions lets a user mute audio while leaving captions
    // showing the real words, e.g. to verify audio muting against what
    // was actually said.
    var settings = pm.settings || pm._state;
    if (!settings) return true;
    return settings.enabled !== false && settings.censorCaptions !== false;
  }

  // Censor a single element's text content in place, skipping writes
  // that would be no-ops or that echo what we just wrote ourselves.
  function censorElement(el) {
    if (!el || !isEnabled()) return;
    var pm = getWordlist();
    if (!pm) return;

    var current = el.textContent;
    if (current == null || current === "") return;

    // If this is exactly the text we wrote last time, nothing to do -
    // this mutation was caused by our own previous write (or is a
    // duplicate render of already-censored text).
    if (lastWrittenText.get(el) === current) return;

    var censored = pm.censorText(current);
    if (censored === current) return;

    lastWrittenText.set(el, censored);
    el.textContent = censored;
    logCensorEvent(current, censored);
  }

  // Persistent dev log (shared/devlog.js, loaded before this file per the
  // manifest's content_scripts order - still guarded, since a broken
  // diagnostic must never stop captions being censored). Only reached on a
  // write that actually changed something, so the log records real censor
  // events rather than every no-op observer pass.
  //
  // The BEFORE and AFTER text are handed over whole; devlog.js reduces
  // them to just the words that changed (PMDevlogCore.diffCensored) and
  // stores nothing else - persisting whole caption segments would amount
  // to keeping a transcript of every video watched, which is exactly what
  // the pm_devlogVerbose flag exists to gate for the audio side.
  function logCensorEvent(original, censored) {
    var d = (typeof globalThis !== "undefined" && globalThis.PMDevlog) || null;
    if (!d || typeof d.logCaptionCensor !== "function") return;
    try {
      d.logCaptionCensor(original, censored);
    } catch (e) {
      // ignore - diagnostics must never break caption censoring
    }
  }

  function censorPlayerCaptions(root) {
    var scope = root || document;
    var segments = scope.querySelectorAll
      ? scope.querySelectorAll(PLAYER_SEGMENT_SELECTOR)
      : [];
    for (var i = 0; i < segments.length; i++) {
      censorElement(segments[i]);
    }
    // The mutation target itself may be the segment.
    if (scope.matches && scope.matches(PLAYER_SEGMENT_SELECTOR)) {
      censorElement(scope);
    }
  }

  function censorTranscriptPanel(root) {
    var scope = root || document;
    var rows = scope.querySelectorAll
      ? scope.querySelectorAll(TRANSCRIPT_SEGMENT_SELECTOR)
      : [];
    for (var i = 0; i < rows.length; i++) {
      var textEl = rows[i].querySelector(TRANSCRIPT_TEXT_SELECTOR) || rows[i];
      censorElement(textEl);
    }
  }

  function censorAll(root) {
    censorPlayerCaptions(root);
    censorTranscriptPanel(root);
  }

  var scheduled = false;
  function scheduleCensor(root) {
    // Coalesce bursts of mutations into a single pass per frame.
    if (scheduled) return;
    scheduled = true;
    var target = root;
    requestAnimationFrame(function () {
      scheduled = false;
      censorAll(target);
    });
  }

  function startObserver() {
    if (!document.body) {
      // document_start: body may not exist yet.
      document.addEventListener("DOMContentLoaded", startObserver, { once: true });
      return;
    }

    var observer = new MutationObserver(function (mutations) {
      if (!isEnabled()) return;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === "characterData") {
          var parent = m.target.parentElement;
          if (parent) scheduleCensor(parent);
        } else if (m.type === "childList") {
          scheduleCensor(document);
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Initial pass in case captions are already present.
    scheduleCensor(document);
  }

  // Refresh censoring shortly after the wordlist/settings change, so a
  // toggle in the popup (pm_enabled/pm_wordlist/pm_safeMode) is
  // reflected on already-rendered captions without a page reload.
  if (
    typeof chrome !== "undefined" &&
    chrome &&
    chrome.storage &&
    chrome.storage.onChanged &&
    typeof chrome.storage.onChanged.addListener === "function"
  ) {
    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== "sync") return;
        if (
          changes.pm_enabled ||
          changes.pm_wordlist ||
          changes.pm_safeMode ||
          changes.pm_censorCaptions
        ) {
          // Clear the write-cache so previously-censored (or now stale)
          // nodes get re-evaluated against the new settings.
          lastWrittenText = new WeakMap();
          scheduleCensor(document);
        }
      });
    } catch (e) {
      // ignore
    }
  }

  startObserver();
})();
