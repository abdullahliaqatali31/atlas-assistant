/**
 * Browser profiles and habits, main side (shared/habits.ts does the sums).
 * Once the owner turns it on, this finds every Chromium browser (Chrome, Edge,
 * Brave, Comet, Arc, Opera, Vivaldi…) and Firefox-family browser
 * profile on the PC (names, colours and pictures from the browser's own
 * "Local State"), copies each recently used profile's history file into
 * Atlas's folder (the browser keeps it locked) and reads the last 30 days of
 * visits and searches, read-only. A profile's file is read again only when it
 * changed. Nothing leaves the PC; Atlas gets a text summary of the profiles
 * the owner shares.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

import {
  DEFAULT_WORK_HOURS,
  estimate,
  insights,
  ownWords,
  localDay,
  RANGES,
  ribbon,
  summarize,
  type HabitsRange,
  type HabitsView,
  type ProfileInfo,
  type ProfileRole,
  type RangeDays,
  type RibbonSegment,
  type Spent,
  type Visit,
  type WorkHours,
} from '../../shared/habits.ts'

const DAY_MS = 86_400_000
const WINDOW_DAYS = 30
/** Read again on its own this often while on. */
const REFRESH_MS = 10 * 60_000
const MAX_VISITS = 60_000

type Kind = 'chromium' | 'firefox'

/**
 * Chromium-family browsers (one "User Data" folder, profiles listed in its Local State): under
 * %LOCALAPPDATA% unless noted on Windows; `mac` is the folder under ~/Library/Application Support.
 */
const CHROMIUM: { id: string; name: string; dir: string; roaming?: boolean; mac: string }[] = [
  { id: 'chrome', name: 'Chrome', dir: join('Google', 'Chrome', 'User Data'), mac: join('Google', 'Chrome') },
  { id: 'chrome-beta', name: 'Chrome Beta', dir: join('Google', 'Chrome Beta', 'User Data'), mac: join('Google', 'Chrome Beta') },
  { id: 'chrome-canary', name: 'Chrome Canary', dir: join('Google', 'Chrome SxS', 'User Data'), mac: join('Google', 'Chrome Canary') },
  { id: 'edge', name: 'Edge', dir: join('Microsoft', 'Edge', 'User Data'), mac: 'Microsoft Edge' },
  { id: 'edge-beta', name: 'Edge Beta', dir: join('Microsoft', 'Edge Beta', 'User Data'), mac: 'Microsoft Edge Beta' },
  { id: 'edge-dev', name: 'Edge Dev', dir: join('Microsoft', 'Edge Dev', 'User Data'), mac: 'Microsoft Edge Dev' },
  { id: 'brave', name: 'Brave', dir: join('BraveSoftware', 'Brave-Browser', 'User Data'), mac: join('BraveSoftware', 'Brave-Browser') },
  { id: 'comet', name: 'Comet', dir: join('Perplexity', 'Comet', 'User Data'), mac: 'Comet' },
  { id: 'vivaldi', name: 'Vivaldi', dir: join('Vivaldi', 'User Data'), mac: 'Vivaldi' },
  { id: 'yandex', name: 'Yandex', dir: join('Yandex', 'YandexBrowser', 'User Data'), mac: join('Yandex', 'YandexBrowser') },
  { id: 'chromium', name: 'Chromium', dir: join('Chromium', 'User Data'), mac: 'Chromium' },
  { id: 'thorium', name: 'Thorium', dir: join('Thorium', 'User Data'), mac: 'Thorium' },
  { id: 'arc-mac', name: 'Arc', dir: '', mac: join('Arc', 'User Data') },
  { id: 'opera', name: 'Opera', dir: join('Opera Software', 'Opera Stable'), roaming: true, mac: 'com.operasoftware.Opera' },
  { id: 'opera-gx', name: 'Opera GX', dir: join('Opera Software', 'Opera GX Stable'), roaming: true, mac: 'com.operasoftware.OperaGX' },
]

/** Firefox-family browsers: profiles listed in profiles.ini under %APPDATA% (`mac`: under ~/Library/Application Support). */
const FIREFOX: { id: string; name: string; dir: string; mac: string }[] = [
  { id: 'firefox', name: 'Firefox', dir: join('Mozilla', 'Firefox'), mac: 'Firefox' },
  { id: 'zen', name: 'Zen', dir: 'zen', mac: 'zen' },
  { id: 'floorp', name: 'Floorp', dir: 'Floorp', mac: 'Floorp' },
  { id: 'librewolf', name: 'LibreWolf', dir: 'librewolf', mac: 'librewolf' },
  { id: 'waterfox', name: 'Waterfox', dir: 'Waterfox', mac: 'Waterfox' },
]
const MAC = process.platform === 'darwin'
const MAC_SUPPORT = join(homedir(), 'Library', 'Application Support')

/** Arc installs as a Store app: its User Data sits inside the package folder. */
const arcRoot = (local: string): string | null => {
  try {
    const pkg = readdirSync(join(local, 'Packages')).find(d => /^TheBrowserCompany\.Arc_/.test(d))
    return pkg ? join(local, 'Packages', pkg, 'LocalCache', 'Local', 'Arc', 'User Data') : null
  } catch {
    return null
  }
}

/** Each Chromium-family browser's "User Data" folder on this computer (Windows or Mac). */
export const chromiumRoots = (): { id: string; name: string; root: string }[] => {
  const local = process.env.LOCALAPPDATA ?? ''
  const roaming = process.env.APPDATA ?? ''
  const roots = MAC
    ? CHROMIUM.map(b => ({ id: b.id === 'arc-mac' ? 'arc' : b.id, name: b.name, root: join(MAC_SUPPORT, b.mac) }))
    : CHROMIUM.filter(b => b.dir).map(b => ({ id: b.id, name: b.name, root: join(b.roaming ? roaming : local, b.dir) }))
  const arc = MAC ? null : arcRoot(local)
  if (arc) roots.push({ id: 'arc', name: 'Arc', root: arc })
  return roots
}

/** Every Chromium-family profile with a history file: browser, profile folder and the file. */
export const chromiumProfiles = (): { browserId: string; browser: string; dir: string; history: string }[] =>
  chromiumRoots().flatMap(b => {
    let dirs: string[] = []
    try {
      dirs = Object.keys(((JSON.parse(readFileSync(join(b.root, 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, unknown> } }).profile?.info_cache ?? {}) as Record<string, unknown>)
    } catch {
      return []
    }
    return dirs.map(dir => ({ browserId: b.id, browser: b.name, dir, history: join(b.root, dir, 'History') })).filter(p => existsSync(p.history))
  })

/** profiles.ini → each profile's name and folder. */
const firefoxProfiles = (root: string): { name: string; path: string }[] => {
  let ini = ''
  try {
    ini = readFileSync(join(root, 'profiles.ini'), 'utf8')
  } catch {
    return []
  }
  const out: { name: string; path: string }[] = []
  for (const block of ini.split(/^\[/m)) {
    if (!/^Profile\d+\]/.test(block)) continue
    const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(block)?.[1]?.trim() ?? ''
    const path = get('Path')
    if (!path) continue
    out.push({ name: get('Name') || path, path: get('IsRelative') === '0' ? path : join(root, path) })
  }
  return out
}

/** Search words from a search page's address (Google, Bing, DuckDuckGo, Yahoo, Perplexity). */
const searchTerm = (url: string): string | null => {
  try {
    const u = new URL(url)
    if (!/(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|search\.yahoo\.com|perplexity\.ai|search\.brave\.com)$/.test(u.hostname)) return null
    const q = u.searchParams.get('q') ?? u.searchParams.get('p')
    return q?.trim() ? q.trim().slice(0, 100) : null
  } catch {
    return null
  }
}

/** Fallback colours for profiles without their own (one per profile, in order). */
const FALLBACK = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#2dd4bf', '#fb923c', '#94a3b8']

interface Saved {
  enabled: boolean
  workHours: WorkHours
  roles: Record<string, ProfileRole>
  /** Profiles hidden from Atlas. */
  hidden: string[]
}

interface Found extends ProfileInfo {
  kind: Kind
  /** The account holder's name (to tell a person's name from a business name). */
  person: string
  history: string
  mtime: number
}

interface Read {
  mtime: number
  spent: Spent[]
  searches: { term: string; count: number }[]
}

/** Chrome keeps colours as signed ARGB numbers. */
const argb = (v: unknown): string | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return `#${((v >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class HabitsService {
  private saved: Saved
  private found: Found[] = []
  private readonly cache = new Map<string, Read>()
  private view: HabitsView
  private reading: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly deps: {
      file: string
      cacheDir: string
      onChange: (v: HabitsView) => void
      log: (level: 'info' | 'warn', message: string) => void
    },
  ) {
    this.saved = this.load()
    this.view = { enabled: this.saved.enabled, reading: false, readAt: null, error: null, workHours: this.saved.workHours, found: [], ranges: {}, ribbons: {} }
    // After the app has finished wiring itself up (onChange may use things made after this).
    if (this.saved.enabled) setTimeout(() => this.start(), 0)
  }

  private load(): Saved {
    try {
      const raw = JSON.parse(readFileSync(this.deps.file, 'utf8')) as Partial<Saved>
      return {
        enabled: raw.enabled === true,
        workHours: raw.workHours ?? DEFAULT_WORK_HOURS,
        roles: raw.roles && typeof raw.roles === 'object' ? raw.roles : {},
        hidden: Array.isArray(raw.hidden) ? raw.hidden.filter(h => typeof h === 'string') : [],
      }
    } catch {
      return { enabled: false, workHours: DEFAULT_WORK_HOURS, roles: {}, hidden: [] }
    }
  }

  private save() {
    try {
      writeFileSync(this.deps.file, JSON.stringify(this.saved))
    } catch (e) {
      this.deps.log('warn', `Could not save the habits settings: ${String(e)}`)
    }
  }

  state(): HabitsView {
    return this.view
  }

  get enabled() {
    return this.saved.enabled
  }

  setEnabled(on: boolean) {
    this.saved.enabled = on
    this.save()
    if (on) this.start()
    else {
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      this.cache.clear()
      this.view = { ...this.view, enabled: false, ranges: {}, ribbons: {}, found: [] }
      this.publish()
    }
    return this.view
  }

  setProfile(key: string, change: { role?: ProfileRole | null | undefined; shared?: boolean | undefined }) {
    if (change.role !== undefined) {
      if (change.role === null) delete this.saved.roles[key]
      else this.saved.roles[key] = change.role
    }
    if (change.shared !== undefined) this.saved.hidden = change.shared ? this.saved.hidden.filter(h => h !== key) : [...new Set([...this.saved.hidden, key])]
    this.save()
    this.compute()
    return this.view
  }

  setWorkHours(w: WorkHours) {
    this.saved.workHours = w
    this.save()
    this.compute()
    return this.view
  }

  async refresh(): Promise<HabitsView> {
    if (this.saved.enabled) await this.read()
    return this.view
  }

  private start() {
    this.view = { ...this.view, enabled: true }
    void this.read()
    if (!this.timer) {
      this.timer = setInterval(() => void this.read(), REFRESH_MS)
      this.timer.unref()
    }
  }

  private publish() {
    this.deps.onChange(this.view)
  }

  /** Every profile of every browser on the PC. */
  private discover(): Found[] {
    const out: Found[] = []
    const roaming = process.env.APPDATA ?? ''
    for (const b of chromiumRoots()) {
      const root = b.root
      let cache: Record<string, Record<string, unknown>> = {}
      try {
        cache = ((JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as { profile?: { info_cache?: typeof cache } }).profile?.info_cache ?? {}) as typeof cache
      } catch {
        continue
      }
      // Opera keeps one profile and may not list it: look in its own folder.
      if (!Object.keys(cache).length) cache = existsSync(join(root, 'Default', 'History')) ? { Default: { name: b.name } } : existsSync(join(root, 'History')) ? { '': { name: b.name } } : {}
      for (const [dir, info] of Object.entries(cache)) {
        const history = join(root, dir, 'History')
        let mtime = 0
        try {
          mtime = statSync(history).mtimeMs
        } catch {
          continue
        }
        let picture: string | null = null
        const pic = typeof info.gaia_picture_file_name === 'string' && info.gaia_picture_file_name ? join(root, dir, info.gaia_picture_file_name) : null
        try {
          if (pic && existsSync(pic) && statSync(pic).size < 200_000) picture = `data:image/png;base64,${readFileSync(pic).toString('base64')}`
        } catch {
          picture = null
        }
        const name = String(info.name || info.gaia_name || dir)
        out.push({
          kind: 'chromium',
          key: `${b.id}:${dir || 'main'}`,
          browser: b.name,
          name,
          account: typeof info.user_name === 'string' ? info.user_name : '',
          color: argb(info.profile_highlight_color) ?? argb(info.default_avatar_fill_color) ?? FALLBACK[out.length % FALLBACK.length]!,
          picture,
          person: String(info.gaia_name ?? info.gaia_given_name ?? ''),
          history,
          mtime,
        })
      }
    }
    for (const b of FIREFOX) {
      for (const p of firefoxProfiles(MAC ? join(MAC_SUPPORT, b.mac) : join(roaming, b.dir))) {
        const history = join(p.path, 'places.sqlite')
        let mtime = 0
        try {
          // The journal changes as you browse; the main file only now and then.
          mtime = Math.max(statSync(history).mtimeMs, existsSync(`${history}-wal`) ? statSync(`${history}-wal`).mtimeMs : 0)
        } catch {
          continue
        }
        const name = p.name.replace(/^default(-release)?$/i, b.name)
        out.push({ kind: 'firefox', key: `${b.id}:${p.name}`, browser: b.name, name, account: '', color: FALLBACK[out.length % FALLBACK.length]!, picture: null, person: '', history, mtime })
      }
    }
    return out
  }

  /** One profile's last 30 days, from a fresh copy of its history file. */
  private readProfile(p: Found, since: number, own: string[]): Read {
    mkdirSync(this.deps.cacheDir, { recursive: true })
    const copy = join(this.deps.cacheDir, `${p.key.replace(/[^\w-]+/g, '_')}.db`)
    copyFileSync(p.history, copy)
    for (const ext of ['-journal', '-wal']) {
      try {
        if (existsSync(p.history + ext)) copyFileSync(p.history + ext, copy + ext)
        else if (existsSync(copy + ext)) writeFileSync(copy + ext, '')
      } catch {
        // A journal in use: the main file alone is a little older, which is fine.
      }
    }
    const db = new DatabaseSync(copy, { readOnly: true })
    try {
      if (p.kind === 'firefox') {
        // Firefox: microseconds since 1970, no measured time per visit; searches come from search-page addresses.
        const rows = db
          .prepare(
            `SELECT v.visit_date / 1000 AS t, p.url AS url, p.title AS title FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id
             WHERE v.visit_date / 1000 > ? AND v.visit_type NOT IN (4, 8) ORDER BY v.visit_date LIMIT ${MAX_VISITS}`,
          )
          .all(since) as unknown as { t: number; url: string; title: string | null }[]
        const visits: Visit[] = rows.map(r => ({ t: Number(r.t), dur: 0, url: r.url, title: r.title ?? '' }))
        const counts = new Map<string, number>()
        for (const v of visits) {
          const term = searchTerm(v.url)
          if (term) counts.set(term, (counts.get(term) ?? 0) + 1)
        }
        const searches = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([term, count]) => ({ term, count }))
        return { mtime: p.mtime, spent: estimate(visits, own), searches }
      }
      // Chrome's times are microseconds since 1601; converted in SQL so they stay small numbers.
      const rows = db
        .prepare(
          `SELECT v.visit_time / 1000 - 11644473600000 AS t, v.visit_duration / 1000 AS d, u.url AS url, u.title AS title
           FROM visits v JOIN urls u ON u.id = v.url
           WHERE v.visit_time / 1000 - 11644473600000 > ? AND (v.transition & 255) NOT IN (3, 4)
           ORDER BY v.visit_time LIMIT ${MAX_VISITS}`,
        )
        .all(since) as unknown as { t: number; d: number; url: string; title: string | null }[]
      const visits: Visit[] = rows.map(r => ({ t: Number(r.t), dur: Math.max(0, Number(r.d) || 0), url: r.url, title: r.title ?? '' }))
      let searches: { term: string; count: number }[] = []
      try {
        searches = (
          db
            .prepare(
              `SELECT k.term AS term, count(*) AS c FROM keyword_search_terms k JOIN urls u ON u.id = k.url_id
               WHERE u.last_visit_time / 1000 - 11644473600000 > ? GROUP BY k.normalized_term ORDER BY c DESC, u.last_visit_time DESC LIMIT 15`,
            )
            .all(since) as unknown as { term: string; c: number }[]
        ).map(r => ({ term: String(r.term).slice(0, 100), count: Number(r.c) }))
      } catch {
        searches = []
      }
      return { mtime: p.mtime, spent: estimate(visits, own), searches }
    } finally {
      db.close()
    }
  }

  private read(): Promise<void> {
    this.reading ??= this.readAll().finally(() => (this.reading = null))
    return this.reading
  }

  private async readAll() {
    this.view = { ...this.view, reading: true }
    this.publish()
    const since = Date.now() - WINDOW_DAYS * DAY_MS
    let error: string | null = null
    try {
      this.found = this.discover()
      const own = ownWords(this.found)
      for (const p of this.found) {
        if (!this.saved.enabled) return
        if (p.mtime < since) continue
        if (this.cache.get(p.key)?.mtime === p.mtime) continue
        try {
          this.cache.set(p.key, this.readProfile(p, since, own))
        } catch (e) {
          this.deps.log('warn', `Could not read ${p.browser} profile "${p.name}": ${e instanceof Error ? e.message : String(e)}`)
        }
        // Let the window breathe between profiles.
        await sleep(15)
      }
      if (!this.found.length) error = 'No browser profiles were found on this PC.'
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    this.view = { ...this.view, reading: false, readAt: Date.now(), error }
    this.compute()
  }

  /** The sums for each range, the week's ribbons and the advice, from what was read. */
  private compute() {
    if (!this.saved.enabled) return
    const now = Date.now()
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    const w = this.saved.workHours
    const ranges: Partial<Record<RangeDays, HabitsRange>> = {}
    for (const days of RANGES) {
      const from = today.getTime() - (days - 1) * DAY_MS
      const profiles = this.found
        .filter(p => this.cache.has(p.key))
        .map(p => {
          const r = this.cache.get(p.key)!
          // Pictures travel once, in found (the page puts them back).
          return summarize({ ...p, picture: null }, r.spent, from, now + 1, { workHours: w, role: this.saved.roles[p.key] ?? null, shared: !this.saved.hidden.includes(p.key), searches: r.searches })
        })
        .filter(p => p.totalMs > 0)
        .sort((a, b) => b.totalMs - a.totalMs)
      const { insights: ins, guides } = insights(profiles, w, days)
      ranges[days] = { days, profiles, insights: ins, guides }
    }
    const ribbons: Record<string, Record<string, RibbonSegment[]>> = {}
    for (let i = 0; i < 7; i++) {
      const from = today.getTime() - i * DAY_MS
      const to = from + DAY_MS
      const day: Record<string, RibbonSegment[]> = {}
      for (const [key, r] of this.cache) {
        const segs = ribbon(r.spent, from, to)
        if (segs.length) day[key] = segs
      }
      ribbons[localDay(from + 3_600_000 * 2)] = day
    }
    const lastUsed = new Map([...this.cache].map(([k, r]) => [k, r.spent.length ? r.spent[r.spent.length - 1]!.t : 0]))
    this.view = {
      ...this.view,
      enabled: true,
      workHours: w,
      found: this.found
        .map(p => ({ key: p.key, browser: p.browser, name: p.name, account: p.account, color: p.color, picture: p.picture, lastUsed: lastUsed.get(p.key) ?? p.mtime, shared: !this.saved.hidden.includes(p.key), role: this.saved.roles[p.key] ?? null }))
        .sort((a, b) => b.lastUsed - a.lastUsed),
      ranges,
      ribbons,
    }
    this.publish()
  }
}
