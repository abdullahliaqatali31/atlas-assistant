/**
 * Voice ID in the page: recordings decoded to 16 kHz mono (what the voice
 * model reads), and whether Voice ID is on, kept current for the
 * conversation and the wake word.
 */
import { samplesToBytes, SPK_RATE, type SpeakerView } from '../../../shared/speaker.ts'

let view: SpeakerView | null = null
let started = false

/** The latest Voice ID state (null until it is known). */
export const speakerView = () => {
  if (!started) {
    started = true
    void window.speaker.state().then(v => (view = v), () => undefined)
    window.speaker.onChanged(v => (view = v))
  }
  return view
}

/** Voice messages should carry 16 kHz samples: Voice ID is set up and on. */
export const voiceIdOn = () => {
  const v = speakerView()
  return Boolean(v && v.enabled && v.model.status === 'ready' && v.people.some(p => p.owner))
}

/** Any recording the browser can play → 16 kHz mono samples. */
export const toPcm16k = async (audio: Uint8Array): Promise<Float32Array> => {
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(audio.slice().buffer)
    const frames = Math.ceil(decoded.duration * SPK_RATE)
    const off = new OfflineAudioContext(1, frames, SPK_RATE)
    const src = new AudioBufferSourceNode(off, { buffer: decoded })
    src.connect(off.destination)
    src.start()
    return (await off.startRendering()).getChannelData(0)
  } finally {
    void ctx.close()
  }
}

/** The bytes Voice ID needs for a recording, or undefined when it is off or decoding fails. */
export const pcmFor = async (audio: Uint8Array): Promise<Uint8Array | undefined> => {
  if (!voiceIdOn()) return undefined
  try {
    return samplesToBytes(await toPcm16k(audio))
  } catch {
    return undefined
  }
}
