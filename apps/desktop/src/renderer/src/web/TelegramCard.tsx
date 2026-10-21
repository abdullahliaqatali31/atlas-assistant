/**
 * Settings › Security › Telegram: the owner's own bot as a second way in.
 * Save the token from @BotFather, pair this phone with a one-time code, and
 * choose which notices go there.
 */
import { ExternalLink, Send, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { TelegramNotify, TelegramView } from '../../../shared/telegram.ts'
import { nameOf } from '../ui/assistantName.ts'

const clean = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.')

const NOTIFY_LABEL: Record<TelegramNotify, string> = {
  away: 'While no page shows me',
  always: 'Always',
  off: 'Never (replies only)',
}

export function TelegramCard() {
  const [view, setView] = useState<TelegramView | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.telegram.state().then(setView, e => setError(clean(e)))
    return window.telegram.onChanged(setView)
  }, [])

  const run = async (fn: () => Promise<TelegramView>) => {
    setBusy(true)
    setError('')
    try {
      setView(await fn())
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(false)
    }
  }

  if (!view) return error ? <p className="text-xs text-danger">{error}</p> : null
  return (
    <section className="tile space-y-3 p-4">
      <header className="flex items-center gap-2.5">
        <span className="inline-flex size-9 items-center justify-center rounded-xl border border-border bg-surface-strong text-accent">
          <Send className="size-[18px]" />
        </span>
        <h2 className="font-medium">Telegram</h2>
        {view.paired && <span className="ml-auto rounded-full border border-ok/50 bg-ok/10 px-2 py-0.5 text-[11px] text-ok">paired with {view.paired.name}</span>}
      </header>
      <p className="text-xs text-muted">
        Talk to {nameOf()} from your phone through your own Telegram bot: write or send voice notes, get replies, approve actions, and hear about reminders and timers while you are away. Only the
        chat you pair is answered.
      </p>

      {!view.configured ? (
        <div className="space-y-2">
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
            <li>
              In Telegram, open{' '}
              <a className="text-accent underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                @BotFather
              </a>
              , send <code>/newbot</code>, and pick a name.
            </li>
            <li>Paste the token it gives you here (it is kept in Windows Credential Manager).</li>
          </ol>
          <form
            className="flex gap-2"
            onSubmit={e => {
              e.preventDefault()
              void run(() => window.telegram.setToken(token)).then(() => setToken(''))
            }}
          >
            <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="123456789:AA…" autoComplete="off" className="field" aria-label="Bot token" />
            <button type="submit" className="btn btn-primary shrink-0" disabled={busy || token.trim().length < 20}>
              {busy ? 'Checking…' : 'Save'}
            </button>
          </form>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">
            Bot: <b>@{view.bot ?? '…'}</b> {view.running ? <span className="text-xs text-ok">· listening</span> : <span className="text-xs text-warm">· not running</span>}
          </p>

          {!view.paired && (
            <div className="space-y-2">
              <button type="button" className="btn" disabled={busy || !view.running} onClick={() => void run(() => window.telegram.newCode())}>
                Pair my phone
              </button>
              {view.code && view.bot && (
                <div className="rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm">
                  <a className="flex items-center gap-1.5 font-medium text-accent underline" href={`https://t.me/${view.bot}?start=${view.code}`} target="_blank" rel="noreferrer">
                    Open @{view.bot} and press Start <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                  <p className="mt-1 text-xs text-muted">
                    Or send it <code>/start {view.code}</code> (works once, for 10 minutes).
                  </p>
                </div>
              )}
            </div>
          )}

          {view.paired && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted">{nameOf()}'s own notices (reminders, timers, speaking up)</p>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Notices on Telegram">
                {(Object.keys(NOTIFY_LABEL) as TelegramNotify[]).map(n => (
                  <button key={n} type="button" role="radio" aria-checked={view.notify === n} onClick={() => void run(() => window.telegram.setNotify(n))} className={`btn text-xs ${view.notify === n ? 'border-accent text-accent' : ''}`}>
                    {NOTIFY_LABEL[n]}
                  </button>
                ))}
              </div>
              <button type="button" className="btn text-xs" onClick={() => void run(() => window.telegram.unpair())}>
                Unpair this phone
              </button>
            </div>
          )}

          <button type="button" className="btn text-danger" onClick={() => void run(() => window.telegram.removeToken())}>
            <Trash2 className="size-3.5" aria-hidden /> Remove the bot
          </button>
        </div>
      )}
      {view.error && <p className="text-xs text-danger">{view.error}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  )
}
