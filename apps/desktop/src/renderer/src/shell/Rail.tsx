import type { ReactNode } from 'react'

import type { Count } from './counts.ts'

export interface RailItem {
  id: string
  label: string
  icon: ReactNode
  count?: Count | undefined
  active: boolean
  onClick: () => void
}

/**
 * The right rail: each module as an icon, a live number and a short name.
 * Vertical beside the stage; a scrolling bottom bar on phone-width windows.
 */
export function Rail({ top, items, bottom, horizontal = false }: { top: RailItem[]; items: RailItem[]; bottom: RailItem[]; horizontal?: boolean }) {
  if (horizontal) {
    return (
      <nav className="glass mx-2 mb-2 flex h-14 shrink-0 items-center gap-0.5 overflow-x-auto rounded-2xl px-1" aria-label="Main">
        {[...top, ...items, ...bottom].map(i => (
          <RailCell key={i.id} item={i} compact />
        ))}
      </nav>
    )
  }
  return (
    <nav className="glass mb-2 mr-2 flex w-[76px] shrink-0 flex-col items-stretch gap-0.5 overflow-y-auto overflow-x-hidden rounded-2xl px-1.5 py-2" aria-label="Main">
      {top.map(i => (
        <RailCell key={i.id} item={i} />
      ))}
      <div className="mx-2 my-1 h-px bg-border" aria-hidden />
      {items.map(i => (
        <RailCell key={i.id} item={i} />
      ))}
      <div className="min-h-2 flex-1" />
      {bottom.map(i => (
        <RailCell key={i.id} item={i} />
      ))}
    </nav>
  )
}

function RailCell({ item, compact = false }: { item: RailItem; compact?: boolean }) {
  const label = item.count?.hint ?? item.label
  return (
    <button
      type="button"
      onClick={item.onClick}
      aria-label={label}
      title={label}
      aria-current={item.active ? 'page' : undefined}
      className={`group relative flex shrink-0 flex-col items-center justify-center rounded-xl transition-colors ${compact ? 'size-11' : 'px-1 py-1.5'} ${
        item.active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-strong hover:text-text'
      }`}
    >
      {item.active && !compact && <span className="absolute inset-y-2 -right-1.5 w-0.5 rounded-full bg-accent" aria-hidden />}
      <span className="[&_svg]:size-[18px]">{item.icon}</span>
      {!compact && item.count?.value && (
        <span className={`mt-0.5 font-mono text-[11px] leading-none tabular-nums ${item.count.attention ? 'text-warm' : item.active ? 'text-accent' : 'text-text'}`}>{item.count.value}</span>
      )}
      {!compact && <span className="mt-0.5 max-w-full truncate text-[9.5px] leading-tight">{item.label}</span>}
      {compact && item.count?.value && item.count.attention && <span className="absolute right-1 top-1 size-2 rounded-full bg-warm" aria-hidden />}
    </button>
  )
}
