import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PREFS } from '@assistant/initiative'
import { MemoryStore } from '@assistant/memory'
import type { LlmEvent, LlmProvider, LlmRequest } from '@assistant/providers'
import { DEFAULT_PROFILE, fixedClock, type PersonalityProfile } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { Assistant } from './assistant.ts'
import { PERSONA, profileBlock, systemPrompt } from './persona.ts'
import { DEFAULT_RULES, localTools } from './tools.ts'

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }

class FakeLlm implements LlmProvider {
  readonly id = 'fake'
  readonly model = 'fake'
  requests: LlmRequest[] = []
  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    this.requests.push(structuredClone(req))
    yield { type: 'text', text: 'Ji.' }
    yield { type: 'done', stopReason: 'end', usage, raw: [{ type: 'text', text: 'Ji.' }] }
  }
  async healthCheck() {
    return { ok: true as const }
  }
}

const dirs: string[] = []
const stores: MemoryStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) if (s.db.isOpen) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-persona-'))
  dirs.push(dir)
  const clock = fixedClock(Date.UTC(2026, 9, 17, 4))
  const memory = new MemoryStore(join(dir, 'a.db'), clock)
  stores.push(memory)
  const llm = new FakeLlm()
  const assistant = new Assistant({
    llm,
    memory,
    clock,
    owner: { name: 'Hamza' },
    prefs: { ...DEFAULT_PREFS, utcOffsetMin: 300 },
    tools: localTools(memory, clock),
    rules: () => DEFAULT_RULES,
  })
  return { memory, llm, assistant }
}

const drain = async (it: AsyncIterable<string>) => {
  let s = ''
  for await (const c of it) s += c
  return s
}

const profile = (p: Partial<PersonalityProfile>): PersonalityProfile => ({ ...DEFAULT_PROFILE, ...p })

describe('system prompt assembly', () => {
  it('puts the identity first, byte-identical whatever the profile', () => {
    const a = systemPrompt(profile({}), 'Hamza')
    const b = systemPrompt(profile({ ownerNickname: 'Boss', assistantName: 'Zara', humour: false, language: 'ur-Arab', verbosity: 'detailed', disagreement: 'firm' }), 'Hamza')
    expect(a[0]).toBe(PERSONA)
    expect(b[0]).toBe(PERSONA)
    expect(a[1]).not.toBe(b[1])
  })

  it('is deterministic for the same profile, so the profile block caches', () => {
    const p = profile({ ownerNickname: 'Boss', language: 'mix' })
    expect(profileBlock(p, 'Hamza')).toBe(profileBlock(structuredClone(p), 'Hamza'))
    expect(profileBlock(p, 'Hamza')).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('carries nickname, assistant name, language and tone', () => {
    const block = profileBlock(profile({ ownerNickname: 'Boss', assistantName: 'Zara', language: 'ur-Latn', humour: false, verbosity: 'detailed', disagreement: 'firm' }), 'Hamza')
    expect(block).toContain('Address the owner as "Boss"')
    expect(block).toContain('The owner\'s name is "Hamza"')
    expect(block).toContain('Your name is "Zara"')
    expect(block).toContain('you are still an AI')
    expect(block).toContain('Roman Urdu')
    expect(block).toContain('Humour: off')
    expect(block).toContain('Reply length: Detailed')
    expect(block).toContain('Disagreement: Firm')
  })

  it('falls back to the owner name, and states that tone never changes safety', () => {
    const block = profileBlock(DEFAULT_PROFILE, 'Hamza')
    expect(block).toContain('Address the owner as "Hamza"')
    expect(block).toContain('You have no personal name')
    expect(block).toMatch(/do not change your honesty rules, safety rules, the approval gate or any limit/)
    expect(PERSONA).toMatch(/never changes Identity and honesty, Context and tools, or Safety/)
  })
})

describe('Assistant with a profile', () => {
  it('sends identity and profile as two system blocks, stable across turns', async () => {
    const { assistant, llm } = setup()
    await drain(assistant.reply('salam'))
    await drain(assistant.reply('kya haal hai'))
    const [first, second] = llm.requests
    expect(Array.isArray(first?.system)).toBe(true)
    expect(first?.system).toEqual(second?.system)
    expect(first?.system[0]).toBe(PERSONA)
    // The profile is not per-turn context.
    const userText = JSON.stringify(first?.turns.at(-1))
    expect(userText).not.toContain('Owner profile')
  })

  it('applies a profile change on the very next reply', async () => {
    const { assistant, llm, memory } = setup()
    await drain(assistant.reply('salam'))
    memory.updatePersonality({ ownerNickname: 'Boss', assistantName: 'Zara', language: 'ur-Latn' }, 'onboarding')
    await drain(assistant.reply('kaun ho tum?'))
    expect(llm.requests[0]?.system[1]).toContain('Address the owner as "Hamza"')
    expect(llm.requests[1]?.system[1]).toContain('Address the owner as "Boss"')
    expect(llm.requests[1]?.system[1]).toContain('Your name is "Zara"')
    expect(llm.requests[1]?.system[0]).toBe(PERSONA)

    memory.undoPersonality()
    await drain(assistant.reply('phir se?'))
    expect(llm.requests[2]?.system[1]).toBe(llm.requests[0]?.system[1])
  })

  it('notes a profile change once, so earlier replies are not treated as mistakes', async () => {
    const { assistant, llm, memory } = setup()
    const note = 'changed your personality settings'
    const lastTurn = (i: number) => JSON.stringify(llm.requests[i]?.turns.at(-1))
    await drain(assistant.reply('salam'))
    memory.updatePersonality({ assistantName: 'Zara' }, 'setup')
    await drain(assistant.reply('naam?'))
    await drain(assistant.reply('theek'))
    expect(lastTurn(0)).not.toContain(note)
    expect(lastTurn(1)).toContain(note)
    expect(lastTurn(2)).not.toContain(note)
  })

  it('welcomes by nickname as a system event, not as an owner message', async () => {
    const { assistant, llm, memory } = setup()
    memory.updatePersonality({ ownerNickname: 'Boss' }, 'onboarding')
    expect(await drain(assistant.welcome())).toBe('Ji.')
    const text = JSON.stringify(llm.requests[0]?.turns.at(-1))
    expect(text).toContain('[system event]')
    expect(text).toContain('Greet Boss')
  })

  it('briefs using the nickname', async () => {
    const { assistant, llm, memory } = setup()
    memory.updatePersonality({ ownerNickname: 'Boss' }, 'x')
    await drain(assistant.speakUp({ type: 'session.first-of-day', at: Date.UTC(2026, 9, 17, 4) }))
    expect(JSON.stringify(llm.requests[0]?.turns.at(-1))).toContain('Greet Boss once')
  })
})
