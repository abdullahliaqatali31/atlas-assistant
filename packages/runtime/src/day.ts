/**
 * Today's conversation as context. The newest part goes to the model word
 * for word (as alternating history turns); anything older from today is a
 * short digest in the context packet. No extra model call is needed.
 */
import type { ChatTurn } from '@assistant/providers'

export interface DayMessage {
  speaker: 'owner' | 'assistant'
  content: string
  at: number
}

/** Start of the owner's local day, as epoch ms. */
export const startOfLocalDay = (now: number, utcOffsetMin: number) => {
  const local = now + utcOffsetMin * 60_000
  return local - (local % 86_400_000) - utcOffsetMin * 60_000
}

/** Messages as alternating user/assistant turns, starting with a user turn (the API requires it). */
export const toTurns = (messages: readonly DayMessage[]): ChatTurn[] => {
  const turns: ChatTurn[] = []
  for (const m of messages) {
    const role = m.speaker === 'owner' ? 'user' : 'assistant'
    const last = turns.at(-1)
    if (last && last.role === role && typeof last.content === 'string') last.content += `\n\n${m.content}`
    else turns.push({ role, content: m.content })
  }
  // Briefings start with the assistant: mark the gap instead of inventing what the owner said.
  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: '[earlier today: the assistant spoke first]' })
  return turns
}

/**
 * Splits today's messages into a recent window (kept verbatim, at most
 * `maxTurns` turns) and a digest of the earlier part.
 */
export const dayContext = (messages: readonly DayMessage[], maxTurns: number): { history: ChatTurn[]; digest: string } => {
  const all = toTurns(messages)
  if (all.length <= maxTurns) return { history: all, digest: '' }
  // Keep a window that starts with a user turn.
  let cut = all.length - maxTurns
  if (all[cut]?.role === 'assistant') cut++
  const older = all.slice(0, cut)
  const digest = older
    .map(t => {
      const text = typeof t.content === 'string' ? t.content.replace(/\s+/g, ' ').trim() : ''
      return text ? `- ${t.role === 'user' ? 'Owner' : 'You'}: ${text.length > 160 ? `${text.slice(0, 157)}…` : text}` : ''
    })
    .filter(Boolean)
    .slice(-30)
    .join('\n')
  return { history: all.slice(cut), digest }
}

export interface SessionContext {
  /** The recent part, verbatim, as alternating turns. */
  history: ChatTurn[]
  /** A short line-per-message digest of older messages the summary does not cover yet. */
  digest: string
  /** Older messages the summary does not cover yet (for the next summary). */
  unsummarized: DayMessage[]
}

/**
 * Splits one conversation for the model. All of it goes verbatim while it
 * is short; once it passes `max` turns it is cut back to the last `keep`,
 * so the verbatim part (which the provider caches) changes only every few
 * turns instead of sliding every message. Older messages are covered by the
 * stored summary up to `summarizedThrough`, and by a digest after that.
 */
export const sessionContext = (messages: readonly DayMessage[], opts: { max: number; keep: number; summarizedThrough: number }): SessionContext => {
  const all = toTurns(messages)
  if (all.length <= opts.max) return { history: all, digest: '', unsummarized: [] }
  // The message index each turn starts at (consecutive messages from one speaker merge into one turn).
  const starts: number[] = []
  for (let i = 0; i < messages.length; i++) if (i === 0 || messages[i]!.speaker !== messages[i - 1]!.speaker) starts.push(i)
  // toTurns may put a marker turn first when the assistant spoke first; line the indices up with it.
  const offset = all.length - starts.length
  let cut = all.length - opts.keep
  if (all[cut]?.role === 'assistant') cut++
  const older = messages.slice(0, starts[cut - offset] ?? messages.length)
  const unsummarized = older.filter(m => m.at > opts.summarizedThrough)
  const digest = unsummarized
    .map(m => {
      const text = m.content.replace(/\s+/g, ' ').trim()
      return text ? `- ${m.speaker === 'owner' ? 'Owner' : 'You'}: ${text.length > 160 ? `${text.slice(0, 157)}…` : text}` : ''
    })
    .filter(Boolean)
    .slice(-20)
    .join('\n')
  return { history: all.slice(cut), digest, unsummarized }
}
