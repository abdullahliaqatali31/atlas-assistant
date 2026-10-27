/**
 * The rolling summary of a conversation's older part: once messages fall
 * out of the verbatim window, a cheap model folds them into a short running
 * summary (plus a better title), which the context packet carries instead of
 * the messages themselves. Runs in the background after a reply; until it is
 * done, a plain digest stands in.
 */
import type { LlmProvider } from '@assistant/providers'

import type { DayMessage } from './day.ts'

export interface SummaryInput {
  previous: string
  title: string
  messages: readonly DayMessage[]
}

export type Summarizer = (input: SummaryInput, signal?: AbortSignal) => Promise<{ summary: string; title?: string | undefined }>

const SYSTEM =
  'You keep a running summary of a conversation between the owner and their personal assistant (you), for your own later use. ' +
  'Update the summary with the new messages: who wants what, decisions, facts the owner gave, promises you made, and open questions. ' +
  'Keep names, numbers and dates exactly. At most 120 words, in English, plain sentences. ' +
  'Also give a title for the conversation of at most 6 words. ' +
  'Answer with JSON only: {"title": "...", "summary": "..."}'

/** Pulls {title, summary} out of the model's answer, tolerating text around the JSON. */
export const parseSummary = (text: string): { summary: string; title?: string } | null => {
  const m = /\{[\s\S]*\}/.exec(text)
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { summary?: unknown; title?: unknown }
      if (typeof o.summary === 'string' && o.summary.trim()) {
        return { summary: o.summary.trim().slice(0, 1200), ...(typeof o.title === 'string' && o.title.trim() ? { title: o.title.trim().slice(0, 60) } : {}) }
      }
    } catch {
      // Fall through to the plain text.
    }
  }
  const plain = text.trim()
  return plain ? { summary: plain.slice(0, 1200) } : null
}

export const llmSummarizer =
  (llm: LlmProvider): Summarizer =>
  async ({ previous, title, messages }, signal) => {
    const lines = messages.map(m => `${m.speaker === 'owner' ? 'Owner' : 'Assistant'}: ${m.content.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')
    const prompt = [`Current title: ${title || '(none)'}`, `Summary so far: ${previous || '(none yet)'}`, 'New messages:', lines].join('\n\n')
    let text = ''
    for await (const e of llm.stream({ system: SYSTEM, turns: [{ role: 'user', content: prompt }], maxTokens: 600, effort: 'low' }, signal)) if (e.type === 'text') text += e.text
    const out = parseSummary(text)
    if (!out) throw new Error('The summary came back empty.')
    return out
  }
