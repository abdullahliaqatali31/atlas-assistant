/**
 * Starts the runtime host in an Electron utility process and keeps it alive:
 * an unexpected exit restarts it with backoff and ends any in-flight reply
 * with an error, so the renderer never waits forever.
 */
import { randomUUID } from 'node:crypto'

import { utilityProcess, type UtilityProcess } from 'electron'

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
  DayLine,
  UiMode,
  VoiceProviderChoice,
} from '../shared/ipc.ts'
import type { ActivityEntry, ControlHostEvent, ControlHostRequest } from '../shared/control.ts'
import type { PersonalityHostEvent, PersonalityHostRequest } from '../shared/personality.ts'
import type { ActivityHostEvent, ActivityHostRequest } from '../shared/activity.ts'
import type { LearningHostEvent, LearningHostRequest } from '../shared/learning.ts'
import type { ProjectsHostEvent, ProjectsHostRequest } from '../shared/projects.ts'

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
  /** Learning screen answers and "something new was learned" pushes. */
  onLearning?: (e: LearningHostEvent) => void
  /** Code-project requests from the model's tools, and measured VS Code minutes. */
  onCode?: (e: Extract<HostEvent, { type: 'code' | 'code-minutes' }>) => void
}

const STABLE_MS = 60_000
const MAX_BACKOFF_MS = 30_000

export class RuntimeSupervisor {
  private child: UtilityProcess | null = null
  private stopping = false
  private backoff = 1_000
  private startedAt = 0
  private restartTimer: NodeJS.Timeout | null = null
  private mode: UiMode = 'companion'
  private speech = true
  private activeReply: string | null = null
  private readonly taskRequests = new Map<string, (t: TaskView[]) => void>()
  private readonly todayRequests = new Map<string, (l: DayLine[]) => void>()
  private readonly secretRequests = new Map<string, (error?: string) => void>()
  private readonly actionRequests = new Map<string, (entries: ActivityEntry[]) => void>()
  private readonly backupRequests = new Map<string, (error?: string) => void>()

  constructor(private readonly deps: SupervisorDeps) {}

  start() {
    this.stopping = false
    const child = utilityProcess.fork(this.deps.entry, [], { serviceName: 'Assistant runtime', stdio: 'pipe' })
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
      child.postMessage({ type: 'shutdown' } satisfies HostRequest)
    })
  }

  send(text: string): string {
    const replyId = randomUUID()
    this.activeReply = replyId
    this.post({ type: 'send', replyId, text })
    return replyId
  }

  sendVoice(audio: Uint8Array, mime: string): string {
    const replyId = randomUUID()
    this.activeReply = replyId
    this.post({ type: 'voice', replyId, audio, mime })
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
  storeSecrets(llmKey: string, voiceKey: string, voiceProvider: VoiceProviderChoice): Promise<string | undefined> {
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
      this.post({ type: 'store-secrets', requestId, llmKey, voiceKey, voiceProvider })
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
  /** Code-project snapshots and tool answers. */
  code(msg: Extract<HostRequest, { type: 'code-snapshot' | 'code-result' }>): boolean {
    if (!this.child) return false
    this.post(msg)
    return true
  }

  data(msg: ActivityHostRequest | ProjectsHostRequest | LearningHostRequest): boolean {
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
    this.child?.postMessage(msg)
  }

  private handle(e: HostEvent) {
    switch (e.type) {
      case 'status':
        // The host starts in companion mode with speech on; re-apply the owner's choices after (re)starts.
        if (e.phase === 'ready') {
          if (this.mode !== 'companion') this.post({ type: 'set-mode', mode: this.mode })
          this.post({ type: 'set-speech', enabled: this.speech })
        }
        this.deps.onStatus(e)
        break
      case 'chunk':
      case 'done':
      case 'heard':
      case 'audio':
      case 'speech-error':
      case 'initiative':
        // A reply the assistant started on its own is in flight too.
        if (e.type === 'initiative') this.activeReply = e.replyId
        if (e.type === 'done' && this.activeReply === e.replyId) this.activeReply = null
        this.deps.onReply(e)
        break
      case 'today':
        this.todayRequests.get(e.requestId)?.(e.lines)
        this.todayRequests.delete(e.requestId)
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
      case 'learning':
      case 'learning-changed':
        this.deps.onLearning?.(e)
        break
      case 'code':
      case 'code-minutes':
        this.deps.onCode?.(e)
        break
      case 'log':
        this.deps.log(e.level, e.message)
    }
  }

  private exited(child: UtilityProcess, code: number) {
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
