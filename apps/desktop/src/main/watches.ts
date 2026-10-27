/**
 * Watches, kept by the gateway (shared/watches.ts): saved to a file, looked
 * at on every reading of the PC Atlas works on and every 20 seconds, and sent
 * as notices wherever the owner is. While one is set, the PC is read about
 * every 45 seconds (not every 5 minutes) so a "every 2 minutes" reminder is
 * on time.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import type { SystemSnapshot } from '../shared/system.ts'
import { describeWatches, EMPTY_STATE, MAX_WATCHES, noticeText, step, WCH, whenText, type Watch, type WatchesView, type WatchNotice, type WatchOp, type WatchState } from '../shared/watches.ts'

const LOOK_MS = 20_000

export interface WatchDeps {
  file: string
  now: () => number
  handle: <T>(channel: string, fn: (a: unknown, b: unknown) => T | Promise<T>) => void
  toRenderer: (channel: string, payload: unknown) => void
  /** A notice wherever the owner is: the PCs' notifications, the page and widget, Telegram. */
  deliver: (title: string, text: string) => void
  /** Read the PC often (a watch is set) or as usual. */
  pace: (often: boolean) => void
  log: (level: 'info' | 'warn', message: string) => void
}

export class WatchService {
  private watches: Watch[] = []
  private readonly states = new Map<string, WatchState>()
  private reading: SystemSnapshot | null = null
  private look: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: WatchDeps) {
    try {
      const raw = JSON.parse(readFileSync(deps.file, 'utf8')) as Watch[]
      this.watches = Array.isArray(raw) ? raw.filter(w => w && typeof w.id === 'string' && Array.isArray(w.when)).slice(0, MAX_WATCHES) : []
    } catch {
      this.watches = []
    }
  }

  start() {
    this.look ??= setInterval(() => this.check(), LOOK_MS)
    this.look.unref?.()
    this.deps.pace(this.anyOn)
  }

  stop() {
    if (this.look) clearInterval(this.look)
    this.look = null
  }

  private get anyOn() {
    return this.watches.some(w => w.on)
  }

  view(): WatchesView {
    return { watches: this.watches.map(w => ({ ...w, state: this.states.get(w.id) ?? EMPTY_STATE })), readingAt: this.reading?.at ?? null }
  }

  private save() {
    try {
      writeFileSync(this.deps.file, JSON.stringify(this.watches, null, 2))
    } catch (e) {
      this.deps.log('warn', `Watches not saved: ${(e as Error).message}`)
    }
  }

  private changed() {
    this.save()
    this.deps.pace(this.anyOn)
    this.deps.toRenderer(WCH.changed, this.view())
  }

  /** A new reading from the PC Atlas works on. */
  onReading(s: SystemSnapshot) {
    this.reading = s
    this.check()
  }

  private check() {
    const now = this.deps.now()
    for (const w of this.watches) {
      const before = this.states.get(w.id) ?? EMPTY_STATE
      const { state, send } = step(w, before, this.reading, now)
      this.states.set(w.id, state)
      if (!send) continue
      const text = noticeText(w, this.reading)
      const notice: WatchNotice = { watchId: w.id, label: w.label, text, at: now, count: state.sent }
      this.deps.deliver(w.label, text)
      this.deps.toRenderer(WCH.fired, notice)
      this.deps.toRenderer(WCH.changed, this.view())
    }
  }

  register() {
    const { handle } = this.deps
    const find = (id: unknown) => {
      const w = this.watches.find(x => x.id === id)
      if (!w) throw new Error('That watch is gone.')
      return w
    }
    handle(WCH.state, () => this.view())
    handle(WCH.toggle, (id, on) => {
      find(id).on = on === true
      this.changed()
      return this.view()
    })
    handle(WCH.remove, id => {
      find(id)
      this.watches = this.watches.filter(w => w.id !== id)
      this.states.delete(id as string)
      this.changed()
      return this.view()
    })
    handle(WCH.quiet, (id, minutes) => {
      const w = find(id)
      const m = typeof minutes === 'number' && minutes > 0 && minutes <= 24 * 60 ? minutes : 15
      const st = this.states.get(w.id) ?? EMPTY_STATE
      this.states.set(w.id, { ...st, quietUntil: this.deps.now() + m * 60_000 })
      this.deps.toRenderer(WCH.changed, this.view())
      return this.view()
    })
  }

  /** Atlas's watch tools. */
  handle(op: WatchOp): string {
    const now = this.deps.now()
    switch (op.kind) {
      case 'list':
        return `${describeWatches(this.view().watches)}${this.reading ? '' : '\n(No reading from the PC yet: watches start once it reports.)'}`
      case 'notify':
        this.deps.deliver(op.title || 'Atlas', op.text)
        this.deps.toRenderer(WCH.fired, { watchId: '', label: op.title || 'Atlas', text: op.text, at: now, count: 1 } satisfies WatchNotice)
        return 'Sent: it shows on the PC as a notification, in the page, and on Telegram when that is how the owner is reached.'
      case 'set': {
        // The same label again replaces it (changing a watch is setting it again).
        const old = this.watches.find(w => w.label.toLowerCase() === op.label.toLowerCase())
        if (!old && this.watches.length >= MAX_WATCHES) return `There are already ${MAX_WATCHES} watches; remove one first.`
        const w: Watch = { id: old?.id ?? randomUUID(), label: op.label, when: op.when, message: op.message, everyMin: op.everyMin, on: true, created: old?.created ?? now }
        this.watches = old ? this.watches.map(x => (x.id === old.id ? w : x)) : [...this.watches, w]
        this.states.delete(w.id)
        this.changed()
        this.check()
        const holding = this.states.get(w.id)?.since ? ' It holds right now, so the first notice just went out.' : ''
        return `${old ? 'Changed' : 'Set'}: "${w.label}" — when ${whenText(w)}, I send "${w.message}"${w.everyMin ? ` and again every ${w.everyMin} min until it stops holding` : ''}. It reaches the owner as a notification even in quiet mode.${holding}`
      }
      case 'remove': {
        if (op.all) {
          const n = this.watches.length
          this.watches = []
          this.states.clear()
          this.changed()
          return n ? `Removed all ${n} watches.` : 'No watches were set.'
        }
        const w = this.watches[(op.n ?? 0) - 1]
        if (!w) return `There is no watch ${op.n}.\n${describeWatches(this.view().watches)}`
        this.watches = this.watches.filter(x => x.id !== w.id)
        this.states.delete(w.id)
        this.changed()
        return `Removed "${w.label}".`
      }
      case 'pause': {
        const w = this.watches[op.n - 1]
        if (!w) return `There is no watch ${op.n}.`
        const st = this.states.get(w.id) ?? EMPTY_STATE
        this.states.set(w.id, { ...st, quietUntil: now + op.minutes * 60_000 })
        this.deps.toRenderer(WCH.changed, this.view())
        return `"${w.label}" stays quiet for ${op.minutes} min (it starts again after, if it still holds).`
      }
    }
  }
}
