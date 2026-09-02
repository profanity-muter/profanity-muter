// test/report_test.js
// Node unit tests for shared/report.js: report assembly, the debug-log
// consent flag, the size guard, and the mailto draft.
//
// Run with: node test/report_test.js   (or npm test, from extension/)
//
// The two branches worth guarding hardest are the ones a user can't see
// until it's too late: that declining to include the debug log ACTUALLY
// leaves it out (a privacy promise made in the UI, one boolean away from
// being a lie), and that an oversized log is trimmed rather than silently
// producing a report nobody can paste.

"use strict";

const assert = require("assert");
const path = require("path");
const { PMReportCore } = require(path.join(__dirname, "..", "shared", "report.js"));
const { PMMomentsCore } = require(path.join(__dirname, "..", "shared", "moments.js"));

const R = PMReportCore;
const NOW = 1_800_000_000_000;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error("FAIL: " + name);
    console.error("      " + (e && e.message ? e.message : String(e)));
  }
}

// A devlog of `count` videos, each padded to roughly `padBytes` so the
// size guard can be driven over its threshold deterministically.
function makeDevlog(count, padBytes) {
  const videos = [];
  for (let i = 0; i < count; i++) {
    videos.push({
      videoId: "vid" + i,
      title: "video " + i,
      startedAt: NOW - (count - i) * 1000,
      version: "0.1.31",
      settings: { enabled: true, strictness: "strict" },
      windows: padBytes
        ? [{ t0: 0, t1: 10, transcriptWordCount: 5, matches: [], muteIntervals: [], text: "x".repeat(padBytes) }]
        : [],
      gaps: [],
      captions: [],
      captionCount: 0,
      errors: [],
      truncated: false
    });
  }
  return { version: 1, videos: videos };
}

function build(over) {
  return R.buildReport(
    Object.assign(
      {
        extensionVersion: "0.1.31",
        userAgent: "Mozilla/5.0 (Test)",
        whatHappened: "it missed a word",
        videoUrl: "https://www.youtube.com/watch?v=abc123",
        includeLog: true,
        devlog: makeDevlog(2, 0),
        now: NOW
      },
      over || {}
    )
  );
}

// ---- report shape --------------------------------------------------------

test("buildReport produces the documented envelope", () => {
  const r = build();
  assert.strictEqual(r.kind, "profanity-muter-problem-report");
  assert.strictEqual(r.reportVersion, R.REPORT_VERSION);
  assert.strictEqual(r.extensionVersion, "0.1.31");
  assert.strictEqual(r.userAgent, "Mozilla/5.0 (Test)");
  assert.strictEqual(r.createdAt, NOW);
  assert.strictEqual(r.videoUrl, "https://www.youtube.com/watch?v=abc123");
  assert.strictEqual(r.whatHappened, "it missed a word");
  assert.strictEqual(r.debugLogIncluded, true);
  assert.strictEqual(r.debugLogTruncated, false);
  assert.ok(r.debugLog && r.debugLog.videos.length === 2);
  assert.ok(typeof r.debugLogNote === "string" && r.debugLogNote.length > 0);
});

test("buildReport tolerates missing everything", () => {
  const r = R.buildReport();
  assert.strictEqual(r.extensionVersion, "unknown");
  assert.strictEqual(r.userAgent, "unknown");
  assert.strictEqual(r.whatHappened, "");
  assert.strictEqual(r.videoUrl, "");
  assert.strictEqual(r.debugLogIncluded, false);
  assert.strictEqual(r.debugLog, null);
  assert.strictEqual(typeof r.createdAt, "number");
});

test("buildReport coerces junk field types rather than embedding them", () => {
  const r = build({ whatHappened: { evil: true }, videoUrl: 42 });
  assert.strictEqual(r.whatHappened, "");
  assert.strictEqual(r.videoUrl, "");
});

test("the report serializes to JSON cleanly", () => {
  const json = R.reportToJson(build());
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.kind, "profanity-muter-problem-report");
  assert.ok(json.indexOf("\n") !== -1, "pretty-printed so a human can read it in an email");
});

// ---- consent -------------------------------------------------------------

test("declining the debug log ACTUALLY leaves it out", () => {
  const r = build({ includeLog: false });
  assert.strictEqual(r.debugLog, null);
  assert.strictEqual(r.debugLogIncluded, false);
  // And nothing from the log leaks in by another route.
  assert.strictEqual(R.reportToJson(r).indexOf("vid0"), -1);
});

test("declining is recorded as a choice, not as an absence", () => {
  const r = build({ includeLog: false });
  assert.strictEqual(r.debugLogNote, "The user chose not to include their debug log.");
});

test("consent defaults to included when the flag is omitted", () => {
  // The checkbox ships checked; an undefined flag must mean the same, or
  // the UI and the assembly disagree about the default.
  const r = build({ includeLog: undefined });
  assert.strictEqual(r.debugLogIncluded, true);
  assert.ok(r.debugLog);
});

test("consenting with no log recorded yet is not reported as a refusal", () => {
  const r = build({ devlog: null });
  assert.strictEqual(r.debugLogIncluded, false, "there is genuinely no log");
  assert.ok(/No debug log was available/.test(r.debugLogNote), r.debugLogNote);
});

test("an empty-but-present devlog is included as-is", () => {
  const r = build({ devlog: { version: 1, videos: [] } });
  assert.strictEqual(r.debugLogTruncated, false);
  assert.ok(/Full debug log included \(0 video/.test(r.debugLogNote), r.debugLogNote);
});

// ---- size guard ----------------------------------------------------------

test("a log under the limit is included whole", () => {
  const devlog = makeDevlog(10, 100);
  assert.ok(R.serializedSize(devlog) < R.MAX_LOG_BYTES, "fixture must be under the cap");
  const t = R.truncateDevlog(devlog);
  assert.strictEqual(t.truncated, false);
  assert.strictEqual(t.videosIncluded, 10);
  assert.strictEqual(t.devlog, devlog);
});

test("an oversized log is trimmed to the 3 MOST RECENT videos", () => {
  const devlog = makeDevlog(10, 40 * 1024); // ~400KB, well over the cap
  assert.ok(R.serializedSize(devlog) > R.MAX_LOG_BYTES, "fixture must be over the cap");
  const t = R.truncateDevlog(devlog);
  assert.strictEqual(t.truncated, true);
  assert.strictEqual(t.videosIncluded, R.TRUNCATE_TO_VIDEOS);
  assert.strictEqual(t.originalVideos, 10);
  // videos are oldest-first, so the survivors are the tail.
  assert.deepStrictEqual(
    t.devlog.videos.map((v) => v.videoId),
    ["vid7", "vid8", "vid9"]
  );
  assert.strictEqual(t.devlog.version, 1, "the envelope's version survives");
});

test("truncation is disclosed in the report, with real numbers", () => {
  const r = build({ devlog: makeDevlog(10, 40 * 1024) });
  assert.strictEqual(r.debugLogTruncated, true);
  assert.strictEqual(r.debugLog.videos.length, 3);
  assert.ok(/TRUNCATED to the 3 most recent videos \(of 10\)/.test(r.debugLogNote), r.debugLogNote);
  assert.ok(/KB/.test(r.debugLogNote), "says how big it was");
});

test("the truncation threshold is honoured exactly at the boundary", () => {
  const under = { version: 1, videos: [{ videoId: "a", pad: "x".repeat(1000) }] };
  const overBytes = R.MAX_LOG_BYTES + 1000;
  const over = { version: 1, videos: [1, 2, 3, 4].map((i) => ({ videoId: "v" + i, pad: "x".repeat(overBytes / 4) })) };
  assert.strictEqual(R.truncateDevlog(under).truncated, false);
  assert.strictEqual(R.truncateDevlog(over).truncated, true);
});

test("a custom maxLogBytes is respected (so the UI can preview the same verdict)", () => {
  const devlog = makeDevlog(6, 100);
  assert.strictEqual(R.truncateDevlog(devlog, 10).truncated, true);
  assert.strictEqual(R.truncateDevlog(devlog, 10).videosIncluded, 3);
});

test("truncateDevlog never throws on junk", () => {
  [null, undefined, {}, { videos: "no" }, "nope", 7].forEach(function (v) {
    const t = R.truncateDevlog(v);
    assert.strictEqual(t.devlog, null);
    assert.strictEqual(t.truncated, false);
  });
});

test("serializedSize reports Infinity for a circular log rather than throwing", () => {
  const circular = { version: 1, videos: [] };
  circular.videos.push({ self: circular });
  assert.strictEqual(R.serializedSize(circular), Infinity);
  // ...and such a log is treated as oversized, so it gets trimmed rather
  // than producing an unserializable report.
  assert.strictEqual(R.truncateDevlog(circular).truncated, true);
});

// ---- mailto --------------------------------------------------------------

function mailto(over) {
  return R.buildMailto(
    Object.assign(
      {
        email: PMMomentsCore.SUPPORT_EMAIL,
        extensionVersion: "0.1.31",
        whatHappened: "it missed a word",
        videoUrl: "https://www.youtube.com/watch?v=abc123"
      },
      over || {}
    )
  );
}

function bodyOf(url) {
  return decodeURIComponent(url.split("&body=")[1] || "");
}

function subjectOf(url) {
  return decodeURIComponent((url.split("?subject=")[1] || "").split("&body=")[0]);
}

test("buildMailto addresses the support constant and versions the subject", () => {
  const url = mailto();
  // Canonical unescaped form, not mailto:support%40example.com.
  assert.ok(url.indexOf("mailto:" + PMMomentsCore.SUPPORT_EMAIL + "?") === 0, url);
  assert.strictEqual(subjectOf(url), "Profanity Muter problem report v0.1.31");
});

test("the mail body carries the user's words, the video and the version", () => {
  const body = bodyOf(mailto());
  assert.ok(body.indexOf("it missed a word") !== -1);
  assert.ok(body.indexOf("Video: https://www.youtube.com/watch?v=abc123") !== -1);
  // 0.1.33 moved the version into the embedded summary's header line.
  assert.ok(body.indexOf("v0.1.31") !== -1, body);
});

test("the mail body carries the paste instruction verbatim", () => {
  assert.ok(bodyOf(mailto()).indexOf(R.PASTE_INSTRUCTION) !== -1);
  assert.strictEqual(
    R.PASTE_INSTRUCTION,
    "The full diagnostic log is on your clipboard. If you can, paste it " +
      "below this line before sending - it helps, but the summary above is " +
      "usually enough."
  );
});

test("the mail body NEVER carries the raw debug log", () => {
  // The full JSON log still cannot travel in a mailto: body. What DOES
  // travel, as of 0.1.33, is the compact counts-only summary (covered
  // below); this asserts the raw log is still excluded.
  const url = mailto();
  assert.ok(url.indexOf("muteIntervals") === -1);
  assert.ok(url.indexOf("transcriptWordCount") === -1);
  assert.ok(url.length <= R.MAX_MAILTO_CHARS, "draft length " + url.length);
});

test("an empty description gets a placeholder rather than a blank email", () => {
  assert.ok(bodyOf(mailto({ whatHappened: "" })).indexOf("(describe what happened here)") !== -1);
});

test("no video line at all when the user cleared the field", () => {
  assert.strictEqual(bodyOf(mailto({ videoUrl: "" })).indexOf("Video:"), -1);
});

test("mailto is properly encoded (newlines and specials survive)", () => {
  const url = mailto({ whatHappened: "line one\nline two & more?" });
  assert.strictEqual(url.indexOf("\n"), -1, "raw newlines would break the URL");
  assert.ok(bodyOf(url).indexOf("line one\nline two & more?") !== -1);
});

// ---- video prefill -------------------------------------------------------

test("latestVideoUrl builds a watch URL from the NEWEST devlog entry", () => {
  const devlog = { version: 1, videos: [{ videoId: "oldvideo00" }, { videoId: "dQw4w9WgXcQ" }] };
  assert.strictEqual(R.latestVideoUrl(devlog), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
});

test("latestVideoUrl declines to guess for a non-id videoId", () => {
  // content.js falls back to a pathname for non-watch pages; gluing that
  // into a watch URL would produce a confidently wrong link.
  assert.strictEqual(R.latestVideoUrl({ version: 1, videos: [{ videoId: "/shorts/xyz" }] }), "");
  assert.strictEqual(R.latestVideoUrl({ version: 1, videos: [{ videoId: "" }] }), "");
  assert.strictEqual(R.latestVideoUrl({ version: 1, videos: [{}] }), "");
});

test("latestVideoUrl is empty for an absent or empty log", () => {
  assert.strictEqual(R.latestVideoUrl(null), "");
  assert.strictEqual(R.latestVideoUrl({ version: 1, videos: [] }), "");
  assert.strictEqual(R.latestVideoUrl("nope"), "");
});

// ---- Tier 1: the embedded summary (0.1.33) -------------------------------
//
// Why this tier exists: the previous design put everything on the
// clipboard and asked the user to paste. Most people will not, and every
// unpasted report was undiagnosable. These tests guard the two properties
// that make the new design work: the summary is genuinely informative,
// and it is genuinely small enough to survive a mailto.

function summaryVideo(id, opts) {
  opts = opts || {};
  const windows = [];
  for (let i = 0; i < (opts.windows || 0); i++) {
    windows.push({
      t0: i * 10,
      t1: i * 10 + 10,
      transcriptWordCount: 20,
      matches: opts.matchWord ? [{ word: opts.matchWord, t: i * 10 + 3 }] : [],
      muteIntervals: opts.matchWord ? [{ start: i * 10 + 2, end: i * 10 + 4 }] : [],
      text: opts.text || ""
    });
  }
  return {
    videoId: id,
    title: opts.title || "a video",
    settings: opts.settings || {
      enabled: true,
      strictness: "strict",
      additionalWordCount: 2,
      catchupMode: "play",
      padding: "normal",
      muteAudio: true,
      censorCaptions: true
    },
    windows: windows,
    gaps: opts.gaps || [],
    captions: [],
    captionCount: 0,
    errors: opts.errors || [],
    health: opts.health || []
  };
}

const UA_CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

test("shortenUserAgent reduces a UA string to browser and OS", () => {
  assert.strictEqual(R.shortenUserAgent(UA_CHROME_MAC), "Chrome 141 on macOS");
  assert.strictEqual(
    R.shortenUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0"),
    "Chrome 140 on Windows 10/11"
  );
  assert.strictEqual(R.shortenUserAgent(""), "unknown browser");
  assert.strictEqual(R.shortenUserAgent(null), "unknown browser");
});

test("the summary carries version, browser, settings and per-video counts", () => {
  const devlog = {
    version: 1,
    videos: [
      summaryVideo("older1", { windows: 2, matchWord: "damn" }),
      summaryVideo("newest", {
        windows: 3,
        matchWord: "damn",
        gaps: [{ start: 0, end: 5, mode: "play" }],
        errors: [{ t: 1, wall: 1, text: "boom" }],
        health: [{ status: "unhealthy", reason: "no-audio-intercepted" }]
      })
    ]
  };
  const text = R.buildSummary({ extensionVersion: "0.1.33", userAgent: UA_CHROME_MAC, devlog });
  assert.ok(text.indexOf("v0.1.33") !== -1, text);
  assert.ok(text.indexOf("Chrome 141 on macOS") !== -1, text);
  assert.ok(text.indexOf("tier=strict") !== -1, text);
  assert.ok(text.indexOf("catchup=play") !== -1, text);
  assert.ok(text.indexOf("+own=2") !== -1, text);
  assert.ok(text.indexOf("newest health=unhealthy/no-audio-intercepted") !== -1, text);
  assert.ok(/newest .*windows=3 matches=3 mutes=3 gaps=1 errors=1/.test(text), text);
});

test("the summary lists videos NEWEST FIRST", () => {
  const devlog = {
    version: 1,
    videos: [summaryVideo("oldest"), summaryVideo("middle"), summaryVideo("newest")]
  };
  const text = R.buildSummary({ devlog });
  const order = ["newest", "middle", "oldest"].map((id) => text.indexOf(id));
  assert.ok(order[0] < order[1] && order[1] < order[2], text);
});

test("PRIVACY: the summary never carries matched words or transcripts", () => {
  // Email bodies get forwarded and quoted and sit in mailboxes for years.
  // A list of which profanity a specific child said or heard has no place
  // in one, and is never needed to diagnose a pipeline that is not
  // running. Counts only.
  const devlog = {
    version: 1,
    videos: [
      summaryVideo("v1", {
        windows: 4,
        matchWord: "motherfucker",
        text: "the full transcript of everything that was said out loud"
      })
    ]
  };
  const text = R.buildSummary({ devlog });
  assert.strictEqual(text.indexOf("motherfucker"), -1, "no matched words");
  assert.strictEqual(text.indexOf("transcript of everything"), -1, "no transcripts");
  assert.ok(text.indexOf("matches=4") !== -1, "counts only: " + text);
});

test("PRIVACY: unticking consent withholds video details from the EMAIL too", () => {
  // The checkbox says "include my debug log". If declining still put a
  // per-video summary of someone's viewing in the mail body, that
  // checkbox would be a lie.
  const devlog = { version: 1, videos: [summaryVideo("secretvideo", { windows: 2 })] };
  const text = R.buildSummary({ devlog, logWithheld: true });
  assert.strictEqual(text.indexOf("secretvideo"), -1, text);
  assert.ok(text.indexOf("withheld by user choice") !== -1, text);
  // Version, browser and settings are not viewing activity, so they stay.
  assert.ok(text.indexOf("tier=strict") !== -1, text);
});

test("the summary says so plainly when there is no activity", () => {
  assert.ok(/no video activity recorded yet/.test(R.buildSummary({ devlog: null })));
  assert.ok(/no video activity recorded yet/.test(R.buildSummary({ devlog: { version: 1, videos: [] } })));
});

test("the summary caps the video list and says how many it dropped", () => {
  const videos = [];
  for (let i = 0; i < 9; i++) videos.push(summaryVideo("v" + i));
  const text = R.buildSummary({ devlog: { version: 1, videos } });
  assert.ok(/4 older video\(s\) omitted/.test(text), text);
  assert.ok(text.indexOf("v8") !== -1, "newest kept");
  assert.strictEqual(text.indexOf("v0"), -1, "oldest dropped");
});

test("health changes are surfaced, including a recovery", () => {
  const devlog = {
    version: 1,
    videos: [
      summaryVideo("v1", {
        health: [
          { status: "unhealthy", reason: "zero-windows-completed" },
          { status: "recovered", reason: "zero-windows-completed" }
        ]
      })
    ]
  };
  const text = R.buildSummary({ devlog });
  assert.ok(/health=recovered.*\(2 changes\)/.test(text), text);
});

// ---- the mailto budget ---------------------------------------------------

function fatDevlog(videoCount, windowsEach) {
  const videos = [];
  for (let i = 0; i < videoCount; i++) {
    videos.push(
      summaryVideo("video" + i, {
        windows: windowsEach,
        matchWord: "damn",
        gaps: [{ start: 0, end: 9, mode: "play" }],
        errors: [{ t: 1, wall: 1, text: "x".repeat(400) }],
        health: [{ status: "unhealthy", reason: "no-audio-intercepted" }],
        text: "y".repeat(2000)
      })
    );
  }
  return { version: 1, videos };
}

test("a fat devlog still produces a mailto under the 1800 char budget", () => {
  const url = R.buildMailto({
    email: PMMomentsCore.SUPPORT_EMAIL,
    extensionVersion: "0.1.33",
    userAgent: UA_CHROME_MAC,
    whatHappened: "it stopped working on every video today",
    videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    devlog: fatDevlog(10, 40)
  });
  assert.ok(url.length <= R.MAX_MAILTO_CHARS, "url length " + url.length);
  const body = decodeURIComponent(url.split("&body=")[1]);
  assert.ok(body.indexOf("it stopped working on every video today") !== -1, "user text survives");
  assert.ok(body.indexOf("diagnostic summary") !== -1, "summary survives");
});

test("the budget drops the OLDEST videos first", () => {
  const url = R.buildMailto({
    email: PMMomentsCore.SUPPORT_EMAIL,
    extensionVersion: "0.1.33",
    userAgent: UA_CHROME_MAC,
    whatHappened: "x",
    devlog: fatDevlog(10, 40),
    maxChars: 900
  });
  const body = decodeURIComponent(url.split("&body=")[1]);
  assert.ok(url.length <= 900, "url length " + url.length);
  assert.ok(body.indexOf("video9") !== -1, "the newest video is kept: " + body);
  assert.strictEqual(body.indexOf("video0"), -1, "the oldest is dropped");
});

test("an absurd budget still yields a usable draft with the user's own text", () => {
  // The user's words are the one thing only they can supply, so they are
  // never truncated even when every video line has to go.
  const url = R.buildMailto({
    email: PMMomentsCore.SUPPORT_EMAIL,
    extensionVersion: "0.1.33",
    userAgent: UA_CHROME_MAC,
    whatHappened: "swearing at 1:20 was not muted",
    devlog: fatDevlog(10, 40),
    maxChars: 400
  });
  const body = decodeURIComponent(url.split("&body=")[1]);
  assert.ok(body.indexOf("swearing at 1:20 was not muted") !== -1, body);
  assert.ok(body.indexOf("v0.1.33") !== -1, "the version line survives everything");
});

test("the paste instruction now frames the clipboard log as optional", () => {
  // The old copy made pasting sound mandatory, which is exactly why most
  // reports arrived empty.
  assert.ok(/optional|usually enough/i.test(R.PASTE_INSTRUCTION), R.PASTE_INSTRUCTION);
  assert.ok(bodyOf(mailto()).indexOf(R.PASTE_INSTRUCTION) !== -1);
});

// ---- summary -------------------------------------------------------------

console.log("report_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
