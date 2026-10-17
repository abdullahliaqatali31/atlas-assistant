import { Keyboard, X } from 'lucide-react'
import { useEffect, useState } from 'react'

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
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, idleUntil - now)
  const fraction = phase === 'listening' && idleUntil > 0 ? Math.min(1, left / 30_000) : 1
  const R = 158
  const circumference = 2 * Math.PI * R

  return (
    <div className="relative flex h-full flex-col items-center justify-between overflow-hidden px-6 pb-6 pt-8" role="region" aria-label="Voice conversation">
      <p className="hud-label">{name ? `Talking with ${name}` : 'Voice conversation'}</p>

      <div className="relative flex flex-1 flex-col items-center justify-center">
        <div className="relative">
          {/* Listening countdown: the ring empties as the 30-second wait runs out. */}
          <svg className="absolute inset-0 -rotate-90" viewBox="0 0 340 340" aria-hidden>
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
          <Orb state={ORB[phase]} level={level} size={340} />
        </div>
        <p role="status" className={`mt-2 text-lg font-medium tracking-wide ${phase === 'listening' ? 'text-warm' : 'text-accent'}`}>
          {LABEL[phase]}
          {phase === 'listening' && idleUntil > 0 && left < 10_000 && <span className="ml-2 text-sm text-muted">{Math.ceil(left / 1000)}s</span>}
        </p>
      </div>

      <div className="w-full max-w-2xl space-y-3 text-center" aria-live="polite">
        {you && (
          <p className="rise-in text-base text-muted">
            <span className="hud-label mr-2">You</span>
            {tail(you, 160)}
          </p>
        )}
        {assistant && <p className="rise-in text-2xl font-light leading-snug text-text">{tail(assistant)}</p>}
        {!you && !assistant && <p className="text-base text-muted">Speak naturally. Pause when you're done; I'll answer, then keep listening.</p>}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button type="button" onClick={onKeyboard} className="btn h-11 rounded-full px-4" title="Switch to typing">
          <Keyboard className="size-4" aria-hidden /> Type instead
        </button>
        <button type="button" onClick={onEnd} className="btn btn-danger h-11 rounded-full px-5" title="End the conversation (Esc)">
          <X className="size-4" aria-hidden /> End
        </button>
      </div>
      <p className="mt-2 text-[11px] text-muted">Say “bas” or “that’s all” to finish · Esc ends · it stops after 30 s of silence</p>
    </div>
  )
}
