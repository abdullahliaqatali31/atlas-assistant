/**
 * Confirming it is the owner, from the widget itself: the security code, or
 * Windows Hello (face, fingerprint or PIN) when the owner turned it on. The
 * same check as the full lock screen (window.identity), in one small row.
 */
import { Fingerprint, Lock, LockOpen } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import type { IdentityView } from '../../../shared/identity.ts'

export function Unlock({ view }: { view: IdentityView }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const lockedOut = view.lockoutUntil !== null && view.lockoutUntil > now
  const hello = view.hello && view.helloAvailable

  // A lockout counts down by itself.
  useEffect(() => {
    if (!view.lockoutUntil) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [view.lockoutUntil])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!code.trim() || busy || lockedOut) return
    setBusy(true)
    try {
      const r = await window.identity.verify(code)
      setCode('')
      if (r.ok) setMessage('Confirmed.')
      else if (r.reason === 'locked-out' || r.lockoutUntil) setMessage(`Too many tries: wait ${Math.max(1, Math.ceil(((r.lockoutUntil ?? Date.now()) - Date.now()) / 60_000))} min.`)
      else setMessage(`Not that one. ${r.attemptsLeft} ${r.attemptsLeft === 1 ? 'try' : 'tries'} left.`)
    } catch {
      setMessage('Could not check it right now.')
    } finally {
      setBusy(false)
    }
  }

  const useHello = async () => {
    if (busy) return
    setBusy(true)
    setMessage('Windows is asking: look at the camera, touch the sensor or type your PIN.')
    try {
      const r = await window.identity.hello()
      setMessage(r.ok ? 'Confirmed.' : r.result === 'Canceled' ? '' : 'Windows Hello did not confirm it. Try again or type the code.')
    } catch {
      setMessage('Windows Hello is not available right now.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1" data-no-drag>
      <form onSubmit={e => void submit(e)} className="flex items-center gap-1.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full border border-amber-400/50 text-amber-300" title="Atlas is locked until you confirm it is you">
          <Lock className="size-4" />
        </span>
        <input
          type="password"
          autoComplete="off"
          value={code}
          onChange={e => setCode(e.target.value)}
          disabled={lockedOut}
          placeholder={lockedOut ? 'Locked for a moment…' : 'Your security code'}
          aria-label="Your security code"
          className="min-w-0 flex-1 rounded-full border border-amber-400/40 bg-black/35 px-3 py-1.5 text-[13px] text-white placeholder:text-white/45 focus:border-amber-300 focus:outline-none"
        />
        <button type="submit" disabled={!code.trim() || busy || lockedOut} className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-black disabled:opacity-30" aria-label="Unlock" title="Unlock">
          <LockOpen className="size-3.5" />
        </button>
        {hello && (
          <button type="button" onClick={() => void useHello()} disabled={busy || lockedOut} className="grid size-8 shrink-0 place-items-center rounded-full border border-accent/50 text-accent hover:bg-accent hover:text-black disabled:opacity-30" aria-label="Use Windows Hello" title="Use Windows Hello (face, fingerprint or PIN)">
            <Fingerprint className="size-4" />
          </button>
        )}
      </form>
      {message && <p className="px-1 text-[11px] text-amber-200">{message}</p>}
    </div>
  )
}
