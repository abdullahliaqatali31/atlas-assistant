import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '@assistant/memory'
import type { LlmEvent, LlmProvider, LlmRequest } from '@assistant/providers'
import { DAY, fixedClock, HOUR, MINUTE } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { Learner } from './learner.ts'
import { parseItems, quoted, similarity } from './memory-manager.ts'
import { detectStyle } from './style.ts'
import { mineWorkflows } from './workflows.ts'

class ScriptedLlm implements LlmProvider {
  readonly id = 'fake'
  readonly model = 'fake'
  requests: LlmRequest[] = []
  constructor(private readonly reply: string) {}
  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    this.requests.push(req)
    yield { type: 'text', text: this.reply }
    yield { type: 'done', stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, raw: [] }
  }
  async healthCheck() {
    return { ok: true as const }
  }
}

const dirs: string[] = []
const stores: MemoryStore[] = []
afterEach(() => {
  // Windows keeps an open SQLite file locked: close before deleting.
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const setup = (reply = '[]') => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-learn-'))
  dirs.push(dir)
  const clock = fixedClock(Date.UTC(2026, 9, 17, 6))
  const memory = new MemoryStore(join(dir, 'a.db'), clock)
  stores.push(memory)
  // The default is already short replies; start from detailed so a change is visible.
  memory.updatePersonality({ verbosity: 'detailed' }, 'test start')
  const llm = new ScriptedLlm(reply)
  return { memory, clock, llm, learner: new Learner({ memory, llm, clock }) }
}

const say = (memory: MemoryStore, ...lines: [who: 'owner' | 'assistant', text: string][]) => {
  for (const [who, text] of lines) memory.addMessage('c1', who, text)
}

// ── personality adapter ─────────────────────────────────────

describe('personality adapter', () => {
  it('tells lasting instructions from passing hints', () => {
    expect(detectStyle('hamesha chhote jawab do')).toEqual([{ field: 'verbosity', value: 'short', strength: 'instruction' }])
    expect(detectStyle('yar itna lamba kyun likha')).toEqual([{ field: 'verbosity', value: 'short', strength: 'hint' }])
    expect(detectStyle('from now on reply in English')).toEqual([{ field: 'language', value: 'en', strength: 'instruction' }])
    expect(detectStyle('aaj se mazaq band')).toEqual([{ field: 'humour', value: false, strength: 'instruction' }])
    expect(detectStyle('quote bhej do')).toEqual([])
  })

  it('applies an instruction at once, with undo', () => {
    const { memory, learner } = setup()
    const out = learner.observeOwner('Atlas, hamesha chhote jawab do')
    expect(out).toMatchObject([{ kind: 'applied', field: 'verbosity', value: 'short' }])
    expect(memory.personality().profile.verbosity).toBe('short')
    expect(memory.personality().canUndo).toBe(true)
    expect(learner.snapshot().personalityChanges[0]?.reason).toMatch(/^learned: keep replies short/)
  })

  it('asks only after the same hint three times on two days', () => {
    const { memory, clock, learner } = setup()
    expect(learner.observeOwner('itna lamba jawab mat do')).toEqual([])
    expect(learner.observeOwner('bak bak kam karo')).toEqual([])
    expect(learner.observeOwner('too long again')).toEqual([]) // three hints, but one day
    clock.advance(DAY)
    const out = learner.observeOwner('phir itna lamba')
    expect(out).toMatchObject([{ kind: 'proposed', field: 'verbosity', value: 'short' }])
    expect(memory.personality().profile.verbosity).toBe('detailed') // nothing changed without a yes
    const p = learner.snapshot().pending[0]!
    expect(p.title).toBe('Should I always keep replies short?')
    learner.decide(p.id, true)
    expect(memory.personality().profile.verbosity).toBe('short')
  })
})

// ── memory manager ──────────────────────────────────────────

describe('memory manager', () => {
  it('only keeps items that quote the owner', () => {
    const owner = ['Mera client Ahmed hai, uska quote Friday tak chahiye']
    expect(quoted('client Ahmed hai', owner)).toBe(true)
    expect(quoted('Ahmed likes PDF', owner)).toBe(false)
    expect(similarity('Quote for Ahmed is due Friday', 'Ahmed quote due Friday')).toBeGreaterThan(0.6)
    expect(parseItems('Sure!\n```json\n[{"kind":"fact","statement":"x","quote":"y","confidence":0.9}]\n```')).toHaveLength(1)
    expect(parseItems('not json')).toEqual([])
  })

  it('saves stated facts, proposes lessons and guesses, drops invented ones', async () => {
    const reply = JSON.stringify([
      { kind: 'fact', statement: 'Ahmed is a client; his quote is due Friday.', quote: 'Ahmed mera client hai, quote Friday tak', confidence: 0.95 },
      { kind: 'preference', statement: 'Owner prefers quotes as PDF.', quote: 'quote hamesha PDF mein', confidence: 0.9 },
      { kind: 'correction', statement: 'When sending quotes, attach a PDF, not Word.', quote: 'Word nahi, PDF bhejo', confidence: 0.9 },
      { kind: 'inference', statement: 'Owner works in construction estimating.', quote: 'Block C ki drawings', confidence: 0.6 },
      { kind: 'fact', statement: 'Owner lives in Lahore.', quote: 'main Lahore mein rehta hoon', confidence: 0.9 }, // never said
    ])
    const { memory, learner } = setup(reply)
    say(
      memory,
      ['owner', 'Ahmed mera client hai, quote Friday tak bhejna hai'],
      ['assistant', 'Theek hai.'],
      ['owner', 'aur quote hamesha PDF mein bhejna'],
      ['owner', 'Word nahi, PDF bhejo please'],
      ['owner', 'Block C ki drawings bhi dekhni hain'],
    )
    const { memory: r } = await learner.runIdle({ force: true })
    expect(r.saved).toEqual(['Ahmed is a client; his quote is due Friday.', 'Owner prefers quotes as PDF.'])
    expect(r.droppedUnquoted).toBe(1)
    expect(r.proposed).toEqual(['When sending quotes, attach a PDF, not Word.', 'Owner works in construction estimating.'])
    expect(memory.recall('Lahore')).toEqual([])
    // Nothing behaves differently until the owner says yes to the lesson.
    expect(learner.contextLines()).toEqual([])
    const lesson = learner.snapshot().pending.find(p => p.kind === 'lesson')!
    learner.decide(lesson.id, true)
    expect(learner.contextLines()[0]).toContain('When sending quotes, attach a PDF, not Word.')
  })

  it('updates a changed fact instead of keeping both', async () => {
    const { memory, clock, learner } = setup()
    const old = memory.remember({ kind: 'fact', statement: 'Ahmed quote is due Friday.', source: { kind: 'owner', origin: 'learned', retrievedAt: 0 } })
    const llm = new ScriptedLlm(
      JSON.stringify([{ kind: 'fact', statement: 'Ahmed quote is now due Monday.', quote: 'Ahmed ka quote ab Monday tak', confidence: 0.9, updates: old.slice(0, 8) }]),
    )
    const l2 = new Learner({ memory, llm, clock })
    say(memory, ['owner', 'Ahmed ka quote ab Monday tak chahiye'])
    const { memory: r } = await l2.runIdle({ force: true })
    expect(r.updated).toEqual(['Ahmed quote is due Friday. → Ahmed quote is now due Monday.'])
    expect(memory.recall('Ahmed quote').map(m => m.statement)).toEqual(['Ahmed quote is now due Monday.'])
    void learner
  })

  it('does not call the model without enough new conversation, and respects the gap', async () => {
    const { memory, clock, llm, learner } = setup('[]')
    say(memory, ['owner', 'hi'])
    expect((await learner.runIdle()).memory.reason).toBe('not enough new conversation')
    say(memory, ['owner', 'one'], ['owner', 'two'], ['owner', 'three'])
    expect((await learner.runIdle()).memory.ran).toBe(true)
    say(memory, ['owner', 'four'], ['owner', 'five'], ['owner', 'six'])
    clock.advance(5 * MINUTE)
    expect((await learner.runIdle()).memory.reason).toBe('ran recently')
    expect(llm.requests).toHaveLength(1)
  })

  it('deletes raw conversation after 30 days but keeps what was learned', async () => {
    const { memory, clock, learner } = setup()
    say(memory, ['owner', 'old chat'])
    memory.remember({ kind: 'fact', statement: 'A learned fact', source: { kind: 'owner', origin: 'learned', retrievedAt: 0 } })
    clock.advance(31 * DAY)
    const { memory: r } = await learner.runIdle()
    expect(r.deletedMessages).toBe(1)
    expect(memory.recall('learned fact')).toHaveLength(1)
  })

  it('merges near-duplicate memories', () => {
    const { memory, learner } = setup()
    const src = { kind: 'owner' as const, origin: 'learned', retrievedAt: 0 }
    memory.remember({ kind: 'fact', statement: 'Ahmed is the client for Block C tower', source: src })
    memory.remember({ kind: 'fact', statement: 'Ahmed is the client for the Block C tower', source: src })
    expect(learner.manager.consolidate()).toBe(1)
    expect(memory.memories(['fact'])).toHaveLength(1)
  })
})

// ── workflows ───────────────────────────────────────────────

describe('workflow learning', () => {
  const run = (day: number, hour: number) => {
    const t = Date.UTC(2026, 9, 10 + day, hour)
    return [
      { tool: 'gmail__search', result: 'done', at: t },
      { tool: 'filesystem__read_file', result: 'done', at: t + MINUTE },
      { tool: 'task_add', result: 'done', at: t + 2 * MINUTE },
    ]
  }

  it('proposes a sequence repeated three times on two days, only the full sequence', () => {
    const mined = mineWorkflows([...run(0, 9), ...run(0, 15), ...run(1, 10)])
    expect(mined).toEqual([{ steps: ['gmail__search', 'filesystem__read_file', 'task_add'], count: 3, days: 2, lastAt: expect.any(Number) }])
  })

  it('ignores one-day repetition and failed steps', () => {
    expect(mineWorkflows([...run(0, 9), ...run(0, 12), ...run(0, 15)])).toEqual([])
    const failed = run(1, 10).map(a => ({ ...a, result: 'failed' }))
    expect(mineWorkflows([...run(0, 9), ...run(0, 15), ...failed])).toEqual([])
  })

  it('becomes a proposal, then a routine in context only after a yes', async () => {
    const { memory, clock, learner } = setup()
    for (const [d, h] of [
      [0, 9],
      [0, 15],
      [1, 10],
    ] as const) {
      clock.set(Date.UTC(2026, 9, 10 + d, h))
      for (const a of run(d, h)) {
        clock.set(a.at)
        memory.logAction({ tool: a.tool, summary: '{}', decision: 'allow', result: 'done' })
      }
    }
    clock.advance(2 * HOUR)
    const r = await learner.runIdle()
    expect(r.workflowsProposed).toEqual(['search → read file → task add'])
    const p = learner.snapshot().pending.find(x => x.kind === 'workflow')!
    expect(learner.contextLines()).toEqual([])
    learner.decide(p.id, true)
    expect(learner.contextLines()[0]).toContain('search → read file → task add')
    // Asked once: the same pattern is never proposed again.
    expect((await learner.runIdle()).workflowsProposed).toEqual([])
  })
})

describe('hint phrasing', () => {
  it('catches common Roman Urdu ways of saying "too long"', () => {
    for (const t of ['phir se bohat lamba', 'bahut zyada likh diya', 'kaafi lamba ho gaya']) {
      expect(detectStyle(t)).toEqual([{ field: 'verbosity', value: 'short', strength: 'hint' }])
    }
  })
})
