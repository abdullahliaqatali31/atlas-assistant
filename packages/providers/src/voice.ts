/**
 * Voice contracts. Speech-to-text and text-to-speech are configured
 * independently; every adapter supports cancellation so an interruption stops
 * playback and drops queued audio from the previous reply.
 */

export interface SttResult {
  text: string
  languageCode: string | null
}

export interface SttProvider {
  readonly id: string
  /** Transcribe one utterance (already endpointed by VAD). */
  transcribe(audio: Blob, opts?: { languageHint?: string; signal?: AbortSignal }): Promise<SttResult>
}

export interface TtsProvider {
  readonly id: string
  /** Streams encoded audio chunks for one sentence or clause. */
  synthesize(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<Uint8Array>
}

export interface VoiceProvider {
  stt: SttProvider
  tts: TtsProvider
  healthCheck(): Promise<{ ok: true } | { ok: false; error: string }>
}

/**
 * Split streamed LLM text into speakable chunks so TTS can start on the first
 * sentence instead of waiting for the whole reply.
 */
export const sentenceChunker = () => {
  let buffer = ''
  return {
    push(text: string): string[] {
      buffer += text
      const out: string[] = []
      const re = /[^.!?۔؟\n]+[.!?۔؟\n]+(\s|$)/gu
      let match: RegExpExecArray | null
      let consumed = 0
      while ((match = re.exec(buffer)) !== null) {
        const s = match[0].trim()
        if (s) out.push(s)
        consumed = re.lastIndex
      }
      buffer = buffer.slice(consumed)
      return out
    },
    flush(): string[] {
      const rest = buffer.trim()
      buffer = ''
      return rest ? [rest] : []
    },
  }
}
