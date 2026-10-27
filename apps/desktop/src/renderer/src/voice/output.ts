/**
 * Everything Atlas says goes through one sound chain, so replies are loud,
 * clear and even on laptop speakers:
 *
 *   clip leveller → high-pass 100 Hz → presence +2.5 dB at 3 kHz →
 *   gentle compressor → loudness (Normal / Loud / Max) → limiter → ceiling
 *
 * Each sentence is levelled to one loudness first (voices and sentences come
 * back from the providers at different levels), the limiter keeps the boost
 * from clipping, and the owner can pick which speakers or headphones play it.
 * The settings live in this window only (they belong to this machine).
 */
import { useSyncExternalStore } from 'react'

export type Loudness = 'normal' | 'loud' | 'max'
export const LOUDNESS: readonly Loudness[] = ['normal', 'loud', 'max']
export const LOUDNESS_LABEL: Record<Loudness, string> = { normal: 'Normal', loud: 'Loud', max: 'Max' }
/** Make-up gain after the compressor, dB. */
const MAKEUP_DB: Record<Loudness, number> = { normal: 2, loud: 6, max: 10 }

export interface OutputSettings {
  loudness: Loudness
  /** Speakers or headphones ('' = the system default). */
  outputId: string
  /** Microphone ('' = the system default). */
  inputId: string
}

const KEY = 'voice.output'
const DEFAULTS: OutputSettings = { loudness: 'loud', outputId: '', inputId: '' }

let settings: OutputSettings = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<OutputSettings> | null
    return {
      loudness: LOUDNESS.includes(raw?.loudness as Loudness) ? (raw!.loudness as Loudness) : DEFAULTS.loudness,
      outputId: typeof raw?.outputId === 'string' ? raw.outputId : '',
      inputId: typeof raw?.inputId === 'string' ? raw.inputId : '',
    }
  } catch {
    return DEFAULTS
  }
})()
const subs = new Set<() => void>()

export const outputSettings = () => settings

export const setOutputSettings = (patch: Partial<OutputSettings>) => {
  settings = { ...settings, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Kept for this session only.
  }
  applySettings()
  for (const s of subs) s()
}

export const useOutputSettings = () =>
  useSyncExternalStore(
    cb => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => settings,
  )

const dbToGain = (db: number) => 10 ** (db / 20)

interface Chain {
  ctx: AudioContext
  /** Where every clip connects. */
  input: AudioNode
  makeup: GainNode
}

let chain: Chain | null = null

/** The shared output context and its chain, made on first use. */
export const voiceOut = (): Chain => {
  if (chain && chain.ctx.state !== 'closed') return chain
  const ctx = new AudioContext({ latencyHint: 'interactive' })
  const highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 100, Q: 0.7 })
  // Presence: speech consonants live here; small laptop speakers lose them first.
  const presence = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 3000, gain: 2.5 })
  // A gentle leveller: evens out loud and soft words inside a sentence.
  const compressor = new DynamicsCompressorNode(ctx, { threshold: -24, knee: 12, ratio: 3.5, attack: 0.003, release: 0.2 })
  const makeup = new GainNode(ctx, { gain: dbToGain(MAKEUP_DB[settings.loudness]) })
  // The limiter: the boost above never clips.
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.05 })
  const ceiling = new GainNode(ctx, { gain: dbToGain(-1) })
  highpass.connect(presence).connect(compressor).connect(makeup).connect(limiter).connect(ceiling).connect(ctx.destination)
  chain = { ctx, input: highpass, makeup }
  applySettings()
  return chain
}

const applySettings = () => {
  if (!chain) return
  chain.makeup.gain.setTargetAtTime(dbToGain(MAKEUP_DB[settings.loudness]), chain.ctx.currentTime, 0.05)
  const sink = (chain.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId
  // A device that has gone away falls back to the default.
  if (sink) void sink.call(chain.ctx, settings.outputId).catch(() => void sink.call(chain!.ctx, '').catch(() => undefined))
}

/**
 * The gain that brings a clip to the target loudness: the RMS of its voiced
 * parts (quiet gaps ignored), aimed at -20 dBFS (about -16 LUFS for speech),
 * kept between 0.5x and 4x so a near-silent clip is not blown up.
 */
export const levelFor = (buffer: AudioBuffer): number => {
  const data = buffer.getChannelData(0)
  const frame = Math.max(1, Math.round(buffer.sampleRate * 0.02))
  let sum = 0
  let count = 0
  for (let i = 0; i + frame <= data.length; i += frame) {
    let s = 0
    for (let j = i; j < i + frame; j++) s += data[j]! * data[j]!
    const rms = Math.sqrt(s / frame)
    // Only frames above -50 dBFS count: pauses would drag the level down.
    if (rms > 0.0032) {
      sum += rms * rms
      count++
    }
  }
  if (!count) return 1
  const rms = Math.sqrt(sum / count)
  return Math.max(0.5, Math.min(4, dbToGain(-20) / rms))
}

/** Route a media element (a voice sample, a live call) through the same chain. */
export const playThroughChain = (el: HTMLMediaElement): (() => void) => {
  const { ctx, input } = voiceOut()
  if (ctx.state === 'suspended') void ctx.resume()
  const src = ctx.createMediaElementSource(el)
  src.connect(input)
  return () => src.disconnect()
}

/** Route a live stream (the realtime voice) through the chain. */
export const streamThroughChain = (stream: MediaStream): (() => void) => {
  const { ctx, input } = voiceOut()
  if (ctx.state === 'suspended') void ctx.resume()
  const src = ctx.createMediaStreamSource(stream)
  src.connect(input)
  return () => src.disconnect()
}
