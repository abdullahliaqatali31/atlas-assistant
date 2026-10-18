/**
 * The layer rail (plan §4.2): one row per layer down the map's right edge,
 * with its live count and a one-key shortcut. Click shows or hides the
 * layer; rest the pointer on a row and its panel opens beside it, with
 * "Now" (what is happening in that layer) and "Filters". A pin keeps the
 * panel open. Hidden on narrow windows, where the Layers button remains.
 */
import { Activity, BookOpen, Flame, TriangleAlert, MapPin, Newspaper, Pin, PinOff, Plane, Satellite, Ship, Video, type LucideIcon } from 'lucide-react'
import type * as satellite from 'satellite.js'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { CAMERA_COVERAGE, kmBetween, type WorldSnapshot } from '../../../shared/world.ts'
import { CATEGORIES } from '../../../shared/news.ts'
import { ago } from '../Jarvis.tsx'
import { ASK_EVENT } from '../shell/live.ts'
import { ALERT_COLOR, SHIP_COLOR, type FC } from './geo.ts'
import { layerDef, type LayerId } from './layers.ts'
import { CHOKEPOINTS, mixBy, passes as passesFilter, topBy, type MapFilters } from './panels.ts'
import { aboveNow, nextPasses, type Observer } from './passes.ts'

type Feature = FC['features'][number]

/** Rail order, icons and keys. Keys avoid the app's own: g, h, w, /, [ and ]. */
export const RAIL: { id: LayerId; icon: LucideIcon; key: string }[] = [
  { id: 'news', icon: Newspaper, key: 'n' },
  { id: 'story', icon: BookOpen, key: 'a' },
  { id: 'places', icon: MapPin, key: 'p' },
  { id: 'flights', icon: Plane, key: 'f' },
  { id: 'ships', icon: Ship, key: 'b' },
  { id: 'satellites', icon: Satellite, key: 's' },
  { id: 'cameras', icon: Video, key: 'c' },
  { id: 'quakes', icon: Activity, key: 'q' },
  { id: 'events', icon: Flame, key: 'e' },
  { id: 'disasters', icon: TriangleAlert, key: 'd' },
  { id: 'pins', icon: Pin, key: 'm' },
]

export interface RailContext {
  sources: Partial<Record<LayerId, FC>>
  world: WorldSnapshot
  filters: MapFilters
  onFilters: (f: MapFilters) => void
  /** Where "above you" is: the first watched place, else the map centre. */
  observer: Observer & { name: string }
  centre: [number, number]
  sats: readonly { name: string; rec: satellite.SatRec }[]
  storyTitle: string | null
  flightNote: string
  shipNote: string | null
  /** The AISStream key form, when ships need one. */
  shipKeyForm: ReactNode
  now: number
  onFocus: (kind: LayerId, f: Feature) => void
  onFly: (lat: number, lon: number, zoom: number) => void
}

const fmtCount = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const time = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })

function Row({ f, kind, right, onFocus }: { f: Feature; kind: LayerId; right?: ReactNode; onFocus: RailContext['onFocus'] }) {
  return (
    <li>
      <button type="button" className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-surface" onClick={() => onFocus(kind, f)}>
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: String(f.properties.color ?? layerDef(kind).dot) }} aria-hidden />
        <span className="min-w-0 flex-1 truncate" dir="auto" title={String(f.properties.title ?? '')}>
          {String(f.properties.title ?? layerDef(kind).kind)}
        </span>
        {right && <span className="shrink-0 font-mono text-[10px] text-muted">{right}</span>}
      </button>
    </li>
  )
}

const Empty = ({ children }: { children: ReactNode }) => <p className="px-1.5 py-2 text-xs text-muted">{children}</p>
const Label = ({ children }: { children: ReactNode }) => <p className="hud-label mb-1 mt-2 px-1.5 first:mt-0">{children}</p>

function NowTab({ id, ctx }: { id: LayerId; ctx: RailContext }) {
  const all = (ctx.sources[id]?.features ?? []).filter(f => passesFilter(id, f.properties, ctx.filters))
  const fc: FC = { type: 'FeatureCollection', features: all }
  const [cLon, cLat] = ctx.centre
  const nearest = (n: number) =>
    [...all].sort((a, b) => kmBetween({ lat: cLat, lon: cLon }, { lat: a.geometry.coordinates[1]!, lon: a.geometry.coordinates[0]! }) - kmBetween({ lat: cLat, lon: cLon }, { lat: b.geometry.coordinates[1]!, lon: b.geometry.coordinates[0]! })).slice(0, n)
  switch (id) {
    case 'news': {
      const mix = mixBy(fc, 'category')
      return all.length ? (
        <>
          <p className="flex flex-wrap gap-x-2 px-1.5 text-[11px] text-muted">
            {mix.map(m => (
              <span key={m.value}>
                {m.value} <span className="font-mono text-text">{m.count}</span>
              </span>
            ))}
          </p>
          <Label>Heaviest first</Label>
          <ul>{[...all].sort((a, b) => Number(b.properties.severity) - Number(a.properties.severity) || Number(b.properties.time ?? 0) - Number(a.properties.time ?? 0)).slice(0, 12).map(f => <Row key={String(f.properties.id)} f={f} kind={id} right={String(f.properties.place ?? '')} onFocus={ctx.onFocus} />)}</ul>
          <button type="button" className="mx-1.5 mt-2 w-[calc(100%-0.75rem)] rounded-lg border border-accent/50 px-2 py-1.5 text-left text-xs text-accent hover:bg-surface" onClick={() => window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: 'Aaj ki important news map pe dikhao, connected stories ke saath.' }))}>
            Ask Atlas to pick the important ones and connect them
          </button>
          <p className="mt-1 px-1.5 text-[10px] text-muted">Headlines from your news feeds, placed by the places they name. Turn feeds on or off on the News page.</p>
        </>
      ) : (
        <Empty>No headlines yet. The feeds refresh in the background; turn more on in News.</Empty>
      )
    }
    case 'story':
      return all.length ? (
        <>
          <Label>{ctx.storyTitle ?? 'Story'}</Label>
          <ul>{all.map(f => <Row key={String(f.properties.id)} f={f} kind={id} right={`#${f.properties.n}`} onFocus={ctx.onFocus} />)}</ul>
        </>
      ) : (
        <Empty>No story on the map. Ask Atlas: “aaj ki important news map pe dikhao”.</Empty>
      )
    case 'places':
      return ctx.world.places.length ? (
        <ul>
          {all.map(f => {
            const s = ctx.world.places.find(p => p.place.id === f.properties.id)
            return <Row key={String(f.properties.id)} f={f} kind={id} right={s?.weather ? `${Math.round(s.weather.temp)}°` : undefined} onFocus={ctx.onFocus} />
          })}
        </ul>
      ) : (
        <Empty>No watched places yet: type one in “Watch a city…”.</Empty>
      )
    case 'flights': {
      const mil = all.filter(f => f.properties.military === 1).length
      return (
        <>
          <p className="px-1.5 text-xs">
            <span className="font-mono text-base">{all.length}</span> in the air here{mil ? <span className="text-danger"> · {mil} military</span> : null}
          </p>
          <p className="px-1.5 text-[10px] text-muted">{ctx.flightNote || 'Around the map centre when zoomed in to a region.'}</p>
          {all.length > 0 && <Label>Highest</Label>}
          <ul>{topBy(fc, 'altitude', 6).map(f => <Row key={String(f.properties.title)} f={f} kind={id} right={`${Math.round(Number(f.properties.altitude) / 1000)}k ft`} onFocus={ctx.onFocus} />)}</ul>
        </>
      )
    }
    case 'ships': {
      const mix = mixBy(fc, 'category')
      const total = all.length
      return (
        <>
          <p className="px-1.5 text-xs">
            <span className="font-mono text-base">{total}</span> on screen
          </p>
          {ctx.shipNote && <p className="px-1.5 text-[10px] text-warm">{ctx.shipNote}</p>}
          {ctx.shipKeyForm && <div className="px-1.5">{ctx.shipKeyForm}</div>}
          {total > 0 && (
            <div className="mx-1.5 mt-1 flex h-1.5 overflow-hidden rounded-full bg-surface" aria-label="Ships by type">
              {mix.map(m => (
                <span key={m.value} style={{ width: `${(m.count / total) * 100}%`, background: SHIP_COLOR[m.value] ?? SHIP_COLOR.Other }} title={`${m.value}: ${m.count}`} />
              ))}
            </div>
          )}
          {mix.length > 0 && (
            <p className="mt-1 flex flex-wrap gap-x-2 px-1.5 text-[10px] text-muted">
              {mix.slice(0, 5).map(m => (
                <span key={m.value}>
                  <span className="mr-0.5 inline-block size-1.5 rounded-full" style={{ background: SHIP_COLOR[m.value] ?? SHIP_COLOR.Other }} />
                  {m.value} {m.count}
                </span>
              ))}
            </p>
          )}
          <Label>Chokepoints</Label>
          <div className="grid grid-cols-2 gap-1 px-1.5">
            {CHOKEPOINTS.map(c => (
              <button key={c.name} type="button" className="truncate rounded-md border border-border px-1.5 py-1 text-left text-[11px] hover:border-accent" onClick={() => ctx.onFly(c.lat, c.lon, c.zoom)} title={`Fly to ${c.name}`}>
                {c.name}
              </button>
            ))}
          </div>
        </>
      )
    }
    case 'satellites':
      return <SatellitesNow ctx={ctx} />
    case 'cameras':
      return (
        <>
          <p className="px-1.5 text-xs">
            <span className="font-mono text-base">{all.length}</span> public cameras
          </p>
          <p className="px-1.5 text-[10px] leading-snug text-muted">Official open feeds only: {CAMERA_COVERAGE}</p>
          {all.length > 0 && <Label>Nearest the map centre</Label>}
          <ul>{nearest(6).map(f => <Row key={String(f.properties.id)} f={f} kind={id} onFocus={ctx.onFocus} />)}</ul>
        </>
      )
    case 'quakes':
      return all.length ? (
        <>
          <Label>Strongest, last 2 days</Label>
          <ul>{topBy(fc, 'mag', 8).map(f => <Row key={String(f.properties.title)} f={f} kind={id} right={ago(Number(f.properties.time), ctx.now)} onFocus={ctx.onFocus} />)}</ul>
        </>
      ) : (
        <Empty>No earthquakes above the filter in the last 2 days.</Empty>
      )
    case 'events': {
      const mix = mixBy(fc, 'category')
      return all.length ? (
        <>
          <p className="flex flex-wrap gap-x-2 px-1.5 text-[11px] text-muted">
            {mix.map(m => (
              <span key={m.value}>
                {m.value} <span className="font-mono text-text">{m.count}</span>
              </span>
            ))}
          </p>
          <Label>Most recent</Label>
          <ul>{topBy(fc, 'time', 8).map(f => <Row key={String(f.properties.title)} f={f} kind={id} right={ago(Number(f.properties.time), ctx.now)} onFocus={ctx.onFocus} />)}</ul>
        </>
      ) : (
        <Empty>No open natural events right now.</Empty>
      )
    }
    case 'disasters': {
      const mix = mixBy(fc, 'alert')
      return all.length ? (
        <>
          <p className="flex gap-3 px-1.5 text-[11px] text-muted">
            {mix.map(m => (
              <span key={m.value}>
                <span className="mr-1 inline-block size-1.5 rounded-full" style={{ background: ALERT_COLOR[m.value] }} />
                {m.value} <span className="font-mono text-text">{m.count}</span>
              </span>
            ))}
          </p>
          <Label>Most serious</Label>
          <ul>{topBy(fc, 'rank', 10).map(f => <Row key={String(f.properties.id)} f={f} kind={id} right={String(f.properties.kind ?? '')} onFocus={ctx.onFocus} />)}</ul>
          <p className="mt-1 px-1.5 text-[10px] text-muted">GDACS, the UN and European Commission disaster alert system: green is routine, orange and red need attention.</p>
        </>
      ) : (
        <Empty>No current disaster alerts.</Empty>
      )
    }
    case 'pins':
      return all.length ? <ul>{all.map(f => <Row key={String(f.properties.id)} f={f} kind={id} onFocus={ctx.onFocus} />)}</ul> : <Empty>No pins. Atlas drops them when telling you about places.</Empty>
  }
}

function SatellitesNow({ ctx }: { ctx: RailContext }) {
  const iss = ctx.sats.find(s => /^ISS \(ZARYA\)/.test(s.name))
  // Pass prediction steps through two days of orbit: once per panel open, not every render.
  const { above, passList } = useMemo(() => {
    const at = new Date()
    return { above: aboveNow(ctx.sats, ctx.observer, at), passList: iss ? nextPasses(iss.rec, ctx.observer, at.getTime(), { limit: 4 }) : [] }
  }, [ctx.sats.length, ctx.observer.lat, ctx.observer.lon, iss?.name])
  const issNow = ctx.sources.satellites?.features.find(f => f.properties.label === 'ISS')
  return (
    <>
      <p className="px-1.5 text-xs">
        <span className="font-mono text-base">{above}</span> above {ctx.observer.name} now <span className="text-muted">(of {ctx.sats.length} tracked)</span>
      </p>
      {issNow && (
        <button type="button" className="mx-1.5 mt-1.5 w-[calc(100%-0.75rem)] rounded-lg border border-border px-2 py-1.5 text-left text-xs hover:border-accent" onClick={() => ctx.onFocus('satellites', issNow)}>
          <span className="font-medium">The ISS</span> <span className="text-muted">· {String(issNow.properties.detail)} · follow</span>
        </button>
      )}
      <Label>ISS over {ctx.observer.name}</Label>
      {passList.length ? (
        <ul className="space-y-0.5 px-1.5 text-xs">
          {passList.map(p => (
            <li key={p.rise} className="flex justify-between gap-2">
              <span>{time(p.rise)}</span>
              <span className="font-mono text-[10px] text-muted">
                {Math.max(1, Math.round((p.set - p.rise) / 60_000))} min · {p.maxElevation}°
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>{iss ? 'No passes above 10° in the next two days.' : 'Turn on Satellites to see passes.'}</Empty>
      )}
      <p className="mt-1 px-1.5 text-[10px] text-muted">Higher passes at dusk or dawn are the ones you can see.</p>
    </>
  )
}

function FiltersTab({ id, ctx }: { id: LayerId; ctx: RailContext }) {
  const f = ctx.filters
  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])
  switch (id) {
    case 'flights':
      return (
        <label className="flex items-center gap-2 px-1.5 py-1 text-xs">
          <input type="checkbox" checked={f.militaryOnly} onChange={() => ctx.onFilters({ ...f, militaryOnly: !f.militaryOnly })} /> Military aircraft only
        </label>
      )
    case 'ships':
      return (
        <fieldset className="grid grid-cols-2 gap-x-2 px-1.5 text-xs">
          <legend className="hud-label mb-1">Show types (none ticked shows all)</legend>
          {Object.keys(SHIP_COLOR).map(t => (
            <label key={t} className="flex items-center gap-1.5 py-0.5">
              <input type="checkbox" checked={f.shipTypes.includes(t)} onChange={() => ctx.onFilters({ ...f, shipTypes: toggleIn(f.shipTypes, t) })} />
              <span className="size-1.5 rounded-full" style={{ background: SHIP_COLOR[t] }} aria-hidden /> {t}
            </label>
          ))}
        </fieldset>
      )
    case 'quakes':
      return (
        <div className="px-1.5 text-xs">
          <p className="hud-label mb-1">Smallest magnitude</p>
          <div className="flex gap-1">
            {[4, 5, 6, 7].map(m => (
              <button key={m} type="button" className={`map-chip h-7 px-2.5 ${f.quakeMinMag === m ? 'border-accent text-accent' : ''}`} onClick={() => ctx.onFilters({ ...f, quakeMinMag: m })}>
                M{m}+
              </button>
            ))}
          </div>
        </div>
      )
    case 'events': {
      const kinds = mixBy(ctx.sources.events, 'category').map(m => m.value)
      return kinds.length ? (
        <fieldset className="px-1.5 text-xs">
          <legend className="hud-label mb-1">Show (none ticked shows all)</legend>
          {kinds.map(k => (
            <label key={k} className="flex items-center gap-1.5 py-0.5">
              <input type="checkbox" checked={f.eventTypes.includes(k)} onChange={() => ctx.onFilters({ ...f, eventTypes: toggleIn(f.eventTypes, k) })} /> {k}
            </label>
          ))}
        </fieldset>
      ) : (
        <Empty>No events to filter right now.</Empty>
      )
    }
    case 'news':
      return (
        <fieldset className="px-1.5 text-xs">
          <legend className="hud-label mb-1">Show (none ticked shows all)</legend>
          {CATEGORIES.map(k => (
            <label key={k} className="flex items-center gap-1.5 py-0.5 capitalize">
              <input type="checkbox" checked={f.newsTypes.includes(k)} onChange={() => ctx.onFilters({ ...f, newsTypes: toggleIn(f.newsTypes, k) })} /> {k}
            </label>
          ))}
        </fieldset>
      )
    case 'disasters':
      return (
        <div className="px-1.5 text-xs">
          <p className="hud-label mb-1">Show</p>
          <div className="flex gap-1">
            {(['All', 'Orange and red', 'Red only'] as const).map((label, n) => (
              <button key={label} type="button" className={`map-chip h-7 px-2.5 ${f.disasterMinAlert === n ? 'border-accent text-accent' : ''}`} onClick={() => ctx.onFilters({ ...f, disasterMinAlert: n })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )
    default:
      return <Empty>No filters for this layer.</Empty>
  }
}

export function LayerRail({ on, counts, onToggle, ctx }: { on: Record<LayerId, boolean>; counts: Partial<Record<LayerId, number>>; onToggle: (id: LayerId) => void; ctx: RailContext }) {
  const [open, setOpen] = useState<LayerId | null>(null)
  const [pinned, setPinned] = useState(false)
  const [tab, setTab] = useState<'now' | 'filters'>('now')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const enter = (id: LayerId) => {
    clearTimeout(timer.current)
    if (pinned && open) return
    timer.current = setTimeout(() => setOpen(id), open ? 0 : 150)
  }
  const leave = () => {
    clearTimeout(timer.current)
    if (!pinned) timer.current = setTimeout(() => setOpen(null), 250)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (setOpen(null), setPinned(false))
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="pointer-events-none absolute right-2 top-[104px] z-10 hidden @[640px]:block" onMouseLeave={leave}>
      <nav aria-label="Map layers" className="glass pointer-events-auto flex w-[52px] flex-col gap-0.5 rounded-xl bg-solid/85 p-1 shadow-xl">
        {RAIL.map(r => {
          const Icon = r.icon
          const visible = on[r.id]
          const n = (ctx.sources[r.id]?.features ?? []).filter(f => passesFilter(r.id, f.properties, ctx.filters)).length
          const count = counts[r.id] === undefined && !n ? null : n
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => onToggle(r.id)}
              onMouseEnter={() => enter(r.id)}
              onFocus={() => enter(r.id)}
              aria-pressed={visible}
              aria-keyshortcuts={r.key.toUpperCase()}
              title={`${layerDef(r.id).label} (${r.key.toUpperCase()}): click to ${visible ? 'hide' : 'show'}`}
              className={`relative flex flex-col items-center rounded-lg py-1 transition-colors hover:bg-surface ${open === r.id ? 'bg-surface' : ''} ${visible ? '' : 'opacity-40'}`}
            >
              <Icon className="size-4" style={{ color: visible ? layerDef(r.id).dot : undefined }} aria-hidden />
              <span className="font-mono text-[9.5px] leading-tight">{count === null ? '–' : fmtCount(count)}</span>
              <span className="absolute right-0.5 top-0 font-mono text-[8px] text-muted/70">{r.key.toUpperCase()}</span>
            </button>
          )
        })}
      </nav>
      {open && (
        <section
          aria-label={`${layerDef(open).label} panel`}
          onMouseEnter={() => clearTimeout(timer.current)}
          className="peek-card glass pointer-events-auto absolute right-[60px] top-0 flex max-h-[min(70vh,560px)] w-[300px] flex-col overflow-hidden rounded-xl bg-solid/92 shadow-2xl"
        >
          <header className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="size-2 rounded-full" style={{ background: layerDef(open).dot }} aria-hidden />
            <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{layerDef(open).label}</h3>
            <button type="button" className="icon-btn size-7" onClick={() => setPinned(p => !p)} aria-pressed={pinned} aria-label={pinned ? 'Unpin the panel' : 'Keep the panel open'} title={pinned ? 'Unpin' : 'Keep open'}>
              {pinned ? <PinOff className="size-3.5" aria-hidden /> : <Pin className="size-3.5" aria-hidden />}
            </button>
          </header>
          <div className="flex gap-1 border-b border-border px-2 py-1" role="tablist">
            {(['now', 'filters'] as const).map(t => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-md px-2 py-0.5 text-xs ${tab === t ? 'bg-surface text-accent' : 'text-muted hover:text-text'}`}>
                {t === 'now' ? 'Now' : 'Filters'}
              </button>
            ))}
            {!on[open] && (
              <button type="button" className="ml-auto text-[11px] text-accent hover:underline" onClick={() => onToggle(open)}>
                Show on map
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{tab === 'now' ? <NowTab id={open} ctx={ctx} /> : <FiltersTab id={open} ctx={ctx} />}</div>
        </section>
      )}
    </div>
  )
}
