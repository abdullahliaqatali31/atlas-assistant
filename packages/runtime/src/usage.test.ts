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
    // Opus 5.5: 1M in × $4 + 0.1M out × $20 + 2M cached × $0.20 = $6.40; Haiku: $0.10 + $0.05 + 2M cached × $0.01 = $0.17.
    expect(s.byModel.map(m => [m.model, m.purpose, m.usd])).toEqual([
      ['claude-opus-5-5', 'chat', 6.4],
      ['claude-haiku-5-5', 'background', expect.closeTo(0.17, 6)],
    ])
    expect(s.today).toMatchObject({ calls: 2, tokens: 6_200_000 })
    expect(s.month.usd).toBeCloseTo(6.57, 6)
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
    expect(groq.config?.llm).toEqual({ provider: 'groq', apiKey: 'g', model: 'llama-x', baseUrl: undefined, backgroundModel: 'small', quickModel: undefined, routing: 'auto' })
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

describe('per-call breakdown', () => {
  it('records each call with cache writes, its cost, and what the request was made of', async () => {
    const { memory, clock } = setup()
    const llm = meterLlm(fake('claude-opus-5-5', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 9000, cacheWriteTokens: 500 } as never), { purpose: 'chat', memory, clock, utcOffsetMin: 0 })
    const req: LlmRequest = {
      system: ['x'.repeat(4000), 'y'.repeat(400)],
      tools: [{ name: 't', description: 'd'.repeat(200), inputSchema: {} }],
      turns: [
        { role: 'user', content: 'h'.repeat(800) },
        { role: 'assistant', content: 'i'.repeat(400), cacheBreak: true },
        { role: 'user', content: [{ type: 'text', text: 'now' }, { type: 'text', text: 'c'.repeat(1200) }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'news', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: '1', content: 'r'.repeat(8000) }] },
      ],
    }
    for await (const _ of llm.stream(req)) void _
    const s = usageSummary(memory, clock.now(), 0)
    expect(s.recent).toHaveLength(1)
    const c = s.recent[0]!
    expect(c).toMatchObject({ model: 'claude-opus-5-5', purpose: 'chat', input: 1000, cached: 9000, cacheWrite: 500, output: 200 })
    // $4/M fresh, $0.20/M cached, $5/M written, $20/M out.
    expect(c.usd).toBeCloseTo((1000 * 4 + 9000 * 0.2 + 500 * 5 + 200 * 20) / 1_000_000, 9)
    expect(c.parts).toMatchObject({ instructions: 1100, history: 300, toolResults: 2000 })
    expect(c.parts.turn).toBeGreaterThan(300)
    // 9000 of 10500 input came from the cache today.
    expect(s.cacheShare).toBeCloseTo(9000 / 10500, 6)
    expect(s.byModel[0]).toMatchObject({ cacheWrite: 500 })
  })

  it('keeps only the newest thousand calls', () => {
    const { memory } = setup()
    for (let i = 0; i < 1005; i++) memory.addCall({ at: i, model: 'm', purpose: 'chat', input: 1, output: 1, cached: 0, cacheWrite: 0, parts: {} })
    const recent = memory.recentCalls(2000)
    expect(recent).toHaveLength(1000)
    expect(recent[0]!.at).toBe(1004)
  })
})
