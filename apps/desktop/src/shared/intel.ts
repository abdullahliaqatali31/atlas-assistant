/**
 * Intelligence for the World page (after Argos): conflict events from the
 * GDELT 2.0 event feed (every 15 minutes, keyless), filtered hard because
 * GDELT tags plenty of crime and court news as "violence"; categorised
 * (drones, missiles, airstrikes, ground fighting, protest) from the source
 * article's own words; severity from how widely it is reported. Plus
 * Ukraine's live air-raid alerts (siren.pp.ua), rolled up to oblasts for
 * highlighting. Titles come from the article's address: GDELT has none.
 */

export const INTEL_CATEGORIES = ['drones', 'missiles', 'airstrikes', 'ground', 'protest', 'other'] as const
export type IntelCategory = (typeof INTEL_CATEGORIES)[number]

export const CATEGORY_LABEL: Record<IntelCategory, string> = { drones: 'Drones', missiles: 'Missiles', airstrikes: 'Airstrikes', ground: 'Ground', protest: 'Protest', other: 'Other' }
export const CATEGORY_COLOR: Record<IntelCategory, string> = { drones: '#f97316', missiles: '#ef4444', airstrikes: '#e11d48', ground: '#f59e0b', protest: '#a78bfa', other: '#94a3b8' }

export interface IntelEvent {
  id: string
  title: string
  url: string
  /** The outlet's domain. */
  source: string
  /** When GDELT saw it, epoch ms. */
  at: number
  lat: number
  lon: number
  place: string
  /** ISO 3166-1 alpha-2, '' when unknown. */
  country: string
  countryName: string
  category: IntelCategory
  /** 1 (minor) to 4 (major), from how many sources report it. */
  severity: 1 | 2 | 3 | 4
  mentions: number
}

const CRIME = /police|court|bail|sexual|rape|murder|stabb|robber|domestic|teacher|struck-by-car|car-crash|crash|arrest|sentenc|trial|jail|prison|inquest|lawsuit|footballer|\bnfl\b|\bnba\b|soccer|cricket|dog|zoo|wildlife|hunting|shooting-range|gun-shop|burglar|theft|fraud|drunk|sheriff|deputy|pedestrian|driver|\bsuv\b|teen|daughter|students?|campus|scotus|supreme-court|epstein|heckler|lapd|nypd/
const DRONES = /\bdrones?\b|\buavs?\b|shahed|quadcopter|kamikaze|loitering/
const MISSILES = /missiles?|ballistic|\brockets?\b|cruise|iskander|kinzhal|interceptors?|air-defen[cs]e|iron-dome/
const AIRSTRIKES = /air-?strikes?|airstrikes?|bomb(s|ing|ed|ard\w*)?\b|warplanes?|fighter-jets?|air-raids?/
const GROUND = /troops|offensive|front-?lines?|fighting|clash(es)?|artiller\w*|shell(s|ing|ed)?\b|soldiers|\barmy\b|militants?|insurgents?|rebels?|\btanks?\b|ambush|incursion|counter-?offensive|siege|frontline|brigade|battalion/
// Only words that mean armed conflict on their own ("attack", "killed", "blast" alone are mostly crime and accidents).
const WAR = /\bwar\b|military|invasion|ceasefire|hostages?|terror\w*|gunmen|militia|hamas|hezbollah|houthis?|\bidf\b|kremlin|\bnato\b|occupied|annex\w*|genocide|massacre|insurgen\w*|jihad\w*|al-shabaab|\bisis\b|wagner|warlord|junta|coup/
const PROTEST = /protests?|protesters|demonstrators|demonstrations|rioters|marchers|march-against|walkout|tear-gas|crackdown/

/** The article's address as words, for the filters and the title. */
const slugWords = (url: string) => {
  try {
    const u = new URL(url)
    return decodeURIComponent(u.pathname).toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[_/]+/g, '-')
  } catch {
    return ''
  }
}

/** Is it about conflict, and which kind? null: not conflict (crime, sport, courts…). */
export const classify = (url: string, rootCode: string): IntelCategory | null => {
  const w = slugWords(url)
  if (!w || CRIME.test(w)) return null
  if (rootCode === '14') return PROTEST.test(w) ? 'protest' : null
  if (DRONES.test(w)) return 'drones'
  if (MISSILES.test(w)) return 'missiles'
  if (AIRSTRIKES.test(w)) return 'airstrikes'
  if (GROUND.test(w)) return 'ground'
  if (WAR.test(w)) return 'other'
  return null
}

/** "russia-strikes-28-energy-facilities-ukraine" → "Russia strikes 28 energy facilities ukraine". */
export const titleFromUrl = (url: string): string => {
  let path = ''
  try {
    path = decodeURIComponent(new URL(url).pathname)
  } catch {
    return ''
  }
  const segs = path
    .split('/')
    .map(s => s.replace(/\.[a-z0-9]{2,5}$/i, ''))
    .filter(s => /[a-z]/i.test(s) && s.split(/[-_]/).filter(w => /[a-z]{2,}/i.test(w)).length >= 3)
  const best = segs.sort((a, b) => b.length - a.length)[0]
  if (!best) return ''
  const words = best
    .split(/[-_]+/)
    .filter(w => w && !/^[0-9a-f]{8,}$/i.test(w) && !/^\d{5,}$/.test(w))
    .slice(0, 16)
  const t = words.join(' ').trim()
  return t ? t[0]!.toUpperCase() + t.slice(1) : ''
}

export const severityOf = (mentions: number): 1 | 2 | 3 | 4 => (mentions >= 20 ? 4 : mentions >= 8 ? 3 : mentions >= 3 ? 2 : 1)

/** "20261020014500" → epoch ms (UTC). */
const gdeltTime = (s: string) => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s)
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : NaN
}

/**
 * One 15-minute GDELT 2.0 events export (tab-separated, 61 columns) into
 * conflict events, one per article (the most-mentioned row wins). FIPS
 * country codes become ISO through `countries`.
 */
export const parseGdeltExport = (tsv: string, countries: ReadonlyMap<string, { iso: string; name: string }>): IntelEvent[] => {
  const byUrl = new Map<string, IntelEvent>()
  for (const line of tsv.split('\n')) {
    const c = line.split('\t')
    if (c.length < 61) continue
    const root = c[28]!
    if (!['14', '18', '19', '20'].includes(root)) continue
    const url = c[60]!.trim()
    if (!/^https?:\/\//.test(url)) continue
    const category = classify(url, root)
    if (!category) continue
    const lat = Number(c[56])
    const lon = Number(c[57])
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue
    const mentions = Number(c[31]) || 1
    const prev = byUrl.get(url)
    if (prev && prev.mentions >= mentions) continue
    const fips = c[53]!
    const country = countries.get(fips)
    let source = ''
    try {
      source = new URL(url).hostname.replace(/^www\./, '')
    } catch {
      continue
    }
    byUrl.set(url, {
      id: c[0]!,
      title: titleFromUrl(url) || source,
      url,
      source,
      at: gdeltTime(c[59]!) || Date.now(),
      lat,
      lon,
      place: c[52]!,
      country: country?.iso ?? '',
      countryName: country?.name ?? '',
      category,
      severity: severityOf(mentions),
      mentions,
    })
  }
  return [...byUrl.values()]
}

/** "Where most is happening now": events per country, most first, with their categories. */
export const countryStats = (events: readonly IntelEvent[]) => {
  const out = new Map<string, { iso: string; name: string; count: number; byCategory: Partial<Record<IntelCategory, number>> }>()
  for (const e of events) {
    if (!e.country) continue
    const s = out.get(e.country) ?? { iso: e.country, name: e.countryName, count: 0, byCategory: {} }
    s.count++
    s.byCategory[e.category] = (s.byCategory[e.category] ?? 0) + 1
    out.set(e.country, s)
  }
  return [...out.values()].sort((a, b) => b.count - a.count)
}

// ── Ukraine's air-raid alerts ──

/** siren.pp.ua names oblasts in Ukrainian; the boundaries (geoBoundaries) in English. */
export const UA_OBLASTS: Record<string, string> = {
  Вінницька: 'Vinnytsia Oblast',
  Волинська: 'Volyn Oblast',
  Дніпропетровська: 'Dnipropetrovsk Oblast',
  Донецька: 'Donetsk Oblast',
  Житомирська: 'Zhytomyr Oblast',
  Закарпатська: 'Zakarpattia Oblast',
  Запорізька: 'Zaporizhia Oblast',
  'Івано-Франківська': 'Ivano-Frankivsk Oblast',
  Київська: 'Kyiv Oblast',
  Кіровоградська: 'Kirovohrad Oblast',
  Луганська: 'Luhansk Oblast',
  Львівська: 'Lviv Oblast',
  Миколаївська: 'Mykolaiv Oblast',
  Одеська: 'Odessa Oblast',
  Полтавська: 'Poltava Oblast',
  Рівненська: 'Rivne Oblast',
  Сумська: 'Sumy Oblast',
  Тернопільська: 'Ternopil Oblast',
  Харківська: 'Kharkiv Oblast',
  Херсонська: 'Kherson Oblast',
  Хмельницька: 'Khmelnytskyi Oblast',
  Черкаська: 'Cherkasy Oblast',
  Чернівецька: 'Chernivtsi Oblast',
  Чернігівська: 'Chernihiv Oblast',
  'м. Київ': 'Kyiv',
  'Автономна Республіка Крим': 'Autonomous Republic of Crimea',
}

/** The boundary name for a siren.pp.ua state name ("Харківська область", "м. Київ"). */
export const oblastName = (ua: string): string | null => {
  const t = ua.trim()
  if (UA_OBLASTS[t]) return UA_OBLASTS[t]!
  const stem = t.replace(/\s+область$/, '')
  return UA_OBLASTS[stem] ?? null
}

export interface AlertRegion {
  /** Boundary name (geoBoundaries shapeName). */
  name: string
  /** full: the whole oblast; partial: some districts or communities. */
  level: 'full' | 'partial'
  since: number
  /** How many districts or communities are under alert, for partial. */
  parts: number
}

/**
 * Live alerts (any level) rolled up to their oblast through the region tree:
 * an alert on the oblast itself makes it "full", otherwise "partial".
 */
export const rollUpAlerts = (alerts: unknown, regions: unknown): AlertRegion[] => {
  const states = (regions as { states?: unknown[] })?.states
  const stateOf = new Map<string, { id: string; name: string }>()
  const walk = (node: Record<string, unknown>, state: { id: string; name: string }) => {
    stateOf.set(String(node.regionId), state)
    for (const ch of Array.isArray(node.regionChildIds) ? node.regionChildIds : []) walk(ch as Record<string, unknown>, state)
  }
  for (const s of Array.isArray(states) ? states : []) {
    const node = s as Record<string, unknown>
    walk(node, { id: String(node.regionId), name: String(node.regionName ?? '') })
  }
  const out = new Map<string, AlertRegion>()
  for (const a of Array.isArray(alerts) ? alerts : []) {
    const r = a as Record<string, unknown>
    const active = Array.isArray(r.activeAlerts) ? r.activeAlerts : []
    if (!active.length) continue
    const state = stateOf.get(String(r.regionId))
    const name = state ? oblastName(state.name) : null
    if (!name) continue
    const since = Date.parse(String(r.lastUpdate ?? '')) || Date.now()
    const full = r.regionType === 'State'
    const prev = out.get(name)
    out.set(name, { name, level: full || prev?.level === 'full' ? 'full' : 'partial', since: Math.min(prev?.since ?? since, since), parts: (prev?.parts ?? 0) + (full ? 0 : 1) })
  }
  return [...out.values()]
}
