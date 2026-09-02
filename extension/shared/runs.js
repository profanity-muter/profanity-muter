// shared/runs.js
// Plain script (NOT an ES module). Loaded into the MAIN world alongside
// capture.js, imported into the offscreen bundle, and require()d by
// test/runs_test.js. Defines globalThis.PMRuns.
//
// RUN TOPOLOGY: which demux run serves which region of the video, and what
// to do when the answer changes faster than the pipeline can keep up.
//
// A "run" is one mediabunny Input fed one contiguous byte stream. It can
// only decode audio whose bytes it was actually fed. Feed it audio from a
// different part of the video and it cannot serve that span at all, and
// says so forever: "no decodable audio in this run at that time yet".
//
// WHAT 0.1.24 FIXED, AND MUST STAY FIXED
// --------------------------------------
// findGrowth once misread ordinary buffer eviction (YouTube trimming the
// front of a range while extending the tail) as a disjoint new range, on
// EVERY segment of a long video. That fired a run boundary per segment,
// hundreds a minute, each superseded before it could transcribe anything.
// The real fix was interval set-difference in findGrowth; the rate limiter
// was defense in depth, tripping after 3 boundaries in 10s and thereafter
// feeding everything into the existing run: "degraded but alive beats
// churn death".
//
// WHY THAT BACKSTOP THEN CAUSED ITS OWN OUTAGE
// --------------------------------------------
// A user seek-stormed (25 -> 1495 -> 1596 -> 1566 in about two seconds).
// Those are four genuinely disjoint regions, correctly classified. The
// fourth tripped the limiter, which suppressed the boundary and fed audio
// from 1560 into a run anchored around 1590. That run could never decode
// it. The window skipped forever, and coverage only returned when the
// playhead drifted into a region the run could actually serve: 35.8
// seconds of unfiltered audible playback in play mode.
//
// The backstop assumed every boundary it suppressed was misclassified.
// After 0.1.24 that assumption is wrong in exactly the case that hurts:
// misclassified growth is CONTIGUOUS by construction (it is the same range
// trimmed and extended), while a seek jump is DISJOINT. Suppressing a
// contiguous "boundary" is free, since the existing run holds that audio
// anyway. Suppressing a disjoint one guarantees undecodable audio.
//
// So the rule is not "how many boundaries recently" but "is this audio
// somewhere the existing run can serve". Churn protection survives as a
// cap on how many runs may be opened, with one exception that cannot be
// rate-limited away: the run serving the playhead.

(function (root) {
  "use strict";

  // How far a growth span must sit from a run's fed span before it counts
  // as a different region. Small, because the failure it prevents is total
  // (undecodable audio) while a false "new run" costs one extra demux.
  // Comfortably larger than the sub-second overlaps normal appends
  // produce, and far smaller than any real seek.
  var DISJOINT_GAP_S = 3;

  // Churn protection, retained from 0.1.24 but no longer absolute.
  var BOUNDARY_WINDOW_MS = 10000;
  var BOUNDARY_MAX = 3;

  // How many runs a session keeps. Two was enough when runs arrived one at
  // a time; a seek storm produces several in seconds and the playhead can
  // land back in any of them.
  var KEEP_RUNS = 4;

  function spansOverlapOrAdjoin(aStart, aEnd, bStart, bEnd, gapS) {
    var gap = typeof gapS === "number" ? gapS : DISJOINT_GAP_S;
    return aStart <= bEnd + gap && bStart <= aEnd + gap;
  }

  // Is this growth somewhere the given run span can already serve?
  // A null/empty span means the run has been fed nothing yet, which makes
  // it able to serve whatever comes first.
  function isContiguousWith(span, growthStart, growthEnd, gapS) {
    if (!span || typeof span.start !== "number" || typeof span.end !== "number") return true;
    return spansOverlapOrAdjoin(span.start, span.end, growthStart, growthEnd, gapS);
  }

  // classifyBoundary(input) -> {action, reason}
  //
  //   "new-run"       open a new demux run for this growth
  //   "feed-existing" not a boundary; the current run serves this region
  //   "suppressed"    a boundary the churn cap refused, safe ONLY because
  //                   the growth is contiguous with the current run
  //
  // input:
  //   isNewRange     what findGrowth decided
  //   growthStart/growthEnd
  //   currentRunSpan {start,end} of what the current run has been fed
  //   boundaryWalls  wall times of recent boundaries actually opened
  //   now, windowMs, maxBoundaries, gapS
  function classifyBoundary(input) {
    input = input || {};
    var gapS = typeof input.gapS === "number" ? input.gapS : DISJOINT_GAP_S;
    var growthStart = input.growthStart;
    var growthEnd = input.growthEnd;
    var hasGrowth = typeof growthStart === "number" && typeof growthEnd === "number";

    if (!input.isNewRange) {
      return { action: "feed-existing", reason: "contiguous-growth" };
    }
    if (!hasGrowth) {
      // A boundary with no usable growth span cannot be reasoned about.
      // Treat it as the old code did and let the churn cap decide.
      return recentCount(input) > maxOf(input)
        ? { action: "suppressed", reason: "storm-no-growth-span" }
        : { action: "new-run", reason: "boundary-no-growth-span" };
    }

    var contiguous = isContiguousWith(input.currentRunSpan, growthStart, growthEnd, gapS);
    if (contiguous) {
      // This is what 0.1.24 was built for: growth flagged as a boundary
      // that the current run can serve anyway. Suppressing it is free, and
      // the churn cap is the right tool.
      if (recentCount(input) > maxOf(input)) {
        return { action: "suppressed", reason: "storm-contiguous" };
      }
      return { action: "new-run", reason: "boundary-contiguous" };
    }

    // DISJOINT. The current run cannot decode this audio, so suppressing
    // the boundary does not degrade the pipeline, it silently breaks it.
    // No rate limit may apply here: this is precisely the case where
    // "degraded but alive" is neither.
    return { action: "new-run", reason: "disjoint-requires-run" };
  }

  function recentCount(input) {
    var walls = input.boundaryWalls || [];
    var now = typeof input.now === "number" ? input.now : Date.now();
    var windowMs = typeof input.windowMs === "number" ? input.windowMs : BOUNDARY_WINDOW_MS;
    var n = 0;
    for (var i = 0; i < walls.length; i++) {
      if (now - walls[i] < windowMs) n++;
    }
    return n;
  }

  function maxOf(input) {
    return typeof input.maxBoundaries === "number" ? input.maxBoundaries : BOUNDARY_MAX;
  }

  // Which run should be retired when the cap is exceeded?
  //
  // FIFO was fine when runs arrived one at a time. After a seek storm the
  // oldest run can be the one holding the region the playhead just
  // returned to, and dropping it recreates the same outage from the other
  // direction. Retire by distance from the playhead instead, and never
  // retire the run that can serve it or the current one.
  //
  // runs: [{span:{start,end}|null, isCurrent:bool}]
  // returns the index to retire, or -1 for "retire nothing"
  function selectRunToRetire(input) {
    input = input || {};
    var runs = input.runs || [];
    var keep = typeof input.maxRuns === "number" ? input.maxRuns : KEEP_RUNS;
    if (runs.length <= keep) return -1;
    var playheadT = typeof input.playheadT === "number" ? input.playheadT : null;
    var gapS = typeof input.gapS === "number" ? input.gapS : DISJOINT_GAP_S;

    var worstIdx = -1;
    var worstDistance = -1;
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i] || {};
      if (r.isCurrent) continue; // never retire the run being fed
      var d = distanceFromPlayhead(r.span, playheadT);
      if (d === 0) continue; // serves the playhead: the one run we must keep
      if (playheadT != null && r.span && isContiguousWith(r.span, playheadT, playheadT, gapS)) {
        continue; // close enough to serve a moment from now
      }
      if (d > worstDistance) {
        worstDistance = d;
        worstIdx = i;
      }
    }
    // Everything left is either current or playhead-relevant. Fall back to
    // the oldest non-current run rather than growing without bound.
    if (worstIdx === -1) {
      for (var j = 0; j < runs.length; j++) {
        if (!runs[j] || !runs[j].isCurrent) return j;
      }
    }
    return worstIdx;
  }

  function distanceFromPlayhead(span, playheadT) {
    if (playheadT == null) return Infinity; // no playhead: age is all we have
    if (!span || typeof span.start !== "number" || typeof span.end !== "number") return Infinity;
    if (playheadT >= span.start && playheadT <= span.end) return 0;
    return playheadT < span.start ? span.start - playheadT : playheadT - span.end;
  }

  // Can this run serve the playhead at all? Used by the stall recovery to
  // tell "the pipeline is slow" from "the run mapping is wrong", which need
  // completely different responses: waiting helps the first and can never
  // help the second.
  function runCanServe(span, t, gapS) {
    if (!span || typeof span.start !== "number" || typeof span.end !== "number") return false;
    var gap = typeof gapS === "number" ? gapS : DISJOINT_GAP_S;
    return t >= span.start - gap && t <= span.end + gap;
  }

  var PMRunsCore = {
    DISJOINT_GAP_S: DISJOINT_GAP_S,
    BOUNDARY_WINDOW_MS: BOUNDARY_WINDOW_MS,
    BOUNDARY_MAX: BOUNDARY_MAX,
    KEEP_RUNS: KEEP_RUNS,
    isContiguousWith: isContiguousWith,
    classifyBoundary: classifyBoundary,
    selectRunToRetire: selectRunToRetire,
    distanceFromPlayhead: distanceFromPlayhead,
    runCanServe: runCanServe
  };

  root.PMRuns = PMRunsCore;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMRunsCore: PMRunsCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
