/**
 * The desktop widget's page: Atlas outside the browser. Four sizes, chosen
 * by the owner, by Atlas (its widget tool) or by a newly connected display:
 *   orb   just Atlas, breathing with its voice
 *   bar   Atlas, what was just said, a box to type and the mic
 *   chat  the recent conversation
 *   glass a Jarvis-style panel: the time, what is next, the displays
 * The window around it (WebView2, widget.ps1) moves where the gateway says;
 * dragging any empty part moves it, and it settles into the nearest corner.
 */
import { BellRing, Check, ExternalLink, LayoutPanelLeft, Lock, Maximize2, MessageSquare, Mic, MonitorSmartphone, Pin, PinOff, Send, Square, Volume2, VolumeX, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'

import { record, SentencePlayer, type Recording } from '../audio.ts'
import { setMicLevel } from '../shell/micLevel.ts'
import { nameOf } from '../ui/assistantName.ts'
import { LiveOrb } from '../ui/LiveOrb.tsx'
import { setLiveLevel } from '../ui/liveLevel.ts'
import type { OrbState } from '../ui/Orb.tsx'
import { pcmFor } from '../voice/voiceId.ts'
import type { IdentityView } from '../../../shared/identity.ts'
import type { RuntimeStatus, TaskView } from '../../../shared/ipc.ts'
import { Unlock } from './Unlock.tsx'
import { displayLabel, type WidgetMode, type WidgetView } from '../../../shared/widget.ts'

interface Line {
  id: string
  who: 'you' | 'atlas'
  text: string
}

const MAX_LINES = 30

/** WebView2's channel to the window around the page (moving it); absent in a normal browser. */
const host = (window as unknown as { chrome?: { webview?: { postMessage(m: string): void } } }).chrome?.webview

/** A press on an empty part of the widget moves the window (not on buttons, the text box or the chat). */
const dragFrom = (e: RPointerEvent) => {
  if (e.button !== 0 || !host) return
  if ((e.target as HTMLElement).closest('button, input, textarea, a, [data-no-drag]')) return
  host.postMessage('drag')
}

export function Widget() {
  const [view, setView] = useState<WidgetView | null>(null)
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [replyId, setReplyId] = useState<string | null>(null)
  const [speaking, setSpeaking] = useState(false)
  const [listening, setListening] = useState(false)
  const [draft, setDraft] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [tasks, setTasks] = useState<TaskView[]>([])
  /** A watch's notice (battery low…): shown for a minute; Windows' notification carries it too. */
  const [notice, setNotice] = useState<{ label: string; text: string } | null>(null)
  const [identity, setIdentity] = useState<IdentityView | null>(null)
  const [error, setError] = useState('')
  const recording = useRef<Recording | null>(null)
  const player = useRef<SentencePlayer | null>(null)
  player.current ??= new SentencePlayer(setSpeaking)

  useEffect(() => {
    void window.widget.get().then(setView, () => undefined)
    void window.assistant.status().then(setStatus, () => undefined)
    void window.identity.get().then(setIdentity, () => undefined)
    let noticeTimer: ReturnType<typeof setTimeout> | undefined
    const offs = [
      window.widget.onChanged(setView),
      window.assistant.onStatus(setStatus),
      window.identity.onChanged(setIdentity),
      window.watches.onFired(n => {
        setNotice({ label: n.label, text: n.text })
        clearTimeout(noticeTimer)
        noticeTimer = setTimeout(() => setNotice(null), 60_000)
      }),
    ]
    return () => offs.forEach(off => off())
  }, [])

  // What Atlas says (to anyone): the lines, the voice (only what this widget should play reaches it), the quick replies.
  useEffect(() => {
    const add = (l: Line) => setLines(ls => [...ls.filter(x => x.id !== l.id), l].slice(-MAX_LINES))
    return window.assistant.onReply(e => {
      if (e.type === 'initiative') {
        setReplyId(e.replyId)
        add({ id: e.replyId, who: 'atlas', text: '' })
      } else if (e.type === 'heard') add({ id: `you-${e.replyId}`, who: 'you', text: e.text })
      else if (e.type === 'chunk') {
        setReplyId(e.replyId)
        setSuggestions([])
        setLines(ls => {
          const i = ls.findIndex(l => l.id === e.replyId)
          if (i < 0) return [...ls, { id: e.replyId, who: 'atlas' as const, text: e.text }].slice(-MAX_LINES)
          const next = [...ls]
          next[i] = { ...next[i]!, text: next[i]!.text + e.text }
          return next
        })
      } else if (e.type === 'done') setReplyId(r => (r === e.replyId ? null : r))
      else if (e.type === 'audio' && !recording.current) void player.current?.add(e.replyId, e.seq, e.data).catch(() => undefined)
      else if (e.type === 'suggestions') setSuggestions(e.ended ? [] : e.options.slice(0, 3))
    })
  }, [])

  // The glass shows what is next: read when it opens, then each minute.
  const mode: WidgetMode = view?.mode ?? 'bar'
  useEffect(() => {
    if (mode !== 'glass') return
    const read = () => void window.assistant.listTasks().then(setTasks, () => undefined)
    read()
    const t = setInterval(read, 60_000)
    return () => clearInterval(t)
  }, [mode])

  const send = async (text: string) => {
    const t = text.trim()
    if (!t) return
    setDraft('')
    setError('')
    setLines(ls => [...ls, { id: `you-${Date.now()}`, who: 'you' as const, text: t }].slice(-MAX_LINES))
    try {
      setReplyId((await window.assistant.send(t)).replyId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Atlas did not answer.')
    }
  }

  const talk = useCallback(async () => {
    if (recording.current) return recording.current.stop(true)
    // Talking over Atlas stops it at once.
    if (replyId || speaking) {
      player.current?.stop()
      void window.assistant.interrupt().catch(() => undefined)
    }
    setError('')
    try {
      recording.current = await record({
        onLevel: v => {
          setMicLevel(v)
          setLiveLevel(v)
        },
        onEnd: async result => {
          recording.current = null
          setListening(false)
          if (!result) return
          try {
            setReplyId((await window.assistant.sendVoice(result.audio, result.mime, await pcmFor(result.audio))).replyId)
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Sending your voice failed.')
          }
        },
      })
      setListening(true)
    } catch {
      setError('The microphone is not available.')
    }
  }, [replyId, speaking])

  const stop = () => {
    recording.current?.stop(false)
    player.current?.stop()
    void window.assistant.interrupt().catch(() => undefined)
  }

  const op = (o: Parameters<typeof window.widget.op>[0]) => void window.widget.op(o).catch(() => undefined)
  const setMode = (m: WidgetMode) => op({ kind: 'mode', mode: m })
  const speech = status?.speech.enabled ?? true
  const toggleSpeech = () => void window.assistant.setSpeech(!speech).catch(() => undefined)

  const state: OrbState = !status || status.phase === 'stopped' ? 'offline' : listening ? 'listening' : speaking ? 'speaking' : replyId ? 'thinking' : 'idle'
  const stateText = { offline: 'Not connected', idle: 'Ready', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking', paused: 'Paused' }[state]
  const last = [...lines].reverse().find(l => l.who === 'atlas' && l.text)
  const approval = status?.approvals[0]
  // Locked until the owner confirms it is them: the widget asks right where the message box was.
  const locked = !!identity?.locked && identity.configured

  // clear: see-through, with a soft panel only where there is text; frosted: Windows' blurred glass behind (or a solid one).
  const look = view?.look === 'frosted' ? (view.acrylic ? 'widget-glass' : 'widget-solid') : 'widget-clear'
  const shell = `widget-shell ${look} ${state}`

  // ── the orb alone ──
  if (mode === 'orb')
    return (
      <div className={`${shell} widget-orb group relative grid h-screen w-screen place-items-center rounded-full`} onPointerDown={dragFrom} onDoubleClick={() => setMode('bar')} title={`Click to talk · drag to move · the buttons below open ${nameOf()} again`}>
        <button type="button" className="rounded-full" onClick={() => (locked ? setMode('bar') : void talk())} aria-label={locked ? 'Locked: open to confirm it is you' : listening ? 'Send what you said' : `Talk to ${nameOf()}`}>
          <LiveOrb state={state} size={104} />
        </button>
        {locked && (
          <span className="pointer-events-none absolute right-3 top-3 grid size-6 place-items-center rounded-full border border-amber-400/60 bg-black/70 text-amber-300" title="Locked">
            <Lock className="size-3.5" />
          </span>
        )}
        {notice && !locked && (
          <button type="button" onClick={() => setMode('bar')} className="absolute right-3 top-3 grid size-6 animate-pulse place-items-center rounded-full border border-amber-400/60 bg-black/70 text-amber-300" title={`${notice.label}: ${notice.text}`} aria-label={`${notice.label}: ${notice.text}`}>
            <BellRing className="size-3.5" />
          </button>
        )}
        {/* Back to a bigger size: shown while the pointer is over the orb. */}
        <div className="absolute bottom-1 left-1/2 flex -translate-x-1/2 gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <OrbButton label="Open the bar" onClick={() => setMode('bar')}>
            <Maximize2 className="size-3" />
          </OrbButton>
          <OrbButton label="Open the chat" onClick={() => setMode('chat')}>
            <MessageSquare className="size-3" />
          </OrbButton>
          <OrbButton label="Open the glass panel" onClick={() => setMode('glass')}>
            <LayoutPanelLeft className="size-3" />
          </OrbButton>
        </div>
      </div>
    )

  const toolbar = (
    <div className="flex items-center gap-0.5">
      <IconButton label={speech ? 'Speak replies: on (click for quiet)' : 'Quiet: replies are written only (click to speak)'} onClick={toggleSpeech}>
        {speech ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
      </IconButton>
      <IconButton label="Chat" active={mode === 'chat'} onClick={() => setMode(mode === 'chat' ? 'bar' : 'chat')}>
        <MessageSquare className="size-3.5" />
      </IconButton>
      <IconButton label="Glass panel" active={mode === 'glass'} onClick={() => setMode(mode === 'glass' ? 'bar' : 'glass')}>
        <Maximize2 className="size-3.5" />
      </IconButton>
      <IconButton label="Just the orb" onClick={() => setMode('orb')}>
        <span className="block size-3 rounded-full border border-current" />
      </IconButton>
      <IconButton label={view?.onTop ? 'Stays on top (click to let windows cover it)' : 'Keep on top'} onClick={() => op({ kind: 'pin', on: !view?.onTop })}>
        {view?.onTop ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
      </IconButton>
      <IconButton label={`Open the full ${nameOf()}`} onClick={() => op({ kind: 'open-atlas' })}>
        <ExternalLink className="size-3.5" />
      </IconButton>
      <IconButton label="Hide the widget" onClick={() => op({ kind: 'hide' })}>
        <X className="size-3.5" />
      </IconButton>
    </div>
  )

  const input = (
    <form
      className="flex items-center gap-1.5"
      data-no-drag
      onSubmit={e => {
        e.preventDefault()
        void send(draft)
      }}
    >
      <button type="button" onClick={() => void talk()} className={`grid size-8 shrink-0 place-items-center rounded-full border ${listening ? 'border-accent bg-accent text-black' : 'border-white/20 text-white/80 hover:border-accent hover:text-accent'}`} aria-label={listening ? 'Send what you said' : 'Talk'}>
        <Mic className="size-4" />
      </button>
      <input value={draft} onChange={e => setDraft(e.target.value)} placeholder={`Message ${nameOf()}…`} className="min-w-0 flex-1 rounded-full border border-white/15 bg-black/25 px-3 py-1.5 text-[13px] text-white placeholder:text-white/40 focus:border-accent focus:outline-none" />
      {replyId || speaking ? (
        <button type="button" onClick={stop} className="grid size-8 shrink-0 place-items-center rounded-full border border-white/20 text-white/80 hover:border-warm hover:text-warm" aria-label="Stop">
          <Square className="size-3.5" />
        </button>
      ) : (
        <button type="submit" disabled={!draft.trim()} className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-black disabled:opacity-30" aria-label="Send">
          <Send className="size-3.5" />
        </button>
      )}
    </form>
  )

  const entry = locked && identity ? <Unlock view={identity} /> : input

  const approvalCard = approval && (
    <div className="flex items-center gap-2 rounded-xl border border-amber-400/40 bg-amber-400/10 px-2.5 py-1.5 text-[12px] text-amber-100" data-no-drag>
      <span className="min-w-0 flex-1 truncate" title={approval.question ?? approval.reason}>
        {approval.question ?? `${approval.tool}: ${approval.reason}`}
      </span>
      <button type="button" className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-black" onClick={() => void window.assistant.answerApproval(approval.id, true)}>
        <Check className="inline size-3" /> Yes
      </button>
      <button type="button" className="rounded-full border border-white/25 px-2 py-0.5 text-[11px]" onClick={() => void window.assistant.answerApproval(approval.id, false)}>
        No
      </button>
    </div>
  )

  // ── the bar ──
  if (mode === 'bar')
    return (
      <div className={`${shell} flex h-screen w-screen items-center gap-3 rounded-[22px] p-3`} onPointerDown={dragFrom}>
        <button type="button" className="shrink-0 rounded-full" onClick={() => void talk()} onDoubleClick={() => setMode('orb')} aria-label={`Talk to ${nameOf()}`}>
          <LiveOrb state={state} size={84} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="widget-label">
              {nameOf()} · {stateText}
            </span>
            <span className="ml-auto">{toolbar}</span>
          </div>
          {approvalCard ?? <p className="line-clamp-2 min-h-[2.4em] text-[13px] leading-snug text-white/90">{locked ? `${nameOf()} is locked. Confirm it is you to talk.` : notice ? `🔔 ${notice.label}: ${notice.text}` : error || last?.text || `Say something, or type. ${nameOf()} is listening when the orb glows.`}</p>}
          {entry}
        </div>
      </div>
    )

  // ── the chat ──
  if (mode === 'chat')
    return (
      <div className={`${shell} flex h-screen w-screen flex-col rounded-[22px]`}>
        <header className="flex items-center gap-2 px-3 pt-3 pb-2" onPointerDown={dragFrom}>
          <LiveOrb state={state} size={34} />
          <span className="widget-label">
            {nameOf()} · {stateText}
          </span>
          <span className="ml-auto">{toolbar}</span>
        </header>
        <Chat lines={lines} />
        <footer className="space-y-2 p-3 pt-1">
          {approvalCard}
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1" data-no-drag>
              {suggestions.map(s => (
                <button key={s} type="button" onClick={() => void send(s)} className="rounded-full border border-accent/40 px-2 py-0.5 text-[11px] text-accent hover:bg-accent hover:text-black">
                  {s}
                </button>
              ))}
            </div>
          )}
          {error && !locked && <p className="text-[11px] text-warm">{error}</p>}
          {entry}
        </footer>
      </div>
    )

  // ── the glass ──
  return <Glass view={view} state={state} stateText={stateText} last={last?.text ?? ''} tasks={tasks} toolbar={toolbar} input={entry} approval={approvalCard} shell={shell} onMove={i => op({ kind: 'move', display: String(i + 1) })} />
}

function OrbButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="grid size-6 place-items-center rounded-full border border-accent/50 bg-black/70 text-accent hover:bg-accent hover:text-black">
      {children}
    </button>
  )
}

function IconButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className={`grid size-6 place-items-center rounded-md ${active ? 'bg-accent/20 text-accent' : 'text-white/60 hover:bg-white/10 hover:text-white'}`}>
      {children}
    </button>
  )
}

function Chat({ lines }: { lines: Line[] }) {
  const end = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [lines])
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3" data-no-drag>
      {lines.length === 0 && <p className="pt-6 text-center text-[12px] text-white/45">Nothing said yet. Type below, or tap the mic.</p>}
      {lines.map(l => (
        <div key={l.id} className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-1.5 text-[13px] leading-snug ${l.who === 'you' ? 'ml-auto bg-accent/25 text-white' : 'bg-white/8 text-white/90'}`}>
          {l.text || '…'}
        </div>
      ))}
      <div ref={end} />
    </div>
  )
}

/** The Jarvis panel: the time, Atlas, what is next, and the displays (a new one gets its own card). */
function Glass(props: { view: WidgetView | null; state: OrbState; stateText: string; last: string; tasks: TaskView[]; toolbar: ReactNode; input: ReactNode; approval: ReactNode; shell: string; onMove: (i: number) => void }) {
  const { view, state, stateText, last, tasks, toolbar, input, approval, shell, onMove } = props
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const displays = view?.displays ?? []
  const box = useMemo(() => {
    if (!displays.length) return null
    const minX = Math.min(...displays.map(d => d.x))
    const minY = Math.min(...displays.map(d => d.y))
    const maxX = Math.max(...displays.map(d => d.x + d.w))
    const maxY = Math.max(...displays.map(d => d.y + d.h))
    return { minX, minY, w: maxX - minX, h: maxY - minY }
  }, [displays])
  const open = tasks.filter(t => t.status !== 'done').slice(0, 4)

  return (
    <div className={`${shell} widget-hud relative flex h-screen w-screen flex-col overflow-hidden rounded-[26px]`} onPointerDown={dragFrom}>
      <div className="hud-grid pointer-events-none absolute inset-0 opacity-40" />
      <header className="relative flex items-center gap-2 px-4 pt-3">
        <span className="widget-label">{nameOf()} · glass</span>
        <span className="ml-auto">{toolbar}</span>
      </header>
      <div className="relative grid min-h-0 flex-1 grid-cols-[1.1fr_1fr] gap-4 p-4">
        <section className="flex flex-col items-center justify-center gap-3">
          <div className="relative">
            <span className="hud-ring absolute -inset-6 rounded-full" />
            <span className="hud-ring hud-ring-slow absolute -inset-12 rounded-full" />
            <LiveOrb state={state} size={190} />
          </div>
          <p className="widget-label">{stateText}</p>
          <p className="line-clamp-3 max-w-[90%] text-center text-[13px] text-white/85">{last || 'How can I help?'}</p>
        </section>
        <section className="flex min-h-0 flex-col gap-3">
          <div>
            <p className="font-mono text-4xl font-light tracking-wider text-white">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
            <p className="widget-label">{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</p>
          </div>
          <div className="widget-card rounded-xl border border-accent/25 p-2.5">
            <p className="widget-label mb-1">Next</p>
            {open.length ? (
              <ul className="space-y-0.5 text-[12px] text-white/85">
                {open.map(t => (
                  <li key={t.id} className="truncate">
                    • {t.title}
                    {t.dueAt ? <span className="text-white/45"> · {new Date(t.dueAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-white/45">Nothing open.</p>
            )}
          </div>
          {box && (
            <div className="widget-card rounded-xl border border-accent/25 p-2.5" data-no-drag>
              <p className="widget-label mb-1.5 flex items-center gap-1">
                <MonitorSmartphone className="size-3" /> Displays · click one to move here
              </p>
              <div className="relative w-full" style={{ aspectRatio: `${box.w} / ${box.h}`, maxHeight: 110 }}>
                {displays.map((d, i) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => onMove(i)}
                    title={displayLabel(d, displays)}
                    className={`absolute grid place-items-center rounded-md border text-[10px] transition-colors ${view?.on === d.id ? 'border-accent bg-accent/25 text-white' : 'border-white/25 bg-white/5 text-white/60 hover:border-accent'}`}
                    style={{ left: `${((d.x - box.minX) / box.w) * 100}%`, top: `${((d.y - box.minY) / box.h) * 100}%`, width: `${(d.w / box.w) * 100 - 1.5}%`, height: `${(d.h / box.h) * 100 - 3}%` }}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            </div>
          )}
          {approval}
        </section>
      </div>
      <footer className="relative px-4 pb-4">
        <div className="widget-card rounded-full border border-accent/25 p-1.5">{input}</div>
      </footer>

      {view?.announce && (
        <div className="hud-announce pointer-events-none absolute inset-0 grid place-items-center">
          <div className="rounded-2xl border border-accent/60 bg-black/55 px-8 py-6 text-center shadow-[0_0_40px_rgba(34,211,238,0.35)]">
            <p className="widget-label">New display connected</p>
            <p className="mt-2 text-2xl font-light text-white">{displayLabel(view.announce, displays)}</p>
            <p className="mt-1 text-[12px] text-white/60">
              Scale {Math.round(view.announce.scale * 100)}% · {nameOf()} moved here
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
