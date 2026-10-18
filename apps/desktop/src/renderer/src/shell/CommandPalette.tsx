import { CornerDownLeft, Search, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { ASK_EVENT } from './live.ts'
import { searchCommands } from './search.ts'

export interface Command {
  id: string
  group: string
  label: string
  hint?: string | undefined
  icon?: ReactNode
  /** Extra words that should find it ("dark", "light" for themes). */
  keywords?: string
  run: () => void
}

/** Things the palette reads only while it is open: places, tasks, projects, apps. */
export type CommandSource = () => Promise<Command[]>

/**
 * Ctrl+K: one box to go anywhere or do anything — pages, places, tasks,
 * projects, apps and shell actions. Typing something it doesn't know offers
 * to ask Atlas instead. Arrow keys move, Enter runs, Esc closes.
 */
export function CommandPalette({ open, onClose, commands, sources }: { open: boolean; onClose: () => void; commands: Command[]; sources: CommandSource[] }) {
  const [query, setQuery] = useState('')
  const [extra, setExtra] = useState<Command[]>([])
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    input.current?.focus()
    let live = true
    void Promise.allSettled(sources.map(s => s())).then(rs => {
      if (live) setExtra(rs.flatMap(r => (r.status === 'fulfilled' ? r.value : [])))
    })
    return () => {
      live = false
    }
  }, [open])

  const results = useMemo(() => {
    const found = query.trim() ? searchCommands([...commands, ...extra], query) : commands
    const ask: Command[] = query.trim()
      ? [{ id: 'ask', group: 'Ask', label: `Ask Atlas: “${query.trim()}”`, icon: <Sparkles />, run: () => window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: query.trim() })) }]
      : []
    return [...found, ...ask]
  }, [query, commands, extra])

  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    list.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) return null
  const run = (c: Command | undefined) => {
    if (!c) return
    onClose()
    c.run()
  }

  let lastGroup = ''
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 px-3 pt-[12vh]" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Command palette" className="ask-pop glass flex max-h-[min(520px,70vh)] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl bg-solid/95 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted" aria-hidden />
          <input
            ref={input}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setIndex(i => Math.min(results.length - 1, i + 1)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setIndex(i => Math.max(0, i - 1)))
              else if (e.key === 'Enter') (e.preventDefault(), run(results[index]))
              else if (e.key === 'Escape') (e.preventDefault(), onClose())
            }}
            placeholder="Go to, do, or ask…"
            aria-label="Search commands"
            aria-controls="palette-list"
            aria-activedescendant={results[index] ? `cmd-${index}` : undefined}
            className="bare-input h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-border px-1.5 font-mono text-[10px] text-muted">Esc</kbd>
        </div>
        <ul ref={list} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted">Nothing matches.</li>}
          {results.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null
            lastGroup = c.group
            return (
              <li key={`${c.id}-${i}`}>
                {head && <p className="hud-label px-2.5 pb-1 pt-2">{head}</p>}
                <button
                  type="button"
                  id={`cmd-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === index}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => run(c)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm ${i === index ? 'bg-accent-soft text-text' : 'text-text/90'}`}
                >
                  <span className={`shrink-0 [&_svg]:size-4 ${i === index ? 'text-accent' : 'text-muted'}`}>{c.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="shrink-0 truncate font-mono text-[10px] text-muted">{c.hint}</span>}
                  {i === index && <CornerDownLeft className="size-3.5 shrink-0 text-muted" aria-hidden />}
                </button>
              </li>
            )
          })}
        </ul>
        <p className="hidden border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted sm:block">↑↓ move · Enter run · / ask · G H home · G W world · [ ] switch panel</p>
      </div>
    </div>
  )
}
