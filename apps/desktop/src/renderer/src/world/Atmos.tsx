/**
 * The World map's own skin, the same on the flat map and in 3D: a faint hex
 * grid that drifts, fine scanlines, a soft scan light that passes now and
 * then, film grain, a breathing Atlas mark and a vignette, all tinted by the
 * theme's accent. CSS only (compositor animations), nothing to pick, and
 * still in Lite mode or when the system asks for less motion.
 *
 * Also the loader shown while a map wakes up: the mark in a turning ring,
 * a progress bar and its percentage.
 */
import { useEffect, useState } from 'react'

import logo from '../assets/logo.svg'

export function Atmos({ dim = false }: { dim?: boolean }) {
  return (
    <div className={`atmos ${dim ? 'atmos-dim' : ''}`} aria-hidden>
      <div className="atmos-hex" />
      <div className="atmos-lines" />
      <div className="atmos-sweep" />
      <div className="atmos-grain" />
      <img src={logo} alt="" className="atmos-mark" draggable={false} />
      <div className="atmos-vignette" />
    </div>
  )
}

/**
 * The loader: shown until `progress` reaches 1 (or `done`), then it fades.
 * It waits a moment before appearing, so a quick load never flashes it.
 */
export function AtlasLoader({ progress, label, done = false }: { progress: number; label: string; done?: boolean }) {
  const finished = done || progress >= 1
  const [shown, setShown] = useState(false)
  const [gone, setGone] = useState(false)
  useEffect(() => {
    if (finished) {
      const t = setTimeout(() => setGone(true), 650)
      return () => clearTimeout(t)
    }
    setGone(false)
    const t = setTimeout(() => setShown(true), 250)
    return () => clearTimeout(t)
  }, [finished])
  if (gone || !shown) return null
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100)
  return (
    <div className={`atlas-loader ${finished ? 'atlas-loader-out' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <div className="relative grid size-28 place-items-center">
        <svg viewBox="0 0 100 100" className="absolute inset-0 size-full" aria-hidden>
          <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="1.5" />
          <circle cx="50" cy="50" r="38" fill="none" stroke="currentColor" strokeOpacity="0.08" strokeWidth="1" />
          <circle className="atlas-loader-arc" cx="50" cy="50" r="46" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="60 229" />
        </svg>
        <img src={logo} alt="" className="size-11 drop-shadow-[0_0_14px_var(--accent)]" draggable={false} />
      </div>
      <p className="mt-6 text-2xl font-light uppercase tracking-[0.45em] text-slate-100">Atlas</p>
      <p className="mt-1 text-xs uppercase tracking-[0.35em] text-accent/80">{label}</p>
      <div className="mt-8 h-1 w-[min(440px,70vw)] overflow-hidden rounded-full bg-white/5">
        <div className="h-full rounded-full bg-accent shadow-[0_0_12px_var(--accent)] transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 w-[min(440px,70vw)] text-right font-mono text-xs text-accent/80">{pct}%</p>
    </div>
  )
}
