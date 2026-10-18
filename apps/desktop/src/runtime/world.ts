/**
 * The live world, runtime side. Every 15 minutes it fetches weather and air
 * quality for the owner's places (Open-Meteo), recent earthquakes (USGS) and
 * open natural events (NASA EONET); news for each place (GDELT) hourly,
 * politely spaced. All free, no keys. From that it raises proactive alerts
 * (a strong quake nearby, dangerous air, extreme weather, a fire or storm
 * close by), feeds the daily briefing, and answers the assistant's tools.
 */
import { randomUUID } from 'node:crypto'

import type { MemoryStore } from '@assistant/memory'
import type { Rule } from '@assistant/policy'
import type { AgendaEvent, EvidenceSource, RuntimeTool } from '@assistant/runtime'
import { DAY, HOUR, MINUTE } from '@assistant/shared'

import {
  aqiLevel,
  DISASTER_KIND,
  kmBetween,
  weatherSummary,
  type AirNow,
  type Disaster,
  type NaturalEvent,
  type NewsItem,
  type Place,
  type PlaceStatus,
  type Quake,
  type WeatherNow,
  type WorldOp,
  type WorldSnapshot,
} from '../shared/world.ts'

const PLACES_KEY = 'world.places'
const ALERTED_KEY = 'world.alerted'
const MAX_PLACES = 12
const REFRESH_MS = 15 * MINUTE
const NEWS_MS = HOUR
/** GDELT asks for at most one request every 5 seconds. */
const GDELT_GAP_MS = 6_000
const TIMEOUT_MS = 20_000
/** GDELT can take a while to answer. */
const NEWS_TIMEOUT_MS = 45_000

export const WORLD_RULES: Rule[] = [
  ...(['world_places', 'world_now'] as const).map((tool): Rule => ({ id: `default-${tool}`, tool, actionClass: 'observe', effect: 'allow' })),
  ...(['world_place_add', 'world_place_remove'] as const).map((tool): Rule => ({ id: `default-${tool}`, tool, actionClass: 'modify', effect: 'allow' })),
]

// ── parsers (pure, tested with fixtures) ─────────────────────────────

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

export const parseGeocode = (j: unknown): Omit<Place, 'id'> | null => {
  const r = (j as { results?: Record<string, unknown>[] })?.results?.[0]
  if (!r || typeof r.name !== 'string') return null
  return { name: r.name, country: typeof r.country === 'string' ? r.country : null, lat: num(r.latitude), lon: num(r.longitude), timezone: typeof r.timezone === 'string' ? r.timezone : null }
}

export const parseWeather = (j: unknown): WeatherNow | null => {
  const o = j as { current?: Record<string, unknown>; daily?: Record<string, unknown[]> }
  if (!o?.current) return null
  const c = o.current
  const d = o.daily ?? {}
  const dates = (d.time as string[] | undefined) ?? []
  return {
    temp: num(c.temperature_2m),
    feels: num(c.apparent_temperature),
    humidity: num(c.relative_humidity_2m),
    wind: num(c.wind_speed_10m),
    gusts: num(c.wind_gusts_10m),
    code: num(c.weather_code),
    summary: weatherSummary(num(c.weather_code)),
    days: dates.map((date, i) => ({
      date,
      max: num(d.temperature_2m_max?.[i]),
      min: num(d.temperature_2m_min?.[i]),
      rain: num(d.precipitation_sum?.[i]),
      gusts: num(d.wind_gusts_10m_max?.[i]),
      code: num(d.weather_code?.[i]),
      summary: weatherSummary(num(d.weather_code?.[i])),
    })),
  }
}

export const parseAir = (j: unknown): AirNow | null => {
  const c = (j as { current?: Record<string, unknown> })?.current
  if (!c || typeof c.us_aqi !== 'number') return null
  // The US AQI scale ends at 500; desert dust can push the model's estimate far past it.
  return { aqi: Math.min(500, Math.round(c.us_aqi)), pm25: num(c.pm2_5), pm10: num(c.pm10), level: aqiLevel(c.us_aqi) }
}

export const parseQuakes = (j: unknown): Quake[] => {
  const feats = (j as { features?: { id: string; properties: Record<string, unknown>; geometry: { coordinates: number[] } }[] })?.features ?? []
  return feats
    .filter(f => typeof f?.properties?.mag === 'number' && Array.isArray(f.geometry?.coordinates))
    .map(f => ({
      id: String(f.id),
      mag: num(f.properties.mag),
      place: String(f.properties.place ?? ''),
      time: num(f.properties.time),
      lon: num(f.geometry.coordinates[0]),
      lat: num(f.geometry.coordinates[1]),
      depthKm: num(f.geometry.coordinates[2]),
      url: String(f.properties.url ?? ''),
      tsunami: f.properties.tsunami === 1,
    }))
}

export const parseEvents = (j: unknown): NaturalEvent[] => {
  const events = (j as { events?: Record<string, unknown>[] })?.events ?? []
  const out: NaturalEvent[] = []
  for (const e of events) {
    const geo = (e.geometry as { date: string; type: string; coordinates: unknown }[] | undefined) ?? []
    const last = [...geo].reverse().find(g => g.type === 'Point' && Array.isArray(g.coordinates))
    if (!last) continue
    const [lon, lat] = last.coordinates as number[]
    const cat = (e.categories as { id: string; title: string }[] | undefined)?.[0]
    out.push({ id: String(e.id), title: String(e.title ?? ''), category: cat?.title ?? 'Event', time: Date.parse(last.date) || 0, lat: num(lat), lon: num(lon), url: String(e.link ?? '') })
  }
  return out
}

const ALERT_RANK = { Red: 0, Orange: 1, Green: 2 } as const

/** GDACS current alerts (EVENTS4APP GeoJSON): points only, red first, then newest. */
export const parseGdacs = (j: unknown): Disaster[] => {
  const features = (j as { features?: { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> }[] })?.features ?? []
  const out: Disaster[] = []
  for (const f of features) {
    const p = f.properties ?? {}
    if (f.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates) || String(p.iscurrent) !== 'true') continue
    const [lon, lat] = f.geometry.coordinates as number[]
    const alert = p.alertlevel === 'Red' || p.alertlevel === 'Orange' ? p.alertlevel : 'Green'
    const type = String(p.eventtype ?? '')
    const report = (p.url as { report?: unknown } | undefined)?.report
    const sev = String((p.severitydata as { severitytext?: unknown } | undefined)?.severitytext ?? '')
    out.push({
      id: `${type}-${String(p.eventid ?? '')}`,
      type,
      kind: DISASTER_KIND[type] ?? 'Disaster',
      name: String(p.name ?? DISASTER_KIND[type] ?? 'Disaster'),
      alert,
      country: String(p.country ?? ''),
      // "Hurricane/Typhoon > 74 mph (maximum wind speed of 194 km/h)" → the part in brackets reads best.
      severity: /\(([^)]+)\)/.exec(sev)?.[1] ?? sev,
      from: Date.parse(`${String(p.fromdate ?? '')}Z`) || 0,
      to: Date.parse(`${String(p.todate ?? '')}Z`) || 0,
      lat: num(lat),
      lon: num(lon),
      url: typeof report === 'string' && report.startsWith('https://') ? report : '',
    })
  }
  return out.sort((a, b) => ALERT_RANK[a.alert] - ALERT_RANK[b.alert] || b.to - a.to)
}

export const parseNews = (j: unknown): NewsItem[] => {
  const arts = (j as { articles?: Record<string, unknown>[] })?.articles ?? []
  const seen = (s: string) => {
    // GDELT dates look like 20261018T113000Z.
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s)
    return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : 0
  }
  const titles = new Set<string>()
  return arts
    .filter(a => typeof a.title === 'string' && typeof a.url === 'string' && /^https:\/\//.test(a.url))
    .map(a => ({ title: String(a.title).trim(), url: String(a.url), domain: String(a.domain ?? ''), time: seen(String(a.seendate ?? '')), language: String(a.language ?? '') }))
    .filter(a => !titles.has(a.title.toLowerCase()) && titles.add(a.title.toLowerCase()))
    .slice(0, 8)
}

// ── alert rules ──────────────────────────────────────────────────────

/** A quake worth interrupting for: strong and near, or felt-strong and very near. */
export const quakeMatters = (q: Quake, km: number) => (q.mag >= 4.5 && km <= 400) || (q.mag >= 3.5 && km <= 100) || (q.mag >= 6.5 && km <= 1000)
const EVENT_RADIUS: Record<string, number> = { 'Severe Storms': 500, Wildfires: 150, Volcanoes: 200, Floods: 200 }
/** How far an orange or red GDACS alert reaches a watched place, by type. */
export const DISASTER_RADIUS: Record<string, number> = { TC: 800, FL: 300, VO: 300, DR: 500, WF: 150 }

// ── the watch ────────────────────────────────────────────────────────

export class WorldWatch {
  private quakes: Quake[] = []
  private events: NaturalEvent[] = []
  private disasters: Disaster[] = []
  private weather = new Map<string, WeatherNow>()
  private air = new Map<string, AirNow>()
  private news = new Map<string, { items: NewsItem[]; at: number }>()
  private updatedAt: number | null = null
  private problems: string[] = []
  private refreshing: Promise<void> | null = null
  private again: { force: boolean } | null = null
  /** GDELT said “too many requests”: leave it alone for a while. */
  private gdeltPausedUntil = 0
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly deps: {
      memory: MemoryStore
      now: () => number
      fetchJson?: (url: string) => Promise<unknown>
      /** Headlines from the owner's own feeds that mention a place: free, and there when GDELT is busy. */
      localNews?: (place: string) => NewsItem[]
      /** Sends the latest snapshot to main (World page). */
      publish?: (s: WorldSnapshot) => void
      log?: (level: 'info' | 'warn', message: string) => void
      sleep?: (ms: number) => Promise<void>
    },
  ) {}

  private async get(url: string, timeoutMs = TIMEOUT_MS): Promise<unknown> {
    if (this.deps.fetchJson) return this.deps.fetchJson(url)
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Atlas personal assistant (open source)' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(text.slice(0, 80) || 'not JSON')
    }
  }

  start() {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  places(): Place[] {
    try {
      const raw = JSON.parse(this.deps.memory.getSetting(PLACES_KEY) ?? '[]') as Place[]
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  private savePlaces(p: Place[]) {
    this.deps.memory.setSetting(PLACES_KEY, JSON.stringify(p.slice(0, MAX_PLACES)))
  }

  /** A place name to coordinates (Open-Meteo), for flying the map somewhere; nothing is saved. */
  async geocode(name: string): Promise<Omit<Place, 'id'> | null> {
    const q = name.trim()
    if (!q || q.length > 80) return null
    return parseGeocode(await this.get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`))
  }

  async addPlace(name: string): Promise<Place> {
    const q = name.trim()
    if (!q || q.length > 80) throw new Error('Which place?')
    const places = this.places()
    if (places.length >= MAX_PLACES) throw new Error(`At most ${MAX_PLACES} places; remove one first.`)
    const found = parseGeocode(await this.get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`))
    if (!found) throw new Error(`Could not find a place called "${q}".`)
    const existing = places.find(p => kmBetween(p, found) < 5)
    if (existing) return existing
    const place: Place = { id: randomUUID().slice(0, 8), ...found }
    this.savePlaces([...places, place])
    void this.refresh(true)
    return place
  }

  removePlace(idOrName: string): Place | null {
    const places = this.places()
    const n = idOrName.trim().toLowerCase()
    const hit = places.find(p => p.id === idOrName || p.name.toLowerCase() === n)
    if (!hit) return null
    this.savePlaces(places.filter(p => p.id !== hit.id))
    this.weather.delete(hit.id)
    this.air.delete(hit.id)
    this.news.delete(hit.id)
    this.deps.publish?.(this.snapshot())
    return hit
  }

  /**
   * One refresh at a time; news only when an hour old (or forced). Asked
   * again while one runs (a place was just added), one more run follows.
   */
  refresh(forceNews = false): Promise<void> {
    if (this.refreshing) {
      this.again = { force: (this.again?.force ?? false) || forceNews }
      return this.refreshing.then(() => this.refreshing ?? undefined)
    }
    this.refreshing = this.doRefresh(forceNews).finally(() => {
      this.refreshing = null
      const next = this.again
      this.again = null
      if (next) void this.refresh(next.force)
    })
    return this.refreshing
  }

  private async doRefresh(forceNews: boolean) {
    const problems: string[] = []
    const places = this.places()
    const attempt = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (e) {
        problems.push(`${what}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await Promise.all([
      attempt('earthquakes (USGS)', async () => {
        this.quakes = parseQuakes(await this.get('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'))
      }),
      attempt('disaster alerts (GDACS)', async () => {
        this.disasters = parseGdacs(await this.get('https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP'))
      }),
      attempt('natural events (NASA EONET)', async () => {
        this.events = parseEvents(await this.get('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=10'))
      }),
      ...places.map(p =>
        attempt(`weather for ${p.name}`, async () => {
          const w = parseWeather(
            await this.get(
              `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_gusts_10m_max,weather_code&timezone=auto&forecast_days=2`,
            ),
          )
          if (w) this.weather.set(p.id, w)
        }),
      ),
      ...places.map(p =>
        attempt(`air quality for ${p.name}`, async () => {
          const a = parseAir(await this.get(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${p.lat}&longitude=${p.lon}&current=us_aqi,pm2_5,pm10&timezone=auto`))
          if (a) this.air.set(p.id, a)
        }),
      ),
    ])
    this.updatedAt = this.deps.now()
    this.problems = problems
    this.deps.publish?.(this.snapshot())
    // News last and slowly: GDELT wants a gap between requests.
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
    let first = true
    for (const p of places) {
      const old = this.news.get(p.id)
      if (!forceNews && old && this.deps.now() - old.at < NEWS_MS) continue
      if (this.deps.now() < this.gdeltPausedUntil) {
        problems.push('news (GDELT): busy, trying again later')
        break
      }
      if (!first) await sleep(GDELT_GAP_MS)
      first = false
      await attempt(`news for ${p.name}`, async () => {
        const items = parseNews(await this.get(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${p.name}"`)}&mode=ArtList&maxrecords=15&timespan=1d&format=json&sort=DateDesc`, NEWS_TIMEOUT_MS))
        this.news.set(p.id, { items, at: this.deps.now() })
      }).then(() => {
        if (problems.some(x => x.startsWith(`news for ${p.name}`) && /429|limit requests/i.test(x))) this.gdeltPausedUntil = this.deps.now() + 30 * MINUTE
      })
    }
    this.problems = problems
    if (problems.length) this.deps.log?.('warn', `World: ${problems.join('; ')}`)
    this.deps.publish?.(this.snapshot())
  }

  private nearbyOf(p: Place): PlaceStatus['nearby'] {
    const out: PlaceStatus['nearby'] = []
    for (const q of this.quakes) {
      const km = kmBetween(p, q)
      if (km <= 1000 && q.mag >= 3) out.push({ kind: 'quake', id: q.id, title: `M${q.mag.toFixed(1)} earthquake, ${q.place}`, km: Math.round(km), time: q.time })
    }
    for (const e of this.events) {
      const km = kmBetween(p, e)
      if (km <= (EVENT_RADIUS[e.category] ?? 200) * 2) out.push({ kind: 'event', id: e.id, title: `${e.category}: ${e.title}`, km: Math.round(km), time: e.time })
    }
    for (const d of this.disasters) {
      if (d.alert === 'Green' || d.type === 'EQ') continue
      const km = kmBetween(p, d)
      if (km <= (DISASTER_RADIUS[d.type] ?? 300) * 2) out.push({ kind: 'event', id: d.id, title: `GDACS ${d.alert.toLowerCase()} alert: ${d.name}`, km: Math.round(km), time: d.to })
    }
    return out.sort((a, b) => a.km - b.km).slice(0, 8)
  }

  /** GDELT's headlines plus the owner's own feeds that mention the place, newest first, no repeats. */
  private newsFor(p: Place): NewsItem[] {
    const all = [...(this.news.get(p.id)?.items ?? []), ...(this.deps.localNews?.(p.name) ?? [])]
    const seen = new Set<string>()
    return all
      .filter(n => !seen.has(n.title.toLowerCase()) && seen.add(n.title.toLowerCase()))
      .sort((a, b) => b.time - a.time)
      .slice(0, 8)
  }

  snapshot(): WorldSnapshot {
    return {
      places: this.places().map(p => ({ place: p, weather: this.weather.get(p.id) ?? null, air: this.air.get(p.id) ?? null, news: this.newsFor(p), nearby: this.nearbyOf(p) })),
      quakes: this.quakes.filter(q => q.mag >= 4).slice(0, 200),
      events: this.events.slice(0, 300),
      disasters: this.disasters.slice(0, 300),
      updatedAt: this.updatedAt,
      problems: this.problems,
    }
  }

  /** A place in words, for the assistant. */
  describe(s: PlaceStatus, withNews = true): string {
    const w = s.weather
    const lines = [
      `${s.place.name}${s.place.country ? `, ${s.place.country}` : ''}:`,
      w ? `  Weather now ${Math.round(w.temp)}°C (feels ${Math.round(w.feels)}), ${w.summary.toLowerCase()}, wind ${Math.round(w.wind)} km/h.` : '  Weather: not loaded yet.',
      ...(w?.days ?? []).map((d, i) => `  ${i === 0 ? 'Today' : 'Tomorrow'}: ${Math.round(d.min)}–${Math.round(d.max)}°C, ${d.summary.toLowerCase()}${d.rain ? `, ${d.rain} mm rain` : ''}${d.gusts >= 50 ? `, gusts ${Math.round(d.gusts)} km/h` : ''}.`),
      s.air ? `  Air quality: US AQI ${s.air.aqi} (${s.air.level}), PM2.5 ${s.air.pm25} µg/m³.` : '',
      ...s.nearby.slice(0, 4).map(n => `  Nearby: ${n.title}, ${n.km} km away.`),
      ...(withNews ? s.news.slice(0, 5).map(n => `  News: ${n.title} (${n.domain})`) : []),
    ]
    return lines.filter(Boolean).join('\n')
  }

  private alerted(): Record<string, number> {
    try {
      return JSON.parse(this.deps.memory.getSetting(ALERTED_KEY) ?? '{}') as Record<string, number>
    } catch {
      return {}
    }
  }

  /**
   * Things worth saying without being asked, each once: a strong quake near a
   * place, a fire/storm/volcano/flood close by, dangerous air, extreme weather.
   * They go through the normal attention rules (quiet hours, focus, budget).
   */
  agenda(now: number): (AgendaEvent & { priority: number })[] {
    const seen = this.alerted()
    const items: (AgendaEvent & { priority: number })[] = []
    const add = (key: string, title: string, instruction: string, evidence: string, priority: number) => {
      if (seen[key]) return
      seen[key] = now
      items.push({ type: 'agenda', at: now, key: `world:${key}`, kind: 'nudge', title, instruction, evidence, expectsAnswer: false, priority })
    }
    for (const p of this.places()) {
      for (const q of this.quakes) {
        const km = kmBetween(p, q)
        if (now - q.time > 6 * HOUR || !quakeMatters(q, km)) continue
        add(
          `quake:${q.id}:${p.id}`,
          `Earthquake near ${p.name}`,
          `A magnitude ${q.mag.toFixed(1)} earthquake struck ${q.place}, about ${Math.round(km)} km from ${p.name}, ${Math.round((now - q.time) / MINUTE)} minutes ago (USGS)${q.tsunami ? ', with a tsunami flag' : ''}. Tell the owner calmly in one or two sentences; if ${p.name} is where they or their people are, suggest checking in.`,
          `USGS: M${q.mag.toFixed(1)}, ${Math.round(km)} km from ${p.name}.`,
          75,
        )
      }
      for (const e of this.events) {
        const km = kmBetween(p, e)
        if (now - e.time > 2 * DAY || km > (EVENT_RADIUS[e.category] ?? 0)) continue
        add(`event:${e.id}:${p.id}`, `${e.category} near ${p.name}`, `NASA EONET reports "${e.title}" (${e.category}) about ${Math.round(km)} km from ${p.name}. Tell the owner in one sentence and offer more detail.`, `EONET: ${e.title}, ${Math.round(km)} km.`, 55)
      }
      for (const d of this.disasters) {
        // Earthquakes come from USGS above; green alerts are routine.
        if (d.alert === 'Green' || d.type === 'EQ') continue
        const km = kmBetween(p, d)
        if (km > (DISASTER_RADIUS[d.type] ?? 300)) continue
        add(
          `disaster:${d.id}:${d.alert}:${p.id}`,
          `${d.kind} near ${p.name}`,
          `GDACS (the UN/EC disaster alert system) has a ${d.alert.toLowerCase()} alert for ${d.name}${d.country ? ` (${d.country})` : ''}, about ${Math.round(km)} km from ${p.name}${d.severity ? `: ${d.severity}` : ''}. Tell the owner calmly in one or two sentences; if it is a cyclone or flood heading their way, suggest checking local advice. Offer to show it on the World map.`,
          `GDACS ${d.alert}: ${d.name}, ${Math.round(km)} km from ${p.name}.`,
          d.alert === 'Red' ? 80 : 60,
        )
      }
      const a = this.air.get(p.id)
      const today = new Date(now).toISOString().slice(0, 10)
      if (a && a.aqi >= 200) {
        add(`air:${p.id}:${today}`, `Bad air in ${p.name}`, `Air quality in ${p.name} is US AQI ${a.aqi} (${a.level}). Tell the owner in one sentence and suggest a mask or staying indoors if they are there.`, `Open-Meteo: AQI ${a.aqi} in ${p.name}.`, 45)
      }
      const w = this.weather.get(p.id)
      for (const d of w?.days ?? []) {
        const extreme = [d.max >= 43 ? `up to ${Math.round(d.max)}°C` : '', d.rain >= 30 ? `${Math.round(d.rain)} mm of rain` : '', d.gusts >= 70 ? `gusts of ${Math.round(d.gusts)} km/h` : ''].filter(Boolean)
        if (!extreme.length) continue
        add(`weather:${p.id}:${d.date}`, `Extreme weather in ${p.name}`, `The forecast for ${p.name} on ${d.date} shows ${extreme.join(' and ')}. Tell the owner in one sentence, practically.`, `Open-Meteo: ${extreme.join(', ')} in ${p.name} on ${d.date}.`, 40)
      }
    }
    if (items.length) {
      // Old marks fade after two weeks.
      for (const [k, t] of Object.entries(seen)) if (now - t > 14 * DAY) delete seen[k]
      this.deps.memory.setSetting(ALERTED_KEY, JSON.stringify(seen))
    }
    return items
  }

  briefingSource(): EvidenceSource {
    return {
      id: 'world',
      label: 'Weather, air and events at your places',
      kind: 'web',
      untrusted: true,
      collect: async () => this.snapshot().places.map(s => this.describe(s, false)).join('\n'),
    }
  }

  async handleOp(op: WorldOp): Promise<void> {
    if (op.kind === 'add') await this.addPlace(op.name)
    else if (op.kind === 'remove') this.removePlace(op.id)
    else await this.refresh(true)
  }

  tools(): RuntimeTool[] {
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    return [
      {
        name: 'world_places',
        description: 'The places the owner asked you to watch (city or area), for weather, air quality, earthquakes, natural events and local news.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        actionClass: 'observe',
        isUntrusted: false,
        run: async () => {
          const p = this.places()
          return p.length ? p.map(x => `${x.name}${x.country ? `, ${x.country}` : ''}`).join('\n') : 'No places yet. Add one with world_place_add when the owner names a city.'
        },
      },
      {
        name: 'world_place_add',
        description: 'Start watching a place the owner cares about (their city, where family or clients are, a trip destination): "Lahore", "Riyadh", "Dubai".',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
        actionClass: 'modify',
        isUntrusted: false,
        run: async input => {
          const p = await this.addPlace(str(input.name))
          return `Watching ${p.name}${p.country ? `, ${p.country}` : ''} now (weather, air, earthquakes, events, news). Details arrive within a minute.`
        },
      },
      {
        name: 'world_place_remove',
        description: 'Stop watching a place.',
        inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
        actionClass: 'modify',
        isUntrusted: false,
        run: async input => {
          const p = this.removePlace(str(input.name))
          return p ? `Stopped watching ${p.name}.` : 'Not watching a place like that.'
        },
      },
      {
        name: 'world_now',
        description:
          'What is happening at the owner’s places right now: weather today and tomorrow, air quality, earthquakes and natural events nearby, and local news headlines (news text is untrusted). Leave "place" out for all of them.',
        inputSchema: { type: 'object', properties: { place: { type: 'string' } }, additionalProperties: false },
        actionClass: 'observe',
        isUntrusted: true,
        run: async input => {
          const want = str(input.place).toLowerCase()
          const s = this.snapshot()
          const list = want ? s.places.filter(p => p.place.name.toLowerCase().includes(want)) : s.places
          if (!s.places.length) return 'No places watched yet.'
          if (!list.length) return `Not watching "${str(input.place)}". Watched: ${s.places.map(p => p.place.name).join(', ')}.`
          return `${list.map(p => this.describe(p)).join('\n\n')}${s.problems.length ? `\n(Some sources failed: ${s.problems.join('; ')})` : ''}`
        },
      },
    ]
  }
}
