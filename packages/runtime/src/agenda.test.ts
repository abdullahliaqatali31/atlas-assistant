import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '@assistant/memory'
import { DAY, fixedClock, HOUR } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { buildAgenda } from './agenda.ts'
import { learningTools, localTools } from './tools.ts'

const stores: MemoryStore[] = []
const dirs: string[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// 10:00 in Karachi (UTC+5).
const setup = (utcHour = 5) => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-agenda-'))
  dirs.push(dir)
  const clock = fixedClock(Date.UTC(2026, 9, 17, utcHour))
  const memory = new MemoryStore(join(dir, 'a.db'), clock)
  stores.push(memory)
  return { memory, clock }
}
const PKT = { utcOffsetMin: 300 }

describe('buildAgenda', () => {
  it('is empty on a quiet morning', () => {
    const { memory, clock } = setup()
    expect(buildAgenda(memory, clock.now(), PKT)).toEqual([])
  })

  it('nudges about a deadline within 24 hours, not about ones further away', () => {
    const { memory, clock } = setup()
    memory.addTask('Send revised quote', { dueAt: clock.now() + 5 * HOUR })
    memory.addTask('Annual report', { dueAt: clock.now() + 5 * DAY })
    const items = buildAgenda(memory, clock.now(), PKT)
    expect(items.map(i => i.title)).toEqual(['Due soon: Send revised quote'])
    expect(items[0]).toMatchObject({ kind: 'nudge', expectsAnswer: true })
  })

  it('wraps up the day after 18:00 with what got done', () => {
    const { memory, clock } = setup()
    const t = memory.addTask('Site visit photos')
    memory.transition(t, 'completed', { evidence: 'uploaded' })
    clock.set(Date.UTC(2026, 9, 17, 13, 30)) // 18:30 PKT
    const [wrap] = buildAgenda(memory, clock.now(), PKT)
    expect(wrap).toMatchObject({ kind: 'wrap-up', key: 'wrap-up:2026-10-17', expectsAnswer: true })
    expect(wrap!.instruction).toContain('Completed today: "Site visit photos"')
  })

  it('turns one learning suggestion into a question, oldest first, never a routine', () => {
    const { memory, clock } = setup()
    memory.addProposal({ kind: 'memory', title: 'Owner works in construction.', detail: {}, evidence: 'You said: “AutoCAD”', dedupKey: 'a' })
    clock.advance(1000)
    memory.addProposal({ kind: 'lesson', title: 'Send quotes as PDF.', detail: {}, evidence: 'x', dedupKey: 'b' })
    memory.addProposal({ kind: 'workflow', title: 'Save routine?', detail: {}, evidence: 'x', dedupKey: 'c' })
    const qs = buildAgenda(memory, clock.now(), PKT).filter(i => i.key.startsWith('confirm:'))
    expect(qs).toHaveLength(1)
    expect(qs[0]!.title).toBe('Quick check: Owner works in construction.')
    expect(qs[0]!.instruction).toContain('suggestion_answer')
  })

  it('asks about an active project left alone for days', () => {
    const { memory, clock } = setup()
    const p = memory.createProject({ name: 'Block C tower', state: 'waiting on steel prices' })
    memory.addTask('Review drawings', { projectId: p.id })
    clock.advance(4 * DAY)
    const [q] = buildAgenda(memory, clock.now(), PKT)
    expect(q).toMatchObject({ kind: 'question', title: 'How is Block C tower going?' })
    expect(q!.instruction).toContain('last state: "waiting on steel prices"')
  })

  it('orders by importance: wrap-up, deadlines, suggestions, projects', () => {
    const { memory, clock } = setup(13) // 18:00 PKT
    memory.addTask('Quote', { dueAt: clock.now() + HOUR })
    memory.addProposal({ kind: 'lesson', title: 'L', detail: {}, evidence: 'e', dedupKey: 'l' })
    expect(buildAgenda(memory, clock.now(), PKT).map(i => i.kind)).toEqual(['wrap-up', 'nudge', 'question'])
  })
})

describe('answer tools', () => {
  it('project_update records the owner’s status', async () => {
    const { memory, clock } = setup()
    const p = memory.createProject({ name: 'Block C tower' })
    const tool = localTools(memory, clock).find(t => t.name === 'project_update')!
    expect(await tool.run({ project: 'block c', state: 'drawings approved' })).toBe('Updated Block C tower.')
    expect(memory.getProject(p.id)?.state).toBe('drawings approved')
  })

  it('suggestion_answer passes the owner’s yes or no to the learner', async () => {
    const calls: [string, boolean][] = []
    const [tool] = learningTools({ decide: (id, accept) => calls.push([id, accept]) })
    await tool!.run({ proposal_id: 'abc', accept: false })
    expect(calls).toEqual([['abc', false]])
  })
})
