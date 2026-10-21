/**
 * One microphone for the whole conversation: recording a turn and listening
 * for barge-in share the same stream instead of each opening their own. It
 * stays open a few seconds between turns, so the next turn starts at once
 * (the first syllable is not lost to a device opening) and Windows' echo
 * cancellation keeps one steady picture of Atlas's own voice to remove.
 */
import { outputSettings } from './output.ts'

interface Shared {
  stream: MediaStream
  ctx: AudioContext
  analyser: AnalyserNode
  users: number
  closeTimer: number
  inputId: string
}

let shared: Shared | null = null
let opening: Promise<Shared> | null = null

/** Kept open this long after the last user lets go. */
const LINGER_MS = 8000

const open = async (): Promise<Shared> => {
  const inputId = outputSettings().inputId
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(inputId ? { deviceId: { exact: inputId } } : {}),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
  const ctx = new AudioContext({ latencyHint: 'interactive' })
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(analyser)
  return { stream, ctx, analyser, users: 0, closeTimer: 0, inputId }
}

const close = (s: Shared) => {
  s.stream.getTracks().forEach(t => t.stop())
  void s.ctx.close()
  if (shared === s) shared = null
}

export interface MicHandle {
  stream: MediaStream
  /** RMS level now, 0..1. */
  level(): number
  release(): void
}

/** The shared microphone (opened if needed; a changed device choice reopens it). */
export const acquireMic = async (): Promise<MicHandle> => {
  if (shared && shared.inputId !== outputSettings().inputId && shared.users === 0) close(shared)
  if (!shared || shared.stream.getAudioTracks().every(t => t.readyState === 'ended')) {
    opening ??= open().finally(() => (opening = null))
    shared = await opening
  }
  const s = shared
  clearTimeout(s.closeTimer)
  s.users++
  if (s.ctx.state === 'suspended') await s.ctx.resume()
  const samples = new Float32Array(s.analyser.fftSize)
  let released = false
  return {
    stream: s.stream,
    level: () => {
      s.analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const v of samples) sum += v * v
      return Math.sqrt(sum / samples.length)
    },
    release: () => {
      if (released) return
      released = true
      s.users--
      if (s.users <= 0) s.closeTimer = window.setTimeout(() => s.users <= 0 && close(s), LINGER_MS)
    },
  }
}

/** Close the microphone now (lock, sleep, privacy). */
export const closeMic = () => {
  if (shared) close(shared)
}

/**
 * The room's noise, learned all the time: it falls to a quieter level at once
 * and rises slowly, so a fan that starts mid-sentence is learned within a few
 * seconds while speech itself never becomes "noise".
 */
export class NoiseFloor {
  private floor = Infinity
  update(rms: number, speaking: boolean) {
    if (!Number.isFinite(this.floor)) this.floor = rms
    else if (rms < this.floor) this.floor += (rms - this.floor) * 0.3
    else if (!speaking) this.floor += (rms - this.floor) * 0.02
  }
  get value() {
    return Number.isFinite(this.floor) ? this.floor : 0
  }
}
