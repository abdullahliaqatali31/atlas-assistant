import { describe, expect, it } from 'vitest'

import { toMessage } from './anthropic.ts'
import type { ChatTurn } from './llm.ts'
import { toMessages } from './openai-compatible.ts'

const turn: ChatTurn = { role: 'user', content: [{ type: 'image', mediaType: 'image/jpeg', data: 'AAAA' }, { type: 'text', text: 'What error is this?' }] }

describe('pictures in an owner turn', () => {
  it('reach Claude as a base64 image block', () => {
    expect(toMessage(turn)).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        { type: 'text', text: 'What error is this?' },
      ],
    })
  })

  it('reach OpenAI-style APIs as a data URL beside the text', () => {
    expect(toMessages('sys', [turn])[1]).toEqual({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
        { type: 'text', text: 'What error is this?' },
      ],
    })
  })
})
