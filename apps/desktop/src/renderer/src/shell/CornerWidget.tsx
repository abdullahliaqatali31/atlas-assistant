import { useEffect, useRef, useState } from 'react'

import { MAP_VIEW_EVENT } from '../../../shared/map.ts'
import type { PlaceStatus } from '../../../shared/world.ts'
import { STATE_LABEL, useNow, type Presence } from '../Jarvis.tsx'
import { Orb, type OrbState } from '../ui/Orb.tsx'
import { nameOf } from '../ui/assistantName.ts'

type Ring = [number, number][]

/** Country outlines (Natural Earth 110 m), loaded once for every mini globe. */
let landRings: Promise<Ring[]> | null = null
const loadLand = () =>
  (landRings ??= window.world
    .intelCountries()
    .then(fc =>
      fc.features.flatMap(f => {
        const g = f.geometry as { type: string; coordinates: unknown }
        const polys = g.type === 'Polygon' ? [g.coordinates as Ring[]] : g.type === 'MultiPolygon' ? (g.coordinates as Ring[][]) : []
        return polys.map(p => p[0]!).filter(Boolean)
      }),
    )
    .catch(() => []))

const RAD = Math.PI / 180

/**
 * A small globe turned to where the World map looks: the land in the accent
 * colour, a pulse where you are looking and a sweep around the rim. Drawn
 * about 20 times a second while visible; it eases to each new view.
 */
function MiniGlobe({ size = 64 }: { size?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext('2d')!
    const dpr = Math.min(2, devicePixelRatio || 1)
    el.width = el.height = Math.round(size * dpr)
    let rings: Ring[] = []
    void loadLand().then(r => (rings = r))
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#22d3ee'
    let target: { lat: number; lon: number } | null = null
    const at = { lat: 20, lon: 60 }
    const onView = (e: Event) => {
      const d = (e as CustomEvent<{ lat: number; lon: number }>).detail
      if (d) target = { lat: d.lat, lon: d.lon }
    }
    window.addEventListener(MAP_VIEW_EVENT, onView)
    let timer = 0
    const R = (size / 2 - 2) * dpr
    const c = (size / 2) * dpr
    const draw = () => {
      if (document.hidden) return
      const t = performance.now() / 1000
      // Ease toward the view; with none yet, turn slowly.
      if (target) {
        let dLon = target.lon - at.lon
        if (dLon > 180) dLon -= 360
        if (dLon < -180) dLon += 360
        at.lon += dLon * 0.15
        at.lat += (target.lat - at.lat) * 0.15
      } else at.lon += 0.6
      const p0 = at.lat * RAD
      const l0 = at.lon * RAD
      const sp0 = Math.sin(p0)
      const cp0 = Math.cos(p0)
      ctx.clearRect(0, 0, el.width, el.height)
      // The sea, lit a little from the upper left.
      const sea = ctx.createRadialGradient(c - R * 0.35, c - R * 0.35, R * 0.1, c, c, R)
      sea.addColorStop(0, '#0f2a3a')
      sea.addColorStop(1, '#030a12')
      ctx.fillStyle = sea
      ctx.beginPath()
      ctx.arc(c, c, R, 0, Math.PI * 2)
      ctx.fill()
      // Land: each outline, only its near side.
      ctx.save()
      ctx.beginPath()
      ctx.arc(c, c, R, 0, Math.PI * 2)
      ctx.clip()
      ctx.strokeStyle = accent
      ctx.globalAlpha = 0.85
      ctx.lineWidth = 0.8 * dpr
      ctx.fillStyle = accent
      for (const ring of rings) {
        let open = false
        let all = true
        const path = new Path2D()
        for (let i = 0; i < ring.length; i += ring.length > 60 ? 2 : 1) {
          const [lon, lat] = ring[i]!
          const p = lat * RAD
          const dl = lon * RAD - l0
          const cp = Math.cos(p)
          const cosc = sp0 * Math.sin(p) + cp0 * cp * Math.cos(dl)
          const x = c + R * cp * Math.sin(dl)
          const y = c - R * (cp0 * Math.sin(p) - sp0 * cp * Math.cos(dl))
          if (cosc <= 0) {
            all = false
            open = false
            continue
          }
          if (open) path.lineTo(x, y)
          else path.moveTo(x, y)
          open = true
        }
        if (all) {
          ctx.globalAlpha = 0.22
          ctx.fill(path)
          ctx.globalAlpha = 0.85
        }
        ctx.stroke(path)
      }
      ctx.restore()
      // The rim, a sweep going round it, and a pulse where the map looks (the centre).
      ctx.globalAlpha = 1
      ctx.strokeStyle = accent
      ctx.lineWidth = 1 * dpr
      ctx.globalAlpha = 0.35
      ctx.beginPath()
      ctx.arc(c, c, R, 0, Math.PI * 2)
      ctx.stroke()
      const a = (t * 1.2) % (Math.PI * 2)
      ctx.globalAlpha = 0.9
      ctx.lineWidth = 2 * dpr
      ctx.beginPath()
      ctx.arc(c, c, R, a, a + 0.7)
      ctx.stroke()
      const pulse = (t % 1.6) / 1.6
      ctx.globalAlpha = 1 - pulse
      ctx.lineWidth = 1.2 * dpr
      ctx.beginPath()
      ctx.arc(c, c, (3 + pulse * 9) * dpr, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(c, c, 1.8 * dpr, 0, Math.PI * 2)
      ctx.fill()
    }
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    timer = window.setInterval(draw, reduced ? 1000 : 50)
    draw()
    return () => {
      clearInterval(timer)
      window.removeEventListener(MAP_VIEW_EVENT, onView)
    }
  }, [size])
  return <canvas ref={canvas} style={{ width: size, height: size }} className="shrink-0 rounded-full shadow-[0_0_22px_color-mix(in_srgb,var(--accent)_35%,transparent)]" aria-hidden />
}

const fmtLat = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'N' : 'S'}`
const fmtLon = (v: number) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}`

/**
 * The corner widget (bottom left of the World stage): a mini globe turned to
 * where the map looks, the time with seconds, the weather at the first
 * watched place, where the map looks, and Atlas's orb. Click: back to Home.
 */
export function CornerWidget({ state, presence, onHome }: { state: OrbState; presence: Presence; onHome: () => void }) {
  const now = useNow(1000)
  const [place, setPlace] = useState<PlaceStatus | null>(null)
  const [view, setView] = useState<{ lat: number; lon: number } | null>(null)
  useEffect(() => {
    const pick = (w: { places: PlaceStatus[] }) => setPlace(w.places[0] ?? null)
    void window.world.state().then(pick, () => undefined)
    const off = window.world.onChanged(pick)
    let last = 0
    const onView = (e: Event) => {
      if (Date.now() - last < 400) return
      last = Date.now()
      const d = (e as CustomEvent<{ lat: number; lon: number }>).detail
      if (d) setView({ lat: d.lat, lon: d.lon })
    }
    window.addEventListener(MAP_VIEW_EVENT, onView)
    return () => {
      off()
      window.removeEventListener(MAP_VIEW_EVENT, onView)
    }
  }, [])
  const w = place?.weather
  const aqi = place?.air?.aqi
  const d = new Date(now)
  const offset = -d.getTimezoneOffset() / 60
  return (
    <button
      type="button"
      onClick={onHome}
      title={`${STATE_LABEL[state]} · back to Home`}
      aria-label={`${nameOf()} is ${STATE_LABEL[state].toLowerCase()}. Back to Home`}
      className="pointer-events-auto flex items-center gap-3 rounded-full border border-accent/25 bg-slate-950/70 py-1 pl-1 pr-4 text-left text-slate-200 shadow-2xl backdrop-blur-md transition-colors hover:border-accent/60"
    >
      <MiniGlobe size={64} />
      <span className="flex flex-col leading-tight">
        <span className="flex items-center gap-2">
          <span className="font-mono text-lg tabular-nums tracking-wider">{d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>
          <Orb state={state} level={presence.level} size={20} />
        </span>
        <span className="font-mono text-[10px] text-slate-400">
          UTC{offset >= 0 ? '+' : ''}
          {offset}
          {w ? ` · ${Math.round(w.temp)}° ${w.summary}` : ''}
          {aqi !== undefined && <span className={aqi > 150 ? 'text-danger' : aqi > 100 ? 'text-warm' : ''}> · AQI {aqi}</span>}
        </span>
        <span className="font-mono text-[10px] text-accent/80">{view ? `${fmtLat(view.lat)} · ${fmtLon(view.lon)}` : place ? place.place.name : ''}</span>
      </span>
    </button>
  )
}
