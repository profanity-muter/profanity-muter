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
  // Returns {values, timedOut, error}. A timeout is reported rather than
  // thrown, since the caller's next decision (rebuild, skip, give up)
  // depends on which kind of failure it was.
  //
  // `now` and `setTimer`/`clearTimer` are injectable so the tests can drive
  // the clock without waiting on it.
  function drainWithTimeout(iterator, options) {
    options = options || {};
    var timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : STAGE_TIMEOUT_MS;
    var setTimer = options.setTimer || (typeof setTimeout === "function" ? setTimeout : null);
    var clearTimer = options.clearTimer || (typeof clearTimeout === "function" ? clearTimeout : null);
    var values = [];
    var aborted = false;
    var timer = null;

    if (!iterator || typeof iterator.next !== "function") {
      return Promise.resolve({ values: values, timedOut: false, error: new Error("not an iterator") });
    }

    var timeoutPromise = new Promise(function (resolve) {
      if (!setTimer) return; // no timer available: the drain is simply unbounded
      timer = setTimer(function () {
        aborted = true;
        resolve("timeout");
      }, timeoutMs);
    });

    var drainPromise = (function () {
      function step() {
        return Promise.resolve(iterator.next()).then(function (result) {
          if (aborted) return "aborted";
          if (result && result.done) return "done";
          values.push(result ? result.value : undefined);
          return step();
        });
      }
      return step();
    })();

    return Promise.race([drainPromise, timeoutPromise]).then(
      function (outcome) {
        if (clearTimer && timer != null) clearTimer(timer);
        if (outcome === "done") return { values: values, timedOut: false, error: null };
        // Timed out, or the loop noticed the abort first. Either way we
        // have stopped consuming, so the iterator MUST be closed: its pump
        // is holding a decoder and a queue of samples that only return()
        // releases.
        aborted = true;
        return closeIterator(iterator).then(function () {
          return { values: values, timedOut: true, error: null };
        });
      },
      function (err) {
        if (clearTimer && timer != null) clearTimer(timer);
        // A thrown decode error tears the iterator down on its own way out,
        // but closing twice is safe and costs nothing, whereas assuming it
        // did is how the original leak survived three releases.
        aborted = true;
        return closeIterator(iterator).then(function () {
          return { values: values, timedOut: false, error: err };
        });
      }
    );
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
    HANG_REBUILD_AT: HANG_REBUILD_AT,
    HANG_SKIP_AT: HANG_SKIP_AT,
    HANG_THRESHOLD: HANG_THRESHOLD,
    stageTimeoutMsFor: stageTimeoutMsFor,
    hangAction: hangAction,
    drainWithTimeout: drainWithTimeout,
    closeIterator: closeIterator
  };

  root.PMDecode = PMDecodeCore;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PMDecodeCore: PMDecodeCore };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
