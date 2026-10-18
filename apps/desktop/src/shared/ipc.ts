/**
 * The whole contract between the sandboxed renderer and the main process.
 * Everything here is plain data: no keys ever travel main → renderer, only
 * whether each one is present.
 */

import { isLlmProvider, type LlmProviderId } from '@assistant/providers/llm-presets'

import type { ActivityHostEvent, ActivityHostRequest } from './activity.ts'
import type { CodeOp, CodeProjectView, RunView } from './code.ts'
import type { FileOp } from './files.ts'
import type { ControlHostEvent, ControlHostRequest } from './control.ts'
import type { PersonalityHostEvent, PersonalityHostRequest } from './personality.ts'
import type { LearningHostEvent, LearningHostRequest } from './learning.ts'
import type { ProjectsHostEvent, ProjectsHostRequest } from './projects.ts'

export const MODES = ['companion', 'work', 'focus', 'quiet'] as const
export type UiMode = (typeof MODES)[number]

export const MAX_MESSAGE_CHARS = 8_000
/** One spoken utterance; 30 s of opus is well under this. */
export const MAX_VOICE_BYTES = 5 * 1024 * 1024

export interface SetupProblem {
  key: string
  message: string
}

export type RuntimePhase = 'starting' | 'setup' | 'checking' | 'ready' | 'restarting' | 'stopped'

export interface RuntimeStatus {
  phase: RuntimePhase
  /** Missing or failing setup items, from `loadConfig` and provider checks. */
  problems: SetupProblem[]
  warnings: string[]
  mode: UiMode
  setup: SetupSummary
  /** Tool calls waiting for the owner's yes or no, oldest first. */
  approvals: ApprovalRequest[]
  /** available: a voice provider is configured; enabled: the owner wants replies spoken. */
  speech: { available: boolean; enabled: boolean }
  /** Things the assistant held back or only notified about, newest last. */
  later: InitiativeItem[]
}

/** Something the assistant raised on its own, with the attention policy's reason. */
export interface InitiativeItem {
  /** The initiative dedup key, e.g. `due:<taskId>` or `briefing:2026-10-17`. */
  id: string
  kind: 'briefing' | 'check-in' | 'reminder' | 'question' | 'wrap-up' | 'task' | 'other'
  title: string
  channel: 'speak' | 'notify' | 'queue'
  /** Why the assistant spoke up or held back ("why did you say this?"). */
  reason: string
  at: number
  /** "Don't remind me again" applies: a reminder about a task or commitment. */
  canMute: boolean
  /** The assistant asked something: after it speaks, it listens for the answer. */
  expectsAnswer?: boolean
}

/**
 * Owner controls for an initiative item: snooze ("Not now"), mute ("Don't
 * remind me again"; the task stays), dismiss, or tell (hear a queued item now).
 */
export const INITIATIVE_ACTIONS = ['snooze', 'mute', 'dismiss', 'tell'] as const
export type InitiativeAction = (typeof INITIATIVE_ACTIONS)[number]

/** OS session changes main forwards to the runtime. idleMs: how long the owner was away, on unlock/active. */
export type SessionChange = { signal: 'lock' | 'suspend' | 'idle' } | { signal: 'unlock' | 'resume' | 'active'; idleMs: number }

/** A tool call the policy gate wants the owner to approve. */
export interface ApprovalRequest {
  id: string
  tool: string
  actionClass: string
  /** Truncated JSON of the call input, for display only. */
  input: string
  reason: string
}

/** Tool progress for the activity view, as reported by the runtime. */
export interface ActionNotice {
  tool: string
  status: 'running' | 'done' | 'denied' | 'declined' | 'failed'
  detail?: string | undefined
}

/** Voice providers setup offers. Azure's free F0 tier has real Pakistani Urdu voices. */
export const VOICE_PROVIDERS = ['elevenlabs', 'azure'] as const
export type VoiceProviderChoice = (typeof VOICE_PROVIDERS)[number]

/** For the provider picker: what each one needs and suggests. */
export const VOICE_PROVIDER_INFO: Record<VoiceProviderChoice, { label: string; voiceLabel: string; needsRegion: boolean; suggestedVoices: readonly string[]; note: string }> = {
  elevenlabs: { label: 'ElevenLabs', voiceLabel: 'ElevenLabs voice ID', needsRegion: false, suggestedVoices: [], note: 'Paid plans unlock Voice Library voices.' },
  azure: {
    label: 'Azure AI Speech',
    voiceLabel: 'Azure voice name',
    needsRegion: true,
    suggestedVoices: ['ur-PK-UzmaNeural', 'ur-PK-AsadNeural'],
    note: 'The free F0 tier works and includes Pakistani Urdu voices.',
  },
}

/** What setup already has. Keys are reported as present/absent only. */
export interface StartupView {
  /** Only the installed app can register itself. */
  available: boolean
  enabled: boolean
}

/** What the cost meter shows (same shape as the runtime's usage summary). */
export interface UsageView {
  today: { tokens: number; usd: number; calls: number }
  month: { tokens: number; usd: number; calls: number }
  byModel: { model: string; purpose: string; input: number; output: number; cached: number; calls: number; usd: number | null }[]
  unpriced: string[]
  budgetUsd: number
  overBudget: boolean
}

export interface SetupSummary {
  ownerName: string
  /** The LLM provider in use, its model, server address (custom/Ollama) and background model. */
  llmProvider: LlmProviderId
  llmModel: string
  llmBaseUrl: string
  llmBackgroundModel: string
  /** ElevenLabs voice id, or the Azure voice name when Azure is selected. */
  voiceId: string
  voiceProvider: VoiceProviderChoice
  /** Azure Speech resource region, e.g. "centralindia"; empty for ElevenLabs. */
  azureRegion: string
  hasLlmKey: boolean
  /** The selected voice provider's key is stored. */
  hasVoiceKey: boolean
}

export interface SetupInput {
  ownerName: string
  /** Absent keeps the current LLM provider and its settings. */
  llmProvider?: LlmProviderId | undefined
  llmModel?: string | undefined
  llmBaseUrl?: string | undefined
  llmBackgroundModel?: string | undefined
  voiceId: string
  /** Empty string keeps the stored key. */
  llmKey: string
  /** Key for `voiceProvider`; empty keeps the stored one. */
  voiceKey: string
  /** Absent keeps the current provider (older setup screens send only the fields above). */
  voiceProvider?: VoiceProviderChoice | undefined
  azureRegion?: string | undefined
}

/** One message of today's conversation. */
export interface DayLine {
  who: 'owner' | 'assistant'
  text: string
  at: number
}

export interface TaskView {
  id: string
  title: string
  status: string
  dueAt: number | null
}

export type ReplyEvent =
  | { replyId: string; type: 'chunk'; text: string }
  | { replyId: string; type: 'done'; stopped: boolean; error?: string }
  /** What speech-to-text heard for a voice message. */
  | { replyId: string; type: 'heard'; text: string }
  /** One sentence of spoken reply as a complete MP3, in order. */
  | { replyId: string; type: 'audio'; seq: number; data: Uint8Array }
  | { replyId: string; type: 'speech-error'; message: string }
  /** The assistant is speaking up on its own; the reply that follows belongs to this item. */
  | { replyId: string; type: 'initiative'; item: InitiativeItem }

/** Channel names, shared so main and preload cannot drift apart. */
export const CH = {
  status: 'assistant:status',
  statusChanged: 'assistant:status-changed',
  send: 'assistant:send',
  stop: 'assistant:stop',
  setMode: 'assistant:set-mode',
  listTasks: 'assistant:list-tasks',
  listToday: 'assistant:list-today',
  saveSetup: 'setup:save',
  answerApproval: 'assistant:answer-approval',
  sendVoice: 'assistant:send-voice',
  setSpeech: 'assistant:set-speech',
  listModels: 'assistant:list-models',
  usage: 'assistant:usage',
  startup: 'assistant:startup',
  setStartup: 'assistant:set-startup',
  usageChanged: 'assistant:usage-changed',
  setBudget: 'assistant:set-budget',
  setPrice: 'assistant:set-price',
  reply: 'assistant:reply',
  action: 'assistant:action',
  initiativeAction: 'assistant:initiative-action',
  ready: 'assistant:ready',
  silence: 'assistant:silence',
  interrupt: 'assistant:interrupt',
} as const

/** The API the preload exposes as `window.assistant`. */
export interface AssistantBridge {
  status(): Promise<RuntimeStatus>
  send(text: string): Promise<{ replyId: string }>
  /** A recorded utterance (webm/opus); the reply arrives like a typed one, after a 'heard' event. */
  sendVoice(audio: Uint8Array, mime: string): Promise<{ replyId: string }>
  setSpeech(enabled: boolean): Promise<void>
  stop(): Promise<void>
  /**
   * Barge-in: the owner started talking over a spoken reply (VAD fired while
   * audio played). Main silences playback (onSilence fires), drops the reply's
   * queued audio and cancels its TTS and text stream, well under 250 ms.
   * The renderer should still stop its own player immediately.
   */
  interrupt(): Promise<void>
  setMode(mode: UiMode): Promise<void>
  listTasks(): Promise<TaskView[]>
  /** Today's conversation so far (across restarts), oldest first. */
  listToday(): Promise<DayLine[]>
  saveSetup(input: SetupInput): Promise<RuntimeStatus>
  /** Models the chosen provider offers; uses the typed key, or the stored one when blank. */
  listModels(provider: LlmProviderId, apiKey: string, baseUrl: string): Promise<string[]>
  /** The cost meter: today, this month, per model, and the monthly budget. Null until the runtime reports. */
  usage(): Promise<UsageView | null>
  onUsage(cb: (u: UsageView) => void): () => void
  setBudget(usd: number): Promise<void>
  /** Start with Windows (installed app only), in the tray. */
  startup(): Promise<StartupView>
  setStartup(on: boolean): Promise<StartupView>
  setPrice(model: string, price: { input: number; output: number; cacheRead?: number | undefined } | null): Promise<void>
  answerApproval(id: string, approved: boolean): Promise<void>
  initiativeAction(id: string, action: InitiativeAction): Promise<void>
  /** The companion is listening for replies; main then flushes anything it held while the window was loading. */
  ready(): Promise<void>
  onReply(cb: (e: ReplyEvent) => void): () => void
  /** The screen locked or the PC is going to sleep: stop playback and listening now. */
  onSilence(cb: () => void): () => void
  onAction(cb: (n: ActionNotice) => void): () => void
  onStatus(cb: (s: RuntimeStatus) => void): () => void
}

// ── validation (main process side) ──────────────────────────

export const isMode = (v: unknown): v is UiMode => typeof v === 'string' && (MODES as readonly string[]).includes(v)

export const parseMessage = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const text = v.trim()
  return text && text.length <= MAX_MESSAGE_CHARS ? text : null
}

const field = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v.trim() : null)

export const parseApproval = (id: unknown, approved: unknown): { id: string; approved: boolean } | null =>
  typeof id === 'string' && id.length <= 64 && typeof approved === 'boolean' ? { id, approved } : null

export const parseInitiativeAction = (id: unknown, action: unknown): { id: string; action: InitiativeAction } | null =>
  typeof id === 'string' && id.length <= 300 && typeof action === 'string' && (INITIATIVE_ACTIONS as readonly string[]).includes(action)
    ? { id, action: action as InitiativeAction }
    : null

const AUDIO_MIME = /^audio\/[\w.+-]+(;[\w=.,\s-]*)?$/

export const parseVoice = (audio: unknown, mime: unknown): { audio: Uint8Array; mime: string } | null =>
  audio instanceof Uint8Array && audio.byteLength > 0 && audio.byteLength <= MAX_VOICE_BYTES && typeof mime === 'string' && mime.length <= 100 && AUDIO_MIME.test(mime)
    ? { audio, mime }
    : null

export const parseSetup = (v: unknown): SetupInput | null => {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const ownerName = field(o.ownerName, 100)
  const voiceId = field(o.voiceId, 200)
  const llmKey = field(o.llmKey, 500)
  const voiceKey = field(o.voiceKey, 500)
  if (ownerName === null || voiceId === null || llmKey === null || voiceKey === null) return null
  let voiceProvider: VoiceProviderChoice | undefined
  if (o.voiceProvider !== undefined) {
    if (typeof o.voiceProvider !== 'string' || !(VOICE_PROVIDERS as readonly string[]).includes(o.voiceProvider)) return null
    voiceProvider = o.voiceProvider as VoiceProviderChoice
  }
  let azureRegion: string | undefined
  if (o.azureRegion !== undefined) {
    const region = field(o.azureRegion, 40)?.toLowerCase()
    if (region === undefined || (region !== '' && !/^[a-z][a-z0-9]{2,30}$/.test(region))) return null
    azureRegion = region
  }
  let llmProvider: LlmProviderId | undefined
  if (o.llmProvider !== undefined) {
    if (!isLlmProvider(o.llmProvider)) return null
    llmProvider = o.llmProvider
  }
  const llmModel = o.llmModel === undefined ? undefined : field(o.llmModel, 200)
  const llmBackgroundModel = o.llmBackgroundModel === undefined ? undefined : field(o.llmBackgroundModel, 200)
  const llmBaseUrl = o.llmBaseUrl === undefined ? undefined : field(o.llmBaseUrl, 300)
  if (llmModel === null || llmBackgroundModel === null || llmBaseUrl === null) return null
  if (llmBaseUrl && !/^https?:\/\/[^\s]+$/.test(llmBaseUrl)) return null
  return { ownerName, voiceId, llmKey, voiceKey, voiceProvider, azureRegion, llmProvider, llmModel, llmBaseUrl, llmBackgroundModel }
}

// ── main ⇄ runtime host messages ────────────────────────────

export type HostRequest =
  | { type: 'init'; env: Record<string, string>; cwd: string; away?: 'lock' | 'suspend' | 'idle' | undefined }
  | { type: 'send'; replyId: string; text: string }
  | { type: 'voice'; replyId: string; audio: Uint8Array; mime: string }
  | { type: 'set-speech'; enabled: boolean }
  | { type: 'stop' }
  /** Barge-in: like stop, for a reply the owner talked over. */
  | { type: 'interrupt' }
  | { type: 'set-mode'; mode: UiMode }
  | { type: 'list-tasks'; requestId: string }
  /** Encrypted backups: a consistent database snapshot written to `path`. */
  | { type: 'backup-db'; requestId: string; path: string }
  | { type: 'list-today'; requestId: string }
  | { type: 'store-secrets'; requestId: string; llmKey: string; llmProvider: LlmProviderId; voiceKey: string; voiceProvider: VoiceProviderChoice }
  /** Setup: the models a provider offers this key (a typed key, else the stored one). */
  | { type: 'list-models'; requestId: string; provider: LlmProviderId; apiKey: string; baseUrl: string }
  /** Monthly AI budget in US dollars (0 = no limit), and the owner's price for a model (null removes it). */
  | { type: 'set-budget'; usd: number }
  | { type: 'set-price'; model: string; price: { input: number; output: number; cacheRead?: number | undefined } | null }
  | { type: 'approval-answer'; id: string; approved: boolean }
  | { type: 'session'; change: SessionChange }
  | { type: 'initiative-action'; id: string; action: InitiativeAction }
  | { type: 'shutdown' }
  /** Headlines for the assistant's news tool (untrusted feed text). */
  | { type: 'news-snapshot'; headlines: { title: string; source: string; category: string; publishedAt: number | null; summary: string }[] }
  /** Code projects: the latest scan and running servers, pushed by main after every change. */
  | { type: 'code-snapshot'; projects: CodeProjectView[]; running: RunView[] }
  | { type: 'code-result'; requestId: string; result?: string | undefined; error?: string | undefined }
  /** Answer to a file tool's request. */
  | { type: 'files-result'; requestId: string; result?: string | undefined; error?: string | undefined }
  | ControlHostRequest
  | PersonalityHostRequest
  | ActivityHostRequest
  | ProjectsHostRequest
  | LearningHostRequest

export type HostEvent =
  | { type: 'status'; phase: RuntimePhase; problems: SetupProblem[]; warnings: string[]; keys?: { llm: boolean; voice: boolean }; voiceReady?: boolean }
  | ReplyEvent
  | { type: 'tasks'; requestId: string; tasks: TaskView[] }
  | { type: 'backup-db'; requestId: string; error?: string }
  | { type: 'today'; requestId: string; lines: DayLine[] }
  | { type: 'secrets-stored'; requestId: string; error?: string | undefined }
  | { type: 'models'; requestId: string; models?: string[] | undefined; error?: string | undefined }
  /** The cost meter's totals, after LLM calls and on start. */
  | { type: 'usage'; summary: UsageView }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-closed'; id: string }
  | { type: 'action'; notice: ActionNotice }
  /** The current held-back list; a 'notify' item also gets a Windows notification. */
  | { type: 'later'; items: InitiativeItem[]; notify?: InitiativeItem }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  /** A code-project tool asks main to start, stop, read logs or update a status file. */
  | { type: 'code'; requestId: string; op: CodeOp }
  /** VS Code minutes per project today, from window tracking. */
  | { type: 'code-minutes'; minutes: Record<string, number> }
  /** A file tool asks main to list, search, read, move, organise, recycle or undo inside the chosen folders. */
  | { type: 'files'; requestId: string; op: FileOp }
  | ControlHostEvent
  | PersonalityHostEvent
  | ActivityHostEvent
  | ProjectsHostEvent
  | LearningHostEvent
