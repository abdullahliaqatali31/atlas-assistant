import type { SttProvider, SttResult, TtsProvider, VoiceProvider } from './voice.ts'

/** Azure neural voices with real Pakistani Urdu; both are on the free (F0) tier. */
export const AZURE_URDU_VOICES = ['ur-PK-UzmaNeural', 'ur-PK-AsadNeural'] as const
export const DEFAULT_AZURE_VOICE = 'ur-PK-UzmaNeural'

/** Speech regions are lowercase letters and digits, e.g. "eastus", "centralindia". */
export const isAzureRegion = (v: string) => /^[a-z][a-z0-9]{2,30}$/.test(v)

/** Voice names look like "ur-PK-UzmaNeural" or "en-US-AvaMultilingualNeural". */
export const isAzureVoiceName = (v: string) => /^[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z0-9]+Neural$/.test(v)

/**
 * Owner language codes (from onboarding or ASSISTANT_LANGUAGES) to Azure
 * recognition locales. Roman Urdu is spoken Urdu, so it maps to ur-PK.
 */
export const azureLocale = (code: string | undefined): string | undefined => {
  if (!code) return undefined
  const c = code.toLowerCase()
  if (c === 'ur' || c.startsWith('ur-')) return 'ur-PK'
  if (c === 'en' || c === 'en-latn') return 'en-US'
  if (/^[a-z]{2}-[a-z]{2}$/.test(c)) return `${c.slice(0, 2)}-${c.slice(3).toUpperCase()}`
  return undefined
}

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]!)

/** SSML for one sentence; the voice's own locale sets xml:lang. */
export const azureSsml = (text: string, voice: string) => {
  const lang = voice.split('-').slice(0, 2).join('-')
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`
}

/**
 * Azure AI Speech adapter (free F0 tier works). TTS uses the REST endpoint,
 * which streams MP3 as it is synthesized; STT uses the fast transcription
 * API, which accepts the companion's WebM/Opus recordings directly.
 * Endpoint shapes follow the public docs; the Phase 0 bake-off validates them
 * against real owner sentences.
 */
export class AzureSpeechVoice implements VoiceProvider {
  readonly stt: SttProvider
  readonly tts: TtsProvider

  constructor(
    private readonly apiKey: string,
    private readonly region: string,
    private readonly voice = DEFAULT_AZURE_VOICE,
    /** Locales tried when the caller gives no hint; several enable language identification. */
    private readonly defaultLocales: string[] = ['ur-PK', 'en-US'],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!isAzureRegion(region)) throw new Error(`"${region}" is not an Azure Speech region (for example eastus or centralindia).`)
    this.stt = { id: 'azure-stt', transcribe: (audio, opts) => this.transcribe(audio, opts) }
    this.tts = { id: 'azure-tts', synthesize: (text, opts) => this.synthesize(text, opts) }
  }

  private get ttsBase() {
    return `https://${this.region}.tts.speech.microsoft.com`
  }

  private async transcribe(audio: Blob, opts: { languageHint?: string; signal?: AbortSignal } = {}): Promise<SttResult> {
    const hinted = azureLocale(opts.languageHint)
    const form = new FormData()
    form.append('audio', audio, 'utterance.webm')
    form.append('definition', JSON.stringify({ locales: hinted ? [hinted] : this.defaultLocales, profanityFilterMode: 'None' }))
    const res = await this.fetchImpl(`https://${this.region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': this.apiKey },
      body: form,
      signal: opts.signal,
    })
    if (!res.ok) throw new Error(`Azure STT failed: ${res.status} ${await res.text()}`)
    const body = (await res.json()) as { combinedPhrases?: { text?: string }[]; phrases?: { locale?: string }[] }
    const text = (body.combinedPhrases ?? []).map(p => p.text ?? '').join(' ').trim()
    return { text, languageCode: body.phrases?.[0]?.locale ?? hinted ?? null }
  }

  private async *synthesize(text: string, opts: { signal?: AbortSignal } = {}): AsyncIterable<Uint8Array> {
    const res = await this.fetchImpl(`${this.ttsBase}/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.apiKey,
        'Content-Type': 'application/ssml+xml',
        // MP3 like the ElevenLabs path, so the companion plays both the same way.
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'personal-assistant',
      },
      body: azureSsml(text, this.voice),
      signal: opts.signal,
    })
    if (!res.ok || !res.body) throw new Error(`Azure TTS failed: ${res.status} ${await res.text()}`)
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

  /** Lists voices: checks the key, the region and that the chosen voice exists, without billing. */
  async healthCheck() {
    try {
      const res = await this.fetchImpl(`${this.ttsBase}/cognitiveservices/voices/list`, { headers: { 'Ocp-Apim-Subscription-Key': this.apiKey } })
      if (res.status === 401 || res.status === 403) return { ok: false as const, error: `The Azure Speech key was rejected for region ${this.region}.` }
      if (!res.ok) return { ok: false as const, error: `Azure Speech returned ${res.status}.` }
      const voices = (await res.json()) as { ShortName?: string }[]
      if (!voices.some(v => v.ShortName === this.voice)) return { ok: false as const, error: `Voice ${this.voice} is not available in ${this.region}.` }
      return { ok: true as const }
    } catch {
      return { ok: false as const, error: `Could not reach Azure Speech in ${this.region}.` }
    }
  }
}
