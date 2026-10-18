import { describe, expect, it } from 'vitest'

import { applyCacheMarkers, toMessage } from './anthropic.ts'
import type { ChatTurn } from './llm.ts'
import { costOf, KNOWN_PRICES } from './llm-presets.ts'

const marked = (m: { content: unknown }) => (Array.isArray(m.content) ? m.content.filter(b => (b as { cache_control?: unknown }).cache_control).length : 0)

describe('prompt cache markers', () => {
  it('marks the end of the history, turning a plain string into a markable block', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'salam' },
      { role: 'assistant', content: 'Wa alaikum salam!', cacheBreak: true },
      { role: 'user', content: [{ type: 'text', text: 'kya haal hai' }, { type: 'text', text: '<context>…</context>' }] },
    ]
    const messages = turns.map(toMessage)
    expect(applyCacheMarkers(turns, messages, 2)).toBe(3)
    expect(messages[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Wa alaikum salam!', cache_control: { type: 'ephemeral' } }] })
    // The new message and its context stay after the marker.
    expect(marked(messages[2]!)).toBe(0)
  })

  it('never marks a thinking block, and never changes the replayed content itself', () => {
    const raw = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 't1', name: 'tasks_list', input: {} },
    ]
    const turns: ChatTurn[] = [{ role: 'assistant', content: [], raw, cacheBreak: true }]
    const messages = turns.map(toMessage)
    applyCacheMarkers(turns, messages, 2)
    const blocks = messages[0]!.content as { type: string; cache_control?: unknown }[]
    expect(blocks[0]!.cache_control).toBeUndefined()
    expect(blocks[1]!.cache_control).toEqual({ type: 'ephemeral' })
    expect((raw[1] as { cache_control?: unknown }).cache_control).toBeUndefined()
  })

  it('stays within the four markers the API allows', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'a', cacheBreak: true },
      { role: 'assistant', content: 'b', cacheBreak: true },
    ]
    expect(applyCacheMarkers(turns, turns.map(toMessage), 3)).toBe(4)
  })
})

describe('costOf', () => {
  it('prices cache writes at 1.25x input and reads at the cache price', () => {
    const p = KNOWN_PRICES['claude-opus-5-5']
    // 1M fresh in ($4) + 1M cached ($0.20) + 1M written ($5) + 0.1M out ($2)
    expect(costOf({ input: 1_000_000, cached: 1_000_000, cacheWrite: 1_000_000, output: 100_000 }, p)).toBeCloseTo(11.2, 6)
    expect(costOf({ input: 1, output: 1, cached: 1 }, undefined)).toBeNull()
  })
})
