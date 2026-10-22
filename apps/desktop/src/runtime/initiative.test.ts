import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PREFS } from '@assistant/initiative'
import { MemoryStore } from '@assistant/memory'
import type { LlmEvent, LlmProvider } from '@assistant/providers'
import { Assistant } from '@assistant/runtime'
import { fixedClock, HOUR, MINUTE } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { InitiativeItem } from '../shared/ipc.ts'
import { InitiativeService, parseQuietHours, SNOOZE_MS } from './initiative.ts'

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }

class FakeLlm implements LlmProvider {
  readonly id = 'fake'
  readonly model = 'fake'
  calls = 0
  async *stream(): AsyncIterable<LlmEvent> {
    this.calls++
    yield { type: 'text', text: 'Theek hai.' }
    yield { type: 'done', stopReason: 'end', usage, raw: [{ type: 'text', text: 'Theek hai.' }] }
  }
  async healthCheck() {
    return { ok: true as const }
  }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const setup = (prefs: Partial<typeof DEFAULT_PREFS> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-init-'))
  dirs.push(dir)
  // 09:00 in Asia/Karachi.
  const clock = fixedClock(Date.UTC(2026, 9, 17, 4))
  const memory = new MemoryStore(join(dir, 'a.db'), clock)
  const llm = new FakeLlm()
  const assistant = new Assistant({ llm, memory, clock, owner: { name: 'Hamza' }, prefs: { ...DEFAULT_PREFS, utcOffsetMin: 300, ...prefs } })
  const spoken: InitiativeItem[] = []
  const later: { items: InitiativeItem[]; notify?: InitiativeItem }[] = []
  let silenced = 0
  const service = new InitiativeService({
    assistant,
    memory,
    clock,
    speak: async (event, item) => {
      spoken.push(item)
      for await (const _ of assistant.speakUp(event)) void _
    },
    later: (items, notify) => later.push({ items, notify }),
    silence: () => silenced++,
    isBusy: () => false,
  })
  const kinds = () => spoken.map(i => i.kind)
  return { clock, memory, llm, assistant, service, spoken, later, kinds, silenced: () => silenced }
}

/** Lock, wait, unlock: what powerMonitor reports through main. */
const awayFor = async (s: ReturnType<typeof setup>, ms: number) => {
  s.service.session({ signal: 'lock' })
  s.clock.advance(ms)
  s.service.session({ signal: 'unlock', idleMs: ms })
  await s.service.drain()
}

describe('desktop initiative wiring', () => {
  it('briefs once on start and never again across unlocks the same day', async () => {
    const s = setup()
    await s.service.start()
    expect(s.kinds()).toEqual(['briefing'])
    expect(s.spoken[0]?.reason).toMatch(/First session of the day/)

    for (let i = 0; i < 3; i++) await awayFor(s, 2 * MINUTE)
    expect(s.kinds()).toEqual(['briefing'])
    expect(s.llm.calls).toBe(1)
    s.memory.close()
  })

  it('briefs on the first unlock of a new day', async () => {
    const s = setup()
    await s.service.start()
    s.service.session({ signal: 'lock' })
    s.clock.advance(20 * HOUR) // next morning, 05:00 local
    s.service.session({ signal: 'unlock', idleMs: 20 * HOUR })
    await s.service.drain()
    // The new day's briefing replaces the welcome back.
    expect(s.kinds()).toEqual(['briefing', 'briefing'])
    s.memory.close()
  })

  it('stops speech on lock and defers due reminders until unlock', async () => {
    const s = setup()
    await s.service.start()
    s.service.session({ signal: 'lock' })
    expect(s.silenced()).toBe(1)
    expect(s.assistant.session.mode).toBe('locked')

    s.memory.addTask('Call the bank', { dueAt: s.clock.now() + 5 * MINUTE })
    s.clock.advance(10 * MINUTE)
    await s.service.tick()
    expect(s.kinds()).toEqual(['briefing'])

    s.service.session({ signal: 'unlock', idleMs: 10 * MINUTE })
    await s.service.drain()
    expect(s.assistant.session.mode).toBe('companion')
    expect(s.spoken.map(i => i.title)).toEqual(['Daily briefing', 'Call the bank'])
    s.memory.close()
  })

  it('reminds about a due task exactly once', async () => {
    const s = setup()
    await s.service.start()
    s.memory.addTask('Send revised quote', { dueAt: s.clock.now() + 30 * MINUTE })
    await s.service.tick()
    expect(s.kinds()).toEqual(['briefing'])

    s.clock.advance(31 * MINUTE)
    for (let i = 0; i < 4; i++) {
      await s.service.tick()
      s.clock.advance(MINUTE)
    }
    await awayFor(s, 3 * MINUTE)
    const reminders = s.spoken.filter(i => i.kind === 'reminder')
    expect(reminders).toHaveLength(1)
    expect(reminders[0]).toMatchObject({ title: 'Send revised quote', canMute: true, reason: 'Urgent item.' })
    s.memory.close()
  })

  it('covers overdue tasks in the briefing instead of a separate reminder', async () => {
    const s = setup()
    s.memory.addTask('Pay rent', { dueAt: s.clock.now() - HOUR })
    await s.service.start()
    expect(s.kinds()).toEqual(['briefing'])
    await s.service.tick()
    expect(s.kinds()).toEqual(['briefing'])
    s.memory.close()
  })

  it('respects the cooldown and the daily routine budget for welcome backs', async () => {
    const s = setup()
    await s.service.start() // the briefing is routine: 1 of 5
    await awayFor(s, 20 * MINUTE) // within the 60-minute cooldown
    expect(s.kinds()).toEqual(['briefing'])
    expect(s.later.at(-1)?.items.at(-1)).toMatchObject({ kind: 'check-in', channel: 'queue', reason: 'Within routine cooldown.' })

    for (let i = 0; i < 6; i++) await awayFor(s, 61 * MINUTE)
    expect(s.kinds()).toEqual(['briefing', 'check-in', 'check-in', 'check-in', 'check-in'])
    expect(s.later.at(-1)?.items.at(-1)?.reason).toBe('Daily routine budget used.')
    s.memory.close()
  })

  it('keeps quiet mode silent: urgent items notify, routine ones queue', async () => {
    const s = setup()
    s.service.setOwnerMode('quiet')
    await s.service.start()
    expect(s.spoken).toHaveLength(0)
    expect(s.later.at(-1)?.items.map(i => i.kind)).toEqual(['briefing'])

    s.memory.addTask('Submit form', { dueAt: s.clock.now() })
    await s.service.tick()
    expect(s.spoken).toHaveLength(0)
    expect(s.later.at(-1)?.notify).toMatchObject({ title: 'Submit form', channel: 'notify' })
    s.memory.close()
  })

  it('holds routine items back during quiet hours', async () => {
    // 09:00 local falls inside 08:00-10:00.
    const s = setup({ quietHours: parseQuietHours('08:00-10:00') })
    await s.service.start()
    expect(s.spoken).toHaveLength(0)
    expect(s.later.at(-1)?.items[0]).toMatchObject({ kind: 'briefing', reason: 'Quiet mode: queued for later.' })
    s.memory.close()
  })

  it('"Not now" brings a reminder back after the snooze; "Don\'t remind me again" keeps the task', async () => {
    const s = setup()
    await s.service.start()
    const snoozed = s.memory.addTask('Reply to Sara', { dueAt: s.clock.now() })
    const muted = s.memory.addTask('Water plants', { dueAt: s.clock.now() })
    await s.service.tick()
    expect(s.spoken.filter(i => i.kind === 'reminder').map(i => i.title)).toEqual(['Reply to Sara', 'Water plants'])

    await s.service.act(`due:${snoozed}`, 'snooze')
    await s.service.act(`due:${muted}`, 'mute')
    s.clock.advance(SNOOZE_MS / 2)
    await s.service.tick()
    expect(s.spoken.filter(i => i.kind === 'reminder')).toHaveLength(2)

    s.clock.advance(SNOOZE_MS)
    await s.service.tick()
    s.clock.advance(8 * 24 * HOUR - SNOOZE_MS * 2) // past the dedup window, same tasks still open
    await s.service.tick()
    expect(s.spoken.filter(i => i.kind === 'reminder').map(i => i.title)).toEqual(['Reply to Sara', 'Water plants', 'Reply to Sara'])
    expect(s.memory.getTask(muted)?.status).not.toBe('cancelled')
    s.memory.close()
  })

  it('parses quiet hours', () => {
    expect(parseQuietHours('22:00-07:30')).toEqual({ startMin: 1320, endMin: 450 })
    expect(parseQuietHours('25:00-07:00')).toBeUndefined()
    expect(parseQuietHours(undefined)).toBeUndefined()
  })
})
