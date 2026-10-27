import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decide, DEFAULT_PREFS } from '@assistant/initiative'
import { MemoryStore } from '@assistant/memory'
import { fixedClock, HOUR, MINUTE } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { describeSchedule, parseSchedule, skillAgenda, skillContextLines, skillTools } from './skills.ts'
import { DEFAULT_RULES } from './tools.ts'

const stores: MemoryStore[] = []
const dirs: string[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PKT = 300
/** Monday 19 Oct 2026, 08:00 in Karachi. */
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-skills-'))
  dirs.push(dir)
  const clock = fixedClock(Date.UTC(2026, 9, 19, 3))
  const memory = new MemoryStore(join(dir, 'a.db'), clock)
  stores.push(memory)
  const tools = skillTools(memory, clock, PKT)
  const call = (name: string, input: Record<string, unknown>) => tools.find(t => t.name === name)!.run(input)
  return { memory, clock, tools, call }
}

const emailSkill = {
  name: 'client email summary',
  goal: 'Summarise new client emails and make tasks for urgent ones',
  steps: ['Open Gmail in the browser', 'Search unread emails from clients', 'Summarise each in one line', 'Add a task for anything urgent'],
  inputs: [],
  check: 'Every unread client email is in the summary',
  approve: 'replying to anyone',
}

describe('parseSchedule', () => {
  it('understands times, days, weekdays and one-off runs', () => {
    expect(parseSchedule({ time: '09:30' }, PKT)).toEqual({ kind: 'daily', minute: 570, days: [] })
    expect(parseSchedule({ time: '10:00', days: ['Monday', 'thu'] }, PKT)).toEqual({ kind: 'daily', minute: 600, days: [1, 4] })
    expect(parseSchedule({ time: '7:05', days: 'weekdays' }, PKT)).toEqual({ kind: 'daily', minute: 425, days: [1, 2, 3, 4, 5] })
    expect(parseSchedule({ once_at: '2026-10-20T17:00:00+05:00' }, PKT)).toEqual({ kind: 'once', at: Date.parse('2026-10-20T17:00:00+05:00') })
    expect(parseSchedule(undefined, PKT)).toBeNull()
  })

  it('explains what it cannot understand', () => {
    expect(parseSchedule({ time: '25:00' }, PKT)).toMatch(/HH:MM/)
    expect(parseSchedule({ time: '09:00', days: ['someday'] }, PKT)).toMatch(/unknown day/)
    expect(parseSchedule({ once_at: 'kal shaam' }, PKT)).toMatch(/ISO/)
  })

  it('describes schedules in plain words', () => {
    expect(describeSchedule(null, PKT)).toBe('when you ask')
    expect(describeSchedule({ kind: 'daily', minute: 600, days: [1, 4] }, PKT)).toBe('Mon, Thu at 10:00')
    expect(describeSchedule({ kind: 'daily', minute: 540, days: [1, 2, 3, 4, 5] }, PKT)).toBe('weekdays at 09:00')
  })
})

describe('teaching and running a skill', () => {
  it('saves a taught skill, updates it by name, and keeps the owner’s auto setting', async () => {
    const { memory, call } = setup()
    expect(await call('skill_save', { ...emailSkill, schedule: { time: '09:00', days: 'weekdays' } })).toMatch(/^Learned "client email summary" \(4 steps, runs weekdays at 09:00\)/)
    const id = memory.skill('Client Email Summary')!.id
    memory.updateSkill(id, { auto: true })
    expect(await call('skill_save', { ...emailSkill, steps: [...emailSkill.steps, 'Read me the summary'] })).toMatch(/^Updated/)
    const s = memory.skill(id)!
    expect(s.steps).toHaveLength(5)
    expect(s.auto).toBe(true)
    expect(s.schedule).toEqual({ kind: 'daily', minute: 540, days: [1, 2, 3, 4, 5] })
    expect(await call('skill_save', { name: 'x', goal: 'y', steps: [] })).toMatch(/at least one step/)
    expect(await call('skill_save', { ...emailSkill, name: 'z', schedule: { time: 'noon' } })).toMatch(/Schedule not understood/)
  })

  it('runs by a loose name, hands over the steps with safety rules, and records a checked result', async () => {
    const { memory, call } = setup()
    await call('skill_save', emailSkill)
    const started = await call('skill_run', { name: 'client email' })
    const runId = /run_id ([0-9a-f-]+)/.exec(started)![1]!
    expect(started).toContain('1. Open Gmail in the browser')
    expect(started).toContain('Ask the owner before: replying to anyone.')
    expect(started).toContain('Always ask before sending, posting, deleting, paying or submitting')
    expect(started).toContain('Never say it is done unless you checked')
    expect(await call('skill_finish', { run_id: runId, ok: true, summary: '3 emails summarised, 1 task added' })).toBe('Recorded.')
    expect(await call('skill_finish', { run_id: runId, ok: false, summary: 'again' })).toMatch(/already finished/)
    expect(memory.skillRuns(memory.skill(emailSkill.name)!.id)[0]).toMatchObject({ ok: true, trigger: 'owner', summary: '3 emails summarised, 1 task added' })
    expect(await call('skill_run', { name: 'tax return' })).toMatch(/^No skill called "tax return". Known: client email summary/)
  })

  it('needs the owner’s yes to delete, and deleting removes the run history', async () => {
    const { memory, tools, call } = setup()
    await call('skill_save', emailSkill)
    await call('skill_run', { name: emailSkill.name })
    expect(tools.find(t => t.name === 'skill_delete')!.actionClass).toBe('destructive')
    expect(DEFAULT_RULES.some(r => r.tool === 'skill_delete')).toBe(false)
    const id = memory.skill(emailSkill.name)!.id
    await call('skill_delete', { name: emailSkill.name })
    expect(memory.skills()).toEqual([])
    expect(memory.skillRuns(id)).toEqual([])
  })

  it('tells the model how to learn, what it knows, and when to offer a skill', async () => {
    const { memory, call } = setup()
    expect(skillContextLines(memory, PKT)[0]).toMatch(/^Teaching: .*Save it with skill_save only after they confirm/)
    await call('skill_save', { ...emailSkill, when: 'a new email from a client arrives' })
    const lines = skillContextLines(memory, PKT).join('\n')
    expect(lines).toContain('- client email summary: Summarise new client emails and make tasks for urgent ones [when you ask; offer it when a new email from a client arrives]')
    expect(lines).toContain('do not run it without a yes')
  })
})

describe('scheduled skills', () => {
  it('comes due at its time on its days, once per slot, asking first unless allowed to run by itself', async () => {
    const { memory, clock, call } = setup()
    await call('skill_save', { ...emailSkill, schedule: { time: '09:00', days: ['mon', 'wed'] } })
    expect(skillAgenda(memory, clock.now(), { utcOffsetMin: PKT })).toEqual([])
    clock.advance(HOUR) // Mon 09:00
    const [ask] = skillAgenda(memory, clock.now(), { utcOffsetMin: PKT })
    expect(ask).toMatchObject({ kind: 'question', key: expect.stringMatching(/^skill:.*:2026-10-19-540$/), expectsAnswer: true })
    memory.updateSkill(memory.skill(emailSkill.name)!.id, { auto: true })
    expect(skillAgenda(memory, clock.now(), { utcOffsetMin: PKT })[0]).toMatchObject({ kind: 'task', title: 'Doing: client email summary', expectsAnswer: false })
    // Missed by more than two hours: skipped, not run late in the day. Tuesday: not a chosen day.
    clock.advance(3 * HOUR)
    expect(skillAgenda(memory, clock.now(), { utcOffsetMin: PKT })).toEqual([])
    clock.advance(21 * HOUR)
    expect(skillAgenda(memory, clock.now(), { utcOffsetMin: PKT })).toEqual([])
    // Paused: nothing.
    clock.advance(24 * HOUR) // Wed 09:00
    memory.updateSkill(memory.skill(emailSkill.name)!.id, { status: 'paused' })
    expect(skillAgenda(memory, clock.now(), { utcOffsetMin: PKT })).toEqual([])
  })

  it('a one-off run comes due once at its time', async () => {
    const { memory, clock, call } = setup()
    await call('skill_save', { ...emailSkill, schedule: { once_at: '2026-10-19T17:00:00+05:00' } })
    clock.set(Date.parse('2026-10-19T16:59:00+05:00'))
    expect(skillAgenda(memory, clock.now(), { utcOffsetMin: PKT })).toEqual([])
    clock.advance(5 * MINUTE)
    expect(skillAgenda(memory, clock.now(), { utcOffsetMin: PKT })).toHaveLength(1)
  })

  it('skips the chatter budget and cooldown, but still respects quiet and focus modes', () => {
    const { clock } = setup()
    const e = { type: 'agenda' as const, at: clock.now(), key: 'skill:abc:2026-10-19-540', kind: 'task' as const, title: 't', instruction: 'i', evidence: 'e', expectsAnswer: false }
    const busy = { handled: new Map(), routineDeliveredAt: [clock.now() - MINUTE, clock.now() - 2 * MINUTE, clock.now() - 3 * MINUTE, clock.now() - 4 * MINUTE, clock.now() - 5 * MINUTE] }
    const prefs = { ...DEFAULT_PREFS, utcOffsetMin: PKT }
    expect(decide(e, 'companion', busy, prefs)).toMatchObject({ channel: 'speak', isRoutine: false })
    expect(decide(e, 'quiet', busy, prefs).channel).toBe('queue')
    expect(decide(e, 'focus', busy, prefs).channel).toBe('queue')
  })
})
