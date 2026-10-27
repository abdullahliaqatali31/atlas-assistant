/**
 * Always-on wake word listener. A light energy detector cuts short bursts of
 * speech (with half a second of audio before the burst, so the first
 * syllable is kept) and hands them to the local speech model worker; only the
 * name match leaves this module. Nothing is sent anywhere until the name is
 * heard. Pause it while the assistant speaks or records.
 */
import { DoubleClapDetector, WhistleDetector } from '../../../shared/sound-triggers.ts'
import { matchWake, type Sensitivity, type WakeMatch } from '../../../shared/wake.ts'
import type { AsrRequest, AsrResponse } from './asr.worker.ts'
import { outputSettings } from '../voice/output.ts'

const RATE = 16_000
const FRAME = 1024 // 64 ms
const PREROLL_FRAMES = 8 // ~0.5 s kept before speech starts
const END_SILENCE_FRAMES = 6 // ~0.4 s of quiet ends a burst
const MIN_SPEECH_FRAMES = 4 // ~0.25 s
const MAX_FRAMES = Math.round((3.2 * RATE) / FRAME) // longer bursts are cut to their start

/** What woke the assistant: its name (with the burst's 16 kHz PCM), a double clap or a whistle. */
export type WakeTrigger = { kind: 'name'; match: WakeMatch; audio: Float32Array } | { kind: 'clap' } | { kind: 'whistle' }

export interface ListenerOptions {
  onWake: (trigger: WakeTrigger) => void
  /** Every transcript, matched or not (for training and the live test). */
  onHeard?: (text: string, match: WakeMatch | null, ms: number) => void
  onLevel?: (level: number) => void
  onError?: (message: string) => void
  /** Read on every block, so changes apply without a restart. `name` false skips the speech model entirely. */
  settings: () => { aliases: string[]; sensitivity: Sensitivity; name: boolean; clap: boolean; whistle: boolean }
}

let worker: Worker | null = null
let workerReady: Promise<void> | null = null
let nextId = 1
const waiting = new Map<number, (r: AsrResponse) => void>()

/** One shared worker: loading the model is the slow part. */
const ensureWorker = () => {
  if (!worker) {
    worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<AsrResponse>) => {
      const m = e.data
      if ((m.type === 'text' || m.type === 'error') && m.id !== undefined) {
        waiting.get(m.id)?.(m)
        waiting.delete(m.id)
      }
    }
  }
  workerReady ??= new Promise<void>((resolve, reject) => {
    const w = worker!
    const onMsg = (e: MessageEvent<AsrResponse>) => {
      if (e.data.type === 'ready') {
        w.removeEventListener('message', onMsg)
        resolve()
      } else if (e.data.type === 'error' && e.data.id === undefined) {
        w.removeEventListener('message', onMsg)
        workerReady = null
        reject(new Error(e.data.message))
      }
    }
    w.addEventListener('message', onMsg)
    w.postMessage({ type: 'load' } satisfies AsrRequest)
  })
  return workerReady
}

/** Transcribes 16 kHz mono PCM with the local model. */
export const transcribeLocal = async (audio: Float32Array): Promise<{ text: string; ms: number }> => {
  await ensureWorker()
  const id = nextId++
  return new Promise((resolve, reject) => {
    waiting.set(id, r => (r.type === 'text' ? resolve({ text: r.text, ms: r.ms }) : reject(new Error(r.type === 'error' ? r.message : 'failed'))))
    worker!.postMessage({ type: 'transcribe', id, audio } satisfies AsrRequest, [audio.buffer])
  })
}

export class WakeListener {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private node: ScriptProcessorNode | null = null
  private paused = false
  private busy = false

  constructor(private readonly opts: ListenerOptions) {}

  private clap = new DoubleClapDetector()
  private whistle = new WhistleDetector()

  async start() {
    // The speech model loads only when the name trigger is on; claps and whistles need none.
    if (this.opts.settings().name) await ensureWorker()
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(outputSettings().inputId ? { deviceId: { exact: outputSettings().inputId } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.ctx = new AudioContext({ sampleRate: RATE })
    // Chromium may create it suspended; without this no audio (and no level) arrives.
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    const source = this.ctx.createMediaStreamSource(this.stream)
    // ScriptProcessor keeps this to one file; the work per frame is tiny.
    this.node = this.ctx.createScriptProcessor(FRAME, 1, 1)
    source.connect(this.node)
    this.node.connect(this.ctx.destination)

    const preroll: Float32Array[] = []
    let burst: Float32Array[] | null = null
    let speechFrames = 0
    let quietFrames = 0
    let floor = 0.01

    this.node.onaudioprocess = ev => {
      const input = ev.inputBuffer.getChannelData(0)
      ev.outputBuffer.getChannelData(0).fill(0)
      const frame = new Float32Array(input)
      let sum = 0
      for (const s of frame) sum += s * s
      const rms = Math.sqrt(sum / frame.length)
      this.opts.onLevel?.(Math.min(1, rms / 0.15))
      if (this.paused) {
        burst = null
        preroll.length = 0
        return
      }
      const triggers = this.opts.settings()
      if (triggers.clap && this.clap.push(frame)) return this.opts.onWake({ kind: 'clap' })
      if (triggers.whistle && this.whistle.push(frame)) return this.opts.onWake({ kind: 'whistle' })
      if (!triggers.name) return
      const threshold = Math.max(0.012, floor * 3)
      const speech = rms > threshold
      // Track room noise only while quiet, slowly.
      if (!speech) floor = floor * 0.97 + rms * 0.03

      if (!burst) {
        preroll.push(frame)
        if (preroll.length > PREROLL_FRAMES) preroll.shift()
        if (speech) {
          burst = [...preroll]
          preroll.length = 0
          speechFrames = 1
          quietFrames = 0
        }
        return
      }
      burst.push(frame)
      if (speech) {
        speechFrames++
        quietFrames = 0
      } else quietFrames++
      const tooLong = burst.length >= MAX_FRAMES
      if (quietFrames >= END_SILENCE_FRAMES || tooLong) {
        const done = burst
        burst = null
        if (speechFrames >= MIN_SPEECH_FRAMES) void this.check(join(done))
        // A long burst keeps going: ignore the rest of it until a pause.
        if (tooLong && quietFrames < END_SILENCE_FRAMES) this.ignoreUntilQuiet()
      }
    }
  }

  private ignoringUntil = 0
  private ignoreUntilQuiet() {
    this.ignoringUntil = performance.now() + 1500
  }

  private async check(audio: Float32Array) {
    // One at a time; a burst that arrives while the model is busy is skipped.
    if (this.busy || performance.now() < this.ignoringUntil) return
    this.busy = true
    try {
      const copy = audio.slice()
      const { text, ms } = await transcribeLocal(audio)
      const { aliases, sensitivity } = this.opts.settings()
      const match = text ? matchWake(text, aliases, sensitivity) : null
      this.opts.onHeard?.(text, match, ms)
      if (match && !this.paused) this.opts.onWake({ kind: 'name', match, audio: copy })
    } catch (error) {
      this.opts.onError?.(error instanceof Error ? error.message : String(error))
    } finally {
      this.busy = false
    }
  }

  pause(paused: boolean) {
    this.paused = paused
  }

  stop() {
    this.node?.disconnect()
    this.node = null
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
    void this.ctx?.close()
    this.ctx = null
  }
}

const join = (frames: Float32Array[]) => {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0))
  let o = 0
  for (const f of frames) {
    out.set(f, o)
    o += f.length
  }
  return out
}

/** 16-bit PCM WAV, for sending a "name + request" burst to the voice provider as one message. */
export const toWav = (pcm: Float32Array, rate = RATE): Uint8Array => {
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, pcm.length * 2, true)
  pcm.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true))
  return new Uint8Array(buf)
}

/** A short rising two-note chime: "I'm listening". */
export const chime = () => {
  try {
    const ctx = new AudioContext()
    const now = ctx.currentTime
    for (const [i, f] of [660, 990].entries()) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, now + i * 0.09)
      g.gain.exponentialRampToValueAtTime(0.12, now + i * 0.09 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.16)
      o.connect(g).connect(ctx.destination)
      o.start(now + i * 0.09)
      o.stop(now + i * 0.09 + 0.18)
    }
    setTimeout(() => void ctx.close(), 600)
  } catch {
    // No audio output: the orb still shows it is listening.
  }
}
