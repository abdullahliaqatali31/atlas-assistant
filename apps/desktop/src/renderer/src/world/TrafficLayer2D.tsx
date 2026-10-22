/**
 * Moving traffic on the flat map: vehicles drawn on a canvas over the map,
 * running along the roads at their live speed (TomTom), green where it
 * flows and red where it jams; incidents as markers with a card on hover.
 * Where TomTom has no live traffic, the movement on the real roads is only
 * an impression, and the chip says so. Draws only while the map is shown.
 */
import type { GeoJSONSource, Map as MapLibre, MapMouseEvent } from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'

import { INCIDENT_LABEL, TrafficEngine, type TrafficIncident } from '../../../shared/traffic.ts'

/** From this zoom the streets are close enough for cars. */
export const TRAFFIC_MIN_ZOOM = 11

const INCIDENT_COLOR: Record<TrafficIncident['kind'], string> = { accident: '#ef4444', jam: '#f97316', roadworks: '#eab308', closure: '#7f1d1d', weather: '#38bdf8', hazard: '#f59e0b', other: '#a3a3a3' }

export type TrafficStatus = { source: 'tomtom' | 'simulated' | 'none' | 'far' | 'error'; message?: string; cars: number; incidents: number }

export function TrafficLayer2D({ map, on, idle, onStatus }: { map: MapLibre | null; on: boolean; idle: () => boolean; onStatus: (s: TrafficStatus | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const engine = useRef(new TrafficEngine())
  const [card, setCard] = useState<{ i: TrafficIncident; x: number; y: number } | null>(null)
  const incidents = useRef<TrafficIncident[]>([])
  const statusRef = useRef(onStatus)
  statusRef.current = onStatus
  const idleRef = useRef(idle)
  idleRef.current = idle

  // Roads and incidents for the view, after it settles.
  useEffect(() => {
    const m = map
    if (!m || !on) {
      engine.current.setRoads([])
      statusRef.current(null)
      return
    }
    let seq = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let status: TrafficStatus = { source: 'none', cars: 0, incidents: 0 }
    const report = (s: Partial<TrafficStatus>) => statusRef.current((status = { ...status, ...s }))
    const load = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (idleRef.current()) return
        const zoom = m.getZoom()
        const b = m.getBounds()
        const box = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }
        const mine = ++seq
        if (zoom < TRAFFIC_MIN_ZOOM) {
          engine.current.setRoads([])
          report({ source: 'far', cars: 0 })
        } else
          void window.world.trafficFlow(box, zoom).then(
            f => {
              if (mine !== seq) return
              engine.current.setRoads(f.roads, zoom >= 14 ? 2400 : zoom >= 13 ? 1800 : 1200, Math.round(zoom * 1000))
              report({ source: f.source, cars: engine.current.cars.length, message: undefined })
            },
            (e: unknown) => mine === seq && report({ source: 'error', message: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e) }),
          )
        // Incidents from the region up.
        if (zoom >= 8)
          void window.world.trafficIncidents(box).then(
            list => {
              if (mine !== seq) return
              incidents.current = list
              report({ incidents: list.length })
              const src = m.getSource('traffic-incidents') as GeoJSONSource | undefined
              src?.setData(incidentFeatures(list))
            },
            () => undefined,
          )
        else {
          incidents.current = []
          ;(m.getSource('traffic-incidents') as GeoJSONSource | undefined)?.setData(incidentFeatures([]))
          report({ incidents: 0 })
        }
      }, 500)
    }
    // Incident markers and their stretches of road.
    const layers = () => {
      if (!m.isStyleLoaded()) return
      if (!m.getSource('traffic-incidents')) m.addSource('traffic-incidents', { type: 'geojson', data: incidentFeatures(incidents.current) })
      if (!m.getLayer('traffic-inc-line'))
        m.addLayer({ id: 'traffic-inc-line', type: 'line', source: 'traffic-incidents', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.55, 'line-dasharray': [2, 1.5] } })
      if (!m.getLayer('traffic-inc'))
        m.addLayer({ id: 'traffic-inc', type: 'circle', source: 'traffic-incidents', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 14, 7], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 } })
    }
    layers()
    m.on('styledata', layers)
    m.on('moveend', load)
    load()
    const enter = (e: MapMouseEvent & { features?: { properties: Record<string, unknown> }[] }) => {
      const id = e.features?.[0]?.properties.id
      const i = incidents.current.find(x => x.id === id)
      if (i) setCard({ i, x: e.point.x, y: e.point.y })
      m.getCanvas().style.cursor = 'pointer'
    }
    const leave = () => {
      setCard(null)
      m.getCanvas().style.cursor = ''
    }
    m.on('mousemove', 'traffic-inc', enter)
    m.on('mouseleave', 'traffic-inc', leave)
    return () => {
      seq++
      clearTimeout(timer)
      m.off('styledata', layers)
      m.off('moveend', load)
      m.off('mousemove', 'traffic-inc', enter)
      m.off('mouseleave', 'traffic-inc', leave)
      for (const id of ['traffic-inc', 'traffic-inc-line']) if (m.getLayer(id)) m.removeLayer(id)
      if (m.getSource('traffic-incidents')) m.removeSource('traffic-incidents')
      engine.current.setRoads([])
      setCard(null)
    }
  }, [map, on])

  // The cars: every frame, while there are any and the map shows.
  useEffect(() => {
    const el = canvas.current
    const m = map
    if (!el || !m || !on) return
    const ctx = el.getContext('2d')!
    let raf = 0
    let rest: ReturnType<typeof setTimeout> | undefined
    let blank = false
    let last = performance.now()
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      // No cars (or the map is out of sight): clear once, then look again twice a second instead of every frame.
      if (!engine.current.cars.length || idleRef.current()) {
        cancelAnimationFrame(raf)
        if (!blank) ctx.clearRect(0, 0, el.width, el.height)
        blank = true
        rest = setTimeout(() => {
          last = performance.now()
          raf = requestAnimationFrame(frame)
        }, 500)
        return
      }
      blank = false
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const e = engine.current
      const w = el.clientWidth
      const h = el.clientHeight
      const dpr = Math.min(2, devicePixelRatio || 1)
      if (el.width !== Math.round(w * dpr)) el.width = Math.round(w * dpr)
      if (el.height !== Math.round(h * dpr)) el.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const zoom = m.getZoom()
      const lat = m.getCenter().lat
      // Metres per pixel here: cars move about 22 px a second at 20 m/s, whatever the zoom.
      const mpp = (156_543 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
      e.step(dt, Math.max(1, Math.min(80, mpp * 1.1)))
      const len = Math.max(3, Math.min(8, (zoom - 9) * 1.4))
      const paths = new Map<string, Path2D>()
      const heads: [number, number, string][] = []
      for (const c of e.cars) {
        const p = e.place(c)
        const s = m.project([p.lon, p.lat])
        if (s.x < -10 || s.y < -10 || s.x > w + 10 || s.y > h + 10) continue
        const dx = Math.cos(p.heading) * len
        const dy = -Math.sin(p.heading) * len
        let path = paths.get(p.color)
        if (!path) paths.set(p.color, (path = new Path2D()))
        path.moveTo(s.x - dx, s.y - dy)
        path.lineTo(s.x, s.y)
        if (heads.length < 900) heads.push([s.x, s.y, p.color])
      }
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'round'
      for (const [color, path] of paths) {
        ctx.strokeStyle = color
        ctx.globalAlpha = 0.35
        ctx.lineWidth = 4.5
        ctx.stroke(path)
        ctx.globalAlpha = 0.95
        ctx.lineWidth = 1.8
        ctx.stroke(path)
      }
      // Bright headlights.
      ctx.globalAlpha = 0.9
      ctx.fillStyle = '#ffffff'
      for (const [x, y] of heads) ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(rest)
    }
  }, [map, on])

  if (!on) return null
  return (
    <>
      <canvas ref={canvas} className="pointer-events-none absolute inset-0 z-[1] h-full w-full" aria-hidden />
      {card && <IncidentCard i={card.i} style={{ left: Math.max(8, card.x - 140), top: card.y + 14 }} />}
    </>
  )
}

export const incidentFeatures = (list: readonly TrafficIncident[]) => ({
  type: 'FeatureCollection' as const,
  features: list.flatMap(i => {
    const props = { id: i.id, color: INCIDENT_COLOR[i.kind] }
    const point = { type: 'Feature' as const, properties: props, geometry: { type: 'Point' as const, coordinates: [i.lon, i.lat] } }
    return i.path.length > 1 ? [{ type: 'Feature' as const, properties: props, geometry: { type: 'LineString' as const, coordinates: i.path } }, point] : [point]
  }),
})

const mins = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.max(1, Math.round(s / 60))} min`)

export function IncidentCard({ i, style }: { i: TrafficIncident; style?: React.CSSProperties }) {
  return (
    <div className="pointer-events-none absolute z-30 w-72 rounded-xl border border-white/10 bg-slate-950/90 p-2.5 text-slate-200 shadow-2xl backdrop-blur" style={style}>
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: INCIDENT_COLOR[i.kind] }}>
        <span className="size-2 rounded-full" style={{ background: INCIDENT_COLOR[i.kind] }} />
        {INCIDENT_LABEL[i.kind]}
        {i.magnitude >= 3 ? ' · major' : i.magnitude === 2 ? ' · moderate' : ''}
      </p>
      <p className="mt-1 text-[13px] leading-snug">{i.description}</p>
      {(i.from || i.to) && (
        <p className="mt-1 text-[11px] text-slate-400">
          {i.road ? `${i.road}: ` : ''}
          {i.from}
          {i.to ? ` → ${i.to}` : ''}
        </p>
      )}
      <p className="mt-1 font-mono text-[10px] text-slate-400">
        {[i.delay ? `+${mins(i.delay)} delay` : '', i.length ? `${(i.length / 1000).toFixed(1)} km` : '', i.start ? `since ${new Date(i.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '', i.end ? `until ${new Date(i.end).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''].filter(Boolean).join(' · ')}
      </p>
      <p className="mt-1 text-[9px] text-slate-500">Traffic © TomTom</p>
    </div>
  )
}

/** What live traffic shows right now, in one line. */
export function TrafficPill({ s }: { s: TrafficStatus }) {
  const text =
    s.source === 'far'
      ? 'Zoom in to a city to see the traffic move'
      : s.source === 'tomtom'
        ? `Live traffic · ${s.cars.toLocaleString()} vehicles${s.incidents ? ` · ${s.incidents} incidents` : ''} · TomTom`
        : s.source === 'simulated'
          ? 'Simulated movement on real roads: TomTom has no live traffic here'
          : s.source === 'error'
            ? (s.message ?? 'Traffic did not load')
            : 'No traffic data for this area'
  return (
    <div className="pointer-events-none absolute bottom-12 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/10 bg-slate-950/80 px-3 py-1 text-[11px] text-slate-200 shadow-lg backdrop-blur">
      <span className={`mr-1.5 inline-block size-1.5 rounded-full align-middle ${s.source === 'tomtom' ? 'bg-ok' : s.source === 'simulated' ? 'bg-sky-300' : s.source === 'error' ? 'bg-danger' : 'bg-muted'}`} />
      {text}
    </div>
  )
}
