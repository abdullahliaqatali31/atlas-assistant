/**
 * Proactive wiring for the desktop runtime (plan sections 6 and 9): turns OS
 * session changes and due tasks or commitments into initiative events, runs
 * each through the Assistant's attention policy (packages/initiative owns
 * cooldown, budget, quiet hours and modes) and hands the chosen channel to the
 * host. No Electron imports, so it is tested with a fake clock.
 */
import { dedupKeyOf, type InitiativeDecision } from '@assistant/initiative'
import type { MemoryStore } from '@assistant/memory'
import type { Assistant } from '@assistant/runtime'
import { DAY, MINUTE, type Clock, type ConversationMode, type InitiativeEvent } from '@assistant/shared'

import type { InitiativeAction, InitiativeItem, SessionChange } from '../shared/ipc.ts'

/** "Not now" brings the item back after this long. */
export const SNOOZE_MS = 30 * MINUTE
/** Away at least this long (locked, asleep or idle) before a welcome-back check-in is considered. */
export const RETURN_MIN_MS = 15 * MINUTE
/** Older due items are left to the task list; matches the 7-day dedup window, so each reminds at most once. */
const DUE_WINDOW_MS = 7 * DAY
const MAX_LATER = 30
/** No agenda item within this long of the owner's last message: give them room to work. */
export const AGENDA_QUIET_MS = 10 * MINUTE

export interface InitiativeDeps {
  assistant: Pick<Assistant, 'considerEvent' | 'previewEvent' | 'setMode'>
  memory: Pick<MemoryStore, 'openTasks' | 'dueCommitments' | 'initiativeHandled' | 'initiativeEntry' | 'forgetInitiative' | 'recordInitiative'>
  clock: Clock
  /** Speak an event through the companion; resolves when that reply ends. */
  speak: (event: InitiativeEvent, item: InitiativeItem) => Promise<void>
  /** The held-back list changed; `notify` is a new item to show as a system notification. */
  later: (items: InitiativeItem[], notify?: InitiativeItem) => void
  /** Stop whatever the assistant is saying now (lock, sleep, or "Not now" on the item being spoken). */
  silence: () => void
  /** An owner turn is in flight; proactive speech waits until it ends. */
  isBusy: () => boolean
  /** The assistant's own agenda (questions, nudges, wrap-up), most important first. */
  agenda?: (now: number) => InitiativeEvent[]
  /** When the owner last sent a message (0 if never), so the agenda never jumps in mid-conversation. */
  lastOwnerTurnAt?: () => number
}

type Away = 'lock' | 'suspend' | 'idle'

export class InitiativeService {
  private ownerMode: ConversationMode = 'companion'
  private away: Away | null = null
  private pending: InitiativeEvent[] = []
  private items: InitiativeItem[] = []
  /** Events behind items the owner can still act on, by item id. */
  private readonly events = new Map<string, InitiativeEvent>()
  private readonly snoozed = new Map<string, { event: InitiativeEvent; until: number }>()
  private speaking: string | null = null
  private draining: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: InitiativeDeps,
    away?: Away,
  ) {
    if (away) this.leave(away)
  }

  /** The mode the owner picked; applied whenever they are at the screen. */
  setOwnerMode(mode: ConversationMode) {
    this.ownerMode = mode
    if (!this.away) this.deps.assistant.setMode(mode)
  }

  /** The assistant just became ready: app start counts as the start of the day. */
  start() {
    this.pending.push({ type: 'session.first-of-day', at: this.deps.clock.now() })
    return this.tick()
  }

  session(change: SessionChange) {
    switch (change.signal) {
      case 'lock':
      case 'suspend':
        this.leave(change.signal)
        // Privacy: nothing keeps talking to a locked or sleeping PC.
        this.deps.silence()
        return
      case 'idle':
        if (!this.away) this.leave('idle')
        return
      case 'resume':
        // Windows usually locks on sleep; the unlock that follows is the return.
        if (this.away === 'lock') return
        break
      case 'active':
        if (this.away !== 'idle') return
        break
      case 'unlock':
        break
    }
    this.back(change.idleMs)
  }

  /** Something arrived from outside (a chat message): deliver it as the policy allows. */
  raise(event: InitiativeEvent) {
    this.enqueue(event)
    void this.drain()
  }

  /** Raise due reminders and expired snoozes, then deliver what the policy allows. */
  async tick() {
    if (!this.away) {
      const now = this.deps.clock.now()
      for (const [id, s] of this.snoozed) {
        if (s.until > now) continue
        this.snoozed.delete(id)
        this.enqueue({ ...s.event, at: now })
      }
      for (const event of this.dueEvents(now)) this.enqueue(event)
      // One agenda item per tick, only when nothing else is waiting: it should feel like a
      // thought between other things, not a list read out.
      const quietFor = now - (this.deps.lastOwnerTurnAt?.() ?? 0)
      // A taught task at its set time does not wait for the owner to go quiet.
      if (this.pending.length === 0 && !this.speaking) {
        const next = this.nextAgenda(now, quietFor < AGENDA_QUIET_MS)
        if (next) this.enqueue(next)
      }
    }
    await this.drain()
  }

  /**
   * Deliver pending events one at a time, never over an owner turn or while
   * they are away. Calls queue behind the run in flight, so awaiting one
   * means everything pending so far has been handled.
   */
  drain(): Promise<void> {
    this.draining = this.draining.then(() => this.drainOnce())
    return this.draining
  }

  private async drainOnce() {
    while (this.pending.length && !this.away && !this.deps.isBusy()) {
      const event = this.pending.shift()!
      const decision = this.deps.assistant.considerEvent(event)
      if (decision.channel === 'suppress') continue
      if (event.type === 'session.first-of-day') this.briefed(decision)
      await this.deliver(event, decision).catch(() => undefined)
    }
  }

  /** Owner controls from the companion or the held-back list. */
  async act(id: string, action: InitiativeAction) {
    const event = this.events.get(id)
    const item = this.items.find(i => i.id === id)
    if (this.speaking === id && action !== 'tell') this.deps.silence()
    this.drop(id)
    switch (action) {
      case 'snooze':
        if (!event) return
        this.deps.memory.forgetInitiative(id)
        this.deps.memory.recordInitiative(`snooze:${id}`, 'snooze', 'Owner said not now.')
        this.snoozed.set(id, { event, until: this.deps.clock.now() + SNOOZE_MS })
        return
      case 'mute':
        // The task or commitment stays; only this reminder is silenced for good.
        this.deps.memory.recordInitiative(`mute:${id}`, 'mute', 'Owner said not to remind again.')
        this.events.delete(id)
        return
      case 'dismiss':
        this.events.delete(id)
        return
      case 'tell':
        // The owner asked to hear it, so this is their turn, not an unsolicited one.
        if (event) await this.say(event, { ...(item ?? toItem(event, id, 'speak', '')), channel: 'speak', reason: 'You asked to hear it from the later list.' })
    }
  }

  get later(): readonly InitiativeItem[] {
    return this.items
  }

  // ── internals ─────────────────────────────────────────────

  private leave(why: Away) {
    // A lock outranks idle; sleep outranks both until resume.
    if (this.away !== 'suspend') this.away = why === 'idle' && this.away === 'lock' ? 'lock' : why
    this.deps.assistant.setMode(this.away === 'lock' ? 'locked' : 'away')
  }

  private back(awayMs: number) {
    this.away = null
    this.deps.assistant.setMode(this.ownerMode)
    const at = this.deps.clock.now()
    // First unlock of the day briefs; the policy suppresses repeats. Otherwise maybe a welcome back.
    this.pending.push({ type: 'session.first-of-day', at })
    if (awayMs >= RETURN_MIN_MS) this.pending.push({ type: 'session.return-from-idle', at, idleMs: awayMs })
    void this.tick()
  }

  private enqueue(event: InitiativeEvent) {
    const key = dedupKeyOf(event, 0)
    if (event.type === 'commitment.due' && this.pending.some(e => e.type === 'commitment.due' && e.commitmentId === event.commitmentId)) return
    if (this.snoozed.has(key)) return
    this.pending.push(event)
  }

  /** Open tasks and commitments that are due, not yet handled, snoozed or muted. */
  private dueEvents(now: number): InitiativeEvent[] {
    const { memory } = this.deps
    const handled = memory.initiativeHandled(DUE_WINDOW_MS)
    const due = [
      ...memory.openTasks().flatMap(t => (t.dueAt !== null && t.dueAt <= now ? [{ id: t.id, title: t.title, dueAt: t.dueAt }] : [])),
      ...memory.dueCommitments(now).map(c => ({ id: c.id, title: `${c.what} (to ${c.toWhom})`, dueAt: c.dueAt ?? now })),
    ]
    return due
      .filter(d => now - d.dueAt <= DUE_WINDOW_MS)
      .filter(d => {
        const key = `due:${d.id}`
        if (handled.has(key) || this.events.has(key) || memory.initiativeEntry(`mute:${key}`)) return false
        const snooze = memory.initiativeEntry(`snooze:${key}`)
        return !snooze || now - snooze.at >= SNOOZE_MS
      })
      .map(d => ({ type: 'commitment.due' as const, at: now, commitmentId: d.id, title: d.title }))
  }

  /** The most important agenda item not yet raised, snoozed, muted or held in Later. */
  private nextAgenda(now: number, scheduledOnly = false): InitiativeEvent | undefined {
    const { memory } = this.deps
    const handled = memory.initiativeHandled(DUE_WINDOW_MS)
    return this.deps.agenda?.(now).find(e => {
      if (scheduledOnly && !(e.type === 'agenda' && e.key.startsWith('skill:'))) return false
      const key = dedupKeyOf(e, 0)
      if (handled.has(key) || this.events.has(key) || this.snoozed.has(key) || memory.initiativeEntry(`mute:${key}`)) return false
      const snooze = memory.initiativeEntry(`snooze:${key}`)
      if (snooze && now - snooze.at < SNOOZE_MS) return false
      // Only when it would be spoken now; otherwise wait for a better moment (cooldown, focus, quiet hours).
      return this.deps.assistant.previewEvent(e).channel === 'speak'
    })
  }

  /** A briefing (spoken or held back) replaces the welcome back; a spoken one covers overdue tasks too. */
  private briefed(decision: InitiativeDecision) {
    this.pending = this.pending.filter(e => e.type !== 'session.return-from-idle')
    if (decision.channel !== 'speak') return
    const now = this.deps.clock.now()
    for (const t of this.deps.memory.openTasks()) {
      if (t.dueAt === null || t.dueAt > now || now - t.dueAt > DUE_WINDOW_MS) continue
      this.deps.memory.recordInitiative(`due:${t.id}`, 'speak', 'Covered in the daily briefing.')
    }
  }

  private async deliver(event: InitiativeEvent, decision: InitiativeDecision) {
    if (decision.channel === 'suppress') return
    const item = toItem(event, decision.dedupKey, decision.channel, decision.reason, this.deps.clock.now())
    this.events.set(item.id, event)
    // Spoken items stay actionable for a while; keep the map bounded.
    if (this.events.size > 200) this.events.delete(this.events.keys().next().value!)
    if (decision.channel === 'speak') return this.say(event, item)
    this.items = [...this.items.filter(i => i.id !== item.id), item].slice(-MAX_LATER)
    this.deps.later(this.items, decision.channel === 'notify' ? item : undefined)
  }

  private async say(event: InitiativeEvent, item: InitiativeItem) {
    this.speaking = item.id
    try {
      await this.deps.speak(event, item)
    } finally {
      if (this.speaking === item.id) this.speaking = null
    }
  }

  private drop(id: string) {
    if (!this.items.some(i => i.id === id)) return
    this.items = this.items.filter(i => i.id !== id)
    this.deps.later(this.items)
  }
}

const toItem = (event: InitiativeEvent, id: string, channel: InitiativeItem['channel'], reason: string, at = event.at): InitiativeItem => {
  const base = { id, channel, reason, at, canMute: event.type === 'commitment.due' || event.type === 'agenda' }
  switch (event.type) {
    case 'session.first-of-day':
      return { ...base, kind: 'briefing', title: 'Daily briefing' }
    case 'session.return-from-idle':
      return { ...base, kind: 'check-in', title: `Welcome back (away ${Math.round(event.idleMs / MINUTE)} min)` }
    case 'commitment.due':
      return { ...base, kind: 'reminder', title: event.title }
    case 'task.failed':
      return { ...base, kind: 'other', title: `Failed: ${event.title}` }
    case 'message.arrived':
      return { ...base, kind: 'other', title: `Message from ${event.from}` }
    case 'project.changed':
      return { ...base, kind: 'other', title: event.summary }
    case 'agenda':
      return { ...base, kind: event.kind === 'wrap-up' ? 'wrap-up' : event.kind === 'task' ? 'task' : 'question', title: event.title, reason: `${reason} ${event.evidence}`.trim(), expectsAnswer: event.expectsAnswer }
  }
}

/** `ASSISTANT_QUIET_HOURS=22:00-07:00` → owner-local minutes; may wrap past midnight. */
export const parseQuietHours = (v: string | undefined): { startMin: number; endMin: number } | undefined => {
  const m = v?.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/)
  if (!m) return undefined
  const [h1, m1, h2, m2] = m.slice(1).map(Number) as [number, number, number, number]
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return undefined
  const startMin = h1 * 60 + m1
  const endMin = h2 * 60 + m2
  return startMin === endMin ? undefined : { startMin, endMin }
}
