/**
 * Shared contracts: typed events, ids and the clock every module receives.
 * Modules never read the wall clock or generate ids directly, so scenario
 * tests can replay multi-day timelines deterministically.
 */

export type Id = string

export const newId = (): Id => crypto.randomUUID()

export interface Clock {
  /** Milliseconds since the Unix epoch, UTC. */
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

export const fixedClock = (start: number) => {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
    set(ms: number) {
      t = ms
    },
  }
}

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** Where a fact or event came from. Everything not `owner` is untrusted data. */
export type SourceKind =
  | 'owner'
  | 'assistant'
  | 'calendar'
  | 'email'
  | 'window-activity'
  | 'notification'
  | 'browser'
  | 'file'
  | 'mcp'

export interface SourceRef {
  kind: SourceKind
  /** Connector or server name, e.g. "google-calendar". */
  origin: string
  /** Opaque locator inside the origin (message id, url, path). */
  locator?: string
  retrievedAt: number
}

/** Events that may lead the assistant to take the initiative. */
export type InitiativeEvent =
  | { type: 'session.first-of-day'; at: number }
  | { type: 'session.return-from-idle'; at: number; idleMs: number }
  | { type: 'commitment.due'; at: number; commitmentId: Id; title: string }
  | { type: 'message.arrived'; at: number; source: SourceRef; from: string; preview: string; isUrgent: boolean }
  | { type: 'task.failed'; at: number; taskId: Id; title: string }
  | { type: 'project.changed'; at: number; projectId: Id; summary: string }
  /** Something from the assistant's own agenda: a question, a nudge or the end-of-day wrap-up. */
  | {
      type: 'agenda'
      at: number
      /** Stable key; each key is raised at most once (the attention policy dedups on it). */
      key: string
      /** 'task': a taught skill the owner allowed to run by itself. */
      kind: 'question' | 'nudge' | 'wrap-up' | 'task'
      title: string
      /** What the model should do, in plain words; never contains untrusted text. */
      instruction: string
      /** Why it is raised now, shown to the owner ("why did you say this?"). */
      evidence: string
      /** After speaking, listen for the owner's answer. */
      expectsAnswer: boolean
    }

export type InitiativeEventType = InitiativeEvent['type']

/** Session lifecycle signals from the OS. */
export type SessionSignal = 'login' | 'unlock' | 'lock' | 'idle' | 'active' | 'sleep' | 'resume'

export type ConversationMode = 'companion' | 'work' | 'focus' | 'quiet' | 'away' | 'locked'

/** A minimal Result type for operations that fail in expected ways. */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export * from './personality.ts'
