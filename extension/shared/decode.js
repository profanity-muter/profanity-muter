// shared/decode.js
// Plain script (NOT an ES module), imported by the offscreen bundle and
// require()d by test/decode_test.js. Defines globalThis.PMDecode.
//
// THE CHRONIC DECODE HANG, AND WHY IT WAS OURS
// --------------------------------------------
// Field logs from 0.1.21 onward showed sink.buffers() decodes that never
// settled, at one point roughly every other window on a six-minute video.
// It was assumed to be a mediabunny or WebCodecs failure on some unaudited
// container path, and every round since had added another layer of timeout
// around it. Reading mediabunny's own implementation
// (dist/modules/src/media-sink.js, mediaSamplesInRange) shows it was the
// timeouts themselves:
//
//   * Every buffers() call constructs its OWN AudioDecoder and closes it
//     only in the .finally() of an internal pump task.
//   * That pump finishes when the range ends naturally, or when the
//     CONSUMER calls iterator.return(), which sets its terminated/ended
//     flags and releases the promises it is waiting on.
//   * The pump applies backpressure: once its sample queue fills it blocks
//     on a promise that only the consumer's next() call resolves.
//
// So abandoning the iteration on timeout, which is exactly what
// `await withStageTimeout(loopPromise)` does, parks that pump forever
// holding a live AudioDecoder and a queue of unclosed AudioData. WebCodecs
// decoders are a finite resource. Each abandoned decode therefore made the
// next one likelier to stall, which timed out, which abandoned another.
// A guard meant to bound one failure was manufacturing the next.
//
// The rule that follows is small and absolute, and is why this module
// exists rather than the logic living inline: AN ITERATOR WE STOP
// CONSUMING MUST BE CLOSED. Not "should", and not "eventually" - the
// resource is held until return() runs.

(function (root) {
  "use strict";

  // ---- timeout ladder ----------------------------------------------------
  //
  // The first attempt is on a short leash and every later one is not. At
  // these window sizes a decode that is going to settle settles in well
  // under a second (measured RTF is far below 1x realtime), so a long first
  // timeout is not patience, it is dead time in front of a repair that
  // takes milliseconds. Post-rebuild attempts get the original generous
  // budget, so a genuinely slow machine is never punished for being slow.
  var STAGE_TIMEOUT_FIRST_MS = 3000;
  var STAGE_TIMEOUT_MS = 25000;

  function stageTimeoutMsFor(attemptsSoFar) {
    return attemptsSoFar > 0 ? STAGE_TIMEOUT_MS : STAGE_TIMEOUT_FIRST_MS;
  }

  // ---- suspend / background-throttle awareness (0.1.48) ------------------
  //
  // THE FALSE HANG. Field logs from long, backgrounded videos showed
  // [PM-REBUILD] on nearly every window and [PM-GIVEUP] every few, with the
  // devlog's own wall-clock stamps jumping by THOUSANDS of seconds between
  // consecutive windows. That is not a decoder defect - it is the machine
  // sleeping or the offscreen document being heavily throttled while hidden.
  // A plain setTimeout budget cannot tell "the decode wedged for 3s of real
  // work" from "the process was frozen for an hour and this timer only just
  // got to run": both look like elapsed >= budget. The decode did not fail;
  // it never got CPU. Counting that as a hang rebuilds a healthy pipeline,
  // then gives up on a window that still had ample lead time on the playhead.
  //
  // The fix is to measure the budget in AWAKE wall-clock time, not raw
  // elapsed time. We sample the clock on a short tick; a gap between ticks
  // far larger than the tick interval can only mean the timer thread was
  // frozen (sleep/throttle), so that time was not spent decoding and is
  // credited back to the deadline instead of counted against it. A genuine
  // wedge - one that keeps getting scheduled but never settles - still trips
  // the budget normally, because its ticks arrive on time.
  var SUSPEND_TICK_MS = 1000; // how often to sample the clock for a freeze
  var SUSPEND_GRACE_MS = 4000; // an inter-tick gap beyond tick+this = a suspend, not slow decode

  // FAST no-progress stall detection (0.1.48). A healthy decode of an ~18s
  // window yields buffers continuously and completes in well under a second,
  // so two seconds with the iterator yielding NOTHING is already a wedged
  // WebCodecs decoder, not a slow one. Catching it here, cheaply, keeps a
  // stall from burning the 25s stage budget - the exact 25s that is the whole
  // lead the playhead had. This is a no-PROGRESS budget, reset on every
  // delivered buffer; it is not a ceiling on how long a big, actively-
  // progressing decode may run (that is still timeoutMs).
  var NO_PROGRESS_MS = 2000;

  // PROACTIVE decoder recycling (0.1.48). mediabunny builds a fresh
  // AudioDecoder for every buffers() call and closes it when the range ends
  // or the consumer calls return(); with the disposal contract above honored,
  // decoders should never accumulate. This constant is defense in depth: the
  // offscreen caller drops and rebuilds a run's cached track/sink every this
  // many completed windows, forcing a clean decoder lineage rather than
  // trusting a 30-minute session's worth of implicit teardown to leak
  // nothing. Cheap (a rebuild reparses nothing - same Input, same fed bytes)
  // and it turns "decoders slowly pile up until decodes stall deep in a long
  // video" into a bounded, self-clearing pattern.
  var DECODER_RECYCLE_EVERY = 40;

  // ---- the hang ladder ---------------------------------------------------
  //
  // Recovery is cheap now, so it happens sooner. Rebuilding the decode
  // pipeline is the repair most likely to clear a wedged decoder, and there
  // is no reason to sit through a second identical wait before trying it.
  var HANG_REBUILD_AT = 1;
  var HANG_SKIP_AT = 2;
  var HANG_THRESHOLD = 6;

  // hangAction(attemptCount) -> "rebuild" | "skip" | "giveup" | "retry"
  //
  //   rebuild - drop the cached track/sink and build fresh ones
  //   skip    - stop attempting this SPAN and advance past it. The span is
  //             never marked covered, so the audio stays unanalyzed and
  //             mute/pause catch-up keeps protecting it; only the picker
  //             stops returning to it.
  //   giveup  - the whole session is undecodable
  function hangAction(attemptCount) {
    var n = typeof attemptCount === "number" && attemptCount > 0 ? attemptCount : 0;
    if (n >= HANG_THRESHOLD) return "giveup";
    if (n >= HANG_SKIP_AT) return "skip";
    if (n >= HANG_REBUILD_AT) return "rebuild";
    return "retry";
  }

  // ---- the disposal contract ---------------------------------------------
  //
  // Drain an async iterator with a time budget, and close it whatever
  // happens. This is the whole fix, expressed once so it can be tested:
  // the caller cannot forget the teardown, because the teardown is not the
  // caller's job.
  //
  // Returns {values, timedOut, error, suspendedMs}. A timeout is reported
  // rather than thrown, since the caller's next decision (rebuild, skip, give
  // up) depends on which kind of failure it was. `suspendedMs` reports how
  // much clock time was credited back as sleep/throttle so the caller can log
  // it and decide not to hold a throttled window against the hang ladder.
  //
  // TWO deadlines, whichever comes first:
  //   * A NO-PROGRESS deadline (options.noProgressMs). A healthy ~18s-window
  //     decode yields buffers continuously and finishes in well under a
  //     second; a WebCodecs decoder that is genuinely wedged yields nothing.
  //     So we reset this deadline every time a value is delivered - a decode
  //     that is making progress is never killed, and a stuck one is caught in
  //     a couple of seconds of AWAKE time instead of sitting on a 25s budget
  //     that eats the whole lead the playhead had. Defaults to timeoutMs when
  //     the caller does not ask for it, so old call sites keep their single-
  //     budget behavior exactly.
  //   * An OVERALL deadline (options.timeoutMs) - a ceiling on total awake
  //     time regardless of progress, the original budget.
  //
  // Both are measured in AWAKE wall-clock time. We sample the clock on a
  // short tick; a gap between ticks far larger than the tick interval means
  // the timer thread was frozen (machine sleep, or a hidden/throttled
  // offscreen document), which is not time the decode spent failing - it is
  // time the decode never got. That gap is credited back to both deadlines
  // instead of counted against them, so a merely-throttled window is never
  // mislabeled a hang. See SUSPEND_TICK_MS / SUSPEND_GRACE_MS above.
  //
  // `now` and `setTimer`/`clearTimer` are injectable so the tests can drive
  // the clock without waiting on it.
  function drainWithTimeout(iterator, options) {
    options = options || {};
    var timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : STAGE_TIMEOUT_MS;
    var noProgressMs = typeof options.noProgressMs === "number" ? options.noProgressMs : timeoutMs;
    var setTimer = options.setTimer || (typeof setTimeout === "function" ? setTimeout : null);
    var clearTimer = options.clearTimer || (typeof clearTimeout === "function" ? clearTimeout : null);
    var now = options.now || (typeof Date !== "undefined" && Date.now ? Date.now : function () { return 0; });
    var tickMs = typeof options.tickMs === "number" ? options.tickMs : SUSPEND_TICK_MS;
    var graceMs = typeof options.suspendGraceMs === "number" ? options.suspendGraceMs : SUSPEND_GRACE_MS;
    var values = [];
    var aborted = false;
    var timer = null;
    var suspendedMs = 0;

    if (!iterator || typeof iterator.next !== "function") {
      return Promise.resolve({ values: values, timedOut: false, error: new Error("not an iterator"), suspendedMs: 0 });
    }

    var startWall = now();
    var overallDeadline = startWall + timeoutMs;
    var progressDeadline = startWall + noProgressMs;

    var timeoutPromise = new Promise(function (resolve) {
      if (!setTimer) return; // no timer available: the drain is simply unbounded
      var lastTick = now();
      function scheduleNext() {
        var t = now();
        var soonest = Math.min(overallDeadline, progressDeadline);
        var delay = Math.max(1, Math.min(tickMs, soonest - t));
        timer = setTimer(tick, delay);
      }
      function tick() {
        var t = now();
        // A jump far beyond the scheduled tick is a freeze, not slow decode.
        // Credit it back to both deadlines so suspended time is not counted.
        var gap = t - lastTick;
        var overshoot = gap - tickMs;
        if (overshoot > graceMs) {
          suspendedMs += overshoot;
          overallDeadline += overshoot;
          progressDeadline += overshoot;
        }
        lastTick = t;
        if (aborted) return; // drain already settled; stop ticking
        if (t >= overallDeadline || t >= progressDeadline) {
          aborted = true;
          resolve("timeout");
          return;
        }
        scheduleNext();
      }
      scheduleNext();
    });

    var drainPromise = (function () {
      function step() {
        return Promise.resolve(iterator.next()).then(function (result) {
          if (aborted) return "aborted";
          if (result && result.done) return "done";
          values.push(result ? result.value : undefined);
          // Real forward progress: push the no-progress deadline out. As long
          // as buffers keep arriving the decode is healthy and is never
          // killed, no matter how much total audio the window covers.
          progressDeadline = now() + noProgressMs;
          return step();
        });
      }
      return step();
    })();

    return Promise.race([drainPromise, timeoutPromise]).then(
      function (outcome) {
        if (clearTimer && timer != null) clearTimer(timer);
        if (outcome === "done") return { values: values, timedOut: false, error: null, suspendedMs: suspendedMs };
        // Timed out, or the loop noticed the abort first. Either way we
        // have stopped consuming, so the iterator MUST be closed: its pump
        // is holding a decoder and a queue of samples that only return()
        // releases.
        aborted = true;
        return closeIterator(iterator).then(function () {
          return { values: values, timedOut: true, error: null, suspendedMs: suspendedMs };
        });
      },
      function (err) {
        if (clearTimer && timer != null) clearTimer(timer);
        // A thrown decode error tears the iterator down on its own way out,
        // but closing twice is safe and costs nothing, whereas assuming it
        // did is how the original leak survived three releases.
        aborted = true;
        return closeIterator(iterator).then(function () {
          return { values: values, timedOut: false, error: err, suspendedMs: suspendedMs };
        });
      }
    );
  }

  // ---- fail-safe accounting helper (0.1.48) ------------------------------
  //
  // A span may be permanently abandoned only once the playhead has moved PAST
  // it. Re-analyzing audio the viewer has already heard is pointless (the
  // words already played), but abandoning a span the playhead has NOT reached
  // throws away coverage that still had time to land ahead of playback. This
  // is the gate that keeps the give-up ladder from killing a FUTURE window
  // that merely hit a transient stall. With no playhead known, preserve the
  // old unconditional behavior.
  function playheadPassed(spanEnd, playheadT, marginS) {
    if (typeof playheadT !== "number") return true;
    var margin = typeof marginS === "number" ? marginS : 0;
    return playheadT >= spanEnd + margin;
  }

  // ---- anchor coverage tolerance (0.1.48) --------------------------------
  //
  // Does a decode whose audio BEGINS at `decodedStart` cover a requested
  // anchor point `requestedStart`? A decode that lands exactly where it was
  // asked (startDelta 0, to sub-centisecond float rounding) plainly does -
  // but a strict `decodedStart <= requestedStart` (or a half-open-interval
  // firstUncoveredPoint comparing floats without slack) reported a decode
  // that started a few microseconds LATER as "still uncovered", which fired
  // the WINDOW-LOOP path and the DECODE-DELTA "did NOT cover" line on
  // perfectly good windows every cycle. The tolerance matches the 0.05s slack
  // mergeRangeInto already uses to join adjacent coverage, so the two agree
  // on what "touching" means.
  var ANCHOR_EPS_S = 0.05;
  function decodeCoversAnchor(decodedStart, requestedStart, epsS) {
    var eps = typeof epsS === "number" ? epsS : ANCHOR_EPS_S;
    return decodedStart <= requestedStart + eps;
  }

  // Always resolves. A teardown that throws must never mask the failure
  // that caused it, and must never prevent the caller from carrying on.
  function closeIterator(iterator) {
    if (!iterator || typeof iterator.return !== "function") return Promise.resolve(false);
    try {
      return Promise.resolve(iterator.return()).then(
        function () { return true; },
        function () { return false; }
      );
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  var PMDecodeCore = {
    STAGE_TIMEOUT_FIRST_MS: STAGE_TIMEOUT_FIRST_MS,
    STAGE_TIMEOUT_MS: STAGE_TIMEOUT_MS,
    NO_PROGRESS_MS: NO_PROGRESS_MS,
    SUSPEND_TICK_MS: SUSPEND_TICK_MS,
    SUSPEND_GRACE_MS: SUSPEND_GRACE_MS,
    DECODER_RECYCLE_EVERY: DECODER_RECYCLE_EVERY,
    HANG_REBUILD_AT: HANG_REBUILD_AT,
    HANG_SKIP_AT: HANG_SKIP_AT,
    HANG_THRESHOLD: HANG_THRESHOLD,
    ANCHOR_EPS_S: ANCHOR_EPS_S,
    stageTimeoutMsFor: stageTimeoutMsFor,
    hangAction: hangAction,
    drainWithTimeout: drainWithTimeout,
    closeIterator: closeIterator,
    playheadPassed: playheadPassed,
    decodeCoversAnchor: decodeCoversAnchor
  };

  root.PMDecode = PMDecodeCore;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMDecodeCore: PMDecodeCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
