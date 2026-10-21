/**
 * Voice ID: who is speaking, from a voice print (an embedding) made on this
 * PC. The owner enrols with a few phrases, family can be added; only the
 * prints are kept, encrypted. It tells Atlas who it is talking to; it is
 * never a lock (voices can be imitated): sends, payments and deletes still
 * need the owner's yes.
 */

export const SPK = {
  state: 'speaker:state',
  changed: 'speaker:changed',
  download: 'speaker:download',
  enrol: 'speaker:enrol',
  identify: 'speaker:identify',
  forget: 'speaker:forget',
  setOptions: 'speaker:set-options',
} as const

/** 16 kHz mono samples, the rate the voice model reads. */
export const SPK_RATE = 16_000
/** At least this much voice per enrolment phrase, and per voice check. */
export const MIN_SECONDS = 1.2
export const ENROL_PHRASES = 5

/** Same person at or above this; clearly someone else below GUEST_BELOW; in between, unsure. */
export const MATCH = 0.5
export const GUEST_BELOW = 0.3

export type Verdict = 'owner' | 'known' | 'guest' | 'unsure'

export interface SpeakerResult {
  /** The enrolled person it sounds like, if any. */
  name: string | null
  verdict: Verdict
  /** Similarity to the closest enrolled voice, -1..1. */
  score: number
}

export interface SpeakerPerson {
  name: string
  owner: boolean
  phrases: number
  created: number
}

export interface SpeakerView {
  model: { status: 'missing' | 'downloading' | 'ready' | 'error'; progress: number; error: string | null; bytes: number }
  people: SpeakerPerson[]
  /** Voice messages carry who spoke. */
  enabled: boolean
  /** Only the owner's voice wakes Atlas (a TV or a visitor does not). */
  wakeOnlyOwner: boolean
}

export interface SpeakerBridge {
  state(): Promise<SpeakerView>
  download(): Promise<SpeakerView>
  /** Each phrase: 16 kHz mono Float32 samples as bytes. */
  enrol(name: string, owner: boolean, phrases: Uint8Array[]): Promise<SpeakerView>
  identify(samples: Uint8Array): Promise<SpeakerResult>
  forget(name: string | null): Promise<SpeakerView>
  setOptions(o: { enabled?: boolean; wakeOnlyOwner?: boolean }): Promise<SpeakerView>
  onChanged(cb: (v: SpeakerView) => void): () => void
}

/** What the owner reads aloud to enrol: varied sounds, English and Urdu. */
export const PHRASES = [
  'Atlas, what does my day look like today?',
  'Aaj ka weather kaisa hai, aur kal ka plan kya hai?',
  'Please remind me to call the bank at five o’clock.',
  'Mujhe aaj ki news sunao, khaas taur par technology ki.',
  'Open my project in VS Code and check the latest changes.',
]

export const cosine = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

const normalize = (v: ArrayLike<number>): number[] => {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!
  n = Math.sqrt(n) || 1
  return Array.from(v, x => x / n)
}

/** One print from several phrases: each normalised, averaged, normalised again. */
export const averagePrint = (prints: ArrayLike<number>[]): number[] => {
  const ns = prints.map(normalize)
  const mean = ns[0]!.map((_, i) => ns.reduce((s, p) => s + p[i]!, 0) / ns.length)
  return normalize(mean)
}

/** The phrases sound like one voice (a noisy room or two people would not). */
export const consistent = (prints: ArrayLike<number>[]): boolean => {
  for (let i = 0; i < prints.length; i++) for (let j = i + 1; j < prints.length; j++) if (cosine(prints[i]!, prints[j]!) < MATCH - 0.1) return false
  return true
}

/** Who it sounds like among the enrolled people. */
export const judge = (print: ArrayLike<number>, people: { name: string; owner: boolean; print: number[] }[]): SpeakerResult => {
  if (!people.length) return { name: null, verdict: 'unsure', score: 0 }
  const scored = people.map(p => ({ p, score: cosine(print, p.print) })).sort((a, b) => b.score - a.score)
  const best = scored[0]!
  const score = Math.round(best.score * 1000) / 1000
  if (best.score >= MATCH) return { name: best.p.name, verdict: best.p.owner ? 'owner' : 'known', score }
  const owner = scored.find(s => s.p.owner)
  if (!owner || owner.score < GUEST_BELOW) return { name: null, verdict: 'guest', score }
  return { name: null, verdict: 'unsure', score }
}

/**
 * The line Atlas reads before a voice message from someone other than the
 * owner; nothing for the owner or when unsure (a poor mic must not lock the
 * owner out of their own assistant).
 */
export const speakerNote = (r: SpeakerResult | undefined, owner: string): string => {
  if (!r || r.verdict === 'owner' || r.verdict === 'unsure') return ''
  const who = r.verdict === 'known' ? `${r.name}, someone ${owner || 'the owner'} added as family or a regular` : `someone whose voice is not ${owner || 'the owner'}’s`
  return `[Voice ID: this was said by ${who}. Be helpful with general things, but keep ${owner || 'the owner'}’s private matters private (memories, messages, tasks, calendar, files, money) unless they are here to say so; do nothing that acts on their behalf.]\n`
}

/** Float32 samples ↔ bytes, for the wire. */
export const samplesToBytes = (s: Float32Array): Uint8Array => new Uint8Array(s.buffer, s.byteOffset, s.byteLength)
export const bytesToSamples = (b: Uint8Array): Float32Array => {
  const copy = new Uint8Array(b.byteLength - (b.byteLength % 4))
  copy.set(b.subarray(0, copy.byteLength))
  return new Float32Array(copy.buffer)
}
