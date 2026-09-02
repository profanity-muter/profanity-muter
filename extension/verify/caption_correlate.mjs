// Deterministic sync verification: correlates OUR transcript's word
// timestamps against YouTube's own caption track (same media timeline as
// video.currentTime) instead of eyeballing the debug overlay.
//
// YouTube caption CONTENT is famously unreliable and cue timing itself is
// only accurate to about +-1s - so this does NOT do per-word pass/fail
// windows (that would fail a correct build on caption sloppiness alone).
// Instead: match our transcript's distinctive (non-stopword) words to
// same-word caption occurrences within a search radius, compute the time
// DELTA for each match, and look at the DISTRIBUTION over a 60s sample:
//   - median(delta): a systematic sync offset shows up as a shifted median.
//   - IQR(delta): caption timing noise shows up as spread; tolerated.
// Verdict: |median| < 1.0s AND IQR < 2.0s => in sync.
//
// Usage:
//   node caption_correlate.mjs --video <id> --log <path-to-console-log.txt> [--window 0,60] [--lang en]
//
// The log file is raw console text containing our own `[PM] WORDTIMES
// [{"w":"word","s":12.34,"e":12.9}, ...]` lines (see content.js addWords) -
// e.g. saved from read_console_messages, the debug overlay's "Copy logs"
// button, or a Playwright console capture. Lines not matching are ignored,
// so you can point this at a full raw log dump.
import fs from 'node:fs';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'and', 'in', 'on',
  'at', 'it', 'that', 'this', 'i', 'you', 'he', 'she', 'we', 'they', 'for', 'with', 'as', 'but', 'or',
  'not', 'so', 'do', 'does', 'did', 'have', 'has', 'had', 'my', 'your', 'his', 'her', 'its', 'our',
  'their', 'me', 'him', 'us', 'them', 'no', 'yes', 'up', 'down', 'out', 'if', 'just', 'like', 'go',
  'get', 'got', 'oh', 'uh', 'um', 'yeah', "it's", "i'm", "don't", 'okay', 'ok', 'gonna', 'know'
]);

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function normWord(w) {
  return String(w || '').toLowerCase().replace(/[^a-z']/g, '');
}

function extractOurWords(logText) {
  const words = [];
  const re = /WORDTIMES\s+(\[.*\])/g;
  let m;
  while ((m = re.exec(logText))) {
    try {
      const arr = JSON.parse(m[1]);
      for (const t of arr) words.push({ word: t.w, start: t.s, end: t.e });
    } catch (e) {
      // tolerate a malformed/truncated line in a raw log dump
    }
  }
  return words;
}

function parseTimedTextJson3(data) {
  const words = [];
  for (const event of data.events || []) {
    if (!event.segs || event.tStartMs == null) continue;
    const baseS = event.tStartMs / 1000;
    let offsetMs = 0;
    for (const seg of event.segs) {
      const text = seg.utf8 || '';
      const segStartS = baseS + (seg.tOffsetMs || offsetMs) / 1000;
      offsetMs = seg.tOffsetMs || offsetMs;
      const tokens = text.split(/\s+/).filter(Boolean);
      for (const tok of tokens) words.push({ word: tok, start: segStartS });
    }
  }
  return words;
}

// A bare Node `fetch` to youtube.com/api/timedtext frequently comes back
// HTTP 200 with an empty body - YouTube appears to require session/cookie
// context tying the request to an actual page load (bot mitigation), which
// a plain HTTP client doesn't have. Two ways to get real caption data here:
//  1. --captions-json <path>: a local file already containing the
//     timedtext `fmt=json3` response body (fetch it from a real browser tab
//     - e.g. `fetch(captionTrackBaseUrl + '&fmt=json3').then(r=>r.text())`
//     in the video's own page context, save the result - and point this at
//     it. Most reliable.
//  2. Best-effort auto-fetch: scrape the watch page for a signed
//     captionTracks[].baseUrl, then fetch fmt=json3 from it. Works from some
//     network environments, not others (same bot-mitigation risk); tried
//     automatically if --captions-json isn't given.
async function fetchCaptions(videoId, lang, captionsJsonPath) {
  if (captionsJsonPath) {
    const raw = fs.readFileSync(captionsJsonPath, 'utf8');
    return parseTimedTextJson3(JSON.parse(raw));
  }
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await pageRes.text();
  const m = html.match(/"captionTracks":(\[.*?\])/);
  if (!m) throw new Error('no captionTracks found on watch page (video may have no captions, or page structure changed)');
  const tracks = JSON.parse(m[1]);
  const track = tracks.find((t) => t.languageCode === lang && !t.kind) || tracks.find((t) => t.languageCode === lang) || tracks[0];
  if (!track) throw new Error('no caption track found for lang=' + lang);
  const capRes = await fetch(track.baseUrl + '&fmt=json3', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await capRes.text();
  if (!text.trim()) {
    throw new Error(
      'timedtext returned an empty body (likely YouTube session/bot-mitigation blocking a bare HTTP fetch) - ' +
        're-run with --captions-json pointing at a file fetched from within a real browser tab instead'
    );
  }
  return parseTimedTextJson3(JSON.parse(text));
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quartile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

async function main() {
  const args = parseArgs();
  if (!args.video || !args.log) {
    console.error('Usage: node caption_correlate.mjs --video <id> --log <path> [--window start,end] [--lang en]');
    process.exit(2);
  }
  const [winStart, winEnd] = (args.window || '0,60').split(',').map(Number);
  const lang = args.lang || 'en';

  const logText = fs.readFileSync(args.log, 'utf8');
  const ourWordsAll = extractOurWords(logText);
  const ourWords = ourWordsAll.filter((w) => w.start >= winStart && w.start <= winEnd);
  console.log(`Parsed ${ourWordsAll.length} of our words total, ${ourWords.length} in window [${winStart},${winEnd}]`);
  if (ourWords.length === 0) {
    console.error('No WORDTIMES entries found in the given window - nothing to correlate. Check the log covers this window.');
    process.exit(1);
  }

  const captionWordsAll = await fetchCaptions(args.video, lang, args['captions-json']);
  const captionWords = captionWordsAll.filter((w) => w.start >= winStart - 5 && w.start <= winEnd + 5);
  console.log(`Fetched ${captionWordsAll.length} caption words total, ${captionWords.length} in/near window`);
  if (captionWords.length === 0) {
    console.error('No captions found for this video/language/window - cannot verify. (captions may not exist, or timedtext lang mismatch)');
    process.exit(1);
  }

  const deltas = [];
  const matches = [];
  for (const ow of ourWords) {
    const norm = normWord(ow.word);
    if (!norm || STOPWORDS.has(norm) || norm.length < 3) continue; // distinctive words only
    let best = null;
    let bestDist = Infinity;
    for (const cw of captionWords) {
      if (normWord(cw.word) !== norm) continue;
      const dist = Math.abs(cw.start - ow.start);
      if (dist < bestDist && dist <= 10) {
        bestDist = dist;
        best = cw;
      }
    }
    if (best) {
      const delta = ow.start - best.start;
      deltas.push(delta);
      matches.push({ word: ow.word, ours: ow.start, caption: best.start, delta });
    }
  }

  console.log(`\nMatched ${matches.length} distinctive words (of ${ourWords.length} candidates) within +-10s search radius.`);
  matches.slice(0, 20).forEach((m) => console.log(`  "${m.word}" ours=${m.ours.toFixed(2)} caption=${m.caption.toFixed(2)} delta=${m.delta.toFixed(2)}`));
  if (matches.length > 20) console.log(`  ... and ${matches.length - 20} more`);

  if (deltas.length < 5) {
    console.error(`\nOnly ${deltas.length} matched words - too few for a reliable median/IQR. Widen the window or check caption availability.`);
    process.exit(1);
  }

  const sorted = [...deltas].sort((a, b) => a - b);
  const med = median(deltas);
  const q1 = quartile(sorted, 0.25);
  const q3 = quartile(sorted, 0.75);
  const iqr = q3 - q1;

  console.log(`\n=== RESULT (window [${winStart},${winEnd}], n=${deltas.length} matched words) ===`);
  console.log(`median(delta) = ${med.toFixed(3)}s`);
  console.log(`IQR(delta)    = ${iqr.toFixed(3)}s  (Q1=${q1.toFixed(3)}, Q3=${q3.toFixed(3)})`);

  const inSync = Math.abs(med) < 1.0 && iqr < 2.0;
  console.log(`\nVERDICT: ${inSync ? 'IN SYNC' : 'OUT OF SYNC'} (criteria: |median| < 1.0s AND IQR < 2.0s)`);
  process.exit(inSync ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
