import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DAY, fixedClock, type SourceRef } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryStore } from './index.ts'

const dirs: string[] = []
const open = (clock = fixedClock(Date.UTC(2026, 9, 17))) => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-mem-'))
  dirs.push(dir)
  const path = join(dir, 'assistant.db')
  return { store: new MemoryStore(path, clock), path, clock }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const owner = (at = 0): SourceRef => ({ kind: 'owner', origin: 'chat', retrievedAt: at })

describe('MemoryStore', () => {
  it('recalls a fact after restart', () => {
    const { store, path, clock } = open()
    store.remember({ kind: 'fact', statement: 'Client Ahmed wants the revised quote by Friday', source: owner() })
    store.close()
    const again = new MemoryStore(path, clock)
    expect(again.recall('revised quote').map(m => m.statement)).toEqual(['Client Ahmed wants the revised quote by Friday'])
    again.close()
  })

  it('lists logged actions newest first with their evidence', () => {
    const { store } = open()
    store.logAction({ tool: 'tasks_list', summary: '{}', decision: 'allow', ruleId: 'default-tasks_list', result: 'done', evidence: 'No open tasks.' })
    store.logAction({ tool: 'playwright__browser_navigate', summary: '{"url":"https://example.com"}', decision: 'ask', result: 'failed', evidence: 'timeout' })
    const [latest, first] = store.recentActions(10)
    expect(latest).toMatchObject({ tool: 'playwright__browser_navigate', result: 'failed', evidence: 'timeout', ruleId: null })
    expect(first).toMatchObject({ tool: 'tasks_list', ruleId: 'default-tasks_list', evidence: 'No open tasks.' })
    store.close()
  })

  it('corrections supersede, and the old fact stops surfacing', () => {
    const { store } = open()
    const id = store.remember({ kind: 'fact', statement: 'Quote deadline is Friday', source: owner() })
    store.correct(id, 'Quote deadline is Thursday', owner())
    expect(store.recall('quote deadline').map(m => m.statement)).toEqual(['Quote deadline is Thursday'])
    store.close()
  })

  it('forgotten memories do not resurface through search', () => {
    const { store } = open()
    const id = store.remember({ kind: 'fact', statement: 'Secret project codename Falcon', source: owner() })
    store.forget(id)
    expect(store.recall('Falcon')).toEqual([])
    store.close()
  })

  it('a backup snapshot taken while in use reopens with everything in it', () => {
    const { store, path, clock } = open()
    store.remember({ kind: 'fact', statement: 'Ahmed Raza is the Block C client', source: owner() })
    store.addTask('Send revised quote', { dueAt: clock.now() + DAY })
    const copy = `${path}.backup`
    store.backupTo(copy)
    store.addTask('Added after the backup')
    store.close()
    const restored = new MemoryStore(copy, clock)
    expect(restored.recall('Block C').map(m => m.statement)).toEqual(['Ahmed Raza is the Block C client'])
    expect(restored.openTasks().map(t => t.title)).toEqual(['Send revised quote'])
    restored.close()
  })

  it('forgetting a corrected fact never brings back the older version', () => {
    const { store } = open()
    const v1 = store.remember({ kind: 'fact', statement: 'Quote deadline is Friday', source: owner() })
    const v2 = store.correct(v1, 'Quote deadline is Thursday', owner())
    const v3 = store.correct(v2, 'Quote deadline is Wednesday', owner())
    store.addProposal({ kind: 'memory', title: 'Quote deadline is Wednesday', detail: {}, evidence: 'x', dedupKey: 'p' })
    expect(store.forget(v3)).toBe(3)
    expect(store.recall('quote deadline')).toEqual([])
    expect(store.memories()).toEqual([])
    expect(store.proposals('pending')).toEqual([])
    store.close()
  })

  it('finds a memory by the short id tools show, and only when it is unambiguous and current', () => {
    const { store } = open()
    const id = store.remember({ kind: 'fact', statement: 'Ahmed is a client', source: owner() })
    expect(store.findMemory(id.slice(0, 8))?.statement).toBe('Ahmed is a client')
    const newer = store.correct(id, 'Ahmed is a former client', owner())
    expect(store.findMemory(id.slice(0, 8))).toBeUndefined()
    expect(store.findMemory(newer)?.statement).toBe('Ahmed is a former client')
    store.close()
  })

  it('refuses to complete a task without evidence and keeps history on reopen', () => {
    const { store } = open()
    const id = store.addTask('Send revised quote')
    expect(() => store.transition(id, 'completed')).toThrow(/evidence/)
    store.transition(id, 'completed', { evidence: 'Sent email id 123' })
    store.transition(id, 'ready', { note: 'client asked for changes' })
    expect(store.taskHistory(id).map(h => h.to_status)).toEqual(['ready', 'completed', 'ready'])
    store.close()
  })

  it('rejects illegal transitions', () => {
    const { store } = open()
    const id = store.addTask('Draft', { status: 'proposed' })
    expect(() => store.transition(id, 'running')).toThrow(/cannot go/)
    store.close()
  })

  it('marks tasks that were running at a crash as waiting, with a note', () => {
    const { store, path, clock } = open()
    const id = store.addTask('Upload drawings')
    store.transition(id, 'running')
    store.close()
    const again = new MemoryStore(path, clock)
    expect(again.recoverInterrupted().map(t => t.title)).toEqual(['Upload drawings'])
    expect(again.getTask(id)?.status).toBe('waiting')
    expect(again.taskHistory(id).at(-1)?.note).toMatch(/verify/)
    again.close()
  })

  it('tracks commitments until resolved with a note', () => {
    const { store, clock } = open()
    const id = store.addCommitment({ who: 'owner', what: 'send revised quote', toWhom: 'Ahmed', dueAt: clock.now() - 1, source: owner() })
    expect(store.dueCommitments().map(c => c.what)).toEqual(['send revised quote'])
    expect(() => store.resolveCommitment(id, ' ')).toThrow()
    store.resolveCommitment(id, 'sent by email')
    expect(store.openCommitments()).toEqual([])
    store.close()
  })

  it('lists overdue open tasks', () => {
    const { store, clock } = open()
    store.addTask('Yesterday thing', { dueAt: clock.now() - DAY })
    store.addTask('Tomorrow thing', { dueAt: clock.now() + DAY })
    expect(store.overdue().map(t => t.title)).toEqual(['Yesterday thing'])
    store.close()
  })
})

describe('conversations', () => {
  it('keeps a conversation per id with its first owner words as title, newest used first', () => {
    const { store, clock } = open()
    store.addMessage('c1', 'assistant', 'Subah bakhair!')
    store.addMessage('c1', 'owner', 'Ahmed ke quote ka kya hua?\nbatao')
    clock.advance(60_000)
    store.addMessage('c2', 'owner', 'salam')
    const list = store.conversations()
    expect(list.map(c => c.id)).toEqual(['c2', 'c1'])
    expect(list[1]).toMatchObject({ title: 'Ahmed ke quote ka kya hua? batao', messages: 2, summary: '', summarizedThrough: 0 })
    expect(store.conversationMessages('c1').map(m => m.speaker)).toEqual(['assistant', 'owner'])
    store.close()
  })

  it('stores the rolling summary and a better title, and finds old messages by words', () => {
    const { store } = open()
    store.addMessage('c1', 'owner', 'Visa appointment is on Monday at 10')
    store.addMessage('c2', 'owner', 'remind me about the dentist')
    store.setConversationSummary('c1', 'Owner has a visa appointment Monday 10:00.', 123, 'Visa appointment')
    expect(store.conversation('c1')).toMatchObject({ summary: 'Owner has a visa appointment Monday 10:00.', summarizedThrough: 123, title: 'Visa appointment' })
    expect(store.searchMessages('VISA monday').map(h => [h.conversationId, h.title])).toEqual([['c1', 'Visa appointment']])
    expect(store.searchMessages('nothing like this')).toEqual([])
    store.close()
  })
})

describe('the brain: connections between memories', () => {
  it('links a new memory to the ones it shares meaning with, and strengthens links used together', () => {
    const { store } = open()
    const tea = store.remember({ kind: 'preference', statement: 'Abdullah prefers green tea in the evening', source: owner() })
    const coffee = store.remember({ kind: 'fact', statement: 'Abdullah drinks green tea after dinner', source: owner() })
    const cricket = store.remember({ kind: 'fact', statement: 'Plays cricket on Sundays', source: owner() })
    let b = store.brain()
    expect(b.memories).toHaveLength(3)
    expect(b.links.map(l => [l.a, l.b].sort().join())).toContain([tea, coffee].sort().join())
    expect(b.links.some(l => l.a === cricket || l.b === cricket)).toBe(false)
    const before = b.links.find(l => (l.a === tea || l.b === tea) && (l.a === coffee || l.b === coffee))!.weight
    store.noteUse([tea, coffee, cricket, tea])
    b = store.brain()
    const after = b.links.find(l => (l.a === tea || l.b === tea) && (l.a === coffee || l.b === coffee))!
    expect(after.weight).toBeGreaterThan(before)
    expect(after.uses).toBe(1)
    expect(b.links.some(l => l.a === cricket || l.b === cricket)).toBe(true)
    expect(b.memories.find(m => m.id === tea)).toMatchObject({ uses: 1 })
    expect(b.links.every(l => l.a < l.b)).toBe(true)
    store.close()
  })
})
