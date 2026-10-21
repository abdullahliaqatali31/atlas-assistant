/**
 * Settings › Security › Web access: where Atlas can be opened (this PC, and
 * the home network if allowed), codes to pair another browser, the browsers
 * that are paired, and forgetting this one.
 */
import { Copy, ExternalLink, Globe, LogOut, Trash2, Wifi } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { WebAccessView } from '../../../shared/web.ts'
import { nameOf } from '../ui/assistantName.ts'
import { unpair } from './transport.ts'

const clean = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.')

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

function Shell({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <section className="tile space-y-3 p-4">
      <header className="flex items-center gap-2.5">
        <span className="inline-flex size-9 items-center justify-center rounded-xl border border-border bg-surface-strong text-accent">
          <Globe className="size-[18px]" />
        </span>
        <h2 className="font-medium">Web access</h2>
        {note && <span className="ml-auto rounded-full border border-ok/50 bg-ok/10 px-2 py-0.5 text-[11px] text-ok">{note}</span>}
      </header>
      {children}
    </section>
  )
}

export function WebAccessCard() {
  const [view, setView] = useState<WebAccessView | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    void window.webAccess.state().then(setView, e => setError(clean(e)))
    return window.webAccess.onChanged(setView)
  }, [])
  // The code's countdown.
  useEffect(() => {
    if (!view?.codeExpiresAt) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [view?.codeExpiresAt])

  const run = async (fn: () => Promise<WebAccessView | void>) => {
    setError('')
    try {
      const v = await fn()
      if (v) setView(v)
    } catch (e) {
      setError(clean(e))
    }
  }

  if (!view) return error ? <Shell><p className="text-xs text-danger">{error}</p></Shell> : null
  const left = view.codeExpiresAt ? Math.max(0, Math.round((view.codeExpiresAt - now) / 1000)) : 0
  const online = view.devices.filter(d => d.online).length

  return (
    <Shell note={online ? `${online} browser${online > 1 ? 's' : ''} connected` : undefined}>
      <p className="text-xs text-muted">
        {nameOf()} runs on this PC and shows itself in your browser. Each browser connects once (with a code, or the tray icon's own link) and can be removed here. The PC must be on for any of them to work.
      </p>

      <label className="flex items-start gap-2 rounded-xl border border-border p-2.5 text-sm">
        <input type="checkbox" className="mt-0.5" checked={view.lan} onChange={e => void run(() => window.webAccess.set({ lan: e.target.checked }))} />
        <span>
          <span className="flex items-center gap-1.5 font-medium">
            <Wifi className="size-4 text-accent" aria-hidden /> Also from my home network
          </span>
          <span className="block text-xs text-muted">
            A phone or laptop on the same Wi-Fi can open it (it still needs a code). The link is not encrypted on the network, and browsers allow the microphone only
            on this PC, so voice works here and typing works everywhere.
          </span>
        </span>
      </label>

      {view.running && (
        <div className="space-y-1.5">
          {view.urls.map(u => (
            <div key={u} className="flex items-center gap-2 rounded-lg bg-surface-strong px-2.5 py-1.5 font-mono text-xs">
              <span className="min-w-0 flex-1 truncate">{u}</span>
              <button type="button" className="text-muted hover:text-text" title="Copy" onClick={() => void navigator.clipboard.writeText(u)}>
                <Copy className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" className="btn btn-primary" onClick={() => void run(() => window.webAccess.newCode())}>
              New code
            </button>
            <button type="button" className="btn" onClick={() => void run(() => window.webAccess.open())}>
              <ExternalLink className="size-3.5" aria-hidden /> Open in the default browser
            </button>
            <button type="button" className="btn text-danger" onClick={() => void unpair()}>
              <LogOut className="size-3.5" aria-hidden /> Forget this browser
            </button>
          </div>
        </div>
      )}

      {view.code && left > 0 && (
        <div className="rounded-xl border border-accent/40 bg-accent/10 p-3 text-center">
          <div className="font-mono text-3xl tracking-[0.4em] text-text">{view.code}</div>
          <div className="mt-1 text-xs text-muted">
            Type it in the browser · works once · {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left
          </div>
        </div>
      )}

      {view.devices.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-muted">Paired browsers</h3>
          {view.devices.map(d => (
            <div key={d.id} className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm">
              <span className={`size-2 rounded-full ${d.online ? 'bg-ok' : 'bg-border'}`} aria-label={d.online ? 'connected' : 'not connected'} />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              <span className="text-xs text-muted">{d.online ? 'connected' : ago(d.lastSeen)}</span>
              <button type="button" className="text-muted hover:text-danger" title="Remove" onClick={() => void run(() => window.webAccess.revoke(d.id))}>
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
      {view.error && <p className="text-xs text-danger">{view.error}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </Shell>
  )
}
