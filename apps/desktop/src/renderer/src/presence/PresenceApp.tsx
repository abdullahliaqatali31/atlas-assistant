import { Check, GripVertical, Mic, Square, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'

import type { PresenceState } from '../../../shared/presence.ts'
import { Orb, type OrbState } from '../ui/Orb.tsx'

const LABEL = { idle: 'Atlas', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking' } as const
const ORB: Record<PresenceState['activity'], OrbState> = { idle: 'idle', listening: 'listening', thinking: 'thinking', speaking: 'speaking' }
const ZOOM = { s: 0.85, m: 1, l: 1.2 } as const

/**
 * Press and move to drag the widget (main moves the window with the cursor);
 * press and let go without moving to click. Buttons marked data-nodrag keep
 * their own clicks. No OS drag regions: they swallow clicks and fight hover.
 */
const useDrag = (onClick?: () => void) => {
  const start = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  const end = () => {
    if (start.current?.dragging) void window.presence.dragEnd()
    start.current = null
  }
  return {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('[data-nodrag]')) return
      start.current = { x: e.screenX, y: e.screenY, dragging: false }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const s = start.current
      if (!s || s.dragging || Math.hypot(e.screenX - s.x, e.screenY - s.y) < 4) return
      s.dragging = true
      void window.presence.dragStart()
    },
    onPointerUp: () => {
      const s = start.current
      end()
      if (s && !s.dragging) onClick?.()
    },
    onLostPointerCapture: end,
  }
}

/** The last sentence or two, so the caption reads at a glance. */
const tail = (text: string, max = 140) => {
  const t = text.replace(/\*\*|__|`|^\s*#+\s*|^\s*[-*•]\s+/gm, '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(-max)
  const start = cut.search(/(?<=[.!?۔؟]\s)\S/)
  return `…${start > 0 ? cut.slice(start) : cut}`
}

/**
 * The desktop widget's page. Three shapes, chosen by what Atlas is doing:
 * a dot (idle), a pill (listening, thinking, speaking) and a card (Atlas spoke
 * up or needs a yes). The page measures itself and main fits the window to it.
 */
export function PresenceApp() {
  const [s, setS] = useState<PresenceState | null>(null)
  const root = useRef<HTMLDivElement>(null)
  // The orb talks when Atlas is quiet and stops it when busy (the pill's Stop, while the glass panel keeps the widget compact).
  const talkDrag = useDrag(() => void (s && s.activity !== 'idle' ? window.presence.stop() : window.presence.talk()))
  const openDrag = useDrag(() => void window.presence.open())
  const plainDrag = useDrag()

  useEffect(() => window.presence.onState(setS), [])

  // Fit the window to whatever is showing now.
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const fit = () => {
      const r = el.getBoundingClientRect()
      void window.presence.resize(Math.ceil(r.width), Math.ceil(r.height))
    }
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    fit()
    return () => ro.disconnect()
  }, [])

  const menu = (e: MouseEvent) => {
    e.preventDefault()
    void window.presence.menu()
  }

  const shape = !s ? 'dot' : s.card ? 'card' : s.activity !== 'idle' && !s.glass ? 'pill' : 'dot'
  const busy = s?.activity === 'thinking' || s?.activity === 'speaking'

  return (
    <div ref={root} className={`inline-block p-1 ${s?.fullControl ? '[&>*]:!border-warm [&>*]:shadow-[0_0_14px_rgba(251,191,36,0.55)]' : ''}`} style={{ zoom: ZOOM[s?.scale ?? 'm'] }} onContextMenu={menu} title={s?.fullControl ? 'Full control is on' : undefined}>
      {shape === 'dot' ? (
        // Idle: a quiet orb. Click to talk, drag to move, right-click for options. It never changes size on hover.
        <div
          {...talkDrag}
          role="button"
          tabIndex={0}
          onKeyDown={e => e.key === 'Enter' && void (s && s.activity !== 'idle' ? window.presence.stop() : window.presence.talk())}
          className="relative grid size-14 cursor-grab touch-none select-none place-items-center rounded-full border border-border bg-solid/95 shadow-lg transition-shadow hover:shadow-[0_0_18px_var(--accent-soft)] active:cursor-grabbing"
          title={s && s.activity !== 'idle' ? 'Click to stop · drag to move' : 'Click to talk · drag to move · right-click for options'}
          aria-label="Talk to Atlas"
        >
          <Orb state={ORB[s?.activity ?? 'idle']} level={s?.level ?? 0} size={44} />
          {!!s && s.waiting + s.later > 0 && (
            <span className={`absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full px-1 text-[9px] font-bold text-black ${s.waiting ? 'bg-warm' : 'bg-accent'}`} aria-label={`${s.waiting} waiting, ${s.later} for later`}>
              {s.waiting || s.later}
            </span>
          )}
        </div>
      ) : shape === 'pill' && s ? (
        <div {...openDrag} className="flex w-[340px] cursor-grab touch-none select-none items-center gap-2 rounded-full border border-border bg-solid/95 py-1 pl-1 pr-1.5 shadow-lg active:cursor-grabbing" title="Click to open the conversation · drag to move">
          <div className="grid size-12 shrink-0 place-items-center rounded-full">
            <Orb state={ORB[s.activity]} level={s.level} size={44} />
          </div>
          <div className="min-w-0 flex-1 py-0.5">
            <p className={`text-[11px] font-medium ${s.activity === 'listening' ? 'text-warm' : 'text-accent'}`} role="status">
              {LABEL[s.activity]}
            </p>
            {s.caption && (
              <p className="line-clamp-2 text-xs leading-snug text-text" dir="auto">
                {tail(s.caption)}
              </p>
            )}
            {(s.browsing || s.memories > 0) && (
              <p className="mt-0.5 flex gap-2 truncate text-[10px] text-muted">
                {s.browsing && <span className="truncate">🌐 Browsing {s.browsing}</span>}
                {s.memories > 0 && <span>🧠 Using {s.memories} {s.memories === 1 ? 'memory' : 'memories'}</span>}
              </p>
            )}
          </div>
          {(busy || s.activity === 'listening') && (
            <button type="button" data-nodrag className="btn h-8 shrink-0 gap-1 rounded-full border-warm/60 px-2.5 text-xs text-warm" onClick={() => void window.presence.stop()} title="Stop">
              <Square className="size-3 fill-current" aria-hidden /> Stop
            </button>
          )}
        </div>
      ) : s?.card ? (
        <div className="w-[360px] rounded-2xl border border-border bg-solid/95 shadow-xl">
          <header {...plainDrag} className="flex cursor-grab touch-none select-none items-center gap-2 px-2 pt-2 active:cursor-grabbing">
            <Orb state={ORB[s.activity]} level={s.level} size={28} />
            <span className="flex-1 text-xs font-medium text-text">{s.card.kind === 'approval' ? `${s.name} needs your OK` : s.name}</span>
            <GripVertical className="size-3.5 text-muted" aria-hidden />
            {s.card.kind === 'initiative' && (
              <button type="button" data-nodrag className="icon-btn size-7" onClick={() => void window.presence.initiative((s.card as { id: string }).id, 'dismiss')} aria-label="Close" title="Close">
                <X className="size-3.5" aria-hidden />
              </button>
            )}
          </header>
          <div className="px-3 pb-3 pt-1.5">
            {s.card.kind === 'locked' ? (
              <p className="text-sm text-text">Something is waiting for you. Open Atlas and confirm it's you to see it.</p>
            ) : s.card.kind === 'approval' ? (
              <>
                <p className="text-sm leading-snug text-text" dir="auto">
                  {s.card.summary}
                </p>
                <p className="mt-1 font-mono text-[11px] text-muted">
                  {s.card.tool}
                  {s.waiting > 1 ? ` · +${s.waiting - 1} more waiting` : ''}
                </p>
              </>
            ) : (
              <p className="text-sm leading-snug text-text" dir="auto">
                {s.caption && s.activity !== 'idle' ? tail(s.caption, 220) : s.card.text}
              </p>
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {s.card.kind === 'approval' && (
                <>
                  <button type="button" className="btn btn-primary h-8 gap-1 px-3 text-xs" onClick={() => void window.presence.approval((s.card as { id: string }).id, true)}>
                    <Check className="size-3.5" aria-hidden /> Haan
                  </button>
                  <button type="button" className="btn h-8 px-3 text-xs" onClick={() => void window.presence.approval((s.card as { id: string }).id, false)}>
                    Nahi
                  </button>
                </>
              )}
              {s.card.kind === 'initiative' && (
                <>
                  {busy && (
                    <button type="button" className="btn h-8 gap-1 border-warm/60 px-2.5 text-xs text-warm" onClick={() => void window.presence.stop()}>
                      <Square className="size-3 fill-current" aria-hidden /> Stop
                    </button>
                  )}
                  <button type="button" className="btn h-8 px-2.5 text-xs" onClick={() => void window.presence.talk()}>
                    <Mic className="size-3.5" aria-hidden /> Reply
                  </button>
                  <button type="button" className="btn h-8 px-2.5 text-xs" onClick={() => void window.presence.initiative((s.card as { id: string }).id, 'snooze')}>
                    Not now
                  </button>
                  {s.card.canMute && (
                    <button type="button" className="h-8 rounded px-1.5 text-[11px] text-muted hover:text-text" onClick={() => void window.presence.initiative((s.card as { id: string }).id, 'mute')}>
                      Don't remind me
                    </button>
                  )}
                </>
              )}
              <button type="button" className="ml-auto h-8 rounded px-1.5 text-[11px] text-muted hover:text-text" onClick={() => void window.presence.open()}>
                Open Atlas
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
