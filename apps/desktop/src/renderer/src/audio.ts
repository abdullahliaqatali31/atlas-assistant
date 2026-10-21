/**
 * Microphone capture with an end-of-speech detector, and an ordered player for
 * spoken reply sentences. Both stop instantly so the owner can interrupt at
 * any time. Capture shares one microphone (voice/mic.ts); playback goes
 * through the shared sound chain (voice/output.ts): levelled, clear, loud.
 */
import { acquireMic, NoiseFloor } from './voice/mic.ts'
import { levelFor, voiceOut } from './voice/output.ts'

export interface Recording {
  /** Stop listening; `send` false discards what was recorded. */
  stop(send: boolean): void
}

export interface RecordOptions {
  /** Input level 0..1 for the listening indicator. */
  onLevel?: (level: number) => void
  /** The finished utterance, or null when cancelled or nothing was said. */
  onEnd: (result: { audio: Uint8Array; mime: string } | null, reason: 'sent' | 'cancelled' | 'no-speech') => void
  /** Speech was heard but very quietly: the microphone level is probably too low. */
  onQuiet?: () => void
  /** Silence after speech that ends the utterance. */
  silenceMs?: number
  /** Give up when no speech starts within this time. */
  noSpeechMs?: number
  maxMs?: number
}

const PREFERRED_MIME = 'audio/webm;codecs=opus'
/** Speech peaks below this (RMS) mean the microphone is set too low. */
const QUIET_PEAK = 0.05

export const record = async (opts: RecordOptions): Promise<Recording> => {
  const { silenceMs = 1300, noSpeechMs = 8000, maxMs = 30_000 } = opts
  const mic = await acquireMic()
  const mime = MediaRecorder.isTypeSupported(PREFERRED_MIME) ? PREFERRED_MIME : ''
  const recorder = new MediaRecorder(new MediaStream(mic.stream.getAudioTracks()), mime ? { mimeType: mime } : undefined)
  const parts: Blob[] = []
  recorder.ondataavailable = e => e.data.size > 0 && parts.push(e.data)

  const started = performance.now()
  const floor = new NoiseFloor()
  let heardSpeech = false
  let voicedMs = 0
  let peak = 0
  let lastVoiceAt = started
  let outcome: 'sent' | 'cancelled' | 'no-speech' | null = null

  const finish = (reason: 'sent' | 'cancelled' | 'no-speech') => {
    if (outcome) return
    outcome = reason
    clearInterval(timer)
    if (recorder.state !== 'inactive') recorder.stop()
  }

  recorder.onstop = async () => {
    mic.release()
    opts.onLevel?.(0)
    const reason = outcome ?? 'cancelled'
    if (reason !== 'sent' || !heardSpeech) return opts.onEnd(null, reason === 'sent' ? 'no-speech' : reason)
    if (peak < QUIET_PEAK) opts.onQuiet?.()
    const blob = new Blob(parts, { type: recorder.mimeType || 'audio/webm' })
    opts.onEnd({ audio: new Uint8Array(await blob.arrayBuffer()), mime: blob.type }, 'sent')
  }

  let last = started
  const timer = setInterval(() => {
    const rms = mic.level()
    const now = performance.now()
    const dt = now - last
    last = now
    // Speech is well above the room's noise, which keeps being learned (a fan that starts is not speech).
    const threshold = Math.max(0.012, floor.value * 2.8)
    const voiced = rms > threshold
    floor.update(rms, voiced)
    opts.onLevel?.(Math.min(1, rms / 0.2))
    if (voiced) {
      voicedMs += dt
      // A click is not speech: it takes 120 ms of voice to count.
      if (voicedMs >= 120) heardSpeech = true
      lastVoiceAt = now
      peak = Math.max(peak, rms)
    } else voicedMs = Math.max(0, voicedMs - dt / 2)
    if (heardSpeech && now - lastVoiceAt > silenceMs) finish('sent')
    else if (!heardSpeech && now - started > noSpeechMs) finish('no-speech')
    else if (now - started > maxMs) finish('sent')
  }, 40)

  recorder.start(250)
  return { stop: send => finish(send ? 'sent' : 'cancelled') }
}

/** Plays one reply's sentences strictly in order, as they arrive, levelled and through the sound chain. */
export class SentencePlayer {
  private replyId: string | null = null
  private buffers = new Map<number, AudioBuffer>()
  private next = 0
  private source: AudioBufferSourceNode | null = null
  private decoding = 0
  /** The last sentence's level, so the next one does not jump. */
  private lastGain = 1

  constructor(private readonly onSpeaking: (speaking: boolean) => void) {}

  get isSpeaking() {
    return this.source !== null
  }

  /** Playing, or still holding sentences that have arrived but not played yet. */
  get isBusy() {
    return this.source !== null || this.buffers.size > 0 || this.decoding > 0
  }

  async add(replyId: string, seq: number, data: Uint8Array) {
    if (this.replyId !== replyId) {
      this.stop()
      this.replyId = replyId
    }
    const { ctx } = voiceOut()
    if (ctx.state === 'suspended') await ctx.resume()
    this.decoding++
    let buffer: AudioBuffer
    try {
      buffer = await ctx.decodeAudioData(data.slice().buffer)
    } finally {
      this.decoding--
    }
    if (this.replyId !== replyId) return
    this.buffers.set(seq, buffer)
    this.pump()
  }

  /** Silence now and forget queued sentences. */
  stop() {
    this.replyId = null
    this.buffers.clear()
    this.next = 0
    const playing = this.source
    this.source = null
    if (playing) {
      playing.onended = null
      playing.stop()
      this.onSpeaking(false)
    }
  }

  private pump() {
    if (this.source) return
    const buffer = this.buffers.get(this.next)
    if (!buffer) return
    this.buffers.delete(this.next)
    const { ctx, input } = voiceOut()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    // Level the sentence, eased toward the last one so a reply keeps one loudness.
    const gain = this.next === 0 ? levelFor(buffer) : this.lastGain * 0.6 + levelFor(buffer) * 0.4
    this.lastGain = gain
    const leveller = new GainNode(ctx, { gain })
    source.connect(leveller).connect(input)
    source.onended = () => {
      leveller.disconnect()
      this.source = null
      this.next++
      this.pump()
      if (!this.source) this.onSpeaking(false)
    }
    this.source = source
    source.start()
    this.onSpeaking(true)
  }
}

/**
 * Barge-in: calls `onSpeech` once when the owner starts talking over a spoken
 * reply. It listens on the same microphone as recording (echo cancellation
 * removes most of Atlas's own voice); the bar sits well above the room and
 * the leftover echo, which keep being learned, and must hold for `minMs`, so
 * its own speech or a cough does not cut it off.
 */
export const watchForSpeech = async (onSpeech: () => void, minMs = 350): Promise<() => void> => {
  const mic = await acquireMic()
  const started = performance.now()
  const floor = new NoiseFloor()
  let loudSince: number | null = null
  let done = false
  const stop = () => {
    if (done) return
    done = true
    clearInterval(timer)
    mic.release()
  }
  const timer = setInterval(() => {
    const rms = mic.level()
    const now = performance.now()
    const bar = Math.max(0.04, floor.value * 5)
    const loud = rms > bar
    floor.update(rms, loud)
    // Learn the level of the room plus leftover echo first.
    if (now - started < 400) return
    if (loud) {
      loudSince ??= now
      if (now - loudSince >= minMs) {
        stop()
        onSpeech()
      }
    } else loudSince = null
  }, 40)
  return stop
}
