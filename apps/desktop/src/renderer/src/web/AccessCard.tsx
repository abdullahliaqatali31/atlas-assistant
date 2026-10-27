/**
 * Settings › Security › Address & HTTPS: Atlas at its own domain. Like a
 * hosting panel: type the domain, point its DNS here, and Atlas gets a free
 * Let's Encrypt certificate and renews it by itself. Or keep the proxy you
 * already have (Caddy, Traefik, Cloudflare Tunnel, Dokploy) doing HTTPS.
 */
import { CheckCircle2, Globe2, Loader2, Lock, RefreshCw, ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ACCESS_MODE_LABEL, ACCESS_MODES, type AccessMode, type AccessView } from '../../../shared/access.ts'
import { nameOf } from '../ui/assistantName.ts'

const clean = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.')
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export function AccessCard() {
  const [view, setView] = useState<AccessView | null>(null)
  const [mode, setMode] = useState<AccessMode>('off')
  const [domain, setDomain] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.access.state().then(v => {
      setView(v)
      setMode(v.mode)
      setDomain(v.domain ?? '')
      setEmail(v.email ?? '')
    }, e => setError(clean(e)))
    return window.access.onChanged(setView)
  }, [])

  if (!view) return error ? <p className="text-xs text-danger">{error}</p> : null
  const run = async (fn: () => Promise<AccessView>) => {
    setError('')
    setBusy(true)
    try {
      setView(await fn())
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(false)
    }
  }
  const changed = mode !== view.mode || domain.trim() !== (view.domain ?? '') || email.trim() !== (view.email ?? '')
  const cert = view.certificate && view.certificate.domain === view.domain ? view.certificate : null
  const days = cert ? Math.round((cert.expires - Date.now()) / 86_400_000) : 0
  const dnsOk = view.dns && view.dns.publicIp ? view.dns.addresses.includes(view.dns.publicIp) : null

  return (
    <section className="tile space-y-3 p-4">
      <header className="flex items-center gap-2.5">
        <span className="inline-flex size-9 items-center justify-center rounded-xl border border-border bg-surface-strong text-accent">
          <Globe2 className="size-[18px]" />
        </span>
        <h2 className="font-medium">Address & HTTPS</h2>
        {view.url && (
          <a href={view.url} className="ml-auto inline-flex items-center gap-1 rounded-full border border-ok/50 bg-ok/10 px-2 py-0.5 text-[11px] text-ok">
            <Lock className="size-3" /> {view.url.replace(/^https:\/\//, '')}
          </a>
        )}
      </header>
      <p className="text-xs text-muted">Reach {nameOf()} from anywhere at your own domain, with a padlock: HTTPS keeps the conversation, your codes and your voice private on the way, and browsers allow the microphone only over HTTPS.</p>

      <div className="space-y-1.5">
        {ACCESS_MODES.filter(m => !(view.panel && m === 'acme')).map(m => (
          <label key={m} className={`flex items-center gap-2 rounded-xl border p-2 text-sm ${mode === m ? 'border-accent/60' : 'border-border'}`}>
            <input type="radio" name="access-mode" checked={mode === m} onChange={() => setMode(m)} /> {view.panel && m === 'proxy' ? `My domain, through ${view.panel} (its Traefik does HTTPS)` : ACCESS_MODE_LABEL[m]}
          </label>
        ))}
      </div>

      {mode !== 'off' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted">
            Domain
            <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="atlas.example.com" className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text" />
          </label>
          {mode === 'acme' && (
            <label className="space-y-1 text-xs text-muted">
              Email for expiry notices (optional)
              <input value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-text" />
            </label>
          )}
        </div>
      )}

      {mode === 'acme' && (
        <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted">
          <li>At your DNS provider, add an A record for the domain pointing at this server's public IP{view.dns?.publicIp ? ` (${view.dns.publicIp})` : ''}.</li>
          <li>Open ports 80 and 443 in the server's firewall (Let's Encrypt checks on port 80).</li>
          <li>Save: {nameOf()} gets the certificate, then renews it by itself before it runs out.</li>
        </ol>
      )}
      {mode === 'proxy' && view.panel && (
        <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted">
          <li>At your DNS provider, add an A record for the domain pointing at this server's public IP{view.dns?.publicIp ? ` (${view.dns.publicIp})` : ''}.</li>
          <li>Save: {nameOf()} adds its route to {view.panel}'s Traefik, which gets the certificate and renews it. Nothing to do in {view.panel} itself.</li>
        </ol>
      )}
      {mode === 'proxy' && !view.panel && (
        <p className="text-xs text-muted">
          Point your proxy at this server's port {window.location.port || '47800'} over plain http, with WebSocket upgrades on, and have it send <code>X-Forwarded-Proto: https</code> (Caddy, Traefik, Dokploy and Cloudflare Tunnel do this already).
        </p>
      )}

      {(changed || busy) && (
        <button type="button" disabled={busy} onClick={() => void run(() => window.access.set({ mode, domain: mode === 'off' ? null : domain.trim(), email: email.trim() || null }))} className="rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-black disabled:opacity-40">
          {busy ? 'Saving…' : mode === 'acme' && !cert ? 'Save and get a certificate' : 'Save'}
        </button>
      )}

      {!changed && view.mode === 'acme' && view.domain && (
        <div className="space-y-1.5 rounded-xl border border-border p-2.5 text-sm">
          {view.issuing ? (
            <p className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin text-accent" /> Asking Let's Encrypt for {view.domain}…
            </p>
          ) : cert ? (
            <p className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-ok" /> Certificate for {cert.domain} until {day(cert.expires)} ({days} days; renewed by itself).
            </p>
          ) : (
            <p className="flex items-center gap-2 text-muted">
              <ShieldAlert className="size-4 text-warm" /> No certificate yet.
            </p>
          )}
          <p className="text-xs text-muted">
            Port 80 {view.listening.http ? 'open' : 'not open'} · port 443 {view.listening.https ? 'open' : 'not open'}
          </p>
          {view.dns && (
            <p className={`text-xs ${dnsOk === false ? 'text-warm' : 'text-muted'}`}>
              {view.domain} points at {view.dns.addresses.join(', ') || 'nothing yet'}
              {view.dns.publicIp ? `; this server is ${view.dns.publicIp}` : ''}
              {dnsOk === true ? ' ✓' : dnsOk === false ? ' — they differ: fix the A record (it can take a few minutes to update).' : ''}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={view.issuing} onClick={() => void run(() => window.access.issue())} className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs hover:border-accent disabled:opacity-40">
              <RefreshCw className="size-3" /> {cert ? 'Renew now' : 'Get the certificate'}
            </button>
            <button type="button" onClick={() => void run(() => window.access.checkDns())} className="rounded-full border border-border px-2.5 py-0.5 text-xs hover:border-accent">
              Check the DNS
            </button>
          </div>
        </div>
      )}
      {(view.error || error) && <p className="text-xs text-danger">{error || view.error}</p>}
    </section>
  )
}
