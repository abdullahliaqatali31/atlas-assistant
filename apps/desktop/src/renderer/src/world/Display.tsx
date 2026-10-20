import type { Map as MapLibre } from 'maplibre-gl'
import { useEffect, useState } from 'react'

import { groundResolution, metres, MODE_LABEL, sunElevation, type DisplayMode } from './hud.ts'
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
 * The tactical HUD: a turning reticle and one strip under the toolbar with
 * live time, mode and zoom, then (as room allows) the counts, ground
 * resolution and sun. No frames: it reflows with the pane.
 * All real numbers from the map; repainted on move and once a second.
 */
/** Where the HUD reads the view from: the flat map, or the 3D view through a small adapter. */
export interface HudSource {
  getCenter(): { lat: number; lng: number }
  getZoom(): number
  on(type: 'move', fn: () => void): unknown
  off(type: 'move', fn: () => void): unknown
}

/** The reticle over the map's centre: a still cross inside a slowly turning ring. */
export function TacticalHud() {
  return (
    <div className="pointer-events-none absolute inset-0 z-[2]" aria-hidden>
      <span className="absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-accent/60" />
      <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 bg-accent/60" />
      <span className="absolute left-1/2 top-1/2 -ml-7 -mt-7 size-14">
        <span className="hud-reticle block size-full rounded-full border border-dashed border-accent/35" />
      </span>
    </div>
  )
}

/**
 * The HUD's readout, as one chip in the map's toolbar (so it wraps with the
 * other buttons and never sits under them): live time, mode and zoom, then
 * counts, ground resolution and sun as the pane's width allows.
 */
export function HudChip({ map, mode, counts }: { map: HudSource | MapLibre | null; mode: DisplayMode; counts: Partial<Record<LayerId, number>> }) {
  const [, tick] = useState(0)
  const [blink, setBlink] = useState(true)
  useEffect(() => {
    const t = setInterval(() => {
      tick(n => n + 1)
      setBlink(b => !b)
    }, 1000)
    let raf = 0
    let lastMove = 0
    // Ten readouts a second while the view moves: numbers need no more, and the map keeps its frames.
    const onMove = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (performance.now() - lastMove < 100) return
        lastMove = performance.now()
        tick(n => n + 1)
      })
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
  const stats = Object.entries(LABEL)
    .filter(([k]) => typeof counts[k as LayerId] === 'number')
    .map(([k, v]) => [v, counts[k as LayerId]!] as const)
  return (
    <span className="pointer-events-none flex h-8 min-w-0 max-w-full items-center gap-2 overflow-hidden whitespace-nowrap rounded-full border border-accent/25 bg-slate-950/60 px-3 font-mono text-[10px] uppercase tracking-[0.12em] text-accent/90 backdrop-blur-sm" aria-hidden>
      <span className={blink ? 'text-red-500' : 'text-red-500/30'}>●</span>
      <span>{now.toISOString().slice(11, 19)}Z</span>
      <span className="text-accent/70">
        {MODE_LABEL[mode]} Z{z.toFixed(1)}
      </span>
      {stats.length > 0 && (
        <span className="hidden gap-2 @min-[1100px]:flex">
          {stats.map(([k, v]) => (
            <span key={k}>
              <span className="text-accent/55">{k}</span> {v.toLocaleString()}
            </span>
          ))}
        </span>
      )}
      <span className="hidden gap-2 @min-[1500px]:flex">
        <span>GSD {metres(gsd)}</span>
        <span className="text-accent/70">
          Sun {sun >= 0 ? '+' : ''}
          {sun.toFixed(0)}° {sun < -6 ? 'night' : sun < 0 ? 'dusk' : 'day'}
        </span>
      </span>
    </span>
  )
}
