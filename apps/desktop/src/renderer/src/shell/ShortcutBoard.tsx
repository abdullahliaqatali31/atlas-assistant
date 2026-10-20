/**
 * The shortcut board: every keyboard shortcut in one place. Global ones
 * work anywhere in Windows (Atlas minimised or behind other apps); a warning
 * marks any that another app has taken. Opens with "?", Ctrl+Alt+/, the
 * palette, the rail or the tray.
 */
import { AlertTriangle, Globe, Keyboard, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { acceleratorKeys, APP_SHORTCUTS, type ShortcutsView } from '../../../shared/shortcuts.ts'

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((k, i) => (
        <kbd key={i} className="min-w-6 rounded-md border border-b-2 border-border bg-surface-strong px-1.5 py-0.5 text-center font-mono text-[11px] text-text">
          {k}
        </kbd>
      ))}
    </span>
  )
}

export function ShortcutBoard({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<ShortcutsView | null>(null)
  useEffect(() => {
    void window.shortcuts.list().then(setView, () => undefined)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose} role="presentation">
      <section
        className="glass pop-in flex max-h-[min(720px,92vh)] w-[min(880px,100%)] flex-col overflow-hidden rounded-2xl bg-solid shadow-2xl"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Keyboard className="size-5 text-accent" aria-hidden />
          <h2 id="shortcuts-title" className="flex-1 text-base font-semibold">
            Keyboard shortcuts
          </h2>
          <span className="hidden items-center gap-1.5 whitespace-nowrap text-xs text-muted sm:flex">
            Press <Keys keys={['?']} /> any time
          </span>
          <button type="button" className="icon-btn size-8" onClick={onClose} aria-label="Close">
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="grid gap-4 overflow-y-auto p-4 md:grid-cols-2">
          <div className="tile space-y-2 p-3 md:col-span-2">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <Globe className="size-4 text-accent" aria-hidden /> Anywhere in Windows
              <span className="text-xs font-normal text-muted">· even while Atlas is minimised</span>
            </h3>
            <ul className="grid gap-x-6 gap-y-1.5 md:grid-cols-2">
              {(view?.global ?? []).map(s => (
                <li key={s.id} className="flex items-center gap-3 rounded-lg px-1 py-1" title={s.detail}>
                  <Keys keys={acceleratorKeys(s.accelerator)} />
                  <span className="min-w-0 flex-1 text-sm">
                    {s.label}
                    {!s.ok && (
                      <span className="ml-1.5 inline-flex items-center gap-1 text-[11px] text-warm">
                        <AlertTriangle className="size-3" aria-hidden /> taken by another app
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {APP_SHORTCUTS.map(g => (
            <div key={g.group} className="tile space-y-2 p-3">
              <h3 className="text-sm font-medium">{g.group}</h3>
              <ul className="space-y-1">
                {g.items.map(s => (
                  <li key={`${s.keys.join('+')}-${s.label}`} className="flex items-center gap-3 text-sm">
                    <Keys keys={s.keys} />
                    <span className="min-w-0 flex-1 text-muted">{s.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
