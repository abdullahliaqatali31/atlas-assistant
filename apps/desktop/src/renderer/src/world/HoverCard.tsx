/**
 * The hover card: rest the pointer on any map item for a moment and a
 * leader line grows out of it, then a small card with what it is. Moving to
 * another item swaps the card at once; leaving closes it after a beat. One
 * DOM overlay positioned from the map, so it themes and animates like the
 * rest of Atlas (plan §4.3). Touch screens and drags never show it.
 */
import type { Map as MapLibre, MapMouseEvent } from 'maplibre-gl'
import { useEffect, useRef, useState } from 'react'

import type { WorldSnapshot } from '../../../shared/world.ts'
import { hoverInfo, type HoverInfo } from './hover.ts'
import { pickAt, type Picked } from './pick.ts'

const SHOW_AFTER_MS = 120
const HIDE_AFTER_MS = 200
const CARD_W = 236

/** Latest camera frames, so hovering back and forth does not refetch. */
const frames = new Map<string, { src: string; at: number }>()

function CameraThumb({ id }: { id: string }) {
  const [src, setSrc] = useState(() => frames.get(id)?.src ?? null)
  useEffect(() => {
    const cached = frames.get(id)
    if (cached && Date.now() - cached.at < 30_000) return setSrc(cached.src)
    let stopped = false
    void window.world.cameraImage(id).then(
      r => {
        frames.set(id, { src: r.dataUrl, at: Date.now() })
        if (!stopped) setSrc(r.dataUrl)
      },
      () => undefined,
    )
    return () => {
      stopped = true
    }
  }, [id])
  return <div className="mt-1.5 aspect-video overflow-hidden rounded-md bg-surface">{src ? <img src={src} alt="" className="h-full w-full object-cover" /> : null}</div>
}

export function HoverCard({ map, ready, world, now }: { map: MapLibre | null; ready: boolean; world: WorldSnapshot; now: number }) {
  const [item, setItem] = useState<Picked | null>(null)
  const [, redraw] = useState(0)
  const worldRef = useRef(world)
  worldRef.current = world

  useEffect(() => {
    const m = map
    if (!m || !ready) return
    let current: string | null = null
    let showTimer: ReturnType<typeof setTimeout> | undefined
    let hideTimer: ReturnType<typeof setTimeout> | undefined
    let frame = 0
    const show = (p: Picked) => {
      current = p.key
      setItem(p)
    }
    const hide = () => {
      current = null
      setItem(null)
    }
    const onMove = (e: MapMouseEvent) => {
      // A drag is panning the map, not pointing at something.
      if ((e.originalEvent as MouseEvent).buttons) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const hit = pickAt(m, e.point)
        if (hit) {
          clearTimeout(hideTimer)
          if (hit.key === current) return
          clearTimeout(showTimer)
          // Already showing one: swap at once. Otherwise wait for the pointer to rest.
          if (current) show(hit)
          else showTimer = setTimeout(() => show(hit), SHOW_AFTER_MS)
        } else {
          clearTimeout(showTimer)
          if (current) {
            clearTimeout(hideTimer)
            hideTimer = setTimeout(hide, HIDE_AFTER_MS)
          }
        }
      })
    }
    const leave = () => {
      clearTimeout(showTimer)
      hideTimer = setTimeout(hide, HIDE_AFTER_MS)
    }
    const dismiss = () => {
      clearTimeout(showTimer)
      clearTimeout(hideTimer)
      hide()
    }
    // The card follows its point while the map moves under it.
    const follow = () => current && redraw(n => n + 1)
    m.on('mousemove', onMove)
    m.on('mouseout', leave)
    m.on('mousedown', dismiss)
    m.on('touchstart', dismiss)
    m.on('click', dismiss)
    m.on('move', follow)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(showTimer)
      clearTimeout(hideTimer)
      m.off('mousemove', onMove)
      m.off('mouseout', leave)
      m.off('mousedown', dismiss)
      m.off('touchstart', dismiss)
      m.off('click', dismiss)
      m.off('move', follow)
    }
  }, [map, ready])

  if (!map || !item) return null
  const info: HoverInfo = hoverInfo(item.kind, item.props, worldRef.current, now)
  const box = map.getContainer()
  const w = box.clientWidth
  const h = box.clientHeight
  const p = map.project(item.lngLat)
  // Away from the edges: to the right unless that would clip, above unless too near the top.
  const sx = p.x + 40 + CARD_W > w ? -1 : 1
  const sy = p.y < 150 ? -1 : 1
  const elbow = { x: p.x + 22 * sx, y: p.y - 22 * sy }
  const end = { x: elbow.x + 14 * sx, y: elbow.y }
  const place = {
    ...(sx === 1 ? { left: end.x } : { right: w - end.x }),
    ...(sy === 1 ? { bottom: h - end.y - 12 } : { top: end.y - 12 }),
    width: CARD_W,
  }
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" aria-live="polite">
      <svg key={`l-${item.key}`} className="absolute inset-0 h-full w-full" aria-hidden>
        <circle cx={p.x} cy={p.y} r={9} fill="none" stroke={info.color} strokeOpacity={0.9} strokeWidth={1.5} className="hover-ring" />
        <polyline points={`${p.x + 9 * 0.7 * sx},${p.y - 9 * 0.7 * sy} ${elbow.x},${elbow.y} ${end.x},${end.y}`} fill="none" stroke={info.color} strokeWidth={1.5} pathLength={1} className="hover-leader" />
      </svg>
      <div key={`c-${item.key}`} className="hover-card glass absolute overflow-hidden rounded-lg bg-solid/90 shadow-2xl" style={{ ...place, transformOrigin: `${sx === 1 ? 'left' : 'right'} ${sy === 1 ? 'bottom' : 'top'}` }}>
        <div className="h-0.5 w-full" style={{ background: info.color }} />
        <div className="px-2.5 py-2">
          <p className="truncate text-[13px] font-semibold leading-snug" title={info.title} dir="auto">
            {info.title}
          </p>
          <p className="mt-0.5 font-mono text-[10px] tracking-wider" style={{ color: info.color }}>
            {info.kind}
          </p>
          {info.facts.map(f => (
            <p key={f} className="truncate text-[11px] text-muted" title={f}>
              {f}
            </p>
          ))}
          {info.cameraId && <CameraThumb id={info.cameraId} />}
          <p className="mt-1 text-[10px] text-muted/80">Click for more</p>
        </div>
      </div>
    </div>
  )
}
