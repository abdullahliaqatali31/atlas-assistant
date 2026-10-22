/**
 * Initiative manager: decides whether, and how, the assistant speaks up.
 * Pure function over (event, history, preferences, time) so it is cheap,
 * deterministic and runs before any LLM call.
 */
import { DAY, HOUR, type ConversationMode, type InitiativeEvent } from '@assistant/shared'

import { QUIET_BELOW, welcomeChance, welcomeContext, type WelcomeTable } from './welcome.ts'

export * from './welcome.ts'

export type Channel = 'speak' | 'notify' | 'queue' | 'suppress'

export interface InitiativePrefs {
  /** Minimum gap between routine unsolicited check-ins. */
  routineCooldownMs: number
  /** Max routine interventions per local day. */
  dailyRoutineBudget: number
  /** Quiet hours in owner-local minutes since midnight; may wrap past midnight. */
  quietHours?: { startMin: number; endMin: number }
  /** Owner's UTC offset in minutes, e.g. +300 for Asia/Karachi. */
  utcOffsetMin: number
}

export const DEFAULT_PREFS: InitiativePrefs = {
  routineCooldownMs: HOUR,
  dailyRoutineBudget: 5,
  utcOffsetMin: 0,
}

export interface InitiativeHistory {
  /** Dedup keys already handled, with when. */
  handled: ReadonlyMap<string, number>
  /** Times of routine interventions that reached the owner (speak/notify). */
  routineDeliveredAt: readonly number[]
  /** Local day (YYYY-MM-DD) of the last daily briefing. */
  lastBriefingDay?: string
}

export interface InitiativeDecision {
  channel: Channel
  dedupKey: string
  isRoutine: boolean
  reason: string
}

const localDay = (at: number, offsetMin: number) => new Date(at + offsetMin * 60_000).toISOString().slice(0, 10)

const localMinute = (at: number, offsetMin: number) => {
  const d = new Date(at + offsetMin * 60_000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

export const isQuietTime = (at: number, prefs: InitiativePrefs) => {
  const q = prefs.quietHours
  if (!q) return false
  const m = localMinute(at, prefs.utcOffsetMin)
  return q.startMin <= q.endMin ? m >= q.startMin && m < q.endMin : m >= q.startMin || m < q.endMin
}

export const dedupKeyOf = (e: InitiativeEvent, offsetMin: number): string => {
  switch (e.type) {
    case 'session.first-of-day':
      return `briefing:${localDay(e.at, offsetMin)}`
    case 'session.return-from-idle':
      return `return:${Math.floor(e.at / HOUR)}`
    case 'commitment.due':
      return `due:${e.commitmentId}`
    case 'message.arrived':
      return `msg:${e.source.origin}:${e.source.locator ?? e.preview}`
    case 'task.failed':
      return `failed:${e.taskId}`
    case 'project.changed':
      return `project:${e.projectId}:${localDay(e.at, offsetMin)}`
    case 'agenda':
      return `agenda:${e.key}`
  }
}

const isUrgent = (e: InitiativeEvent) =>
  e.type === 'commitment.due' || e.type === 'task.failed' || (e.type === 'message.arrived' && e.isUrgent)

export const decide = (
  e: InitiativeEvent,
  mode: ConversationMode,
  history: InitiativeHistory,
  prefs: InitiativePrefs = DEFAULT_PREFS,
  /** What the owner's reactions taught about when speaking up is welcome. */
  welcome?: WelcomeTable,
): InitiativeDecision => {
  const dedupKey = dedupKeyOf(e, prefs.utcOffsetMin)
  const urgent = isUrgent(e)
  const isRoutine = !urgent
  const base = { dedupKey, isRoutine }

  if (history.handled.has(dedupKey)) {
    return { ...base, channel: 'suppress', reason: 'Already handled.' }
  }

  if (mode === 'locked' || mode === 'away') {
    return { ...base, channel: 'queue', reason: `Owner is ${mode}; nothing private is spoken.` }
  }

  if (mode === 'quiet' || isQuietTime(e.at, prefs)) {
    return urgent
      ? { ...base, channel: 'notify', reason: 'Quiet mode: urgent item shown silently.' }
      : { ...base, channel: 'queue', reason: 'Quiet mode: queued for later.' }
  }

  if (mode === 'focus' && !urgent) {
    return { ...base, channel: 'queue', reason: 'Focus mode: routine item queued.' }
  }

  if (urgent) {
    return { ...base, channel: mode === 'focus' ? 'notify' : 'speak', reason: 'Urgent item.' }
  }

  // A task the owner taught and scheduled: their own request, so no budget or cooldown (modes above still apply).
  if (e.type === 'agenda' && e.key.startsWith('skill:')) {
    return { dedupKey, isRoutine: false, channel: 'speak', reason: 'A task you scheduled.' }
  }

  if (e.type === 'session.first-of-day') {
    return history.lastBriefingDay === localDay(e.at, prefs.utcOffsetMin)
      ? { ...base, channel: 'suppress', reason: 'Briefing already given today.' }
      : { ...base, channel: 'speak', reason: 'First session of the day: greet and brief.' }
  }

  const today = localDay(e.at, prefs.utcOffsetMin)
  const deliveredToday = history.routineDeliveredAt.filter(t => localDay(t, prefs.utcOffsetMin) === today)
  if (deliveredToday.length >= prefs.dailyRoutineBudget) {
    return { ...base, channel: 'queue', reason: 'Daily routine budget used.' }
  }

  const last = history.routineDeliveredAt.at(-1)
  if (last !== undefined && e.at - last < prefs.routineCooldownMs) {
    return { ...base, channel: 'queue', reason: 'Within routine cooldown.' }
  }

  // Within the owner's rules, what their reactions taught: a speak-up they usually pass on is shown quietly.
  const context = welcome ? welcomeContext(e, prefs.utcOffsetMin) : null
  if (welcome && context && welcomeChance(welcome, context, e.at) < QUIET_BELOW) {
    return { ...base, channel: 'notify', reason: 'You usually pass on these at this time of day, so it is shown quietly.' }
  }

  return { ...base, channel: 'speak', reason: 'Routine check-in allowed.' }
}

/** Drop handled keys older than a week so history stays bounded. */
export const pruneHandled = (handled: ReadonlyMap<string, number>, now: number) =>
  new Map([...handled].filter(([, at]) => now - at < 7 * DAY))
