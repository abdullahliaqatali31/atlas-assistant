/**
 * Contract for Projects (plan sections 7 and 15): projects with their tasks
 * and commitments. Data and IPC only; the runtime host owns the database and
 * applies every change through the memory store, whose task state machine
 * still refuses completion without evidence.
 */

export const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const TASK_STATUSES = ['proposed', 'ready', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export interface ProjectSummary {
  id: string
  name: string
  goals: string
  state: string
  status: ProjectStatus
  createdAt: number
  updatedAt: number
  openTasks: number
  openCommitments: number
}

export interface ProjectTaskView {
  id: string
  title: string
  status: TaskStatus
  dueAt: number | null
  /** What showed it was done, for completed tasks. */
  evidence: string | null
}

export interface ProjectCommitmentView {
  id: string
  /** Who promised ("Hamza", "client"). */
  who: string
  what: string
  toWhom: string
  dueAt: number | null
  /** Where it was recorded: "owner" (typed in the app or said), or a connector. */
  source: string
  resolvedAt: number | null
  resolution: string | null
}

export interface ProjectDetailView extends Omit<ProjectSummary, 'openTasks' | 'openCommitments'> {
  tasks: ProjectTaskView[]
  commitments: ProjectCommitmentView[]
}

export interface ProjectInput {
  name: string
  goals?: string | undefined
  state?: string | undefined
}

export interface ProjectPatch {
  name?: string | undefined
  goals?: string | undefined
  state?: string | undefined
  status?: ProjectStatus | undefined
}

export interface TaskInput {
  title: string
  /** Epoch ms; null or absent for no due time. */
  dueAt?: number | null | undefined
}

export interface CommitmentInput {
  what: string
  toWhom: string
  /** Defaults to the owner. */
  who?: string | undefined
  dueAt?: number | null | undefined
}

/** Channel names for `window.projects`. */
export const PJ = {
  list: 'projects:list',
  get: 'projects:get',
  create: 'projects:create',
  update: 'projects:update',
  addTask: 'projects:add-task',
  assignTask: 'projects:assign-task',
  setTaskStatus: 'projects:set-task-status',
  addCommitment: 'projects:add-commitment',
  assignCommitment: 'projects:assign-commitment',
  resolveCommitment: 'projects:resolve-commitment',
  changed: 'projects:changed',
} as const

export interface ProjectsBridge {
  /** Active and paused first; archived only with includeArchived. Null while the runtime is not ready. */
  list(includeArchived?: boolean): Promise<ProjectSummary[] | null>
  get(id: string): Promise<ProjectDetailView | null>
  create(input: ProjectInput): Promise<ProjectDetailView>
  update(id: string, patch: ProjectPatch): Promise<ProjectDetailView>
  addTask(projectId: string, input: TaskInput): Promise<ProjectDetailView>
  /** Moves an existing task into a project, or out of it with null. Returns the target project, or null. */
  assignTask(taskId: string, projectId: string | null): Promise<ProjectDetailView | null>
  /** Follows the task state machine; 'completed' needs evidence ("client confirmed by email"). */
  setTaskStatus(taskId: string, status: TaskStatus, evidence?: string): Promise<ProjectDetailView | null>
  addCommitment(projectId: string, input: CommitmentInput): Promise<ProjectDetailView>
  assignCommitment(commitmentId: string, projectId: string | null): Promise<ProjectDetailView | null>
  /** Resolving needs a short note on how it was settled. */
  resolveCommitment(commitmentId: string, resolution: string): Promise<ProjectDetailView | null>
  /** A project changed (here or through the assistant's tools); carries its id. */
  onChanged(cb: (projectId: string) => void): () => void
}

// ── validation (main process side) ──────────────────────────

export type ProjectOp =
  | { kind: 'list'; includeArchived: boolean }
  | { kind: 'get'; id: string }
  | { kind: 'create'; input: ProjectInput }
  | { kind: 'update'; id: string; patch: ProjectPatch }
  | { kind: 'add-task'; projectId: string; input: TaskInput }
  | { kind: 'assign-task'; taskId: string; projectId: string | null }
  | { kind: 'set-task-status'; taskId: string; status: TaskStatus; evidence?: string | undefined }
  | { kind: 'add-commitment'; projectId: string; input: CommitmentInput }
  | { kind: 'assign-commitment'; commitmentId: string; projectId: string | null }
  | { kind: 'resolve-commitment'; commitmentId: string; resolution: string }

const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{8,64}$/i.test(v)
const text = (v: unknown, max: number, required = false): string | undefined | null => {
  if (v === undefined && !required) return undefined
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (t.length > max || (required && !t)) return null
  return t
}
const due = (v: unknown): number | null | undefined | false => {
  if (v === undefined || v === null) return v as null | undefined
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? v : false
}

/** Turns a renderer call into a checked op, or an error message. */
export const parseProjectOp = (channel: string, a: unknown, b: unknown, c?: unknown): ProjectOp | string => {
  const obj = (v: unknown) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
  switch (channel) {
    case PJ.list:
      return { kind: 'list', includeArchived: a === true }
    case PJ.get:
      return isId(a) ? { kind: 'get', id: a } : 'No such project.'
    case PJ.create: {
      const o = obj(a)
      const name = text(o?.name, 120, true)
      const goals = text(o?.goals, 2_000)
      const state = text(o?.state, 2_000)
      if (!o || !name || goals === null || state === null) return 'A project needs a name under 120 characters; goals and state under 2000.'
      return { kind: 'create', input: { name, goals, state } }
    }
    case PJ.update: {
      const o = obj(b)
      if (!isId(a) || !o) return 'No such project.'
      const name = text(o.name, 120)
      const goals = text(o.goals, 2_000)
      const state = text(o.state, 2_000)
      const status = o.status
      if (name === null || name === '' || goals === null || state === null) return 'Invalid project values.'
      if (status !== undefined && !(PROJECT_STATUSES as readonly unknown[]).includes(status)) return 'Unknown project status.'
      return { kind: 'update', id: a, patch: { name, goals, state, status: status as ProjectStatus | undefined } }
    }
    case PJ.addTask: {
      const o = obj(b)
      const title = text(o?.title, 300, true)
      const dueAt = due(o?.dueAt)
      if (!isId(a) || !o || !title || dueAt === false) return 'A task needs a title under 300 characters and an optional due time.'
      return { kind: 'add-task', projectId: a, input: { title, dueAt } }
    }
    case PJ.assignTask:
      return isId(a) && (b === null || isId(b)) ? { kind: 'assign-task', taskId: a, projectId: b } : 'No such task or project.'
    case PJ.setTaskStatus: {
      const evidence = text(c, 1_000)
      if (!isId(a) || !(TASK_STATUSES as readonly unknown[]).includes(b) || evidence === null) return 'Invalid task status.'
      return { kind: 'set-task-status', taskId: a, status: b as TaskStatus, evidence }
    }
    case PJ.addCommitment: {
      const o = obj(b)
      const what = text(o?.what, 500, true)
      const toWhom = text(o?.toWhom, 120, true)
      const who = text(o?.who, 120)
      const dueAt = due(o?.dueAt)
      if (!isId(a) || !o || !what || !toWhom || who === null || dueAt === false) return 'A commitment needs what was promised and to whom.'
      return { kind: 'add-commitment', projectId: a, input: { what, toWhom, who, dueAt } }
    }
    case PJ.assignCommitment:
      return isId(a) && (b === null || isId(b)) ? { kind: 'assign-commitment', commitmentId: a, projectId: b } : 'No such commitment or project.'
    case PJ.resolveCommitment: {
      const resolution = text(b, 500, true)
      return isId(a) && resolution ? { kind: 'resolve-commitment', commitmentId: a, resolution } : 'Resolving needs a short note.'
    }
    default:
      return 'Unknown projects call.'
  }
}

// ── main ⇄ runtime host messages ────────────────────────────

export type ProjectsHostRequest = { type: 'projects'; requestId: string; op: ProjectOp }

export type ProjectsHostEvent =
  | { type: 'projects'; requestId: string; result?: unknown; error?: string | undefined }
  /** A project changed, whoever changed it. */
  | { type: 'project-changed'; projectId: string }
