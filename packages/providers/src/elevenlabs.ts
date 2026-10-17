import type { SttProvider, SttResult, TtsProvider, VoiceProvider } from './voice.ts'

const BASE = 'https://api.elevenlabs.io/v1'

/**
 * ElevenLabs adapter (Scribe for STT, streaming TTS). Endpoint shapes follow
 * the public docs; not yet validated against the live API in this repo, which
 * is what the Phase 0 voice bake-off is for.
 */
export class ElevenLabsVoice implements VoiceProvider {
  readonly stt: SttProvider
  readonly tts: TtsProvider

  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
    private readonly models = { tts: 'eleven_multilingual_v2', stt: 'scribe_v1' },
  ) {
    this.stt = { id: 'elevenlabs-scribe', transcribe: (audio, opts) => this.transcribe(audio, opts) }
    this.tts = { id: 'elevenlabs-tts', synthesize: (text, opts) => this.synthesize(text, opts) }
  }

  private headers(extra: Record<string, string> = {}) {
    return { 'xi-api-key': this.apiKey, ...extra }
  }

  private async transcribe(audio: Blob, opts: { languageHint?: string; signal?: AbortSignal } = {}): Promise<SttResult> {
    const form = new FormData()
    form.append('model_id', this.models.stt)
    form.append('file', audio, 'utterance.webm')
    if (opts.languageHint) form.append('language_code', opts.languageHint)
    const res = await fetch(`${BASE}/speech-to-text`, { method: 'POST', headers: this.headers(), body: form, signal: opts.signal })
    if (!res.ok) throw new Error(`ElevenLabs STT failed: ${res.status} ${await res.text()}`)
    const body = (await res.json()) as { text: string; language_code?: string }
    return { text: body.text, languageCode: body.language_code ?? null }
  }

  private async *synthesize(text: string, opts: { signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
    const res = await fetch(`${BASE}/text-to-speech/${encodeURIComponent(this.voiceId)}/stream`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', accept: 'audio/mpeg' }),
      body: JSON.stringify({ text, model_id: this.models.tts }),
      signal: opts.signal,
    })
    if (!res.ok || !res.body) throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`)
    const reader = res.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        yield value
      }
    } finally {
      reader.releaseLock()
    }
  }

  async healthCheck() {
    try {
      const res = await fetch(`${BASE}/voices/${encodeURIComponent(this.voiceId)}`, { headers: this.headers() })
      if (res.status === 401) return { ok: false as const, error: 'The ElevenLabs key was rejected.' }
      if (res.status === 404) return { ok: false as const, error: `Voice ${this.voiceId} was not found.` }
      if (!res.ok) return { ok: false as const, error: `ElevenLabs returned ${res.status}.` }
      return { ok: true as const }
    } catch {
      return { ok: false as const, error: 'Could not reach ElevenLabs.' }
    }
  }
}
