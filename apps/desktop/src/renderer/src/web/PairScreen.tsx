/**
 * The first screen in a browser that Atlas does not know yet: the owner
 * types the six-digit code from the desktop app (Settings › Web access).
 */
import { KeyRound, MonitorSmartphone } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import logo from '../assets/logo.svg'
import { pairWithCode } from './transport.ts'

export function PairScreen() {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (code.length !== 6 || busy) return
    setBusy(true)
    setError('')
    const problem = await pairWithCode(code)
    if (problem === null) return location.reload()
    setBusy(false)
    setError(problem)
  }

  return (
    <div className="relative isolate flex min-h-screen items-center justify-center bg-bg p-4 text-text">
      <div className="aurora" aria-hidden />
      <form onSubmit={e => void submit(e)} className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-surface/80 p-6 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-3">
          <img src={logo} alt="" className="size-9 drop-shadow-[0_0_10px_rgba(34,211,238,0.6)]" />
          <div>
            <h1 className="text-base font-semibold">Connect this browser</h1>
            <p className="text-xs text-muted">Your assistant runs on your PC; this page is a screen onto it.</p>
          </div>
        </div>
        <ol className="space-y-2 text-sm text-muted">
          <li className="flex gap-2">
            <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            <span>
              On the PC, open the app › <b className="text-text">Settings</b> › <b className="text-text">Security &amp; Backups</b> › <b className="text-text">Web access</b> and press <b className="text-text">New code</b>.
            </span>
          </li>
          <li className="flex gap-2">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
            <span>Type the six digits here. This browser stays connected until you remove it.</span>
          </li>
        </ol>
        <input
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Pairing code"
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="••••••"
          className="w-full rounded-xl border border-border bg-bg px-4 py-3 text-center font-mono text-2xl tracking-[0.5em] outline-none focus:border-accent"
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <button type="submit" disabled={code.length !== 6 || busy} className="btn w-full justify-center bg-accent py-2 text-accent-fg disabled:opacity-50">
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </form>
    </div>
  )
}
