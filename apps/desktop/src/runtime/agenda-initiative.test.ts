import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PREFS } from '@assistant/initiative'
import { MemoryStore } from '@assistant/memory'
import type { LlmEvent, LlmProvider, LlmRequest } from '@assistant/providers'
import { Assistant, buildAgenda } from '@assistant/runtime'
import { DAY, fixedClock, HOUR, MINUTE } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { InitiativeItem } from '../shared/ipc.ts'
import { InitiativeService } from './initiative.ts'

class FakeLlm implements LlmProvider {
  readonly id = 'fake'
  readonly model = 'fake'
  requests: LlmRequest[] = []
  async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
    this.requests.push(req)
    yield { type: 'text', text: 'Ek sawal tha…' }
    yield { type: 'done', stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, raw: [] }
  }
  async healthCheck() {
    return { ok: true as const }
  }
}

const stores: MemoryStore[] = []
const dirs: string[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-agenda-init-'))
  dirs.push(dir)
  const clock = fixedClock(Date.UTC(2026, 9, 17, 4)) // 09:00 PKT
  const memory = new MemoryStore(join(dir, 'a.db'), clock)
  stores.push(memory)
  const llm = new FakeLlm()
  const assistant = new Assistant({ llm, memory, clock, owner: { name: 'Hamza' }, prefs: { ...DEFAULT_PREFS, utcOffsetMin: 300 } })
  const spoken: InitiativeItem[] = []
  const later: InitiativeItem[][] = []
  const service = new InitiativeService({
    assistant,
    memory,
    clock,
    speak: async (event, item) => {
      spoken.push(item)
      for await (const _ of assistant.speakUp(event)) void _
    },
    later: items => later.push(items),
    silence: () => undefined,
    isBusy: () => false,
    agenda: now => buildAgenda(memory, now, { utcOffsetMin: 300 }),
    lastOwnerTurnAt: () => lastOwner,
  })
  let lastOwner = 0
  return { clock, memory, llm, assistant, service, spoken, later, ownerSpoke: () => (lastOwner = clock.now()) }
}

describe('agenda through the initiative service', () => {
  it('waits out the cooldown after the briefing, then asks once and listens', async () => {
    const s = setup()
    s.memory.addTask('Send revised quote', { dueAt: s.clock.now() + 6 * HOUR })
    await s.service.start()
    expect(s.spoken.map(i => i.kind)).toEqual(['briefing'])

    // Within the hour after the briefing: nothing, and nothing piled into Later.
    s.clock.advance(20 * MINUTE)
    await s.service.tick()
    expect(s.spoken).toHaveLength(1)
    expect(s.later.flat()).toEqual([])

    s.clock.advance(HOUR)
    await s.service.tick()
    const q = s.spoken[1]!
    expect(q).toMatchObject({ kind: 'question', title: 'Due soon: Send revised quote', expectsAnswer: true, canMute: true })
    expect(q.reason).toContain('due within 24 hours')
    expect(s.llm.requests.at(-1)!.turns.at(-1)).toMatchObject({ role: 'user' })
    expect(JSON.stringify(s.llm.requests.at(-1)!.turns.at(-1))).toContain('End with one clear question')

    // Never the same thing twice.
    s.clock.advance(2 * HOUR)
    await s.service.tick()
    expect(s.spoken).toHaveLength(2)
  })

  it('stays silent in Focus mode and asks later when the owner is back to normal', async () => {
    const s = setup()
    s.memory.addProposal({ kind: 'lesson', title: 'Send quotes as PDF.', detail: { statement: 'Send quotes as PDF.' }, evidence: 'You said: “sirf PDF”', dedupKey: 'x' })
    await s.service.start()
    s.service.setOwnerMode('focus')
    s.clock.advance(2 * HOUR)
    await s.service.tick()
    expect(s.spoken.map(i => i.kind)).toEqual(['briefing'])
    s.service.setOwnerMode('companion')
    await s.service.tick()
    expect(s.spoken.map(i => i.title)).toEqual(['Daily briefing', 'Quick check: Send quotes as PDF.'])
  })

  it('"Don’t ask again" mutes that question for good', async () => {
    const s = setup()
    const p = s.memory.createProject({ name: 'Block C tower' })
    s.memory.addTask('Review drawings', { projectId: p.id })
    s.clock.advance(4 * DAY)
    await s.service.start()
    s.clock.advance(2 * HOUR)
    await s.service.tick()
    const q = s.spoken.at(-1)!
    expect(q.title).toBe('How is Block C tower going?')
    await s.service.act(q.id, 'mute')
    s.clock.advance(3 * HOUR)
    await s.service.tick()
    expect(s.spoken.at(-1)!.id).toBe(q.id)
  })

  it('leaves the owner room: nothing from the agenda within 10 minutes of their last message', async () => {
    const s = setup()
    await s.service.start()
    s.clock.advance(2 * HOUR)
    s.memory.addTask('Send revised quote', { dueAt: s.clock.now() + 3 * HOUR })
    s.ownerSpoke()
    await s.service.tick()
    expect(s.spoken.map(i => i.kind)).toEqual(['briefing'])
    s.clock.advance(11 * MINUTE)
    await s.service.tick()
    expect(s.spoken.map(i => i.kind)).toEqual(['briefing', 'question'])
  })
})
