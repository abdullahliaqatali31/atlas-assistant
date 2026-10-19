import { describe, expect, it } from 'vitest'

import { parseChatModelChoice } from '../../shared/ipc.ts'
import { prettyModel } from './ModelChip.tsx'

describe('model chip', () => {
  it('accepts only sane choices', () => {
    expect(parseChatModelChoice({ kind: 'auto' })).toEqual({ kind: 'auto' })
    expect(parseChatModelChoice({ kind: 'model', provider: 'openrouter', model: 'anthropic/claude-opus-5.5' })).toEqual({ kind: 'model', provider: 'openrouter', model: 'anthropic/claude-opus-5.5' })
    expect(parseChatModelChoice({ kind: 'model', provider: 'nope', model: 'x' })).toBeNull()
    expect(parseChatModelChoice({ kind: 'model', provider: 'openai', model: 'a b; rm' })).toBeNull()
    expect(parseChatModelChoice(null)).toBeNull()
  })

  it('names models the way people say them', () => {
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(prettyModel('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(prettyModel('gpt-5.1-mini')).toBe('GPT 5.1 mini')
  })
})
