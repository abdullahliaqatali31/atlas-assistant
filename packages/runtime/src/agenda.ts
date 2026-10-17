/**
 * The assistant's own agenda (plan section 9): things worth raising with the
 * owner without being asked, each with a reason and evidence from real data.
 * Pure over the memory store and the clock, so it is cheap to run on every
 * tick; the attention policy still decides whether and how it is said.
 */
import type { MemoryStore } from '@assistant/memory'
import { DAY, HOUR, type InitiativeEvent } from '@assistant/shared'

import { curiosityItems } from './curiosity.ts'
import { startOfLocalDay } from './day.ts'

export type AgendaEvent = Extract<InitiativeEvent, { type: 'agenda' }>

export interface AgendaOptions {
  utcOffsetMin: number
  /** Owner-local minute after which the end-of-day wrap-up may come (default 18:00). */
  wrapUpMinute?: number
  /** Projects without an update for this long get a status question. */
  staleProjectMs?: number
  /** Follow-ups, opinions on stuck tasks and get-to-know questions (default on). */
  curiosity?: boolean
}

const localMinute = (now: number, offsetMin: number) => Math.floor((((now + offsetMin * 60_000) % DAY) + DAY) % DAY / 60_000)
const localDay = (now: number, offsetMin: number) => new Date(now + offsetMin * 60_000).toISOString().slice(0, 10)
const fmtTime = (t: number, offsetMin: number) => new Date(t + offsetMin * 60_000).toISOString().slice(11, 16)

/**
 * Everything on the agenda right now, most important first. Each item has a
 * stable key, so once raised (or snoozed, muted) it does not come back.
 */
export const buildAgenda = (memory: MemoryStore, now: number, opts: AgendaOptions): (AgendaEvent & { priority: number })[] => {
  const { utcOffsetMin } = opts
  const wrapUpMinute = opts.wrapUpMinute ?? 18 * 60
  const staleMs = opts.staleProjectMs ?? 3 * DAY
  const items: (AgendaEvent & { priority: number })[] = []
  const minute = localMinute(now, utcOffsetMin)

  // 1. End-of-day wrap-up: once per day, between the wrap-up time and 23:00.
  if (minute >= wrapUpMinute && minute < 23 * 60) {
    const done = memory.tasksCompletedSince(startOfLocalDay(now, utcOffsetMin))
    const open = memory.openTasks()
    const tomorrowEnd = startOfLocalDay(now, utcOffsetMin) + 2 * DAY
    const dueSoon = open.filter(t => t.dueAt !== null && t.dueAt < tomorrowEnd)
    items.push({
      type: 'agenda',
      at: now,
      key: `wrap-up:${localDay(now, utcOffsetMin)}`,
      kind: 'wrap-up',
      title: 'End-of-day wrap-up',
      instruction: [
        'Give a short end-of-day wrap-up.',
        done.length ? `Completed today: ${done.map(d => `"${d.title}"`).join(', ')}.` : 'Nothing was marked completed today; say so plainly, without judgement.',
        dueSoon.length ? `Still open and due by tomorrow: ${dueSoon.map(t => `"${t.title}"`).join(', ')}.` : `${open.length} task(s) still open, none due tomorrow.`,
        'Ask what should carry over to tomorrow, or if anything should be noted before they finish.',
      ].join(' '),
      evidence: `It is after ${String(Math.floor(wrapUpMinute / 60)).padStart(2, '0')}:${String(wrapUpMinute % 60).padStart(2, '0')}, the end of your working day.`,
      expectsAnswer: true,
      priority: 80,
    })
  }

  // 2. Deadlines in the next 24 hours.
  for (const t of memory.openTasks()) {
    if (t.dueAt === null || t.dueAt <= now || t.dueAt - now > 24 * HOUR) continue
    items.push({
      type: 'agenda',
      at: now,
      key: `due-soon:${t.id}`,
      kind: 'nudge',
      title: `Due soon: ${t.title}`,
      instruction: `The task "${t.title}" is due at ${fmtTime(t.dueAt, utcOffsetMin)}${t.dueAt - now > 12 * HOUR ? ' tomorrow' : ' today'}. Ask if it is on track or if they want help with it.`,
      evidence: `“${t.title}” is due within 24 hours.`,
      expectsAnswer: true,
      priority: 70,
    })
  }

  // 3. One learning suggestion at a time, as a natural question.
  const suggestion = memory.proposals('pending', 50).filter(p => p.kind !== 'workflow').at(-1)
  if (suggestion) {
    const what =
      suggestion.kind === 'personality'
        ? `You would like to change how you talk: "${suggestion.title}"`
        : suggestion.kind === 'lesson'
          ? `You want to remember this rule for next time: "${suggestion.title}"`
          : `You noticed something about the owner and want to check it: "${suggestion.title}"`
    items.push({
      type: 'agenda',
      at: now,
      key: `confirm:${suggestion.id}`,
      kind: 'question',
      title: `Quick check: ${suggestion.title}`,
      instruction: `${what}. Ask them to confirm, casually. If they clearly say yes or no, call suggestion_answer with proposal_id "${suggestion.id}". If they are unsure, leave it.`,
      evidence: suggestion.evidence,
      expectsAnswer: true,
      priority: 50,
    })
  }

  // 4. Active projects with open work and no update for a while.
  for (const p of memory.listProjects()) {
    if (p.status !== 'active' || p.openTasks === 0 || now - p.updatedAt < staleMs) continue
    const days = Math.floor((now - p.updatedAt) / DAY)
    items.push({
      type: 'agenda',
      at: now,
      // Once a week at most per project.
      key: `project-status:${p.id}:${Math.floor(now / (7 * DAY))}`,
      kind: 'question',
      title: `How is ${p.name} going?`,
      instruction: `The project "${p.name}" has ${p.openTasks} open task(s) and no update for ${days} days${p.state ? ` (last state: "${p.state}")` : ''}. Ask for a quick status. If they give one, call project_update with the new state.`,
      evidence: `No update on ${p.name} for ${days} days.`,
      expectsAnswer: true,
      priority: 40,
    })
  }

  // 5. Curiosity: follow-ups, opinions on stuck tasks, getting to know the owner.
  if (opts.curiosity !== false) items.push(...curiosityItems(memory, now, { utcOffsetMin }))

  return items.sort((a, b) => b.priority - a.priority)
}
