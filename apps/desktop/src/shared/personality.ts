/**
 * Contract for first-run onboarding and the Personality section of Setup
 * (plan sections 10 and 15). The renderer only ever sends a validated profile
 * patch or a prompt key: the words the assistant speaks during onboarding
 * come from the table below, never from the renderer.
 */
import { parseProfilePatch, type PersonalityProfile, type ReplyLanguage } from '@assistant/shared'

export type { PersonalityProfile, ReplyLanguage }

export interface PersonalityView {
  profile: PersonalityProfile
  version: number
  canUndo: boolean
  updatedAt: number | null
  /** First-run onboarding was finished or skipped for this data directory. */
  onboarded: boolean
  /** Newest first, a few entries for the Setup screen. */
  history: { version: number; reason: string; at: number }[]
}

export const CHANGE_REASONS = ['onboarding', 'setup'] as const
export type ChangeReason = (typeof CHANGE_REASONS)[number]

/** Channel names for `window.personality`. */
export const PC = {
  get: 'personality:get',
  update: 'personality:update',
  undo: 'personality:undo',
  reset: 'personality:reset',
  exportFile: 'personality:export',
  setOnboarded: 'personality:set-onboarded',
  speakPrompt: 'personality:speak-prompt',
  transcribe: 'personality:transcribe',
  welcome: 'personality:welcome',
  changed: 'personality:changed',
} as const

export interface PersonalityBridge {
  /** Null while the runtime is not ready (no database yet). */
  get(): Promise<PersonalityView | null>
  update(patch: Partial<PersonalityProfile>, reason: ChangeReason): Promise<PersonalityView>
  undo(): Promise<PersonalityView>
  reset(): Promise<PersonalityView>
  /** Asks where to save, then writes the profile and its history as JSON. */
  exportFile(): Promise<{ saved: boolean }>
  /** false runs onboarding again (from Setup). */
  setOnboarded(done: boolean): Promise<PersonalityView>
  /** Speaks one onboarding question; null when speech is off or unavailable. */
  speakPrompt(step: OnboardingStep, language: PromptLanguage): Promise<{ replyId: string } | null>
  /** Speech-to-text only, for answering an onboarding question by voice. */
  transcribe(audio: Uint8Array, mime: string): Promise<string>
  /** The assistant's first greeting; it streams like any reply. */
  welcome(): Promise<{ replyId: string }>
  onChanged(cb: (v: PersonalityView) => void): () => void
}

// ── onboarding script ───────────────────────────────────────

export const ONBOARDING_STEPS = ['language', 'ownerNickname', 'assistantName', 'humour', 'verbosity', 'disagreement', 'securityCode', 'identityAsk'] as const
/** Steps whose answers go to the owner check (main), not to the personality profile. */
export const IDENTITY_STEPS = ['securityCode', 'identityAsk'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

/** Languages the onboarding is written in; 'mix' reads as Roman Urdu. */
export const PROMPT_LANGUAGES = ['en', 'ur-Latn', 'ur-Arab'] as const
export type PromptLanguage = (typeof PROMPT_LANGUAGES)[number]

export const promptLanguageFor = (l: ReplyLanguage): PromptLanguage => (l === 'ur-Arab' ? 'ur-Arab' : l === 'ur-Latn' || l === 'mix' ? 'ur-Latn' : 'en')

type Text = Record<PromptLanguage, string>

const LANGUAGE_QUESTION =
  'Assalam o alaikum! Main aap ka assistant hoon. Pehle batayein, main kis zabaan mein baat karun? Hello! Which language should I use with you?'

export const QUESTIONS: Record<OnboardingStep, Text> = {
  language: { en: LANGUAGE_QUESTION, 'ur-Latn': LANGUAGE_QUESTION, 'ur-Arab': LANGUAGE_QUESTION },
  ownerNickname: {
    en: 'What should I call you? Your name, a nickname, or something like Boss.',
    'ur-Latn': 'Main aap ko kya bulaun? Aap ka naam, koi nickname, ya Boss jaisa kuch.',
    'ur-Arab': 'میں آپ کو کیا بلاؤں؟ آپ کا نام، کوئی نک نیم، یا باس جیسا کچھ۔',
  },
  assistantName: {
    en: 'And what would you like to call me? Give me a name, or skip this.',
    'ur-Latn': 'Aur aap mujhe kis naam se bulana chahenge? Koi naam dein, ya skip kar dein.',
    'ur-Arab': 'اور آپ مجھے کس نام سے بلانا چاہیں گے؟ کوئی نام دیں، یا اسے چھوڑ دیں۔',
  },
  humour: {
    en: 'Should I keep a bit of humour in my replies?',
    'ur-Latn': 'Kya main baaton mein thora mazaaq rakhun?',
    'ur-Arab': 'کیا میں باتوں میں تھوڑا مذاق رکھوں؟',
  },
  verbosity: {
    en: 'Do you prefer short answers, or more detailed ones?',
    'ur-Latn': 'Aap ko chhote jawab pasand hain ya tafseeli?',
    'ur-Arab': 'آپ کو مختصر جواب پسند ہیں یا تفصیلی؟',
  },
  securityCode: {
    en: 'Last thing: set a security word or sentence. When I am not sure it is you, I will ask for it before sharing anything private. Only a scrambled version is stored on this computer.',
    'ur-Latn': 'Aakhri baat: ek security word ya sentence rakh dein. Jab mujhe yaqeen na ho ke ye aap hain, to kuch bhi private batane se pehle main ye poochunga. Is computer par sirf iska scrambled version save hota hai.',
    'ur-Arab': 'آخری بات: ایک سیکیورٹی لفظ یا جملہ رکھ دیں۔ جب مجھے یقین نہ ہو کہ یہ آپ ہیں، تو کچھ بھی نجی بتانے سے پہلے میں یہ پوچھوں گا۔ اس کمپیوٹر پر صرف اس کا خفیہ روپ محفوظ ہوتا ہے۔',
  },
  identityAsk: {
    en: 'When should I ask for the code?',
    'ur-Latn': 'Main code kab poochun?',
    'ur-Arab': 'میں کوڈ کب پوچھوں؟',
  },
  disagreement: {
    en: 'When I think you are making a mistake, how firmly should I say so?',
    'ur-Latn': 'Jab mujhe lage ke aap ghalti kar rahe hain, to main kitni sakhti se bataun?',
    'ur-Arab': 'جب مجھے لگے کہ آپ غلطی کر رہے ہیں، تو میں کتنی سختی سے بتاؤں؟',
  },
}

export const UI_TEXT: Record<'next' | 'skip' | 'skipAll' | 'typeOrTalk' | 'done' | 'codePlaceholder' | 'codeSaved', Text> = {
  codePlaceholder: { en: 'Your security word or sentence', 'ur-Latn': 'Apna security word ya sentence', 'ur-Arab': 'اپنا سیکیورٹی لفظ یا جملہ' },
  codeSaved: { en: '(code saved)', 'ur-Latn': '(code save ho gaya)', 'ur-Arab': '(کوڈ محفوظ ہو گیا)' },
  next: { en: 'Next', 'ur-Latn': 'Aage', 'ur-Arab': 'آگے' },
  skip: { en: 'Skip', 'ur-Latn': 'Skip', 'ur-Arab': 'چھوڑیں' },
  skipAll: { en: 'Skip setup', 'ur-Latn': 'Sab skip karein', 'ur-Arab': 'سب چھوڑیں' },
  typeOrTalk: { en: 'Type, or tap the mic and say it', 'ur-Latn': 'Likhein, ya mic dabaa kar bolein', 'ur-Arab': 'لکھیں، یا مائیک دبا کر بولیں' },
  done: {
    en: 'All set. You can change any of this later in Setup › Personality.',
    'ur-Latn': 'Ho gaya. Ye sab baad mein Setup › Personality mein badal sakte hain.',
    'ur-Arab': 'ہو گیا۔ یہ سب بعد میں سیٹ اپ › پرسنالٹی میں بدل سکتے ہیں۔',
  },
}

/** When-to-ask chips for the identityAsk step (values are AskWhen). */
export const ASK_CHOICES = [
  { value: 'daily', label: { en: 'Once a day, first time I see you', 'ur-Latn': 'Din mein ek baar, pehli mulaqat par', 'ur-Arab': 'دن میں ایک بار، پہلی ملاقات پر' } },
  { value: 'away', label: { en: 'Also after 30+ minutes away', 'ur-Latn': '30+ minute door rehne ke baad bhi', 'ur-Arab': '30 منٹ سے زیادہ دور رہنے کے بعد بھی' } },
  { value: 'off', label: { en: 'Never ask', 'ur-Latn': 'Kabhi nahi', 'ur-Arab': 'کبھی نہیں' } },
] as const

/** Answer chips for the choice steps. */
export const CHOICES = {
  language: [
    { value: 'ur-Latn', label: { en: 'Roman Urdu', 'ur-Latn': 'Roman Urdu', 'ur-Arab': 'Roman Urdu' } },
    { value: 'ur-Arab', label: { en: 'اردو', 'ur-Latn': 'اردو', 'ur-Arab': 'اردو' } },
    { value: 'en', label: { en: 'English', 'ur-Latn': 'English', 'ur-Arab': 'English' } },
    { value: 'mix', label: { en: 'Mix of both', 'ur-Latn': 'Dono mix', 'ur-Arab': 'دونوں ملا کر' } },
  ],
  humour: [
    { value: true, label: { en: 'Yes, some humour', 'ur-Latn': 'Haan, thora mazaaq', 'ur-Arab': 'ہاں، تھوڑا مذاق' } },
    { value: false, label: { en: 'No, keep it plain', 'ur-Latn': 'Nahi, seedhi baat', 'ur-Arab': 'نہیں، سیدھی بات' } },
  ],
  verbosity: [
    { value: 'short', label: { en: 'Short', 'ur-Latn': 'Chhote', 'ur-Arab': 'مختصر' } },
    { value: 'detailed', label: { en: 'Detailed', 'ur-Latn': 'Tafseeli', 'ur-Arab': 'تفصیلی' } },
  ],
  disagreement: [
    { value: 'gentle', label: { en: 'Gently', 'ur-Latn': 'Narmi se', 'ur-Arab': 'نرمی سے' } },
    { value: 'direct', label: { en: 'Directly', 'ur-Latn': 'Seedha', 'ur-Arab': 'سیدھا' } },
    { value: 'firm', label: { en: 'Firmly', 'ur-Latn': 'Sakhti se', 'ur-Arab': 'سختی سے' } },
  ],
} as const satisfies {
  [K in 'language' | 'humour' | 'verbosity' | 'disagreement']: readonly { value: PersonalityProfile[K]; label: Text }[]
}

// ── validation (main process side) ──────────────────────────

export const parseReason = (v: unknown): ChangeReason | null => (typeof v === 'string' && (CHANGE_REASONS as readonly string[]).includes(v) ? (v as ChangeReason) : null)

export { parseProfilePatch }

/** The fixed question text for a step, or null for anything else. */
export const promptText = (step: unknown, language: unknown): string | null =>
  typeof step === 'string' &&
  (ONBOARDING_STEPS as readonly string[]).includes(step) &&
  typeof language === 'string' &&
  (PROMPT_LANGUAGES as readonly string[]).includes(language)
    ? QUESTIONS[step as OnboardingStep][language as PromptLanguage]
    : null

// ── main ⇄ runtime host messages ────────────────────────────

export type PersonalityOp =
  | { kind: 'get' }
  | { kind: 'update'; patch: Partial<PersonalityProfile>; reason: ChangeReason }
  | { kind: 'undo' }
  | { kind: 'reset' }
  | { kind: 'export' }
  | { kind: 'onboarded'; done: boolean }

export type PersonalityHostRequest =
  | { type: 'personality'; requestId: string; op: PersonalityOp }
  | { type: 'speak-prompt'; replyId: string; text: string }
  | { type: 'transcribe'; requestId: string; audio: Uint8Array; mime: string }
  | { type: 'welcome'; replyId: string }

export type PersonalityHostEvent =
  /** Answers one op; `exported` is the JSON for an export. */
  | { type: 'personality'; requestId: string; view?: PersonalityView | undefined; exported?: string | undefined; error?: string | undefined }
  | { type: 'transcript'; requestId: string; text?: string | undefined; error?: string | undefined }
