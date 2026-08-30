// Spike: intercept MSE audio SourceBuffer appends in the MAIN world so we can
// see bytes ahead of the playhead (YouTube buffers 30s-2min ahead).
// Always calls through to the original appendBuffer FIRST so playback is
// never broken by spike logic. All spike logic is wrapped in try/catch and
// logs [CAPTURE-ERR] on failure.
(function () {
  var TAG = '[CAPTURE]';
  var ERR = '[CAPTURE-ERR]';

  function toArrayBuffer(chunk) {
    if (chunk instanceof ArrayBuffer) return chunk.slice(0);
    if (ArrayBuffer.isView(chunk)) {
      return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    }
    throw new Error('appendBuffer chunk is neither ArrayBuffer nor ArrayBufferView');
  }

  function concatBuffers(a, b) {
    var out = new Uint8Array(a.byteLength + b.byteLength);
    out.set(new Uint8Array(a), 0);
    out.set(new Uint8Array(b), a.byteLength);
    return out.buffer;
  }

  function sniffContainer(buf) {
    var bytes = new Uint8Array(buf.slice(0, 16));
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return 'webm/matroska (EBML header)';
    }
    var boxType = '';
    for (var i = 4; i < 8 && i < bytes.length; i++) {
      boxType += String.fromCharCode(bytes[i]);
    }
    var knownBoxes = ['ftyp', 'styp', 'moov', 'moof', 'sidx', 'free', 'skip', 'mdat'];
    if (knownBoxes.indexOf(boxType) !== -1) {
      return 'iso-bmff/mp4 (box=' + boxType + ')';
    }
    var hex = [];
    for (var j = 0; j < bytes.length; j++) {
      hex.push(bytes[j].toString(16).padStart(2, '0'));
    }
    return 'unknown (first bytes: ' + hex.join(' ') + ')';
  }

  var audioContext = null;
  function getAudioContext() {
    if (!audioContext) {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        audioContext = new Ctx();
        console.log(TAG, 'AudioContext created, state=' + audioContext.state);
      } catch (e) {
        console.error(ERR, 'failed to create AudioContext', e);
      }
    }
    return audioContext;
  }

  var OrigMediaSource = window.MediaSource;
  if (!OrigMediaSource) {
    console.error(ERR, 'window.MediaSource not present at document_start');
    return;
  }

  var origAddSourceBuffer = OrigMediaSource.prototype.addSourceBuffer;

  OrigMediaSource.prototype.addSourceBuffer = function (mime) {
    var sb = origAddSourceBuffer.call(this, mime);
    try {
      if (typeof mime === 'string' && mime.toLowerCase().indexOf('audio') !== -1) {
        instrumentAudioSourceBuffer(sb, mime);
      }
    } catch (e) {
      console.error(ERR, 'addSourceBuffer hook failed', e);
    }
    return sb;
  };

  function instrumentAudioSourceBuffer(sb, mime) {
    console.log(TAG, 'audio SourceBuffer detected, mime=' + mime);
    var origAppendBuffer = sb.appendBuffer;
    var initSegment = null;
    var segmentCount = 0;

    sb.appendBuffer = function (chunk) {
      // Always call through FIRST so playback is never broken by spike logic.
      var result = origAppendBuffer.call(this, chunk);

      try {
        var video = document.querySelector('video');
        var currentTime = video ? video.currentTime : NaN;
        var bufferedEnd = NaN;
        try {
          if (this.buffered && this.buffered.length > 0) {
            bufferedEnd = this.buffered.end(this.buffered.length - 1);
          }
        } catch (e) {
          // buffered can throw while the SourceBuffer is updating; ignore.
        }

        var ab = toArrayBuffer(chunk);
        var bytes = ab.byteLength;
        segmentCount++;
        var segIndex = segmentCount; // snapshot for async callbacks below

        if (initSegment === null) {
          initSegment = ab;
          console.log(
            TAG,
            'mime=' + mime + ' bytes=' + bytes + ' decodedSec=init' +
              ' currentTime=' + fmt(currentTime) +
              ' bufferedEnd=' + fmt(bufferedEnd) +
              ' aheadSec=NA' +
              ' container=' + sniffContainer(ab)
          );
          return result;
        }

        var ctx = getAudioContext();
        if (!ctx) {
          console.error(ERR, 'no AudioContext available, skipping decode for segment #' + segIndex);
          return result;
        }

        var combined = concatBuffers(initSegment, ab);
        var container = sniffContainer(ab);

        ctx
          .decodeAudioData(combined)
          .then(function (audioBuffer) {
            var decodedSec = audioBuffer.duration;
            var ahead = !isNaN(bufferedEnd) && !isNaN(currentTime) ? bufferedEnd - currentTime : NaN;
            console.log(
              TAG,
              'mime=' + mime + ' bytes=' + bytes + ' decodedSec=' + fmt(decodedSec) +
                ' currentTime=' + fmt(currentTime) +
                ' bufferedEnd=' + fmt(bufferedEnd) +
                ' aheadSec=' + fmt(ahead)
            );
          })
          .catch(function (err) {
            console.error(
              ERR,
              'decodeAudioData failed for segment #' + segIndex +
                ' bytes=' + bytes +
                ' container=' + container +
                ' error=' + (err && err.message)
            );
          });
      } catch (e) {
        console.error(ERR, 'appendBuffer hook failed', e);
      }

      return result;
    };
  }

  function fmt(n) {
    return typeof n === 'number' && !isNaN(n) ? n.toFixed(3) : 'NA';
  }

  console.log(TAG, 'capture.js installed at document_start, world=MAIN');
})();
