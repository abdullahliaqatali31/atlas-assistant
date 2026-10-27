/// <reference lib="webworker" />
/**
 * Local speech recognition for the wake word: Moonshine tiny (quantized) on
 * ONNX Runtime WebAssembly, loaded only from the app's own model folder via
 * assistant-model://. No network. One utterance at a time.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'

import { MODEL_ID, MODEL_SCHEME } from '../../../shared/wake.ts'
import { SCHEME_PATH } from '../../../shared/wire.ts'

export type AsrDevice = 'webgpu' | 'wasm'
export type AsrRequest = { type: 'load'; device?: AsrDevice } | { type: 'transcribe'; id: number; audio: Float32Array }
export type AsrResponse = { type: 'ready'; device: AsrDevice } | { type: 'text'; id: number; text: string; ms: number } | { type: 'error'; id?: number; message: string }

env.allowRemoteModels = false
env.allowLocalModels = true
env.useBrowserCache = false
// In a browser (the web interface) the same files come through Atlas's server.
env.localModelPath = /Electron\//.test(navigator.userAgent) ? `${MODEL_SCHEME}://models/` : `${SCHEME_PATH}${MODEL_SCHEME}/models/`
const wasm = env.backends.onnx.wasm
if (wasm) {
  wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm }
  // No cross-origin isolation in the app, so no shared memory: single thread.
  wasm.numThreads = 1
  wasm.proxy = false
}

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null
let device: AsrDevice = 'wasm'

const create = (d: AsrDevice) =>
  pipeline('automatic-speech-recognition', MODEL_ID, {
    device: d,
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
  }) as Promise<AutomaticSpeechRecognitionPipeline>

/** CPU WebAssembly by default (Moonshine tiny measured ~0.35 s per check); WebGPU only when asked. */
const load = (prefer?: AsrDevice) =>
  (asr ??= (async () => {
    const wantGpu = prefer === 'webgpu' && 'gpu' in navigator && (await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null))
    if (wantGpu) {
      try {
        const p = await create('webgpu')
        device = 'webgpu'
        return p
      } catch {
        // Fall through to CPU.
      }
    }
    device = 'wasm'
    return create('wasm')
  })())

const post = (m: AsrResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m)

self.onmessage = async (e: MessageEvent<AsrRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      await load(msg.device)
      post({ type: 'ready', device })
      return
    }
    const started = performance.now()
    const run = await load()
    // Only the first words matter for a wake word: a short decode is most of the speed-up.
    const out = await run(msg.audio, { max_new_tokens: 6, num_beams: 1 })
    const text = (Array.isArray(out) ? out[0]?.text : out.text) ?? ''
    post({ type: 'text', id: msg.id, text: text.trim(), ms: Math.round(performance.now() - started) })
  } catch (error) {
    asr = null
    post({ type: 'error', id: msg.type === 'transcribe' ? msg.id : undefined, message: error instanceof Error ? error.message : String(error) })
  }
}
