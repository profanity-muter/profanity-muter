// shared/report.js
// Plain script (NOT an ES module), loaded by report/report.html and
// require()d by test/report_test.js. Defines globalThis.PMReport.
//
// WHAT THIS IS FOR
// ----------------
// "Report a problem", aimed squarely at the non-technical user: a parent
// or a friend who says "it didn't mute the swearing in this video" and
// has no idea what a console is. Before this existed, the only diagnostic
// path was the popup's "Copy debug log" button, which produces a wall of
// JSON with no context: no description of what actually went wrong, no
// video, no extension version, and no clue what to do with it next.
//
// This module assembles the whole thing into one object and one mail
// draft. It is pure - no chrome.*, no DOM, no clock (the caller passes
// `now`) - so every branch that matters (consent honoured, truncation,
// mailto shape) is unit-testable without a browser.
//
// WHY CLIPBOARD + PASTE, AND NOT AN ATTACHMENT
// --------------------------------------------
// mailto: cannot attach files at all, and its body is carried in a URL:
// browsers and mail clients enforce their own limits (commonly a couple
// of thousand characters, sometimes less) and silently TRUNCATE past
// them. A debug log is tens to hundreds of kilobytes. So the report goes
// on the clipboard and the mail body carries only the user's own words
// plus an instruction to paste. That is a genuinely worse experience than
// an attachment and there is no way around it in an extension without
// running a server to receive uploads - which would mean sending users'
// data somewhere, which this extension does not do. The UI says all of
// this in plain words rather than pretending the paste step is normal.
//
// PRIVACY POSTURE
// ---------------
// The debug log is included ONLY on an explicit, visible checkbox, and
// the report records that decision either way (`debugLogIncluded`), so
// whoever reads it can tell "no log" from "log withheld". The log's own
// contents are already privacy-shaped by shared/devlog.js - matched words
// and timings, settings, never full transcripts unless the user
// deliberately turned on pm_devlogVerbose - and the UI says exactly that
// next to the checkbox rather than asking for blind consent.

(function (root) {
  "use strict";

  // Report envelope version. Bump if the SHAPE changes in a way a reader
  // parsing old reports would need to know about.
  var REPORT_VERSION = 1;

  // Above this serialized size, the log is trimmed to the most recent
  // videos (see truncateDevlog). ~200KB: a report is destined for the
  // clipboard and then a mail body a human has to paste, and beyond a few
  // hundred KB some clipboard/mail paths start failing in ways the user
  // experiences as "nothing happened". The devlog's own cap is ~256KB,
  // so this bites only on genuinely large logs.
  var MAX_LOG_BYTES = 200 * 1024;

  // How many videos survive truncation. Three, not one: "the problem
  // video" is often not the newest entry by the time someone gets around
  // to reporting it.
  var TRUNCATE_TO_VIDEOS = 3;

  var PASTE_INSTRUCTION =
    "The full diagnostic log is on your clipboard. If you can, paste it " +
    "below this line before sending - it helps, but the summary above is " +
    "usually enough.";

  // Hard ceiling for the whole mailto: URL (0.1.33). Mail clients and
  // browsers truncate long mailto URLs silently and at inconsistent
  // limits; staying well under the commonly cited ~2000 gives the draft a
  // realistic chance of arriving intact everywhere.
  var MAX_MAILTO_CHARS = 1800;

  // How many videos the embedded summary starts with before the budget
  // shrinks it. Newest first, so shrinking drops the oldest.
  var SUMMARY_MAX_VIDEOS = 5;

  function serializedSize(value) {
    try {
      return JSON.stringify(value).length;
    } catch (e) {
      return Infinity;
    }
  }

  // Trim a devlog to fit. Returns {devlog, truncated, videosIncluded,
  // originalVideos, originalBytes}. Never throws, and never returns
  // something unserializable - a log we can't measure is dropped
  // entirely rather than silently breaking the whole report.
  function truncateDevlog(devlog, maxBytes) {
    maxBytes = typeof maxBytes === "number" ? maxBytes : MAX_LOG_BYTES;
    var videos = devlog && Array.isArray(devlog.videos) ? devlog.videos : null;
    if (!videos) {
      return {
        devlog: null,
        truncated: false,
        videosIncluded: 0,
        originalVideos: 0,
        originalBytes: 0
      };
    }
    var originalBytes = serializedSize(devlog);
    if (originalBytes <= maxBytes) {
      return {
        devlog: devlog,
        truncated: false,
        videosIncluded: videos.length,
        originalVideos: videos.length,
        originalBytes: originalBytes
      };
    }
    // videos is oldest-first (shared/devlog.js), so the most recent ones
    // are the tail.
    var kept = videos.slice(Math.max(0, videos.length - TRUNCATE_TO_VIDEOS));
    var trimmed = { version: devlog.version, videos: kept };
    return {
      devlog: trimmed,
      truncated: true,
      videosIncluded: kept.length,
      originalVideos: videos.length,
      originalBytes: originalBytes
    };
  }

  // The human-readable note about what happened to the log. Always
  // present, and always says something - "why is there no log in here"
  // is otherwise the first question a reader has to ask the user, which
  // costs a whole round trip with someone who is already frustrated.
  function debugLogNote(includeLog, trim) {
    if (!includeLog) {
      return "The user chose not to include their debug log.";
    }
    if (!trim.devlog) {
      return "No debug log was available yet (nothing has been watched, or it was cleared).";
    }
    if (trim.truncated) {
      return (
        "Debug log TRUNCATED to the " +
        trim.videosIncluded +
        " most recent videos (of " +
        trim.originalVideos +
        ") because the full log was " +
        Math.round(trim.originalBytes / 1024) +
        "KB, over the " +
        Math.round(MAX_LOG_BYTES / 1024) +
        "KB report limit."
      );
    }
    return "Full debug log included (" + trim.videosIncluded + " video(s)).";
  }

  // Assemble the report object that goes on the clipboard.
  //
  // input: {extensionVersion, userAgent, whatHappened, videoUrl,
  //         includeLog, devlog, now, maxLogBytes}
  function buildReport(input) {
    input = input || {};
    var includeLog = input.includeLog !== false;
    var trim = truncateDevlog(
      includeLog ? input.devlog : null,
      input.maxLogBytes
    );
    return {
      // A `kind` field so a report pasted into an email is recognizable
      // for what it is without any surrounding context.
      kind: "profanity-muter-problem-report",
      reportVersion: REPORT_VERSION,
      extensionVersion: String(input.extensionVersion || "unknown"),
      userAgent: String(input.userAgent || "unknown"),
      createdAt: typeof input.now === "number" ? input.now : Date.now(),
      videoUrl: typeof input.videoUrl === "string" ? input.videoUrl : "",
      whatHappened: typeof input.whatHappened === "string" ? input.whatHappened : "",
      debugLogIncluded: includeLog && !!trim.devlog,
      debugLogTruncated: trim.truncated,
      debugLogNote: debugLogNote(includeLog, trim),
      // Null rather than omitted: an explicit "no log here" reads
      // unambiguously, an absent key reads like a bug in the reporter.
      debugLog: includeLog ? trim.devlog : null
    };
  }

  function reportToJson(report) {
    return JSON.stringify(report, null, 2);
  }

  // ---- Tier 1: the EMBEDDED summary (0.1.33) -----------------------------
  //
  // The single most important change in this release. The previous design
  // put the entire diagnostic payload on the clipboard and asked the user
  // to paste it into the mail draft. Most people will not: they hit send
  // on a near-empty email, and every one of those reports is
  // undiagnosable. Asking a frustrated non-technical user to perform a
  // clipboard ritual correctly, at the exact moment they are annoyed
  // enough to write in, was always going to fail most of the time.
  //
  // So the mail body now carries a compact summary that is enough to
  // triage on its own, and the clipboard log becomes a genuinely optional
  // bonus. Every report arrives actionable whether or not anyone pastes.
  //
  // PRIVACY TIER. Email bodies get forwarded, quoted, and sit in mailboxes
  // for years, so this tier is deliberately poorer than the clipboard
  // one: COUNTS ONLY. No transcripts, no matched words, no word-list
  // contents. A list of which profanity a specific child said or heard is
  // not something to put in an email, and it is never needed to diagnose a
  // pipeline that is not running. Video ids are included because they are
  // public identifiers and are what makes a report reproducible.
  function shortenUserAgent(ua) {
    if (typeof ua !== "string" || !ua) return "unknown browser";
    var browser = "unknown browser";
    var m = /(Edg|OPR|Chrome|Firefox|Safari)\/(\d+)/.exec(ua);
    if (m) {
      var name = {
        Edg: "Edge", OPR: "Opera", Chrome: "Chrome",
        Firefox: "Firefox", Safari: "Safari"
      }[m[1]];
      browser = name + " " + m[2];
    }
    var os = "unknown OS";
    if (ua.indexOf("Windows NT 10") !== -1) os = "Windows 10/11";
    else if (ua.indexOf("Windows") !== -1) os = "Windows";
    else if (ua.indexOf("Mac OS X") !== -1) os = "macOS";
    else if (ua.indexOf("CrOS") !== -1) os = "ChromeOS";
    else if (ua.indexOf("Android") !== -1) os = "Android";
    else if (ua.indexOf("Linux") !== -1) os = "Linux";
    return browser + " on " + os;
  }

  // One line describing how the extension was configured, taken from the
  // devlog entry's own settings snapshot (what was actually in force at
  // the time) rather than re-reading storage now. Counts only: the word
  // list's CONTENTS never appear, here or anywhere else user-facing.
  function settingsLine(settings) {
    if (!settings) return "settings: not recorded";
    var parts = [];
    parts.push("tier=" + (settings.strictness || "?"));
    parts.push("+own=" + (typeof settings.additionalWordCount === "number" ? settings.additionalWordCount : "?"));
    parts.push("catchup=" + (settings.catchupMode || "?"));
    parts.push("padding=" + (settings.padding || "?"));
    parts.push("mute=" + (settings.muteAudio === false ? "off" : "on"));
    parts.push("captions=" + (settings.censorCaptions === false ? "off" : "on"));
    if (settings.enabled === false) parts.push("ENABLED=off");
    return "settings: " + parts.join(" ");
  }

  function countIn(entry, field) {
    var n = 0;
    var windows = (entry && entry.windows) || [];
    for (var i = 0; i < windows.length; i++) {
      n += ((windows[i] && windows[i][field]) || []).length;
    }
    return n;
  }

  // The health story for one video, which is the first thing worth knowing
  // and the whole reason the 0.1.32 monitor exists. Reports the LAST
  // verdict plus how many times it changed, because "warned then cleared"
  // and "warned and stayed broken" are different bugs.
  function healthSummary(entry) {
    var health = (entry && entry.health) || [];
    if (!health.length) return "health=none";
    var last = health[health.length - 1];
    var text = "health=" + (last.status || "?") + (last.reason ? "/" + last.reason : "");
    if (health.length > 1) text += "(" + health.length + " changes)";
    return text;
  }

  function videoLine(entry) {
    return (
      "- " + (entry && entry.videoId ? entry.videoId : "unknown") +
      " " + healthSummary(entry) +
      " windows=" + (((entry && entry.windows) || []).length) +
      " matches=" + countIn(entry, "matches") +
      " mutes=" + countIn(entry, "muteIntervals") +
      " gaps=" + (((entry && entry.gaps) || []).length) +
      " errors=" + (((entry && entry.errors) || []).length)
    );
  }

  // Build the embedded summary. `maxVideos` is what the mailto budget
  // shrinks; videos are listed NEWEST FIRST and the oldest fall off, since
  // the problem being reported is almost always the most recent thing.
  function buildSummary(input) {
    input = input || {};
    var maxVideos = typeof input.maxVideos === "number" ? input.maxVideos : SUMMARY_MAX_VIDEOS;
    var devlog = input.devlog;
    var videos = devlog && Array.isArray(devlog.videos) ? devlog.videos.slice() : [];
    videos.reverse(); // newest first

    var lines = [];
    lines.push("--- diagnostic summary (auto-filled) ---");
    lines.push("v" + (input.extensionVersion || "unknown") + " | " + shortenUserAgent(input.userAgent));

    if (input.logWithheld === true) {
      // The consent checkbox governs per-video data in BOTH tiers, not
      // just the clipboard one. Saying so here is what keeps the checkbox
      // truthful: someone who declines must not find their viewing
      // activity summarized in the email anyway. Version, browser and
      // settings stay, since none of them describe what was watched.
      if (videos.length) lines.push(settingsLine(videos[0].settings));
      lines.push("video details withheld by user choice");
      return lines.join("\n");
    }
    if (!videos.length) {
      lines.push("no video activity recorded yet");
      return lines.join("\n");
    }

    lines.push(settingsLine(videos[0].settings));
    var shown = videos.slice(0, Math.max(0, maxVideos));
    lines.push("recent videos (newest first):");
    for (var i = 0; i < shown.length; i++) lines.push(videoLine(shown[i]));
    if (videos.length > shown.length) {
      lines.push("(" + (videos.length - shown.length) + " older video(s) omitted)");
    }
    return lines.join("\n");
  }

  // The mail draft: the user's own words first, then the embedded summary.
  // Shrinks the summary until the whole URL fits MAX_MAILTO_CHARS, dropping
  // the oldest videos first and, in the worst case, the video list
  // entirely. The user's text is never truncated: it is the part only they
  // can supply.
  function buildMailto(input) {
    input = input || {};
    var email = input.email || "";
    var version = input.extensionVersion || "unknown";
    var subject = "Profanity Muter problem report v" + version;
    var maxChars = typeof input.maxChars === "number" ? input.maxChars : MAX_MAILTO_CHARS;
    var maxVideos = typeof input.maxVideos === "number" ? input.maxVideos : SUMMARY_MAX_VIDEOS;

    var url = assemble(maxVideos);
    while (url.length > maxChars && maxVideos > 0) {
      maxVideos--;
      url = assemble(maxVideos);
    }
    return url;

    function assemble(videoCount) {
      var lines = [];
      lines.push(input.whatHappened ? String(input.whatHappened) : "(describe what happened here)");
      lines.push("");
      if (input.videoUrl) {
        lines.push("Video: " + input.videoUrl);
        lines.push("");
      }
      lines.push(
        buildSummary({
          extensionVersion: version,
          userAgent: input.userAgent,
          devlog: input.devlog,
          logWithheld: input.logWithheld === true,
          maxVideos: videoCount
        })
      );
      lines.push("");
      lines.push("----------------------------------------");
      lines.push(PASTE_INSTRUCTION);
      lines.push("----------------------------------------");
      lines.push("");
      return encodeUrl(lines.join("\n"));
    }

    function encodeUrl(body) {

      // The address is NOT percent-encoded: `mailto:name@example.com` is
      // the canonical form every client understands, whereas the escaped
      // `%40` version is technically legal but has a history of confusing
      // desktop mail handlers. Only the subject and body, which carry
      // arbitrary user text, get encoded.
      return (
        "mailto:" +
        email +
        "?subject=" +
        encodeURIComponent(subject) +
        "&body=" +
        encodeURIComponent(body)
      );
    }
  }

  // Best-effort watch URL for the newest devlog entry, used to prefill
  // the "which video" field so the user doesn't have to go and find it.
  // videoId is usually a YouTube `v` param, but content.js falls back to
  // a pathname for non-watch pages - anything that isn't a plain id is
  // left alone rather than glued into a URL that would be wrong.
  function latestVideoUrl(devlog) {
    if (!devlog || !Array.isArray(devlog.videos) || !devlog.videos.length) return "";
    var newest = devlog.videos[devlog.videos.length - 1];
    var id = newest && newest.videoId;
    if (typeof id !== "string" || !id) return "";
    if (!/^[A-Za-z0-9_-]{5,20}$/.test(id)) return "";
    return "https://www.youtube.com/watch?v=" + id;
  }

  var PMReportCore = {
    REPORT_VERSION: REPORT_VERSION,
    MAX_LOG_BYTES: MAX_LOG_BYTES,
    TRUNCATE_TO_VIDEOS: TRUNCATE_TO_VIDEOS,
    PASTE_INSTRUCTION: PASTE_INSTRUCTION,
    MAX_MAILTO_CHARS: MAX_MAILTO_CHARS,
    SUMMARY_MAX_VIDEOS: SUMMARY_MAX_VIDEOS,
    shortenUserAgent: shortenUserAgent,
    settingsLine: settingsLine,
    buildSummary: buildSummary,
    truncateDevlog: truncateDevlog,
    debugLogNote: debugLogNote,
    buildReport: buildReport,
    reportToJson: reportToJson,
    buildMailto: buildMailto,
    latestVideoUrl: latestVideoUrl,
    serializedSize: serializedSize
  };

  root.PMReport = PMReportCore;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMReportCore: PMReportCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
