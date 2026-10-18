/**
 * The World map, full-bleed: the basemap style (satellite by default), flat
 * or globe, every registered layer, a floating toolbar, the layer switches
 * and a view history for "Back". A click picks an item for the Inspector.
 */
import 'maplibre-gl/dist/maplibre-gl.css'

import { ArrowLeft, Globe2, Layers, Map as MapIcon } from 'lucide-react'
import maplibregl, { type GeoJSONSource, type Map as MapLibre, type StyleSpecification } from 'maplibre-gl'
import * as satellite from 'satellite.js'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { MAX_PINS, type MapOp, type Pin } from '../../../shared/map.ts'
import { CAMERA_COVERAGE, type ShipsResult, type WorldSnapshot } from '../../../shared/world.ts'
import { cleanError, flightFeatures, planeIcon, satelliteFeatures, shipFeatures, shipIcon, toFeatures, type FC } from './geo.ts'
import { nearbyItems, type NearbyItem } from './hover.ts'
import { HoverCard } from './HoverCard.tsx'
import type { Selected } from './Inspector.tsx'
import { layerDef, LAYERS, OWN_SOURCES, PICKABLE, readLayers, SELECTED_LAYER, type LayerId } from './layers.ts'
import { describeFound, describeVisible, findItems, pinFeatures, ZOOM_FOR } from './mapops.ts'
import { pickAt } from './pick.ts'
import { BASE_URL, carryOverlays, composeStyle, creditLine, STYLES, type CreditPart, type StyleId } from './styles.ts'

export interface MapPrefs {
  style: StyleId
  globe: boolean
}

export interface View {
  center: [number, number]
  zoom: number
  bearing: number
  pitch: number
}

const isLite = () => document.documentElement.dataset.lite === 'true'
const theme = (): 'dark' | 'light' => (document.documentElement.dataset.theme === 'daylight' ? 'light' : 'dark')

/** The OpenFreeMap styles, fetched once per session; imagery styles borrow their labels. */
let bases: Promise<{ dark: StyleSpecification; light: StyleSpecification }> | null = null
const loadBases = () => {
  bases ??= Promise.all([BASE_URL.dark, BASE_URL.light].map(u => fetch(u).then(r => (r.ok ? (r.json() as Promise<StyleSpecification>) : Promise.reject(new Error(`HTTP ${r.status}`)))))).then(
    ([dark, light]) => ({ dark: dark!, light: light! }),
    err => {
      bases = null
      throw err
    },
  )
  return bases
}

const viewOf = (m: MapLibre): View => {
  const c = m.getCenter()
  return { center: [c.lng, c.lat], zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() }
}

const ICONS: Record<string, () => ImageData> = { plane: planeIcon, ship: shipIcon }

export function MapView({
  world,
  selected,
  onSelect,
  focus,
  prefs,
  onPrefs,
  toolbar,
  now,
  onNearby,
}: {
  world: WorldSnapshot
  selected: Selected | null
  onSelect: (s: Selected | null) => void
  focus: { lngLat: [number, number]; zoom?: number; n: number } | null
  prefs: MapPrefs
  onPrefs: (p: MapPrefs) => void
  toolbar: (controls: ReactNode) => ReactNode
  now: number
  /** What sits near the picked item, nearest first. */
  onNearby: (items: NearbyItem[]) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<MapLibre | null>(null)
  const [ready, setReady] = useState(false)
  const [styleError, setStyleError] = useState('')
  const fitted = useRef(false)
  const [layers, setLayers] = useState(readLayers)
  const [open, setOpen] = useState<'layers' | 'style' | null>(null)
  const [counts, setCounts] = useState<Partial<Record<LayerId, number>>>({})
  const [flightNote, setFlightNote] = useState('')
  const [shipState, setShipState] = useState<{ status: ShipsResult['status']; message: string | null }>({ status: 'off', message: null })
  const [shipKey, setShipKey] = useState('')
  const [shipKeyError, setShipKeyError] = useState('')
  /** Views to go back to, newest last; each fly-to the owner or Atlas asks for adds one. */
  const history = useRef<View[]>([])
  const [canGoBack, setCanGoBack] = useState(false)
  const data = useMemo(() => toFeatures(world), [world])
  const dataRef = useRef(data)
  dataRef.current = data
  /** What each layer shows right now, for "Nearby" in the Inspector. */
  const latest = useRef<Partial<Record<LayerId, FC>>>({})
  const put = (id: LayerId, fc: FC) => {
    latest.current[id] = fc
    ;(map.current?.getSource(id) as GeoJSONSource | undefined)?.setData(fc)
  }
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect
  // Lite mode keeps the map flat: the globe costs the most GPU.
  const globe = prefs.globe && !isLite()

  useEffect(() => {
    if (!box.current) return
    const m = new maplibregl.Map({ container: box.current, style: BASE_URL.dark, center: [70, 28], zoom: 2.2, attributionControl: false, pixelRatio: isLite() ? 1 : window.devicePixelRatio })
    map.current = m
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    // Credits: our own small line at the bottom (MapCredit), not the library's white pill.
    // Style switches drop images added at runtime; draw them again when a layer asks.
    m.on('styleimagemissing', e => {
      const make = ICONS[e.id]
      if (make && !m.hasImage(e.id)) m.addImage(e.id, make(), { sdf: true })
    })
    m.once('load', () => {
      const d = dataRef.current
      const empty: FC = { type: 'FeatureCollection', features: [] }
      const initial: Record<string, FC> = { quakes: d.quakes, events: d.events, places: d.places }
      for (const id of OWN_SOURCES) if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: initial[id] ?? empty })
      for (const l of LAYERS) for (const spec of l.draw) if (!m.getLayer(spec.id)) m.addLayer(spec)
      if (!m.getLayer(SELECTED_LAYER.id)) m.addLayer(SELECTED_LAYER)

      // One click handler: the top-most item near the pointer, or nothing (closes the Inspector).
      m.on('click', e => {
        const hit = pickAt(m, e.point)
        selectRef.current(hit ? { kind: hit.kind, lngLat: hit.lngLat, props: hit.props } : null)
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

  // The basemap and projection: built from the OpenFreeMap styles, the map's own layers carried across.
  useEffect(() => {
    const m = map.current
    if (!m) return
    let stopped = false
    void loadBases().then(
      b => {
        if (stopped) return
        setStyleError('')
        const next = composeStyle({ id: prefs.style, bases: b, theme: theme(), globe, now: Date.now() })
        m.setStyle(next, { transformStyle: (prev, nextStyle) => carryOverlays(prev, nextStyle, OWN_SOURCES) })
      },
      err => !stopped && setStyleError(`Map style unavailable (${cleanError(err)}); showing the plain map.`),
    )
    return () => {
      stopped = true
    }
  }, [prefs.style, globe])

  // The ring around the picked item.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    ;(m.getSource('selected') as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: selected ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: selected.lngLat }, properties: {} }] : [],
    })
  }, [selected, ready])

  // What else is on the map around the picked item, at the moment it was picked.
  const nearbyRef = useRef(onNearby)
  nearbyRef.current = onNearby
  useEffect(() => {
    nearbyRef.current(selected ? nearbyItems(selected.lngLat, latest.current, { radiusKm: selected.kind === 'places' ? 150 : 100, exclude: selected }) : [])
  }, [selected])

  // "Centre on map" and picking a place from the toolbar; the view before it is kept for Back.
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !focus) return
    history.current = [...history.current, viewOf(m)].slice(-20)
    setCanGoBack(true)
    m.flyTo({ center: focus.lngLat, zoom: Math.max(m.getZoom(), focus.zoom ?? 6), duration: isLite() ? 0 : 900 })
  }, [focus, ready])

  const back = () => {
    const m = map.current
    const v = history.current.at(-1)
    if (!m || !v) return
    history.current = history.current.slice(0, -1)
    setCanGoBack(history.current.length > 0)
    m.flyTo({ ...v, duration: isLite() ? 0 : 900 })
  }

  // ── The assistant's map ops (map_* tools): run here, answered in words ──

  const pins = useRef<Pin[]>([])
  const now$ = useRef({ prefs, layers, selected, globe })
  now$.current = { prefs, layers, selected, globe }

  /** Fly and wait until the map settles (or a few seconds pass), keeping the view for Back. */
  const fly = (m: MapLibre, to: { center?: [number, number]; zoom?: number }) =>
    new Promise<void>(resolve => {
      history.current = [...history.current, viewOf(m)].slice(-20)
      setCanGoBack(true)
      const done = setTimeout(resolve, 3_500)
      m.once('moveend', () => {
        clearTimeout(done)
        resolve()
      })
      m.flyTo({ ...to, duration: isLite() ? 0 : 1_400, essential: true })
    })

  const runOp = async (op: MapOp): Promise<string> => {
    const m = map.current
    if (!m) throw new Error('The map is not ready yet.')
    const { prefs: p, layers: on, selected: sel, globe: isGlobe } = now$.current
    const showLayer = (id: LayerId) => !on[id] && setLayers(x => ({ ...x, [id]: true }))
    switch (op.kind) {
      case 'view': {
        if (op.style !== undefined || op.globe !== undefined) onPrefs({ style: op.style ?? p.style, globe: op.globe ?? p.globe })
        if (op.lat !== undefined && op.lon !== undefined) await fly(m, { center: [op.lon, op.lat], zoom: op.zoom ?? Math.max(m.getZoom(), 6) })
        else if (op.zoom !== undefined) await fly(m, { zoom: op.zoom })
        const style = op.style ?? p.style
        const wantsGlobe = op.globe ?? p.globe
        const where = op.label ?? (op.lat !== undefined ? `${op.lat.toFixed(2)}, ${op.lon!.toFixed(2)}` : 'the same place')
        return `Showing ${where} at zoom ${m.getZoom().toFixed(1)} on the ${STYLES.find(s => s.id === style)?.label ?? style} map${wantsGlobe ? (isLite() ? ' (Lite mode keeps it flat, not a globe)' : ' as a globe') : ''}.`
      }
      case 'layers': {
        setLayers(x => {
          const next = { ...x }
          for (const id of op.show) next[id] = true
          for (const id of op.hide) next[id] = false
          return next
        })
        const after = LAYERS.filter(l => (op.show.includes(l.id) ? true : op.hide.includes(l.id) ? false : on[l.id])).map(l => l.id)
        return `Layers on now: ${after.join(', ') || 'none'}.`
      }
      case 'visible': {
        const b = m.getBounds()
        const c = m.getCenter()
        return describeVisible(
          latest.current,
          { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
          { center: [c.lng, c.lat], zoom: m.getZoom(), style: p.style, globe: isGlobe, layersOn: LAYERS.filter(l => on[l.id]).map(l => l.id), selected: sel ? { kind: sel.kind, title: String(sel.props.title ?? '') } : null },
        )
      }
      case 'find':
        return describeFound(findItems(latest.current, op.query, op.layers), op.query)
      case 'focus': {
        if (op.query) {
          const hit = findItems(latest.current, op.query)[0]
          if (!hit) throw new Error(describeFound([], op.query))
          showLayer(hit.kind)
          selectRef.current({ kind: hit.kind, lngLat: hit.lngLat, props: hit.props })
          await fly(m, { center: hit.lngLat, zoom: op.zoom ?? Math.max(m.getZoom(), ZOOM_FOR[hit.kind]) })
          const around = nearbyItems(hit.lngLat, latest.current, { exclude: { kind: hit.kind, props: hit.props }, limit: 5 })
          return `Focused on ${layerDef(hit.kind).kind.toLowerCase()} "${hit.title}"; its card is open.${around.length ? ` Around it: ${around.map(a => `${a.title} (${a.km} km)`).join('; ')}.` : ''}`
        }
        await fly(m, { center: [op.lon!, op.lat!], zoom: op.zoom ?? Math.max(m.getZoom(), 8) })
        return `Focused on ${op.label ?? `${op.lat!.toFixed(2)}, ${op.lon!.toFixed(2)}`}.`
      }
      case 'clear-selection':
        selectRef.current(null)
        return 'Closed the card.'
      case 'pins': {
        pins.current = [...(op.clear ? [] : pins.current), ...op.add].slice(-MAX_PINS)
        put('pins', pinFeatures(pins.current))
        if (op.add.length) showLayer('pins')
        if (op.add.length === 1) await fly(m, { center: [op.add[0]!.lon, op.add[0]!.lat], zoom: Math.max(m.getZoom(), 6) })
        else if (op.add.length > 1) {
          const b = new maplibregl.LngLatBounds()
          for (const pin of op.add) b.extend([pin.lon, pin.lat])
          history.current = [...history.current, viewOf(m)].slice(-20)
          setCanGoBack(true)
          m.fitBounds(b, { padding: 90, maxZoom: 9, duration: isLite() ? 0 : 1_400 })
        }
        return pins.current.length ? `${pins.current.length} pin${pins.current.length === 1 ? '' : 's'} on the map: ${pins.current.map(x => x.label).join('; ')}.` : 'Pins cleared.'
      }
      case 'back':
        if (!history.current.length) return 'There is no earlier view to go back to.'
        back()
        return 'Back to the previous view.'
    }
  }
  const runOpRef = useRef(runOp)
  runOpRef.current = runOp

  useEffect(() => {
    if (!ready) return
    // Main sends each op again until it hears back; answer each one once.
    const seen = new Set<string>()
    return window.mapOps.onOp(({ requestId, op }) => {
      if (seen.has(requestId)) return
      seen.add(requestId)
      void runOpRef.current(op).then(
        result => window.mapOps.reply(requestId, result),
        err => window.mapOps.reply(requestId, undefined, cleanError(err)),
      )
    })
  }, [ready])

  // Places, quakes and events: update the sources; frame the places the first time.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    put('quakes', data.quakes)
    put('events', data.events)
    put('places', data.places)
    setCounts(c => ({ ...c, places: data.places.features.length, quakes: data.quakes.features.length, events: data.events.features.length }))
    if (!fitted.current && data.places.features.length) {
      fitted.current = true
      const b = new maplibregl.LngLatBounds()
      for (const f of data.places.features) b.extend(f.geometry.coordinates as [number, number])
      m.fitBounds(b, { padding: 80, maxZoom: 5.5, duration: 0 })
    }
  }, [data, ready])

  // Switches: show or hide each layer's map layers, remembered. Applied again after a style switch.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const apply = () => {
      for (const l of LAYERS) for (const spec of l.draw) if (m.getLayer(spec.id)) m.setLayoutProperty(spec.id, 'visibility', layers[l.id] ? 'visible' : 'none')
    }
    apply()
    m.on('style.load', apply)
    try {
      localStorage.setItem('world.layers', JSON.stringify(layers))
    } catch {
      // Remembering the switches is a convenience only.
    }
    return () => {
      m.off('style.load', apply)
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
        put('flights', { type: 'FeatureCollection', features: [] })
        setCounts(c => ({ ...c, flights: 0 }))
        return
      }
      const c = m.getCenter()
      try {
        const flights = await window.world.flights(c.lat, c.lng, 250)
        if (stopped) return
        put('flights', flightFeatures(flights))
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
        put('ships', shipFeatures(r.ships))
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
      put('cameras', {
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
      put('satellites', satelliteFeatures(sats, new Date()))
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
  const current = STYLES.find(s => s.id === prefs.style)!
  const toggle = (which: 'layers' | 'style') => setOpen(o => (o === which ? null : which))
  const controls = (
    <>
      {canGoBack && (
        <button type="button" onClick={back} className="map-chip px-2" title="Back to the previous view" aria-label="Back to the previous view">
          <ArrowLeft className="size-3.5" aria-hidden />
        </button>
      )}
      <button type="button" onClick={() => toggle('style')} aria-expanded={open === 'style'} className={`map-chip ${open === 'style' ? 'border-accent text-accent' : ''}`} title="Map style">
        <MapIcon className="size-3.5" aria-hidden />
        <span className="hidden @[520px]:inline">{current.label}</span>
      </button>
      <button
        type="button"
        onClick={() => onPrefs({ ...prefs, globe: !prefs.globe })}
        aria-pressed={globe}
        disabled={isLite()}
        className={`map-chip px-2 ${globe ? 'border-accent text-accent' : ''}`}
        title={isLite() ? 'Lite mode keeps the map flat' : globe ? 'Flat map' : 'Globe'}
        aria-label={globe ? 'Show the flat map' : 'Show the globe'}
      >
        <Globe2 className="size-3.5" aria-hidden />
        <span className="hidden @[640px]:inline">{globe ? 'Globe' : '2D'}</span>
      </button>
      <button type="button" onClick={() => toggle('layers')} aria-expanded={open === 'layers'} className={`map-chip ${open === 'layers' ? 'border-accent text-accent' : ''}`} title="Map layers">
        <Layers className="size-3.5" aria-hidden />
        <span className="hidden @[520px]:inline">Layers</span>
        <span className="font-mono text-[10px] text-muted">
          {on}/{LAYERS.length}
        </span>
      </button>
    </>
  )

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div ref={box} className="h-full w-full" aria-label="World map" role="region" />
      <HoverCard map={map.current} ready={ready} world={world} now={now} />
      {toolbar(controls)}
      <MapCredit parts={creditLine(prefs.style, LAYERS.filter(l => layers[l.id]).map(l => l.id))} />
      {styleError && <p className="glass absolute bottom-16 left-2 z-10 rounded-lg bg-solid/85 px-2 py-1 text-[11px] text-warm">{styleError}</p>}
      {open === 'style' && (
        <fieldset className="ask-pop glass absolute left-2 top-12 z-20 w-[min(280px,calc(100%-1rem))] space-y-0.5 rounded-xl bg-solid/90 p-1.5 text-xs shadow-2xl">
          <legend className="sr-only">Map style</legend>
          {STYLES.map(s => (
            <label key={s.id} className={`flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-surface ${s.id === prefs.style ? 'text-accent' : ''}`}>
              <input
                type="radio"
                name="map-style"
                className="mt-0.5"
                checked={s.id === prefs.style}
                onChange={() => {
                  onPrefs({ ...prefs, style: s.id })
                  setOpen(null)
                }}
              />
              <span className="min-w-0">
                <span className="block font-medium">{s.label}</span>
                <span className="block text-[10px] text-muted">{s.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {open === 'layers' && (
        <fieldset className="ask-pop glass absolute left-2 top-12 z-20 w-[min(280px,calc(100%-1rem))] space-y-1 rounded-xl bg-solid/90 px-3 py-2 text-xs shadow-2xl">
          <legend className="sr-only">Map layers</legend>
          {[...LAYERS]
            .sort((a, b) => a.pickRank - b.pickRank)
            .map(l => (
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

/**
 * The map's credit line: small monospace text at the bottom right, no pill,
 * each source linked where its licence asks. Hover shows it whole.
 */
function MapCredit({ parts }: { parts: CreditPart[] }) {
  const full = parts.map(p => p.text).join(' | ')
  return (
    <p className="map-credit pointer-events-auto absolute bottom-1 right-2 z-[4] line-clamp-2 max-w-[min(42%,34rem)] text-right font-mono text-[9.5px] leading-tight" title={full}>
      {parts.map((p, i) => (
        <span key={p.text}>
          {i > 0 && <span aria-hidden> | </span>}
          {p.href ? (
            <a href={p.href} target="_blank" rel="noreferrer">
              {p.text}
            </a>
          ) : (
            p.text
          )}
        </span>
      ))}
    </p>
  )
}
