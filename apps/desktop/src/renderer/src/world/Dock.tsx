/**
 * The World page's dock (after Argos): Intelligence, Markets, VIP people and
 * Geography, as buttons in the map's toolbar (flat map and 3D view alike)
 * and one panel at a time, docked on the right so the item card keeps the
 * left. Each panel reads main's keyless feeds; the map shows what it can.
 */
import { Briefcase, Globe2, Search, Shield, Star, Video, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { CATEGORY_COLOR, CATEGORY_LABEL, INTEL_CATEGORIES, type AlertRegion, type IntelCategory, type IntelEvent } from '../../../shared/intel.ts'
import { GROUP_LABEL, MARKET_GROUPS, sparkPath, type MarketGroup, type Quote } from '../../../shared/markets.ts'
import { kmBetween, type Camera, type CountryCard, type WorldSnapshot } from '../../../shared/world.ts'
import type { Selected } from './Inspector.tsx'
import { cameraFeatures } from './geo.ts'
import { VIP_CATEGORIES, VIP_LABEL, type RichPerson, type VipCategory, type VipFlying } from '../../../shared/vip.ts'
import { MAP3D_EVENT } from './mapops.ts'
import { initialsOf, RemoteImg } from './RemoteImg.tsx'

export type DockId = 'intel' | 'cams' | 'markets' | 'vip' | 'geo'

export const DOCK: { id: DockId; label: string; icon: typeof Shield; key: string; color: string }[] = [
  { id: 'intel', label: 'Intelligence', icon: Shield, key: 'i', color: '#f59e0b' },
  { id: 'cams', label: 'Cameras', icon: Video, key: 'j', color: '#38bdf8' },
  { id: 'markets', label: 'Markets', icon: Briefcase, key: 'k', color: '#eab308' },
  { id: 'vip', label: 'VIP people', icon: Star, key: 'v', color: '#facc15' },
  { id: 'geo', label: 'Geography', icon: Globe2, key: 'z', color: '#22c55e' },
]

/** What a panel can do with the map it sits on. */
export interface DockContext {
  /** Fly the map (flat or 3D) to a point. */
  flyTo: (lat: number, lon: number, zoom: number) => void
  /** Is a point on screen now (for "only what the map shows")? */
  inView: (lat: number, lon: number) => boolean
  /** Intelligence on the map: events, the country shading and alert regions. */
  intelOnMap: boolean
  setIntelOnMap: (on: boolean) => void
  /** Events and alerts as the panel loaded them, shared with the map layers. */
  onIntel: (events: IntelEvent[], alerts: AlertRegion[]) => void
  /** The events loaded so far (for Geography's activity), if the Intelligence panel has run. */
  intelEvents: IntelEvent[] | null
  /** Open an item's card (as a click on the map would). */
  select: (s: Selected) => void
  /** The live world: earthquakes and natural events, for "where something is happening". */
  world: WorldSnapshot
}

export function DockButtons({ open, onOpen, badge }: { open: DockId | null; onOpen: (id: DockId | null) => void; badge?: Partial<Record<DockId, string>> }) {
  return (
    <>
      {DOCK.map(d => {
        const Icon = d.icon
        return (
          <button key={d.id} type="button" onClick={() => onOpen(open === d.id ? null : d.id)} aria-pressed={open === d.id} aria-keyshortcuts={d.key.toUpperCase()} className={`map-chip px-2 ${open === d.id ? 'border-accent text-accent' : ''}`} title={`${d.label} (${d.key.toUpperCase()})`}>
            <Icon className="size-3.5" style={{ color: open === d.id ? undefined : d.color }} aria-hidden />
            <span className="hidden @[1400px]:inline">{d.label}</span>
            {badge?.[d.id] && <span className="font-mono text-[10px] text-muted">{badge[d.id]}</span>}
          </button>
        )
      })}
    </>
  )
}

const ago = (t: number) => {
  const m = Math.max(1, Math.round((Date.now() - t) / 60_000))
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`
}

const SEV_TONE = ['', 'bg-sky-500/80', 'bg-lime-400/80 text-black', 'bg-amber-400/90 text-black', 'bg-red-500/90']

function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, string][] }) {
  return (
    <div className="grid gap-1 rounded-lg border border-border p-0.5" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }} role="tablist">
      {items.map(([v, label]) => (
        <button key={v} type="button" role="tab" aria-selected={value === v} onClick={() => onChange(v)} className={`rounded-md px-2 py-1 text-xs ${value === v ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text'}`}>
          {label}
        </button>
      ))}
    </div>
  )
}

function IntelPanel({ ctx }: { ctx: DockContext }) {
  const [tab, setTab] = useState<'events' | 'overview' | 'alerts'>('events')
  const [hours, setHours] = useState(24)
  const [minSev, setMinSev] = useState(1)
  const [cat, setCat] = useState<IntelCategory | null>(null)
  const [query, setQuery] = useState('')
  const [onlyView, setOnlyView] = useState(false)
  const [events, setEvents] = useState<IntelEvent[] | null>(null)
  const [alerts, setAlerts] = useState<AlertRegion[]>([])
  const [error, setError] = useState('')
  // A day of events (the feed keeps one), refreshed every five minutes; alerts every minute.
  useEffect(() => {
    let gone = false
    const load = () =>
      void window.world.intelEvents(24).then(
        e => !gone && (setEvents(e), setError('')),
        err => !gone && setError(err instanceof Error ? err.message : 'The feed is unavailable right now.'),
      )
    const loadAlerts = () =>
      void window.world.intelAlerts().then(
        a => !gone && setAlerts(a),
        () => undefined,
      )
    load()
    loadAlerts()
    const t1 = setInterval(load, 5 * 60_000)
    const t2 = setInterval(loadAlerts, 60_000)
    return () => {
      gone = true
      clearInterval(t1)
      clearInterval(t2)
    }
  }, [])
  useEffect(() => {
    if (events) ctx.onIntel(events, alerts)
    // The map follows what the panel loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, alerts])
  const cut = Date.now() - hours * 3600_000
  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () => (events ?? []).filter(e => e.at >= cut && e.severity >= minSev && (!cat || e.category === cat) && (!q || `${e.title} ${e.place} ${e.countryName} ${e.source}`.toLowerCase().includes(q)) && (!onlyView || ctx.inView(e.lat, e.lon))),
    // ctx.inView reads the live map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, cut, minSev, cat, q, onlyView],
  )
  const ranking = useMemo(() => {
    const m = new Map<string, { name: string; iso: string; count: number; lat: number; lon: number; by: Partial<Record<IntelCategory, number>> }>()
    for (const e of shown) {
      const k = e.country || e.countryName || e.place.split(',').pop()!.trim()
      const s = m.get(k) ?? { name: e.countryName || k, iso: e.country, count: 0, lat: 0, lon: 0, by: {} }
      s.count++
      s.lat += e.lat
      s.lon += e.lon
      s.by[e.category] = (s.by[e.category] ?? 0) + 1
      m.set(k, s)
    }
    return [...m.values()].sort((a, b) => b.count - a.count).slice(0, 30)
  }, [shown])
  const top = ranking[0]?.count ?? 1

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
      <Tabs value={tab} onChange={setTab} items={[['events', 'Events'], ['overview', 'Overview'], ['alerts', `Alerts${alerts.length ? ` · ${alerts.length}` : ''}`]]} />
      {tab !== 'alerts' && (
        <>
          <label className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5">
            <Search className="size-3.5 text-muted" aria-hidden />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Where: country, city, region or sea" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted" />
          </label>
          <div className="grid grid-cols-4 gap-1 text-[11px]">
            {[3, 6, 12, 24].map(h => (
              <button key={h} type="button" onClick={() => setHours(h)} className={`rounded-md border px-1 py-1 ${hours === h ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}`}>
                {h} h
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1 text-[11px]">
            {[1, 2, 3, 4].map(s => (
              <button key={s} type="button" onClick={() => setMinSev(s)} className={`rounded-md border px-2 py-0.5 ${minSev === s ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}`}>
                {s === 1 ? 'All' : `S${s}+`}
              </button>
            ))}
            <button type="button" onClick={() => setOnlyView(v => !v)} aria-pressed={onlyView} className={`ml-auto rounded-md border px-2 py-0.5 ${onlyView ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}`}>
              Only what the map shows
            </button>
          </div>
          <div className="flex flex-wrap gap-1 text-[10px]">
            {INTEL_CATEGORIES.map(c => (
              <button key={c} type="button" onClick={() => setCat(x => (x === c ? null : c))} aria-pressed={cat === c} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${cat === c ? 'border-accent text-text' : 'border-border text-muted hover:text-text'}`}>
                <span className="size-1.5 rounded-full" style={{ background: CATEGORY_COLOR[c] }} />
                {CATEGORY_LABEL[c]}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="px-1 text-xs text-warm">{error}</p>}
        {!events && !error && <p className="px-1 text-xs text-muted">Reading the world’s conflict feed (GDELT, the last two hours first)…</p>}
        {tab === 'events' && events && (
          <ul className="divide-y divide-border">
            {shown.slice(0, 300).map(e => (
              <li key={e.id + e.url}>
                <button type="button" onClick={() => ctx.flyTo(e.lat, e.lon, 7)} className="flex w-full gap-2 px-1 py-2 text-left hover:bg-surface">
                  <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: CATEGORY_COLOR[e.category] }} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium leading-snug">{e.title}</span>
                    <span className="block truncate text-[11px] text-muted">
                      {e.place} · {ago(e.at)}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                      <span className={`rounded px-1 font-mono font-semibold ${SEV_TONE[e.severity]}`}>S{e.severity}</span>
                      <span className="text-muted">{CATEGORY_LABEL[e.category]}</span>
                      <a href={e.url} target="_blank" rel="noreferrer" onClick={ev => ev.stopPropagation()} className="ml-auto truncate text-accent hover:underline">
                        {e.source}
                      </a>
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {!shown.length && <li className="px-1 py-3 text-xs text-muted">Nothing matches in this window.</li>}
          </ul>
        )}
        {tab === 'overview' && events && (
          <>
            <p className="hud-label px-1 pb-1">Where most is happening now</p>
            <ol className="space-y-1.5">
              {ranking.map((c, i) => (
                <li key={c.name}>
                  <button type="button" onClick={() => ctx.flyTo(c.lat / c.count, c.lon / c.count, 5)} className="w-full rounded-md px-1 py-1 text-left hover:bg-surface">
                    <span className="flex items-baseline gap-2 text-xs">
                      <span className="w-4 font-mono text-muted">{i + 1}</span>
                      <span className="flex-1 truncate font-medium">{c.name}</span>
                      {c.iso && <span className="rounded border border-border px-1 font-mono text-[9px] text-muted">{c.iso}</span>}
                      <span className="font-mono">{c.count}</span>
                    </span>
                    <span className="mt-1 block h-1 overflow-hidden rounded-full bg-border">
                      <span className="block h-full rounded-full bg-amber-400" style={{ width: `${(c.count / top) * 100}%` }} />
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-muted">
                      {Object.entries(c.by)
                        .sort((a, b) => b[1] - a[1])
                        .map(([k, n]) => `${CATEGORY_LABEL[k as IntelCategory]} ${n}`)
                        .join(' · ')}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </>
        )}
        {tab === 'alerts' && (
          <>
            <p className="px-1 pb-1 text-xs">
              <span className="font-medium">Ukraine · air-raid alerts now</span>
              <span className="text-muted"> · {alerts.length} oblast{alerts.length === 1 ? '' : 's'}</span>
            </p>
            <ul className="space-y-0.5">
              {alerts
                .slice()
                .sort((a, b) => (a.level === b.level ? b.since - a.since : a.level === 'full' ? -1 : 1))
                .map(a => (
                  <li key={a.name} className="flex items-center gap-2 rounded-md px-1 py-1 text-xs">
                    <span className={`size-2 rounded-full ${a.level === 'full' ? 'bg-red-500' : 'bg-orange-400'}`} aria-hidden />
                    <span className="flex-1 truncate">{a.name}</span>
                    <span className="text-[10px] text-muted">{a.level === 'full' ? 'whole oblast' : `${a.parts} district${a.parts === 1 ? '' : 's'}`} · {ago(a.since)}</span>
                  </li>
                ))}
            </ul>
            <p className="mt-2 px-1 text-[10px] text-muted">Live from siren.pp.ua; shapes geoBoundaries (ODbL). Luhansk and Crimea stay on: occupied since 2014–2022.</p>
          </>
        )}
      </div>
      <p className="text-[10px] text-muted">Events: GDELT 2.0, filtered to armed conflict and protest by the article’s own words; titles come from its address. Severity by how many outlets report it.</p>
    </div>
  )
}

export function DockPanel({ which, onClose, ctx, children }: { which: DockId; onClose: () => void; ctx: DockContext; children?: ReactNode }) {
  const d = DOCK.find(x => x.id === which)!
  const Icon = d.icon
  return (
    <section aria-label={`${d.label} panel`} className="peek-card glass pointer-events-auto flex max-h-full w-[min(360px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl bg-solid/92 shadow-2xl">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon className="size-4" style={{ color: d.color }} aria-hidden />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{d.label}</h3>
        {which === 'intel' && (
          <button type="button" onClick={() => ctx.setIntelOnMap(!ctx.intelOnMap)} aria-pressed={ctx.intelOnMap} className={`rounded-md border px-2 py-0.5 text-[11px] ${ctx.intelOnMap ? 'border-accent text-accent' : 'border-border text-muted'}`} title="Events, country shading and alert regions on the map">
            On map
          </button>
        )}
        <button type="button" className="icon-btn size-7" onClick={onClose} aria-label="Close the panel" title="Close (Esc)">
          <X className="size-4" aria-hidden />
        </button>
      </header>
      {which === 'intel' ? <IntelPanel ctx={ctx} /> : which === 'markets' ? <MarketsPanel /> : which === 'geo' ? <GeoPanel ctx={ctx} /> : which === 'vip' ? <VipPanel ctx={ctx} /> : which === 'cams' ? <CamerasPanel ctx={ctx} /> : children}
    </section>
  )
}

const flag = (cc: string, w = 40) => `https://flagcdn.com/w${w}/${cc.toLowerCase()}.png`
const fmtPrice = (q: Quote) => {
  const v = q.price
  const s = v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v >= 10 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v.toLocaleString(undefined, { maximumFractionDigits: 4 })
  return q.currency === 'USD' && q.group !== 'indices' && q.group !== 'currencies' ? `$${s}` : s
}

/** World trade: indices, commodities, crypto, currencies and sectors, each with its month. */
function MarketsPanel() {
  const [quotes, setQuotes] = useState<Quote[] | null>(null)
  const [group, setGroup] = useState<MarketGroup | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let gone = false
    const load = () =>
      void window.world.markets().then(
        q => !gone && (setQuotes(q), setError(q.length ? '' : 'Market data is unavailable right now.')),
        () => !gone && setError('Market data is unavailable right now.'),
      )
    load()
    const t = setInterval(load, 10 * 60_000)
    return () => {
      gone = true
      clearInterval(t)
    }
  }, [])
  const q = query.trim().toLowerCase()
  const shown = (quotes ?? []).filter(x => (!group || x.group === group) && (!q || `${x.name} ${x.symbol} ${GROUP_LABEL[x.group]}`.toLowerCase().includes(q)))
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
      <label className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5">
        <Search className="size-3.5 text-muted" aria-hidden />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Company, index, commodity, currency" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted" />
      </label>
      <div className="flex flex-wrap gap-1 text-[10px]">
        {MARKET_GROUPS.map(g => (
          <button key={g} type="button" onClick={() => setGroup(x => (x === g ? null : g))} aria-pressed={group === g} className={`rounded-full border px-2 py-0.5 ${group === g ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}`}>
            {GROUP_LABEL[g]}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="px-1 text-xs text-warm">{error}</p>}
        {!quotes && !error && <p className="px-1 text-xs text-muted">Loading today and the last month…</p>}
        {MARKET_GROUPS.filter(g => shown.some(x => x.group === g)).map(g => {
          const items = shown.filter(x => x.group === g)
          const up = items.filter(x => x.changePct >= 0).length
          return (
            <section key={g} className="mb-2">
              <p className="hud-label flex justify-between px-1 pb-1">
                <span>{GROUP_LABEL[g]}</span>
                <span>
                  <span className="text-emerald-400">▲ {up}</span> · <span className="text-red-400">▼ {items.length - up}</span>
                </span>
              </p>
              <ul className="space-y-0.5">
                {items.map(x => {
                  const rising = (x.closes.at(-1) ?? 0) >= (x.closes[0] ?? 0)
                  return (
                    <li key={x.symbol}>
                      <a href={`https://finance.yahoo.com/quote/${encodeURIComponent(x.symbol)}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface">
                        {x.cc ? <img src={flag(x.cc)} alt="" className="h-4 w-6 shrink-0 rounded-sm object-cover" loading="lazy" /> : <span className="grid h-4 w-6 shrink-0 place-items-center rounded-sm bg-surface font-mono text-[8px] text-muted">{x.symbol.slice(0, 3)}</span>}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{x.name}</span>
                          <span className="block truncate font-mono text-[9px] text-muted">{x.symbol}</span>
                        </span>
                        <svg viewBox="0 0 60 18" className="h-[18px] w-[60px] shrink-0" aria-hidden>
                          <path d={sparkPath(x.closes, 60, 18)} fill="none" stroke={rising ? '#34d399' : '#f87171'} strokeWidth="1.2" />
                        </svg>
                        <span className="w-20 shrink-0 text-right">
                          <span className="block font-mono text-xs">{fmtPrice(x)}</span>
                          <span className={`block font-mono text-[10px] ${x.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {x.changePct >= 0 ? '▲' : '▼'}
                            {Math.abs(x.changePct).toFixed(2)} %
                          </span>
                        </span>
                      </a>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
      <p className="text-[10px] text-muted">Today and the last month, from Yahoo Finance (delayed, for information only).</p>
    </div>
  )
}

interface CountryRow {
  iso: string
  name: string
  continent: string
  lat: number
  lon: number
}

const CONTINENTS = ['Europe', 'Asia', 'Africa', 'North America', 'South America', 'Oceania'] as const

/** Geography: every country, the busiest first, and each country's card. */
function GeoPanel({ ctx }: { ctx: DockContext }) {
  const [rows, setRows] = useState<CountryRow[]>([])
  const [query, setQuery] = useState('')
  const [continent, setContinent] = useState<string | null>(null)
  const [pick, setPick] = useState<CountryRow | null>(null)
  const [card, setCard] = useState<CountryCard | null | 'loading'>(null)
  useEffect(() => {
    void window.world.intelCountries().then(
      fc => setRows(fc.features.map(f => f.properties as unknown as CountryRow).filter(r => r.iso && r.name).sort((a, b) => a.name.localeCompare(b.name))),
      () => undefined,
    )
  }, [])
  useEffect(() => {
    if (!pick) return
    let gone = false
    setCard('loading')
    void window.world.country(pick.iso).then(
      c => !gone && setCard(c),
      () => !gone && setCard(null),
    )
    return () => {
      gone = true
    }
  }, [pick])
  const activity = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of ctx.intelEvents ?? []) if (e.country) m.set(e.country, (m.get(e.country) ?? 0) + 1)
    return m
  }, [ctx.intelEvents])
  const q = query.trim().toLowerCase()
  const shown = rows.filter(r => (!continent || r.continent === continent) && (!q || r.name.toLowerCase().includes(q) || r.iso.toLowerCase() === q)).sort((a, b) => (activity.get(b.iso) ?? 0) - (activity.get(a.iso) ?? 0) || a.name.localeCompare(b.name))
  const top = Math.max(1, ...activity.values())

  if (pick) {
    const c = card === 'loading' ? null : card
    const events = (ctx.intelEvents ?? []).filter(e => e.country === pick.iso).slice(0, 8)
    const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString())
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
        <button type="button" onClick={() => setPick(null)} className="self-start text-[11px] text-accent hover:underline">
          ← All countries
        </button>
        <div className="flex items-center gap-3">
          <img src={flag(pick.iso, 80)} alt="" className="h-10 w-16 rounded object-cover shadow" />
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">{c?.name || pick.name}</p>
            <p className="text-[10px] uppercase tracking-wider text-muted">
              {pick.continent} · {pick.iso}
            </p>
          </div>
        </div>
        {c?.description && <p className="text-xs text-muted">{c.description}</p>}
        {card === 'loading' && <p className="text-xs text-muted">Reading its card…</p>}
        {c && (
          <dl className="divide-y divide-border text-xs">
            {[
              ['Capital', c.capital],
              ['Population', fmt(c.population)],
              ['Area', c.areaKm2 === null ? '—' : `${Math.round(c.areaKm2).toLocaleString()} km²`],
              ['Currency', c.currency],
              ['Languages', c.languages],
              ['Head of state', c.headOfState],
              ['Head of government', c.headOfGovernment],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 py-1.5">
                <dt className="text-muted">{k}</dt>
                <dd className="text-right">{v || '—'}</dd>
              </div>
            ))}
          </dl>
        )}
        {card === null && <p className="text-xs text-muted">No card for this country right now.</p>}
        <button type="button" onClick={() => ctx.flyTo(pick.lat, pick.lon, 4)} className="rounded-lg border border-accent/50 px-3 py-1.5 text-xs text-accent hover:bg-accent/10">
          Center on map
        </button>
        {events.length > 0 && (
          <>
            <p className="hud-label pt-1">Latest events here</p>
            <ul className="space-y-1">
              {events.map(e => (
                <li key={e.url}>
                  <button type="button" onClick={() => ctx.flyTo(e.lat, e.lon, 7)} className="flex w-full gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-surface">
                    <span className="mt-1 size-2 shrink-0 rounded-full" style={{ background: CATEGORY_COLOR[e.category] }} />
                    <span className="min-w-0 flex-1">
                      {e.title}
                      <span className="block text-[10px] text-muted">
                        {e.place} · {ago(e.at)} · S{e.severity}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="text-[10px] text-muted">Facts: Wikidata (CC0); flags: flagcdn.com.</p>
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
      <label className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5">
        <Search className="size-3.5 text-muted" aria-hidden />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Country or code" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted" />
      </label>
      <div className="flex flex-wrap gap-1 text-[10px]">
        {CONTINENTS.map(c => (
          <button key={c} type="button" onClick={() => setContinent(x => (x === c ? null : c))} aria-pressed={continent === c} className={`rounded-full border px-2 py-0.5 ${continent === c ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}`}>
            {c}
          </button>
        ))}
      </div>
      {!ctx.intelEvents && <p className="px-1 text-[10px] text-muted">Open Intelligence once to rank countries by what is happening there.</p>}
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {shown.map(r => {
          const n = activity.get(r.iso) ?? 0
          return (
            <li key={r.iso}>
              <button type="button" onClick={() => setPick(r)} className="w-full rounded-md px-1 py-1 text-left hover:bg-surface">
                <span className="flex items-center gap-2 text-xs">
                  <img src={flag(r.iso)} alt="" className="h-3.5 w-5 shrink-0 rounded-sm object-cover" loading="lazy" />
                  <span className="flex-1 truncate">{r.name}</span>
                  {n > 0 && <span className="font-mono text-[11px]">{n}</span>}
                </span>
                {n > 0 && (
                  <span className="mt-0.5 block h-0.5 overflow-hidden rounded-full bg-border">
                    <span className="block h-full bg-amber-400" style={{ width: `${(n / top) * 100}%` }} />
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** VIP people: who of the known VIP aircraft is flying now, and the richest. */
function VipPanel({ ctx }: { ctx: DockContext }) {
  const [tab, setTab] = useState<'now' | 'richest'>('now')
  const [data, setData] = useState<{ total: number; counts: Partial<Record<VipCategory, number>>; flying: VipFlying[] } | null>(null)
  const [rich, setRich] = useState<RichPerson[] | null>(null)
  const [cat, setCat] = useState<VipCategory | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let gone = false
    const load = () =>
      void window.world.vip().then(
        d => !gone && setData(d),
        () => undefined,
      )
    load()
    const t = setInterval(load, 60_000)
    return () => {
      gone = true
      clearInterval(t)
    }
  }, [])
  useEffect(() => {
    if (tab !== 'richest' || rich) return
    void window.world.richest().then(setRich, () => setRich([]))
  }, [tab, rich])
  const q = query.trim().toLowerCase()
  const flying = (data?.flying ?? []).filter(f => (!cat || f.category === cat) && (!q || `${f.who} ${f.operator} ${f.registration} ${f.type}`.toLowerCase().includes(q)))
  const ride = (f: VipFlying) => window.dispatchEvent(new CustomEvent(MAP3D_EVENT, { detail: { kind: '3d', action: 'fly_with', query: f.hex, lat: f.lat, lon: f.lon, mode: 'chase', show: [], hide: [] } }))
  const topWorth = rich?.[0]?.worth ?? 1
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
      <Tabs value={tab} onChange={setTab} items={[['now', 'Now'], ['richest', 'The richest']]} />
      {tab === 'now' ? (
        <>
          <label className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5">
            <Search className="size-3.5 text-muted" aria-hidden />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Person, company or country" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted" />
          </label>
          <div className="flex flex-wrap gap-1 text-[10px]">
            {VIP_CATEGORIES.map(c => (
              <button key={c} type="button" onClick={() => setCat(x => (x === c ? null : c))} aria-pressed={cat === c} className={`rounded-full border px-2 py-0.5 ${cat === c ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}`}>
                {VIP_LABEL[c]}
                {data?.counts[c] ? <span className="ml-1 font-mono text-muted">{data.counts[c]}</span> : null}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="rounded-lg border border-border px-2 py-1.5">
              <p className="font-mono text-lg">{data ? data.flying.length : '…'}</p>
              <p className="text-[10px] text-muted">flying now, among the aircraft Atlas sees</p>
            </div>
            <div className="rounded-lg border border-border px-2 py-1.5">
              <p className="font-mono text-lg">{data ? data.total.toLocaleString() : '…'}</p>
              <p className="text-[10px] text-muted">VIP aircraft known</p>
            </div>
          </div>
          <p className="hud-label px-1">Flying now</p>
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {flying.map(f => (
              <li key={f.hex} className="rounded-md px-1 py-1 hover:bg-surface">
                <button type="button" onClick={() => ctx.flyTo(f.lat, f.lon, 8)} className="flex w-full items-center gap-2 text-left">
                  <Star className="size-3.5 shrink-0 text-yellow-300" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{f.who}</span>
                    <span className="block truncate text-[10px] text-muted">
                      {VIP_LABEL[f.category]} · {f.registration} · {f.type}
                    </span>
                  </span>
                  <span className="shrink-0 rounded border border-emerald-400/60 px-1 font-mono text-[9px] text-emerald-300">{f.altitude ? `FL${String(Math.round(f.altitude / 100)).padStart(3, '0')}` : 'LIVE'}</span>
                </button>
                <button type="button" onClick={() => ride(f)} className="ml-5 mt-0.5 text-[10px] text-accent hover:underline">
                  Fly with it in 3D
                </button>
              </li>
            ))}
            {data && !flying.length && <li className="px-1 py-2 text-xs text-muted">None in the air among the aircraft loaded. Zoom the map out to the world: Atlas sweeps every area and the list fills in.</li>}
          </ul>
          <p className="text-[10px] text-muted">Aircraft list: plane-alert-db (sdr-enthusiasts, ODbL). Positions: live ADS-B.</p>
        </>
      ) : (
        <>
          <ol className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
            {!rich && <li className="px-1 text-xs text-muted">Reading Wikidata…</li>}
            {rich?.map((r, i) => (
              <li key={r.name} className="flex items-center gap-2 px-1">
                <span className="w-4 font-mono text-[10px] text-muted">{i + 1}</span>
                <RemoteImg src={r.image} initials={initialsOf(r.name)} className="size-7 shrink-0 rounded-full object-cover" />
                <span className="min-w-0 flex-1">
                  <span className="flex justify-between gap-2 text-xs">
                    <span className="truncate">{r.name}</span>
                    <span className="font-mono text-yellow-300">${(r.worth / 1e9).toFixed(1)} B</span>
                  </span>
                  <span className="mt-0.5 block h-1 overflow-hidden rounded-full bg-border">
                    <span className="block h-full bg-yellow-400" style={{ width: `${(r.worth / topWorth) * 100}%` }} />
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <p className="text-[10px] text-muted">Net worth in US dollars as Wikidata records it (dates vary); photos Wikimedia Commons.</p>
        </>
      )}
    </div>
  )
}

const PLACES: { name: string; lat: number; lon: number }[] = [
  { name: 'London', lat: 51.507, lon: -0.128 },
  { name: 'Seattle', lat: 47.606, lon: -122.332 },
  { name: 'Atlanta', lat: 33.749, lon: -84.388 },
  { name: 'Madrid', lat: 40.417, lon: -3.704 },
  { name: 'Toronto', lat: 43.653, lon: -79.383 },
  { name: 'Sydney', lat: -33.869, lon: 151.209 },
  { name: 'Hong Kong', lat: 22.319, lon: 114.169 },
  { name: 'Helsinki', lat: 60.17, lon: 24.938 },
]

/** Public cameras: search them, jump to a city, and find the cameras near what is happening. */
function CamerasPanel({ ctx }: { ctx: DockContext }) {
  const [cams, setCams] = useState<Camera[] | null>(null)
  const [query, setQuery] = useState('')
  const [km, setKm] = useState(100)
  useEffect(() => {
    void window.world.cameras().then(setCams, () => setCams([]))
  }, [])
  const open = (c: Camera) => {
    const f = cameraFeatures([c]).features[0]
    ctx.flyTo(c.lat, c.lon, 13)
    if (f) ctx.select({ kind: 'cameras', lngLat: [c.lon, c.lat], props: f.properties as Record<string, string | number> })
  }
  const q = query.trim().toLowerCase()
  const found = q.length >= 2 ? (cams ?? []).filter(c => `${c.name} ${c.country} ${c.source}`.toLowerCase().includes(q)).slice(0, 60) : []
  const live = (cams ?? []).filter(c => c.video).length
  const countries = new Set((cams ?? []).map(c => c.country)).size
  // Earthquakes, natural events and the strongest conflict events, each with the cameras around it.
  const happening = useMemo(() => {
    if (!cams?.length) return []
    const spots: { title: string; kind: string; lat: number; lon: number }[] = [
      ...ctx.world.quakes.slice(0, 40).map(q => ({ title: q.place || `M${q.mag}`, kind: `Earthquake · M${q.mag.toFixed(1)}`, lat: q.lat, lon: q.lon })),
      ...ctx.world.events.slice(0, 60).map(e => ({ title: e.title, kind: e.category, lat: e.lat, lon: e.lon })),
      ...(ctx.intelEvents ?? []).filter(e => e.severity >= 4 && e.category !== 'protest' && e.category !== 'other').slice(0, 20).map(e => ({ title: e.title, kind: `${CATEGORY_LABEL[e.category]} · S${e.severity}`, lat: e.lat, lon: e.lon })),
    ]
    return spots
      .map(s => {
        const near = cams.filter(c => Math.abs(c.lat - s.lat) < km / 80 && kmBetween(s, c) <= km)
        return { ...s, n: near.length, live: near.filter(c => c.video).length }
      })
      .filter(s => s.n > 0)
      // Earthquakes and natural events first (they are what cameras show best), then the most covered.
      .sort((a, b) => Number(/^Earthquake|Wildfire|Volcano|Storm|Flood/i.test(b.kind)) - Number(/^Earthquake|Wildfire|Volcano|Storm|Flood/i.test(a.kind)) || b.n - a.n)
      .slice(0, 25)
    // ctx.world and ctx.intelEvents change as feeds update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cams, km, ctx.world, ctx.intelEvents])
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2.5">
      <label className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5">
        <Search className="size-3.5 text-muted" aria-hidden />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Camera, road, city or country" className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted" />
      </label>
      <div className="grid grid-cols-3 gap-1.5">
        {[
          [cams ? cams.length.toLocaleString() : '…', 'cameras'],
          [cams ? live.toLocaleString() : '…', 'live video'],
          [cams ? String(countries) : '…', 'countries'],
        ].map(([v, l]) => (
          <div key={l} className="rounded-lg border border-border px-2 py-1.5">
            <p className="font-mono text-base">{v}</p>
            <p className="text-[10px] text-muted">{l}</p>
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {q.length >= 2 ? (
          <ul className="space-y-0.5">
            {found.map(c => (
              <li key={c.id}>
                <button type="button" onClick={() => open(c)} className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-surface">
                  <Video className={`size-3.5 shrink-0 ${c.video ? 'text-red-400' : 'text-teal-300'}`} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{c.name}</span>
                    <span className="block truncate text-[10px] text-muted">
                      {c.country} · {c.source}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {!found.length && <li className="px-1 py-2 text-xs text-muted">No camera by that name.</li>}
          </ul>
        ) : (
          <>
            <p className="hud-label px-1 pb-1">Search any place</p>
            <div className="flex flex-wrap gap-1 pb-2 text-[11px]">
              {PLACES.map(p => (
                <button key={p.name} type="button" onClick={() => ctx.flyTo(p.lat, p.lon, 11)} className="rounded-full border border-border px-2 py-0.5 text-muted hover:border-accent hover:text-accent">
                  {p.name}
                </button>
              ))}
            </div>
            <p className="hud-label px-1">Where something is happening</p>
            <label className="flex items-center gap-2 px-1 py-1.5 text-[11px]">
              <span className="text-muted">Within</span>
              <input type="range" min={10} max={300} step={10} value={km} onChange={e => setKm(Number(e.target.value))} className="flex-1 accent-[var(--color-accent,#22d3ee)]" />
              <span className="w-14 text-right font-mono">{km} km</span>
            </label>
            <ul className="space-y-0.5">
              {happening.map(h => (
                <li key={h.title + h.lat}>
                  <button type="button" onClick={() => ctx.flyTo(h.lat, h.lon, 9)} className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-surface">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs">{h.title}</span>
                      <span className="block truncate text-[10px] text-muted">
                        {h.kind} · {h.n} camera{h.n === 1 ? '' : 's'}
                      </span>
                    </span>
                    {h.live > 0 && <span className="shrink-0 font-mono text-[10px] text-red-300">{h.live} live</span>}
                  </button>
                </li>
              ))}
              {cams && !happening.length && <li className="px-1 py-2 text-xs text-muted">No public camera near today’s events within {km} km.</li>}
            </ul>
          </>
        )}
      </div>
      <p className="text-[10px] text-muted">Official open feeds only (road agencies and cities); Windy webcams with your key appear on the map.</p>
    </div>
  )
}
