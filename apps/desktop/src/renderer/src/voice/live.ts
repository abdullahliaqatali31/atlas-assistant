/**
 * One live voice call: the microphone and OpenAI Realtime over WebRTC (audio
 * both ways, events on a data channel). The session itself (model, voice,
 * instructions, tools) was fixed by main when it minted the token.
 *
 * While Atlas's mind works on an ask_atlas call the microphone is muted, a
 * soft two-note tick plays after 0.7 s, and after 2.5 s one short spoken
 * "one moment" goes out of band (not added to the conversation). Every
 * response's usage is priced; the call ends itself at the owner's cap.
 */
import { LIVE_MODELS, usageCost, type LiveSession, type RealtimeUsage } from '../../../shared/livevoice.ts'

export type LivePhase = 'connecting' | 'listening' | 'thinking' | 'speaking'

export interface LiveCallbacks {
  onPhase(p: LivePhase): void
  /** What the owner said (transcribed for captions). */
  onHeard(text: string): void
  /** What the voice is saying, as it says it. */
  onSaid(text: string, done: boolean): void
  onLevel(level: number): void
  onCost(usd: number): void
  /** Run the request through Atlas's mind; resolve with what to say. */
  onAsk(request: string): Promise<string>
  onEnd(reason: string | null): void
}

const CALLS = 'https://api.openai.com/v1/realtime/calls'
const EARCON_MS = 700
const PROGRESS_MS = 2_500
const ASK_TIMEOUT_MS = 120_000

/** A soft two-note "still working" tick. */
const earcon = (ctx: AudioContext) => {
  const t = ctx.currentTime
  for (const [i, f] of [660, 880].entries()) {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.value = f
    g.gain.setValueAtTime(0, t + i * 0.09)
    g.gain.linearRampToValueAtTime(0.05, t + i * 0.09 + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.08)
    o.connect(g).connect(ctx.destination)
    o.start(t + i * 0.09)
    o.stop(t + i * 0.09 + 0.1)
  }
}

const rms = (a: AnalyserNode, buf: Uint8Array<ArrayBuffer>) => {
  a.getByteTimeDomainData(buf)
  let sum = 0
  for (const v of buf) sum += ((v - 128) / 128) ** 2
  return Math.min(1, Math.sqrt(sum / buf.length) * 4)
}

export class LiveCall {
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private mic: MediaStream | null = null
  private audio: HTMLAudioElement | null = null
  private ctx: AudioContext | null = null
  private micA: AnalyserNode | null = null
  private outA: AnalyserNode | null = null
  private levelTimer: ReturnType<typeof setInterval> | null = null
  private phase: LivePhase = 'connecting'
  private said = ''
  private usd = 0
  private handled = new Set<string>()
  private ended = false
  private endAfterSpeech = false

  constructor(
    private readonly session: LiveSession,
    private readonly cb: LiveCallbacks,
  ) {}

  get cost() {
    return this.usd
  }

  private set(p: LivePhase) {
    if (this.phase === p) return
    this.phase = p
    this.cb.onPhase(p)
  }

  private send(ev: Record<string, unknown>) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(ev))
  }

  async start() {
    this.cb.onPhase('connecting')
    if (this.session.expiresAt && this.session.expiresAt * 1000 < Date.now()) throw new Error('The live session expired before it started; try again.')
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    const pc = new RTCPeerConnection()
    this.pc = pc
    this.ctx = new AudioContext()
    const buf = new Uint8Array(new ArrayBuffer(512))
    this.micA = this.ctx.createAnalyser()
    this.micA.fftSize = 512
    this.ctx.createMediaStreamSource(this.mic).connect(this.micA)
    this.audio = new Audio()
    this.audio.autoplay = true
    pc.ontrack = e => {
      const stream = e.streams[0]
      if (!stream || !this.audio || !this.ctx) return
      this.audio.srcObject = stream
      this.outA = this.ctx.createAnalyser()
      this.outA.fftSize = 512
      this.ctx.createMediaStreamSource(stream).connect(this.outA)
    }
    for (const t of this.mic.getAudioTracks()) pc.addTrack(t, this.mic)
    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    dc.onmessage = e => {
      try {
        this.onEvent(JSON.parse(String(e.data)) as Record<string, unknown>)
      } catch {
        // Not JSON: ignore.
      }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.stop('The live connection dropped.')
    }
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const res = await fetch(CALLS, { method: 'POST', body: offer.sdp ?? '', cache: 'no-store', headers: { Authorization: `Bearer ${this.session.token}`, 'Content-Type': 'application/sdp' } })
    if (!res.ok) throw new Error(res.status === 401 ? 'The live session was refused; try again.' : `Live voice could not connect (${res.status}).`)
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
    this.levelTimer = setInterval(() => {
      const a = this.phase === 'speaking' ? this.outA : this.phase === 'listening' ? this.micA : null
      this.cb.onLevel(a ? rms(a, buf) : 0)
    }, 60)
    this.set('listening')
  }

  private onEvent(ev: Record<string, unknown>) {
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.set('listening')
        break
      case 'input_audio_buffer.speech_stopped':
        this.set('thinking')
        break
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof ev.transcript === 'string' && ev.transcript.trim()) this.cb.onHeard(ev.transcript.trim())
        break
      case 'response.output_audio_transcript.delta':
        if (typeof ev.delta === 'string') {
          this.said += ev.delta
          this.cb.onSaid(this.said, false)
        }
        break
      case 'response.output_audio_transcript.done':
        if (typeof ev.transcript === 'string' && ev.transcript) this.cb.onSaid(ev.transcript, true)
        this.said = ''
        break
      case 'output_audio_buffer.started':
        this.set('speaking')
        break
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        if (this.endAfterSpeech) return this.stop(null)
        this.set('listening')
        break
      case 'response.function_call_arguments.done':
        void this.call(String(ev.call_id ?? ''), String(ev.name ?? ''), String(ev.arguments ?? '{}'))
        break
      case 'response.done': {
        const usage = (ev.response as { usage?: RealtimeUsage } | undefined)?.usage
        if (usage) {
          this.usd += usageCost(usage, LIVE_MODELS[this.session.tier].rates)
          this.cb.onCost(this.usd)
          if (this.usd >= this.session.capUsd) this.stop(`Live voice stopped at your $${this.session.capUsd.toFixed(2)} limit for one conversation.`)
        }
        break
      }
      case 'error': {
        const msg = (ev.error as { message?: string } | undefined)?.message ?? 'Live voice error.'
        // A cancel with nothing to cancel is harmless.
        if (!/no active response|cancel/i.test(msg)) console.warn('[live]', msg)
        break
      }
    }
  }

  private async call(callId: string, name: string, args: string) {
    if (!callId || this.handled.has(callId)) return
    this.handled.add(callId)
    if (name === 'end_conversation') {
      this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: 'ok' } })
      // Let the goodbye finish playing first.
      this.endAfterSpeech = true
      setTimeout(() => this.stop(null), 4_000)
      return
    }
    let request = ''
    try {
      request = String((JSON.parse(args) as { request?: unknown }).request ?? '').slice(0, 4000)
    } catch {
      // Bad arguments: answered below.
    }
    this.set('thinking')
    const track = this.mic?.getAudioTracks()[0]
    if (track) track.enabled = false
    const tick = setTimeout(() => this.ctx && earcon(this.ctx), EARCON_MS)
    const progress = setTimeout(
      () =>
        this.send({
          type: 'response.create',
          response: { conversation: 'none', tool_choice: 'none', max_output_tokens: 60, instructions: 'Say only a very short "one moment, checking" in the language the owner is speaking (for Urdu: "Ek second, dekh raha hoon"). Nothing else.' },
        }),
      PROGRESS_MS,
    )
    let output: string
    try {
      output = request
        ? await Promise.race([this.cb.onAsk(request), new Promise<string>(r => setTimeout(() => r('Atlas is still working on it; tell the owner it will show up in the chat when ready.'), ASK_TIMEOUT_MS))])
        : 'The request was empty; ask the owner again.'
    } catch (e) {
      output = `Atlas could not do it: ${e instanceof Error ? e.message : 'unknown error'}`
    } finally {
      clearTimeout(tick)
      clearTimeout(progress)
      if (track) track.enabled = true
    }
    if (this.ended) return
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: output.slice(0, 6000) } })
    this.send({ type: 'response.create' })
  }

  /** Stop what the voice is saying now (the owner's Stop / barge-in). */
  cancel() {
    this.send({ type: 'response.cancel' })
    this.send({ type: 'output_audio_buffer.clear' })
    this.set('listening')
  }

  stop(reason: string | null) {
    if (this.ended) return
    this.ended = true
    if (this.levelTimer) clearInterval(this.levelTimer)
    for (const t of this.mic?.getTracks() ?? []) t.stop()
    try {
      this.dc?.close()
      this.pc?.close()
    } catch {
      // Already closed.
    }
    if (this.audio) this.audio.srcObject = null
    void this.ctx?.close().catch(() => undefined)
    this.cb.onEnd(reason)
  }
}
