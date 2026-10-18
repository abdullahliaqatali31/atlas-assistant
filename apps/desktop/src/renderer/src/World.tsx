import 'maplibre-gl/dist/maplibre-gl.css'

import { Globe2, MapPin, Plus, RefreshCw, Trash2, Wind } from 'lucide-react'
import maplibregl, { type GeoJSONSource, type Map as MapLibre } from 'maplibre-gl'
import * as satellite from 'satellite.js'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'

import { ATTRIBUTION, CAMERA_COVERAGE, EMPTY_WORLD, type Flight, type PlaceStatus, type Ship, type ShipsResult, type WorldSnapshot } from '../../shared/world.ts'
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

type LayerId = 'places' | 'quakes' | 'events' | 'flights' | 'ships' | 'satellites' | 'cameras'
const LAYERS: { id: LayerId; label: string; dot: string }[] = [
  { id: 'places', label: 'Your places', dot: '#22d3ee' },
  { id: 'flights', label: 'Flights (live)', dot: '#fbbf24' },
  { id: 'ships', label: 'Ships (live)', dot: '#34d399' },
  { id: 'cameras', label: 'Public cameras', dot: '#2dd4bf' },
  { id: 'satellites', label: 'Satellites & ISS', dot: '#c084fc' },
  { id: 'quakes', label: 'Earthquakes (M4+)', dot: '#f97316' },
  { id: 'events', label: 'Fires, storms, volcanoes, floods', dot: '#ef4444' },
]
/** Map layers drawn for each switch. */
const MAP_LAYERS: Record<LayerId, string[]> = { places: ['places', 'place-labels'], quakes: ['quakes'], events: ['events'], flights: ['flights', 'flight-labels'], ships: ['ships', 'ship-labels'], cameras: ['cameras'], satellites: ['satellites', 'satellite-labels'] }

const readLayers = (): Record<LayerId, boolean> => {
  const all = { places: true, quakes: true, events: true, flights: true, ships: true, satellites: true, cameras: true }
  try {
    return { ...all, ...(JSON.parse(localStorage.getItem('world.layers') ?? '{}') as Partial<Record<LayerId, boolean>>) }
  } catch {
    return all
  }
}

/** An arrow pointing up, drawn once; tinted per aircraft (signed distance field). */
const planeIcon = () => {
  const size = 32
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.beginPath()
  g.moveTo(16, 2)
  g.lineTo(27, 28)
  g.lineTo(16, 22)
  g.lineTo(5, 28)
  g.closePath()
  g.fill()
  return g.getImageData(0, 0, size, size)
}

/** A boat seen from above, pointing up; tinted per type. */
const shipIcon = () => {
  const size = 32
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.beginPath()
  g.moveTo(16, 3)
  g.lineTo(23, 13)
  g.lineTo(22, 29)
  g.lineTo(10, 29)
  g.lineTo(9, 13)
  g.closePath()
  g.fill()
  return g.getImageData(0, 0, size, size)
}

const SHIP_COLOR: Record<string, string> = { Cargo: '#34d399', Tanker: '#f87171', Passenger: '#60a5fa', Fishing: '#fbbf24', Military: '#ef4444', Tug: '#a3e635', Pleasure: '#f0abfc', 'High speed': '#22d3ee', Service: '#a3a3a3', Other: '#94a3b8' }

const shipFeatures = (ships: Ship[]): FC => ({
  type: 'FeatureCollection',
  features: ships.map(v => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
    properties: {
      title: `${v.name || `MMSI ${v.mmsi}`} · ${v.category}`,
      detail: `${v.speed.toFixed(1)} kn${v.destination ? ` · to ${v.destination}` : ''}${v.length ? ` · ${v.length} m` : ''}`,
      name: v.name,
      rotation: v.heading ?? v.course,
      color: SHIP_COLOR[v.category] ?? SHIP_COLOR.Other!,
      time: v.at,
    },
  })),
})

const flightFeatures = (flights: Flight[]): FC => ({
  type: 'FeatureCollection',
  features: flights.map(f => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
    properties: {
      title: `${f.callsign || f.registration || f.hex}${f.type ? ` · ${f.type}` : ''}${f.military ? ' · military' : ''}`,
      detail: `${f.altitude === null ? 'On the ground' : `${Math.round(f.altitude).toLocaleString()} ft`} · ${Math.round(f.speed)} kt${f.registration ? ` · ${f.registration}` : ''}`,
      callsign: f.callsign,
      track: f.track,
      color: f.military ? '#ef4444' : '#fbbf24',
    },
  })),
})

/** Satellite positions now, from their orbit elements. */
const satelliteFeatures = (sats: { name: string; rec: satellite.SatRec }[], at: Date): FC => {
  const gmst = satellite.gstime(at)
  const features: FC['features'] = []
  for (const s of sats) {
    const pv = satellite.propagate(s.rec, at)
    if (!pv || typeof pv.position !== 'object' || !pv.position) continue
    const geo = satellite.eciToGeodetic(pv.position, gmst)
    const iss = /^ISS \(ZARYA\)/.test(s.name)
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [satellite.degreesLong(geo.longitude), satellite.degreesLat(geo.latitude)] },
      properties: { title: iss ? 'ISS · International Space Station' : s.name, detail: `${Math.round(geo.height)} km up`, label: iss ? 'ISS' : '', size: iss ? 7 : 3.5 },
    })
  }
  return { type: 'FeatureCollection', features }
}

/** The map: places, live flights, satellites, earthquakes and natural events, with switches and a card on click. */
function WorldMap({ world }: { world: WorldSnapshot }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibre | null>(null)
  const [ready, setReady] = useState(false)
  const fitted = useRef(false)
  const [layers, setLayers] = useState(readLayers)
  const [counts, setCounts] = useState<Partial<Record<LayerId, number>>>({})
  const [flightNote, setFlightNote] = useState('')
  const [shipState, setShipState] = useState<{ status: ShipsResult['status']; message: string | null }>({ status: 'off', message: null })
  const [shipKey, setShipKey] = useState('')
  const [shipKeyError, setShipKeyError] = useState('')
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
      const empty: FC = { type: 'FeatureCollection', features: [] }
      m.addImage('plane', planeIcon(), { sdf: true })
      m.addImage('ship', shipIcon(), { sdf: true })
      for (const [id, fc] of [['quakes', d.quakes], ['events', d.events], ['places', d.places], ['flights', empty], ['ships', empty], ['satellites', empty], ['cameras', empty]] as const) m.addSource(id, { type: 'geojson', data: fc })
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
      m.addLayer({
        id: 'cameras',
        type: 'circle',
        source: 'cameras',
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2, 10, 5], 'circle-color': '#2dd4bf', 'circle-opacity': 0.8, 'circle-stroke-width': 0.5, 'circle-stroke-color': '#0b1020' },
      })
      // A camera opens its latest frame, fetched by Atlas (the page itself loads only map tiles).
      m.on('click', 'cameras', e => {
        const f = e.features?.[0]
        if (!f) return
        const p = f.properties as Record<string, string>
        const el = document.createElement('div')
        el.className = 'w-64 text-xs text-slate-900'
        const title = document.createElement('p')
        title.className = 'font-medium'
        title.textContent = p.title ?? 'Camera'
        const img = document.createElement('img')
        img.alt = p.title ?? 'Camera snapshot'
        img.className = 'mt-1 w-full rounded bg-slate-200'
        img.style.minHeight = '120px'
        const meta = document.createElement('p')
        meta.className = 'mt-1 text-[10px] text-slate-600'
        meta.textContent = 'Loading the latest frame…'
        const again = document.createElement('button')
        again.type = 'button'
        again.className = 'mt-1 underline'
        again.textContent = 'Refresh'
        const load = () => {
          meta.textContent = 'Loading the latest frame…'
          void window.world.cameraImage(p.id!).then(
            r => {
              img.src = r.dataUrl
              meta.textContent = `${p.source} · ${new Date(r.at).toLocaleTimeString()}`
            },
            () => (meta.textContent = `${p.source} · image unavailable right now`),
          )
        }
        again.addEventListener('click', load)
        el.append(title, img, meta, again)
        load()
        new maplibregl.Popup({ closeButton: true, maxWidth: '300px' }).setLngLat((f.geometry as unknown as PointGeometry).coordinates as [number, number]).setDOMContent(el).addTo(m)
      })
      m.on('mouseenter', 'cameras', () => (m.getCanvas().style.cursor = 'pointer'))
      m.on('mouseleave', 'cameras', () => (m.getCanvas().style.cursor = ''))
      m.addLayer({ id: 'events', type: 'circle', source: 'events', paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-opacity': 0.85, 'circle-stroke-width': 1, 'circle-stroke-color': '#0b1020' } })
      m.addLayer({ id: 'satellites', type: 'circle', source: 'satellites', paint: { 'circle-radius': ['get', 'size'], 'circle-color': '#c084fc', 'circle-stroke-width': 1, 'circle-stroke-color': '#0b1020' } })
      m.addLayer({
        id: 'satellite-labels',
        type: 'symbol',
        source: 'satellites',
        layout: { 'text-field': ['get', 'label'], 'text-offset': [0, 1.1], 'text-size': 11, 'text-anchor': 'top' },
        paint: { 'text-color': '#e9d5ff', 'text-halo-color': '#0b1020', 'text-halo-width': 1.5 },
      })
      m.addLayer({
        id: 'ships',
        type: 'symbol',
        source: 'ships',
        layout: { 'icon-image': 'ship', 'icon-size': 0.45, 'icon-rotate': ['get', 'rotation'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true },
        paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': '#0b1020', 'icon-halo-width': 1 },
      })
      m.addLayer({
        id: 'ship-labels',
        type: 'symbol',
        source: 'ships',
        minzoom: 8,
        layout: { 'text-field': ['get', 'name'], 'text-offset': [0, 1.1], 'text-size': 10, 'text-anchor': 'top' },
        paint: { 'text-color': '#a7f3d0', 'text-halo-color': '#0b1020', 'text-halo-width': 1.5 },
      })
      m.addLayer({
        id: 'flights',
        type: 'symbol',
        source: 'flights',
        layout: { 'icon-image': 'plane', 'icon-size': 0.55, 'icon-rotate': ['get', 'track'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true },
        paint: { 'icon-color': ['get', 'color'], 'icon-halo-color': '#0b1020', 'icon-halo-width': 1 },
      })
      m.addLayer({
        id: 'flight-labels',
        type: 'symbol',
        source: 'flights',
        minzoom: 6.5,
        layout: { 'text-field': ['get', 'callsign'], 'text-offset': [0, 1.2], 'text-size': 10, 'text-anchor': 'top' },
        paint: { 'text-color': '#fde68a', 'text-halo-color': '#0b1020', 'text-halo-width': 1.5 },
      })
      m.addLayer({ id: 'places', type: 'circle', source: 'places', paint: { 'circle-radius': 7, 'circle-color': '#22d3ee', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } })
      m.addLayer({
        id: 'place-labels',
        type: 'symbol',
        source: 'places',
        layout: { 'text-field': ['get', 'title'], 'text-offset': [0, 1.3], 'text-size': 12, 'text-anchor': 'top' },
        paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0b1020', 'text-halo-width': 1.5 },
      })
      for (const layer of ['quakes', 'events', 'places', 'flights', 'ships', 'satellites']) {
        m.on('click', layer, e => {
          const f = e.features?.[0]
          if (!f) return
          const p = f.properties as Record<string, string | number>
          const el = document.createElement('div')
          el.className = 'text-xs text-slate-900'
          const line = (text: string, cls = '') => {
            const x = document.createElement('p')
            x.className = cls
            x.textContent = text
            el.append(x)
          }
          line(String(p.title), 'font-medium')
          if (p.detail) line(String(p.detail))
          if (p.time) line(new Date(Number(p.time)).toLocaleString())
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
      setReady(true)
      // The stage may still be settling its size when the map starts (lazy page, opening drawer): measure again.
      m.resize()
      setTimeout(() => m.resize(), 300)
    })
    const resize = new ResizeObserver(() => m.resize())
    resize.observe(box.current)
    return () => {
      resize.disconnect()
      m.remove()
      map.current = null
    }
  }, [])

  // Places, quakes and events: update the sources; frame the places the first time.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    ;(m.getSource('quakes') as GeoJSONSource | undefined)?.setData(data.quakes)
    ;(m.getSource('events') as GeoJSONSource | undefined)?.setData(data.events)
    ;(m.getSource('places') as GeoJSONSource | undefined)?.setData(data.places)
    setCounts(c => ({ ...c, places: data.places.features.length, quakes: data.quakes.features.length, events: data.events.features.length }))
    if (!fitted.current && data.places.features.length) {
      fitted.current = true
      const b = new maplibregl.LngLatBounds()
      for (const f of data.places.features) b.extend(f.geometry.coordinates as [number, number])
      m.fitBounds(b, { padding: 80, maxZoom: 5.5, duration: 0 })
    }
  }, [data, ready])

  // Switches: show or hide each group of map layers, remembered.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    for (const id of Object.keys(MAP_LAYERS) as LayerId[]) for (const l of MAP_LAYERS[id]) m.setLayoutProperty(l, 'visibility', layers[id] ? 'visible' : 'none')
    try {
      localStorage.setItem('world.layers', JSON.stringify(layers))
    } catch {
      // Remembering the switches is a convenience only.
    }
  }, [layers, ready])

  // Live flights around the map's centre: when it stops moving and every 20 s, if zoomed in enough.
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !layers.flights) return
    let stopped = false
    const load = async () => {
      if (stopped || document.hidden) return
      if (m.getZoom() < 4) {
        setFlightNote('Zoom in to see flights')
        ;(m.getSource('flights') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] })
        setCounts(c => ({ ...c, flights: 0 }))
        return
      }
      const c = m.getCenter()
      try {
        const flights = await window.world.flights(c.lat, c.lng, 250)
        if (stopped) return
        ;(m.getSource('flights') as GeoJSONSource | undefined)?.setData(flightFeatures(flights))
        setCounts(x => ({ ...x, flights: flights.length }))
        setFlightNote('Within 250 nm of the map centre')
      } catch {
        setFlightNote('Flights unavailable right now')
      }
    }
    void load()
    let debounce: ReturnType<typeof setTimeout> | null = null
    const onMove = () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => void load(), 600)
    }
    m.on('moveend', onMove)
    const timer = setInterval(() => void load(), 20_000)
    return () => {
      stopped = true
      m.off('moveend', onMove)
      clearInterval(timer)
      if (debounce) clearTimeout(debounce)
    }
  }, [ready, layers.flights])

  // Ships in the area on screen (the owner's AISStream key): when the map stops and every 8 s.
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !layers.ships) return
    let stopped = false
    const load = async () => {
      if (stopped || document.hidden) return
      const b = m.getBounds()
      const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v))
      try {
        const r = await window.world.ships({ south: clamp(b.getSouth(), 90), north: clamp(b.getNorth(), 90), west: clamp(b.getWest(), 180), east: clamp(b.getEast(), 180) })
        if (stopped) return
        setShipState({ status: r.status, message: r.message })
        ;(m.getSource('ships') as GeoJSONSource | undefined)?.setData(shipFeatures(r.ships))
        setCounts(c => ({ ...c, ships: r.ships.length }))
      } catch {
        setShipState({ status: 'error', message: 'Ships unavailable right now.' })
      }
    }
    void load()
    let debounce: ReturnType<typeof setTimeout> | null = null
    const onMove = () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => void load(), 600)
    }
    m.on('moveend', onMove)
    const timer = setInterval(() => void load(), 8_000)
    return () => {
      stopped = true
      m.off('moveend', onMove)
      clearInterval(timer)
      if (debounce) clearTimeout(debounce)
    }
  }, [ready, layers.ships, shipState.status === 'no-key'])

  const saveShipKey = async (key: string | null) => {
    setShipKeyError('')
    try {
      await window.world.setShipsKey(key)
      setShipKey('')
      setShipState({ status: key ? 'connecting' : 'no-key', message: null })
    } catch (err) {
      setShipKeyError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not save the key.')
    }
  }

  // Public cameras: the list once (only where official open feeds exist).
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !layers.cameras) return
    let stopped = false
    void window.world.cameras().then(list => {
      if (stopped) return
      ;(m.getSource('cameras') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: list.map(c => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lon, c.lat] }, properties: { id: c.id, title: c.name, source: c.source } })),
      })
      setCounts(x => ({ ...x, cameras: list.length }))
    }, () => undefined)
    return () => {
      stopped = true
    }
  }, [ready, layers.cameras])

  // Satellites: orbit elements once, positions every 2 s.
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !layers.satellites) return
    let stopped = false
    let sats: { name: string; rec: satellite.SatRec }[] = []
    const draw = () => {
      if (stopped || document.hidden || !sats.length) return
      ;(m.getSource('satellites') as GeoJSONSource | undefined)?.setData(satelliteFeatures(sats, new Date()))
    }
    void window.world.satellites().then(list => {
      sats = list.flatMap(s => {
        try {
          return [{ name: String(s.OBJECT_NAME ?? ''), rec: satellite.json2satrec(s as unknown as satellite.OMMJsonObject) }]
        } catch {
          return []
        }
      })
      setCounts(c => ({ ...c, satellites: sats.length }))
      draw()
    }, () => undefined)
    const timer = setInterval(draw, 2_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [ready, layers.satellites])

  return (
    <div className="relative h-full min-h-[260px] w-full overflow-hidden rounded-xl">
      <div ref={box} className="h-full w-full" aria-label="World map" role="region" />
      <fieldset className="glass absolute left-2 top-2 max-w-[calc(100%-4rem)] space-y-1 rounded-xl px-3 py-2 text-xs">
        <legend className="sr-only">Map layers</legend>
        {LAYERS.map(l => (
          <label key={l.id} className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={layers[l.id]} onChange={() => setLayers(x => ({ ...x, [l.id]: !x[l.id] }))} />
            <span className="size-2 shrink-0 rounded-full" style={{ background: l.dot }} aria-hidden />
            <span className="truncate">{l.label}</span>
            {layers[l.id] && counts[l.id] !== undefined && <span className="ml-auto pl-2 font-mono text-muted">{counts[l.id]}</span>}
          </label>
        ))}
        {layers.flights && flightNote && <p className="pl-6 text-[10px] text-muted">{flightNote}</p>}
        {layers.ships && shipState.status === 'connecting' && <p className="pl-6 text-[10px] text-muted">Connecting to AISStream… ships appear as they report</p>}
        {layers.ships && (shipState.status === 'no-key' || (shipState.status === 'error' && /key/i.test(shipState.message ?? ''))) && (
          <form
            className="space-y-1 pl-6 pt-1"
            onSubmit={e => {
              e.preventDefault()
              if (shipKey.trim()) void saveShipKey(shipKey.trim())
            }}
          >
            <p className="text-[10px] text-muted">
              {shipState.message ?? 'Ships need your free AISStream key:'}{' '}
              <a href="https://aisstream.io/apikeys" target="_blank" rel="noreferrer" className="text-accent underline">
                get one
              </a>
            </p>
            <div className="flex gap-1">
              <input type="password" autoComplete="off" spellCheck={false} className="field min-w-0 flex-1 py-0.5 text-[11px]" placeholder="Paste AISStream key" value={shipKey} onChange={e => setShipKey(e.target.value)} aria-label="AISStream API key" />
              <button type="submit" className="btn h-6 px-2 text-[11px]" disabled={!shipKey.trim()}>
                Save
              </button>
            </div>
            {shipKeyError && <p className="text-[10px] text-danger">{shipKeyError}</p>}
          </form>
        )}
        {layers.ships && shipState.status === 'error' && !/key/i.test(shipState.message ?? '') && <p className="pl-6 text-[10px] text-warm">{shipState.message}</p>}
        {layers.cameras && <p className="max-w-56 pl-6 text-[10px] leading-snug text-muted">Official open feeds only: {CAMERA_COVERAGE}</p>}
      </fieldset>
    </div>
  )
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
