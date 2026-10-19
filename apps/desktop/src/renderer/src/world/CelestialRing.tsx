/**
 * The celestial ring (after God's Eye View): with the whole globe in view, a
 * ring around it shows which way the Sun and the Moon are, the point each
 * stands over, and the Moon's phase. Drawn in the page over the 3D canvas,
 * only after Cesium renders a frame (it renders on demand), at most 20 times
 * a second; the Sun and Moon are recomputed once a minute.
 */
import * as Cesium from '@cesium/engine'
import { Moon, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { latLonLabel, moonPhase, moonPosition, ringAngle, sunPosition, towards } from './sky.ts'

interface Mark {
  x: number
  y: number
  visibility: number
}

interface Ring {
  cx: number
  cy: number
  r: number
  sun: Mark
  moon: Mark
}

const GAP = 34
const FRAME_MS = 50

const v3 = (c: { x: number; y: number; z: number }) => [c.x, c.y, c.z] as const

export function CelestialRing({ widget }: { widget: Cesium.CesiumWidget }) {
  const [ring, setRing] = useState<Ring | null>(null)
  const [sky, setSky] = useState(() => ({ at: new Date(), sun: sunPosition(new Date()), moon: moonPosition(new Date()), phase: moonPhase(new Date()) }))
  const skyRef = useRef(sky)
  skyRef.current = sky

  // The Sun and Moon move slowly: once a minute, and ask Cesium for a frame so the ring follows.
  useEffect(() => {
    const t = setInterval(() => {
      const at = new Date()
      setSky({ at, sun: sunPosition(at), moon: moonPosition(at), phase: moonPhase(at) })
      if (!document.hidden && !widget.isDestroyed()) widget.scene.requestRender()
    }, 60_000)
    return () => clearInterval(t)
  }, [widget])

  useEffect(() => {
    const scene = widget.scene
    let last = 0
    const place = () => {
      const now = performance.now()
      if (now - last < FRAME_MS) return
      last = now
      const cam = scene.camera
      const canvas = scene.canvas
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const centre = Cesium.SceneTransforms.worldToWindowCoordinates(scene, Cesium.Cartesian3.ZERO)
      const dist = Cesium.Cartesian3.magnitude(cam.positionWC)
      const fovy = (cam.frustum as { fovy?: number }).fovy ?? Math.PI / 3
      const r = (Math.tan(Math.asin(Math.min(1, Cesium.Ellipsoid.WGS84.maximumRadius / dist))) / Math.tan(fovy / 2)) * (h / 2)
      // Only while the whole globe (and the ring) fits on screen.
      if (!centre || !Number.isFinite(r) || r + GAP + 22 > Math.min(w, h) / 2 || centre.x < 0 || centre.y < 0 || centre.x > w || centre.y > h) {
        setRing(null)
        return
      }
      const right = v3(cam.rightWC)
      const up = v3(cam.upWC)
      const fwd = v3(cam.directionWC)
      const mark = (dir: readonly number[]): Mark => {
        const a = ringAngle(dir, right, up, fwd)
        return { x: centre.x + (r + GAP) * Math.cos(a.angle), y: centre.y - (r + GAP) * Math.sin(a.angle), visibility: a.visibility }
      }
      const s = skyRef.current
      setRing({ cx: centre.x, cy: centre.y, r: r + GAP, sun: mark(towards(s.sun)), moon: mark(towards(s.moon)) })
    }
    const off = scene.postRender.addEventListener(place)
    scene.requestRender()
    return () => {
      off()
      setRing(null)
    }
  }, [widget])

  if (!ring) return null
  const pct = Math.round(sky.phase.fraction * 100)
  return (
    <div className="pointer-events-none absolute inset-0">
      <svg className="absolute inset-0 h-full w-full">
        <circle cx={ring.cx} cy={ring.cy} r={ring.r} fill="none" stroke="rgba(125,211,252,0.35)" strokeWidth="1" strokeDasharray="2 6" />
        <line x1={ring.cx} y1={ring.cy} x2={ring.sun.x} y2={ring.sun.y} stroke="rgba(253,224,71,0.18)" strokeWidth="1" opacity={ring.sun.visibility} />
      </svg>
      <Marker m={ring.sun} cx={ring.cx} className="text-yellow-300" glow="rgba(253,224,71,0.55)" icon={<Sun className="size-5" aria-hidden />} title="SUN" detail={`over ${latLonLabel(sky.sun)}`} />
      <Marker m={ring.moon} cx={ring.cx} className="text-slate-200" glow="rgba(226,232,240,0.45)" icon={<Moon className="size-4" aria-hidden />} title={`MOON · ${pct}%`} detail={`${sky.phase.name} · over ${latLonLabel(sky.moon)}`} />
    </div>
  )
}

function Marker({ m, cx, className, glow, icon, title, detail }: { m: Mark; cx: number; className: string; glow: string; icon: React.ReactNode; title: string; detail: string }) {
  const left = m.x < cx
  return (
    <div className={`absolute flex items-center gap-1.5 transition-opacity ${className} ${left ? 'flex-row-reverse text-right' : ''}`} style={{ left: m.x, top: m.y, opacity: m.visibility, transform: `translate(${left ? 'calc(-100% + 11px)' : '-11px'}, -50%)` }}>
      <span className="grid size-[22px] place-items-center rounded-full bg-black/50" style={{ boxShadow: `0 0 14px ${glow}` }}>
        {icon}
      </span>
      <span className="font-mono text-[10px] uppercase leading-tight tracking-[0.12em] [text-shadow:0_0_6px_rgba(0,0,0,0.9)]">
        {title}
        <br />
        <span className="normal-case tracking-normal text-white/60">{detail}</span>
      </span>
    </div>
  )
}
