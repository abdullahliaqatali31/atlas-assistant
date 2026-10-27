/**
 * Turns a streaming text reply into ordered spoken sentences. Sentences are
 * synthesized one at a time (free voice plans allow few concurrent requests)
 * while the LLM keeps streaming, so audio starts after the first sentence.
 */
import { sentenceChunker, type TtsProvider } from '@assistant/providers'

/** Strip markdown and other things that should not be read aloud. */
export const speakable = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/[*_#>~|]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Resolves with the iterator's next value, or rejects as soon as `signal`
 * aborts, even when the provider ignores the signal. This is what keeps
 * barge-in under 250 ms whatever the network does.
 */
const nextOrAbort = <T>(it: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> => {
  if (signal.aborted) return Promise.reject(new DOMException('Interrupted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Interrupted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    it.next().then(
      r => {
        signal.removeEventListener('abort', onAbort)
        resolve(r)
      },
      e => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

export interface Speaker {
  /** Feed streamed reply text; complete sentences are queued for speech. */
  push(text: string): void
  /** Queue whatever is left and resolve once every sentence was sent or dropped. */
  finish(): Promise<void>
  /** Sentences queued but not yet sent, for diagnostics. */
  readonly queued: number
}

export const createSpeaker = (opts: {
  tts: TtsProvider
  signal: AbortSignal
  onAudio: (seq: number, data: Uint8Array) => void
  onError: (message: string) => void
}): Speaker => {
  const chunker = sentenceChunker()
  let chain = Promise.resolve()
  let seq = 0
  let failed = false
  let sent = 0
  // Barge-in: drop everything queued at once; the chain then drains without synthesizing.
  opts.signal.addEventListener('abort', () => (chain = Promise.resolve()), { once: true })

  const say = (sentence: string) => {
    const text = speakable(sentence)
    if (!/[\p{L}\p{N}]/u.test(text)) return
    const n = seq++
    if (opts.signal.aborted) return
    chain = chain.then(async () => {
      sent++
      if (failed || opts.signal.aborted) return
      const it = opts.tts.synthesize(text, { signal: opts.signal })[Symbol.asyncIterator]()
      try {
        const parts: Uint8Array[] = []
        for (let r = await nextOrAbort(it, opts.signal); !r.done; r = await nextOrAbort(it, opts.signal)) parts.push(r.value)
        if (opts.signal.aborted) return
        const data = new Uint8Array(parts.reduce((len, p) => len + p.byteLength, 0))
        let at = 0
        for (const p of parts) {
          data.set(p, at)
          at += p.byteLength
        }
        opts.onAudio(n, data)
      } catch (error) {
        if (opts.signal.aborted) {
          // Let the provider close its request; never wait for it.
          void it.return?.().catch(() => undefined)
          return
        }
        // One failure (quota, network) silences the rest of this reply; the text still arrives.
        failed = true
        opts.onError(error instanceof Error ? error.message : String(error))
      }
    })
  }

  return {
    push: text => chunker.push(text).forEach(say),
    finish: () => {
      chunker.flush().forEach(say)
      return chain
    },
    get queued() {
      return opts.signal.aborted ? 0 : seq - sent
    },
  }
}
