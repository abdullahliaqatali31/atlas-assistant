import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import type { Count } from './counts.ts'

export interface RailItem {
  id: string
  label: string
  icon: ReactNode
  count?: Count | undefined
  active: boolean
  onClick: () => void
  /** The hover overview's body; shown beside the rail after a short pause. */
  peek?: ReactNode
}

const OPEN_DELAY = 220
const CLOSE_DELAY = 160

const COLLAPSED_KEY = 'sidebar.collapsed'
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * The sidebar on the left, as on any web app: each module with its icon, name
 * and a live badge; it folds to icons only (remembered). Folded, hovering or
 * focusing an icon shows an overview card beside it; a click opens the full
 * panel. On phone-width screens it becomes a bottom bar without hover cards.
 * The pages in the top bar (Brain, World, Profiles, Browser) are not repeated here.
 */
export function Rail({ items, bottom, horizontal = false }: { items: RailItem[]; bottom: RailItem[]; horizontal?: boolean }) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const fold = (v: boolean) => {
    setCollapsed(v)
    try {
      localStorage.setItem(COLLAPSED_KEY, String(v))
    } catch {
      // Remembered for this visit only.
    }
  }
  const [peek, setPeek] = useState<{ item: RailItem; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const navRef = useRef<HTMLElement>(null)

  const later = (fn: () => void, ms: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(fn, ms)
  }
  const show = (item: RailItem, el: HTMLElement, now = false) => {
    // With names showing, the overview cards would only get in the way.
    if (!item.peek || !collapsed) return
    const r = el.getBoundingClientRect()
    const go = () => setPeek({ item, y: r.top + r.height / 2 })
    if (now || peek) go()
    else later(go, OPEN_DELAY)
  }
  const hide = () => later(() => setPeek(null), CLOSE_DELAY)
  useEffect(() => () => clearTimeout(timer.current), [])

  // Keep the open card current when counts change underneath it.
  const all = [...items, ...bottom]
  const current = peek ? all.find(i => i.id === peek.item.id) : undefined

  if (horizontal) {
    return (
      <nav className="glass mx-2 mb-2 flex h-12 shrink-0 items-center justify-between gap-0.5 no-scrollbar overflow-x-auto rounded-2xl px-1" aria-label="Main">
        {all.map(i => (
          <RailCell key={i.id} item={i} horizontal />
        ))}
      </nav>
    )
  }

  const cell = (i: RailItem) => (
    <RailCell
      key={i.id}
      item={i}
      wide={!collapsed}
      onEnter={el => show(i, el)}
      onLeave={hide}
      onFocus={el => show(i, el, true)}
      onClick={() => {
        clearTimeout(timer.current)
        setPeek(null)
        i.onClick()
      }}
    />
  )

  return (
    <>
      <nav
        ref={navRef}
        className={`glass mb-2 ml-2 flex shrink-0 flex-col gap-0.5 no-scrollbar overflow-y-auto overflow-x-hidden rounded-2xl py-2 transition-[width] duration-150 ${collapsed ? 'w-12 items-center' : 'w-48 px-2'}`}
        aria-label="Main"
      >
        {items.map(cell)}
        <div className="min-h-2 flex-1" />
        {bottom.map(cell)}
        <div className={`my-1 h-px bg-border ${collapsed ? 'w-5' : 'w-full'}`} aria-hidden />
        <button
          type="button"
          onClick={() => fold(!collapsed)}
          className={`flex items-center gap-2.5 rounded-xl text-muted transition-colors hover:bg-surface-strong hover:text-text ${collapsed ? 'size-9 justify-center' : 'h-9 w-full px-2.5 text-[13px]'}`}
          aria-label={collapsed ? 'Show the names' : 'Fold the sidebar'}
          title={collapsed ? 'Show the names' : 'Fold the sidebar'}
        >
          {collapsed ? <PanelLeftOpen className="size-4 stroke-[1.75]" aria-hidden /> : <PanelLeftClose className="size-4 stroke-[1.75]" aria-hidden />}
          {!collapsed && <span>Fold</span>}
        </button>
      </nav>
      {peek && current && (
        <PeekCard
          item={current}
          y={peek.y}
          left={navRef.current ? navRef.current.getBoundingClientRect().right + 8 : 64}
          onEnter={() => clearTimeout(timer.current)}
          onLeave={hide}
          onOpen={() => {
            setPeek(null)
            current.onClick()
          }}
        />
      )}
    </>
  )
}

function RailCell({
  item,
  wide = false,
  onEnter,
  onLeave,
  onFocus,
  onClick,
  horizontal = false,
}: {
  item: RailItem
  horizontal?: boolean
  /** The name beside the icon (the unfolded sidebar). */
  wide?: boolean
  onEnter?: (el: HTMLElement) => void
  onLeave?: () => void
  onFocus?: (el: HTMLElement) => void
  onClick?: () => void
}) {
  const label = item.count?.hint ?? item.label
  const badge = item.count?.value && item.count.value !== '0' ? item.count.value : null
  return (
    <button
      type="button"
      onClick={onClick ?? item.onClick}
      onMouseEnter={e => onEnter?.(e.currentTarget)}
      onMouseLeave={onLeave}
      onFocus={e => e.currentTarget.matches(':focus-visible') && onFocus?.(e.currentTarget)}
      onBlur={onLeave}
      aria-label={`${item.label}${item.count?.hint && item.count.hint !== item.label ? `: ${item.count.hint}` : ''}`}
      title={wide ? (item.count?.hint && item.count.hint !== item.label ? item.count.hint : undefined) : onEnter ? undefined : label}
      aria-current={item.active ? 'page' : undefined}
      className={`group relative rounded-xl transition-colors ${horizontal ? "grid h-9 min-w-0 max-w-11 flex-1 place-items-center" : wide ? "flex h-9 w-full shrink-0 items-center gap-2.5 px-2.5 text-left text-[13px]" : "grid size-9 shrink-0 place-items-center"} ${
        item.active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-strong hover:text-text'
      }`}
    >
      {item.active && <span className={`absolute rounded-full bg-accent ${horizontal ? 'inset-x-2.5 -bottom-1 h-0.5' : wide ? 'inset-y-2 -left-2 w-0.5' : 'inset-y-2 -left-1.5 w-0.5'}`} aria-hidden />}
      <span className="shrink-0 [&_svg]:size-4 [&_svg]:stroke-[1.75]">{item.icon}</span>
      {wide && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
      {badge && (
        <span
          className={`${wide ? 'relative' : 'absolute -right-0.5 -top-0.5'} min-w-3.5 rounded-full px-1 text-center font-mono text-[9px] font-medium leading-[14px] tabular-nums ring-2 ring-[var(--solid)] ${
            item.count?.attention ? 'bg-warm text-black' : item.active ? 'bg-accent text-black' : 'bg-surface-strong text-text'
          }`}
          aria-hidden
        >
          {badge.length > 4 ? badge.slice(0, 4) : badge}
        </span>
      )}
    </button>
  )
}

/** The overview card, to the right of the sidebar and lined up with the hovered icon. */
function PeekCard({ item, y, left, onEnter, onLeave, onOpen }: { item: RailItem; y: number; left: number; onEnter: () => void; onLeave: () => void; onOpen: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(y - 28)
  // Keep the card inside the window.
  useEffect(() => {
    const h = ref.current?.offsetHeight ?? 0
    setTop(Math.max(8, Math.min(y - 28, window.innerHeight - h - 8)))
  }, [y, item.id])
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${item.label} overview`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ top, left }}
      className="peek-card glass fixed z-50 w-[min(300px,calc(100vw-5rem))] rounded-xl p-3 text-xs shadow-2xl"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-accent [&_svg]:size-3.5">{item.icon}</span>
        <span className="flex-1 truncate font-medium">{item.label}</span>
        {item.count?.value && <span className={`truncate text-[10px] ${item.count.attention ? 'text-warm' : 'text-muted'}`}>{item.count.hint}</span>}
      </div>
      {item.peek}
      <button type="button" onClick={onOpen} className="mt-2.5 w-full rounded-lg border border-border py-1 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent">
        {item.active ? 'Already open' : 'Open details'}
      </button>
    </div>
  )
}
