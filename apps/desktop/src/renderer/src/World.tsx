import 'maplibre-gl/dist/maplibre-gl.css'

import { Globe2, MapPin, Plus, RefreshCw, Trash2, Wind } from 'lucide-react'
import maplibregl, { type GeoJSONSource, type Map as MapLibre } from 'maplibre-gl'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'

import { ATTRIBUTION, EMPTY_WORLD, type PlaceStatus, type WorldSnapshot } from '../../shared/world.ts'
import { ago, useNow } from './Jarvis.tsx'

const cleanError = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'

const STYLE = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/positron',
}

const EVENT_COLOR: Record<string, string> = { Wildfires: '#f97316', 'Severe Storms': '#a78bfa', Volcanoes: '#ef4444', Floods: '#38bdf8' }

const aqiColor = (aqi: number) => (aqi <= 50 ? 'bg-ok/20 text-ok' : aqi <= 100 ? 'bg-yellow-400/20 text-yellow-300' : aqi <= 150 ? 'bg-orange-400/20 text-orange-300' : aqi <= 200 ? 'bg-red-500/20 text-red-300' : 'bg-fuchsia-500/25 text-fuchsia-300')

/** Minimal GeoJSON shapes for the map sources. */
interface PointGeometry {
  type: 'Point'
  coordinates: number[]
}
interface FC {
  type: 'FeatureCollection'
  features: { type: 'Feature'; geometry: PointGeometry; properties: Record<string, string | number> }[]
}

const toFeatures = (w: WorldSnapshot): { places: FC; quakes: FC; events: FC } => ({
  places: { type: 'FeatureCollection', features: w.places.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.place.lon, p.place.lat] }, properties: { title: p.place.name } })) },
  quakes: {
    type: 'FeatureCollection',
    features: w.quakes.map(q => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [q.lon, q.lat] }, properties: { title: `M${q.mag.toFixed(1)} · ${q.place}`, mag: q.mag, url: q.url, time: q.time } })),
  },
  events: {
    type: 'FeatureCollection',
    features: w.events.map(e => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.lon, e.lat] }, properties: { title: `${e.category}: ${e.title}`, color: EVENT_COLOR[e.category] ?? '#94a3b8', url: e.url, time: e.time } })),
  },
})

/** The map: places, earthquakes (size by magnitude) and natural events, with a card on click. */
function WorldMap({ world }: { world: WorldSnapshot }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibre | null>(null)
  const fitted = useRef(false)
  const data = useMemo(() => toFeatures(world), [world])
  const dataRef = useRef(data)
  dataRef.current = data

  useEffect(() => {
    if (!box.current) return
    const dark = !window.matchMedia('(prefers-color-scheme: light)').matches
    const m = new maplibregl.Map({ container: box.current, style: dark ? STYLE.dark : STYLE.light, center: [70, 28], zoom: 2.2, attributionControl: { compact: true } })
    map.current = m
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    m.on('load', () => {
      const d = dataRef.current
      m.addSource('quakes', { type: 'geojson', data: d.quakes })
      m.addSource('events', { type: 'geojson', data: d.events })
      m.addSource('places', { type: 'geojson', data: d.places })
      m.addLayer({
        id: 'quakes',
        type: 'circle',
        source: 'quakes',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'mag'], 4, 4, 6, 9, 8, 16],
          'circle-color': ['interpolate', ['linear'], ['get', 'mag'], 4, '#facc15', 5.5, '#f97316', 7, '#ef4444'],
          'circle-opacity': 0.75,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#0b1020',
        },
      })
      m.addLayer({ id: 'events', type: 'circle', source: 'events', paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-width': 1, 'circle-stroke-color': '#0b1020' } })
      m.addLayer({ id: 'places', type: 'circle', source: 'places', paint: { 'circle-radius': 7, 'circle-color': '#22d3ee', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } })
      m.addLayer({
        id: 'place-labels',
        type: 'symbol',
        source: 'places',
        layout: { 'text-field': ['get', 'title'], 'text-offset': [0, 1.3], 'text-size': 12, 'text-anchor': 'top' },
        paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0b1020', 'text-halo-width': 1.5 },
      })
      for (const layer of ['quakes', 'events', 'places']) {
        m.on('click', layer, e => {
          const f = e.features?.[0]
          if (!f) return
          const p = f.properties as Record<string, string | number>
          const el = document.createElement('div')
          el.className = 'text-xs text-slate-900'
          const title = document.createElement('p')
          title.className = 'font-medium'
          title.textContent = String(p.title)
          el.append(title)
          if (p.time) {
            const t = document.createElement('p')
            t.textContent = new Date(Number(p.time)).toLocaleString()
            el.append(t)
          }
          if (typeof p.url === 'string' && p.url.startsWith('https://')) {
            const a = document.createElement('a')
            a.href = p.url
            a.target = '_blank'
            a.rel = 'noreferrer'
            a.textContent = 'Source'
            a.className = 'underline'
            el.append(a)
          }
          new maplibregl.Popup({ closeButton: false }).setLngLat((f.geometry as unknown as PointGeometry).coordinates as [number, number]).setDOMContent(el).addTo(m)
        })
        m.on('mouseenter', layer, () => (m.getCanvas().style.cursor = 'pointer'))
        m.on('mouseleave', layer, () => (m.getCanvas().style.cursor = ''))
      }
    })
    const resize = new ResizeObserver(() => m.resize())
    resize.observe(box.current)
    return () => {
      resize.disconnect()
      m.remove()
      map.current = null
    }
  }, [])

  // New data: update the sources; frame the places the first time there are some.
  useEffect(() => {
    const m = map.current
    if (!m || !m.isStyleLoaded()) return
    ;(m.getSource('quakes') as GeoJSONSource | undefined)?.setData(data.quakes)
    ;(m.getSource('events') as GeoJSONSource | undefined)?.setData(data.events)
    ;(m.getSource('places') as GeoJSONSource | undefined)?.setData(data.places)
    if (!fitted.current && data.places.features.length) {
      fitted.current = true
      const b = new maplibregl.LngLatBounds()
      for (const f of data.places.features) b.extend(f.geometry.coordinates as [number, number])
      m.fitBounds(b, { padding: 80, maxZoom: 6, duration: 0 })
    }
  }, [data])

  return <div ref={box} className="h-full min-h-[260px] w-full overflow-hidden rounded-xl" aria-label="World map" role="region" />
}

function PlaceCard({ s, now, onRemove }: { s: PlaceStatus; now: number; onRemove: () => void }) {
  const w = s.weather
  return (
    <article className="tile space-y-2 p-3">
      <header className="flex items-center gap-2">
        <MapPin className="size-4 text-accent" aria-hidden />
        <h3 className="min-w-0 flex-1 truncate font-medium">
          {s.place.name}
          {s.place.country ? <span className="text-xs font-normal text-muted"> · {s.place.country}</span> : null}
        </h3>
        {s.air && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] ${aqiColor(s.air.aqi)}`} title={`PM2.5 ${s.air.pm25} µg/m³`}>
            AQI {s.air.aqi >= 500 ? '500+' : s.air.aqi} · {s.air.level}
          </span>
        )}
        <button type="button" className="icon-btn size-7" onClick={onRemove} aria-label={`Stop watching ${s.place.name}`} title="Stop watching">
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      </header>
      {w ? (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <span className="font-mono text-2xl">{Math.round(w.temp)}°</span>
          <span className="text-muted">
            {w.summary} · feels {Math.round(w.feels)}° · <Wind className="inline size-3" aria-hidden /> {Math.round(w.wind)} km/h
          </span>
          {w.days.map((d, i) => (
            <span key={d.date} className="text-xs text-muted">
              {i === 0 ? 'Today' : 'Tomorrow'} {Math.round(d.min)}–{Math.round(d.max)}° {d.rain ? `· ${d.rain} mm` : ''}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">Loading weather…</p>
      )}
      {s.nearby.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {s.nearby.slice(0, 3).map(n => (
            <li key={n.id} className="truncate text-warm" title={n.title}>
              {n.title} · {n.km} km
            </li>
          ))}
        </ul>
      )}
      {s.news.length > 0 && (
        <ul className="space-y-1 border-t border-border pt-2">
          {s.news.slice(0, 4).map(n => (
            <li key={n.url} className="text-xs">
              <a href={n.url} target="_blank" rel="noreferrer" className="line-clamp-2 hover:text-accent" dir="auto">
                {n.title}
              </a>
              <span className="text-[11px] text-muted">
                {n.domain}
                {n.time ? ` · ${ago(n.time, now)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

/**
 * World: the places you care about, live. Weather and air quality, earthquakes
 * and natural events nearby, and local news, from free open sources. Atlas
 * speaks up on its own when something serious happens near one of them.
 */
export function WorldPage() {
  const now = useNow(60_000)
  const [world, setWorld] = useState<WorldSnapshot>(EMPTY_WORLD)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.world.state().then(setWorld, err => setError(cleanError(err)))
    return window.world.onChanged(setWorld)
  }, [])

  const run = async (fn: () => Promise<WorldSnapshot>) => {
    setBusy(true)
    setError('')
    try {
      setWorld(await fn())
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    void run(() => window.world.add(name.trim())).then(() => setName(''))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <Globe2 className="size-4 text-accent" aria-hidden />
        <h2 className="font-semibold">World</h2>
        <form onSubmit={add} className="ml-auto flex min-w-0 flex-1 justify-end gap-2 sm:flex-none">
          <input className="field min-w-0 flex-1 py-1 text-sm sm:w-56" placeholder="Add a city, e.g. Lahore or Riyadh" value={name} onChange={e => setName(e.target.value)} aria-label="Add a place to watch" />
          <button type="submit" className="btn" disabled={busy || !name.trim()}>
            <Plus className="size-3.5" aria-hidden /> Watch
          </button>
        </form>
        <button type="button" className="btn" onClick={() => void run(() => window.world.refresh())} disabled={busy} aria-label="Refresh now">
          <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden />
        </button>
      </header>
      {error && (
        <p role="alert" className="px-4 pt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(260px,45%)_1fr] gap-3 overflow-hidden p-3 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] lg:grid-rows-1">
        <WorldMap world={world} />
        <section className="min-h-0 space-y-2 overflow-y-auto pr-1" aria-label="Your places">
          {world.places.length === 0 && (
            <p className="tile px-3 py-4 text-sm text-muted">Add the places you care about: your city, where family or clients are, a trip. I’ll tell you about dangerous air, extreme weather, earthquakes or fires near them.</p>
          )}
          {world.places.map(s => (
            <PlaceCard key={s.place.id} s={s} now={now} onRemove={() => void run(() => window.world.remove(s.place.id))} />
          ))}
          <p className="px-1 text-[11px] text-muted">
            {world.updatedAt ? `Updated ${ago(world.updatedAt, now)} · ` : ''}
            {world.quakes.length} earthquakes (M4+, 2 days) · {world.events.length} open natural events
            {world.problems.length ? ` · unavailable: ${world.problems.map(p => p.split(':')[0]).join(', ')}` : ''}
          </p>
          <p className="px-1 text-[10px] leading-snug text-muted">{ATTRIBUTION}</p>
        </section>
      </div>
    </div>
  )
}
