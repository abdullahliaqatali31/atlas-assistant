/**
 * Owner check with a security word or sentence (plan section 14).
 * The code is a friendly second check, not strong authentication: anyone who
 * overhears it can repeat it. It is stored only as a salted scrypt hash in
 * main, never sent to the LLM, never logged, and never returned to a window.
 */

/** When the assistant asks for the code before speaking privately. */
export const ASK_WHEN = ['daily', 'wake', 'away', 'off'] as const
export type AskWhen = (typeof ASK_WHEN)[number]

/** Away this long (locked, asleep or idle) counts as "away" for AskWhen 'away' (and idle returns in 'wake'). */
export const AWAY_MS = 30 * 60_000
export const MAX_ATTEMPTS = 3
export const LOCKOUT_MS = 10 * 60_000
export const CODE_MIN = 4
export const CODE_MAX = 120

export interface IdentityView {
  /** A code has been set. */
  configured: boolean
  askWhen: AskWhen
  /** Waiting for the owner to confirm; private content and actions are held back. */
  locked: boolean
  attemptsLeft: number
  /** Epoch ms until which no attempt is accepted, after too many wrong ones. */
  lockoutUntil: number | null
  /**
   * Set (epoch ms) when the owner should be asked aloud now: the window is up
   * and Windows itself is unlocked. Null while nobody is there to hear it.
   */
  askNow: number | null
}

/** Why the owner is back: an app start, a return from sleep or Windows lock, or from idling. */
export type ReturnCause = 'start' | 'wake' | 'idle'

export type VerifyResult = { ok: true } | { ok: false; attemptsLeft: number; lockoutUntil: number | null; reason: 'wrong' | 'locked-out' | 'not-heard' }

/** Channel names for `window.identity`. */
export const IC = {
  get: 'identity:get',
  verify: 'identity:verify',
  verifyVoice: 'identity:verify-voice',
  setCode: 'identity:set-code',
  removeCode: 'identity:remove-code',
  setAskWhen: 'identity:set-ask-when',
  speakChallenge: 'identity:speak-challenge',
  changed: 'identity:changed',
} as const

export interface IdentityBridge {
  get(): Promise<IdentityView>
  /** Typed code. */
  verify(code: string): Promise<VerifyResult>
  /** Spoken code: transcribed by the voice provider, compared in main. */
  verifyVoice(audio: Uint8Array, mime: string): Promise<VerifyResult>
  /** Setting a new code when one exists needs the current one. */
  setCode(code: string, current?: string): Promise<IdentityView>
  removeCode(current: string): Promise<IdentityView>
  setAskWhen(when: AskWhen): Promise<IdentityView>
  /** Speaks the fixed "is that you?" line; null when speech is off. */
  speakChallenge(language: 'en' | 'ur-Latn' | 'ur-Arab'): Promise<{ replyId: string } | null>
  onChanged(cb: (v: IdentityView) => void): () => void
}

/**
 * Canonical form compared for typed and spoken codes: case, accents,
 * punctuation and spacing do not matter ("Neela Aasmaan!" = "neela aasmaan").
 */
export const normalizeCode = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')

/** A code the owner may set, or an explanation of why not. */
export const checkNewCode = (code: unknown): { ok: true; normalized: string } | { ok: false; error: string } => {
  if (typeof code !== 'string') return { ok: false, error: 'The code must be text.' }
  const n = normalizeCode(code)
  if (n.replace(/ /g, '').length < CODE_MIN) return { ok: false, error: `Use at least ${CODE_MIN} letters or numbers.` }
  if (n.length > CODE_MAX) return { ok: false, error: `Keep it under ${CODE_MAX} characters.` }
  return { ok: true, normalized: n }
}

export const isAskWhen = (v: unknown): v is AskWhen => typeof v === 'string' && (ASK_WHEN as readonly string[]).includes(v)

/** Fixed challenge lines, so nothing personal goes through the model. */
export const CHALLENGE: Record<'en' | 'ur-Latn' | 'ur-Arab', (name: string) => string> = {
  en: name => `Hi${name ? ` ${name}` : ''}, is that you? Please say or type our security code.`,
  'ur-Latn': name => `Salam${name ? ` ${name}` : ''}, kya ye aap hain? Apna security code bolein ya likhein.`,
  'ur-Arab': name => `سلام${name ? ` ${name}` : ''}، کیا یہ آپ ہیں؟ اپنا سیکیورٹی کوڈ بولیں یا لکھیں۔`,
}
