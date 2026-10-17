import { useState } from 'react'

import type { InitiativeAction, InitiativeItem } from '../../shared/ipc.ts'

const act = (id: string, action: InitiativeAction) => window.assistant.initiativeAction(id, action).catch(() => undefined)

const button = 'btn py-0.5 text-muted'

/** Owner controls under something the assistant said on its own (plan section 9). */
export function InitiativeControls({ item, speaking, onStop }: { item: InitiativeItem; speaking: boolean; onStop: () => void }) {
  const [done, setDone] = useState<string | null>(null)
  const choose = (action: InitiativeAction, label: string) => {
    setDone(label)
    void act(item.id, action)
  }
  return (
    <div className="mt-2 border-t border-border pt-1.5">
      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none">Why did you say this?</summary>
        <p className="mt-1">{item.reason}</p>
      </details>
      {done ? (
        <p className="mt-1 text-xs text-muted">{done}</p>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {speaking && (
            <button type="button" className={button} onClick={onStop}>
              Stop
            </button>
          )}
          <button type="button" className={button} onClick={() => choose('snooze', 'Okay, I’ll bring it up again in 30 minutes.')}>
            Not now
          </button>
          {item.canMute && (
            <button type="button" className={button} onClick={() => choose('mute', 'I won’t remind you about this again. The task stays on your list.')}>
              Don’t remind me again
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Items held back by quiet mode, focus, quiet hours, the daily budget or cooldown, plus silent notifications. */
export function LaterList({ items }: { items: InitiativeItem[] }) {
  if (items.length === 0) return <p className="text-muted">Nothing held back.</p>
  return (
    <ul className="space-y-2">
      {[...items].reverse().map(i => (
        <li key={i.id}>
          <div className="flex items-baseline justify-between gap-2">
            <span>{i.title}</span>
            <span className="shrink-0 text-xs text-muted">{new Date(i.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <p className="text-xs text-muted">Why: {i.reason}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <button type="button" className={button} onClick={() => void act(i.id, 'tell')}>
              Tell me
            </button>
            <button type="button" className={button} onClick={() => void act(i.id, 'snooze')}>
              Not now
            </button>
            {i.canMute && (
              <button type="button" className={button} onClick={() => void act(i.id, 'mute')}>
                Don’t remind me again
              </button>
            )}
            <button type="button" className={button} onClick={() => void act(i.id, 'dismiss')}>
              Dismiss
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}
