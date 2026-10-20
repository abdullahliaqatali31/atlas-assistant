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
  'If the reply is a plain statement that needs nothing next, give fewer or none. Answer with JSON only: {"options": ["...", "..."]}'

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

/** The options for one exchange, or none (too short to bother, or the model failed). */
export const suggestReplies = async (llm: LlmProvider, owner: string, reply: string, signal?: AbortSignal): Promise<string[]> => {
  if (reply.trim().length < 12) return []
  const prompt = `Owner: ${owner.slice(-600) || '(the assistant spoke up on its own)'}\n\nAssistant: ${reply.slice(-1500)}`
  let text = ''
  for await (const e of llm.stream({ system: SYSTEM, turns: [{ role: 'user', content: prompt }], maxTokens: 200, effort: 'low' }, signal)) if (e.type === 'text') text += e.text
  return parseOptions(text)
}
