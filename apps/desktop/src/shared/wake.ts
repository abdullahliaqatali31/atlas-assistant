/**
 * Wake word: the assistant starts listening when it hears its own name.
 * Detection runs on this computer (a small Moonshine speech model in a worker); only
 * what is said after the name goes to the voice provider. This module holds
 * the settings contract and the name matcher, which is pure and tested.
 */

export const SENSITIVITIES = ['strict', 'normal', 'relaxed'] as const
export type Sensitivity = (typeof SENSITIVITIES)[number]

export interface WakeSettings {
  /** Listen for the assistant's name (needs the local speech model). */
  enabled: boolean
  /** Two quick claps wake it too (no model needed). */
  clap: boolean
  /** A steady whistle (seeti) wakes it too (no model needed). */
  whistle: boolean
  sensitivity: Sensitivity
  /** Spellings the model produced for the name during training, plus any the owner added. */
  aliases: string[]
}

export const DEFAULT_WAKE: WakeSettings = { enabled: false, clap: false, whistle: false, sensitivity: 'normal', aliases: [] }
export const MAX_ALIASES = 20

export type ModelState = { status: 'missing' } | { status: 'downloading'; received: number; total: number } | { status: 'ready'; bytes: number } | { status: 'error'; message: string }

export interface WakeView extends WakeSettings {
  model: ModelState
  /** Approximate download size, shown before asking. */
  modelBytes: number
}

/** Channel names for `window.wake`. */
export const WC = {
  get: 'wake:get',
  update: 'wake:update',
  downloadModel: 'wake:download-model',
  deleteModel: 'wake:delete-model',
  changed: 'wake:changed',
} as const

export interface WakeBridge {
  get(): Promise<WakeView>
  update(patch: Partial<WakeSettings>): Promise<WakeView>
  /** Downloads the speech model once (asks nothing; the UI asks first). */
  downloadModel(): Promise<WakeView>
  deleteModel(): Promise<WakeView>
  onChanged(cb: (v: WakeView) => void): () => void
}

/** The local model, served to the renderer from this scheme by main. */
export const MODEL_SCHEME = 'assistant-model'
/**
 * Moonshine tiny (English, ~32 MB quantized): unlike Whisper, it only processes
 * the audio actually spoken, so a one-second name takes a fraction of the time.
 */
export const MODEL_ID = 'moonshine-tiny'
export const MODEL_REPO = 'onnx-community/moonshine-tiny-ONNX'
/** Earlier model folders the app may have left behind; removed on start. */
export const LEGACY_MODEL_IDS = ['whisper-tiny']
export const MODEL_FILES: { path: string; bytes: number }[] = [
  { path: 'config.json', bytes: 921 },
  { path: 'generation_config.json', bytes: 147 },
  { path: 'preprocessor_config.json', bytes: 128 },
  { path: 'tokenizer.json', bytes: 3_761_754 },
  { path: 'tokenizer_config.json', bytes: 135_735 },
  { path: 'onnx/encoder_model_quantized.onnx', bytes: 7_937_661 },
  { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 20_243_286 },
]
export const MODEL_BYTES = MODEL_FILES.reduce((n, f) => n + f.bytes, 0)

// ── matching ────────────────────────────────────────────────

/** Lowercase, accents off, letters (Latin or Arabic script) and digits only. */
export const normalizeWord = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * A rough sound-alike key for Latin spellings, so "Zara", "Zaara", "Sara"
 * and "Zahra" meet: similar consonants merged, vowels and h dropped after
 * the first letter, repeats collapsed. Arabic-script words pass through.
 */
export const soundKey = (word: string) => {
  const w = normalizeWord(word)
  if (!/^[a-z0-9]+$/.test(w)) return w
  const merged = w
    .replace(/ph/g, 'f')
    .replace(/[ckq]/g, 'k')
    .replace(/[sz]/g, 's')
    .replace(/[vw]/g, 'w')
    .replace(/[ij]/g, 'y')
    // Voiced and unvoiced pairs sound alike in a quick name: "Adlas" ~ "Atlas".
    .replace(/d/g, 't')
    .replace(/b/g, 'p')
    .replace(/g/g, 'k')
  const [first = '', ...rest] = merged
  const body = rest.join('').replace(/[aeiouh]/g, '')
  return (first + body).replace(/(.)\1+/g, '$1')
}

export const levenshtein = (a: string, b: string) => {
  if (a === b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]!
}

const allowedEdits = (len: number, s: Sensitivity) => {
  if (s === 'strict') return 0
  // Short names allow fewer edits: three edits turn "was" into "atlas".
  if (s === 'normal') return len <= 5 ? 1 : 2
  return len <= 5 ? 2 : 3
}

/**
 * Words speech models produce from silence, noise or filler. They can never
 * be a wake word, so training ignores them ("You" is a classic hallucination).
 */
export const NOT_A_NAME = new Set(['you', 'the', 'a', 'an', 'and', 'thank', 'thanks', 'thankyou', 'okay', 'ok', 'yes', 'yeah', 'no', 'hi', 'hello', 'hey', 'bye', 'um', 'uh', 'hmm', 'oh', 'so', 'i', 'it', 'is', 'to', 'music'])

/**
 * From a training transcript, the word (or two-word span) most like the name,
 * or null when nothing plausible was heard.
 */
export const learnAlias = (transcript: string, name: string): string | null => {
  const target = normalizeWord(name)
  if (!target) return null
  const words = transcript
    .split(/\s+/)
    .map(w => w.replace(/[^\p{L}\p{N}'-]/gu, ''))
    .filter(Boolean)
  let best: { text: string; d: number } | null = null
  for (let i = 0; i < words.length; i++) {
    for (const span of [1, 2]) {
      if (i + span > words.length) continue
      const text = words.slice(i, i + span).join(' ')
      const norm = normalizeWord(text)
      if (norm.length < 2 || NOT_A_NAME.has(norm)) continue
      const d = Math.min(levenshtein(norm, target), levenshtein(soundKey(text), soundKey(name)) + 1)
      if (!best || d < best.d) best = { text, d }
    }
  }
  // Only spellings reasonably close to the name; anything else was other speech.
  return best && best.d <= (target.length <= 6 ? 2 : 3) ? best.text : null
}

export interface WakeMatch {
  alias: string
  heard: string
  /** Words after the name, e.g. "aaj kya hai" in "Zara aaj kya hai". */
  rest: string
}

/**
 * Looks for the name in the first few words of what was heard (one or two
 * words, so a two-word name or a split spelling still matches).
 */
export const matchWake = (transcript: string, aliases: readonly string[], sensitivity: Sensitivity): WakeMatch | null => {
  const words = transcript.split(/\s+/).filter(w => normalizeWord(w))
  const targets = aliases.map(a => ({ alias: a, norm: normalizeWord(a), key: soundKey(a) })).filter(t => t.norm.length >= 2)
  if (targets.length === 0) return null
  const window = Math.min(words.length, 4)
  for (let i = 0; i < window; i++) {
    for (const span of [1, 2]) {
      if (i + span > words.length) continue
      const heard = words.slice(i, i + span).join(' ')
      const norm = normalizeWord(heard)
      if (norm.length < 2) continue
      for (const t of targets) {
        const exact = norm === t.norm
        // A much shorter word ("at" for "Atlas") is never close, whatever the edit count.
        // Split names ("jar vis") must match exactly or by sound; edit distance only within one word,
        // so phrases like "at least" never pass for "Atlas".
        const longEnough = span === 1 && norm.length >= Math.ceil(t.norm.length * 0.6)
        const close = longEnough && levenshtein(norm, t.norm) <= allowedEdits(t.norm.length, sensitivity)
        const key = soundKey(heard)
        const sounds =
          (sensitivity !== 'strict' && key === t.key && t.key.length >= 2) ||
          // Relaxed also accepts one sound off, for single words only ("Adlers" for "Atlas").
          (sensitivity === 'relaxed' && span === 1 && longEnough && t.key.length >= 3 && levenshtein(key, t.key) <= 1)
        if (exact || close || sounds) return { alias: t.alias, heard, rest: words.slice(i + span).join(' ') }
      }
    }
  }
  return null
}

/** Fewer words than this after the name are not a request (a speech model often turns "Atlas Atlas" into "Atlas at 10"). */
export const MIN_REQUEST_WORDS = 3

/**
 * The request said in the same breath as the name, without the name repeated,
 * or null when there is none worth sending and the assistant should just listen.
 */
export const wakeRequest = (match: WakeMatch, aliases: readonly string[], sensitivity: Sensitivity): string | null => {
  let rest = match.rest.trim()
  // "Atlas, Atlas, what's on today": drop the repeated name too.
  for (let again = matchWake(rest, aliases, sensitivity); again && rest.startsWith(again.heard); again = matchWake(rest, aliases, sensitivity)) {
    rest = again.rest.trim()
  }
  const words = rest.split(/\s+/).filter(w => normalizeWord(w))
  return words.length >= MIN_REQUEST_WORDS ? words.join(' ') : null
}

/** Settings patch from the renderer, checked in main. */
export const parseWakePatch = (v: unknown): Partial<WakeSettings> | null => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const out: Partial<WakeSettings> = {}
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== 'boolean') return null
    out.enabled = o.enabled
  }
  for (const k of ['clap', 'whistle'] as const) {
    if (o[k] === undefined) continue
    if (typeof o[k] !== 'boolean') return null
    out[k] = o[k] as boolean
  }
  if (o.sensitivity !== undefined) {
    if (!(SENSITIVITIES as readonly unknown[]).includes(o.sensitivity)) return null
    out.sensitivity = o.sensitivity as Sensitivity
  }
  if (o.aliases !== undefined) {
    if (!Array.isArray(o.aliases) || o.aliases.length > MAX_ALIASES) return null
    const aliases = [...new Set(o.aliases.map(a => (typeof a === 'string' ? a.trim() : '')).filter(a => a.length >= 2 && a.length <= 40))]
    if (aliases.length !== o.aliases.length && o.aliases.some(a => typeof a !== 'string')) return null
    out.aliases = aliases
  }
  return out
}
