import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '@assistant/memory'
import { LLM_KEY_NAMES, type LlmEvent, type LlmProvider, type LlmRequest } from '@assistant/providers'
import { fixedClock } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from './config.ts'
import { SECRET_NAMES } from './credentials.ts'
import { BudgetExceededError, meterLlm, setBudget, setPrice, usageSummary } from './usage.ts'

const stores: MemoryStore[] = []
const dirs: string[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-usage-'))
  dirs.push(dir)
  const clock = fixedClock(Date.UTC(2026, 9, 18, 6))
  const memory = new MemoryStore(join(dir, 'a.db'), clock)
  stores.push(memory)
  return { memory, clock }
}

/** A provider that answers with fixed usage. */
const fake = (model: string, usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000 }): LlmProvider => ({
  id: 'fake',
  model,
  healthCheck: async () => ({ ok: true }),
  async *stream(_req: LlmRequest): AsyncIterable<LlmEvent> {
    yield { type: 'text', text: 'ok' }
    yield { type: 'done', stopReason: 'end', usage, raw: [] }
  },
})

const drain = async (llm: LlmProvider) => {
  for await (const _ of llm.stream({ system: 's', turns: [{ role: 'user', content: 'x' }] })) void _
}

describe('cost meter', () => {
  it('records tokens per model and purpose and prices Claude models', async () => {
    const { memory, clock } = setup()
    const opts = { memory, clock, utcOffsetMin: 300 }
    await drain(meterLlm(fake('claude-opus-5-5'), { ...opts, purpose: 'chat' }))
    await drain(meterLlm(fake('claude-haiku-5-5'), { ...opts, purpose: 'background' }))
    const s = usageSummary(memory, clock.now(), 300)
    // Opus 5.5: 1M in × $4 + 0.1M out × $20 + 2M cached × $0.20 = $6.40; Haiku: $0.10 + $0.05 + 2M cached at input price $0.20 = $0.35.
    expect(s.byModel.map(m => [m.model, m.purpose, m.usd])).toEqual([
      ['claude-opus-5-5', 'chat', 6.4],
      ['claude-haiku-5-5', 'background', expect.closeTo(0.35, 6)],
    ])
    expect(s.today).toMatchObject({ calls: 2, tokens: 6_200_000 })
    expect(s.month.usd).toBeCloseTo(6.75, 6)
  })

  it('shows tokens without dollars for models with no known price, until the owner sets one', async () => {
    const { memory, clock } = setup()
    await drain(meterLlm(fake('llama-x'), { memory, clock, utcOffsetMin: 0, purpose: 'chat' }))
    expect(usageSummary(memory, clock.now(), 0)).toMatchObject({ unpriced: ['llama-x'], byModel: [{ model: 'llama-x', usd: null }] })
    setPrice(memory, 'llama-x', { input: 0.5, output: 1 })
    expect(usageSummary(memory, clock.now(), 0).byModel[0]!.usd).toBeCloseTo(0.5 + 0.1 + 1, 6)
  })

  it('pauses background work at the monthly budget but never the owner’s conversation', async () => {
    const { memory, clock } = setup()
    const opts = { memory, clock, utcOffsetMin: 0 }
    setBudget(memory, 5)
    await drain(meterLlm(fake('claude-opus-5-5'), { ...opts, purpose: 'chat' }))
    expect(usageSummary(memory, clock.now(), 0)).toMatchObject({ budgetUsd: 5, overBudget: true })
    await expect(drain(meterLlm(fake('claude-haiku-5-5'), { ...opts, purpose: 'background' }))).rejects.toBeInstanceOf(BudgetExceededError)
    await drain(meterLlm(fake('claude-opus-5-5'), { ...opts, purpose: 'chat' }))
    // A new month starts fresh.
    clock.set(Date.UTC(2026, 10, 1, 6))
    expect(usageSummary(memory, clock.now(), 0).overBudget).toBe(false)
  })
})

describe('provider config', () => {
  const base = { ASSISTANT_DEV_SKIP_VOICE: '1', ASSISTANT_OWNER_NAME: 'A' }

  it('accepts any provider with its own key, and needs a model where there is no default', () => {
    expect(loadConfig({ ...base, ANTHROPIC_API_KEY: 'k' }, '/x').config?.llm).toMatchObject({ provider: 'anthropic', apiKey: 'k' })
    const groq = loadConfig({ ...base, ASSISTANT_LLM_PROVIDER: 'groq', GROQ_API_KEY: 'g', ASSISTANT_LLM_MODEL: 'llama-x', ASSISTANT_LLM_BACKGROUND_MODEL: 'small' }, '/x')
    expect(groq.config?.llm).toEqual({ provider: 'groq', apiKey: 'g', model: 'llama-x', baseUrl: undefined, backgroundModel: 'small' })
    expect(loadConfig({ ...base, ASSISTANT_LLM_PROVIDER: 'groq', GROQ_API_KEY: 'g' }, '/x').problems.map(p => p.key)).toEqual(['ASSISTANT_LLM_MODEL'])
    expect(loadConfig({ ...base, ASSISTANT_LLM_PROVIDER: 'openai', ASSISTANT_LLM_MODEL: 'm' }, '/x').problems.map(p => p.key)).toEqual(['OPENAI_API_KEY'])
  })

  it('runs Ollama without a key, and needs an address for a custom server', () => {
    expect(loadConfig({ ...base, ASSISTANT_LLM_PROVIDER: 'ollama', ASSISTANT_LLM_MODEL: 'qwen' }, '/x').problems).toEqual([])
    expect(loadConfig({ ...base, ASSISTANT_LLM_PROVIDER: 'custom', LLM_API_KEY: 'k', ASSISTANT_LLM_MODEL: 'm' }, '/x').problems.map(p => p.key)).toEqual(['ASSISTANT_LLM_BASE_URL'])
    expect(loadConfig({ ...base, ASSISTANT_LLM_PROVIDER: 'nope' }, '/x').problems[0]!.message).toMatch(/supported: anthropic, openai, gemini/)
  })

  it('can store every provider’s key in the OS credential store', () => {
    for (const k of LLM_KEY_NAMES) expect(SECRET_NAMES as readonly string[]).toContain(k)
  })
})
