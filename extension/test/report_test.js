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
  assert.ok(body.indexOf("Extension version: 0.1.31") !== -1);
});

test("the mail body carries the paste instruction verbatim", () => {
  assert.ok(bodyOf(mailto()).indexOf(R.PASTE_INSTRUCTION) !== -1);
  assert.strictEqual(
    R.PASTE_INSTRUCTION,
    "The full diagnostic report has been copied to your clipboard — " +
      "please paste it below this line before sending."
  );
});

test("the mail body NEVER carries the debug log", () => {
  // mailto bodies are silently truncated by clients past a couple of
  // thousand characters; a log in here would be mangled, not delivered.
  const url = mailto();
  assert.ok(url.indexOf("vid0") === -1);
  assert.ok(url.length < 2000, "the draft stays small enough to survive a mail client: " + url.length);
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

// ---- summary -------------------------------------------------------------

console.log("report_test.js: " + passed + "/" + (passed + failed) + " passed");
if (failed) process.exit(1);
