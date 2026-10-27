/**
 * Quick replies: after Atlas answers, the cheap background model offers two
 * to four short things the owner might say next ("Haan, bhej do", "Aur
 * detail do"), in the owner's own language. The widget and the chat show
 * them as buttons; pressing one sends it as the owner's message. Nothing is
 * done until the owner presses one.
 */
import type { LlmProvider } from '@assistant/providers'

const SYSTEM =
  'You suggest what the owner of a personal assistant might say next, as tappable quick replies. ' +
  'You get the owner’s last message and the assistant’s reply. Give 2 to 4 short replies (at most 7 words each) the owner would plausibly send: ' +
  'answers to a question the assistant asked (yes / no / a choice it offered), or natural next steps. Write them in the owner’s own language and style ' +
  '(Roman Urdu, English or a mix, as they wrote). Each is something the owner says to the assistant, never the assistant speaking. ' +
  'If the reply is a plain statement that needs nothing next, give fewer or none. ' +
  'Also judge whether this topic is finished: "done": true when the owner closed it (thanks, ok, bas, that is all, chup, bye) or the reply fully settled it and neither asks nor invites anything; ' +
  'then give no options. "done": false when the assistant asked something, offered a choice, or the owner is clearly mid-task. Answer with JSON only: {"done": false, "options": ["...", "..."]}'

/** Whether the model judged the topic finished (no more listening, no options). */
export const parseDone = (text: string): boolean => {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return false
  try {
    return (JSON.parse(m[0]) as { done?: unknown }).done === true
  } catch {
    return false
  }
}

/** The model's answer → up to four clean, short, distinct options. */
export const parseOptions = (text: string): string[] => {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return []
  try {
    const o = JSON.parse(m[0]) as { options?: unknown }
    if (!Array.isArray(o.options)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const x of o.options) {
      if (typeof x !== 'string') continue
      // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
      const t = x.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
      if (!t || seen.has(t.toLowerCase())) continue
      seen.add(t.toLowerCase())
      out.push(t)
    }
    return out.slice(0, 4)
  } catch {
    return []
  }
}

/** The options for one exchange (none when too short to bother, or the model failed), and whether the topic is done. */
export const suggestReplies = async (llm: LlmProvider, owner: string, reply: string, signal?: AbortSignal): Promise<{ options: string[]; done: boolean }> => {
  if (reply.trim().length < 12) return { options: [], done: false }
  const prompt = `Owner: ${owner.slice(-600) || '(the assistant spoke up on its own)'}\n\nAssistant: ${reply.slice(-1500)}`
  let text = ''
  for await (const e of llm.stream({ system: SYSTEM, turns: [{ role: 'user', content: prompt }], maxTokens: 200, effort: 'low' }, signal)) if (e.type === 'text') text += e.text
  const done = parseDone(text)
  return { options: done ? [] : parseOptions(text), done }
}
