/**
 * Cost meter and monthly budget. Every LLM call goes through `meterLlm`,
 * which records tokens per owner-local day, model and purpose ("chat" for
 * talking to the owner, "background" for learning and other unattended
 * work). When the month's spending reaches the owner's budget, background
 * calls stop; talking to the owner keeps working, and the status says so.
 */
import type { CallRow, MemoryStore } from '@assistant/memory'
import { costOf, KNOWN_PRICES, type ChatTurn, type LlmEvent, type LlmProvider, type LlmRequest, type Price } from '@assistant/providers'
import type { Clock } from '@assistant/shared'

const BUDGET_KEY = 'usage.monthlyBudgetUsd'
const PRICES_KEY = 'usage.prices'

export type Purpose = 'chat' | 'background'

const localDay = (t: number, offsetMin: number) => new Date(t + offsetMin * 60_000).toISOString().slice(0, 10)

/** The owner's prices (Setup) over the published ones. */
export const prices = (memory: MemoryStore): Record<string, Price> => {
  try {
    return { ...KNOWN_PRICES, ...(JSON.parse(memory.getSetting(PRICES_KEY) ?? '{}') as Record<string, Price>) }
  } catch {
    return { ...KNOWN_PRICES }
  }
}

export const setPrice = (memory: MemoryStore, model: string, price: Price | null) => {
  const own = JSON.parse(memory.getSetting(PRICES_KEY) ?? '{}') as Record<string, Price>
  if (price) own[model] = price
  else delete own[model]
  memory.setSetting(PRICES_KEY, JSON.stringify(own))
}

/** Monthly limit in US dollars; 0 means no limit. */
export const budget = (memory: MemoryStore) => Math.max(0, Number(memory.getSetting(BUDGET_KEY) ?? 0) || 0)
export const setBudget = (memory: MemoryStore, usd: number) => memory.setSetting(BUDGET_KEY, String(Math.max(0, Math.round(usd * 100) / 100)))

export interface UsageSummary {
  today: { tokens: number; usd: number; calls: number }
  month: { tokens: number; usd: number; calls: number }
  /** This month per model and purpose; usd null when the price is unknown. */
  byModel: { model: string; purpose: string; input: number; output: number; cached: number; cacheWrite: number; calls: number; usd: number | null }[]
  /** Today: the share of input served from the prompt cache (0-1). */
  cacheShare: number
  /** The newest calls, newest first, each with its cost and what its request was made of. */
  recent: (CallRow & { usd: number | null })[]
  /** Models used this month without a known price. */
  unpriced: string[]
  budgetUsd: number
  /** Background work is paused because the budget is used up. */
  overBudget: boolean
}

export const usageSummary = (memory: MemoryStore, now: number, utcOffsetMin: number): UsageSummary => {
  const today = localDay(now, utcOffsetMin)
  const month = `${today.slice(0, 7)}-01`
  const p = prices(memory)
  const rows = memory.usageSince(month)
  const by = new Map<string, UsageSummary['byModel'][number]>()
  const sum = { today: { tokens: 0, usd: 0, calls: 0 }, month: { tokens: 0, usd: 0, calls: 0 } }
  const todayIn = { fresh: 0, cached: 0 }
  for (const r of rows) {
    const usd = costOf(r, p[r.model])
    const tokens = r.input + r.output + r.cached + (r.cache_write ?? 0)
    sum.month.tokens += tokens
    sum.month.calls += r.calls
    sum.month.usd += usd ?? 0
    if (r.day === today) {
      todayIn.fresh += r.input + (r.cache_write ?? 0)
      todayIn.cached += r.cached
      sum.today.tokens += tokens
      sum.today.calls += r.calls
      sum.today.usd += usd ?? 0
    }
    const key = `${r.model}|${r.purpose}`
    const prev = by.get(key) ?? { model: r.model, purpose: r.purpose, input: 0, output: 0, cached: 0, cacheWrite: 0, calls: 0, usd: p[r.model] ? 0 : null }
    prev.input += r.input
    prev.output += r.output
    prev.cached += r.cached
    prev.cacheWrite += r.cache_write ?? 0
    prev.calls += r.calls
    if (prev.usd !== null && usd !== null) prev.usd += usd
    by.set(key, prev)
  }
  const limit = budget(memory)
  return {
    ...sum,
    byModel: [...by.values()].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)),
    unpriced: [...new Set(rows.filter(r => !p[r.model]).map(r => r.model))],
    budgetUsd: limit,
    overBudget: limit > 0 && sum.month.usd >= limit,
    cacheShare: todayIn.fresh + todayIn.cached ? todayIn.cached / (todayIn.fresh + todayIn.cached) : 0,
    recent: memory.recentCalls(15).map(c => ({ ...c, usd: costOf(c, p[c.model]) })),
  }
}

/** Rough tokens for some text (about 4 characters each); for showing proportions, not billing. */
const approx = (chars: number) => Math.round(chars / 4)
const turnChars = (t: ChatTurn, only?: 'tool_result' | 'other') => {
  if (typeof t.content === 'string') return only === 'tool_result' ? 0 : t.content.length
  if (t.raw !== undefined && only !== 'tool_result') return JSON.stringify(t.raw).length
  let n = 0
  for (const part of t.content) {
    const isResult = part.type === 'tool_result'
    if (only === 'tool_result' && !isResult) continue
    if (only === 'other' && isResult) continue
    n += part.type === 'text' ? part.text.length : part.type === 'tool_result' ? part.content.length : JSON.stringify(part.input).length + part.name.length
  }
  return n
}

/**
 * What a request was made of, in estimated tokens: the instructions
 * (system prompt), the tool definitions, the conversation history (up to
 * the turn marked as its end), this turn (the owner's words, the context
 * packet, the assistant's tool calls) and tool results.
 */
export const requestParts = (req: LlmRequest): Record<string, number> => {
  const system = typeof req.system === 'string' ? req.system.length : req.system.reduce((n, s) => n + s.length, 0)
  const end = req.turns.findIndex(t => t.cacheBreak)
  const history = req.turns.slice(0, end + 1)
  const now = req.turns.slice(end + 1)
  return {
    instructions: approx(system),
    tools: approx(JSON.stringify(req.tools ?? []).length),
    history: approx(history.reduce((n, t) => n + turnChars(t), 0)),
    turn: approx(now.reduce((n, t) => n + turnChars(t, 'other'), 0)),
    toolResults: approx(now.reduce((n, t) => n + turnChars(t, 'tool_result'), 0)),
  }
}

export class BudgetExceededError extends Error {
  constructor(limit: number) {
    super(`The monthly AI budget ($${limit.toFixed(2)}) is used up, so background work is paused until next month or until you raise it in Setup.`)
  }
}

/**
 * The same provider, metered. Background calls are refused once the
 * month's budget is used up; chat calls are always allowed.
 */
export const meterLlm = (llm: LlmProvider, opts: { purpose: Purpose; memory: MemoryStore; clock: Clock; utcOffsetMin: number; onRecord?: () => void }): LlmProvider => ({
  id: llm.id,
  model: llm.model,
  healthCheck: () => llm.healthCheck(),
  async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent> {
    if (opts.purpose === 'background') {
      const s = usageSummary(opts.memory, opts.clock.now(), opts.utcOffsetMin)
      if (s.overBudget) throw new BudgetExceededError(s.budgetUsd)
    }
    for await (const e of llm.stream(req, signal)) {
      if (e.type === 'done') {
        const u = { input: e.usage.inputTokens, output: e.usage.outputTokens, cached: e.usage.cacheReadTokens, cacheWrite: e.usage.cacheWriteTokens ?? 0 }
        opts.memory.addUsage(localDay(opts.clock.now(), opts.utcOffsetMin), llm.model, opts.purpose, u)
        opts.memory.addCall({ at: opts.clock.now(), model: llm.model, purpose: opts.purpose, ...u, parts: requestParts(req) })
        opts.onRecord?.()
      }
      yield e
    }
  },
})
