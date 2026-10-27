/**
 * Curiosity: the assistant's own questions beyond deadlines and status, so it
 * gets to know the owner and follows up like a person would. Three sources,
 * each grounded in real data:
 *
 * - Follow-ups: an event the owner mentioned ("client meeting kal 3 baje")
 *   whose time has passed: ask how it went.
 * - Opinions: a task stuck overdue for days: recommend what to do with it and
 *   ask, instead of only reminding.
 * - Getting to know: what it still does not know about the owner's work and
 *   life (role, clients, hours, goals, tools, interests): one friendly question
 *   a day at most, never the same one again for weeks.
 *
 * Pure over the memory store; the attention policy decides when it is said.
 */
import type { MemoryStore } from '@assistant/memory'
import { DAY, HOUR } from '@assistant/shared'

import type { AgendaEvent } from './agenda.ts'
import { startOfLocalDay } from './day.ts'

export type CuriosityItem = AgendaEvent & { priority: number }

/** Things worth knowing about the owner, with the words that show a memory already covers them. */
export const TOPICS: readonly { key: string; about: string; covered: RegExp }[] = [
  { key: 'work', about: 'what kind of work they do and their role', covered: /\b(work(s|ing)? (as|at|in|on)|job|role|profession|engineer|designer|developer|business|company|firm|office|student|owner of)\b/i },
  { key: 'clients', about: 'who their main clients or customers are right now', covered: /\b(client|customer)s?\b/i },
  { key: 'hours', about: 'when their working day usually starts and ends', covered: /\b(work(ing)? hours|start(s)? (work|the day)|office (timing|hours)|day starts|finish(es)? work|\d{1,2}\s?(am|pm) to)\b/i },
  { key: 'goal', about: 'one goal they are working towards this month', covered: /\b(goal|target|aim|deadline for|plan(s|ning)? to)\b/i },
  { key: 'tools', about: 'the software or tools they use most at work', covered: /\b(autocad|revit|excel|word|figma|photoshop|vs ?code|tool|software|app)\b/i },
  { key: 'team', about: 'who they work with (team, partner, boss)', covered: /\b(team|colleague|partner|boss|manager|employee|staff)\b/i },
  { key: 'interests', about: 'what they enjoy outside work', covered: /\b(hobby|hobbies|enjoy|likes? to|love(s)? to|cricket|football|gaming|reading|travel)\b/i },
]

/** How long before the same get-to-know question may come again (if still not answered). */
const REASK_MS = 45 * DAY
/** A follow-up stays worth asking about for this long after its time. */
const FOLLOWUP_WINDOW = 2 * DAY
/** A task overdue this long gets an opinion, not just a reminder. */
const STUCK_MS = DAY

const localMinute = (now: number, offsetMin: number) => Math.floor((((now + offsetMin * 60_000) % DAY) + DAY) % DAY / 60_000)
const fmtDay = (t: number, offsetMin: number) => new Date(t + offsetMin * 60_000).toISOString().slice(0, 10)

export const curiosityItems = (memory: MemoryStore, now: number, opts: { utcOffsetMin: number }): CuriosityItem[] => {
  const { utcOffsetMin } = opts
  const items: CuriosityItem[] = []

  // 1. Follow-ups whose time came.
  for (const f of memory.dueFollowups(now - FOLLOWUP_WINDOW, now)) {
    items.push({
      type: 'agenda',
      at: now,
      key: `followup:${f.id}`,
      kind: 'question',
      title: `How did it go: ${f.about}?`,
      instruction: `Earlier the owner told you: “${f.quote}” (${f.about}). That should be over by now. Ask, warmly and in one sentence, how it went. If the answer has something worth remembering, save it with memory_save; if it creates work, offer to add a task.`,
      evidence: `You mentioned: “${f.quote}”`,
      expectsAnswer: true,
      priority: 55,
    })
  }

  // 2. Tasks stuck overdue: an honest recommendation, then a question.
  const open = memory.openTasks()
  for (const [i, t] of open.entries()) {
    if (t.dueAt === null || now - t.dueAt < STUCK_MS) continue
    const days = Math.floor((now - t.dueAt) / DAY)
    const others = open.length - 1
    items.push({
      type: 'agenda',
      at: now,
      // Once a week at most per task.
      key: `stuck:${t.id}:${Math.floor(now / (7 * DAY))}`,
      kind: 'question',
      title: `Stuck: ${t.title}`,
      instruction: [
        `The task "${t.title}" (number ${i + 1} in tasks_list) was due ${fmtDay(t.dueAt, utcOffsetMin)} and has been overdue for ${days} day(s); the owner has ${others} other open task(s).`,
        'Give your honest opinion in one or two sentences: do it first today, move it to a specific day, take one small first step, or drop it. Tie it to this evidence, no lecturing.',
        'Then ask what they want. If they pick a new time, call task_update with the new due; if they drop it, task_update with cancel true.',
      ].join(' '),
      evidence: `“${t.title}” has been overdue for ${days} day(s).`,
      expectsAnswer: true,
      priority: 60,
    })
  }

  // 3. Getting to know the owner: one question a day, in daytime, on a day they are around.
  const dayStart = startOfLocalDay(now, utcOffsetMin)
  const minute = localMinute(now, utcOffsetMin)
  const talkedToday = memory.messagesSince(dayStart).some(m => m.speaker === 'owner')
  const askedToday = [...memory.initiativeHandled(now - dayStart).keys()].some(k => k.startsWith('agenda:know:'))
  if (talkedToday && !askedToday && minute >= 10 * 60 && minute < 20 * 60) {
    const known = memory.memories(['fact', 'preference'], 300).map(m => m.statement)
    const topic = TOPICS.find(t => {
      if (known.some(s => t.covered.test(s))) return false
      const last = memory.initiativeEntry(`agenda:know:${t.key}`)
      return !last || now - last.at > REASK_MS
    })
    if (topic) {
      items.push({
        type: 'agenda',
        at: now,
        key: `know:${topic.key}`,
        kind: 'question',
        title: 'Getting to know you',
        instruction: `You want to be more useful to the owner and realise you do not know ${topic.about}. Ask one short, friendly, curious question about it, in your own words, saying briefly why it helps you. Not an interview: one question only. If they answer, save the useful part with memory_save. If they would rather not say, accept that lightly.`,
        evidence: `I don't know ${topic.about} yet.`,
        expectsAnswer: true,
        priority: 20,
      })
    }
  }

  return items
}

/** For tests and the demo: when the next get-to-know window opens. */
export const KNOW_WINDOW = { from: 10 * HOUR, to: 20 * HOUR }
