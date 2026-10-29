// UH Parrot speech worker: runs Whisper entirely in the browser via transformers.js + ONNX Runtime Web.
// Nothing leaves this machine. All model files are served from ./model/ and ./lib/ (hosted build).
import './netguard.js';
import * as T from './lib/transformers.min.js';
const { env } = T;
import { startEngine } from './engine.js';

const base = new URL('./', self.location.href).href;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = './model/'; // relative: transformers.js treats http(s) paths as remote
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = base + 'lib/';
// Multi-threading needs cross-origin isolation (COOP/COEP headers). Fall back to one thread otherwise.
env.backends.onnx.wasm.numThreads = (self.crossOriginIsolated && navigator.hardwareConcurrency)
  ? Math.min(4, navigator.hardwareConcurrency) : 1;
env.backends.onnx.wasm.proxy = false;

startEngine(T);
