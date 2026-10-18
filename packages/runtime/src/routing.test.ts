import { modelFor } from '@assistant/providers'
import { describe, expect, it } from 'vitest'

import { routeMessage } from './routing.ts'

describe('routeMessage', () => {
  it('sends greetings, thanks and short chat to the quick model', () => {
    for (const t of ['salam', 'kya haal hai', 'shukriya yaar', 'theek hai', 'good morning!', 'haha nice']) expect(routeMessage(t), t).toBe('quick')
  })

  it('sends work, tools, reasoning and long messages to the main model', () => {
    for (const t of [
      'aaj ki important news map pe dikhao',
      'Ahmed ko email bhej do',
      'kal ka schedule kya hai',
      'why is the sky blue',
      'yeh code fix karo',
      'Karachi ka mausam',
      'open https://example.com',
      'a'.repeat(200),
      'first line\nsecond line',
    ])
      expect(routeMessage(t), t).toBe('main')
  })
})

describe('modelFor quick', () => {
  it('uses the provider’s quick default, the owner’s choice, or the main model', () => {
    expect(modelFor({ provider: 'anthropic', apiKey: 'k' }, 'quick')).toBe('claude-haiku-5-5')
    expect(modelFor({ provider: 'anthropic', apiKey: 'k', quickModel: 'claude-sonnet-5-5' }, 'quick')).toBe('claude-sonnet-5-5')
    // No known quick model elsewhere: the main one (so routing changes nothing).
    expect(modelFor({ provider: 'openai', apiKey: 'k', model: 'gpt-x' }, 'quick')).toBe('gpt-x')
  })
})
