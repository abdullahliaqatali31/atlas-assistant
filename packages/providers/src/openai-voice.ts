import type { SttProvider, SttResult, TtsProvider, VoiceProvider } from './voice.ts'

const BASE = 'https://api.openai.com/v1'

/**
 * OpenAI (ChatGPT) voice: gpt-4o-mini-transcribe hears, gpt-4o-mini-tts speaks
 * (streamed MP3). Uses the same OpenAI key as Live voice, so one key covers
 * both and no other voice service is needed.
 */
export class OpenAiVoice implements VoiceProvider {
  readonly stt: SttProvider
  readonly tts: TtsProvider

  constructor(
    private readonly apiKey: string,
    private readonly voice: string,
    private readonly models = { tts: 'gpt-4o-mini-tts', stt: 'gpt-4o-mini-transcribe' },
  ) {
    this.stt = { id: 'openai-transcribe', transcribe: (audio, opts) => this.transcribe(audio, opts) }
    this.tts = { id: 'openai-tts', synthesize: (text, opts) => this.synthesize(text, opts) }
  }

  private async transcribe(audio: Blob, opts: { languageHint?: string; signal?: AbortSignal } = {}): Promise<SttResult> {
    const form = new FormData()
    form.append('model', this.models.stt)
    form.append('file', audio, 'utterance.webm')
    // OpenAI takes ISO-639-1 ("ur", "en"); a hint like "ur-Latn" is trimmed to its language.
    const lang = opts.languageHint?.split(/[-_]/)[0]
    if (lang && /^[a-z]{2}$/.test(lang)) form.append('language', lang)
    const res = await fetch(`${BASE}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body: form, signal: opts.signal })
    if (!res.ok) throw new Error(`OpenAI transcription failed: ${res.status} ${await res.text()}`)
    const body = (await res.json()) as { text: string; language?: string }
    return { text: body.text, languageCode: body.language ?? lang ?? null }
  }

  private async *synthesize(text: string, opts: { signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
    const res = await fetch(`${BASE}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.models.tts, voice: this.voice, input: text, response_format: 'mp3', instructions: 'Speak naturally and warmly, at a relaxed conversational pace.' }),
      signal: opts.signal,
    })
    if (!res.ok || !res.body) throw new Error(`OpenAI speech failed: ${res.status} ${await res.text()}`)
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
      const res = await fetch(`${BASE}/models/${this.models.tts}`, { headers: { Authorization: `Bearer ${this.apiKey}` } })
      if (res.status === 401) return { ok: false as const, error: 'The OpenAI key was rejected.' }
      if (!res.ok) return { ok: false as const, error: `OpenAI returned ${res.status}.` }
      return { ok: true as const }
    } catch {
      return { ok: false as const, error: 'Could not reach OpenAI.' }
    }
  }
}
