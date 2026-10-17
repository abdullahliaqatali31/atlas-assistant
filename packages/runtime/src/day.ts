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
