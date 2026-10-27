/**
 * Skills: tasks the owner teaches the assistant ("ye task seekho"), saved as
 * a goal and plain-language steps, not recorded clicks. When a skill runs,
 * the model follows the steps with its own tools and judgement (pages
 * change; it re-finds things), asks before anything risky, checks the result
 * and records it. A skill runs when the owner asks, at a time they set, or
 * when the assistant notices the situation it was taught for, asking first
 * unless the owner switched on "run by itself".
 */
import type { MemoryStore, Skill, SkillSchedule } from '@assistant/memory'
import { DAY, type Clock } from '@assistant/shared'

import type { AgendaEvent } from './agenda.ts'
import type { RuntimeTool } from './tools.ts'

export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
/** A scheduled run still happens if the assistant was busy or away for up to this long. */
const SCHEDULE_GRACE_MIN = 120
const MAX_STEPS = 30

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, max).map(s => s.slice(0, 400)) : [])

/**
 * The model's schedule ("09:30" on ["mon","thu"], "daily", "weekdays", or a
 * one-off ISO time) as a stored schedule in the owner's local minutes.
 * Returns an error string when it cannot be understood.
 */
export const parseSchedule = (input: unknown, utcOffsetMin: number): SkillSchedule | null | string => {
  if (input === undefined || input === null || input === '') return null
  if (typeof input !== 'object' || Array.isArray(input)) return 'schedule must be an object'
  const o = input as Record<string, unknown>
  if (o.once_at !== undefined) {
    const at = Date.parse(str(o.once_at))
    return Number.isNaN(at) ? 'once_at must be an ISO 8601 time with offset' : { kind: 'once', at }
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(o.time))
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return 'time must be HH:MM (24-hour, owner local time)'
  const minute = Number(m[1]) * 60 + Number(m[2])
  const raw = o.days
  let days: number[] = []
  if (raw === undefined || raw === 'daily' || raw === 'every day') days = []
  else if (raw === 'weekdays') days = [1, 2, 3, 4, 5]
  else if (Array.isArray(raw)) {
    for (const d of raw) {
      const i = DAY_NAMES.indexOf(str(d).toLowerCase().slice(0, 3) as (typeof DAY_NAMES)[number])
      if (i < 0) return `unknown day "${String(d)}" (use mon, tue, wed, thu, fri, sat, sun)`
      days.push(i)
    }
    days = [...new Set(days)].sort()
    if (days.length === 7) days = []
  } else return 'days must be "daily", "weekdays" or a list like ["mon","thu"]'
  void utcOffsetMin
  return { kind: 'daily', minute, days }
}

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

export const describeSchedule = (s: SkillSchedule | null, utcOffsetMin: number): string => {
  if (!s) return 'when you ask'
  if (s.kind === 'once') return `once, ${new Date(s.at + utcOffsetMin * 60_000).toISOString().slice(0, 16).replace('T', ' ')}`
  const days = s.days.length === 0 ? 'every day' : s.days.join() === '1,2,3,4,5' ? 'weekdays' : s.days.map(d => DAY_NAMES[d]![0]!.toUpperCase() + DAY_NAMES[d]!.slice(1)).join(', ')
  return `${days} at ${hhmm(s.minute)}`
}

/** What the model gets when a skill starts: everything it needs to do it well and honestly. */
export const runInstruction = (skill: Skill, runId: string, values = '') =>
  [
    `Run the skill "${skill.name}" now (run_id ${runId}).`,
    `Goal: ${skill.goal}`,
    'Steps (follow them with your tools; if the screen or page differs, use judgement to reach the same result):',
    ...skill.steps.map((s, i) => `${i + 1}. ${s}`),
    skill.inputs.length ? `Inputs for this run: ${values || `ask the owner for ${skill.inputs.join(', ')} if not already clear`}.` : '',
    skill.approve ? `Ask the owner before: ${skill.approve}.` : '',
    'Always ask before sending, posting, deleting, paying or submitting anything, even if a step says to do it.',
    `Check it worked: ${skill.check || 'confirm the goal is visibly achieved'}.`,
    `When done (or if you cannot finish), call skill_finish with run_id ${runId}, ok true or false, and what you actually verified. Then tell the owner the result in one or two sentences. Never say it is done unless you checked.`,
  ]
    .filter(Boolean)
    .join('\n')

/** Lines for the model's context: what it can do, and how to learn more. */
export const skillContextLines = (memory: MemoryStore, utcOffsetMin: number): string[] => {
  const skills = memory.skills()
  const lines = [
    'Teaching: when the owner wants to teach you a task ("ye task seekho", "learn this", "record this"), find out briefly what it should achieve, the steps, what changes each time, how to check it worked, which steps need their yes, and when it should run (when asked, at a time, or in a situation). Read the steps back in a few lines. Offer to do it together once now with your tools, one step at a time. Save it with skill_save only after they confirm.',
  ]
  if (skills.length) {
    lines.push(
      `Skills the owner taught you (start one with skill_run when they ask, even in other words):\n${skills
        .map(s => `- ${s.name}: ${s.goal} [${s.status === 'paused' ? 'paused' : describeSchedule(s.schedule, utcOffsetMin)}${s.when ? `; offer it when ${s.when}` : ''}]`)
        .join('\n')}`,
    )
  }
  const watch = skills.filter(s => s.status === 'active' && s.when)
  if (watch.length) lines.push('If you notice one of those situations in what you read or hear, offer to run that skill (one short question); do not run it without a yes.')
  return lines
}

/** Scheduled skills due now, as agenda items: done by itself when allowed, otherwise offered first. */
export const skillAgenda = (memory: MemoryStore, now: number, opts: { utcOffsetMin: number }): (AgendaEvent & { priority: number })[] => {
  const local = now + opts.utcOffsetMin * 60_000
  const minute = Math.floor((((local % DAY) + DAY) % DAY) / 60_000)
  const weekday = new Date(local).getUTCDay()
  const day = new Date(local).toISOString().slice(0, 10)
  const items: (AgendaEvent & { priority: number })[] = []
  for (const s of memory.skills()) {
    if (s.status !== 'active' || !s.schedule) continue
    let slot: string | null = null
    if (s.schedule.kind === 'once') {
      if (now >= s.schedule.at && now - s.schedule.at <= SCHEDULE_GRACE_MIN * 60_000) slot = `once-${s.schedule.at}`
    } else if ((s.schedule.days.length === 0 || s.schedule.days.includes(weekday)) && minute >= s.schedule.minute && minute - s.schedule.minute <= SCHEDULE_GRACE_MIN) {
      slot = `${day}-${s.schedule.minute}`
    }
    if (!slot) continue
    const when = describeSchedule(s.schedule, opts.utcOffsetMin)
    items.push(
      s.auto
        ? {
            type: 'agenda',
            at: now,
            key: `skill:${s.id}:${slot}`,
            kind: 'task',
            title: `Doing: ${s.name}`,
            instruction: `It is time for the skill "${s.name}" (${when}), which the owner allowed you to run by itself. Call skill_run with name "${s.name}" and trigger "schedule", do it, then report the result briefly.`,
            evidence: `You set “${s.name}” to run ${when}.`,
            expectsAnswer: false,
            priority: 90,
          }
        : {
            type: 'agenda',
            at: now,
            key: `skill:${s.id}:${slot}`,
            kind: 'question',
            title: `Time for: ${s.name}`,
            instruction: `It is time for the skill "${s.name}" (${when}): ${s.goal}. Ask the owner in one short sentence if you should do it now. If they say yes, call skill_run with name "${s.name}" and trigger "schedule" and do it.`,
            evidence: `You set “${s.name}” for ${when}.`,
            expectsAnswer: true,
            priority: 90,
          },
    )
  }
  return items
}

const scheduleSchema = {
  type: 'object',
  description: 'When it runs by itself. Omit to run only when asked.',
  properties: {
    time: { type: 'string', description: 'HH:MM, 24-hour, owner local time' },
    days: { description: '"daily", "weekdays", or a list like ["mon","thu"]' },
    once_at: { type: 'string', description: 'For a one-off run: ISO 8601 time with offset' },
  },
}

export const skillTools = (memory: MemoryStore, clock: Clock, utcOffsetMin: number): RuntimeTool[] => [
  {
    name: 'skill_save',
    description:
      'Save (or update, by the same name) a task the owner taught you, after they confirmed the steps. Steps are plain language you will follow later with your tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name the owner can say, e.g. "client email summary"' },
        goal: { type: 'string', description: 'What it achieves, one sentence' },
        steps: { type: 'array', items: { type: 'string' }, description: 'The steps, in order, one action each' },
        inputs: { type: 'array', items: { type: 'string' }, description: 'What changes each run, e.g. "client name"' },
        check: { type: 'string', description: 'How to tell it worked' },
        approve: { type: 'string', description: 'Steps that need the owner’s yes, e.g. "sending the email"' },
        schedule: scheduleSchema,
        when: { type: 'string', description: 'A situation in which to offer it, e.g. "a new email from a client arrives"' },
      },
      required: ['name', 'goal', 'steps'],
      additionalProperties: false,
    },
    actionClass: 'modify',
    isUntrusted: false,
    run: async input => {
      const name = str(input.name).slice(0, 80)
      const steps = strings(input.steps, MAX_STEPS)
      if (!name || !str(input.goal) || steps.length === 0) return 'A skill needs a name, a goal and at least one step.'
      const schedule = parseSchedule(input.schedule, utcOffsetMin)
      if (typeof schedule === 'string') return `Schedule not understood: ${schedule}.`
      const { skill, created } = memory.saveSkill({
        name,
        goal: str(input.goal).slice(0, 400),
        steps,
        inputs: strings(input.inputs, 10),
        check: str(input.check).slice(0, 400),
        approve: str(input.approve).slice(0, 400),
        // Left out on an update: keep what was set before.
        schedule: input.schedule === undefined ? undefined : schedule,
        when: input.when === undefined ? undefined : str(input.when).slice(0, 300) || null,
      })
      return `${created ? 'Learned' : 'Updated'} "${skill.name}" (${skill.steps.length} steps, runs ${describeSchedule(skill.schedule, utcOffsetMin)}${skill.when ? `, offered when ${skill.when}` : ''}). On its schedule you ask first, unless the owner turns on “By itself on schedule” for it on the Learning screen (not in Setup).`
    },
  },
  {
    name: 'skill_list',
    description: 'List the skills the owner taught you, with when they run and the last result.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    actionClass: 'observe',
    isUntrusted: false,
    run: async () => {
      const skills = memory.skills()
      if (!skills.length) return 'No skills taught yet.'
      return skills
        .map(s => {
          const last = memory.skillRuns(s.id, 1)[0]
          return `- ${s.name}: ${s.goal} (${s.status === 'paused' ? 'paused' : describeSchedule(s.schedule, utcOffsetMin)}${s.auto ? ', runs by itself' : ''}${last ? `; last run ${last.ok === null ? 'unfinished' : last.ok ? 'ok' : 'failed'}` : ''})`
        })
        .join('\n')
    },
  },
  {
    name: 'skill_run',
    description: 'Start a taught skill now, when the owner asks (in any words) or a scheduled reminder says so. Returns the steps to follow and a run_id for skill_finish.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        inputs: { type: 'string', description: 'Values for this run, e.g. "client: Ahmed Raza"' },
        trigger: { type: 'string', enum: ['owner', 'schedule', 'situation'] },
      },
      required: ['name'],
      additionalProperties: false,
    },
    actionClass: 'modify',
    isUntrusted: false,
    run: async input => {
      const want = str(input.name).toLowerCase()
      const skill = memory.skill(want) ?? memory.skills().find(s => s.name.toLowerCase().includes(want) || want.includes(s.name.toLowerCase()))
      if (!skill) return `No skill called "${str(input.name)}". Known: ${memory.skills().map(s => s.name).join(', ') || 'none yet'}.`
      const runId = memory.startSkillRun(skill.id, str(input.trigger) || 'owner')
      return runInstruction(skill, runId, str(input.inputs))
    },
  },
  {
    name: 'skill_finish',
    description: 'Record how a skill run ended, with what you actually verified. Call once per run_id.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' }, ok: { type: 'boolean' }, summary: { type: 'string', description: 'What was done and how you checked it' } },
      required: ['run_id', 'ok', 'summary'],
      additionalProperties: false,
    },
    actionClass: 'modify',
    isUntrusted: false,
    run: async input => (memory.finishSkillRun(str(input.run_id), input.ok === true, str(input.summary)) ? 'Recorded.' : 'Unknown or already finished run_id.'),
  },
  {
    name: 'skill_delete',
    description: 'Delete a taught skill when the owner asks.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    // Losing a taught skill is permanent: the owner confirms.
    actionClass: 'destructive',
    isUntrusted: false,
    run: async input => {
      const skill = memory.skill(str(input.name))
      if (!skill) return `No skill called "${str(input.name)}".`
      memory.deleteSkill(skill.id)
      void clock
      return `Deleted "${skill.name}".`
    },
  },
]
