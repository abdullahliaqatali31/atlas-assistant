/**
 * When speaking up is welcome, learned from the owner's own reactions: for
 * each kind of routine speak-up and time of day, how often it was welcome
 * (they replied, or asked to hear it) or not ("not now", "don't remind me",
 * dismissed, talked over). A Beta-Bernoulli estimate per context, with old
 * reactions fading (two-week half-life) so a "no" is retried some day.
 * It only ever turns a routine "speak" into a quiet "notify": the owner's
 * rules (quiet hours, budget, cooldown, modes) still come first, and
 * reminders, urgent messages and briefings are never touched.
 */
import { DAY, type InitiativeEvent } from '@assistant/shared'

/** Weighted evidence for one context, and when it was last updated. */
export interface WelcomeCounts {
  yes: number
  no: number
  at: number
}

export type WelcomeTable = Record<string, WelcomeCounts>

const HALF_LIFE = 14 * DAY
/** Prior: two welcome to one not, so new kinds of speak-up start out allowed. */
const PRIOR_YES = 2
const PRIOR_NO = 1
/** Below this chance of being welcome, a routine speak-up is shown quietly instead. */
export const QUIET_BELOW = 0.35

const dayPart = (at: number, offsetMin: number) => {
  const h = new Date(at + offsetMin * 60_000).getUTCHours()
  return h < 6 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'
}

/** The context a speak-up is judged in, or null for ones the learner never touches. */
export const welcomeContext = (e: InitiativeEvent, offsetMin: number): string | null => {
  let kind: string
  switch (e.type) {
    case 'agenda':
      if (e.key.startsWith('skill:')) return null
      kind = `agenda:${e.kind}`
      break
    case 'session.return-from-idle':
      kind = 'welcome-back'
      break
    case 'project.changed':
      kind = 'project'
      break
    case 'message.arrived':
      if (e.isUrgent) return null
      kind = 'message'
      break
    default:
      return null
  }
  return `${kind}@${dayPart(e.at, offsetMin)}`
}

const faded = (c: WelcomeCounts, now: number) => {
  const k = Math.pow(0.5, Math.max(0, now - c.at) / HALF_LIFE)
  return { yes: c.yes * k, no: c.no * k }
}

/** The estimated chance this context is welcome now (the prior when nothing is known). */
export const welcomeChance = (table: WelcomeTable, context: string, now: number): number => {
  const c = table[context]
  const { yes, no } = c ? faded(c, now) : { yes: 0, no: 0 }
  return (PRIOR_YES + yes) / (PRIOR_YES + PRIOR_NO + yes + no)
}

/** One reaction: welcome or not, with a weight (a firm "don't remind me" counts double). */
export const recordWelcome = (table: WelcomeTable, context: string, welcome: boolean, now: number, weight = 1): WelcomeTable => {
  const c = table[context]
  const base = c ? faded(c, now) : { yes: 0, no: 0 }
  return { ...table, [context]: { yes: base.yes + (welcome ? weight : 0), no: base.no + (welcome ? 0 : weight), at: now } }
}

/** For the owner: what was learned, most decided first. */
export const describeWelcome = (table: WelcomeTable, now: number): { context: string; chance: number; reactions: number }[] =>
  Object.entries(table)
    .map(([context, c]) => {
      const f = faded(c, now)
      return { context, chance: welcomeChance(table, context, now), reactions: Math.round((f.yes + f.no) * 10) / 10 }
    })
    .filter(r => r.reactions >= 0.5)
    .sort((a, b) => Math.abs(b.chance - 0.5) - Math.abs(a.chance - 0.5))
