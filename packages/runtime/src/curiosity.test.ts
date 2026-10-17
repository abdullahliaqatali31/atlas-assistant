import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '@assistant/memory'
import type { LlmEvent, LlmProvider, LlmRequest } from '@assistant/providers'
import { DAY, fixedClock, HOUR } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAgenda } from './agenda.ts'
import { curiosityItems } from './curiosity.ts'
import { MemoryManager } from './learning/memory-manager.ts'
import { localTools } from './tools.ts'

const stores: MemoryStore[] = []
const dirs: string[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PKT = { utcOffsetMin: 300 }
/** 14:00 in Karachi on Sat 17 Oct 2026. */
const setup = (utcHour = 9) => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-curious-'))
  dirs.push(dir)
  const clock = fixedClock(Date.UTC(2026, 9, 17, utcHour))
  const memory = new MemoryStore(join(dir, 'a.db'), clock)
  stores.push(memory)
  return { memory, clock }
}
const src = { kind: 'owner' as const, origin: 'test', retrievedAt: 0 }

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

describe('follow-ups', () => {
  it('notes an event the owner mentioned, with their words and local time, and drops invented ones', async () => {
    const { memory, clock } = setup()
    const llm = new ScriptedLlm(
      JSON.stringify([
        { kind: 'followup', statement: 'client meeting with Ahmed', quote: 'kal 3 baje Ahmed ke saath meeting', when: '2026-10-18T17:00:00+05:00', confidence: 0.9 },
        { kind: 'followup', statement: 'dentist', quote: 'dentist appointment', when: '2026-10-18T12:00:00+05:00', confidence: 0.9 }, // never said
        { kind: 'followup', statement: 'yearly audit', quote: 'audit next year', when: '2027-09-01T10:00:00+05:00', confidence: 0.9 }, // too far
      ]),
    )
    memory.addMessage('c', 'owner', 'kal 3 baje Ahmed ke saath meeting hai, audit next year hoga')
    const report = await new MemoryManager({ memory, llm, clock, ...PKT }).run({ force: true })
    expect(report.followups).toEqual(['client meeting with Ahmed (2026-10-18 17:00)'])
    expect(memory.followups().map(f => f.about)).toEqual(['client meeting with Ahmed'])
    // The model sees local times, so "kal" resolves to the owner's tomorrow.
    const prompt = String(llm.requests[0]!.turns[0]!.content)
    expect(prompt).toContain('NOW: 2026-10-17T14:00+05:00 Sat')
    expect(prompt).toContain('[2026-10-17T14:00+05:00 Sat] OWNER: kal 3 baje')
  })

  it('asks how it went once its time has passed, not before and not days later', () => {
    const { memory, clock } = setup()
    memory.addFollowup({ about: 'client meeting with Ahmed', quote: 'kal 3 baje Ahmed ke saath meeting', dueAt: clock.now() + 3 * HOUR, dedupKey: 'f1' })
    expect(curiosityItems(memory, clock.now(), PKT)).toEqual([])
    clock.advance(4 * HOUR)
    const [item] = curiosityItems(memory, clock.now(), PKT)
    expect(item).toMatchObject({ kind: 'question', title: 'How did it go: client meeting with Ahmed?', expectsAnswer: true })
    expect(item!.instruction).toContain('“kal 3 baje Ahmed ke saath meeting”')
    clock.advance(3 * DAY)
    expect(curiosityItems(memory, clock.now(), PKT).filter(i => i.key.startsWith('followup:'))).toEqual([])
  })
})

describe('opinions on stuck tasks', () => {
  it('recommends and asks about a task overdue for days, with the tool to act on the answer', async () => {
    const { memory, clock } = setup()
    memory.addTask('Send revised quote', { dueAt: clock.now() - 3 * DAY })
    memory.addTask('Due in an hour', { dueAt: clock.now() + HOUR })
    const [stuck] = curiosityItems(memory, clock.now(), PKT).filter(i => i.key.startsWith('stuck:'))
    expect(stuck).toMatchObject({ title: 'Stuck: Send revised quote', priority: 60 })
    expect(stuck!.instruction).toContain('overdue for 3 day(s)')
    expect(stuck!.instruction).toContain('task_update')
    // The answer can be acted on.
    const update = localTools(memory, clock).find(t => t.name === 'task_update')!
    expect(await update.run({ number: 1, due: '2026-10-19T10:00:00+05:00' })).toContain('Moved "Send revised quote"')
    expect(memory.openTasks().find(t => t.title === 'Send revised quote')!.dueAt).toBe(Date.parse('2026-10-19T10:00:00+05:00'))
    // Numbers follow tasks_list, which sorts by due time: the moved task is now second.
    expect(await update.run({ number: 1, cancel: true })).toBe('Cancelled "Due in an hour".')
  })
})

describe('corrections and forgetting in chat', () => {
  it('corrects by the id memory_search shows; forgetting always asks the owner first', async () => {
    const { memory, clock } = setup()
    memory.remember({ kind: 'fact', statement: 'Block C deadline is Friday', source: src })
    const tools = localTools(memory, clock)
    const run = (name: string, input: Record<string, unknown>) => tools.find(t => t.name === name)!.run(input)
    const found = await run('memory_search', { query: 'Block C deadline' })
    const id = /\[([0-9a-f]{8})\]/.exec(found)![1]!
    expect(await run('memory_correct', { id, statement: 'Block C deadline is Thursday' })).toContain('→ "Block C deadline is Thursday"')
    expect(memory.recall('Block C deadline').map(m => m.statement)).toEqual(['Block C deadline is Thursday'])
    expect(tools.find(t => t.name === 'memory_forget')!.actionClass).toBe('destructive')
    const newId = /\[([0-9a-f]{8})\]/.exec(await run('memory_search', { query: 'Block C' }))![1]!
    await run('memory_forget', { id: newId })
    expect(memory.recall('Block C')).toEqual([])
  })
})

describe('getting to know the owner', () => {
  it('asks about something it does not know, only on a day the owner talked, in daytime', () => {
    const { memory, clock } = setup()
    expect(curiosityItems(memory, clock.now(), PKT)).toEqual([])
    memory.addMessage('c', 'owner', 'salam')
    const [q] = curiosityItems(memory, clock.now(), PKT)
    expect(q).toMatchObject({ key: 'know:work', title: 'Getting to know you', priority: 20 })
    // Late at night it waits.
    clock.set(Date.UTC(2026, 9, 17, 17)) // 22:00 PKT
    expect(curiosityItems(memory, clock.now(), PKT)).toEqual([])
  })

  it('skips what it already knows and asks at most one a day', () => {
    const { memory, clock } = setup()
    memory.addMessage('c', 'owner', 'salam')
    memory.remember({ kind: 'fact', statement: 'Owner works as a civil engineer.', source: src })
    memory.remember({ kind: 'fact', statement: 'Ahmed is the main client.', source: src })
    expect(curiosityItems(memory, clock.now(), PKT)[0]!.key).toBe('know:hours')
    // Once raised today, nothing more today; tomorrow the next topic.
    memory.recordInitiative('agenda:know:hours', 'conversation', 'test')
    expect(curiosityItems(memory, clock.now(), PKT)).toEqual([])
    clock.advance(DAY)
    memory.addMessage('c', 'owner', 'salam again')
    expect(curiosityItems(memory, clock.now(), PKT)[0]!.key).toBe('know:goal')
  })

  it('sits below deadlines and wrap-up on the agenda, and can be switched off', () => {
    const { memory, clock } = setup()
    memory.addMessage('c', 'owner', 'salam')
    memory.addTask('Quote', { dueAt: clock.now() + HOUR })
    expect(buildAgenda(memory, clock.now(), PKT).map(i => i.key.split(':')[0])).toEqual(['due-soon', 'know'])
    expect(buildAgenda(memory, clock.now(), { ...PKT, curiosity: false }).map(i => i.key.split(':')[0])).toEqual(['due-soon'])
  })
})
