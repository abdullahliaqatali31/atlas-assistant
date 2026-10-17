/**
 * Personality adapter (plan sections 4 and 10). Reads how the owner reacts
 * to the assistant's style and adapts the profile, with two rules:
 *
 * - A clear, lasting instruction ("hamesha chhote jawab do", "from now on in
 *   English") is applied at once as a new profile version, with undo.
 * - A passing hint ("itna lamba kyun", "bak bak") only counts. The same hint
 *   three times on at least two days becomes a proposal the owner confirms.
 *
 * It never changes names, safety rules or limits, only tone settings.
 */
import type { MemoryStore } from '@assistant/memory'
import { DAY, type Clock, type PersonalityProfile } from '@assistant/shared'

export type StyleField = 'verbosity' | 'humour' | 'language' | 'disagreement'

export interface StyleSignal {
  field: StyleField
  value: PersonalityProfile[StyleField]
  /** Lasting instruction (apply now) or a passing hint (count, then ask). */
  strength: 'instruction' | 'hint'
}

/** Words that turn a remark into a lasting instruction. */
const LASTING = /\b(hamesha|always|from now on|aaj se|ab se|aainda|aindah|aage se|har baar|every time|kabhi bhi|in future|going forward)\b/i

const RULES: { field: StyleField; value: PersonalityProfile[StyleField]; re: RegExp }[] = [
  { field: 'verbosity', value: 'short', re: /\b(chho?t[ae] (jawab|reply|answers?)|mukhtasar|short(er)? (answers?|replies)|be brief|kam bol|bak ?bak|(itna|bohat|bahut|kaafi|bara) (lamba|zyada)|too long|talk less|zyada mat bol)/i },
  { field: 'verbosity', value: 'detailed', re: /\b(tafseel|tafseeli|detail(ed)? (answers?|replies)|explain more|zyada (detail|tafseel)|in detail|lamb[ae] jawab)/i },
  { field: 'humour', value: false, re: /\b(no (more )?jokes|mazaa?q (mat|na|band|nahi)|joke mat|serious raho|be serious|stop joking)/i },
  { field: 'humour', value: true, re: /\b(thora mazaa?q|mazaa?q (kiya )?karo|be (more )?funny|make jokes|joke kiya karo)/i },
  { field: 'language', value: 'en', re: /\b(english (mein|me|main) (baat|bolo|jawab|reply)|(speak|reply|answer|talk) (in )?english)\b/i },
  { field: 'language', value: 'ur-Latn', re: /\b(roman urdu (mein|me)|urdu (mein|me|main) (baat|bolo|jawab|reply)|(speak|reply|answer|talk) (in )?urdu)\b/i },
  { field: 'language', value: 'ur-Arab', re: /\b(urdu script|اردو (میں|رسم الخط))/i },
  { field: 'disagreement', value: 'direct', re: /\b(seedha (bata|bolo)|sach sach|be (more )?(direct|honest|blunt)|tell me straight|bluntly)/i },
  { field: 'disagreement', value: 'gentle', re: /\b(narmi se|softly|gently|politely|be (more )?gentle)/i },
]

/** The style feedback in one owner message, if any (first match per field). */
export const detectStyle = (text: string): StyleSignal[] => {
  const strength = LASTING.test(text) ? 'instruction' : 'hint'
  const seen = new Set<StyleField>()
  const out: StyleSignal[] = []
  for (const r of RULES) {
    if (seen.has(r.field) || !r.re.test(text)) continue
    seen.add(r.field)
    out.push({ field: r.field, value: r.value, strength })
  }
  return out
}

const LABEL: Record<StyleField, (v: unknown) => string> = {
  verbosity: v => (v === 'short' ? 'keep replies short' : 'give detailed replies'),
  humour: v => (v ? 'keep some humour' : 'stop the jokes'),
  language: v => (v === 'en' ? 'reply in English' : v === 'ur-Arab' ? 'reply in Urdu script' : 'reply in Roman Urdu'),
  disagreement: v => (v === 'direct' ? 'say plainly when I think you’re wrong' : v === 'firm' ? 'push back firmly' : 'raise concerns gently'),
}

export const describeStyle = (field: StyleField, value: unknown) => LABEL[field](value)

export type StyleOutcome =
  | { kind: 'applied'; field: StyleField; value: unknown; description: string }
  | { kind: 'proposed'; proposalId: string; field: StyleField; value: unknown; description: string }

/** Hints needed (across at least two days within the window) before asking. */
const HINTS_TO_ASK = 3
const HINT_WINDOW = 14 * DAY

export class PersonalityAdapter {
  constructor(
    private readonly memory: MemoryStore,
    private readonly clock: Clock,
  ) {}

  /** Call with every owner message. Returns what changed or was proposed. */
  observe(text: string): StyleOutcome[] {
    const out: StyleOutcome[] = []
    const profile = this.memory.personality().profile
    for (const s of detectStyle(text)) {
      if (profile[s.field] === s.value) continue
      const description = describeStyle(s.field, s.value)
      if (s.strength === 'instruction') {
        this.memory.updatePersonality({ [s.field]: s.value } as Partial<PersonalityProfile>, `learned: ${description} (you said: "${text.slice(0, 120)}")`)
        this.memory.clearStyleSignals(s.field)
        out.push({ kind: 'applied', field: s.field, value: s.value, description })
        continue
      }
      this.memory.addStyleSignal(s.field, String(s.value), text)
      const hints = this.memory.styleSignals(s.field, String(s.value), this.clock.now() - HINT_WINDOW)
      const days = new Set(hints.map(h => Math.floor(h.at / DAY)))
      if (hints.length >= HINTS_TO_ASK && days.size >= 2) {
        const id = this.memory.addProposal({
          kind: 'personality',
          title: `Should I always ${description}?`,
          detail: { field: s.field, value: s.value },
          evidence: hints.map(h => `“${h.text.slice(0, 100)}”`).join(' · '),
          // One open question per field and value; a new one only after this is decided and pruned.
          dedupKey: `personality:${s.field}:${String(s.value)}:${Math.floor(this.clock.now() / (30 * DAY))}`,
        })
        if (id) out.push({ kind: 'proposed', proposalId: id, field: s.field, value: s.value, description })
      }
    }
    return out
  }

  /** The owner accepted a personality proposal. */
  apply(field: StyleField, value: unknown) {
    this.memory.updatePersonality({ [field]: value } as Partial<PersonalityProfile>, `learned (you confirmed): ${describeStyle(field, value)}`)
    this.memory.clearStyleSignals(field)
  }
}
