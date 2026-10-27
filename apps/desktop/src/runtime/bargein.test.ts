import type { TtsProvider } from '@assistant/providers'
import { describe, expect, it } from 'vitest'

import { AudioGate } from '../main/bargein.ts'
import type { ReplyEvent } from '../shared/ipc.ts'
import { createSpeaker } from './speaker.ts'

const BUDGET_MS = 250
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A slow cloud TTS: each sentence streams for `ms`. `ignoreAbort` models a provider that never looks at the signal. */
const slowTts = (ms: number, ignoreAbort = false) => {
  const started: string[] = []
  const tts: TtsProvider = {
    id: 'slow',
    async *synthesize(text, opts) {
      started.push(text)
      for (let i = 0; i < 4; i++) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, ms / 4)
          if (!ignoreAbort)
            opts?.signal?.addEventListener('abort', () => {
              clearTimeout(t)
              reject(new DOMException('aborted', 'AbortError'))
            })
        })
        yield Uint8Array.from([i])
      }
    },
  }
  return { tts, started }
}

describe('barge-in', () => {
  for (const ignoreAbort of [false, true]) {
    it(`cancels playback and queued TTS within ${BUDGET_MS} ms${ignoreAbort ? ' even if the provider ignores the token' : ''}`, async () => {
      const { tts, started } = slowTts(2_000, ignoreAbort)
      const abort = new AbortController()
      const audio: number[] = []
      const errors: string[] = []
      const speaker = createSpeaker({ tts, signal: abort.signal, onAudio: seq => audio.push(seq), onError: m => errors.push(m) })
      speaker.push('Pehla jumla. Doosra jumla. Teesra jumla. ')
      const done = speaker.finish()
      await sleep(50)
      expect(started).toEqual(['Pehla jumla.'])
      expect(speaker.queued).toBe(2)

      const t0 = performance.now()
      abort.abort()
      await done
      const elapsed = performance.now() - t0

      expect(elapsed).toBeLessThan(BUDGET_MS)
      expect(speaker.queued).toBe(0)
      // Nothing was spoken, the queued sentences never reached the provider, and an interruption is not an error.
      await sleep(30)
      expect(audio).toEqual([])
      expect(started).toEqual(['Pehla jumla.'])
      expect(errors).toEqual([])
      // Text that streams in after the interruption is not queued either.
      speaker.push('Chautha jumla. ')
      await speaker.finish()
      expect(started).toHaveLength(1)
    })
  }

  it('main drops in-flight audio of an interrupted reply but keeps its text', () => {
    const gate = new AudioGate(() => 1_000)
    const audio = (replyId: string, seq: number): ReplyEvent => ({ replyId, type: 'audio', seq, data: new Uint8Array(1) })
    expect(gate.allows(audio('r1', 0))).toBe(true)
    expect(gate.interrupt(null)).toBe(false)
    expect(gate.interrupt('r1')).toBe(true)
    expect(gate.lastInterruptAt).toBe(1_000)
    expect(gate.allows(audio('r1', 1))).toBe(false)
    expect(gate.allows({ replyId: 'r1', type: 'chunk', text: 'baqi' })).toBe(true)
    expect(gate.allows({ replyId: 'r1', type: 'done', stopped: true })).toBe(true)
    // The next reply plays normally.
    expect(gate.allows(audio('r2', 0))).toBe(true)
  })
})
