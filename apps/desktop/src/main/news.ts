/**
 * News from public RSS feeds: fetched in main (the window has no network
 * access), cached for 30 minutes, with each story's picture, a short summary
 * and a category. Pictures are proxied through assistant-news://, only for
 * addresses that came from the feeds, and cached on disk. Saved stories are
 * kept in news-saved.json. Feed text is untrusted: it is displayed, and the
 * assistant reads it only as labelled outside content.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { app, net, protocol } from 'electron'

import { NC, NEWS_SCHEME, type Category, type Headline, type NewsResult, type NewsSource, type SavedHeadline } from '../shared/news.ts'

export interface Feed {
  id: string
  source: string
  url: string
  category: Category
  /** On unless the owner turns it off. */
  enabled: boolean
}

/** Pakistani, world, business and tech outlets with public feeds; the owner picks which to show. */
export const FEEDS: Feed[] = [
  { id: 'dawn', source: 'Dawn', url: 'https://www.dawn.com/feeds/home', category: 'pakistan', enabled: true },
  { id: 'tribune', source: 'Express Tribune', url: 'https://tribune.com.pk/feed/home', category: 'pakistan', enabled: true },
  { id: 'geo', source: 'Geo News', url: 'https://www.geo.tv/rss/1/1', category: 'pakistan', enabled: false },
  { id: 'bbc-world', source: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'world', enabled: true },
  { id: 'dawn-business', source: 'Dawn Business', url: 'https://www.dawn.com/feeds/business', category: 'business', enabled: true },
  { id: 'verge', source: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'tech', enabled: true },
  { id: 'bbc-tech', source: 'BBC Technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'tech', enabled: false },
  { id: 'techcrunch', source: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'tech', enabled: false },
]

const TTL_MS = 30 * 60_000
const PER_FEED = 10
const MAX_TITLE = 180
const MAX_SUMMARY = 260
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_CACHED_IMAGES = 400
const MAX_SAVED = 500

const entities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')

const cdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')

/** Plain text from a feed field: CDATA unwrapped, entities decoded, tags removed. */
const text = (s: string) =>
  entities(cdata(s).replace(/<[^>]+>/g, ' '))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const tag = (block: string, name: string) => new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block)?.[1]

export const idOf = (link: string) => createHash('sha256').update(link).digest('hex').slice(0, 16)

/**
 * The story's picture: media:content (largest image), media:thumbnail, an
 * image enclosure, or the first <img> in the description or content. https only.
 */
export const findImage = (block: string): string | null => {
  const https = (u: string | undefined) => (u && /^https:\/\//.test(u) ? entities(u) : null)
  let best: { url: string; width: number } | null = null
  for (const m of block.matchAll(/<media:content\b([^>]*)>/gi)) {
    const attrs = m[1]!
    const url = /\burl="([^"]+)"/.exec(attrs)?.[1]
    const isImage = /medium="image"/.test(attrs) || /type="image\//.test(attrs) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url ?? '')
    const width = Number(/\bwidth="(\d+)"/.exec(attrs)?.[1] ?? 0)
    if (isImage && https(url) && (!best || width > best.width)) best = { url: https(url)!, width }
  }
  if (best) return best.url
  const thumb = https(/<media:thumbnail\b[^>]*\burl="([^"]+)"/i.exec(block)?.[1])
  if (thumb) return thumb
  const enclosure = /<enclosure\b([^>]*)>/i.exec(block)?.[1]
  if (enclosure && /type="image\//.test(enclosure)) {
    const u = https(/\burl="([^"]+)"/.exec(enclosure)?.[1])
    if (u) return u
  }
  const html = entities(cdata(block))
  return https(/<img\b[^>]*\bsrc="([^"]+)"/i.exec(html)?.[1])
}

/** Parses RSS <item> and Atom <entry> blocks; keeps only https links. `imageUrl` maps a picture to its proxied address. */
export const parseFeed = (xml: string, feed: Pick<Feed, 'source' | 'category'>, imageUrl: (remote: string) => string = u => u): Headline[] => {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) ?? []
  const out: Headline[] = []
  for (const block of blocks) {
    const title = text(tag(block, 'title') ?? '').slice(0, MAX_TITLE)
    const link = text(tag(block, 'link') ?? '') || (/<link[^>]*href="([^"]+)"/i.exec(block)?.[1] ?? '')
    if (!title || !link.startsWith('https://')) continue
    const date = tag(block, 'pubDate') ?? tag(block, 'updated') ?? tag(block, 'published')
    const t = date ? Date.parse(text(date)) : Number.NaN
    const raw = text(tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content') ?? '')
    const summary = raw && raw !== title ? (raw.length > MAX_SUMMARY ? `${raw.slice(0, MAX_SUMMARY).replace(/\s+\S*$/, '')}…` : raw) : ''
    const image = findImage(block)
    out.push({ id: idOf(link), title, link, source: feed.source, category: feed.category, publishedAt: Number.isNaN(t) ? null : t, summary, image: image ? imageUrl(image) : null })
    if (out.length >= PER_FEED) break
  }
  return out
}

/** Must run before app 'ready', next to the model scheme. */
export const newsSchemePrivileges = { scheme: NEWS_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }

const readJson = <T>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(value))
  renameSync(`${path}.tmp`, path)
}

export class NewsService {
  private cache: NewsResult = { headlines: [], fetchedAt: null, failed: [] }
  private inflight: Promise<NewsResult> | null = null
  /** Proxied image key → remote address; only these can be fetched. */
  private readonly images = new Map<string, string>()
  private readonly settingsFile = join(app.getPath('userData'), 'news.json')
  private readonly savedFile = join(app.getPath('userData'), 'news-saved.json')
  private readonly imageDir = join(app.getPath('userData'), 'news-images')

  constructor(private readonly deps: { onChange?: (r: NewsResult) => void } = {}) {
    // Saved stories keep their pictures across restarts.
    for (const s of this.saved()) this.remember(s)
  }

  private enabledIds(): Set<string> {
    const stored = readJson<{ enabled?: string[] }>(this.settingsFile, {}).enabled
    return new Set(Array.isArray(stored) ? stored : FEEDS.filter(f => f.enabled).map(f => f.id))
  }

  sources(): NewsSource[] {
    const on = this.enabledIds()
    return FEEDS.map(f => ({ id: f.id, name: f.source, category: f.category, enabled: on.has(f.id) }))
  }

  setSources(ids: unknown): NewsSource[] {
    if (!Array.isArray(ids)) throw new Error('Expected a list of sources.')
    const valid = ids.filter((id): id is string => typeof id === 'string' && FEEDS.some(f => f.id === id))
    writeJson(this.settingsFile, { enabled: valid })
    this.cache = { ...this.cache, fetchedAt: null }
    void this.list(true)
    return this.sources()
  }

  private imageUrl = (remote: string) => {
    const key = idOf(remote)
    this.images.set(key, remote)
    return `${NEWS_SCHEME}://img/${key}`
  }

  private remember(h: Headline & { remoteImage?: string }) {
    if (h.remoteImage && h.image) this.images.set(h.image.split('/').pop()!, h.remoteImage)
  }

  list(refresh = false): Promise<NewsResult> {
    const fresh = this.cache.fetchedAt !== null && Date.now() - this.cache.fetchedAt < TTL_MS
    if (fresh && !refresh) return Promise.resolve(this.cache)
    this.inflight ??= this.fetchAll().finally(() => (this.inflight = null))
    return this.inflight
  }

  private async fetchAll(): Promise<NewsResult> {
    const on = this.enabledIds()
    const feeds = FEEDS.filter(f => on.has(f.id))
    const results = await Promise.allSettled(
      feeds.map(async f => {
        const res = await net.fetch(f.url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'Mozilla/5.0 (Atlas personal assistant)' } })
        if (!res.ok) throw new Error(String(res.status))
        return parseFeed(await res.text(), f, this.imageUrl)
      }),
    )
    const seen = new Set<string>()
    const headlines = results
      .flatMap(r => (r.status === 'fulfilled' ? r.value : []))
      .filter(h => (seen.has(h.id) ? false : (seen.add(h.id), true)))
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    const failed = feeds.filter((_, i) => results[i]?.status === 'rejected').map(f => f.source)
    // Keep the old headlines when every feed fails (offline), so the canvas isn't blank.
    this.cache = headlines.length > 0 ? { headlines, fetchedAt: Date.now(), failed } : { ...this.cache, failed }
    this.deps.onChange?.(this.cache)
    return this.cache
  }

  saved(): SavedHeadline[] {
    return readJson<(SavedHeadline & { remoteImage?: string })[]>(this.savedFile, []).map(({ remoteImage: _r, ...s }) => s)
  }

  save(id: unknown): SavedHeadline[] {
    const h = this.cache.headlines.find(x => x.id === id)
    if (!h) throw new Error('That story is no longer in the list; refresh and try again.')
    const all = readJson<(SavedHeadline & { remoteImage?: string })[]>(this.savedFile, [])
    if (!all.some(s => s.id === h.id)) {
      const key = h.image?.split('/').pop()
      all.unshift({ ...h, savedAt: Date.now(), remoteImage: key ? this.images.get(key) : undefined })
      writeJson(this.savedFile, all.slice(0, MAX_SAVED))
    }
    return this.saved()
  }

  unsave(id: unknown): SavedHeadline[] {
    writeJson(
      this.savedFile,
      readJson<SavedHeadline[]>(this.savedFile, []).filter(s => s.id !== id),
    )
    return this.saved()
  }

  /** Serves pictures for addresses that came from the feeds; disk cache first. */
  registerProtocol() {
    protocol.handle(NEWS_SCHEME, async req => {
      const url = new URL(req.url)
      const key = url.pathname.replace(/^\/+/, '')
      if (url.hostname !== 'img' || !/^[0-9a-f]{16}$/.test(key)) return new Response('Not found', { status: 404 })
      const file = join(this.imageDir, key)
      if (existsSync(file) && existsSync(`${file}.type`)) {
        return new Response(readFileSync(file), { headers: { 'content-type': readFileSync(`${file}.type`, 'utf8'), 'cache-control': 'max-age=86400' } })
      }
      const remote = this.images.get(key)
      if (!remote) return new Response('Not found', { status: 404 })
      try {
        const res = await net.fetch(remote, { signal: AbortSignal.timeout(10_000) })
        const type = res.headers.get('content-type') ?? ''
        if (!res.ok || !type.startsWith('image/')) return new Response('Not an image', { status: 415 })
        const body = Buffer.from(await res.arrayBuffer())
        if (body.length > MAX_IMAGE_BYTES) return new Response('Too large', { status: 413 })
        mkdirSync(this.imageDir, { recursive: true })
        writeFileSync(file, body)
        writeFileSync(`${file}.type`, type)
        this.pruneImages()
        return new Response(body, { headers: { 'content-type': type, 'cache-control': 'max-age=86400' } })
      } catch {
        return new Response('Unavailable', { status: 502 })
      }
    })
  }

  private pruneImages() {
    try {
      const files = readdirSync(this.imageDir).filter(f => !f.endsWith('.type'))
      if (files.length <= MAX_CACHED_IMAGES) return
      const keep = new Set(this.saved().map(s => s.image?.split('/').pop()))
      files
        .filter(f => !keep.has(f))
        .map(f => ({ f, t: statSync(join(this.imageDir, f)).mtimeMs }))
        .sort((a, b) => a.t - b.t)
        .slice(0, files.length - MAX_CACHED_IMAGES)
        .forEach(({ f }) => {
          unlinkSync(join(this.imageDir, f))
          if (existsSync(join(this.imageDir, `${f}.type`))) unlinkSync(join(this.imageDir, `${f}.type`))
        })
    } catch {
      // Pruning is best effort.
    }
  }

  register(handle: <T>(channel: string, fn: (a: unknown) => T | Promise<T>) => void, requireOwner: () => void) {
    handle(NC.list, refresh => this.list(refresh === true))
    handle(NC.sources, () => this.sources())
    handle(NC.setSources, ids => this.setSources(ids))
    handle(NC.saved, () => {
      requireOwner()
      return this.saved()
    })
    handle(NC.save, id => {
      requireOwner()
      return this.save(id)
    })
    handle(NC.unsave, id => {
      requireOwner()
      return this.unsave(id)
    })
  }
}
