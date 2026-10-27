/**
 * Where the side panel sits and how big it is: docked on the right or the
 * left of the stage, or floating anywhere over it; its width (per panel),
 * the floating box, and whether it is collapsed to a slim strip or expanded
 * over the whole stage. Drag the header to move it (drop it on an edge to
 * dock there), drag an edge to resize. Remembered in this window only.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type RefObject } from 'react'

export type PanelPlace = 'left' | 'right' | 'float'
export type ResizeEdge = 'w' | 'e' | 's' | 'se'

export interface PanelLayout {
  place: PanelPlace
  /** Width per panel (chat, today, news…), px. */
  widths: Record<string, number>
  float: { x: number; y: number; w: number; h: number }
  collapsed: boolean
  expanded: boolean
}

const KEY = 'drawer.layout'
const MIN_W = 320
/** A docked panel leaves the stage at least this much. */
const STAGE_MIN = 340
/** Drop within this of an edge to dock there. */
const SNAP = 80
export const STRIP_W = 44

const DEFAULT: PanelLayout = { place: 'right', widths: {}, float: { x: 80, y: 40, w: 440, h: 560 }, collapsed: false, expanded: false }

const load = (): PanelLayout => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PanelLayout> | null
    if (!raw) return DEFAULT
    return {
      place: raw.place === 'left' || raw.place === 'float' ? raw.place : 'right',
      widths: raw.widths && typeof raw.widths === 'object' ? raw.widths : {},
      float: raw.float && typeof raw.float.x === 'number' ? raw.float : DEFAULT.float,
      collapsed: raw.collapsed === true,
      expanded: false,
    }
  } catch {
    return DEFAULT
  }
}

const save = (l: PanelLayout) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...l, expanded: false }))
  } catch {
    // Private mode or full storage: the layout lasts until the window closes.
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi), v))

export interface Drag {
  rect: { x: number; y: number; w: number; h: number }
  zone: PanelPlace
}

export function usePanelLayout(area: RefObject<HTMLElement | null>, panel: string, wide: boolean) {
  const [layout, setRaw] = useState<PanelLayout>(load)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [drag, setDrag] = useState<Drag | null>(null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const update = useCallback((fn: (l: PanelLayout) => PanelLayout) => {
    setRaw(l => {
      const next = fn(l)
      save(next)
      return next
    })
  }, [])

  // The area appears after the app's first screens: watch it from whenever it exists.
  const observed = useRef<{ el: HTMLElement; ro: ResizeObserver; frame: number } | null>(null)
  useEffect(() => {
    const el = area.current
    if (!el || observed.current?.el === el) return
    if (observed.current) {
      observed.current.ro.disconnect()
      cancelAnimationFrame(observed.current.frame)
    }
    // At most one size update per frame, and none when the size did not change.
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      setSize(s => (s.w === w && s.h === h ? s : { w, h }))
    }
    const ro = new ResizeObserver(() => {
      const o = observed.current
      if (!o || o.frame) return
      o.frame = requestAnimationFrame(() => {
        o.frame = 0
        measure()
      })
    })
    ro.observe(el)
    observed.current = { el, ro, frame: 0 }
    measure()
  })
  useEffect(
    () => () => {
      observed.current?.ro.disconnect()
      if (observed.current) cancelAnimationFrame(observed.current.frame)
    },
    [],
  )

  const docked = layout.place !== 'float'
  const maxW = docked ? size.w - STAGE_MIN : size.w - 16
  // Not measured yet: no upper limit rather than squeezing the panel to its minimum.
  const width = clamp(layout.widths[panel] ?? (wide ? 560 : 420), MIN_W, size.w ? maxW : 2000)
  const float = {
    w: clamp(layout.float.w, MIN_W, size.w ? size.w - 16 : 2000),
    h: clamp(layout.float.h, 200, size.h ? size.h - 8 : 2000),
    x: 0,
    y: 0,
  }
  float.x = clamp(layout.float.x, 0, size.w - float.w)
  float.y = clamp(layout.float.y, 0, size.h - Math.min(float.h, 48))

  /**
   * Press on the header and move: the panel follows; drop on an edge to dock, elsewhere to float.
   * The app re-renders only when the drag starts and when the edge it would dock to changes; in
   * between the panel moves itself (a transform), and the place is saved on release.
   */
  const startMove = (e: RPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button,input,select,textarea,a,[data-nodrag]')) return
    const el = area.current
    const aside = (e.currentTarget as HTMLElement).closest('aside')
    if (!el || !aside) return
    const box = el.getBoundingClientRect()
    const r = aside.getBoundingClientRect()
    const sx = e.clientX
    const sy = e.clientY
    const w = Math.min(r.width, 520)
    const h = layoutRef.current.place === 'float' ? r.height : Math.min(r.height, Math.max(360, box.height * 0.75))
    // Keep the grab point under the pointer (scaled when the panel narrows).
    const ox = ((sx - r.left) / r.width) * w
    const oy = Math.min(sy - r.top, 24)
    let moved = false
    let last: Drag | null = null
    /** Where the drag was first drawn: later moves are offsets from it. */
    let first: Drag | null = null
    let frame = 0
    const paint = () => {
      frame = 0
      if (!first || !last) return
      aside.style.transform = `translate(${last.rect.x - first.rect.x}px, ${last.rect.y - first.rect.y}px)`
    }
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return
      moved = true
      const px = ev.clientX - box.left
      const zone: PanelPlace = px < SNAP ? 'left' : px > box.width - SNAP ? 'right' : 'float'
      last = { zone, rect: { x: clamp(px - ox, 0, box.width - w), y: clamp(ev.clientY - box.top - oy, 0, box.height - 40), w, h } }
      if (!first) {
        first = last
        setDrag(first)
        return
      }
      if (zone !== first.zone) {
        first = { ...first, zone }
        setDrag(first)
      }
      frame ||= requestAnimationFrame(paint)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      cancelAnimationFrame(frame)
      aside.style.transform = ''
      setDrag(null)
      const d = last
      if (!moved || !d) return
      update(l => ({ ...l, place: d.zone, expanded: false, ...(d.zone === 'float' ? { float: d.rect } : {}) }))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * Drag an edge: the docked panel's inner edge sets its width; a floating one resizes from its sides and corner.
   * While dragging, the panel's own style follows the pointer (no app re-render); the size is saved on release.
   */
  const startResize = (e: RPointerEvent<HTMLElement>, edge: ResizeEdge) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const aside = (e.currentTarget as HTMLElement).closest('aside')
    const sx = e.clientX
    const sy = e.clientY
    const l0 = layoutRef.current
    const w0 = width
    const f0 = float
    // The style React drew: put back before the new size is committed, so React's own record stays true.
    const before = aside ? { left: aside.style.left, width: aside.style.width, height: aside.style.height } : null
    document.body.style.cursor = edge === 's' ? 'ns-resize' : edge === 'se' ? 'nwse-resize' : 'ew-resize'
    document.body.style.userSelect = 'none'
    let next: ((l: PanelLayout) => PanelLayout) | null = null
    let frame = 0
    let draw: () => void = () => undefined
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      if (l0.place === 'float') {
        const f = { ...f0 }
        if (edge === 'e' || edge === 'se') f.w = f0.w + dx
        if (edge === 'w') {
          f.w = f0.w - dx
          f.x = f0.x + dx
        }
        if (edge === 's' || edge === 'se') f.h = f0.h + dy
        f.w = clamp(f.w, MIN_W, size.w - f.x)
        f.h = clamp(f.h, 200, size.h - f.y)
        next = l => ({ ...l, float: f })
        draw = () => {
          if (!aside) return
          aside.style.left = `${f.x}px`
          aside.style.width = `${f.w}px`
          aside.style.height = `${f.h}px`
        }
      } else {
        const w = clamp(l0.place === 'right' ? w0 - dx : w0 + dx, MIN_W, maxW)
        next = l => ({ ...l, widths: { ...l.widths, [panel]: w } })
        draw = () => {
          if (aside) aside.style.width = `${w}px`
        }
      }
      // No panel to draw on (never expected): fall back to state.
      if (!aside) return setRaw(next)
      frame ||= requestAnimationFrame(() => {
        frame = 0
        draw()
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      cancelAnimationFrame(frame)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      if (aside && before) Object.assign(aside.style, before)
      if (next) update(next)
      else save(layoutRef.current)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return { layout, update, size, drag, width, float, startMove, startResize }
}
