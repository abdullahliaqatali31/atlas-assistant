/**
 * The World page's dock (after Argos): Intelligence, Markets, VIP people and
 * Geography, as buttons in the map's toolbar (flat map and 3D view alike)
 * and one panel at a time, docked on the right so the item card keeps the
 * left. Each panel reads main's keyless feeds; the map shows what it can.
 */
import { Briefcase, Globe2, Search, Shield, Star, X } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { CATEGORY_COLOR, CATEGORY_LABEL, INTEL_CATEGORIES, type AlertRegion, type IntelCategory, type IntelEvent } from '../../../shared/intel.ts'

export type DockId = 'intel' | 'markets' | 'vip' | 'geo'

export const DOCK: { id: DockId; label: string; icon: typeof Shield; key: string; color: string }[] = [
  { id: 'intel', label: 'Intelligence', icon: Shield, key: 'i', color: '#f59e0b' },
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
      {which === 'intel' ? <IntelPanel ctx={ctx} /> : children}
    </section>
  )
}
