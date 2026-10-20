/**
 * Where the World map's panels (Intelligence, Cameras, Markets, VIP people,
 * Geography, Launches) sit: one docked on the right, any number floating
 * over the map (dragged by the header, resized from the corner), and up to
 * four pinned as cards in a tray along the map's bottom, so the information
 * the owner always wants stays in view. Each panel is in one place at a
 * time. Remembered in this window.
 */
import { useCallback, useRef, useState, type PointerEvent as RPointerEvent } from 'react'

import type { DockId } from './Dock.tsx'

export const MAX_PINNED = 4
export const TRAY_MIN = 160
export const TRAY_MAX = 520

export interface FloatRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PanelState {
  side: DockId | null
  floats: Partial<Record<DockId, FloatRect>>
  pinned: DockId[]
  trayH: number
  trayOpen: boolean
}

const KEY = 'world.panels'
const EMPTY: PanelState = { side: null, floats: {}, pinned: [], trayH: 240, trayOpen: true }

const load = (): PanelState => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PanelState> | null
    if (!raw) return EMPTY
    // Floating and side panels open fresh each time; the pinned tray is what stays.
    return { ...EMPTY, pinned: Array.isArray(raw.pinned) ? raw.pinned.slice(0, MAX_PINNED) : [], trayH: typeof raw.trayH === 'number' ? raw.trayH : EMPTY.trayH, trayOpen: raw.trayOpen !== false }
  } catch {
    return EMPTY
  }
}

const save = (s: PanelState) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ pinned: s.pinned, trayH: s.trayH, trayOpen: s.trayOpen }))
  } catch {
    // Private mode: the tray lasts until the window closes.
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(Math.max(lo, hi), v))

/** Take a panel out of wherever it is. */
const without = (s: PanelState, id: DockId): PanelState => {
  const floats = { ...s.floats }
  delete floats[id]
  return { ...s, side: s.side === id ? null : s.side, floats, pinned: s.pinned.filter(p => p !== id) }
}

export function useWorldPanels(area: () => HTMLElement | null) {
  const [state, setRaw] = useState<PanelState>(load)
  const stateRef = useRef(state)
  stateRef.current = state
  const set = useCallback((fn: (s: PanelState) => PanelState) => {
    setRaw(s => {
      const next = fn(s)
      save(next)
      return next
    })
  }, [])

  const isOpen = (id: DockId) => state.side === id || !!state.floats[id] || state.pinned.includes(id)

  /** A toolbar button or key: close it if it is open anywhere, else open it on the side. */
  const toggle = (id: DockId) => set(s => (s.side === id || s.floats[id] || s.pinned.includes(id) ? without(s, id) : { ...without(s, id), side: id }))
  /** Open on the side (Atlas's map_panel), or close with null. */
  const showSide = (id: DockId | null) => set(s => (id === null ? { ...s, side: null } : s.pinned.includes(id) || s.floats[id] ? s : { ...without(s, id), side: id }))
  const close = (id: DockId) => set(s => without(s, id))
  const dockSide = (id: DockId) => set(s => ({ ...without(s, id), side: id }))
  const pin = (id: DockId) =>
    set(s => {
      const rest = without(s, id)
      // Full tray: the oldest pinned card makes room.
      const pinned = [...rest.pinned, id].slice(-MAX_PINNED)
      return { ...rest, pinned, trayOpen: true }
    })
  const float = (id: DockId) =>
    set(s => {
      const el = area()
      const w = 360
      const h = Math.min(520, (el?.clientHeight ?? 600) - 120)
      const n = Object.keys(s.floats).length
      const x = clamp((el?.clientWidth ?? 1000) / 2 - w / 2 + n * 28, 8, (el?.clientWidth ?? 1000) - w - 8)
      return { ...without(s, id), floats: { ...without(s, id).floats, [id]: { x, y: 64 + n * 28, w, h } } }
    })
  const setTray = (patch: Partial<Pick<PanelState, 'trayH' | 'trayOpen'>>) => set(s => ({ ...s, ...patch }))

  /** Press a floating panel's header and move: it follows within the map. */
  const startMove = (id: DockId, e: RPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button,input,select,a,textarea')) return
    const el = area()
    const f = stateRef.current.floats[id]
    if (!el || !f) return
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    const move = (ev: PointerEvent) =>
      setRaw(s => {
        const cur = s.floats[id]
        if (!cur) return s
        return { ...s, floats: { ...s.floats, [id]: { ...cur, x: clamp(f.x + ev.clientX - sx, 0, el.clientWidth - cur.w), y: clamp(f.y + ev.clientY - sy, 0, el.clientHeight - 40) } } }
      })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Drag a floating panel's corner to resize it. */
  const startResize = (id: DockId, e: RPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = area()
    const f = stateRef.current.floats[id]
    if (!el || !f) return
    const sx = e.clientX
    const sy = e.clientY
    const move = (ev: PointerEvent) =>
      setRaw(s => {
        const cur = s.floats[id]
        if (!cur) return s
        return { ...s, floats: { ...s.floats, [id]: { ...cur, w: clamp(f.w + ev.clientX - sx, 260, el.clientWidth - cur.x), h: clamp(f.h + ev.clientY - sy, 180, el.clientHeight - cur.y) } } }
      })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** Drag the tray's top edge to make the pinned cards taller or shorter. */
  const startTrayResize = (e: RPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = area()
    const sy = e.clientY
    const h0 = stateRef.current.trayH
    document.body.style.cursor = 'ns-resize'
    const move = (ev: PointerEvent) => setRaw(s => ({ ...s, trayH: clamp(h0 - (ev.clientY - sy), TRAY_MIN, Math.min(TRAY_MAX, (el?.clientHeight ?? 800) - 140)) }))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      save(stateRef.current)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return { state, isOpen, toggle, showSide, close, dockSide, pin, float, setTray, startMove, startResize, startTrayResize }
}
