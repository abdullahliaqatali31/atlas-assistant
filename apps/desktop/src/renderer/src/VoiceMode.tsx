import { Keyboard, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Orb, type OrbState } from './ui/Orb.tsx'

const LABEL: Record<VoicePhase, string> = {
  listening: 'Listening…',
  transcribing: 'Got it…',
  thinking: 'Thinking…',
  speaking: 'Speaking',
}

export type VoicePhase = 'listening' | 'transcribing' | 'thinking' | 'speaking'

const ORB: Record<VoicePhase, OrbState> = { listening: 'listening', transcribing: 'thinking', thinking: 'thinking', speaking: 'speaking' }

/** The last sentence or two of a reply, so captions stay readable at a glance. */
const tail = (text: string, max = 220) => {
  // Captions are plain text: drop Markdown marks.
  const t = text.replace(/\*\*|__|`|^\s*#+\s*|^\s*[-*•]\s+/gm, '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(-max)
  const start = cut.search(/(?<=[.!?۔؟]\s)\S/)
  return `…${start > 0 ? cut.slice(start) : cut}`
}

/** The orb fits the room it has: never under 96 px, never over 260, never pushing the controls off. */
const useOrbSize = () => {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ size: 200, height: 400 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      if (!e) return
      const { width, height } = e.contentRect
      setBox({ size: Math.round(Math.max(96, Math.min(260, width * 0.72, height - 44))), height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, ...box }
}

/**
 * A live voice conversation: one big presence, what you said, what it is
 * saying, and how long it will keep listening. Feels like a call, not a chat.
 */
export function VoiceMode({
  phase,
  level,
  you,
  assistant,
  idleUntil,
  name,
  onEnd,
  onKeyboard,
  onStop,
}: {
  phase: VoicePhase
  level: number
  /** What the owner just said (empty until transcribed). */
  you: string
  /** The reply as it streams. */
  assistant: string
  /** Epoch ms when listening gives up if nobody speaks. */
  idleUntil: number
  name: string
  onEnd: () => void
  onKeyboard: () => void
  /** Cut the reply short and listen again (like talking over it). */
  onStop: () => void
}) {
  const orb = useOrbSize()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, idleUntil - now)
  const fraction = phase === 'listening' && idleUntil > 0 ? Math.min(1, left / 30_000) : 1
  const R = 158
  const circumference = 2 * Math.PI * R
  const busy = phase === 'thinking' || phase === 'speaking'

  return (
    <div className="flex h-full min-h-0 flex-col items-center overflow-hidden px-4 pb-3 pt-3" role="region" aria-label="Voice conversation">
      <p className="hud-label shrink-0">{name ? `Talking with ${name}` : 'Voice conversation'}</p>

      {/* The orb takes what is left after the captions and controls. */}
      <div ref={orb.ref} className="flex min-h-0 w-full flex-1 flex-col items-center justify-center">
        <div className="relative" style={{ width: orb.size, height: orb.size }}>
          {/* Listening countdown: the ring empties as the 30-second wait runs out. */}
          <svg className="absolute inset-0 size-full -rotate-90" viewBox="0 0 340 340" aria-hidden>
            <circle cx="170" cy="170" r={R} fill="none" stroke="var(--border)" strokeWidth="2" />
            <circle
              cx="170"
              cy="170"
              r={R}
              fill="none"
              stroke={phase === 'listening' ? 'var(--warm)' : 'var(--accent)'}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - fraction)}
              style={{ transition: 'stroke-dashoffset 250ms linear, stroke 300ms' }}
            />
          </svg>
          <Orb state={ORB[phase]} level={level} size={orb.size} />
        </div>
        <p role="status" className={`mt-1 text-base font-medium tracking-wide ${phase === 'listening' ? 'text-warm' : 'text-accent'}`}>
          {LABEL[phase]}
          {phase === 'listening' && idleUntil > 0 && left < 10_000 && <span className="ml-2 text-sm text-muted">{Math.ceil(left / 1000)}s</span>}
        </p>
      </div>

      <div className="w-full max-w-2xl shrink-0 space-y-1.5 text-center" aria-live="polite">
        {you && (
          <p className="rise-in line-clamp-2 text-sm text-muted">
            <span className="hud-label mr-2">You</span>
            {tail(you, 160)}
          </p>
        )}
        {assistant && <p className="rise-in line-clamp-4 text-[length:var(--voice-caption,1.125rem)] font-light leading-snug text-text">{tail(assistant)}</p>}
        {!you && !assistant && <p className="text-sm text-muted">Speak naturally. Pause when you're done; I'll answer, then keep listening.</p>}
      </div>

      {/* Always on screen, whatever the panel's size. */}
      <div className="mt-3 flex shrink-0 flex-wrap items-center justify-center gap-2">
        {busy && (
          <button type="button" onClick={onStop} className="btn h-10 rounded-full border-warm/60 px-4 text-warm" title="Stop the reply and listen">
            <Square className="size-3.5 fill-current" aria-hidden /> Stop
          </button>
        )}
        <button type="button" onClick={onKeyboard} className="btn h-10 rounded-full px-3.5" title="Switch to typing">
          <Keyboard className="size-4" aria-hidden /> <span className="hidden @[340px]:inline">Type instead</span>
        </button>
        <button type="button" onClick={onEnd} className="btn btn-danger h-10 rounded-full px-4" title="End the conversation (Esc)">
          <X className="size-4" aria-hidden /> End
        </button>
      </div>
      {orb.height > 260 && <p className="mt-1.5 shrink-0 text-center text-[11px] text-muted">Say “bas” or “that’s all” to finish · Esc ends · it stops after 30 s of silence</p>}
    </div>
  )
}
