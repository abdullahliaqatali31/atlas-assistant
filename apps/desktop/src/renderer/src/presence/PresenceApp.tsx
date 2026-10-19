import { Check, ExternalLink, GripVertical, Mic, Square, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'

import type { PresenceState } from '../../../shared/presence.ts'
import { Orb, type OrbState } from '../ui/Orb.tsx'

const LABEL = { idle: 'Atlas', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking' } as const
const ORB: Record<PresenceState['activity'], OrbState> = { idle: 'idle', listening: 'listening', thinking: 'thinking', speaking: 'speaking' }
const ZOOM = { s: 0.85, m: 1, l: 1.2 } as const

/** Window-dragging areas; anything clickable inside opts out. */
const drag: CSSProperties = { WebkitAppRegion: 'drag' } as CSSProperties
const noDrag: CSSProperties = { WebkitAppRegion: 'no-drag' } as CSSProperties

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
  const [hover, setHover] = useState(false)
  const root = useRef<HTMLDivElement>(null)

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

  const shape = !s ? 'dot' : s.card ? 'card' : s.activity !== 'idle' ? 'pill' : hover ? 'peek' : 'dot'
  const busy = s?.activity === 'thinking' || s?.activity === 'speaking'

  return (
    <div ref={root} className="inline-block p-1" style={{ zoom: ZOOM[s?.scale ?? 'm'] }} onContextMenu={menu} onMouseLeave={() => setHover(false)}>
      {shape === 'dot' || shape === 'peek' ? (
        // Idle: a quiet orb. The rim drags; the middle talks; hovering says so.
        <div className="flex items-center gap-2 rounded-full border border-border bg-solid/95 p-1 shadow-lg" style={drag} onMouseEnter={() => setHover(true)}>
          <button type="button" className="grid size-12 place-items-center rounded-full" style={noDrag} onClick={() => void window.presence.talk()} title="Talk to Atlas (right-click for options)" aria-label="Talk to Atlas">
            <Orb state="idle" size={44} />
          </button>
          {shape === 'peek' && (
            <div className="flex items-center gap-1 pr-2 text-xs text-text">
              <button type="button" className="btn h-7 gap-1 rounded-full px-2.5 text-xs" style={noDrag} onClick={() => void window.presence.talk()}>
                <Mic className="size-3.5" aria-hidden /> Talk
              </button>
              <button type="button" className="icon-btn size-7" style={noDrag} onClick={() => void window.presence.open()} title="Open Atlas" aria-label="Open Atlas">
                <ExternalLink className="size-3.5" aria-hidden />
              </button>
            </div>
          )}
        </div>
      ) : shape === 'pill' && s ? (
        <div className="flex w-[340px] items-center gap-2 rounded-full border border-border bg-solid/95 py-1 pl-1 pr-1.5 shadow-lg" style={drag}>
          <button type="button" className="grid size-12 shrink-0 place-items-center rounded-full" style={noDrag} onClick={() => void window.presence.open()} title="Open the conversation" aria-label="Open the conversation">
            <Orb state={ORB[s.activity]} level={s.level} size={44} />
          </button>
          <div className="min-w-0 flex-1 py-0.5">
            <p className={`text-[11px] font-medium ${s.activity === 'listening' ? 'text-warm' : 'text-accent'}`} role="status">
              {LABEL[s.activity]}
            </p>
            {s.caption && (
              <p className="line-clamp-2 text-xs leading-snug text-text" dir="auto">
                {tail(s.caption)}
              </p>
            )}
          </div>
          {(busy || s.activity === 'listening') && (
            <button type="button" className="btn h-8 shrink-0 gap-1 rounded-full border-warm/60 px-2.5 text-xs text-warm" style={noDrag} onClick={() => void window.presence.stop()} title="Stop">
              <Square className="size-3 fill-current" aria-hidden /> Stop
            </button>
          )}
        </div>
      ) : s?.card ? (
        <div className="w-[360px] rounded-2xl border border-border bg-solid/95 shadow-xl">
          <header className="flex items-center gap-2 px-2 pt-2" style={drag}>
            <Orb state={ORB[s.activity]} level={s.level} size={28} />
            <span className="flex-1 text-xs font-medium text-text">{s.card.kind === 'approval' ? `${s.name} needs your OK` : s.name}</span>
            <GripVertical className="size-3.5 text-muted" aria-hidden />
            {s.card.kind === 'initiative' && (
              <button type="button" className="icon-btn size-7" style={noDrag} onClick={() => void window.presence.initiative((s.card as { id: string }).id, 'dismiss')} aria-label="Close" title="Close">
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
                <p className="mt-1 font-mono text-[11px] text-muted">{s.card.tool}</p>
              </>
            ) : (
              <p className="text-sm leading-snug text-text" dir="auto">
                {s.caption && s.activity !== 'idle' ? tail(s.caption, 220) : s.card.text}
              </p>
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5" style={noDrag}>
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
