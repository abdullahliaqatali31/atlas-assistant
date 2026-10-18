import 'maplibre-gl/dist/maplibre-gl.css'

import { Crosshair, ExternalLink, Info, Layers, MapPin, Plus, RefreshCw, Sparkles, Trash2, Wind, X } from 'lucide-react'
import maplibregl, { type GeoJSONSource, type Map as MapLibre } from 'maplibre-gl'
import * as satellite from 'satellite.js'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { ATTRIBUTION, CAMERA_COVERAGE, EMPTY_WORLD, type Flight, type PlaceStatus, type Ship, type ShipsResult, type WorldSnapshot } from '../../shared/world.ts'
import { ago, useNow } from './Jarvis.tsx'
import { ASK_EVENT } from './shell/live.ts'

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
  places: { type: 'FeatureCollection', features: w.places.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.place.lon, p.place.lat] }, properties: { id: p.place.id, title: p.place.name } })) },
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

/** Something picked on the map, shown in the Inspector. */
export interface Selected {
  kind: LayerId
  lngLat: [number, number]
  props: Record<string, string | number>
}

/** Map layers that can be picked, top-most first. */
const PICKABLE: { layer: string; kind: LayerId }[] = [
  { layer: 'places', kind: 'places' },
  { layer: 'cameras', kind: 'cameras' },
  { layer: 'flights', kind: 'flights' },
  { layer: 'ships', kind: 'ships' },
  { layer: 'satellites', kind: 'satellites' },
  { layer: 'events', kind: 'events' },
  { layer: 'quakes', kind: 'quakes' },
]

const KIND_LABEL: Record<LayerId, string> = { places: 'Your place', flights: 'Flight', ships: 'Ship', satellites: 'Satellite', cameras: 'Public camera', quakes: 'Earthquake', events: 'Natural event' }

/**
 * The map, full-bleed: every layer, a floating toolbar (top), the layer
 * switches in a popover, and a click picks an item for the Inspector.
 */
function WorldMap({
  world,
  selected,
  onSelect,
  focus,
  toolbar,
}: {
  world: WorldSnapshot
  selected: Selected | null
  onSelect: (s: Selected | null) => void
  focus: { lngLat: [number, number]; zoom?: number; n: number } | null
  toolbar: (layersButton: ReactNode) => ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibre | null>(null)
  const [ready, setReady] = useState(false)
  const fitted = useRef(false)
  const [layers, setLayers] = useState(readLayers)
  const [layersOpen, setLayersOpen] = useState(false)
  const [counts, setCounts] = useState<Partial<Record<LayerId, number>>>({})
  const [flightNote, setFlightNote] = useState('')
  const [shipState, setShipState] = useState<{ status: ShipsResult['status']; message: string | null }>({ status: 'off', message: null })
  const [shipKey, setShipKey] = useState('')
  const [shipKeyError, setShipKeyError] = useState('')
  const data = useMemo(() => toFeatures(world), [world])
  const dataRef = useRef(data)
  dataRef.current = data
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect

  useEffect(() => {
    if (!box.current) return
    const dark = document.documentElement.dataset.theme !== 'daylight'
    const m = new maplibregl.Map({ container: box.current, style: dark ? STYLE.dark : STYLE.light, center: [70, 28], zoom: 2.2, attributionControl: false })
    map.current = m
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    // Map credits under the zoom buttons, clear of the Ask bar and the corner widget.
    m.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-right')
    m.on('load', () => {
      const d = dataRef.current
      const empty: FC = { type: 'FeatureCollection', features: [] }
      m.addImage('plane', planeIcon(), { sdf: true })
      m.addImage('ship', shipIcon(), { sdf: true })
      for (const [id, fc] of [['quakes', d.quakes], ['events', d.events], ['places', d.places], ['flights', empty], ['ships', empty], ['satellites', empty], ['cameras', empty], ['selected', empty]] as const) m.addSource(id, { type: 'geojson', data: fc })
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
      // The picked item: a ring on top of everything.
      m.addLayer({ id: 'selected', type: 'circle', source: 'selected', paint: { 'circle-radius': 13, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff', 'circle-stroke-opacity': 0.9 } })

      // One click handler: the top-most item near the pointer, or nothing (closes the Inspector).
      m.on('click', e => {
        const live = PICKABLE.filter(p => m.getLayer(p.layer) && m.getLayoutProperty(p.layer, 'visibility') !== 'none')
        const r = 6
        const hits = m.queryRenderedFeatures(
          [
            [e.point.x - r, e.point.y - r],
            [e.point.x + r, e.point.y + r],
          ],
          { layers: live.map(p => p.layer) },
        )
        const order = (id: string) => PICKABLE.findIndex(p => p.layer === id)
        const hit = hits.sort((a, b) => order(a.layer.id) - order(b.layer.id))[0]
        if (!hit) return selectRef.current(null)
        const kind = PICKABLE.find(p => p.layer === hit.layer.id)!.kind
        selectRef.current({ kind, lngLat: (hit.geometry as unknown as PointGeometry).coordinates as [number, number], props: hit.properties as Record<string, string | number> })
      })
      for (const { layer } of PICKABLE) {
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

  // The ring around the picked item.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    ;(m.getSource('selected') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: selected ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: selected.lngLat }, properties: {} }] : [],
    })
  }, [selected, ready])

  // "Centre on map" and picking a place from the toolbar.
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !focus) return
    m.flyTo({ center: focus.lngLat, zoom: Math.max(m.getZoom(), focus.zoom ?? 6), duration: document.documentElement.dataset.lite === 'true' ? 0 : 900 })
  }, [focus, ready])

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
      setShipKeyError(cleanError(err) || 'Could not save the key.')
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

  const on = LAYERS.filter(l => layers[l.id]).length
  const layersButton = (
    <button type="button" onClick={() => setLayersOpen(o => !o)} aria-expanded={layersOpen} className={`map-chip ${layersOpen ? 'border-accent text-accent' : ''}`} title="Map layers">
      <Layers className="size-3.5" aria-hidden />
      <span className="hidden @[520px]:inline">Layers</span>
      <span className="font-mono text-[10px] text-muted">
        {on}/{LAYERS.length}
      </span>
    </button>
  )

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={box} className="h-full w-full" aria-label="World map" role="region" />
      {toolbar(layersButton)}
      {layersOpen && (
        <fieldset className="ask-pop glass absolute left-2 top-12 z-20 w-[min(280px,calc(100%-1rem))] space-y-1 rounded-xl bg-solid/90 px-3 py-2 text-xs shadow-2xl">
          <legend className="sr-only">Map layers</legend>
          {LAYERS.map(l => (
            <label key={l.id} className="flex cursor-pointer items-center gap-2 py-0.5">
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
          {layers.cameras && <p className="pl-6 text-[10px] leading-snug text-muted">Official open feeds only: {CAMERA_COVERAGE}</p>}
        </fieldset>
      )}
    </div>
  )
}

/** A watched place in detail: weather, air, what happened nearby and local news. */
function PlaceDetail({ s, now }: { s: PlaceStatus; now: number }) {
  const w = s.weather
  return (
    <div className="space-y-3">
      {w ? (
        <div className="flex items-end gap-3">
          <span className="font-mono text-4xl font-extralight">{Math.round(w.temp)}°</span>
          <div className="pb-1 text-xs text-muted">
            <p className="text-sm text-text">{w.summary}</p>
            <p>
              feels {Math.round(w.feels)}° · <Wind className="inline size-3" aria-hidden /> {Math.round(w.wind)} km/h · {w.humidity}%
            </p>
          </div>
          {s.air && (
            <span className={`ml-auto mb-1 rounded-full px-2 py-0.5 text-[11px] ${aqiColor(s.air.aqi)}`} title={`PM2.5 ${s.air.pm25} µg/m³ · PM10 ${s.air.pm10}`}>
              AQI {s.air.aqi >= 500 ? '500+' : s.air.aqi} · {s.air.level}
            </span>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">Loading weather…</p>
      )}
      {w && (
        <div className="grid grid-cols-2 gap-2">
          {w.days.map((d, i) => (
            <div key={d.date} className="rounded-lg bg-surface px-2.5 py-1.5 text-xs">
              <p className="text-muted">{i === 0 ? 'Today' : 'Tomorrow'}</p>
              <p className="font-mono">
                {Math.round(d.min)}–{Math.round(d.max)}°{d.rain ? <span className="text-muted"> · {d.rain} mm</span> : null}
              </p>
            </div>
          ))}
        </div>
      )}
      {s.nearby.length > 0 && (
        <section>
          <p className="hud-label mb-1">Nearby</p>
          <ul className="space-y-0.5 text-xs">
            {s.nearby.slice(0, 4).map(n => (
              <li key={n.id} className="flex gap-2 text-warm">
                <span className="min-w-0 flex-1 truncate" title={n.title}>
                  {n.title}
                </span>
                <span className="shrink-0 font-mono text-[10px]">{n.km} km</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {s.news.length > 0 && (
        <section>
          <p className="hud-label mb-1">Local news</p>
          <ul className="space-y-1.5">
            {s.news.slice(0, 5).map(n => (
              <li key={n.url} className="text-xs">
                <a href={n.url} target="_blank" rel="noreferrer" className="line-clamp-2 hover:text-accent" dir="auto">
                  {n.title}
                </a>
                <span className="text-[10px] text-muted">
                  {n.domain}
                  {n.time ? ` · ${ago(n.time, now)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** A public camera's latest frame, fetched by Atlas (the page itself loads only map tiles). */
function CameraDetail({ id, source }: { id: string; source: string }) {
  const [frame, setFrame] = useState<{ src: string; at: number } | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const load = useCallback(() => {
    setState('loading')
    void window.world.cameraImage(id).then(
      r => {
        setFrame({ src: r.dataUrl, at: r.at })
        setState('ok')
      },
      () => setState('error'),
    )
  }, [id])
  useEffect(() => {
    setFrame(null)
    load()
  }, [load])
  return (
    <div className="space-y-1.5">
      <div className="grid aspect-video place-items-center overflow-hidden rounded-lg bg-surface">
        {frame ? <img src={frame.src} alt="Latest camera frame" className="h-full w-full object-cover" /> : <span className="text-xs text-muted">{state === 'error' ? 'Image unavailable right now' : 'Loading the latest frame…'}</span>}
      </div>
      <p className="flex items-center gap-2 text-[11px] text-muted">
        <span className="flex-1">
          {source}
          {frame ? ` · ${new Date(frame.at).toLocaleTimeString()}` : ''}
        </span>
        <button type="button" className="text-accent hover:underline" onClick={load} disabled={state === 'loading'}>
          Refresh
        </button>
      </p>
    </div>
  )
}

/** The Inspector: what was picked on the map, with what you can do about it. */
function Inspector({ sel, world, now, onClose, onCentre, onRemovePlace }: { sel: Selected; world: WorldSnapshot; now: number; onClose: () => void; onCentre: () => void; onRemovePlace: (id: string) => void }) {
  const p = sel.props
  const place = sel.kind === 'places' ? world.places.find(x => x.place.id === p.id) : undefined
  const title = place ? place.place.name : String(p.title ?? KIND_LABEL[sel.kind])
  const dot = LAYERS.find(l => l.id === sel.kind)?.dot
  const [lon, lat] = sel.lngLat
  const where = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`
  const ask = () => {
    const about = place
      ? `my watched place ${place.place.name}`
      : `this ${KIND_LABEL[sel.kind].toLowerCase()} on the World map: ${title}${p.detail ? ` (${p.detail})` : ''} at ${where}`
    window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: `Tell me about ${about}.` }))
  }
  return (
    <aside aria-label={`${KIND_LABEL[sel.kind]}: ${title}`} className="ask-pop glass pointer-events-auto flex max-h-full min-h-0 flex-col overflow-hidden rounded-xl bg-solid/90 shadow-2xl">
      <header className="flex items-start gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            <span className="size-1.5 rounded-full" style={{ background: dot }} aria-hidden />
            {KIND_LABEL[sel.kind]}
          </p>
          <h3 className="truncate text-sm font-medium" title={title}>
            {title}
            {place?.place.country ? <span className="font-normal text-muted"> · {place.place.country}</span> : null}
          </h3>
        </div>
        <button type="button" className="icon-btn size-7" onClick={onClose} aria-label="Close the inspector" title="Close (Esc)">
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm">
        {place ? (
          <PlaceDetail s={place} now={now} />
        ) : sel.kind === 'cameras' ? (
          <CameraDetail id={String(p.id)} source={String(p.source ?? '')} />
        ) : (
          <>
            {p.detail && <p>{String(p.detail)}</p>}
            {p.time && <p className="text-xs text-muted">{ago(Number(p.time), now)} · {new Date(Number(p.time)).toLocaleString()}</p>}
            {(sel.kind === 'flights' || sel.kind === 'satellites' || sel.kind === 'ships') && <p className="text-[11px] text-muted">Position when you picked it; it keeps moving on the map.</p>}
          </>
        )}
        <p className="font-mono text-[10px] text-muted">{where}</p>
      </div>
      <footer className="flex flex-wrap gap-1.5 border-t border-border px-3 py-2">
        <button type="button" className="btn h-7 gap-1 px-2 text-xs" onClick={onCentre}>
          <Crosshair className="size-3.5" aria-hidden /> Centre
        </button>
        <button type="button" className="btn h-7 gap-1 border-accent/60 px-2 text-xs text-accent" onClick={ask}>
          <Sparkles className="size-3.5" aria-hidden /> Ask Atlas
        </button>
        {typeof p.url === 'string' && p.url.startsWith('https://') && (
          <a href={p.url} target="_blank" rel="noreferrer" className="btn h-7 gap-1 px-2 text-xs">
            <ExternalLink className="size-3.5" aria-hidden /> Source
          </a>
        )}
        {place && (
          <button type="button" className="btn ml-auto h-7 gap-1 px-2 text-xs" onClick={() => onRemovePlace(place.place.id)} title="Stop watching this place">
            <Trash2 className="size-3.5" aria-hidden /> Stop watching
          </button>
        )}
      </footer>
    </aside>
  )
}

/**
 * World: the map fills the stage. A floating toolbar adds places and switches
 * layers; your places sit as chips; picking anything opens the Inspector
 * (left, or a bottom sheet on narrow windows). Atlas speaks up on its own
 * when something serious happens near one of your places.
 */
export function WorldPage() {
  const now = useNow(60_000)
  const [world, setWorld] = useState<WorldSnapshot>(EMPTY_WORLD)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Selected | null>(null)
  const [focus, setFocus] = useState<{ lngLat: [number, number]; zoom?: number; n: number } | null>(null)
  const [info, setInfo] = useState(false)

  useEffect(() => {
    void window.world.state().then(setWorld, err => setError(cleanError(err)))
    return window.world.onChanged(setWorld)
  }, [])

  // Esc closes the Inspector first.
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      e.stopImmediatePropagation()
      setSelected(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selected])

  const run = async (fn: () => Promise<WorldSnapshot>) => {
    setBusy(true)
    setError('')
    try {
      setWorld(await fn())
      return true
    } catch (err) {
      setError(cleanError(err))
      return false
    } finally {
      setBusy(false)
    }
  }
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    void run(() => window.world.add(name.trim())).then(ok => ok && setName(''))
  }
  const pickPlace = (s: PlaceStatus) => {
    const lngLat: [number, number] = [s.place.lon, s.place.lat]
    setSelected({ kind: 'places', lngLat, props: { id: s.place.id, title: s.place.name } })
    setFocus({ lngLat, zoom: 7, n: Date.now() })
  }

  const toolbar = (layersButton: ReactNode) => (
    <div className="pointer-events-none absolute left-2 right-12 top-2 z-10 flex flex-wrap items-center gap-1.5">
      <form onSubmit={add} className="map-chip pointer-events-auto w-[min(15rem,100%)] pr-1 focus-within:border-accent/60">
        <MapPin className="size-3.5 shrink-0 text-accent" aria-hidden />
        <input className="bare-input min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted" placeholder="Watch a city…" value={name} onChange={e => setName(e.target.value)} aria-label="Add a place to watch" />
        {name.trim() && (
          <button type="submit" className="grid size-6 place-items-center rounded-full bg-accent text-black" disabled={busy} aria-label="Watch this place">
            {busy ? <RefreshCw className="size-3 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
          </button>
        )}
      </form>
      <span className="pointer-events-auto">{layersButton}</span>
      <div className="no-scrollbar pointer-events-auto flex min-w-0 max-w-full gap-1.5 overflow-x-auto @max-[520px]:order-last @max-[520px]:basis-full">
        {world.places.map(s => (
          <button
            key={s.place.id}
            type="button"
            onClick={() => pickPlace(s)}
            className={`map-chip shrink-0 ${selected?.kind === 'places' && selected.props.id === s.place.id ? 'border-accent text-accent' : ''}`}
            title={s.weather ? `${s.place.name}: ${s.weather.summary}` : s.place.name}
          >
            <span className={`size-1.5 rounded-full ${s.nearby.length || (s.air?.aqi ?? 0) > 150 ? 'bg-warm' : 'bg-accent'}`} aria-hidden />
            {s.place.name}
            {s.weather && <span className="font-mono text-[10px] text-muted">{Math.round(s.weather.temp)}°</span>}
          </button>
        ))}
      </div>
      <span className="pointer-events-auto ml-auto flex gap-1.5">
        <button type="button" className="map-chip px-2" onClick={() => void run(() => window.world.refresh())} disabled={busy} aria-label="Refresh world data" title="Refresh">
          <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden />
        </button>
        <button type="button" className={`map-chip px-2 ${info ? 'border-accent text-accent' : ''}`} onClick={() => setInfo(i => !i)} aria-expanded={info} aria-label="Sources and status" title="Sources and status">
          <Info className="size-3.5" aria-hidden />
        </button>
      </span>
    </div>
  )

  return (
    <div className="@container relative h-full min-h-0">
      <WorldMap world={world} selected={selected} onSelect={setSelected} focus={focus} toolbar={toolbar} />

      {error && (
        <p role="alert" className="ask-pop glass absolute left-1/2 top-14 z-20 max-w-[90%] -translate-x-1/2 rounded-lg bg-solid/90 px-3 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}

      {world.places.length === 0 && !selected && (
        <p className="glass pointer-events-none absolute left-2 top-14 z-10 w-[min(300px,calc(100%-1rem))] rounded-xl bg-solid/85 px-3 py-2 text-xs text-muted">
          Watch the places you care about (your city, family, clients, a trip): type one above. I’ll tell you about dangerous air, extreme weather, earthquakes or fires near them.
        </p>
      )}

      {info && (
        <div className="ask-pop glass absolute right-12 top-12 z-20 w-[min(320px,calc(100%-4rem))] space-y-1.5 rounded-xl bg-solid/90 p-3 text-[11px] text-muted shadow-2xl">
          <p className="text-text">
            {world.updatedAt ? `Updated ${ago(world.updatedAt, now)}` : 'Not updated yet'} · {world.quakes.length} earthquakes (M4+, 2 days) · {world.events.length} open natural events
          </p>
          {world.problems.length > 0 && <p className="text-warm">Unavailable: {world.problems.join('; ')}</p>}
          <p className="leading-snug">{ATTRIBUTION}</p>
        </div>
      )}

      {selected && (
        <div className="pointer-events-none absolute inset-x-2 bottom-16 z-10 flex max-h-[55%] flex-col @[640px]:bottom-16 @[640px]:right-auto @[640px]:top-14 @[640px]:max-h-none @[640px]:w-[340px]">
          <Inspector
            sel={selected}
            world={world}
            now={now}
            onClose={() => setSelected(null)}
            onCentre={() => setFocus({ lngLat: selected.lngLat, zoom: selected.kind === 'places' ? 7 : 8, n: Date.now() })}
            onRemovePlace={id => {
              setSelected(null)
              void run(() => window.world.remove(id))
            }}
          />
        </div>
      )}
    </div>
  )
}
