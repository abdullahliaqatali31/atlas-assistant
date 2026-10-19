import 'maplibre-gl/dist/maplibre-gl.css'

import maplibregl, { type GeoJSONSource } from 'maplibre-gl'
import * as satellite from 'satellite.js'
import { useEffect, useRef, useState } from 'react'

import type { GlassPin } from '../../../shared/glass.ts'
import type { Camera, WorldSnapshot } from '../../../shared/world.ts'
import { EMPTY_WORLD } from '../../../shared/world.ts'
import { flightFeatures, planeIcon, satelliteFeatures, shipFeatures, shipIcon, toFeatures, type FC } from '../world/geo.ts'
import { hoverInfo, type HoverInfo } from '../world/hover.ts'
import { layerDef, LAYERS, readLayers, type LayerId } from '../world/layers.ts'
import { pickAt } from '../world/pick.ts'
import { BASE_URL } from '../world/styles.ts'

/** The World map's live layers the glass map can show; the rest (story, news, pins) belong to the app's own map. */
const LIVE: LayerId[] = ['places', 'quakes', 'events', 'disasters', 'cameras', 'ships', 'flights', 'satellites']
const ICONS: Record<string, () => ImageData> = { plane: planeIcon, ship: shipIcon }
const EMPTY: FC = { type: 'FeatureCollection', features: [] }

const pinData = (pins: GlassPin[]) => ({
  type: 'FeatureCollection' as const,
  features: pins.map(p => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] }, properties: { label: p.label } })),
})

const cameraFeatures = (list: Camera[]): FC => ({
  type: 'FeatureCollection',
  features: list.map(c => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [c.lon, c.lat] }, properties: { id: c.id, title: c.name, source: c.source } })),
})

/**
 * The glass panel's map: the place Atlas was asked about, its pins, and the
 * same live layers the owner has switched on in the app's World map
 * (flights, ships, quakes, disasters, places, cameras, satellites), with
 * the same icons and colours. Click anything for a short card.
 */
export default function MiniMap({ lat, lon, zoom, pins, visible = true }: { lat: number; lon: number; zoom: number; pins: GlassPin[]; visible?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const world = useRef<WorldSnapshot>(EMPTY_WORLD)
  const [ready, setReady] = useState(false)
  const [picked, setPicked] = useState<(HoverInfo & { kind: LayerId }) | null>(null)
  // The owner's layer switches from the app's World map (same storage).
  const [on] = useState(() => {
    const all = readLayers()
    return LIVE.filter(id => all[id])
  })

  useEffect(() => {
    if (!box.current) return
    const m = new maplibregl.Map({ container: box.current, style: BASE_URL.dark, center: [lon, lat], zoom, attributionControl: false })
    map.current = m
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    m.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    m.on('styleimagemissing', e => {
      const make = ICONS[e.id]
      if (make && !m.hasImage(e.id)) m.addImage(e.id, make(), { sdf: true })
    })
    m.on('load', () => {
      for (const id of on) {
        const def = layerDef(id)
        for (const src of [def.source, ...(def.extraSources ?? [])]) if (!m.getSource(src)) m.addSource(src, { type: 'geojson', data: EMPTY, ...(src === def.source ? def.sourceOptions : {}) })
      }
      // Draw in the registry's order, so the layers stack as in the app.
      for (const def of LAYERS) if (on.includes(def.id)) for (const spec of def.draw) if (!m.getLayer(spec.id)) m.addLayer(spec)
      m.addSource('glass-pins', { type: 'geojson', data: pinData(pins) })
      m.addLayer({ id: 'glass-pins', type: 'circle', source: 'glass-pins', paint: { 'circle-radius': 7, 'circle-color': '#22d3ee', 'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff' } })
      m.addLayer({
        id: 'glass-pin-labels',
        type: 'symbol',
        source: 'glass-pins',
        layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
        paint: { 'text-color': '#e2f3ff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.2 },
      })
      setReady(true)
    })
    m.on('click', e => {
      const hit = pickAt(m, e.point)
      setPicked(hit ? { ...hoverInfo(hit.kind, hit.props, world.current, Date.now()), kind: hit.kind } : null)
    })
    return () => {
      m.remove()
      map.current = null
    }
    // The map is made once; new views move it (below).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A new map view: move there and redraw the pins.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    ;(m.getSource('glass-pins') as GeoJSONSource | undefined)?.setData(pinData(pins))
    if (pins.length > 1) {
      const b = new maplibregl.LngLatBounds()
      for (const p of pins) b.extend([p.lon, p.lat])
      m.fitBounds(b, { padding: 50, maxZoom: zoom, duration: 800 })
    } else m.flyTo({ center: [lon, lat], zoom, duration: 800 })
  }, [ready, lat, lon, zoom, pins])

  // Shown again after another view: the map's box may have changed size.
  useEffect(() => {
    if (visible) map.current?.resize()
  }, [visible])

  // The live layers, refreshed like the app's map does; paused while another view shows.
  useEffect(() => {
    const m = map.current
    if (!m || !ready || !visible) return
    const put = (id: string, fc: FC): void => void (m.getSource(id) as GeoJSONSource | undefined)?.setData(fc)
    const area = () => {
      const b = m.getBounds()
      const c = (v: number, max: number) => Math.max(-max, Math.min(max, v))
      return { south: c(b.getSouth(), 90), north: c(b.getNorth(), 90), west: c(b.getWest(), 180), east: c(b.getEast(), 180) }
    }
    const timers: ReturnType<typeof setInterval>[] = []
    let stopped = false
    const every = (ms: number, fn: () => Promise<void> | void) => {
      const run = () => !stopped && void Promise.resolve(fn()).catch(() => undefined)
      run()
      timers.push(setInterval(run, ms))
    }
    const has = (id: LayerId) => on.includes(id)

    if (has('places') || has('quakes') || has('events') || has('disasters'))
      every(60_000, async () => {
        world.current = await window.glass.world('state')
        const f = toFeatures(world.current)
        for (const id of ['places', 'quakes', 'events', 'disasters'] as const) if (has(id)) put(id, f[id])
      })
    if (has('flights')) every(8_000, async () => put('flights', flightFeatures((await window.glass.world('flights', area())).flights)))
    if (has('ships')) every(8_000, async () => put('ships', shipFeatures((await window.glass.world('ships', area())).ships)))
    if (has('cameras')) void window.glass.world('cameras').then(list => put('cameras', cameraFeatures(list)), () => undefined)
    if (has('satellites'))
      void window.glass.world('satellites').then(list => {
        const sats = list.flatMap(s => {
          try {
            return [{ name: String(s.OBJECT_NAME ?? ''), rec: satellite.json2satrec(s as unknown as satellite.OMMJsonObject) }]
          } catch {
            return []
          }
        })
        every(2_000, () => put('satellites', satelliteFeatures(sats, new Date())))
      }, () => undefined)
    return () => {
      stopped = true
      for (const t of timers) clearInterval(t)
    }
  }, [ready, on, visible])

  return (
    <div className="relative h-full min-h-[300px] w-full">
      {/* Inline: MapLibre gives its container position: relative, which would beat a class. */}
      <div ref={box} style={{ position: "absolute", inset: 0 }} />
      {on.length > 0 && (
        <p className="pointer-events-none absolute bottom-2 left-2 z-[2] max-w-[80%] truncate rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white/70">
          {on.map(id => layerDef(id).label).join(' · ')}
        </p>
      )}
      {picked && (
        <div className="neon-glass rise-in absolute left-2 top-2 z-[2] max-w-[70%] rounded-xl px-3 py-2 text-white">
          <div className="flex items-start gap-2">
            <span className="mt-1 size-2 shrink-0 rounded-full" style={{ background: layerDef(picked.kind).dot }} aria-hidden />
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.12em] text-white/60">{picked.kind ? layerDef(picked.kind).kind : ''}</p>
              <p className="text-[13px] font-medium leading-snug" dir="auto">
                {picked.title}
              </p>
              {picked.facts.slice(0, 3).map(f => (
                <p key={f} className="text-[11px] text-white/75" dir="auto">
                  {f}
                </p>
              ))}
            </div>
            <button type="button" className="ml-1 text-white/60 hover:text-white" onClick={() => setPicked(null)} aria-label="Close">
              ×
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
