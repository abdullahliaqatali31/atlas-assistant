/**
 * Memory manager (plan section 7). Runs when the owner is idle, within a cost
 * budget:
 *
 * 1. Extract: one short model call reads the conversation since the last run
 *    and lists durable facts, preferences, corrections and inferences. Each
 *    must quote the owner's own words; anything without a real quote is
 *    dropped, so the model cannot invent memories.
 * 2. Decide: stated facts and preferences are saved (visible in Learning,
 *    one click to forget); corrections become lesson proposals; inferences
 *    about the owner become memory proposals. Both need the owner's yes.
 * 3. Consolidate: an update replaces the old fact (kept as history, not
 *    shown); near-duplicates merge.
 * Also notes follow-ups: plans and events the owner mentioned with a time
 * ("client meeting kal 3 baje"), so the assistant can ask how they went.
 *
 * 4. Retention: raw conversation older than 30 days is deleted; what was
 *    learned from it stays.
 */
import type { MemoryKind, MemoryStore } from '@assistant/memory'
import type { LlmProvider } from '@assistant/providers'
import { DAY, MINUTE, type Clock } from '@assistant/shared'

export interface ExtractedItem {
  kind: 'fact' | 'preference' | 'correction' | 'inference' | 'followup'
  statement: string
  quote: string
  confidence: number
  /** Short id of an existing memory this one updates, if any. */
  updates?: string | null
  /** Follow-ups: ISO 8601 time when it is worth asking how it went. */
  when?: string | null
}

export interface ManagerReport {
  ran: boolean
  reason?: string
  saved: string[]
  updated: string[]
  proposed: string[]
  /** Follow-ups noted, e.g. "client meeting with Ahmed (2026-10-19 16:00)". */
  followups: string[]
  merged: number
  droppedUnquoted: number
  deletedMessages: number
}

const LAST_RUN = 'learning.lastExtractAt'
const MIN_GAP = 20 * MINUTE
const MESSAGE_RETENTION = 30 * DAY
const LEARNING_RETENTION = 60 * DAY
const MAX_MESSAGES = 40
const SAVE_CONFIDENCE = 0.7
/** Follow-ups further out than this are plans, not things to check on soon. */
const FOLLOWUP_HORIZON = 30 * DAY
/** A follow-up whose time already passed when it was noted is still worth asking about for this long. */
const FOLLOWUP_GRACE = 2 * DAY

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(w => w.length > 2),
  )

/** Word overlap between two statements, 0..1. */
export const similarity = (a: string, b: string) => {
  const A = words(a)
  const B = words(b)
  if (A.size === 0 || B.size === 0) return 0
  let both = 0
  for (const w of A) if (B.has(w)) both++
  return both / (A.size + B.size - both)
}

const squash = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** True when `quote` really appears in what the owner said (ignoring case and punctuation). */
export const quoted = (quote: string, ownerTexts: readonly string[]) => {
  const q = squash(quote)
  return q.length >= 4 && ownerTexts.some(t => squash(t).includes(q))
}

/** Pulls the first JSON array out of a model reply (bare or in a code fence). */
export const parseItems = (reply: string): ExtractedItem[] => {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const raw = JSON.parse(reply.slice(start, end + 1)) as unknown
    if (!Array.isArray(raw)) return []
    return raw.flatMap((r): ExtractedItem[] => {
      if (typeof r !== 'object' || r === null) return []
      const o = r as Record<string, unknown>
      const kind = o.kind
      if (kind !== 'fact' && kind !== 'preference' && kind !== 'correction' && kind !== 'inference' && kind !== 'followup') return []
      if (typeof o.statement !== 'string' || typeof o.quote !== 'string') return []
      const statement = o.statement.trim().slice(0, 300)
      if (!statement) return []
      return [{ kind, statement, quote: o.quote.slice(0, 300), confidence: typeof o.confidence === 'number' ? o.confidence : 0.5, updates: typeof o.updates === 'string' ? o.updates : null, when: typeof o.when === 'string' ? o.when : null }]
    })
  } catch {
    return []
  }
}

const SYSTEM = `You maintain the long-term memory of a personal assistant. Read the conversation and list only durable things worth remembering for weeks: facts about the owner's work, people, clients, projects, deadlines and tools; the owner's stated preferences; corrections the owner made to the assistant; and inferences about the owner that they did not state.

Rules:
- Every item must include "quote": the owner's exact words it comes from, copied verbatim from an OWNER line. No quote, no item.
- Never take anything from ASSISTANT lines as fact.
- Skip small talk, greetings, one-off requests and anything already in KNOWN unless it changes it.
- If an item updates a KNOWN entry (new deadline, changed preference), set "updates" to that entry's id.
- "correction": the owner told the assistant it was wrong or how to do something; write it as a rule for next time ("When sending quotes, attach a PDF, not Word").
- "inference": something you conclude about the owner that they did not say outright. Use it sparingly.
- "followup": a specific upcoming event or plan the owner mentioned with a time (meeting, call, site visit, delivery, interview, trip, exam), which a friend would later ask about. "statement" names it in a few words ("client meeting with Ahmed"); "when" is the ISO 8601 time with offset when it should be over and worth asking about (e.g. the evening of that day if no end time). Resolve "kal", "tomorrow", "Friday" against the time shown on that OWNER line. Skip routine things and tasks the owner only wants done.
- Write statements in clear English, one fact each, with names and dates kept exactly.
- confidence: 0 to 1, how sure you are the owner meant it as lasting.

Reply with only a JSON array: [{"kind":"fact|preference|correction|inference|followup","statement":"…","quote":"…","confidence":0.9,"updates":null,"when":null}]. Reply [] if nothing qualifies.`

export class MemoryManager {
  constructor(
    private readonly deps: { memory: MemoryStore; llm: LlmProvider; clock: Clock; /** Owner's UTC offset, so "kal" resolves to their day. */ utcOffsetMin?: number },
  ) {}

  /** Runs one pass if enough new conversation has built up (or `force`). */
  async run({ force = false, signal }: { force?: boolean; signal?: AbortSignal } = {}): Promise<ManagerReport> {
    const { memory, clock } = this.deps
    const now = clock.now()
    const report: ManagerReport = { ran: false, saved: [], updated: [], proposed: [], followups: [], merged: 0, droppedUnquoted: 0, deletedMessages: 0 }
    report.deletedMessages = memory.deleteMessagesBefore(now - MESSAGE_RETENTION)
    memory.pruneLearning(now - LEARNING_RETENTION)

    const last = Number(memory.getSetting(LAST_RUN) ?? 0)
    if (!force && now - last < MIN_GAP) return { ...report, reason: 'ran recently' }
    const messages = memory.messagesSince(last + 1).slice(-MAX_MESSAGES)
    const owner = messages.filter(m => m.speaker === 'owner' && !m.content.startsWith('[system event]'))
    if (owner.length === 0 || (!force && owner.length < 3)) return { ...report, reason: 'not enough new conversation' }

    const known = memory.memories(['fact', 'preference', 'lesson'], 40)
    const shortId = (id: string) => id.slice(0, 8)
    const prompt = [
      `NOW: ${this.localTime(now)}`,
      '',
      'KNOWN (id: statement):',
      known.length ? known.map(k => `${shortId(k.id)}: ${k.statement}`).join('\n') : '(nothing yet)',
      '',
      'CONVERSATION:',
      ...messages.map(m => `[${this.localTime(m.at)}] ${m.speaker === 'owner' ? 'OWNER' : 'ASSISTANT'}: ${m.content.replace(/\s+/g, ' ').slice(0, 600)}`),
    ].join('\n')

    let reply = ''
    for await (const ev of this.deps.llm.stream({ system: SYSTEM, turns: [{ role: 'user', content: prompt }], maxTokens: 1500, effort: 'low' }, signal)) {
      if (ev.type === 'text') reply += ev.text
    }
    memory.setSetting(LAST_RUN, String(messages.at(-1)?.at ?? now))
    report.ran = true

    const ownerTexts = owner.map(m => m.content)
    for (const item of parseItems(reply)) {
      if (!quoted(item.quote, ownerTexts)) {
        report.droppedUnquoted++
        continue
      }
      const evidence = `You said: “${item.quote.trim()}”`
      if (item.kind === 'followup') {
        const due = item.when ? Date.parse(item.when) : NaN
        if (Number.isNaN(due) || due > now + FOLLOWUP_HORIZON || due < now - FOLLOWUP_GRACE) continue
        const id = memory.addFollowup({ about: item.statement, quote: item.quote.trim(), dueAt: due, dedupKey: `followup:${squash(item.statement)}:${Math.floor(due / DAY)}` })
        if (id) report.followups.push(`${item.statement} (${this.localTime(due).slice(0, 16).replace('T', ' ')})`)
        continue
      }
      if (item.kind === 'correction') {
        const id = memory.addProposal({ kind: 'lesson', title: item.statement, detail: { statement: item.statement }, evidence, dedupKey: `lesson:${squash(item.statement)}` })
        if (id) report.proposed.push(item.statement)
        continue
      }
      if (item.kind === 'inference') {
        const id = memory.addProposal({
          kind: 'memory',
          title: item.statement,
          detail: { statement: item.statement, kind: 'hypothesis' satisfies MemoryKind },
          evidence,
          dedupKey: `memory:${squash(item.statement)}`,
        })
        if (id) report.proposed.push(item.statement)
        continue
      }
      if (item.confidence < SAVE_CONFIDENCE) continue
      const target = item.updates ? known.find(k => shortId(k.id) === item.updates) : undefined
      // Already known in other words: nothing to add.
      if (!target && known.some(k => similarity(k.statement, item.statement) >= 0.75)) continue
      const id = memory.remember({ kind: item.kind, statement: item.statement, source: { kind: 'owner', origin: 'learned', locator: item.quote.slice(0, 200), retrievedAt: now }, confidence: item.confidence })
      if (target) {
        memory.supersede(target.id, id)
        report.updated.push(`${target.statement} → ${item.statement}`)
      } else report.saved.push(item.statement)
    }

    report.merged = this.consolidate()
    return report
  }

  /** "2026-10-17T15:05+05:00 Sat": the owner's local time, so relative dates resolve to their day. */
  private localTime(t: number) {
    const offset = this.deps.utcOffsetMin ?? 0
    const d = new Date(t + offset * 60_000)
    const abs = Math.abs(offset)
    const off = `${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
    return `${d.toISOString().slice(0, 16)}${off} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]}`
  }

  /** Merges near-duplicate memories, keeping the newest wording. Returns how many merged. */
  consolidate(): number {
    const all = this.deps.memory.memories(['fact', 'preference', 'lesson'], 500)
    let merged = 0
    const gone = new Set<string>()
    for (let i = 0; i < all.length; i++) {
      const newer = all[i]!
      if (gone.has(newer.id)) continue
      for (let j = i + 1; j < all.length; j++) {
        const older = all[j]!
        if (gone.has(older.id) || older.kind !== newer.kind) continue
        if (similarity(newer.statement, older.statement) >= 0.85) {
          this.deps.memory.supersede(older.id, newer.id)
          gone.add(older.id)
          merged++
        }
      }
    }
    return merged
  }
}
