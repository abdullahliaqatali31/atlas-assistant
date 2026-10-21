import type { LlmProvider, LlmRequest } from '@assistant/providers'
import { describe, expect, it } from 'vitest'

import { visionTool } from './vision.ts'

const fakeLlm = (reply: string | Error, seen: LlmRequest[] = []): LlmProvider => ({
  id: 'fake',
  model: 'fake',
  healthCheck: async () => ({ ok: true }),
  async *stream(req) {
    seen.push(req)
    if (reply instanceof Error) throw reply
    yield { type: 'text', text: reply }
  },
})

const capture = async () => ({ width: 1280, height: 720, data: 'JPEG' })

describe('screen_look', () => {
  it('shows the model the picture with the question, and says what it looked at', async () => {
    const seen: LlmRequest[] = []
    const tool = visionTool({ llm: () => fakeLlm('A red error: "ENOENT: no such file".', seen), capture })
    const out = await tool.run({ question: 'What is the error?' })
    expect(out).toBe('Looked at the window in front (1280×720):\nA red error: "ENOENT: no such file".')
    expect(seen[0]!.turns[0]!.content).toEqual([{ type: 'image', mediaType: 'image/jpeg', data: 'JPEG' }, { type: 'text', text: 'What is the error?' }])
    expect(tool.isUntrusted).toBe(true)
  })

  it('says plainly when the model cannot read pictures', async () => {
    const tool = visionTool({ llm: () => fakeLlm(new Error('This model does not support image input')), capture })
    await expect(tool.run({ question: 'x', what: 'full' })).rejects.toThrow(/cannot read pictures/)
  })
})
