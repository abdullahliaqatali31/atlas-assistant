import { History, MoreHorizontal, Settings2, SlidersHorizontal, Type } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { CHAT_VIEW_CHOICES, type ChatView } from './chatview.ts'

/**
 * The Conversation header's "More" menu: earlier chats, connections, setup,
 * and the chat view (text size, spacing, style, width) right there, so a
 * change shows at once behind the menu.
 */
export function ChatMenu({
  view,
  onView,
  onChats,
  onControls,
  onSetup,
  locked,
}: {
  view: ChatView
  onView: (v: ChatView) => void
  onChats: () => void
  onControls?: () => void
  onSetup: () => void
  locked: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', esc, true)
    }
  }, [open])
  const go = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }
  const item = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-text hover:bg-surface-strong disabled:opacity-50'

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} className="icon-btn" aria-label="More" aria-expanded={open} title="Chats, chat view, connections, setup">
        <MoreHorizontal className="size-4" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="ask-pop glass absolute right-0 top-9 z-40 w-64 rounded-xl bg-solid/95 p-1.5 shadow-2xl">
          <button type="button" role="menuitem" className={item} onClick={go(onChats)} disabled={locked}>
            <History className="size-3.5 text-muted" aria-hidden /> Earlier chats
          </button>
          {onControls && (
            <button type="button" role="menuitem" className={item} onClick={go(onControls)}>
              <SlidersHorizontal className="size-3.5 text-muted" aria-hidden /> Connections and permissions
            </button>
          )}
          <button type="button" role="menuitem" className={item} onClick={go(onSetup)}>
            <Settings2 className="size-3.5 text-muted" aria-hidden /> Setup
          </button>
          <div className="mx-1 my-1.5 border-t border-border" />
          <p className="hud-label flex items-center gap-1.5 px-2 pb-1">
            <Type className="size-3" aria-hidden /> Chat view
          </p>
          {(Object.keys(CHAT_VIEW_CHOICES) as (keyof ChatView)[]).map(k => (
            <div key={k} className="flex items-center justify-between gap-2 px-2 py-1">
              <span className="text-[11px] text-muted">{CHAT_VIEW_CHOICES[k].label}</span>
              <div className="flex rounded-lg border border-border bg-bg p-0.5" role="radiogroup" aria-label={CHAT_VIEW_CHOICES[k].label}>
                {CHAT_VIEW_CHOICES[k].options.map(o => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={view[k] === o.value}
                    onClick={() => onView({ ...view, [k]: o.value })}
                    className={`rounded-md px-1.5 py-0.5 text-[11px] transition-colors ${view[k] === o.value ? 'bg-accent-soft text-accent' : 'text-muted hover:text-text'}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
