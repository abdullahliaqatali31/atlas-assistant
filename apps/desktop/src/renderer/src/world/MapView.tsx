/**
 * The World map, full-bleed: the basemap style (satellite by default), flat
 * or globe, every registered layer, a floating toolbar, the layer switches
 * and a view history for "Back". A click picks an item for the Inspector.
 */
import 'maplibre-gl/dist/maplibre-gl.css'

import { ArrowLeft, Globe2, Layers, Map as MapIcon } from 'lucide-react'
import maplibregl, { type FilterSpecification, type GeoJSONSource, type Map as MapLibre, type StyleSpecification } from 'maplibre-gl'
import * as satellite from 'satellite.js'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { MAX_PINS, type MapOp, type Pin, type Story } from '../../../shared/map.ts'
import type { NewsResult } from '../../../shared/news.ts'
import { CAMERA_COVERAGE, kmBetween, type Camera, type ShipsResult, type WorldSnapshot } from '../../../shared/world.ts'
import { cleanError, flightFeatures, planeIcon, satelliteFeatures, shipFeatures, shipIcon, toFeatures, type FC } from './geo.ts'
import { nearbyItems, type NearbyItem } from './hover.ts'
import { HoverCard } from './HoverCard.tsx'
import type { Selected } from './Inspector.tsx'
import { layerDef, LAYERS, OWN_SOURCES, PICKABLE, readLayers, SELECTED_LAYER, TRAIL_LAYER, type LayerId } from './layers.ts'
import { groundTrack, horizonKm, nextPasses, orbitFacts, ring } from './passes.ts'
import { Trails } from './trails.ts'
import { describeFound, describeVisible, findItems, linkFeatures, pinFeatures, storyFeatures, ZOOM_FOR } from './mapops.ts'
import { LayerRail, RAIL } from './LayerRail.tsx'
import { NewsCanvas } from './NewsCanvas.tsx'
import { newsFeatures } from './newsmap.ts'
import { layerFilter, readFilters, saveFilters } from './panels.ts'
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
  follow,
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
  /** Keep the picked moving item (aircraft, ship, satellite) in the middle as it moves. */
  follow: boolean
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
  const [filters, setFilters] = useState(readFilters)
  const filtersNow = useRef(filters)
  filtersNow.current = filters
  /** Orbit elements of the tracked satellites, for the rail's "above you" panel. */
  const satsRef = useRef<{ name: string; rec: satellite.SatRec }[]>([])
  /** Where aircraft and ships have been since the map opened. */
  const trails = useRef(new Trails())
  const [open, setOpen] = useState<'layers' | 'style' | null>(null)
  const [counts, setCounts] = useState<Partial<Record<LayerId, number>>>({})
  const [flightNote, setFlightNote] = useState('')
  const [shipState, setShipState] = useState<{ status: ShipsResult['status']; message: string | null }>({ status: 'off', message: null })
  const [shipKey, setShipKey] = useState('')
  const [shipKeyError, setShipKeyError] = useState('')
  /** Worldwide webcams (Windy, the owner's key): status, what is in view, and the key form. */
  const [webcamState, setWebcamState] = useState<{ status: 'no-key' | 'ok' | 'error'; message: string | null; inView: number }>({ status: 'ok', message: null, inView: 0 })
  const [webcamKey, setWebcamKey] = useState('')
  const [webcamKeyError, setWebcamKeyError] = useState('')
  const [webcamKeyVersion, setWebcamKeyVersion] = useState(0)
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
      for (const l of LAYERS) for (const id of [l.source, ...(l.extraSources ?? [])]) if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: initial[id] ?? empty, ...(id === l.source ? l.sourceOptions : {}) })
      for (const id of ['selected', 'trail']) if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: empty })
      for (const l of LAYERS) for (const spec of l.draw) if (!m.getLayer(spec.id)) m.addLayer(spec)
      if (!m.getLayer(TRAIL_LAYER.id)) m.addLayer(TRAIL_LAYER)
      if (!m.getLayer(SELECTED_LAYER.id)) m.addLayer(SELECTED_LAYER)

      // One click handler: the top-most item near the pointer, or nothing (closes the Inspector).
      m.on('click', e => {
        const hit = pickAt(m, e.point)
        selectRef.current(hit ? { kind: hit.kind, lngLat: hit.lngLat, props: hit.props } : null)
      })
      // A news bubble opens up: zoom in until its headlines separate.
      m.on('click', 'news-clusters', e => {
        const f = e.features?.[0]
        const id = f?.properties?.cluster_id
        if (!f || typeof id !== 'number') return
        void (m.getSource('news') as GeoJSONSource).getClusterExpansionZoom(id).then(zoom =>
          m.easeTo({ center: (f.geometry as unknown as { coordinates: [number, number] }).coordinates, zoom: Math.min(zoom + 0.5, 12), duration: isLite() ? 0 : 600 }),
        )
      })
      m.on('mouseenter', 'news-clusters', () => (m.getCanvas().style.cursor = 'pointer'))
      m.on('mouseleave', 'news-clusters', () => (m.getCanvas().style.cursor = ''))
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

  // A picked aircraft, ship or satellite stays live: its card and ring move with it, its path is drawn,
  // and Follow keeps it in the middle. A satellite shows its next orbit and the circle it can see.
  const selectedNow = useRef(selected)
  selectedNow.current = selected
  const followNow = useRef(follow)
  followNow.current = follow
  const worldNow = useRef(world)
  worldNow.current = world
  const selectedId = selected ? String(selected.props.id ?? '') : ''
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const lines = (items: { coords: [number, number][]; color: string; width?: number }[]) =>
      (m.getSource('trail') as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: items.filter(i => i.coords.length > 1).map(i => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: i.coords }, properties: { color: i.color, width: i.width ?? 2 } })),
      })
    const kind = selectedNow.current?.kind
    if (!kind || !selectedId || (kind !== 'flights' && kind !== 'ships' && kind !== 'satellites')) {
      lines([])
      return
    }
    const sat = kind === 'satellites' ? satsRef.current.find(x => `sat:${String(x.rec.satnum).trim()}` === selectedId) : undefined
    // The next pass over the first watched place, worked out once per pick.
    const home = worldNow.current.places[0]?.place
    const pass = sat && home ? nextPasses(sat.rec, { lat: home.lat, lon: home.lon }, Date.now(), { limit: 1 })[0] : undefined
    const tick = () => {
      const sel = selectedNow.current
      if (!sel) return
      let lngLat = sel.lngLat
      let props = sel.props
      const live = latest.current[kind]?.features.find(f => f.properties.id === selectedId)
      if (live) {
        lngLat = live.geometry.coordinates as [number, number]
        props = { ...sel.props, ...live.properties }
      }
      if (sat) {
        const facts = orbitFacts(sat.rec, new Date())
        if (facts) {
          lngLat = [facts.lon, facts.lat]
          props = { ...props, norad: facts.norad, altKm: facts.altKm, speedKms: facts.speedKms, inclination: facts.inclination, periodMin: facts.periodMin, ...(pass && home ? { nextPass: pass.rise, nextPassMax: pass.maxElevation, nextPassMin: Math.max(1, Math.round((pass.set - pass.rise) / 60_000)), passPlace: home.name } : {}) }
          lines([
            { coords: groundTrack(sat.rec, Date.now(), Math.round(facts.periodMin)), color: '#c084fc' },
            { coords: ring(lngLat, horizonKm(facts.altKm)), color: '#c084fc', width: 1 },
          ])
        }
      } else lines([{ coords: trails.current.path(selectedId), color: kind === 'flights' ? '#fbbf24' : '#34d399' }])
      if (lngLat[0] !== sel.lngLat[0] || lngLat[1] !== sel.lngLat[1] || props !== sel.props) selectRef.current({ kind, lngLat, props })
      if (followNow.current) m.easeTo({ center: lngLat, duration: isLite() ? 0 : 800 })
    }
    tick()
    const timer = setInterval(tick, kind === 'satellites' ? 2_000 : 4_000)
    return () => {
      clearInterval(timer)
      lines([])
    }
  }, [ready, selectedId])

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
  /** The news story on the map (map_story), the canvas item lit by hover, and a running tour. */
  const [story, setStory] = useState<Story | null>(null)
  const [hoverItem, setHoverItem] = useState<number | null>(null)
  const [tour, setTour] = useState<{ i: number; secs: number } | null>(null)
  const now$ = useRef({ prefs, layers, selected, globe, story })
  now$.current = { prefs, layers, selected, globe, story }

  const showStory = (s: Story | null) => {
    setStory(s)
    put('story', storyFeatures(s))
    ;(map.current?.getSource('story-links') as GeoJSONSource | undefined)?.setData(linkFeatures(s) as unknown as FC)
    if (!s && now$.current.selected?.kind === 'story') selectRef.current(null)
  }

  /** Fly to one story item and open its card. */
  const focusItem = (i: number) => {
    const m = map.current
    const f = storyFeatures(now$.current.story).features[i]
    if (!m || !f) return
    const lngLat = f.geometry.coordinates as [number, number]
    selectRef.current({ kind: 'story', lngLat, props: f.properties })
    void fly(m, { center: lngLat, zoom: Math.max(m.getZoom(), ZOOM_FOR.story) })
  }

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
      case 'story': {
        setTour(null)
        if (!op.story) {
          showStory(null)
          return 'Took the story off the map.'
        }
        showStory(op.story)
        showLayer('story')
        const b = new maplibregl.LngLatBounds()
        for (const it of op.story.items) b.extend([it.lon, it.lat])
        history.current = [...history.current, viewOf(m)].slice(-20)
        setCanGoBack(true)
        if (op.story.items.length === 1) m.flyTo({ center: [op.story.items[0]!.lon, op.story.items[0]!.lat], zoom: Math.max(m.getZoom(), 5), duration: isLite() ? 0 : 1_400 })
        else m.fitBounds(b, { padding: { top: 90, bottom: 110, left: 60, right: 360 }, maxZoom: 7, duration: isLite() ? 0 : 1_600 })
        const { items, links } = op.story
        return `Story "${op.story.title}" is on the map: ${items.length} numbered item${items.length === 1 ? '' : 's'}${links.length ? `, ${links.length} connection${links.length === 1 ? '' : 's'} drawn` : ''}; the News canvas is open. The owner can say "focus on number 2" (map_focus with query "#2") or ask for a tour (map_tour).`
      }
      case 'tour': {
        const s = now$.current.story
        if (op.action === 'stop') {
          setTour(null)
          return 'Tour stopped.'
        }
        if (!s) throw new Error('There is no story on the map to tour; put one there with map_story first.')
        setTour({ i: 0, secs: op.secondsEach })
        return `Tour started: ${s.items.length} stops, ${op.secondsEach} s each. Each stop opens its card.`
      }
    }
  }
  const runOpRef = useRef(runOp)
  runOpRef.current = runOp

  // The tour: one stop at a time, each card open for a few seconds, then the next; stops at the end.
  useEffect(() => {
    if (!tour || !story) return
    focusItem(tour.i)
    const next = setTimeout(() => setTour(t => (t && t.i + 1 < story.items.length ? { ...t, i: t.i + 1 } : null)), tour.secs * 1_000)
    return () => clearTimeout(next)
  }, [tour, story])

  // Marching dashes along the story's connections; not in Lite mode, paused while the window is hidden.
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !story?.links.length || isLite()) return
    const steps: number[][] = [
      [0, 4, 3],
      [0.5, 4, 2.5],
      [1, 4, 2],
      [1.5, 4, 1.5],
      [2, 4, 1],
      [2.5, 4, 0.5],
      [3, 4, 0],
      [0, 0.5, 3, 3.5],
      [0, 1, 3, 3],
      [0, 1.5, 3, 2.5],
      [0, 2, 3, 2],
      [0, 2.5, 3, 1.5],
      [0, 3, 3, 1],
      [0, 3.5, 3, 0.5],
    ]
    let k = 0
    const timer = setInterval(() => {
      if (document.hidden || !m.getLayer('story-links')) return
      k = (k + 1) % steps.length
      m.setPaintProperty('story-links', 'line-dasharray', steps[k])
    }, 70)
    return () => clearInterval(timer)
  }, [ready, story])

  // The canvas item under the pointer lights its marker.
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !m.getLayer('story-glow')) return
    const base = ['interpolate', ['linear'], ['get', 'severity'], 0, 14, 10, 26]
    m.setPaintProperty('story-glow', 'circle-radius', hoverItem === null ? base : ['case', ['==', ['get', 'n'], hoverItem + 1], 34, base])
    m.setPaintProperty('story-glow', 'circle-opacity', hoverItem === null ? 0.18 : ['case', ['==', ['get', 'n'], hoverItem + 1], 0.45, 0.12])
  }, [hoverItem, ready])

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
    put('disasters', data.disasters)
    put('places', data.places)
    setCounts(c => ({ ...c, places: data.places.features.length, quakes: data.quakes.features.length, events: data.events.features.length, disasters: data.disasters.features.length }))
    if (!fitted.current && data.places.features.length) {
      fitted.current = true
      const b = new maplibregl.LngLatBounds()
      for (const f of data.places.features) b.extend(f.geometry.coordinates as [number, number])
      m.fitBounds(b, { padding: 80, maxZoom: 5.5, duration: 0 })
    }
  }, [data, ready])

  // Filters from the rail's Filters tab: the same rule for the map and the panel lists. Applied again after a style switch.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const apply = () => {
      for (const l of LAYERS)
        for (const spec of l.draw) {
          if (!m.getLayer(spec.id) || spec.type === 'line' || spec.type === 'background' || spec.type === 'raster' || spec.type === 'hillshade') continue
          // A layer's own filter (clusters, labels for big alerts only) stays; the owner's filter is added to it.
          const own = 'filter' in spec ? spec.filter : undefined
          const theirs = layerFilter(l.id, filters)
          m.setFilter(spec.id, own && theirs ? (['all', own, theirs] as FilterSpecification) : (theirs ?? own ?? null))
        }
    }
    apply()
    m.on('style.load', apply)
    saveFilters(filters)
    return () => {
      m.off('style.load', apply)
    }
  }, [filters, ready])

  // One key per layer (shown on the rail) while the map is on screen; never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)) return
      if (!box.current?.offsetParent) return
      const r = RAIL.find(x => x.key === e.key.toLowerCase())
      if (!r) return
      setLayers(x => ({ ...x, [r.id]: !x[r.id] }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
      // Zoomed far out: military aircraft worldwide. Zoomed in to a region: everything in view (up to 1000 nm).
      const c = m.getCenter()
      const corner = m.getBounds().getNorthEast()
      const nm = kmBetween({ lat: c.lat, lon: c.lng }, { lat: corner.lat, lon: corner.lng }) / 1.852
      const regional = m.getZoom() >= 3
      try {
        const flights = await window.world.flights(c.lat, c.lng, regional ? Math.min(1000, Math.ceil(nm)) : 0, regional && filtersNow.current.openSky)
        if (stopped) return
        trails.current.add(flights.map(f => ({ id: `f:${f.hex}`, lon: f.lon, lat: f.lat })))
        put('flights', flightFeatures(flights))
        setCounts(x => ({ ...x, flights: flights.length }))
        setFlightNote(regional ? (nm > 1000 ? 'Within 1000 nm of the map centre, plus military aircraft worldwide' : 'Everything on screen, plus military aircraft worldwide') : 'Military aircraft worldwide; zoom in to a region for every flight')
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
  }, [ready, layers.flights, filters.openSky])

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
        trails.current.add(r.ships.map(v => ({ id: `s:${v.mmsi}`, lon: v.lon, lat: v.lat })))
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

  // News from the owner's feeds, placed where it happens; redrawn whenever the feeds refresh.
  useEffect(() => {
    if (!ready || !layers.news) return
    let stopped = false
    const show = (r: NewsResult) => {
      if (stopped) return
      const types = filters.newsTypes
      const fc = newsFeatures(types.length ? r.headlines.filter(h => types.includes(h.category)) : r.headlines)
      put('news', fc)
      setCounts(c => ({ ...c, news: fc.features.length }))
    }
    // Locked: the feeds are the owner's, so the layer stays empty until they confirm it is them.
    void window.news.list().then(show, () => undefined)
    const off = window.news.onChanged(show)
    return () => {
      stopped = true
      off()
    }
  }, [ready, layers.news, filters.newsTypes.join('|')])

  // Public cameras: the official open feeds once, plus (with the owner's free Windy key) the webcams in view.
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !layers.cameras) return
    let stopped = false
    let official: Camera[] = []
    let windy: Camera[] = []
    const feature = (c: Camera) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] },
      properties: {
        id: c.id,
        title: c.name,
        source: c.source,
        ...(c.video ? { video: c.video.url, videoKind: c.video.kind } : {}),
        ...(c.player ? { player: c.player.url, playerKind: c.player.kind } : {}),
        ...(c.link ? { link: c.link } : {}),
        ...(c.source === 'Windy Webcams' ? { color: '#38bdf8' } : {}),
      },
    })
    const draw = () => {
      if (stopped) return
      const ids = new Set(official.map(c => c.id))
      const all = [...official, ...windy.filter(c => !ids.has(c.id))]
      put('cameras', { type: 'FeatureCollection', features: all.map(feature) })
      setCounts(x => ({ ...x, cameras: all.length }))
    }
    void window.world.cameras().then(list => {
      official = list
      draw()
    }, () => undefined)
    const loadWindy = async () => {
      if (stopped || document.hidden) return
      const b = m.getBounds()
      const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v))
      try {
        const r = await window.world.webcams({ south: clamp(b.getSouth(), 90), north: clamp(b.getNorth(), 90), west: clamp(b.getWest(), 180), east: clamp(b.getEast(), 180) }, m.getZoom())
        if (stopped) return
        setWebcamState({ status: r.status, message: r.message, inView: r.cameras.length })
        if (r.status === 'no-key') return
        windy = r.cameras
        draw()
      } catch {
        setWebcamState(w => ({ ...w, status: 'error', message: 'Webcams unavailable right now.' }))
      }
    }
    void loadWindy()
    let debounce: ReturnType<typeof setTimeout> | null = null
    const onMove = () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => void loadWindy(), 800)
    }
    m.on('moveend', onMove)
    return () => {
      stopped = true
      m.off('moveend', onMove)
      if (debounce) clearTimeout(debounce)
    }
  }, [ready, layers.cameras, webcamKeyVersion])

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
      satsRef.current = sats
      setCounts(c => ({ ...c, satellites: sats.length }))
      draw()
    }, () => undefined)
    const timer = setInterval(draw, 2_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [ready, layers.satellites])

  const saveWebcamKey = async (key: string | null) => {
    setWebcamKeyError('')
    try {
      const r = await window.world.setWebcamsKey(key)
      setWebcamKey('')
      setWebcamState(w => ({ ...w, status: r.hasKey ? 'ok' : 'no-key', message: null }))
      setWebcamKeyVersion(v => v + 1)
    } catch (err) {
      setWebcamKeyError(cleanError(err) || 'Could not save the key.')
    }
  }
  /** The owner's Windy Webcams key, for worldwide webcams; shown in the Cameras panel. */
  const webcamKeyForm = (
    <form
      className="space-y-1 pt-1"
      onSubmit={e => {
        e.preventDefault()
        if (webcamKey.trim()) void saveWebcamKey(webcamKey.trim())
      }}
    >
      <p className="text-[10px] leading-snug text-muted">
        Add webcams from all over the world with your free Windy key ({' '}
        <a href="https://api.windy.com/keys" target="_blank" rel="noreferrer" className="text-accent underline">
          get one
        </a>
        , choose Webcams API). They load for the area you look at, zoomed in to a country or closer.
      </p>
      <div className="flex gap-1">
        <input type="password" autoComplete="off" spellCheck={false} className="field min-w-0 flex-1 py-0.5 text-[11px]" placeholder="Paste Windy Webcams key" value={webcamKey} onChange={e => setWebcamKey(e.target.value)} aria-label="Windy Webcams API key" />
        <button type="submit" className="btn h-6 px-2 text-[11px]" disabled={!webcamKey.trim()}>
          Save
        </button>
      </div>
      {webcamKeyError && <p className="text-[10px] text-danger">{webcamKeyError}</p>}
    </form>
  )
  const needsShipKey = shipState.status === 'no-key' || (shipState.status === 'error' && /key/i.test(shipState.message ?? ''))
  /** The owner's AISStream key form: in the Layers popover and in the Ships panel on the rail. */
  const shipKeyForm = (className: string) => (
      <form
        className={`space-y-1 ${className}`}
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
  )

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
      <button type="button" onClick={() => toggle('layers')} aria-expanded={open === 'layers'} className={`map-chip @[640px]:hidden ${open === 'layers' ? 'border-accent text-accent' : ''}`} title="Map layers">
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
      {ready && map.current && (
        <LayerRail
          on={layers}
          counts={counts}
          onToggle={id => setLayers(x => ({ ...x, [id]: !x[id] }))}
          ctx={{
            sources: latest.current,
            world,
            filters,
            onFilters: setFilters,
            observer: world.places[0] ? { lat: world.places[0].place.lat, lon: world.places[0].place.lon, name: world.places[0].place.name } : { lat: map.current.getCenter().lat, lon: map.current.getCenter().lng, name: 'the map centre' },
            centre: [map.current.getCenter().lng, map.current.getCenter().lat],
            sats: satsRef.current,
            storyTitle: story?.title ?? null,
            flightNote,
            shipNote: shipState.status === 'connecting' ? 'Connecting to AISStream… ships appear as they report.' : (shipState.status === 'error' && !needsShipKey) || shipState.status === 'reconnecting' ? shipState.message : null,
            shipKeyForm: needsShipKey ? shipKeyForm('pt-1') : null,
            webcamNote: webcamState.status === 'error' ? webcamState.message : webcamState.status === 'ok' && webcamState.inView ? `${webcamState.inView} worldwide webcams in this view (Windy)` : webcamState.message,
            webcamKeyForm: webcamState.status === 'no-key' ? webcamKeyForm : null,
            now,
            onFocus: (kind, f) => {
              const lngLat = f.geometry.coordinates as [number, number]
              selectRef.current({ kind, lngLat, props: f.properties })
              void fly(map.current!, { center: lngLat, zoom: Math.max(map.current!.getZoom(), ZOOM_FOR[kind]) })
            },
            onFly: (lat, lon, zoom) => void fly(map.current!, { center: [lon, lat], zoom }),
          }}
        />
      )}
      {story && (
        <NewsCanvas
          story={story}
          active={tour ? tour.i : selected?.kind === 'story' ? Number(selected.props.n) - 1 : null}
          playing={tour !== null}
          onFocus={i => {
            setTour(null)
            focusItem(i)
          }}
          onHover={setHoverItem}
          onPlay={() => setTour({ i: 0, secs: 7 })}
          onStop={() => setTour(null)}
          onClose={() => {
            setTour(null)
            showStory(null)
          }}
        />
      )}
      {toolbar(controls)}
      <MapCredit
        parts={creditLine(prefs.style, LAYERS.filter(l => layers[l.id]).map(l => l.id), [
          ...(layers.cameras && webcamState.inView ? [{ text: 'Webcams Windy.com', href: 'https://www.windy.com/webcams' }] : []),
          ...(layers.flights && filters.openSky ? [{ text: 'OpenSky Network', href: 'https://opensky-network.org' }] : []),
        ])}
      />
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
          {layers.ships && shipState.status === 'reconnecting' && <p className="pl-6 text-[10px] text-muted">{shipState.message}</p>}
          {layers.ships && needsShipKey && shipKeyForm('pl-6 pt-1')}
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
