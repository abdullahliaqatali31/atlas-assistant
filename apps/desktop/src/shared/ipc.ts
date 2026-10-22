/**
 * The whole contract between the sandboxed renderer and the main process.
 * Everything here is plain data: no keys ever travel main → renderer, only
 * whether each one is present.
 */

import type { SpeakerResult } from './speaker.ts'
import type { QuickAction } from './quick.ts'
import { isLlmProvider, type LlmProviderId } from '@assistant/providers/llm-presets'
import type { PcNotification } from './notifications.ts'
import type { HabitsForAtlas } from './habits.ts'

import type { ActivityHostEvent, ActivityHostRequest } from './activity.ts'
import type { CodeOp, CodeProjectView, RunView } from './code.ts'
import type { DesktopOp } from './desktop.ts'
import type { FileOp } from './files.ts'
import type { LiveSession, LiveTier, LiveVoiceSettings } from './livevoice.ts'
import type { SystemChange, SystemSnapshot } from './system.ts'
import type { UiOp, UiState } from './ui.ts'
import type { WorldOp, WorldSnapshot } from './world.ts'
import type { ControlHostEvent, ControlHostRequest } from './control.ts'
import type { PersonalityHostEvent, PersonalityHostRequest } from './personality.ts'
import type { LearningHostEvent, LearningHostRequest } from './learning.ts'
import type { ProjectsHostEvent, ProjectsHostRequest } from './projects.ts'
import type { BrainHostEvent, BrainHostRequest } from './brain.ts'

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
  speech: { available: boolean; enabled: boolean; live: { available: boolean; enabled: boolean; tier: LiveTier; voice: string; capUsd: number } }
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
  /** The question as Atlas asks it in the conversation ("Hamza, kya main … parh loon?"). */
  question?: string | undefined
}

/** Tool progress for the activity view, as reported by the runtime. */
export interface ActionNotice {
  tool: string
  status: 'running' | 'done' | 'denied' | 'declined' | 'failed'
  detail?: string | undefined
}

/** Voice providers setup offers. Azure's free F0 tier has real Pakistani Urdu voices. */
/** The chat's model pick (the model chip): routing, or one model from any provider with a key. */
export type ChatModelChoice = { kind: 'auto' } | { kind: 'main' } | { kind: 'quick' } | { kind: 'model'; provider: LlmProviderId; model: string }

export const parseChatModelChoice = (v: unknown): ChatModelChoice | null => {
  const o = v as Partial<{ kind: string; provider: unknown; model: unknown }> | null
  if (!o || typeof o !== 'object') return null
  if (o.kind === 'auto' || o.kind === 'main' || o.kind === 'quick') return { kind: o.kind }
  if (o.kind === 'model' && isLlmProvider(o.provider) && typeof o.model === 'string' && /^[\w.:/@-]{1,120}$/.test(o.model)) return { kind: 'model', provider: o.provider, model: o.model }
  return null
}

export const VOICE_PROVIDERS = ['elevenlabs', 'azure', 'openai'] as const
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
  openai: {
    label: 'ChatGPT (OpenAI)',
    voiceLabel: 'OpenAI voice',
    needsRegion: false,
    suggestedVoices: ['marin', 'cedar', 'coral', 'sage', 'shimmer', 'nova', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'onyx', 'verse'],
    note: 'Uses your OpenAI key, the same one as Live voice: about $0.015 a minute of speech. No other voice service needed.',
  },
}

/** What setup already has. Keys are reported as present/absent only. */
export interface StartupView {
  /** Only the installed app can register itself. */
  available: boolean
  enabled: boolean
  /** At login, open the window (true) or start quietly in the tray. */
  show: boolean
}

/** What the cost meter shows (same shape as the runtime's usage summary). */
export interface UsageView {
  today: { tokens: number; usd: number; calls: number }
  month: { tokens: number; usd: number; calls: number }
  byModel: { model: string; purpose: string; input: number; output: number; cached: number; cacheWrite: number; calls: number; usd: number | null }[]
  /** Today: the share of input served from the prompt cache (0-1). */
  cacheShare: number
  /** The newest calls, newest first: tokens as billed, cost, and what the request was made of (estimated tokens per part). */
  recent: { id: number; at: number; model: string; purpose: string; input: number; output: number; cached: number; cacheWrite: number; usd: number | null; parts: Record<string, number> }[]
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
  /** The quick model for short, simple messages (empty: the provider's default). */
  llmQuickModel: string
  /** 'auto' sends simple messages to the quick model; 'main' always uses the main model. */
  llmRouting: 'auto' | 'main'
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
  llmQuickModel?: string | undefined
  llmRouting?: 'auto' | 'main' | undefined
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

/** One past or current conversation in the chat list. */
export interface ChatSummary {
  id: string
  title: string
  startedAt: number
  lastAt: number
  messages: number
  /** The conversation new messages go to. */
  current: boolean
}

/** The chat list's requests: list, read one, start a new one, continue an earlier one. */
export type ChatsOp = { kind: 'list' } | { kind: 'read'; id: string } | { kind: 'new' } | { kind: 'resume'; id: string }

export const parseChatsOp = (v: unknown): ChatsOp | null => {
  const o = v as { kind?: unknown; id?: unknown } | null
  if (!o || typeof o !== 'object') return null
  if (o.kind === 'list' || o.kind === 'new') return { kind: o.kind }
  if ((o.kind === 'read' || o.kind === 'resume') && typeof o.id === 'string' && /^[\w-]{1,64}$/.test(o.id)) return { kind: o.kind, id: o.id }
  return null
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
  /** After a reply: short things the owner might say next (buttons in the chat and the widget). */
  | { replyId: string; type: 'suggestions'; text: string; options: string[]; /** The topic looks finished: stop listening, offer nothing. */ ended: boolean }

/** Channel names, shared so main and preload cannot drift apart. */
export const CH = {
  status: 'assistant:status',
  statusChanged: 'assistant:status-changed',
  send: 'assistant:send',
  stop: 'assistant:stop',
  setMode: 'assistant:set-mode',
  listTasks: 'assistant:list-tasks',
  listToday: 'assistant:list-today',
  chats: 'assistant:chats',
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
  quietHours: 'assistant:quiet-hours',
  setQuietHours: 'assistant:set-quiet-hours',
  speakLimits: 'assistant:speak-limits',
  setSpeakLimits: 'assistant:set-speak-limits',
  setPrice: 'assistant:set-price',
  reply: 'assistant:reply',
  action: 'assistant:action',
  initiativeAction: 'assistant:initiative-action',
  ready: 'assistant:ready',
  silence: 'assistant:silence',
  interrupt: 'assistant:interrupt',
  chatModel: 'assistant:chat-model',
  setChatModel: 'assistant:set-chat-model',
  liveSession: 'assistant:live-session',
  setLiveVoice: 'assistant:set-live-voice',
} as const

/** The API the preload exposes as `window.assistant`. */
export interface AssistantBridge {
  status(): Promise<RuntimeStatus>
  send(text: string): Promise<{ replyId: string }>
  /** A recorded utterance (webm/opus); the reply arrives like a typed one, after a 'heard' event. */
  /** pcm: the same speech as 16 kHz mono samples (bytes), for Voice ID; optional. */
  sendVoice(audio: Uint8Array, mime: string, pcm?: Uint8Array): Promise<{ replyId: string }>
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
  /** The chat list: earlier conversations, newest first. */
  listChats(): Promise<ChatSummary[]>
  readChat(id: string): Promise<DayLine[]>
  /** Starts a new conversation; the current one stays in the list. */
  newChat(): Promise<{ id: string }>
  /** Continues an earlier conversation; returns its messages. */
  resumeChat(id: string): Promise<DayLine[]>
  saveSetup(input: SetupInput): Promise<RuntimeStatus>
  /** Models the chosen provider offers; uses the typed key, or the stored one when blank. */
  listModels(provider: LlmProviderId, apiKey: string, baseUrl: string): Promise<string[]>
  /** The cost meter: today, this month, per model, and the monthly budget. Null until the runtime reports. */
  usage(): Promise<UsageView | null>
  onUsage(cb: (u: UsageView) => void): () => void
  setBudget(usd: number): Promise<void>
  /** When Atlas keeps its own initiatives to itself (timers still ring): "22:00-07:00", or null for never. */
  quietHours(): Promise<string | null>
  setQuietHours(range: string | null): Promise<string | null>
  /** Routine speak-ups: at most this many a day, at least this many minutes apart. */
  speakLimits(): Promise<{ perDay: number; gapMin: number }>
  setSpeakLimits(perDay: number, gapMin: number): Promise<{ perDay: number; gapMin: number }>
  /** Start with Windows (installed app only), in the tray. */
  startup(): Promise<StartupView>
  setStartup(on: boolean, show?: boolean): Promise<StartupView>
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
  /** The chat model chip: what is picked now, and pick another (applies from the next message). */
  chatModel(): Promise<{ choice: ChatModelChoice; provider: LlmProviderId; main: string; quick: string }>
  setChatModel(choice: ChatModelChoice): Promise<{ choice: ChatModelChoice; provider: LlmProviderId; main: string; quick: string }>
  /** Live voice: a short-lived session minted by main (the key never comes here). */
  liveSession(assistantName: string): Promise<LiveSession>
  setLiveVoice(settings: LiveVoiceSettings): Promise<void>
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
  const llmQuickModel = o.llmQuickModel === undefined ? undefined : field(o.llmQuickModel, 200)
  if (o.llmRouting !== undefined && o.llmRouting !== 'auto' && o.llmRouting !== 'main') return null
  const llmRouting = o.llmRouting as 'auto' | 'main' | undefined
  const llmBaseUrl = o.llmBaseUrl === undefined ? undefined : field(o.llmBaseUrl, 300)
  if (llmModel === null || llmBackgroundModel === null || llmQuickModel === null || llmBaseUrl === null) return null
  if (llmBaseUrl && !/^https?:\/\/[^\s]+$/.test(llmBaseUrl)) return null
  return { ownerName, voiceId, llmKey, voiceKey, voiceProvider, azureRegion, llmProvider, llmModel, llmBaseUrl, llmBackgroundModel, llmQuickModel, llmRouting }
}

// ── main ⇄ runtime host messages ────────────────────────────

export type HostRequest =
  | { type: 'init'; env: Record<string, string>; cwd: string; away?: 'lock' | 'suspend' | 'idle' | undefined }
  | { type: 'send'; replyId: string; text: string }
  | { type: 'voice'; replyId: string; audio: Uint8Array; mime: string; speaker?: SpeakerResult | undefined }
  | { type: 'set-speech'; enabled: boolean }
  | { type: 'stop' }
  /** Barge-in: like stop, for a reply the owner talked over. */
  | { type: 'interrupt' }
  | { type: 'set-mode'; mode: UiMode }
  | { type: 'list-tasks'; requestId: string }
  /** Encrypted backups: a consistent database snapshot written to `path`. */
  | { type: 'backup-db'; requestId: string; path: string }
  | { type: 'list-today'; requestId: string }
  | { type: 'chats'; requestId: string; op: ChatsOp }
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
  | { type: 'news-snapshot'; headlines: { title: string; source: string; category: string; publishedAt: number | null; summary: string; link?: string | undefined }[] }
  /** Code projects: the latest scan and running servers, pushed by main after every change. */
  | { type: 'code-snapshot'; projects: CodeProjectView[]; running: RunView[] }
  | { type: 'code-result'; requestId: string; result?: string | undefined; error?: string | undefined }
  /** Answer to a file tool's request. */
  | { type: 'files-result'; requestId: string; result?: string | undefined; error?: string | undefined }
  /** The World page asks the runtime to add or remove a place, or refresh. */
  | { type: 'world-op'; requestId: string; op: WorldOp }
  /** Atlas's own window, pushed by main whenever it changes. */
  | { type: 'ui-snapshot'; state: UiState }
  /** The owner switched the chat's model (the model chip). */
  | { type: 'set-chat-model'; choice: ChatModelChoice }
  /** The PC's Wi-Fi, Bluetooth and battery, pushed by main with what changed. */
  | { type: 'system-snapshot'; snapshot: SystemSnapshot; changes: SystemChange[] }
  /** Windows notifications main read (once the owner turned them on); fresh ones may be spoken. */
  | { type: 'notifications'; items: PcNotification[]; fresh: boolean }
  /** Browser profiles and habits (shared profiles only), or null when off. */
  | { type: 'habits-snapshot'; data: HabitsForAtlas | null }
  /** Answer to a window tool's request. */
  | { type: 'ui-result'; requestId: string; result?: string | undefined; error?: string | undefined }
  /** Answer to a desktop-app tool's request. */
  | { type: 'desktop-result'; requestId: string; result?: string | undefined; error?: string | undefined }
  | ControlHostRequest
  | PersonalityHostRequest
  | ActivityHostRequest
  | ProjectsHostRequest
  | BrainHostRequest
  | LearningHostRequest

export type HostEvent =
  | { type: 'status'; phase: RuntimePhase; problems: SetupProblem[]; warnings: string[]; keys?: { llm: boolean; voice: boolean }; voiceReady?: boolean }
  | ReplyEvent
  | { type: 'tasks'; requestId: string; tasks: TaskView[] }
  | { type: 'backup-db'; requestId: string; error?: string }
  | { type: 'today'; requestId: string; lines: DayLine[] }
  | { type: 'chats-result'; requestId: string; result?: ChatSummary[] | DayLine[] | { id: string } | undefined; error?: string | undefined }
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
  /** An instant command (no model): the gateway carries it out (stop, mode, pause, volume). */
  | { type: 'quick'; action: QuickAction }
  /** Atlas installed, wrote or removed a SKILL.md skill. */
  | { type: 'skills-changed' }
  /** The latest live-world snapshot, for the World page. */
  | { type: 'world'; snapshot: WorldSnapshot }
  /** Answer to a World page request. */
  | { type: 'world-result'; requestId: string; error?: string | undefined }
  /** A window tool asks main to describe or change Atlas's own window. */
  | { type: 'ui'; requestId: string; op: UiOp }
  /** A desktop-app tool asks main to open, read or control one of the owner's chosen apps. */
  | { type: 'desktop'; requestId: string; op: DesktopOp }
  | ControlHostEvent
  | PersonalityHostEvent
  | ActivityHostEvent
  | ProjectsHostEvent
  | BrainHostEvent
  | LearningHostEvent
