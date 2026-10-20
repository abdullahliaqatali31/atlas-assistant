import type { Map as MapLibre } from 'maplibre-gl'
import { useEffect, useState } from 'react'

import { dms, groundResolution, metres, MODE_LABEL, sunElevation, type DisplayMode } from './hud.ts'
import type { LayerId } from './layers.ts'

const isLite = () => document.documentElement.dataset.lite === 'true'

/** The ironbow thermal palette: dark → purple → red → orange → near-white, by brightness. */
export function DisplayDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <filter id="atlas-ironbow" colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values="0.3 0.59 0.11 0 0  0.3 0.59 0.11 0 0  0.3 0.59 0.11 0 0  0 0 0 1 0" />
        <feComponentTransfer>
          <feFuncR type="table" tableValues="0.02 0.32 0.78 0.98 1 1" />
          <feFuncG type="table" tableValues="0.01 0.02 0.12 0.45 0.82 0.98" />
          <feFuncB type="table" tableValues="0.08 0.45 0.38 0.08 0.18 0.85" />
        </feComponentTransfer>
      </filter>
    </svg>
  )
}

const GRAIN = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.55'/></svg>")`

/** The light overlays each mode adds over the map (grain, scanlines, vignette) and the scope. */
export function DisplayFx({ mode, scope }: { mode: DisplayMode; scope: boolean }) {
  const lite = isLite()
  return (
    <div className="pointer-events-none absolute inset-0 z-[1]" aria-hidden>
      {mode === 'nvg' && (
        <>
          <div className={`absolute inset-0 mix-blend-overlay opacity-40 ${lite ? '' : 'animate-[atlas-grain_0.4s_steps(4)_infinite]'}`} style={{ backgroundImage: GRAIN }} />
          <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at center, transparent 55%, rgba(0,20,0,0.55) 100%)' }} />
        </>
      )}
      {mode === 'crt' && (
        <>
          <div className="absolute inset-0" style={{ backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 1px, transparent 1px, transparent 3px)' }} />
          <div className={`absolute inset-0 bg-amber-200/[0.03] ${lite ? '' : 'animate-[atlas-flicker_3s_infinite]'}`} />
          <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.6) 100%)' }} />
        </>
      )}
      {mode === 'thermal' && <div className="absolute inset-0 mix-blend-overlay opacity-20" style={{ backgroundImage: GRAIN }} />}
      {scope && <div className="absolute inset-0 transition-opacity duration-500" style={{ background: 'radial-gradient(circle at center, transparent 0, transparent 40%, rgba(2,6,12,0.55) 52%, rgba(2,6,12,0.93) 62%)' }} />}
    </div>
  )
}

const LABEL: Partial<Record<LayerId, string>> = { flights: 'FLT', ships: 'SHIP', satellites: 'SAT', quakes: 'QK', events: 'EVT', disasters: 'ALRT', cameras: 'CAM', launches: 'LNCH', radio: 'RADIO' }

/**
 * The tactical HUD: corner brackets, a header line, REC and the UTC clock,
 * the centre in degrees, ground resolution, sun elevation, and live counts.
 * All real numbers from the map; repainted on move and once a second.
 */
/** Where the HUD reads the view from: the flat map, or the 3D view through a small adapter. */
export interface HudSource {
  getCenter(): { lat: number; lng: number }
  getZoom(): number
  on(type: 'move', fn: () => void): unknown
  off(type: 'move', fn: () => void): unknown
}

export function TacticalHud({ map, mode, counts }: { map: HudSource | MapLibre | null; mode: DisplayMode; counts: Partial<Record<LayerId, number>> }) {
  const [, tick] = useState(0)
  const [blink, setBlink] = useState(true)
  useEffect(() => {
    const t = setInterval(() => {
      tick(n => n + 1)
      setBlink(b => !b)
    }, 1000)
    let raf = 0
    const onMove = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => tick(n => n + 1))
    }
    map?.on('move', onMove)
    return () => {
      clearInterval(t)
      cancelAnimationFrame(raf)
      map?.off('move', onMove)
    }
  }, [map])
  if (!map) return null
  const c = map.getCenter()
  const z = map.getZoom()
  const now = new Date()
  const sun = sunElevation(c.lat, c.lng, now)
  const gsd = groundResolution(c.lat, z)
  const corner = 'absolute size-6 border-accent/70'
  const mono = 'font-mono text-[10px] uppercase tracking-[0.14em] text-accent/90 [text-shadow:0_0_6px_rgba(0,0,0,0.9)]'
  const stats = Object.entries(LABEL)
    .filter(([k]) => typeof counts[k as LayerId] === 'number')
    .map(([k, v]) => `${v} ${counts[k as LayerId]}`)

  return (
    <div className="pointer-events-none absolute inset-0 z-[2]" aria-hidden>
      <span className={`${corner} left-3 top-[6rem] border-l-2 border-t-2`} />
      <span className={`${corner} right-14 top-[6rem] border-r-2 border-t-2`} />
      <span className={`${corner} bottom-[4.75rem] left-3 border-b-2 border-l-2`} />
      <span className={`${corner} bottom-[4.75rem] right-14 border-b-2 border-r-2`} />
      {/* Crosshair at the centre. */}
      <span className="absolute left-1/2 top-1/2 h-5 w-px -translate-x-1/2 -translate-y-1/2 bg-accent/60" />
      <span className="absolute left-1/2 top-1/2 h-px w-5 -translate-x-1/2 -translate-y-1/2 bg-accent/60" />
      <span className="absolute left-1/2 top-1/2 size-12 -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent/25" />
      <div className={`absolute left-6 top-[6.75rem] space-y-0.5 ${mono}`}>
        <p>ATLAS // WORLD // LIVE</p>
        <p className="text-accent/60">{MODE_LABEL[mode]} · Z{z.toFixed(1)}</p>
      </div>
      <div className={`absolute right-16 top-[6.75rem] space-y-0.5 text-right ${mono}`}>
        <p>
          <span className={blink ? 'text-red-500' : 'text-red-500/30'}>●</span> REC {now.toISOString().slice(0, 10)} {now.toISOString().slice(11, 19)}Z
        </p>
        {stats.length > 0 && <p className="text-accent/60">{stats.join(' · ')}</p>}
      </div>
      <div className={`absolute bottom-[5.5rem] left-6 space-y-0.5 ${mono}`}>
        <p>{dms(c.lat, c.lng)}</p>
        <p className="text-accent/60">
          {c.lat.toFixed(4)}, {c.lng.toFixed(4)}
        </p>
      </div>
      <div className={`absolute bottom-[5.5rem] right-16 space-y-0.5 text-right ${mono}`}>
        <p>GSD {metres(gsd)}/PX</p>
        <p className="text-accent/60">
          SUN {sun >= 0 ? '+' : ''}
          {sun.toFixed(1)}° {sun < -6 ? 'NIGHT' : sun < 0 ? 'TWILIGHT' : 'DAY'}
        </p>
      </div>
    </div>
  )
}
