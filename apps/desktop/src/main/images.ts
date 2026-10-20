/**
 * Pictures for the World cards (Wikimedia Commons, airport-data.com), fetched
 * by main rather than the page: Wikimedia turns away anonymous bursts from a
 * page, so here they go two at a time with a proper user agent, retry once
 * after a "slow down", and are kept in memory and on disk. The page gets a
 * data URL. Only these hosts, only images, at most 4 MB.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const HOSTS = new Set(['commons.wikimedia.org', 'upload.wikimedia.org', 'image.airport-data.com', 'airport-data.com', 'www.airport-data.com', 'thespacedevs-prod.nyc3.digitaloceanspaces.com'])
const MAX_BYTES = 4 * 1024 * 1024
const PARALLEL = 2
const UA = 'Atlas personal assistant (open source desktop app) Electron'

export const isAllowedImage = (url: unknown): url is string => {
  if (typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && HOSTS.has(u.hostname)
  } catch {
    return false
  }
}

export class ImageCache {
  private memory = new Map<string, string>()
  private pending = new Map<string, Promise<string | null>>()
  private running = 0
  private queue: (() => void)[] = []

  constructor(private readonly dir: string) {}

  private slot() {
    if (this.running < PARALLEL) {
      this.running++
      return Promise.resolve()
    }
    return new Promise<void>(r => this.queue.push(() => (this.running++, r())))
  }

  private release() {
    this.running--
    this.queue.shift()?.()
  }

  /**
   * Where to fetch a picture from. commons.wikimedia.org may not be reachable
   * where upload.wikimedia.org is, so a Special:FilePath link becomes the
   * direct thumbnail (path from the name's MD5; Wikimedia serves only standard
   * widths); the public wsrv.nl image proxy is the last resort.
   */
  private sources(url: string): string[] {
    const u = new URL(url)
    const m = u.hostname === 'commons.wikimedia.org' ? /^\/wiki\/Special:FilePath\/(.+)$/.exec(u.pathname) : null
    if (!m) return [url]
    const name = decodeURIComponent(m[1]!).replace(/ /g, '_')
    const want = Number(u.searchParams.get('width')) || 330
    const width = [60, 120, 250, 330, 500, 960].find(w => w >= want) ?? 960
    const md5 = createHash('md5').update(name).digest('hex')
    const file = encodeURIComponent(name)
    const thumb = `https://upload.wikimedia.org/wikipedia/commons/thumb/${md5[0]}/${md5.slice(0, 2)}/${file}/${width}px-${file}`
    return [thumb, `https://wsrv.nl/?url=${encodeURIComponent(`upload.wikimedia.org/wikipedia/commons/${md5[0]}/${md5.slice(0, 2)}/${file}`)}&w=${width}`]
  }

  private async fetchOnce(url: string): Promise<Response> {
    let res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': UA }, redirect: 'follow' })
    if (res.status === 429 || res.status === 503) {
      await new Promise(r => setTimeout(r, 1500))
      res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': UA }, redirect: 'follow' })
    }
    return res
  }

  /** The picture as a data URL, or null when it cannot be had. */
  get(url: unknown): Promise<string | null> {
    if (!isAllowedImage(url)) return Promise.resolve(null)
    const hit = this.memory.get(url)
    if (hit) return Promise.resolve(hit)
    const going = this.pending.get(url)
    if (going) return going
    const file = join(this.dir, `${createHash('sha1').update(url).digest('hex')}.txt`)
    const run = (async () => {
      try {
        const saved = await readFile(file, 'utf8')
        if (saved.startsWith('data:image/')) return this.keep(url, saved)
      } catch {
        // Not on disk yet.
      }
      await this.slot()
      try {
        for (const source of this.sources(url))
          try {
            const res = await this.fetchOnce(source)
            if (!res.ok) continue
            // Redirects must land on an allowed host (or the proxy we chose).
            const landed = new URL(res.url || source).hostname
            if (!HOSTS.has(landed) && landed !== 'wsrv.nl') continue
            const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
            if (!type.startsWith('image/')) continue
            const buf = Buffer.from(await res.arrayBuffer())
            if (buf.length > MAX_BYTES) continue
            const data = `data:${type};base64,${buf.toString('base64')}`
            await mkdir(this.dir, { recursive: true }).catch(() => undefined)
            await writeFile(file, data).catch(() => undefined)
            return this.keep(url, data)
          } catch {
            // The next source.
          }
        return null
      } finally {
        this.release()
      }
    })().finally(() => this.pending.delete(url))
    this.pending.set(url, run)
    return run
  }

  private keep(url: string, data: string) {
    this.memory.set(url, data)
    if (this.memory.size > 300) this.memory.delete(this.memory.keys().next().value!)
    return data
  }
}
