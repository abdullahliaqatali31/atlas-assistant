import { Square } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent } from 'react'

import { Orb } from '../ui/Orb.tsx'
import type { Presence } from '../Jarvis.tsx'
import { STOP_EVENT, useLive } from './live.ts'
import { LiveOrb } from '../ui/LiveOrb.tsx'

const LABEL: Record<string, string> = { listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking' }
const KEY = 'presence.pill'

/** Where the pill sits: which side, and how far down (0 top … 1 bottom). Remembered. */
type Spot = { side: 'left' | 'right'; y: number }

const readSpot = (): Spot => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Spot>
    return { side: s.side === 'right' ? 'right' : 'left', y: typeof s.y === 'number' ? Math.max(0, Math.min(1, s.y)) : 0.82 }
  } catch {
    return { side: 'left', y: 0.82 }
  }
}

/**
 * Atlas's presence on any page while the conversation is closed: orb, what it
 * is doing, its newest words and Stop. Drag it anywhere; it snaps to the
 * nearer side. Click opens the conversation.
 */
export function PresencePill({ presence, onOpen }: { presence: Presence; onOpen: () => void }) {
  const live = useLive()
  const [spot, setSpot] = useState<Spot>(readSpot)
  const [dragAt, setDragAt] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const moved = useRef(false)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(spot))
    } catch {
      // A spot that is not remembered is fine.
    }
  }, [spot])

  if (presence.state === 'idle' || !(presence.state in LABEL)) return null
  const caption = presence.state === 'listening' ? '' : (live?.text ?? '').replace(/\s+/g, ' ').trim()

  const parent = () => ref.current?.parentElement?.getBoundingClientRect()
  const down = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('button[data-stop]')) return
    moved.current = false
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    const box = parent()
    if (!box) return
    moved.current = true
    setDragAt({ x: e.clientX - box.left, y: e.clientY - box.top })
  }
  const up = (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement
    if (!el.hasPointerCapture(e.pointerId)) return
    el.releasePointerCapture(e.pointerId)
    const box = parent()
    if (moved.current && box && dragAt) setSpot({ side: dragAt.x > box.width / 2 ? 'right' : 'left', y: Math.max(0, Math.min(1, dragAt.y / box.height)) })
    else onOpen()
    setDragAt(null)
  }

  const style = dragAt
    ? { left: dragAt.x, top: dragAt.y, transform: 'translate(-50%, -50%)' }
    : { [spot.side]: 12, top: `clamp(12px, calc(${spot.y * 100}% - 28px), calc(100% - 68px))` }

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label="Open the conversation"
      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onOpen()}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      className={`rise-in absolute z-40 flex max-w-[min(340px,calc(100%-24px))] cursor-grab touch-none select-none items-center gap-2 rounded-full border border-border bg-solid/95 py-1 pl-1 pr-1.5 shadow-2xl ${dragAt ? 'cursor-grabbing' : 'transition-[top,left,right] duration-200'}`}
      style={style}
    >
      <LiveOrb state={presence.state} size={40} />
      <div className="min-w-0 flex-1">
        <p className={`text-[11px] font-medium ${presence.state === 'listening' ? 'text-warm' : 'text-accent'}`} role="status">
          {LABEL[presence.state]}
        </p>
        {caption && (
          <p className="truncate text-xs text-text" dir="auto">
            {caption.length > 90 ? `…${caption.slice(-90)}` : caption}
          </p>
        )}
      </div>
      <button type="button" data-stop className="btn h-8 shrink-0 gap-1 rounded-full border-warm/60 px-2.5 text-xs text-warm" onClick={() => window.dispatchEvent(new Event(STOP_EVENT))} title="Stop (Esc)">
        <Square className="size-3 fill-current" aria-hidden /> Stop
      </button>
    </div>
  )
}
