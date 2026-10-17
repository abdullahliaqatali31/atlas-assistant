/**
 * Microphone capture with a small energy-based end-of-speech detector, and an
 * ordered player for spoken reply sentences. Both stop instantly so the owner
 * can interrupt at any time.
 */

export interface Recording {
  /** Stop listening; `send` false discards what was recorded. */
  stop(send: boolean): void
}

export interface RecordOptions {
  /** Input level 0..1 for the listening indicator. */
  onLevel?: (level: number) => void
  /** The finished utterance, or null when cancelled or nothing was said. */
  onEnd: (result: { audio: Uint8Array; mime: string } | null, reason: 'sent' | 'cancelled' | 'no-speech') => void
  /** Silence after speech that ends the utterance. */
  silenceMs?: number
  /** Give up when no speech starts within this time. */
  noSpeechMs?: number
  maxMs?: number
}

const PREFERRED_MIME = 'audio/webm;codecs=opus'

export const record = async (opts: RecordOptions): Promise<Recording> => {
  const { silenceMs = 1300, noSpeechMs = 8000, maxMs = 30_000 } = opts
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  const mime = MediaRecorder.isTypeSupported(PREFERRED_MIME) ? PREFERRED_MIME : ''
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  const parts: Blob[] = []
  recorder.ondataavailable = e => e.data.size > 0 && parts.push(e.data)

  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(analyser)
  const samples = new Float32Array(analyser.fftSize)

  const started = performance.now()
  let noiseFloor = Infinity
  let heardSpeech = false
  let lastVoiceAt = started
  let outcome: 'sent' | 'cancelled' | 'no-speech' | null = null

  const finish = (reason: 'sent' | 'cancelled' | 'no-speech') => {
    if (outcome) return
    outcome = reason
    clearInterval(timer)
    if (recorder.state !== 'inactive') recorder.stop()
  }

  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop())
    void ctx.close()
    opts.onLevel?.(0)
    const reason = outcome ?? 'cancelled'
    if (reason !== 'sent' || !heardSpeech) return opts.onEnd(null, reason === 'sent' ? 'no-speech' : reason)
    const blob = new Blob(parts, { type: recorder.mimeType || 'audio/webm' })
    opts.onEnd({ audio: new Uint8Array(await blob.arrayBuffer()), mime: blob.type }, 'sent')
  }

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const s of samples) sum += s * s
    const rms = Math.sqrt(sum / samples.length)
    const now = performance.now()
    // Learn the room's noise in the first 300 ms, then call anything well above it speech.
    if (now - started < 300) noiseFloor = Math.min(noiseFloor, rms)
    const threshold = Math.max(0.015, (Number.isFinite(noiseFloor) ? noiseFloor : 0) * 3)
    opts.onLevel?.(Math.min(1, rms / 0.2))
    if (rms > threshold) {
      heardSpeech = true
      lastVoiceAt = now
    }
    if (heardSpeech && now - lastVoiceAt > silenceMs) finish('sent')
    else if (!heardSpeech && now - started > noSpeechMs) finish('no-speech')
    else if (now - started > maxMs) finish('sent')
  }, 50)

  recorder.start(250)
  return { stop: send => finish(send ? 'sent' : 'cancelled') }
}

/** Plays one reply's sentences strictly in order, as they arrive. */
export class SentencePlayer {
  private ctx: AudioContext | null = null
  private replyId: string | null = null
  private buffers = new Map<number, AudioBuffer>()
  private next = 0
  private source: AudioBufferSourceNode | null = null
  private decoding = 0

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
    this.ctx ??= new AudioContext()
    this.decoding++
    let buffer: AudioBuffer
    try {
      buffer = await this.ctx.decodeAudioData(data.slice().buffer)
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
    if (this.source || !this.ctx) return
    const buffer = this.buffers.get(this.next)
    if (!buffer) return
    this.buffers.delete(this.next)
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.ctx.destination)
    source.onended = () => {
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
 * reply. Echo cancellation removes most of the assistant's own voice; the bar
 * is set well above the room (and echo) level and must hold for `minMs`, so
 * its own speech or a cough does not cut it off.
 */
export const watchForSpeech = async (onSpeech: () => void, minMs = 350): Promise<() => void> => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } })
  const ctx = new AudioContext()
  if (ctx.state === 'suspended') await ctx.resume()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(analyser)
  const samples = new Float32Array(analyser.fftSize)
  const started = performance.now()
  let floor = Infinity
  let loudSince: number | null = null
  let done = false
  const stop = () => {
    if (done) return
    done = true
    clearInterval(timer)
    stream.getTracks().forEach(t => t.stop())
    void ctx.close()
  }
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const s of samples) sum += s * s
    const rms = Math.sqrt(sum / samples.length)
    const now = performance.now()
    // Learn the level of the room plus leftover echo during the first 400 ms.
    if (now - started < 400) {
      floor = Math.min(floor, rms)
      return
    }
    const bar = Math.max(0.04, (Number.isFinite(floor) ? floor : 0) * 6)
    if (rms > bar) {
      loudSince ??= now
      if (now - loudSince >= minMs) {
        stop()
        onSpeech()
      }
    } else loudSince = null
  }, 50)
  return stop
}
