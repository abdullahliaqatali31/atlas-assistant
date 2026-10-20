/**
 * The owner check. Main owns it end to end: the code's salted scrypt hash,
 * the policy for when to ask, attempt limits and the lock state. While
 * locked, main holds back the briefing and refuses private requests.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { AWAY_MS, checkNewCode, LOCKOUT_MS, MAX_ATTEMPTS, normalizeCode, type AskWhen, type IdentityView, type ReturnCause, type VerifyResult } from '../shared/identity.ts'

interface Stored {
  v: 1
  salt: string | null
  hash: string | null
  askWhen: AskWhen
  /** Local day (YYYY-MM-DD) of the last successful check. */
  verifiedDay: string | null
  failures: number
  lockoutUntil: number | null
  /** Windows Hello may confirm the owner too. */
  hello: boolean
}

const EMPTY: Stored = { v: 1, salt: null, hash: null, askWhen: 'daily', verifiedDay: null, failures: 0, lockoutUntil: null, hello: false }
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

const hashOf = (normalized: string, salt: Buffer) => scryptSync(normalized, salt, 32, SCRYPT)

const localDay = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class IdentityGate {
  private s: Stored
  private lockedNow = false
  private askNow: number | null = null

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.s = this.load()
  }

  private load(): Stored {
    try {
      if (!existsSync(this.file)) return { ...EMPTY }
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Stored>
      return { ...EMPTY, ...raw, v: 1 }
    } catch {
      // A damaged file must not lock the owner out of their own app: start clean.
      return { ...EMPTY }
    }
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.s), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  get configured() {
    return this.s.hash !== null && this.s.salt !== null
  }

  get locked() {
    return this.lockedNow
  }

  view(): IdentityView {
    const lockoutUntil = this.s.lockoutUntil !== null && this.s.lockoutUntil > this.now() ? this.s.lockoutUntil : null
    return {
      configured: this.configured,
      askWhen: this.s.askWhen,
      locked: this.lockedNow,
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - this.s.failures),
      lockoutUntil,
      askNow: this.lockedNow ? this.askNow : null,
      hello: this.s.hello,
      helloAvailable: false,
    }
  }

  /**
   * Should the owner be asked now? `awayMs` is how long they were away
   * (Infinity for an app start). Never asks without a code or with 'off'.
   * 'wake' asks after every sleep or Windows lock, whatever its length.
   */
  shouldAsk(awayMs: number, cause: ReturnCause = 'start'): boolean {
    if (!this.configured || this.s.askWhen === 'off') return false
    const notToday = this.s.verifiedDay !== localDay(this.now())
    if (this.s.askWhen === 'daily') return notToday
    if (this.s.askWhen === 'wake' && cause === 'wake') return true
    return notToday || awayMs >= AWAY_MS
  }

  /** In 'wake' mode the check closes as the laptop sleeps or locks, so nothing private shows when it opens. */
  get locksOnLeave() {
    return this.configured && this.s.askWhen === 'wake'
  }

  lock() {
    if (!this.lockedNow) this.askNow = null
    this.lockedNow = true
  }

  /** The owner is there to hear the question: ask aloud. True when this is a new ask. */
  prompt(): boolean {
    if (!this.lockedNow || this.askNow !== null) return false
    this.askNow = this.now()
    return true
  }

  get hello() {
    return this.s.hello
  }

  setHello(on: boolean): IdentityView {
    this.s.hello = on
    this.save()
    return this.view()
  }

  /** Windows Hello said it is the owner: the same as the right code. */
  passHello() {
    this.s.failures = 0
    this.s.lockoutUntil = null
    this.s.verifiedDay = localDay(this.now())
    this.lockedNow = false
    this.save()
  }

  /** Compares a typed or transcribed code; three wrong answers pause attempts for ten minutes. */
  verify(attempt: string): VerifyResult {
    const t = this.now()
    if (this.s.lockoutUntil !== null && this.s.lockoutUntil > t) {
      return { ok: false, attemptsLeft: 0, lockoutUntil: this.s.lockoutUntil, reason: 'locked-out' }
    }
    if (this.s.lockoutUntil !== null) {
      this.s.lockoutUntil = null
      this.s.failures = 0
    }
    if (!this.configured) {
      this.lockedNow = false
      return { ok: true }
    }
    const normalized = normalizeCode(attempt)
    const expected = Buffer.from(this.s.hash!, 'hex')
    const actual = hashOf(normalized, Buffer.from(this.s.salt!, 'hex'))
    if (normalized && timingSafeEqual(expected, actual)) {
      this.s.failures = 0
      this.s.verifiedDay = localDay(t)
      this.lockedNow = false
      this.save()
      return { ok: true }
    }
    this.s.failures += 1
    if (this.s.failures >= MAX_ATTEMPTS) this.s.lockoutUntil = t + LOCKOUT_MS
    this.save()
    return { ok: false, attemptsLeft: Math.max(0, MAX_ATTEMPTS - this.s.failures), lockoutUntil: this.s.lockoutUntil, reason: 'wrong' }
  }

  /** Sets or changes the code. Changing an existing one needs the current code. */
  setCode(code: unknown, current?: unknown): IdentityView {
    const next = checkNewCode(code)
    if (!next.ok) throw new Error(next.error)
    if (this.configured) this.requireCurrent(current)
    const salt = randomBytes(16)
    this.s.salt = salt.toString('hex')
    this.s.hash = hashOf(next.normalized, salt).toString('hex')
    this.s.failures = 0
    this.s.lockoutUntil = null
    // Setting the code proves presence for today.
    this.s.verifiedDay = localDay(this.now())
    this.save()
    return this.view()
  }

  removeCode(current: unknown): IdentityView {
    if (!this.configured) return this.view()
    this.requireCurrent(current)
    this.s = { ...EMPTY, askWhen: this.s.askWhen }
    this.lockedNow = false
    this.save()
    return this.view()
  }

  setAskWhen(when: AskWhen): IdentityView {
    this.s.askWhen = when
    this.save()
    return this.view()
  }

  private requireCurrent(current: unknown) {
    if (typeof current !== 'string') throw new Error('Enter your current code first.')
    const r = this.verify(current)
    if (!r.ok) throw new Error(r.reason === 'locked-out' ? 'Too many wrong tries. Wait a few minutes.' : 'The current code is not right.')
  }
}
