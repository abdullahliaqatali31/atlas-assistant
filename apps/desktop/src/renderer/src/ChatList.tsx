/**
 * Past conversations: a list newest first (title, when, how long), read any
 * one, and continue it. Only the conversation in use is ever sent to the AI;
 * the rest stay here and in Atlas's search (chat_history_search).
 */
import { ArrowLeft, MessageSquare, Play, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { ChatSummary, DayLine } from '../../shared/ipc.ts'
import { ago, useNow } from './Jarvis.tsx'

const clean = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'That did not work.')

export function ChatList({ onClose, onResumed }: { onClose: () => void; onResumed: (lines: DayLine[]) => void }) {
  const now = useNow(60_000)
  const [chats, setChats] = useState<ChatSummary[] | null>(null)
  const [open, setOpen] = useState<{ chat: ChatSummary; lines: DayLine[] } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.assistant.listChats().then(setChats, err => setError(clean(err)))
  }, [])

  const read = (chat: ChatSummary) => {
    setError('')
    void window.assistant.readChat(chat.id).then(lines => setOpen({ chat, lines }), err => setError(clean(err)))
  }
  const resume = (chat: ChatSummary) => {
    setError('')
    void window.assistant.resumeChat(chat.id).then(lines => {
      onResumed(lines)
      onClose()
    }, err => setError(clean(err)))
  }

  return (
    <section aria-label="Earlier chats" className="ask-pop absolute inset-0 z-20 flex flex-col bg-solid">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        {open ? (
          <button type="button" className="icon-btn size-7" onClick={() => setOpen(null)} aria-label="Back to the list">
            <ArrowLeft className="size-4" aria-hidden />
          </button>
        ) : (
          <MessageSquare className="size-4 text-accent" aria-hidden />
        )}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{open ? open.chat.title || 'Untitled chat' : 'Chats'}</h2>
        {open && !open.chat.current && (
          <button type="button" className="btn h-7 gap-1 px-2 text-xs" onClick={() => resume(open.chat)}>
            <Play className="size-3.5" aria-hidden /> Continue this chat
          </button>
        )}
        <button type="button" className="icon-btn size-7" onClick={onClose} aria-label="Close the chat list">
          <X className="size-4" aria-hidden />
        </button>
      </header>
      {error && <p className="px-3 py-2 text-xs text-danger">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {open ? (
          <ol className="space-y-2 p-3">
            {open.lines.map((l, i) => (
              <li key={`${l.at}-${i}`} className={`max-w-[85%] rounded-xl px-3 py-1.5 text-sm ${l.who === 'owner' ? 'ml-auto bg-accent-soft' : 'bg-surface'}`} dir="auto">
                {l.text}
                <span className="block text-[10px] text-muted">{new Date(l.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
              </li>
            ))}
          </ol>
        ) : chats === null ? (
          <p className="p-3 text-xs text-muted">Loading…</p>
        ) : chats.length === 0 ? (
          <p className="p-3 text-xs text-muted">No chats yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {chats.map(c => (
              <li key={c.id}>
                <button type="button" className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface" onClick={() => read(c)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm" dir="auto">
                      {c.title || 'Untitled chat'}
                      {c.current && <span className="ml-1.5 rounded bg-accent-soft px-1 text-[10px] text-accent">now</span>}
                    </span>
                    <span className="block text-[11px] text-muted">
                      {new Date(c.startedAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · {ago(c.lastAt, now)} · {c.messages} messages
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="border-t border-border px-3 py-1.5 text-[10px] text-muted">Only the chat in use goes to the AI. A chat ends after 45 quiet minutes or a new day; older parts of long chats are kept as a short summary.</p>
    </section>
  )
}
