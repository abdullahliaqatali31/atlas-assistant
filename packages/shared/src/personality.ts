/**
 * The owner's personality profile (plan section 10): names, language and tone.
 * Pure data with strict validation, shared by memory (storage), runtime
 * (prompt assembly) and the desktop app (IPC). It only ever selects among
 * fixed options, so it cannot carry instructions into the system prompt.
 */

export const REPLY_LANGUAGES = ['auto', 'ur-Latn', 'ur-Arab', 'en', 'mix'] as const
export type ReplyLanguage = (typeof REPLY_LANGUAGES)[number]

export const VERBOSITY = ['short', 'detailed'] as const
export type Verbosity = (typeof VERBOSITY)[number]

export const DISAGREEMENT = ['gentle', 'direct', 'firm'] as const
export type Disagreement = (typeof DISAGREEMENT)[number]

export interface PersonalityProfile {
  /** How to address the owner ("Boss"); empty means their name. */
  ownerNickname: string
  /** The assistant's own name; empty means none. */
  assistantName: string
  /** 'auto' follows how the owner writes and ASSISTANT_LANGUAGES. */
  language: ReplyLanguage
  humour: boolean
  verbosity: Verbosity
  disagreement: Disagreement
}

export const DEFAULT_PROFILE: Readonly<PersonalityProfile> = Object.freeze({
  ownerNickname: '',
  assistantName: '',
  language: 'auto',
  humour: true,
  verbosity: 'short',
  disagreement: 'direct',
})

export const MAX_NAME_CHARS = 40

/** Letters (any script), marks, digits, spaces and . ' - only: a name, never a sentence of instructions. */
const NAME = /^[\p{L}\p{M}\p{N} .'’-]*$/u

/** A cleaned name, or null when it has characters a name should not have. */
export const parseName = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const name = v.normalize('NFC').replace(/\s+/g, ' ').trim()
  return name.length <= MAX_NAME_CHARS && NAME.test(name) ? name : null
}

const oneOf =
  <T extends string>(options: readonly T[]) =>
  (v: unknown): T | null =>
    typeof v === 'string' && (options as readonly string[]).includes(v) ? (v as T) : null

const PARSERS: { [K in keyof PersonalityProfile]: (v: unknown) => PersonalityProfile[K] | null } = {
  ownerNickname: parseName,
  assistantName: parseName,
  language: oneOf(REPLY_LANGUAGES),
  humour: v => (typeof v === 'boolean' ? v : null),
  verbosity: oneOf(VERBOSITY),
  disagreement: oneOf(DISAGREEMENT),
}

const KEYS = Object.keys(PARSERS) as (keyof PersonalityProfile)[]

/** A partial update: every key known and valid, or null. */
export const parseProfilePatch = (v: unknown): Partial<PersonalityProfile> | null => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const out: Record<string, unknown> = {}
  for (const [k, value] of Object.entries(v)) {
    const parse = PARSERS[k as keyof PersonalityProfile]
    if (!parse) return null
    const parsed = parse(value)
    if (parsed === null) return null
    out[k] = parsed
  }
  return out as Partial<PersonalityProfile>
}

/** A stored profile, tolerant of older or damaged rows: bad fields fall back to defaults. */
export const coerceProfile = (v: unknown): PersonalityProfile => {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const out = { ...DEFAULT_PROFILE }
  for (const k of KEYS) {
    const parsed = PARSERS[k](o[k])
    if (parsed !== null) (out as Record<string, unknown>)[k] = parsed
  }
  return out
}

export const sameProfile = (a: PersonalityProfile, b: PersonalityProfile) => KEYS.every(k => a[k] === b[k])

/**
 * The speech-to-text language pin. Spoken Urdu and Hindi sound alike, so
 * auto-detection often writes Urdu in Devanagari; any Urdu choice pins to
 * Urdu. 'auto' keeps the old rule: the first configured non-English language.
 */
export const sttLanguageFor = (language: ReplyLanguage, configured: readonly string[]): string | undefined => {
  if (language === 'ur-Latn' || language === 'ur-Arab' || language === 'mix') return 'ur'
  if (language === 'en') return undefined
  const primary = configured[0]?.split('-')[0]?.toLowerCase()
  return primary && primary !== 'en' ? primary : undefined
}

/**
 * Pulls a name out of a spoken answer: "call me Boss", "mujhe Boss bulao",
 * "mera naam Ali hai". Returns '' when nothing name-like is left.
 */
export const extractName = (heard: string): string => {
  let s = heard
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[.!?,;:۔؟"“”]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  s = s.replace(/^(?:(?:you can |just |please )?call me|my name is|i am|i'm|it's|mujhe|mujhay|mera naam|meri naam|aap mujhe|ap mujhe|tum mujhe|naam)\s+/i, '')
  s = s.replace(/\s+(?:bulao|bulaen|bulayen|bulaein|bulana|bulaya karo|kaho|kahen|kahein|kaha karo|kehna|hai|he|please)$/i, '')
  s = s.replace(/^(?:your name is|tumhara naam|aap ka naam|apka naam)\s+/i, '')
  const name = s
    .replace(/[^\p{L}\p{M}\p{N} .'’-]/gu, '')
    .trim()
    .slice(0, MAX_NAME_CHARS)
    .trim()
  return parseName(name) ?? ''
}
