/**
 * Public RSS headlines for the Jarvis panel. Fetched in main (the renderer has
 * no network access), cached for 30 minutes, titles only. Feed text is
 * untrusted: it is displayed, never handed to the assistant as instructions.
 */
import { net } from 'electron'

import type { Headline, NewsResult } from '../shared/news.ts'

export interface Feed {
  source: string
  url: string
}

/** Defaults: one Pakistani and two international outlets. Owners can replace them later in settings. */
export const DEFAULT_FEEDS: Feed[] = [
  { source: 'Dawn', url: 'https://www.dawn.com/feeds/home' },
  { source: 'BBC', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { source: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
]

const TTL_MS = 30 * 60_000
const PER_FEED = 6
const MAX_TITLE = 180

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const tag = (block: string, name: string) => new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block)?.[1]

/** Parses RSS <item> and Atom <entry> blocks; keeps only https links. */
export const parseFeed = (xml: string, source: string): Headline[] => {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) ?? []
  const out: Headline[] = []
  for (const block of blocks) {
    const title = decode(tag(block, 'title') ?? '').slice(0, MAX_TITLE)
    const link = decode(tag(block, 'link') ?? '') || (/<link[^>]*href="([^"]+)"/i.exec(block)?.[1] ?? '')
    if (!title || !link.startsWith('https://')) continue
    const date = tag(block, 'pubDate') ?? tag(block, 'updated') ?? tag(block, 'published')
    const t = date ? Date.parse(decode(date)) : Number.NaN
    out.push({ title, link, source, publishedAt: Number.isNaN(t) ? null : t })
    if (out.length >= PER_FEED) break
  }
  return out
}

export class NewsService {
  private cache: NewsResult = { headlines: [], fetchedAt: null, failed: [] }
  private inflight: Promise<NewsResult> | null = null

  constructor(private readonly feeds: Feed[] = DEFAULT_FEEDS) {}

  list(refresh = false): Promise<NewsResult> {
    const fresh = this.cache.fetchedAt !== null && Date.now() - this.cache.fetchedAt < TTL_MS
    if (fresh && !refresh) return Promise.resolve(this.cache)
    this.inflight ??= this.fetchAll().finally(() => (this.inflight = null))
    return this.inflight
  }

  private async fetchAll(): Promise<NewsResult> {
    const results = await Promise.allSettled(
      this.feeds.map(async f => {
        const res = await net.fetch(f.url, { signal: AbortSignal.timeout(8000) })
        if (!res.ok) throw new Error(String(res.status))
        return parseFeed(await res.text(), f.source)
      }),
    )
    const headlines = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []))
    const failed = this.feeds.filter((_, i) => results[i]?.status === 'rejected').map(f => f.source)
    headlines.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    // Keep the old headlines when every feed fails (offline), so the panel isn't blank.
    this.cache = headlines.length > 0 ? { headlines, fetchedAt: Date.now(), failed } : { ...this.cache, failed }
    return this.cache
  }
}
