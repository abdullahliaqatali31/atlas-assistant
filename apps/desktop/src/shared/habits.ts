/**
 * Browser profiles and habits: what each browser profile (Chrome, Edge, Comet, Firefox…) is
 * used for, when, and what does not belong where. Main reads each profile's
 * own history file on this PC (once the owner turns it on) and this module
 * turns the visits into time per site, category, hour and day, a guess at
 * each profile's role, and plain advice ("keep YouTube out of GrowZen",
 * "your best work hours are 11-13"). Nothing is uploaded; Atlas sees a
 * summary, and only of the profiles the owner lets it see.
 */

export const HABIT_CATEGORIES = ['work', 'video', 'learning', 'shopping', 'social', 'chat', 'ai', 'news', 'other'] as const
export type HabitCategory = (typeof HABIT_CATEGORIES)[number]

export const CATEGORY_LABEL: Record<HabitCategory, string> = {
  work: 'Work & tools',
  video: 'Video',
  learning: 'Learning',
  shopping: 'Shopping',
  social: 'Social',
  chat: 'Mail & chat',
  ai: 'AI',
  news: 'News',
  other: 'Other',
}

/** Categorical slots in a fixed, colour-blind-checked order (dark surface); "other" is neutral. */
export const CATEGORY_COLOR: Record<HabitCategory, string> = {
  work: '#3987e5',
  video: '#d95926',
  learning: '#199e70',
  shopping: '#c98500',
  social: '#d55181',
  chat: '#008300',
  ai: '#9085e9',
  news: '#e66767',
  other: '#5b6475',
}

/** Time that pulls away from work. */
export const LEISURE: ReadonlySet<HabitCategory> = new Set(['video', 'social', 'shopping'])
/** Time that is work. */
export const WORKISH: ReadonlySet<HabitCategory> = new Set(['work', 'ai', 'chat', 'learning'])

const RULES: [RegExp, HabitCategory][] = [
  [/(^|\.)(youtube\.com|youtu\.be|netflix\.com|primevideo\.com|twitch\.tv|vimeo\.com|dailymotion\.com|hotstar\.com|tamashaweb\.com|myco\.io|tapmad\.com|disneyplus\.com|spotify\.com)$/, 'video'],
  [/(^|\.)(facebook\.com|instagram\.com|x\.com|twitter\.com|tiktok\.com|reddit\.com|pinterest\.com|snapchat\.com|threads\.net|quora\.com|9gag\.com)$/, 'social'],
  [/(^|\.)(mail\.google\.com|gmail\.com|outlook\.(live|office|office365)\.com|web\.whatsapp\.com|whatsapp\.com|slack\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|discord\.com|telegram\.org|messenger\.com|zoom\.us|meet\.google\.com|calendar\.google\.com)$/, 'chat'],
  [/(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com|claude\.ai|anthropic\.com|gemini\.google\.com|perplexity\.ai|poe\.com|copilot\.microsoft\.com|huggingface\.co|deepseek\.com|grok\.com|aistudio\.google\.com|lovable\.dev|v0\.dev|bolt\.new|replit\.com|cursor\.com|higgsfield\.ai|midjourney\.com|elevenlabs\.io)$/, 'ai'],
  [/(^|\.)(amazon\.[a-z.]+|daraz\.pk|aliexpress\.com|alibaba\.com|ebay\.com|olx\.com\.pk|temu\.com|shein\.com|etsy\.com|shopify\.com|walmart\.com|priceoye\.pk|telemart\.pk)$/, 'shopping'],
  [/(^|\.)(wikipedia\.org|coursera\.org|udemy\.com|edx\.org|khanacademy\.org|w3schools\.com|freecodecamp\.org|medium\.com|dev\.to|geeksforgeeks\.org|duolingo\.com|brilliant\.org|stackoverflow\.com|stackexchange\.com|mdn\.io|developer\.mozilla\.org|scholar\.google\.com|arxiv\.org|britannica\.com)$/, 'learning'],
  [/(^|\.)(dawn\.com|geo\.tv|arynews\.tv|thenews\.com\.pk|tribune\.com\.pk|bbc\.(com|co\.uk)|cnn\.com|aljazeera\.com|reuters\.com|nytimes\.com|theguardian\.com|apnews\.com|bloomberg\.com|news\.google\.com|news\.ycombinator\.com|samaa\.tv|express\.pk|dw\.com|espncricinfo\.com|cricbuzz\.com|theverge\.com|techcrunch\.com|wired\.com|arstechnica\.com)$/, 'news'],
  [/(^|\.)(github\.com|gitlab\.com|bitbucket\.org|vercel\.com|netlify\.com|aws\.amazon\.com|console\.cloud\.google\.com|cloud\.google\.com|azure\.com|portal\.azure\.com|docs\.google\.com|drive\.google\.com|sheets\.google\.com|notion\.so|figma\.com|canva\.com|trello\.com|atlassian\.net|asana\.com|linear\.app|clickup\.com|monday\.com|airtable\.com|hubspot\.com|salesforce\.com|stripe\.com|upwork\.com|fiverr\.com|linkedin\.com|supabase\.com|firebase\.google\.com|cloudflare\.com|digitalocean\.com|heroku\.com|npmjs\.com|pypi\.org|docker\.com|postman\.com|wordpress\.com|wix\.com|godaddy\.com|namecheap\.com|hostinger\.com|business\.facebook\.com|ads\.google\.com|analytics\.google\.com|search\.google\.com|zoho\.com|quickbooks\.intuit\.com|xero\.com|office\.com|sharepoint\.com|onedrive\.live\.com|dropbox\.com|calendly\.com|loom\.com|miro\.com|semrush\.com|ahrefs\.com|expo\.dev|cesium\.com|tomtom\.com|mapbox\.com|contabo\.com|hetzner\.com|chromewebstore\.google\.com|chrome\.google\.com|play\.google\.com|developer\.apple\.com|appstoreconnect\.apple\.com|sentry\.io|posthog\.com|resend\.com|twilio\.com|openrouter\.ai|platform\.openai\.com|console\.anthropic\.com)$/, 'work'],
]

/** A site's category from its host name. */
/** Adult sites: counted (as leisure) but never named, here or to Atlas. */
const PRIVATE = /(porn|xxx|lewd|hentai|nsfw|onlyfans|xvideos|xnxx|xhamster|redtube|youporn|chaturbate|stripchat|camsoda|brazzers|rule34|spankbang|eporner|(^|[.-])sex)/i
export const PRIVATE_HOST = 'private site'
export const isPrivate = (text: string) => PRIVATE.test(text)

/** Film and series sites by their names (streaming, debrid, "watch order" guides). */
const STREAMING = /(movie|cine|film|flix|stream|anime|drama|series|torrent|torbox|debrid|watchorder|watchinorder|kdrama|hdtoday|soap2day|fmovies|123mov|putlocker|vidsrc|earnvids)/i

/** Where people deploy their own projects. */
const DEPLOYS = /\.(vercel\.app|netlify\.app|pages\.dev|onrender\.com|railway\.app|fly\.dev|web\.app|firebaseapp\.com|herokuapp\.com|github\.io|ngrok-free\.app|ngrok\.io)$/

/**
 * A site's category from its host name. `own` are words from the owner's
 * own businesses (profile names, company email domains): their sites are work.
 */
export const categorize = (host: string, own: readonly string[] = []): HabitCategory => {
  const h = host.toLowerCase()
  if (h === PRIVATE_HOST || PRIVATE.test(h)) return 'video'
  if (h === 'localhost' || /^127\.|^192\.168\.|^10\./.test(h) || h.endsWith('.local')) return 'work'
  for (const [re, cat] of RULES) if (re.test(h)) return cat
  if (STREAMING.test(h)) return 'video'
  if (own.some(w => h.includes(w))) return 'work'
  if (DEPLOYS.test(h) || /(^|\.)(docs|console|dashboard|admin|app|portal|studio|developer|developers|api|crm|internal|billing|support)\./.test(h)) return 'work'
  return 'other'
}

/** Words naming the owner's own businesses: company email domains, and profile names that are not the person's name. */
export const ownWords = (profiles: readonly { name: string; account: string; person?: string | undefined }[]): string[] => {
  const words = new Set<string>()
  const generic = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|proton|protonmail|aol|msn|yandex|zoho)$/
  for (const p of profiles) {
    const domain = p.account.split('@')[1]?.split('.')[0]?.toLowerCase()
    if (domain && domain.length >= 4 && !generic.test(domain)) words.add(domain)
    const name = p.name.toLowerCase().replace(/[^a-z0-9]/g, '')
    const person = (p.person ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '')
    const first = person.split(' ')[0] ?? ''
    if (name.length < 4 || /^(profile|person|work|personal|default|your|chrome|user|wsl|edge|brave)/.test(name)) continue
    if (first && (name.includes(first) || first.includes(name))) continue
    words.add(name)
  }
  return [...words]
}

export const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.hostname.replace(/^www\.|^m\./, '')
  } catch {
    return null
  }
}

export type ProfileRole = 'personal' | 'work' | 'study' | 'other'
export const ROLE_LABEL: Record<ProfileRole, string> = { personal: 'Personal', work: 'Work / business', study: 'Study', other: 'Other' }

/** The owner's working hours: minutes after midnight, days 0 (Sunday) to 6. */
export interface WorkHours {
  start: number
  end: number
  days: number[]
}
export const DEFAULT_WORK_HOURS: WorkHours = { start: 9 * 60, end: 18 * 60, days: [1, 2, 3, 4, 5] }

export const inWorkHours = (at: number, w: WorkHours): boolean => {
  const d = new Date(at)
  const m = d.getHours() * 60 + d.getMinutes()
  return w.days.includes(d.getDay()) && (w.start <= w.end ? m >= w.start && m < w.end : m >= w.start || m < w.end)
}

/** One visit, read from a profile's history. */
export interface Visit {
  /** ms since 1970 */
  t: number
  /** What the browser measured (0 when unknown), ms. */
  dur: number
  url: string
  title: string
}

/** A visit with its estimated time on screen (never overlapping the next one). */
export interface Spent {
  t: number
  ms: number
  host: string
  cat: HabitCategory
  url: string
  title: string
}

/** Pages left open count for at most this long; an unmeasured visit counts a few minutes. */
const MAX_VISIT_MS = 20 * 60_000
const UNMEASURED_MS = 3 * 60_000

/**
 * Time per visit: until the next visit in the same profile, at most what the
 * browser measured (capped), so tabs left open in the background do not count.
 */
export const estimate = (visits: readonly Visit[], own: readonly string[] = []): Spent[] => {
  const sorted = [...visits].sort((a, b) => a.t - b.t)
  const out: Spent[] = []
  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i]!
    const real = hostOf(v.url)
    if (!real) continue
    const hidden = isPrivate(real)
    const host = hidden ? PRIVATE_HOST : real
    const cap = v.dur > 0 ? Math.min(v.dur, MAX_VISIT_MS) : UNMEASURED_MS
    const next = sorted[i + 1]
    const ms = Math.max(0, Math.min(cap, next ? next.t - v.t : cap))
    out.push({ t: v.t, ms, host, cat: categorize(host, own), url: hidden ? '' : v.url, title: hidden ? '' : v.title })
  }
  return out
}

export interface SiteTime {
  host: string
  ms: number
  visits: number
  cat: HabitCategory
}

export interface RibbonSegment {
  start: number
  end: number
  cat: HabitCategory
  host: string
}

export interface ProfileInfo {
  /** "chrome:Profile 2" */
  key: string
  browser: string
  name: string
  /** The signed-in account, shown to the owner only (never sent to Atlas). */
  account: string
  color: string
  /** The profile's picture, as a data: URL, when it has one. */
  picture: string | null
}

export interface ProfileHabits extends ProfileInfo {
  role: ProfileRole | null
  inferred: { role: ProfileRole; why: string }
  /** Atlas may see it. */
  shared: boolean
  totalMs: number
  workHoursMs: number
  lastUsed: number
  byCategory: Record<HabitCategory, number>
  sites: SiteTime[]
  /** ms per weekday (0 = Sunday) and hour. */
  week: number[][]
  /** ms per local day, oldest first, one per day of the range. */
  daily: { day: string; ms: number }[]
  youtube: { title: string; count: number; at: number }[]
  searches: { term: string; count: number }[]
}

export type InsightTone = 'good' | 'warn' | 'info'
export interface Insight {
  tone: InsightTone
  title: string
  detail: string
  profile?: string | undefined
  /** A stable name for the kind of finding (one nudge per kind, profile and day). */
  kind?: string | undefined
}

/** The advice card per profile: what belongs there, what does not, and when it works best. */
export interface ProfileGuide {
  key: string
  doHere: string[]
  keepOut: string[]
  bestTime: string | null
}

export interface HabitsRange {
  days: number
  profiles: ProfileHabits[]
  insights: Insight[]
  guides: ProfileGuide[]
}

export const RANGES = [1, 7, 30] as const
export type RangeDays = (typeof RANGES)[number]

export interface HabitsView {
  enabled: boolean
  reading: boolean
  readAt: number | null
  error: string | null
  workHours: WorkHours
  /** Every profile found (active or not), for the settings list. */
  found: (ProfileInfo & { lastUsed: number; shared: boolean; role: ProfileRole | null })[]
  ranges: Partial<Record<RangeDays, HabitsRange>>
  /** Today's and the past week's ribbons: day → profile key → segments. */
  ribbons: Record<string, Record<string, RibbonSegment[]>>
}

export const EMPTY_HABITS: HabitsView = { enabled: false, reading: false, readAt: null, error: null, workHours: DEFAULT_WORK_HOURS, found: [], ranges: {}, ribbons: {} }

export const localDay = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export const fmtDuration = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

const hourLabel = (h: number) => `${String(h % 24).padStart(2, '0')}:00`

const emptyCats = (): Record<HabitCategory, number> => Object.fromEntries(HABIT_CATEGORIES.map(c => [c, 0])) as Record<HabitCategory, number>

/** "watch?v=…" pages give the video's title ("Title - YouTube"). */
const youtubeTitle = (s: Spent): string | null => {
  if (s.host !== 'youtube.com' || !/\/(watch|shorts)\b/.test(s.url)) return null
  const t = s.title.replace(/\s*-\s*YouTube\s*$/i, '').replace(/^\(\d+\)\s*/, '').trim()
  return t && t.toLowerCase() !== 'youtube' ? t.slice(0, 140) : null
}

/** What a profile looks used for, from where its time went. */
export const inferRole = (byCat: Record<HabitCategory, number>, total: number, workHoursMs: number): { role: ProfileRole; why: string } => {
  if (total <= 0) return { role: 'other', why: 'Not used in this period.' }
  const share = (cats: Iterable<HabitCategory>) => [...cats].reduce((a, c) => a + byCat[c], 0) / total
  const work = share(['work', 'ai', 'chat'])
  const leisure = share(LEISURE)
  const learning = byCat.learning / total
  const pct = (x: number) => `${Math.round(x * 100)}%`
  if (learning > 0.35 && learning > work) return { role: 'study', why: `${pct(learning)} of its time is learning sites.` }
  if (work >= 0.45 && work > leisure) return { role: 'work', why: `${pct(work)} work tools, AI, mail and chat${workHoursMs / total > 0.5 ? ', mostly in working hours' : ''}.` }
  if (leisure >= 0.35) return { role: 'personal', why: `${pct(leisure)} video, social and shopping.` }
  return { role: 'other', why: `A mix: ${pct(work)} work, ${pct(leisure)} leisure.` }
}

/** One profile's visits → its summary over [from, to). */
export const summarize = (info: ProfileInfo, spent: readonly Spent[], from: number, to: number, opt: { workHours: WorkHours; role: ProfileRole | null; shared: boolean; searches?: { term: string; count: number }[] | undefined }): ProfileHabits => {
  const inRange = spent.filter(s => s.t >= from && s.t < to)
  const byCategory = emptyCats()
  const sites = new Map<string, SiteTime>()
  const week = Array.from({ length: 7 }, () => new Array<number>(24).fill(0))
  const days = Math.max(1, Math.round((to - from) / 86_400_000))
  const first = startOfDay(from)
  const daily = Array.from({ length: days }, (_, i) => ({ day: localDay(first + i * 86_400_000 + 3_600_000 * 2), ms: 0 }))
  const dayIndex = new Map(daily.map((d, i) => [d.day, i]))
  const yt = new Map<string, { title: string; count: number; at: number }>()
  let total = 0
  let workHoursMs = 0
  let lastUsed = 0
  for (const s of inRange) {
    total += s.ms
    byCategory[s.cat] += s.ms
    if (inWorkHours(s.t, opt.workHours)) workHoursMs += s.ms
    lastUsed = Math.max(lastUsed, s.t)
    const site = sites.get(s.host) ?? { host: s.host, ms: 0, visits: 0, cat: s.cat }
    site.ms += s.ms
    site.visits++
    sites.set(s.host, site)
    const d = new Date(s.t)
    week[d.getDay()]![d.getHours()]! += s.ms
    const di = dayIndex.get(localDay(s.t))
    if (di !== undefined) daily[di]!.ms += s.ms
    const title = youtubeTitle(s)
    if (title) {
      const e = yt.get(title) ?? { title, count: 0, at: 0 }
      e.count++
      e.at = Math.max(e.at, s.t)
      yt.set(title, e)
    }
  }
  return {
    ...info,
    role: opt.role,
    inferred: inferRole(byCategory, total, workHoursMs),
    shared: opt.shared,
    totalMs: total,
    workHoursMs,
    lastUsed,
    byCategory,
    sites: [...sites.values()].sort((a, b) => b.ms - a.ms).slice(0, 14),
    week,
    daily,
    youtube: [...yt.values()].sort((a, b) => b.at - a.at).slice(0, 14),
    searches: (opt.searches ?? []).filter(s => !isPrivate(s.term)).slice(0, 12),
  }
}

/** The day's timeline for one profile: runs of one category, gaps under 2 minutes joined. */
export const ribbon = (spent: readonly Spent[], from: number, to: number): RibbonSegment[] => {
  const out: RibbonSegment[] = []
  for (const s of spent) {
    if (s.t < from || s.t >= to || s.ms <= 0) continue
    const end = Math.min(to, s.t + s.ms)
    const last = out[out.length - 1]
    if (last && last.cat === s.cat && s.t - last.end < 2 * 60_000) {
      last.end = Math.max(last.end, end)
      continue
    }
    out.push({ start: s.t, end, cat: s.cat, host: s.host })
  }
  return out
}

export const roleOf = (p: Pick<ProfileHabits, 'role' | 'inferred'>): ProfileRole => p.role ?? p.inferred.role

/** The 2-hour window with the most work time across the given profiles, or null. */
export const bestWorkWindow = (profiles: readonly ProfileHabits[]): { from: number; to: number; ms: number } | null => {
  const byHour = new Array<number>(24).fill(0)
  for (const p of profiles) {
    const workShare = p.totalMs ? [...WORKISH].reduce((a, c) => a + p.byCategory[c], 0) / p.totalMs : 0
    for (const day of p.week) day.forEach((ms, h) => (byHour[h]! += ms * workShare))
  }
  let best = -1
  let at = 0
  for (let h = 6; h < 23; h++) {
    const ms = byHour[h]! + byHour[h + 1]!
    if (ms > best) {
      best = ms
      at = h
    }
  }
  return best > 30 * 60_000 ? { from: at, to: at + 2, ms: best } : null
}

const topHosts = (p: ProfileHabits, cats: ReadonlySet<HabitCategory>, n = 3) =>
  p.sites
    .filter(s => cats.has(s.cat))
    .slice(0, n)
    .map(s => s.host)

/** Plain advice from the numbers: what each profile is for, what wanders in, when work goes best. */
export const insights = (profiles: readonly ProfileHabits[], workHours: WorkHours, days: number): { insights: Insight[]; guides: ProfileGuide[] } => {
  const out: Insight[] = []
  const period = days === 1 ? 'today' : `in ${days} days`
  const used = profiles.filter(p => p.totalMs > 5 * 60_000)
  const minor = days === 1 ? 15 * 60_000 : 30 * 60_000
  for (const p of used) {
    const role = roleOf(p)
    const leisure = [...LEISURE].reduce((a, c) => a + p.byCategory[c], 0)
    if (role === 'work' && leisure > minor) {
      out.push({ tone: 'warn', kind: 'leisure-at-work', profile: p.key, title: `${fmtDuration(leisure)} of leisure in ${p.name}`, detail: `${topHosts(p, LEISURE).join(', ') || 'Video and social'} ${period}. Keep these in your personal profile so work stays work.` })
    }
    if (role === 'personal' && p.workHoursMs > minor) {
      const top = p.sites.find(s => LEISURE.has(s.cat))
      out.push({ tone: 'warn', kind: 'personal-in-hours', profile: p.key, title: `${p.name} took ${fmtDuration(p.workHoursMs)} of working hours`, detail: `Your personal profile was open during work time ${period}${top ? `, mostly ${top.host}` : ''}.` })
    }
    if (role === 'work') {
      let late = 0
      for (let d = 0; d < 7; d++) for (const h of [23, 0, 1, 2, 3, 4]) if (p.week[d]![h]! > 5 * 60_000) late++
      if (late >= (days === 1 ? 1 : 3)) out.push({ tone: 'warn', kind: 'late', profile: p.key, title: `${p.name} runs late`, detail: `Work at night (23:00-05:00) on ${late} hour-slots ${period}. Late work tends to spill into the next morning.` })
    }
  }
  const workProfiles = used.filter(p => roleOf(p) === 'work')
  const best = bestWorkWindow(workProfiles.length ? workProfiles : used)
  if (best) out.push({ tone: 'good', title: `Your best work hours: ${hourLabel(best.from)}-${hourLabel(best.to)}`, detail: `Most of your focused work ${period} happens here. Guard it: no meetings, no feeds.` })
  const allYt = used.flatMap(p => p.youtube)
  if (allYt.length >= 3) {
    const words = topicWords(allYt.map(y => y.title))
    if (words.length) out.push({ tone: 'info', title: `On YouTube you watched ${allYt.length} videos`, detail: `Mostly about ${words.slice(0, 5).join(', ')}.` })
  }
  const total = used.reduce((a, p) => a + p.totalMs, 0)
  if (total > 0) {
    const leisureAll = used.reduce((a, p) => a + [...LEISURE].reduce((b, c) => b + p.byCategory[c], 0), 0)
    const share = leisureAll / total
    out.push(share < 0.2 ? { tone: 'good', title: `${Math.round((1 - share) * 100)}% of browsing was purposeful`, detail: `Only ${fmtDuration(leisureAll)} of video, social and shopping ${period}.` } : { tone: 'info', title: `${Math.round(share * 100)}% of browsing was leisure`, detail: `${fmtDuration(leisureAll)} of video, social and shopping ${period}.` })
  }
  const guides = used.map((p): ProfileGuide => {
    const role = roleOf(p)
    const own = role === 'work' || role === 'study' ? new Set<HabitCategory>([...WORKISH]) : role === 'personal' ? new Set<HabitCategory>([...LEISURE, 'news', 'learning', 'chat']) : new Set<HabitCategory>(HABIT_CATEGORIES)
    const doHere = p.sites.filter(s => own.has(s.cat)).slice(0, 4).map(s => s.host)
    const keepOut = role === 'work' || role === 'study' ? topHosts(p, LEISURE, 4) : role === 'personal' ? p.sites.filter(s => s.cat === 'work').slice(0, 3).map(s => s.host) : []
    const pb = bestWorkWindow([p])
    return { key: p.key, doHere, keepOut, bestTime: pb ? `${hourLabel(pb.from)}-${hourLabel(pb.to)}` : null }
  })
  return { insights: out.slice(0, 10), guides }
}

const STOP = new Set(
  'the a an and or of to in on for with by from at is are was be it this that how what why who you your my me i we our new vs video official full episode part live best top 2024 2025 2026 hd 4k ki ka ke ko se hai mein aur ya'.split(' '),
)

/** The words that come up most across titles and searches (for "mostly about…"). */
export const topicWords = (texts: readonly string[], n = 8): string[] => {
  const count = new Map<string, number>()
  for (const t of texts) {
    const seen = new Set<string>()
    for (const w of t.toLowerCase().match(/[\p{L}][\p{L}\p{N}+#]{2,}/gu) ?? []) {
      if (STOP.has(w) || seen.has(w)) continue
      seen.add(w)
      count.set(w, (count.get(w) ?? 0) + 1)
    }
  }
  return [...count]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w)
}

/** What Atlas reads: shared profiles only, never accounts or pictures. Titles and searches are other people's words. */
export const habitsForAtlas = (r: HabitsRange, workHours: WorkHours): string => {
  const shared = r.profiles.filter(p => p.shared && p.totalMs > 0)
  if (!shared.length) return 'No browsing in this period from the profiles you may see.'
  const lines = [`Browser profiles, last ${r.days === 1 ? 'day (today)' : `${r.days} days`} (working hours ${hourLabel(Math.floor(workHours.start / 60))}-${hourLabel(Math.floor(workHours.end / 60))}):`]
  for (const p of shared) {
    const cats = HABIT_CATEGORIES.filter(c => p.byCategory[c] > 0)
      .sort((a, b) => p.byCategory[b] - p.byCategory[a])
      .slice(0, 4)
      .map(c => `${CATEGORY_LABEL[c]} ${Math.round((p.byCategory[c] / p.totalMs) * 100)}%`)
    const pb = bestWorkWindow([p])
    lines.push(
      `- ${p.name} (${p.browser}; ${p.role ? `owner says ${ROLE_LABEL[p.role]}` : `looks ${ROLE_LABEL[p.inferred.role]}`}): ${fmtDuration(p.totalMs)}, ${fmtDuration(p.workHoursMs)} in working hours; ${cats.join(', ')}; top sites ${p.sites
        .slice(0, 6)
        .map(s => `${s.host} ${fmtDuration(s.ms)}`)
        .join(', ')}${pb ? `; busiest ${hourLabel(pb.from)}-${hourLabel(pb.to)}` : ''}.`,
    )
    if (p.youtube.length) lines.push(`  YouTube: ${p.youtube.slice(0, 6).map(y => `"${y.title}"`).join('; ')}`)
    if (p.searches.length) lines.push(`  Searches: ${p.searches.slice(0, 6).map(s => `"${s.term}"`).join('; ')}`)
  }
  const ins = r.insights.filter(i => !i.profile || shared.some(p => p.key === i.profile))
  if (ins.length) lines.push('What stands out:', ...ins.map(i => `- ${i.title}: ${i.detail}`))
  return lines.join('\n')
}

export const HB = {
  state: 'habits:state',
  changed: 'habits:changed',
  setEnabled: 'habits:set-enabled',
  setProfile: 'habits:set-profile',
  setWorkHours: 'habits:set-work-hours',
  refresh: 'habits:refresh',
} as const

export interface HabitsBridge {
  state(): Promise<HabitsView>
  onChanged(cb: (v: HabitsView) => void): () => void
  setEnabled(on: boolean): Promise<HabitsView>
  /** The owner names a profile's role, or hides it from Atlas. */
  setProfile(key: string, change: { role?: ProfileRole | null | undefined; shared?: boolean | undefined }): Promise<HabitsView>
  setWorkHours(w: WorkHours): Promise<HabitsView>
  refresh(): Promise<HabitsView>
}

export const parseWorkHours = (v: unknown): WorkHours | null => {
  const o = (v ?? {}) as Record<string, unknown>
  const min = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < 24 * 60 ? x : null)
  const start = min(o.start)
  const end = min(o.end)
  const days = Array.isArray(o.days) ? [...new Set(o.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : null
  return start !== null && end !== null && days && start !== end ? { start, end, days } : null
}

/** What main sends the runtime: summaries of shared profiles only. */
export interface HabitsForAtlas {
  /** habitsForAtlas() per range. */
  today: string
  week: string
  month: string
  /** One line for every reply's context: profile names, roles and time today (no titles or searches). */
  context: string
  /** Topic words from the week's YouTube titles and searches, for Today's find. */
  interests: string[]
  /** Things worth a gentle word today (keys are raised once each). */
  nudges: { key: string; title: string; detail: string }[]
}

export const forAtlas = (v: HabitsView): HabitsForAtlas | null => {
  const t = v.ranges[1]
  const w = v.ranges[7]
  const m = v.ranges[30]
  if (!v.enabled || !t || !w || !m) return null
  const shared = t.profiles.filter(p => p.shared && p.totalMs > 60_000)
  const context = shared.length
    ? `Browser profiles today: ${shared.map(p => `${p.name} (${p.browser}, ${ROLE_LABEL[roleOf(p)].toLowerCase()}) ${fmtDuration(p.totalMs)}`).join('; ')}. browsing_habits tells more.`
    : 'Browser profiles: none used today yet (browsing_habits tells the week).'
  const weekShared = w.profiles.filter(p => p.shared)
  const interests = topicWords([...weekShared.flatMap(p => p.youtube.map(y => y.title)), ...weekShared.flatMap(p => p.searches.map(s => s.term))], 10)
  const day = localDay(Date.now())
  const nudges = t.insights
    .filter(i => i.tone === 'warn' && i.profile && shared.some(p => p.key === i.profile))
    .map(i => ({ key: `${day}:${i.profile}:${i.kind ?? 'other'}`, title: i.title, detail: i.detail }))
  return { today: habitsForAtlas(t, v.workHours), week: habitsForAtlas(w, v.workHours), month: habitsForAtlas(m, v.workHours), context, interests, nudges }
}
