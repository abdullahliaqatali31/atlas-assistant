/**
 * Today's find: one true, interesting thing for the owner each day, picked
 * from Wikipedia's featured feed for today (the featured article, the most
 * read, on this day, in the news) by what the owner likes, and told in their
 * own style. Grounded: the model only chooses and retells, the fact comes
 * from the feed and links back to it. Kept for the day in a small file.
 */
import { readFileSync, writeFileSync } from 'node:fs'

import type { MemoryStore } from '@assistant/memory'
import type { LlmProvider } from '@assistant/providers'

import type { DailyFind } from '../shared/brain.ts'

interface Candidate {
  title: string
  text: string
  url: string | null
  image: string | null
  source: string
}

const UA = 'Atlas-desktop-assistant/1.0 (personal assistant app)'

const SYSTEM =
  'You pick one thing from a list that the owner of a personal assistant (you) would find most interesting today, based on what you know about them, and retell it. ' +
  'Use only what the chosen item says: do not add facts. Write the fact in one or two short, vivid sentences in the owner’s own style and language (if they prefer Roman Urdu or Hinglish, write in that). ' +
  'Then one short line on why it is for them. Answer with JSON only: {"pick": <item number>, "title": "<3-6 words>", "fact": "...", "why": "..."}'

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

type Page = { titles?: { normalized?: string }; title?: string; extract?: string; description?: string; content_urls?: { desktop?: { page?: string } }; thumbnail?: { source?: string } }

/** Today's feed as a numbered list of candidates. */
export const candidatesFrom = (feed: unknown): Candidate[] => {
  const f = (feed ?? {}) as { tfa?: Page; mostread?: { articles?: Page[] }; onthisday?: { text?: string; year?: number; pages?: Page[] }[]; news?: { story?: string; links?: Page[] }[] }
  const page = (p: Page | undefined, source: string, lead = ''): Candidate | null => {
    if (!p) return null
    const title = p.titles?.normalized ?? p.title ?? ''
    const text = `${lead}${p.extract ?? p.description ?? ''}`.trim()
    if (!title || !text) return null
    // Thumbnails are served from upload.wikimedia.org too (the host Atlas's image loader allows).
    const image = p.thumbnail?.source?.replace(/^https:\/\/thumb\.wikimedia\.org\//, 'https://upload.wikimedia.org/').replace(/\?.*$/, '') ?? null
    return { title, text: text.slice(0, 600), url: p.content_urls?.desktop?.page ?? null, image, source }
  }
  const out: (Candidate | null)[] = [page(f.tfa, 'Wikipedia · featured article')]
  for (const n of (f.news ?? []).slice(0, 5)) out.push(page(n.links?.[0], 'Wikipedia · in the news', n.story ? `${stripHtml(n.story)} — ` : ''))
  for (const a of (f.mostread?.articles ?? []).slice(0, 14)) out.push(page(a, 'Wikipedia · most read today'))
  for (const e of (f.onthisday ?? []).slice(0, 10)) out.push(page(e.pages?.[0], 'Wikipedia · on this day', e.text ? `On this day in ${e.year}: ${e.text} — ` : ''))
  const seen = new Set<string>()
  return out.filter((c): c is Candidate => !!c && !seen.has(c.title) && !!seen.add(c.title))
}

export const parsePick = (text: string): { pick: number; title: string; fact: string; why: string } | null => {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>
    if (typeof o.pick !== 'number' || typeof o.fact !== 'string' || !o.fact.trim()) return null
    return { pick: o.pick, title: typeof o.title === 'string' ? o.title.slice(0, 60) : '', fact: o.fact.trim().slice(0, 400), why: typeof o.why === 'string' ? o.why.trim().slice(0, 160) : '' }
  } catch {
    return null
  }
}

export class DailyFinder {
  private busy: Promise<DailyFind | null> | null = null

  constructor(
    private readonly deps: {
      llm: LlmProvider
      memory: MemoryStore
      file: string
      utcOffsetMin: number
      now: () => number
      log: (level: 'info' | 'warn', message: string) => void
      fetch?: typeof fetch
      /** Topic words from what the owner watched and searched this week. */
      interests?: () => string[]
    },
  ) {}

  private today() {
    return new Date(this.deps.now() + this.deps.utcOffsetMin * 60_000).toISOString().slice(0, 10)
  }

  private cached(): DailyFind | null {
    try {
      const f = JSON.parse(readFileSync(this.deps.file, 'utf8')) as DailyFind
      return f.date === this.today() ? f : null
    } catch {
      return null
    }
  }

  get(refresh = false): Promise<DailyFind | null> {
    if (!refresh) {
      const c = this.cached()
      if (c) return Promise.resolve(c)
    }
    this.busy ??= this.make().finally(() => (this.busy = null))
    return this.busy
  }

  private async make(): Promise<DailyFind | null> {
    const date = this.today()
    const [y, m, d] = date.split('-')
    const res = await (this.deps.fetch ?? fetch)(`https://en.wikipedia.org/api/rest_v1/feed/featured/${y}/${m}/${d}`, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`Wikipedia's feed answered ${res.status}.`)
    const list = candidatesFrom(await res.json())
    if (!list.length) return null
    const about = this.deps.memory
      .memories(['preference', 'fact'], 60)
      .map(x => `- ${x.statement}`)
      .join('\n')
    // Plain topic words only (letters and digits), so a video title cannot carry instructions in.
    const lately = (this.deps.interests?.() ?? []).map(w => w.replace(/[^\p{L}\p{N} +#-]/gu, '').slice(0, 30)).filter(Boolean).slice(0, 10)
    const prompt = [`What you know about the owner:\n${about || '(little yet: pick what most people would find fascinating)'}${lately.length ? `\nWhat they watched and searched this week is about: ${lately.join(', ')}` : ''}`, 'Today’s items:', list.map((c, i) => `${i + 1}. ${c.title}: ${c.text}`).join('\n')].join('\n\n')
    let text = ''
    for await (const e of this.deps.llm.stream({ system: SYSTEM, turns: [{ role: 'user', content: prompt }], maxTokens: 500, effort: 'low' })) if (e.type === 'text') text += e.text
    const pick = parsePick(text)
    const c = pick ? list[pick.pick - 1] : undefined
    if (!pick || !c) throw new Error('The pick came back empty.')
    const find: DailyFind = { date, title: pick.title || c.title, fact: pick.fact, why: pick.why, url: c.url, image: c.image, source: c.source }
    try {
      writeFileSync(this.deps.file, JSON.stringify(find))
    } catch (e) {
      this.deps.log('warn', `Could not keep today's find: ${e instanceof Error ? e.message : String(e)}`)
    }
    return find
  }
}
