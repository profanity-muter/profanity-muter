// mem-probe.js - imported FIRST by whisper-worker-src.js so that the
// WebAssembly wrappers are in place before onnxruntime-web is evaluated
// (ES imports execute in order). See shared/memlog.js.
import '../shared/memlog.js';

export const PMMemlog = globalThis.PMMemlog;
export const wasmProbe = PMMemlog.installWasmProbe(globalThis.WebAssembly);
