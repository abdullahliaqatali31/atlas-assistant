import { useEffect, useRef, useState } from 'react'

import { MAP_VIEW_EVENT } from '../../../shared/map.ts'
import type { PlaceStatus } from '../../../shared/world.ts'
import { STATE_LABEL, useNow, type Presence } from '../Jarvis.tsx'
import { Orb, type OrbState } from '../ui/Orb.tsx'
import { nameOf } from '../ui/assistantName.ts'
import { LiveOrb } from '../ui/LiveOrb.tsx'

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
 * colour, a pulse where you are looking and a sweep around the rim. The land
 * is drawn only while the globe turns to a new view (it eases there, then
 * stops drawing); the sweep and the pulse are CSS animations on the
 * compositor, so a still globe costs nothing per frame.
 */
function MiniGlobe({ size = 64 }: { size?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext('2d')!
    const dpr = Math.min(2, devicePixelRatio || 1)
    el.width = el.height = Math.round(size * dpr)
    // Each outline as radians, thinned once (a 64 px globe needs few points).
    let rings: Float32Array[] = []
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#22d3ee'
    let target: { lat: number; lon: number } | null = null
    const at = { lat: 20, lon: 60 }
    let raf = 0
    let drawn = false
    let lastDraw = 0
    const R = (size / 2 - 2) * dpr
    const c = (size / 2) * dpr
    const draw = () => {
      const p0 = at.lat * RAD
      const l0 = at.lon * RAD
      const sp0 = Math.sin(p0)
      const cp0 = Math.cos(p0)
      ctx.clearRect(0, 0, el.width, el.height)
      const sea = ctx.createRadialGradient(c - R * 0.35, c - R * 0.35, R * 0.1, c, c, R)
      sea.addColorStop(0, '#0f2a3a')
      sea.addColorStop(1, '#030a12')
      ctx.fillStyle = sea
      ctx.beginPath()
      ctx.arc(c, c, R, 0, Math.PI * 2)
      ctx.fill()
      // All land in two passes straight on the canvas (outline, then the fully visible shapes filled):
      // two draw calls, and no path object per country.
      /** Adds a ring's near side to the current path; true when all of it faces us. */
      const trace = (ring: Float32Array) => {
        let open = false
        let all = true
        for (let i = 0; i < ring.length; i += 2) {
          const lat = ring[i + 1]!
          const dl = ring[i]! - l0
          const cp = Math.cos(lat)
          const sl = Math.sin(lat)
          const cdl = Math.cos(dl)
          if (sp0 * sl + cp0 * cp * cdl <= 0) {
            all = false
            open = false
            continue
          }
          const x = c + R * cp * Math.sin(dl)
          const y = c - R * (cp0 * sl - sp0 * cp * cdl)
          if (open) ctx.lineTo(x, y)
          else ctx.moveTo(x, y)
          open = true
        }
        return all
      }
      ctx.strokeStyle = accent
      ctx.globalAlpha = 0.85
      ctx.lineWidth = 0.8 * dpr
      ctx.beginPath()
      const whole: Float32Array[] = []
      for (const ring of rings) if (trace(ring)) whole.push(ring)
      ctx.stroke()
      ctx.fillStyle = accent
      ctx.globalAlpha = 0.22
      ctx.beginPath()
      for (const ring of whole) trace(ring)
      ctx.fill()
      ctx.globalAlpha = 0.35
      ctx.lineWidth = dpr
      ctx.beginPath()
      ctx.arc(c, c, R, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(c, c, 1.8 * dpr, 0, Math.PI * 2)
      ctx.fill()
      drawn = true
    }
    /** Ease toward the view and draw; stop once there (nothing moves on a still globe). */
    const step = () => {
      raf = 0
      if (document.hidden) return
      let moving = false
      if (target) {
        let dLon = target.lon - at.lon
        if (dLon > 180) dLon -= 360
        if (dLon < -180) dLon += 360
        const dLat = target.lat - at.lat
        moving = Math.abs(dLon) > 0.05 || Math.abs(dLat) > 0.05
        at.lon += dLon * 0.18
        at.lat += dLat * 0.18
      }
      // A 64 px globe needs no more than ~12 drawings a second, even while the map flies.
      const now = performance.now()
      if ((moving && now - lastDraw >= 80) || !drawn) {
        lastDraw = now
        draw()
      }
      if (moving || !drawn) raf = requestAnimationFrame(step)
      else if (now - lastDraw > 0) {
        // Settled between drawings: one last drawing at the final view.
        draw()
      }
    }
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(step)
    }
    const onView = (e: Event) => {
      const d = (e as CustomEvent<{ lat: number; lon: number }>).detail
      if (!d) return
      target = { lat: d.lat, lon: d.lon }
      kick()
    }
    window.addEventListener(MAP_VIEW_EVENT, onView)
    void loadLand().then(r => {
      rings = r.map(ring => {
        // A 64 px globe shows no more than ~24 points of any outline.
        const stride = Math.max(1, Math.ceil(ring.length / 24))
        const out = new Float32Array(Math.ceil(ring.length / stride) * 2)
        for (let i = 0, j = 0; i < ring.length; i += stride, j += 2) {
          out[j] = ring[i]![0] * RAD
          out[j + 1] = ring[i]![1] * RAD
        }
        return out
      })
      drawn = false
      kick()
    })
    kick()
    const onVisible = () => !document.hidden && ((drawn = false), kick())
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener(MAP_VIEW_EVENT, onView)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [size])
  return (
    <span className="relative shrink-0 rounded-full shadow-[0_0_22px_color-mix(in_srgb,var(--accent)_35%,transparent)]" style={{ width: size, height: size }} aria-hidden>
      <canvas ref={canvas} style={{ width: size, height: size }} className="block rounded-full" />
      {/* The sweep around the rim and the pulse at the centre: compositor-only CSS. */}
      <span className="mini-globe-sweep absolute inset-0 rounded-full" />
      <span className="mini-globe-pulse absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent" />
    </span>
  )
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
          <LiveOrb state={state} size={20} />
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
