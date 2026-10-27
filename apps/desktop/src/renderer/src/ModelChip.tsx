import { Check, ChevronDown, Cpu, Loader2, Search, Sparkles, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { LLM_PROVIDERS, type LlmProviderId } from '@assistant/providers/llm-presets'
import { BrandIcon } from './ui/BrandIcon.tsx'

import type { ChatModelChoice } from '../../shared/ipc.ts'
import { POWER_PROVIDERS } from '../../shared/powerup.ts'

type View = { choice: ChatModelChoice; provider: LlmProviderId; main: string; quick: string }

/** "claude-opus-5-5" → "Opus 5.5"; "gpt-5.1-mini" → "GPT 5.1 mini". */
export const prettyModel = (id: string) => {
  const s = id.replace(/^(claude|models\/)-?/i, '').replace(/-(\d+)-(\d+)\b/g, ' $1.$2').replace(/[-_]/g, ' ').replace(/\bgpt\b/i, 'GPT').trim()
  return s.replace(/\b([a-z])/g, (m, c: string, i: number) => (i === 0 ? c.toUpperCase() : m)) || id
}

const label = (v: View) => (v.choice.kind === 'model' ? prettyModel(v.choice.model) : v.choice.kind === 'main' ? `Best · ${prettyModel(v.main || 'main')}` : v.choice.kind === 'quick' ? `Quick · ${prettyModel(v.quick || 'quick')}` : 'Auto')

/**
 * The chat's model chip: which brain answers. Auto (quick model for simple
 * messages, the main one for real work), always the best, always the quick,
 * or any model from any provider whose key is saved in Power up. Applies from
 * the next message; remembered.
 */
export function ModelChip({ disabled }: { disabled?: boolean }) {
  const [view, setView] = useState<View | null>(null)
  const [open, setOpen] = useState(false)
  const [providers, setProviders] = useState<LlmProviderId[]>([])
  const [browsing, setBrowsing] = useState<LlmProviderId | null>(null)
  const [models, setModels] = useState<string[] | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.assistant.chatModel().then(setView, () => undefined)
  }, [])
  useEffect(() => {
    if (!open) return
    void window.powerup.state().then(rows => setProviders(POWER_PROVIDERS.filter(p => p.llm && rows.find(r => r.id === p.id)?.set).map(p => p.llm!)), () => setProviders([]))
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
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

  const pick = async (choice: ChatModelChoice) => {
    setError('')
    try {
      setView(await window.assistant.setChatModel(choice))
      setOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not switch.')
    }
  }
  const browse = (p: LlmProviderId) => {
    setBrowsing(p)
    setModels(null)
    setFilter('')
    void window.assistant.listModels(p, '', '').then(
      list => setModels(list),
      e => {
        setModels([])
        setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not list models.')
      },
    )
  }

  if (!view) return null
  const is = (c: ChatModelChoice) => JSON.stringify(c) === JSON.stringify(view.choice)
  const row = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-surface-strong'
  const shown = (models ?? []).filter(m => m.toLowerCase().includes(filter.toLowerCase())).slice(0, 60)

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className="flex h-7 max-w-[11rem] items-center gap-1 rounded-full border border-border bg-bg px-2 text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-text"
        title="Which model answers (applies from your next message)"
        aria-expanded={open}
      >
        <Cpu className="size-3 shrink-0 text-accent" aria-hidden />
        <span className="truncate">{label(view)}</span>
        <ChevronDown className="size-3 shrink-0" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="ask-pop glass absolute right-0 top-9 z-40 w-72 rounded-xl bg-solid/95 p-1.5 shadow-2xl">
          <button type="button" className={row} onClick={() => void pick({ kind: 'auto' })}>
            <Sparkles className="size-3.5 text-accent" aria-hidden />
            <span className="flex-1">
              Auto <span className="block text-[10px] text-muted">Quick model for small talk, the best for real work</span>
            </span>
            {is({ kind: 'auto' }) && <Check className="size-3.5 text-accent" aria-hidden />}
          </button>
          <button type="button" className={row} onClick={() => void pick({ kind: 'main' })}>
            <Cpu className="size-3.5 text-accent" aria-hidden />
            <span className="flex-1">
              Always the best <span className="block text-[10px] text-muted">{LLM_PROVIDERS[view.provider].label} · {view.main ? prettyModel(view.main) : 'its main model'}</span>
            </span>
            {is({ kind: 'main' }) && <Check className="size-3.5 text-accent" aria-hidden />}
          </button>
          <button type="button" className={row} onClick={() => void pick({ kind: 'quick' })}>
            <Zap className="size-3.5 text-warm" aria-hidden />
            <span className="flex-1">
              Always quick <span className="block text-[10px] text-muted">Cheaper and faster; still hands real work to the best</span>
            </span>
            {is({ kind: 'quick' }) && <Check className="size-3.5 text-accent" aria-hidden />}
          </button>
          <div className="mx-1 my-1.5 border-t border-border" />
          <p className="hud-label px-2 pb-1">Pick a model</p>
          {providers.length === 0 && <p className="px-2 pb-1 text-[11px] text-muted">Add another brain in Setup › Power up to see more.</p>}
          <div className="flex flex-wrap gap-1 px-1.5 pb-1">
            {providers.map(p => (
              <button key={p} type="button" onClick={() => browse(p)} className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${browsing === p ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}`}>
                <BrandIcon id={p} size={16} />
                {LLM_PROVIDERS[p].label}
              </button>
            ))}
          </div>
          {browsing && (
            <div className="px-1">
              <label className="mb-1 flex items-center gap-1.5 rounded-lg border border-border bg-bg px-2">
                <Search className="size-3 text-muted" aria-hidden />
                <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter models" className="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none" />
              </label>
              <div className="max-h-52 overflow-y-auto">
                {models === null ? (
                  <p className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted">
                    <Loader2 className="size-3 animate-spin" aria-hidden /> Asking {LLM_PROVIDERS[browsing].label}…
                  </p>
                ) : (
                  shown.map(m => (
                    <button key={m} type="button" className={row} onClick={() => void pick({ kind: 'model', provider: browsing, model: m })}>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={m}>
                        {m}
                      </span>
                      {is({ kind: 'model', provider: browsing, model: m }) && <Check className="size-3.5 text-accent" aria-hidden />}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
          {error && <p className="px-2 pt-1 text-[11px] text-danger">{error}</p>}
        </div>
      )}
    </div>
  )
}
