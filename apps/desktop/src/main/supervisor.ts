/**
 * Starts the runtime host in an Electron utility process and keeps it alive:
 * an unexpected exit restarts it with backoff and ends any in-flight reply
 * with an error, so the renderer never waits forever.
 */
import { randomUUID } from 'node:crypto'
import type { PcNotification } from '../shared/notifications.ts'
import type { HabitsForAtlas } from '../shared/habits.ts'

import type { LlmProviderId } from '@assistant/providers/llm-presets'
import type { SpeakerResult } from '../shared/speaker.ts'
import type { QuickAction } from '../shared/quick.ts'
import { fork, type ChildProcess } from 'node:child_process'

import type {
  ActionNotice,
  ApprovalRequest,
  HostEvent,
  HostRequest,
  InitiativeAction,
  InitiativeItem,
  ReplyEvent,
  RuntimePhase,
  SessionChange,
  SetupProblem,
  TaskView,
  ChatsOp,
  DayLine,
  UiMode,
  VoiceProviderChoice,
  UsageView, ChatModelChoice } from '../shared/ipc.ts'
import type { ActivityEntry, ControlHostEvent, ControlHostRequest } from '../shared/control.ts'
import type { PersonalityHostEvent, PersonalityHostRequest } from '../shared/personality.ts'
import type { ActivityHostEvent, ActivityHostRequest } from '../shared/activity.ts'
import type { LearningHostEvent, LearningHostRequest } from '../shared/learning.ts'
import type { ProjectsHostEvent, ProjectsHostRequest } from '../shared/projects.ts'
import type { BrainHostEvent, BrainHostRequest } from '../shared/brain.ts'

export interface SupervisorDeps {
  entry: string
  /** Fresh environment for each start, so a setup change takes effect on restart. */
  env: () => Record<string, string>
  cwd: string
  /** Also fires with phase restarting/stopped when the host exits; pending approvals die with it. */
  onStatus: (s: { phase: RuntimePhase; problems: SetupProblem[]; warnings: string[]; keys?: { llm: boolean; voice: boolean }; voiceReady?: boolean }) => void
  onReply: (e: ReplyEvent) => void
  onApproval: (request: ApprovalRequest) => void
  onApprovalClosed: (id: string) => void
  onAction: (notice: ActionNotice) => void
  /** The held-back initiative list changed; `notify` is a new item for a system notification. */
  onLater: (items: InitiativeItem[], notify?: InitiativeItem) => void
  /** Whether the owner is away right now, so a (re)started runtime never speaks to a locked screen. */
  away: () => 'lock' | 'suspend' | 'idle' | undefined
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  /** Owner rules, pause state, app list and activity settings, sent before init on every (re)start. */
  controlInit?: () => HostRequest[]
  onControl?: (e: ControlHostEvent) => void
  onPersonality?: (e: PersonalityHostEvent) => void
  /** Answers for the Activity and Projects screens, and project-changed notices. */
  onData?: (e: ActivityHostEvent | ProjectsHostEvent) => void
  onBrain?: (e: BrainHostEvent) => void
  /** Learning screen answers and "something new was learned" pushes. */
  onLearning?: (e: LearningHostEvent) => void
  /** The cost meter's totals. */
  onUsage?: (u: UsageView) => void
  /** Code-project requests from the model's tools, and measured VS Code minutes. */
  onCode?: (e: Extract<HostEvent, { type: 'code' | 'code-minutes' }>) => void
  onFiles?: (e: Extract<HostEvent, { type: 'files' }>) => void
  onDesktop?: (e: Extract<HostEvent, { type: 'desktop' }>) => void
  onUi?: (e: Extract<HostEvent, { type: 'ui' }>) => void
  onWorld?: (e: Extract<HostEvent, { type: 'world' | 'world-result' }>) => void
  onSkillsChanged?: () => void
  onQuick?: (action: QuickAction) => void
}

const STABLE_MS = 60_000
const MAX_BACKOFF_MS = 30_000

export class RuntimeSupervisor {
  private child: ChildProcess | null = null
  private stopping = false
  private backoff = 1_000
  private startedAt = 0
  private restartTimer: NodeJS.Timeout | null = null
  private mode: UiMode = 'companion'
  private chatChoice: ChatModelChoice = { kind: 'auto' }
  private speech = true
  private lastNews: Extract<HostRequest, { type: 'news-snapshot' }>['headlines'] = []
  private lastUi: Extract<HostRequest, { type: 'ui-snapshot' }>['state'] | null = null
  private activeReply: string | null = null
  private readonly taskRequests = new Map<string, (t: TaskView[]) => void>()
  private readonly todayRequests = new Map<string, (l: DayLine[]) => void>()
  private readonly chatRequests = new Map<string, (r: { result?: unknown; error?: string | undefined }) => void>()
  private readonly secretRequests = new Map<string, (error?: string) => void>()
  private readonly actionRequests = new Map<string, (entries: ActivityEntry[]) => void>()
  private readonly backupRequests = new Map<string, (error?: string) => void>()
  private readonly modelRequests = new Map<string, (models?: string[], error?: string) => void>()

  constructor(private readonly deps: SupervisorDeps) {}

  start() {
    this.stopping = false
    // Its own Node process; structured messages, so recorded voice and spoken audio cross as bytes.
    const child = fork(this.deps.entry, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
      execArgv: ['--disable-warning=ExperimentalWarning'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
    })
    this.child = child
    this.startedAt = Date.now()
    child.stdout?.on('data', (b: Buffer) => this.deps.log('info', b.toString().trimEnd()))
    child.stderr?.on('data', (b: Buffer) => this.deps.log('warn', b.toString().trimEnd()))
    child.on('message', (e: HostEvent) => this.handle(e))
    child.on('exit', code => this.exited(child, code))
    for (const msg of this.deps.controlInit?.() ?? []) this.post(msg)
    this.post({ type: 'init', env: this.deps.env(), cwd: this.deps.cwd, away: this.deps.away() })
  }

  /** Stop and start again, e.g. after setup saved new keys. */
  async restart() {
    await this.stop()
    this.start()
  }

  async stop() {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const child = this.child
    if (!child) return
    await new Promise<void>(resolve => {
      const kill = setTimeout(() => child.kill(), 3_000)
      child.once('exit', () => {
        clearTimeout(kill)
        resolve()
      })
      child.send({ type: 'shutdown' } satisfies HostRequest)
    })
  }

  send(text: string): string {
    const replyId = randomUUID()
    this.activeReply = replyId
    this.post({ type: 'send', replyId, text })
    return replyId
  }

  sendVoice(audio: Uint8Array, mime: string, speaker?: SpeakerResult): string {
    const replyId = randomUUID()
    this.activeReply = replyId
    this.post({ type: 'voice', replyId, audio, mime, speaker })
    return replyId
  }

  setSpeech(enabled: boolean) {
    this.speech = enabled
    this.post({ type: 'set-speech', enabled })
  }

  stopReply() {
    this.post({ type: 'stop' })
  }

  /** Barge-in: cancel the reply in flight, its TTS and its queued audio. */
  interrupt() {
    this.post({ type: 'interrupt' })
  }

  /** The reply streaming right now (typed, spoken or the assistant's own), if any. */
  get currentReply(): string | null {
    return this.activeReply
  }

  session(change: SessionChange) {
    this.post({ type: 'session', change })
  }

  initiativeAction(id: string, action: InitiativeAction) {
    this.post({ type: 'initiative-action', id, action })
  }

  answerApproval(id: string, approved: boolean) {
    this.post({ type: 'approval-answer', id, approved })
  }

  /** The chat's model pick; re-sent to a restarted runtime. */
  setChatModel(choice: ChatModelChoice) {
    this.chatChoice = choice
    this.post({ type: 'set-chat-model', choice })
  }

  setMode(mode: UiMode) {
    this.mode = mode
    this.post({ type: 'set-mode', mode })
  }

  get currentMode() {
    return this.mode
  }

  listToday(): Promise<DayLine[]> {
    if (!this.child) return Promise.resolve([])
    const requestId = randomUUID()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.todayRequests.delete(requestId)
        resolve([])
      }, 5_000)
      this.todayRequests.set(requestId, lines => {
        clearTimeout(timer)
        resolve(lines)
      })
      this.post({ type: 'list-today', requestId })
    })
  }

  /** The chat list and its actions, answered by the runtime (which owns the conversations). */
  chats(op: ChatsOp): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error('The assistant is not running.'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.chatRequests.delete(requestId)
        reject(new Error('The assistant did not answer in time.'))
      }, 10_000)
      this.chatRequests.set(requestId, r => {
        clearTimeout(timer)
        if (r.error) reject(new Error(r.error))
        else resolve(r.result)
      })
      this.post({ type: 'chats', requestId, op })
    })
  }

  /** Asks the runtime, which owns the database, for a consistent snapshot at `path`. */
  backupDb(path: string): Promise<void> {
    if (!this.child) return Promise.reject(new Error('The assistant is not running.'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.backupRequests.delete(requestId)
        reject(new Error('The database snapshot took too long.'))
      }, 60_000)
      this.backupRequests.set(requestId, error => {
        clearTimeout(timer)
        if (error) reject(new Error(error))
        else resolve()
      })
      this.post({ type: 'backup-db', requestId, path })
    })
  }

  listTasks(): Promise<TaskView[]> {
    if (!this.child) return Promise.resolve([])
    const requestId = randomUUID()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.taskRequests.delete(requestId)
        resolve([])
      }, 5_000)
      this.taskRequests.set(requestId, tasks => {
        clearTimeout(timer)
        resolve(tasks)
      })
      this.post({ type: 'list-tasks', requestId })
    })
  }

  /** Hand keys to the host, which writes them to the OS credential store. Resolves with an error message, if any. */
  storeSecrets(llmKey: string, llmProvider: LlmProviderId, voiceKey: string, voiceProvider: VoiceProviderChoice): Promise<string | undefined> {
    if (!llmKey && !voiceKey) return Promise.resolve(undefined)
    if (!this.child) return Promise.resolve('The runtime is not running; try again in a moment.')
    const requestId = randomUUID()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.secretRequests.delete(requestId)
        resolve('Storing keys timed out.')
      }, 10_000)
      this.secretRequests.set(requestId, error => {
        clearTimeout(timer)
        resolve(error)
      })
      this.post({ type: 'store-secrets', requestId, llmKey, llmProvider, voiceKey, voiceProvider })
    })
  }

  /** Budget and prices go to the runtime, which owns the database. */
  usageSetting(msg: Extract<HostRequest, { type: 'set-budget' | 'set-price' }>) {
    if (!this.child) throw new Error('The assistant is not running.')
    this.post(msg)
  }

  /** Setup: models a provider offers, asked of the runtime, which can read stored keys. */
  listModels(provider: LlmProviderId, apiKey: string, baseUrl: string): Promise<string[]> {
    if (!this.child) return Promise.reject(new Error('The runtime is not running; try again in a moment.'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.modelRequests.delete(requestId)
        reject(new Error('The provider did not answer in time.'))
      }, 25_000)
      this.modelRequests.set(requestId, (models, error) => {
        clearTimeout(timer)
        if (error) reject(new Error(error))
        else resolve(models ?? [])
      })
      this.post({ type: 'list-models', requestId, provider, apiKey, baseUrl })
    })
  }

  /** Rules, pause, MCP reload and app results; dropped when the host is down (it gets `controlInit` on start). */
  /** Profile ops, onboarding speech and the welcome reply. False when the host is down. */
  personality(msg: PersonalityHostRequest): boolean {
    if (!this.child) return false
    if (msg.type === 'welcome' || msg.type === 'speak-prompt') this.activeReply = msg.replyId
    this.post(msg)
    return true
  }

  control(msg: ControlHostRequest) {
    this.post(msg)
  }

  /** Activity and Projects requests. False when the host is down. */
  /** Latest headlines for the assistant's news tool. */
  news(headlines: Extract<HostRequest, { type: 'news-snapshot' }>['headlines']) {
    this.lastNews = headlines
    if (this.child) this.post({ type: 'news-snapshot', headlines })
  }

  /** Code-project snapshots and tool answers. */
  code(msg: Extract<HostRequest, { type: 'code-snapshot' | 'code-result' }>): boolean {
    if (!this.child) return false
    this.post(msg)
    return true
  }

  /** The PC's state, kept for a restarted runtime too. */
  private lastSystem: Extract<HostRequest, { type: 'system-snapshot' }> | null = null
  system(snapshot: Extract<HostRequest, { type: 'system-snapshot' }>['snapshot'], changes: Extract<HostRequest, { type: 'system-snapshot' }>['changes']) {
    this.lastSystem = { type: 'system-snapshot', snapshot, changes: [] }
    if (this.child) this.post({ type: 'system-snapshot', snapshot, changes })
  }

  /** Recent Windows notifications, kept (as background) for a restarted runtime too. */
  private lastNotifications: PcNotification[] = []
  notifications(items: PcNotification[], fresh: boolean) {
    this.lastNotifications = [...this.lastNotifications, ...items].slice(-60)
    if (this.child) this.post({ type: 'notifications', items, fresh })
  }

  /** Browser habits, kept for a restarted runtime too. */
  /** How the machines are, kept for a restarted runtime too. */
  private lastMachines: string | null = null
  machines(text: string | null) {
    this.lastMachines = text
    if (this.child) this.post({ type: 'machines', text })
  }

  private lastHabits: HabitsForAtlas | null = null
  habits(data: HabitsForAtlas | null) {
    this.lastHabits = data
    if (this.child) this.post({ type: 'habits-snapshot', data })
  }

  /** Atlas's own window, kept for a restarted runtime too. */
  ui(state: Extract<HostRequest, { type: 'ui-snapshot' }>['state']) {
    this.lastUi = state
    if (this.child) this.post({ type: 'ui-snapshot', state })
  }

  /** World page requests. */
  world(msg: Extract<HostRequest, { type: 'world-op' }>): boolean {
    if (!this.child) return false
    this.post(msg)
    return true
  }

  /** File, desktop-app and window tool answers. */
  files(msg: Extract<HostRequest, { type: 'files-result' | 'desktop-result' | 'ui-result' }>): boolean {
    if (!this.child) return false
    this.post(msg)
    return true
  }

  data(msg: ActivityHostRequest | ProjectsHostRequest | LearningHostRequest | BrainHostRequest): boolean {
    if (!this.child) return false
    this.post(msg)
    return true
  }

  listActions(): Promise<ActivityEntry[]> {
    if (!this.child) return Promise.resolve([])
    const requestId = randomUUID()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.actionRequests.delete(requestId)
        resolve([])
      }, 5_000)
      this.actionRequests.set(requestId, entries => {
        clearTimeout(timer)
        resolve(entries)
      })
      this.post({ type: 'list-actions', requestId })
    })
  }

  private post(msg: HostRequest) {
    if (this.child?.connected) this.child.send(msg)
  }

  private handle(e: HostEvent) {
    switch (e.type) {
      case 'status':
        // The host starts in companion mode with speech on; re-apply the owner's choices after (re)starts.
        if (e.phase === 'ready') {
          if (this.mode !== 'companion') this.post({ type: 'set-mode', mode: this.mode })
          if (this.chatChoice.kind !== 'auto') this.post({ type: 'set-chat-model', choice: this.chatChoice })
          this.post({ type: 'set-speech', enabled: this.speech })
          if (this.lastNews.length) this.post({ type: 'news-snapshot', headlines: this.lastNews })
          if (this.lastUi) this.post({ type: 'ui-snapshot', state: this.lastUi })
          if (this.lastSystem) this.post(this.lastSystem)
          if (this.lastHabits) this.post({ type: 'habits-snapshot', data: this.lastHabits })
          if (this.lastMachines) this.post({ type: 'machines', text: this.lastMachines })
          if (this.lastNotifications.length) this.post({ type: 'notifications', items: this.lastNotifications, fresh: false })
        }
        this.deps.onStatus(e)
        break
      case 'chunk':
      case 'done':
      case 'heard':
      case 'audio':
      case 'speech-error':
      case 'initiative':
      case 'suggestions':
        // A reply the assistant started on its own is in flight too.
        if (e.type === 'initiative') this.activeReply = e.replyId
        if (e.type === 'done' && this.activeReply === e.replyId) this.activeReply = null
        this.deps.onReply(e)
        break
      case 'today':
        this.todayRequests.get(e.requestId)?.(e.lines)
        this.todayRequests.delete(e.requestId)
        break
      case 'chats-result':
        this.chatRequests.get(e.requestId)?.({ result: e.result, error: e.error })
        this.chatRequests.delete(e.requestId)
        break
      case 'usage':
        this.deps.onUsage?.(e.summary)
        break
      case 'models':
        this.modelRequests.get(e.requestId)?.(e.models, e.error)
        this.modelRequests.delete(e.requestId)
        break
      case 'backup-db':
        this.backupRequests.get(e.requestId)?.(e.error)
        this.backupRequests.delete(e.requestId)
        break
      case 'tasks':
        this.taskRequests.get(e.requestId)?.(e.tasks)
        this.taskRequests.delete(e.requestId)
        break
      case 'approval':
        this.deps.onApproval(e.request)
        break
      case 'approval-closed':
        this.deps.onApprovalClosed(e.id)
        break
      case 'action':
        this.deps.onAction(e.notice)
        break
      case 'later':
        this.deps.onLater(e.items, e.notify)
        break
      case 'secrets-stored':
        this.secretRequests.get(e.requestId)?.(e.error)
        this.secretRequests.delete(e.requestId)
        break
      case 'actions':
        this.actionRequests.get(e.requestId)?.(e.entries)
        this.actionRequests.delete(e.requestId)
        break
      case 'personality':
      case 'transcript':
        this.deps.onPersonality?.(e)
        break
      case 'capabilities':
      case 'open-app':
        this.deps.onControl?.(e)
        break
      case 'activity':
      case 'projects':
      case 'project-changed':
        this.deps.onData?.(e)
        break
      case 'brain':
      case 'memory-used':
        this.deps.onBrain?.(e)
        break
      case 'learning':
      case 'learning-changed':
        this.deps.onLearning?.(e)
        break
      case 'code':
      case 'code-minutes':
        this.deps.onCode?.(e)
        break
      case 'files':
        this.deps.onFiles?.(e)
        break
      case 'desktop':
        this.deps.onDesktop?.(e)
        break
      case 'ui':
        this.deps.onUi?.(e)
        break
      case 'world':
      case 'world-result':
        this.deps.onWorld?.(e)
        break
      case 'skills-changed':
        this.deps.onSkillsChanged?.()
        break
      case 'quick':
        this.deps.onQuick?.(e.action)
        break
      case 'log':
        this.deps.log(e.level, e.message)
    }
  }

  private exited(child: ChildProcess, code: number | null) {
    if (this.child !== child) return
    this.child = null
    if (this.activeReply) {
      this.deps.onReply({ type: 'done', replyId: this.activeReply, stopped: false, error: 'The runtime stopped unexpectedly; restarting it.' })
      this.activeReply = null
    }
    if (this.stopping) {
      this.deps.onStatus({ phase: 'stopped', problems: [], warnings: [] })
      return
    }
    if (Date.now() - this.startedAt > STABLE_MS) this.backoff = 1_000
    this.deps.log('error', `Runtime exited with code ${code}; restarting in ${this.backoff} ms.`)
    this.deps.onStatus({ phase: 'restarting', problems: [], warnings: [] })
    this.restartTimer = setTimeout(() => this.start(), this.backoff)
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
  }
}
