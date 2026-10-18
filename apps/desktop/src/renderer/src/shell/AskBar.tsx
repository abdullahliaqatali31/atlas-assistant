import { Check, Loader2, MessageSquare, Mic, Send, Square, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import type { RuntimeStatus } from '../../../shared/ipc.ts'
import { ASK_EVENT, FOCUS_ASK_EVENT, MIC_EVENT, useLive } from './live.ts'

/** How long a finished reply stays in the bubble before it tucks itself away. */
const LINGER_MS = 25_000

/**
 * The floating Ask bar at the bottom of the stage: type or talk to Atlas
 * without opening the conversation. Messages go through the conversation
 * itself (one thread); the newest reply streams into a small bubble above the
 * bar, and a waiting yes-or-no question shows Haan / Nahi buttons.
 */
export function AskBar({ status, chatOpen, onOpenChat }: { status: RuntimeStatus; chatOpen: boolean; onOpenChat: () => void }) {
  const live = useLive()
  const [draft, setDraft] = useState('')
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [doneAt, setDoneAt] = useState<number | null>(null)
  const [, tick] = useState(0)
  // Only replies seen streaming in this window pop up, never ones loaded from earlier.
  const [ownId, setOwnId] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const ready = status.phase === 'ready'
  const ask = status.approvals[0]

  useEffect(() => {
    if (!live) return
    if (live.replying) {
      setDoneAt(null)
      if (live.replyId) setOwnId(live.replyId)
    }
    else setDoneAt(t => t ?? Date.now())
  }, [live?.replying, live?.replyId])

  // Let the bubble tuck away once a finished reply has lingered.
  useEffect(() => {
    if (doneAt === null) return
    const t = setTimeout(() => tick(n => n + 1), LINGER_MS + 50)
    return () => clearTimeout(t)
  }, [doneAt])

  useEffect(() => {
    const focus = () => input.current?.focus()
    window.addEventListener(FOCUS_ASK_EVENT, focus)
    return () => window.removeEventListener(FOCUS_ASK_EVENT, focus)
  }, [])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || !ready) return
    window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: text }))
    setDraft('')
    setDismissed(null)
  }
  const mic = () => {
    setDismissed(null)
    window.dispatchEvent(new Event(MIC_EVENT))
  }
  const answer = (yes: boolean) => ask && void window.assistant.answerApproval(ask.id, yes)

  const fresh = live && live.replyId !== null && live.replyId === ownId && live.replyId !== dismissed
  const lingering = live?.replying || (doneAt !== null && Date.now() - doneAt < LINGER_MS)
  const bubble = !chatOpen && fresh && lingering && (live.text || live.replying)
  const listening = live?.listening ?? false
  const busy = live?.transcribing || live?.replying

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex flex-col items-center gap-2 px-3">
      {ask && !chatOpen && (
        <div className="ask-pop glass pointer-events-auto flex w-full max-w-[560px] items-center gap-2 rounded-xl border-warm/40 bg-solid/90 px-3 py-2 text-xs" role="alertdialog" aria-label="Atlas is asking">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-warm" aria-hidden />
          <p className="min-w-0 flex-1 line-clamp-2">{ask.question ?? `May I use ${ask.tool}?`}</p>
          <button type="button" className="btn h-7 gap-1 border-accent px-2.5 text-accent" onClick={() => answer(true)}>
            <Check className="size-3.5" aria-hidden /> Haan
          </button>
          <button type="button" className="btn h-7 px-2.5" onClick={() => answer(false)}>
            Nahi
          </button>
        </div>
      )}

      {bubble && (
        <div className="ask-pop glass pointer-events-auto w-full max-w-[560px] rounded-xl bg-solid/90 p-3 text-sm shadow-2xl" aria-live="polite">
          <div className="mb-1 flex items-center gap-2">
            <span className="hud-label flex-1">{live.replying ? 'Atlas is replying…' : 'Atlas'}</span>
            <button type="button" className="icon-btn size-6" onClick={onOpenChat} aria-label="Open the conversation" title="Open conversation">
              <MessageSquare className="size-3.5" aria-hidden />
            </button>
            <button type="button" className="icon-btn size-6" onClick={() => setDismissed(live.replyId)} aria-label="Hide this reply" title="Hide">
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap leading-relaxed">
            {live.text || <span className="text-muted">Thinking…</span>}
            {live.replying && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" aria-hidden />}
          </p>
        </div>
      )}

      {live?.error && !chatOpen && <p className="pointer-events-auto rounded-lg bg-solid/90 px-2 py-1 text-[11px] text-warm">{live.error}</p>}

      <form onSubmit={submit} className="glass pointer-events-auto flex h-10 w-full max-w-[560px] items-center gap-1 rounded-full pl-4 pr-1 shadow-xl focus-within:border-accent/60">
        {listening ? (
          <div className="flex flex-1 items-center gap-2 text-xs text-accent" aria-live="polite">
            <span className="flex h-4 items-end gap-0.5" aria-hidden>
              {[0.6, 1, 0.75, 0.9, 0.5].map((k, i) => (
                <span key={i} className="w-0.5 rounded-full bg-accent transition-[height]" style={{ height: `${Math.max(3, Math.min(16, (live?.level ?? 0) * 40 * k))}px` }} />
              ))}
            </span>
            Listening… tap to stop
          </div>
        ) : (
          <input
            ref={input}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && (setDraft(''), e.currentTarget.blur())}
            disabled={!ready}
            placeholder={ready ? 'Ask Atlas…' : 'Atlas is starting…'}
            aria-label="Ask Atlas"
            className="bare-input min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
        )}
        {!listening && !draft && <kbd className="hidden rounded border border-border px-1.5 font-mono text-[10px] text-muted sm:block">/</kbd>}
        {busy && !listening && <Loader2 className="size-4 animate-spin text-muted" aria-label="Working" />}
        {draft.trim() ? (
          <button type="submit" className="grid size-8 place-items-center rounded-full bg-accent text-black" aria-label="Send">
            <Send className="size-3.5" aria-hidden />
          </button>
        ) : status.speech.available ? (
          <button
            type="button"
            onClick={mic}
            disabled={!ready}
            className={`grid size-8 place-items-center rounded-full transition-colors ${listening ? 'bg-accent text-black' : 'text-muted hover:bg-surface-strong hover:text-text'}`}
            aria-label={listening ? 'Stop listening' : 'Talk to Atlas'}
            aria-pressed={listening}
          >
            {listening ? <Square className="size-3" aria-hidden /> : <Mic className="size-4" aria-hidden />}
          </button>
        ) : null}
      </form>
    </div>
  )
}
