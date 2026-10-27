/**
 * Memory and task store. SQLite (Node's built-in `node:sqlite`, no native
 * build step) is the authoritative record; FTS5 provides retrieval. Embeddings
 * can be added later as a rebuildable index, never as the source of truth.
 */
import { DatabaseSync } from 'node:sqlite'

import {
  coerceProfile,
  DEFAULT_PROFILE,
  newId,
  sameProfile,
  type Clock,
  type Id,
  type PersonalityProfile,
  type SourceRef,
} from '@assistant/shared'

const MIGRATIONS: string[] = [
  `CREATE TABLE owner (
     id TEXT PRIMARY KEY, display_name TEXT NOT NULL, timezone TEXT NOT NULL,
     languages TEXT NOT NULL, preferences TEXT NOT NULL DEFAULT '{}');
   CREATE TABLE project (
     id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, goals TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
   CREATE TABLE message (
     id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, speaker TEXT NOT NULL,
     content TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE memory (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, statement TEXT NOT NULL,
     source TEXT NOT NULL, confidence REAL NOT NULL, sensitivity TEXT NOT NULL DEFAULT 'normal',
     project_id TEXT REFERENCES project(id), superseded_by TEXT REFERENCES memory(id),
     valid_until INTEGER, created_at INTEGER NOT NULL);
   CREATE VIRTUAL TABLE memory_fts USING fts5(statement, content='memory', content_rowid='rowid');
   CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
     INSERT INTO memory_fts(rowid, statement) VALUES (new.rowid, new.statement); END;
   CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
     INSERT INTO memory_fts(memory_fts, rowid, statement) VALUES ('delete', old.rowid, old.statement); END;
   CREATE TABLE task (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT REFERENCES project(id),
     due_at INTEGER, status TEXT NOT NULL, evidence TEXT, created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL);
   CREATE TABLE task_history (
     task_id TEXT NOT NULL REFERENCES task(id), from_status TEXT, to_status TEXT NOT NULL,
     note TEXT, at INTEGER NOT NULL);
   CREATE TABLE commitment (
     id TEXT PRIMARY KEY, who TEXT NOT NULL, what TEXT NOT NULL, to_whom TEXT NOT NULL,
     due_at INTEGER, source TEXT NOT NULL, resolved_at INTEGER, resolution TEXT);
   CREATE TABLE action_log (
     id TEXT PRIMARY KEY, tool TEXT NOT NULL, summary TEXT NOT NULL, decision TEXT NOT NULL,
     rule_id TEXT, result TEXT, evidence TEXT, at INTEGER NOT NULL);
   CREATE TABLE initiative_log (
     dedup_key TEXT PRIMARY KEY, channel TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);`,
  // Append-only personality history. based_on is the version this one was
  // derived from (0 = defaults, NULL = nothing to undo to), so repeated undo
  // walks back through the owner's changes instead of toggling.
  `CREATE TABLE personality_version (
     version INTEGER PRIMARY KEY, profile TEXT NOT NULL, reason TEXT NOT NULL,
     based_on INTEGER, created_at INTEGER NOT NULL);
   CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // Opt-in active-window tracking (plan 13.2): foreground app and title spans only, kept seven days.
  `CREATE TABLE window_activity (
     id INTEGER PRIMARY KEY, app TEXT NOT NULL, title TEXT NOT NULL,
     started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL);
   CREATE INDEX window_activity_started ON window_activity(started_at);`,
  // Projects get a lifecycle; commitments can belong to one.
  `ALTER TABLE project ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
   ALTER TABLE project ADD COLUMN updated_at INTEGER;
   UPDATE project SET updated_at = created_at;
   ALTER TABLE commitment ADD COLUMN project_id TEXT REFERENCES project(id);
   CREATE INDEX task_project ON task(project_id);
   CREATE INDEX commitment_project ON commitment(project_id);`,
  // Learning (plan section 8): proposals the owner reviews, style hints the
  // personality adapter counts, and accepted declarative workflows.
  `CREATE TABLE proposal (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL,
     evidence TEXT NOT NULL, status TEXT NOT NULL, dedup_key TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL, decided_at INTEGER);
   CREATE TABLE style_signal (
     id INTEGER PRIMARY KEY, field TEXT NOT NULL, value TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE workflow (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, steps TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL);
   CREATE INDEX message_created ON message(created_at);`,
  // Curiosity: things the owner mentioned that are worth asking about once they have happened.
  `CREATE TABLE followup (
     id TEXT PRIMARY KEY, about TEXT NOT NULL, quote TEXT NOT NULL, due_at INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'open', dedup_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
   CREATE INDEX followup_due ON followup(status, due_at);`,
  // Skills: tasks the owner taught, in plain steps the assistant follows with its own judgement.
  `CREATE TABLE skill (
     id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, goal TEXT NOT NULL, steps TEXT NOT NULL,
     inputs TEXT NOT NULL, check_text TEXT NOT NULL, approve TEXT NOT NULL, schedule TEXT, when_text TEXT,
     auto INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE skill_run (
     id TEXT PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE, trigger TEXT NOT NULL,
     started_at INTEGER NOT NULL, ended_at INTEGER, ok INTEGER, summary TEXT);
   CREATE INDEX skill_run_skill ON skill_run(skill_id, started_at);`,
  // LLM usage per owner-local day, model and purpose, for the cost meter and budget.
  `CREATE TABLE llm_usage (
     day TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL,
     input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cached INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, model, purpose));`,
  // Prompt-cache writes in the daily totals, and the last calls one by one with what each request was made of.
  `ALTER TABLE llm_usage ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE llm_call (
     id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL,
     input INTEGER NOT NULL, output INTEGER NOT NULL, cached INTEGER NOT NULL, cache_write INTEGER NOT NULL,
     parts TEXT NOT NULL);
   CREATE INDEX llm_call_at ON llm_call(at);`,
  // Conversations as sessions: a title, a rolling summary of the older part, and when it was last used.
  `CREATE TABLE conversation (
     id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
     title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', summarized_through INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX conversation_last ON conversation(last_at);
   CREATE INDEX message_conversation ON message(conversation_id, created_at);
   INSERT INTO conversation (id, started_at, last_at, title)
     SELECT m.conversation_id, MIN(m.created_at), MAX(m.created_at),
       COALESCE((SELECT substr(o.content, 1, 60) FROM message o WHERE o.conversation_id = m.conversation_id AND o.speaker = 'owner' ORDER BY o.created_at LIMIT 1), '')
     FROM message m GROUP BY m.conversation_id;`,
  // The brain: connections between memories (made when one is saved, strengthened when they are used
  // together), and how often and when each memory was last used in a turn.
  `CREATE TABLE memory_link (
     a TEXT NOT NULL, b TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0,
     last_at INTEGER NOT NULL, PRIMARY KEY (a, b));
   ALTER TABLE memory ADD COLUMN uses INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE memory ADD COLUMN last_used INTEGER;`,
  // Recall by meaning: one vector per memory from a local embedding model (named, so a new model re-indexes).
  `CREATE TABLE memory_vec (
     memory_id TEXT PRIMARY KEY, model TEXT NOT NULL, vec BLOB NOT NULL);`,
]

/** A conversation (session): a run of messages without a long pause. */
export interface Conversation {
  id: Id
  startedAt: number
  lastAt: number
  title: string
  /** A short summary of the part older than the verbatim window, if one was written. */
  summary: string
  /** The time of the last message the summary covers (0: none). */
  summarizedThrough: number
  messages: number
}

const toConversation = (r: Record<string, unknown>): Conversation => ({
  id: String(r.id),
  startedAt: Number(r.started_at),
  lastAt: Number(r.last_at),
  title: String(r.title ?? ''),
  summary: String(r.summary ?? ''),
  summarizedThrough: Number(r.summarized_through ?? 0),
  messages: Number(r.n ?? 0),
})

/** One LLM call: tokens as billed, and an estimate of what the request was made of (tokens per part). */
export interface CallRow {
  id: number
  at: number
  model: string
  purpose: string
  input: number
  output: number
  cached: number
  cacheWrite: number
  parts: Record<string, number>
}

export interface UsageRow {
  day: string
  model: string
  purpose: string
  input: number
  output: number
  cached: number
  /** Tokens written to the prompt cache. */
  cache_write: number
  calls: number
}

/** When a skill runs by itself: at a time on some weekdays, or once. */
export type SkillSchedule = { kind: 'daily'; minute: number; days: number[] } | { kind: 'once'; at: number }

export interface Skill {
  id: Id
  name: string
  /** What it achieves, in one sentence. */
  goal: string
  /** Plain-language steps, followed with judgement, not replayed blindly. */
  steps: string[]
  /** What changes each run, e.g. "client name". */
  inputs: string[]
  /** How to tell it worked. */
  check: string
  /** Steps that always need the owner's yes (sending, deleting, paying…). */
  approve: string
  schedule: SkillSchedule | null
  /** A situation in which to offer it ("a new email from a client arrives"). */
  when: string | null
  /** Run on schedule without asking first. */
  auto: boolean
  status: 'active' | 'paused'
  createdAt: number
  updatedAt: number
}

export interface SkillRun {
  id: Id
  skillId: Id
  trigger: string
  startedAt: number
  endedAt: number | null
  ok: boolean | null
  summary: string | null
}

export interface Followup {
  id: Id
  /** What happened or will happen, in a few words ("client meeting with Ahmed"). */
  about: string
  /** The owner's own words it came from. */
  quote: string
  /** When it is worth asking about. */
  dueAt: number
  status: 'open' | 'done'
  createdAt: number
}

/** Raw window observations older than this are deleted. */
export const WINDOW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export interface WindowSpan {
  app: string
  title: string
  startedAt: number
  endedAt: number
}

export const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export interface Project {
  id: Id
  name: string
  goals: string
  /** Free-text current state ("waiting on client sign-off"). */
  state: string
  status: ProjectStatus
  createdAt: number
  updatedAt: number
}

export interface ProjectDetail extends Project {
  /** Every task of the project, open first, then by due time. */
  tasks: Task[]
  /** Unresolved commitments first. */
  commitments: (Commitment & { resolvedAt: number | null; resolution: string | null })[]
}

export interface PersonalityState {
  profile: PersonalityProfile
  /** 0 until the owner changes anything. */
  version: number
  canUndo: boolean
  updatedAt: number | null
}

export interface PersonalityVersion {
  version: number
  profile: PersonalityProfile
  reason: string
  at: number
}

export interface PersonalityExport {
  format: 'assistant-personality/1'
  exportedAt: string
  current: PersonalityProfile
  history: { version: number; reason: string; at: string; profile: PersonalityProfile }[]
}

const MAX_REASON_CHARS = 200

export type TaskStatus = 'proposed' | 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  proposed: ['ready', 'cancelled'],
  ready: ['running', 'waiting', 'cancelled', 'completed'],
  running: ['waiting', 'completed', 'failed', 'cancelled'],
  waiting: ['ready', 'running', 'cancelled', 'completed'],
  completed: ['ready'],
  failed: ['ready', 'cancelled'],
  cancelled: ['ready'],
}

export type MemoryKind = 'fact' | 'preference' | 'observation' | 'hypothesis' | 'lesson'

export interface MemoryRecord {
  id: Id
  kind: MemoryKind
  statement: string
  source: SourceRef
  confidence: number
  projectId: Id | null
  createdAt: number
}

export interface Task {
  id: Id
  title: string
  projectId: Id | null
  dueAt: number | null
  status: TaskStatus
  evidence: string | null
}

export class MemoryStore {
  readonly db: DatabaseSync

  constructor(
    path: string,
    private readonly clock: Clock,
  ) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  private migrate() {
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[v]!)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    }
  }

  /** A consistent copy of the whole database at `path` (for backups), safe while in use. */
  backupTo(path: string) {
    this.db.prepare('VACUUM INTO ?').run(path)
  }

  close() {
    this.db.close()
  }

  // ── projects ──────────────────────────────────────────────

  upsertProject(name: string, goals = ''): Id {
    const existing = this.db.prepare('SELECT id FROM project WHERE name = ?').get(name) as { id: string } | undefined
    if (existing) return existing.id
    const id = newId()
    const now = this.clock.now()
    this.db.prepare('INSERT INTO project (id, name, goals, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, goals, now, now)
    return id
  }

  /** A new project; names are unique (case-insensitive) so "Quote" and "quote" cannot both exist. */
  createProject(input: { name: string; goals?: string; state?: string }): Project {
    const name = input.name.trim()
    if (!name) throw new Error('A project needs a name')
    if (this.db.prepare('SELECT 1 FROM project WHERE lower(name) = lower(?)').get(name)) throw new Error(`A project named "${name}" already exists`)
    const id = newId()
    const now = this.clock.now()
    this.db
      .prepare('INSERT INTO project (id, name, goals, state, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, input.goals ?? '', input.state ?? '', 'active', now, now)
    return this.getProject(id)!
  }

  updateProject(id: Id, patch: { name?: string; goals?: string; state?: string; status?: ProjectStatus }): Project {
    const current = this.getProject(id)
    if (!current) throw new Error(`No project ${id}`)
    const name = patch.name?.trim() ?? current.name
    if (!name) throw new Error('A project needs a name')
    if (name.toLowerCase() !== current.name.toLowerCase() && this.db.prepare('SELECT 1 FROM project WHERE lower(name) = lower(?)').get(name)) {
      throw new Error(`A project named "${name}" already exists`)
    }
    if (patch.status !== undefined && !(PROJECT_STATUSES as readonly string[]).includes(patch.status)) throw new Error(`Unknown status ${patch.status}`)
    this.db
      .prepare('UPDATE project SET name = ?, goals = ?, state = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(name, patch.goals ?? current.goals, patch.state ?? current.state, patch.status ?? current.status, this.clock.now(), id)
    return this.getProject(id)!
  }

  getProject(id: Id): Project | undefined {
    const row = this.db.prepare('SELECT * FROM project WHERE id = ?').get(id)
    return row ? toProject(row) : undefined
  }

  /** Active and paused first, then by most recent change. Archived only when asked for. */
  listProjects(opts: { includeArchived?: boolean } = {}): (Project & { openTasks: number; openCommitments: number })[] {
    const rows = this.db
      .prepare(
        `SELECT p.*,
           (SELECT COUNT(*) FROM task t WHERE t.project_id = p.id AND t.status IN ('proposed','ready','running','waiting','failed')) AS open_tasks,
           (SELECT COUNT(*) FROM commitment c WHERE c.project_id = p.id AND c.resolved_at IS NULL) AS open_commitments
         FROM project p ${opts.includeArchived ? '' : `WHERE p.status != 'archived'`}
         ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, p.updated_at DESC`,
      )
      .all() as Record<string, unknown>[]
    return rows.map(r => ({ ...toProject(r), openTasks: Number(r.open_tasks), openCommitments: Number(r.open_commitments) }))
  }

  projectDetail(id: Id): ProjectDetail | undefined {
    const project = this.getProject(id)
    if (!project) return undefined
    const tasks = this.db
      .prepare(
        `SELECT * FROM task WHERE project_id = ?
         ORDER BY status IN ('completed','cancelled'), due_at IS NULL, due_at, created_at`,
      )
      .all(id)
      .map(toTask)
    const commitments = (this.db.prepare('SELECT * FROM commitment WHERE project_id = ? ORDER BY resolved_at IS NOT NULL, due_at IS NULL, due_at').all(id) as Record<string, unknown>[]).map(
      r => ({ ...toCommitment(r), resolvedAt: (r.resolved_at as number | null) ?? null, resolution: (r.resolution as string | null) ?? null }),
    )
    return { ...project, tasks, commitments }
  }

  /** Moves a task into a project (or out of every project with null). */
  setTaskProject(taskId: Id, projectId: Id | null) {
    if (!this.getTask(taskId)) throw new Error(`No task ${taskId}`)
    if (projectId !== null && !this.getProject(projectId)) throw new Error(`No project ${projectId}`)
    this.db.prepare('UPDATE task SET project_id = ?, updated_at = ? WHERE id = ?').run(projectId, this.clock.now(), taskId)
    if (projectId) this.touchProject(projectId)
  }

  setCommitmentProject(commitmentId: Id, projectId: Id | null) {
    if (projectId !== null && !this.getProject(projectId)) throw new Error(`No project ${projectId}`)
    const r = this.db.prepare('UPDATE commitment SET project_id = ? WHERE id = ?').run(projectId, commitmentId)
    if (Number(r.changes) === 0) throw new Error(`No commitment ${commitmentId}`)
    if (projectId) this.touchProject(projectId)
  }

  private touchProject(id: Id) {
    this.db.prepare('UPDATE project SET updated_at = ? WHERE id = ?').run(this.clock.now(), id)
  }

  // ── window activity (opt-in, plan 13.2) ───────────────────

  /** One foreground-window span. Zero-length spans are ignored. */
  recordWindowSpan(span: WindowSpan) {
    if (span.endedAt <= span.startedAt) return
    this.db
      .prepare('INSERT INTO window_activity (app, title, started_at, ended_at) VALUES (?, ?, ?, ?)')
      .run(span.app, span.title, span.startedAt, span.endedAt)
  }

  /** Spans overlapping [since, until), oldest first. */
  windowActivity(since: number, until = this.clock.now()): WindowSpan[] {
    return (this.db
      .prepare('SELECT app, title, started_at, ended_at FROM window_activity WHERE ended_at > ? AND started_at < ? ORDER BY started_at')
      .all(since, until) as { app: string; title: string; started_at: number; ended_at: number }[]).map(r => ({
      app: r.app,
      title: r.title,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }))
  }

  /** Deletes raw observations past retention; returns how many went. */
  purgeWindowActivity(olderThanMs = WINDOW_RETENTION_MS): number {
    return Number(this.db.prepare('DELETE FROM window_activity WHERE ended_at < ?').run(this.clock.now() - olderThanMs).changes)
  }

  /** Owner's "forget my activity": everything, or one app's records. */
  clearWindowActivity(app?: string): number {
    const r = app === undefined ? this.db.prepare('DELETE FROM window_activity').run() : this.db.prepare('DELETE FROM window_activity WHERE lower(app) = lower(?)').run(app)
    return Number(r.changes)
  }

  // ── memory ────────────────────────────────────────────────

  remember(input: { kind: MemoryKind; statement: string; source: SourceRef; confidence?: number; projectId?: Id }): Id {
    const id = newId()
    this.db
      .prepare(
        `INSERT INTO memory (id, kind, statement, source, confidence, project_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.kind, input.statement, JSON.stringify(input.source), input.confidence ?? 1, input.projectId ?? null, this.clock.now())
    this.linkNew(id, input.statement)
    return id
  }

  /** A new memory joins the three it is closest to in meaning (shared distinctive words). */
  private linkNew(id: Id, statement: string) {
    const words = statement
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(w => w.length > 3 && !STOP.has(w))
    if (!words.length) return
    try {
      for (const m of this.recall(words.join(' '), 4).filter(m => m.id !== id).slice(0, 3)) this.link(id, m.id, 0.6)
    } catch {
      // No neighbours yet: it stands alone until it is used.
    }
  }

  private link(x: Id, y: Id, weight: number) {
    if (x === y) return
    const [a, b] = x < y ? [x, y] : [y, x]
    this.db
      .prepare(`INSERT INTO memory_link (a, b, weight, uses, last_at) VALUES (?, ?, ?, 0, ?)
               ON CONFLICT(a, b) DO UPDATE SET weight = MIN(weight + excluded.weight, 12), last_at = excluded.last_at`)
      .run(a, b, weight, this.clock.now())
  }

  /**
   * Memories used together in one turn: each counts a use, and every pair
   * among them is linked a little more strongly (the brain's paths grow).
   */
  noteUse(ids: readonly Id[]) {
    const unique = [...new Set(ids)].slice(0, 12)
    const now = this.clock.now()
    const use = this.db.prepare('UPDATE memory SET uses = uses + 1, last_used = ? WHERE id = ?')
    for (const id of unique) use.run(now, id)
    for (let i = 0; i < unique.length; i++)
      for (let j = i + 1; j < unique.length; j++) {
        this.link(unique[i]!, unique[j]!, 1)
        const [a, b] = unique[i]! < unique[j]! ? [unique[i]!, unique[j]!] : [unique[j]!, unique[i]!]
        this.db.prepare('UPDATE memory_link SET uses = uses + 1 WHERE a = ? AND b = ?').run(a, b)
      }
  }

  /** Everything the brain view draws: the live memories with their use, and the links among them. */
  brain(limit = 600): { memories: (MemoryRecord & { uses: number; lastUsed: number | null })[]; links: { a: Id; b: Id; weight: number; uses: number }[] } {
    // Memories from before the brain had links: join each to its neighbours, once.
    const none = !(this.db.prepare('SELECT 1 FROM memory_link LIMIT 1').get())
    if (none) for (const r of this.db.prepare('SELECT id, statement FROM memory WHERE superseded_by IS NULL').all() as { id: Id; statement: string }[]) this.linkNew(r.id, r.statement)
    const rows = this.db.prepare('SELECT * FROM memory WHERE superseded_by IS NULL ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]
    const memories = rows.map(r => ({ ...toMemory(r), uses: (r.uses as number | null) ?? 0, lastUsed: (r.last_used as number | null) ?? null }))
    const ids = new Set(memories.map(m => m.id))
    const links = (this.db.prepare('SELECT a, b, weight, uses FROM memory_link ORDER BY weight DESC LIMIT 4000').all() as { a: Id; b: Id; weight: number; uses: number }[]).filter(l => ids.has(l.a) && ids.has(l.b))
    return { memories, links }
  }

  /** A correction supersedes the old fact; the original stays as evidence history. */
  correct(oldId: Id, statement: string, source: SourceRef): Id {
    const old = this.db.prepare('SELECT kind, project_id FROM memory WHERE id = ?').get(oldId) as
      | { kind: MemoryKind; project_id: string | null }
      | undefined
    if (!old) throw new Error(`No memory ${oldId}`)
    const id = this.remember({ kind: old.kind, statement, source, projectId: old.project_id ?? undefined })
    this.db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(id, oldId)
    return id
  }

  /**
   * Hard delete: the memory and every earlier version it replaced (a forgotten
   * correction must not bring back the old fact), with their FTS entries, plus
   * any pending suggestion built on it. Returns how many rows went.
   */
  forget(id: Id): number {
    const chain = new Set<Id>([id])
    for (let frontier = [id]; frontier.length; ) {
      const older = frontier.flatMap(f => (this.db.prepare('SELECT id FROM memory WHERE superseded_by = ?').all(f) as { id: Id }[]).map(r => r.id))
      frontier = older.filter(o => !chain.has(o))
      for (const o of frontier) chain.add(o)
    }
    const statements = [...chain].flatMap(c => {
      const row = this.db.prepare('SELECT statement FROM memory WHERE id = ?').get(c) as { statement: string } | undefined
      return row ? [row.statement] : []
    })
    // Oldest first: each older version points at its replacement.
    for (const c of [...chain].reverse()) {
      this.db.prepare('DELETE FROM memory WHERE id = ?').run(c)
      this.db.prepare('DELETE FROM memory_vec WHERE memory_id = ?').run(c)
    }
    for (const s of statements) this.db.prepare(`DELETE FROM proposal WHERE status = 'pending' AND title = ?`).run(s)
    return chain.size
  }

  /** A memory by full id or by the 8-character short id tools show. */
  findMemory(idOrShort: string): MemoryRecord | undefined {
    const row = this.db.prepare('SELECT * FROM memory WHERE superseded_by IS NULL AND (id = ? OR substr(id, 1, 8) = ?) LIMIT 2').all(idOrShort, idOrShort)
    return row.length === 1 ? toMemory(row[0]) : undefined
  }

  /** Current (non-superseded, unexpired) memories matching the query. */
  recall(query: string, limit = 8): MemoryRecord[] {
    const terms = query
      .split(/[^\p{L}\p{N}]+/u)
      .filter(t => t.length > 1)
      .map(t => `"${t}"*`)
      .join(' OR ')
    if (!terms) return []
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memory_fts f JOIN memory m ON m.rowid = f.rowid
         WHERE memory_fts MATCH ? AND m.superseded_by IS NULL
           AND (m.valid_until IS NULL OR m.valid_until > ?)
         ORDER BY bm25(memory_fts), m.created_at DESC LIMIT ?`,
      )
      .all(terms, this.clock.now(), limit)
    return rows.map(toMemory)
  }

  // ── vectors (recall by meaning) ──────────────────────────

  setVector(id: Id, model: string, vec: Float32Array) {
    this.db.prepare('INSERT INTO memory_vec (memory_id, model, vec) VALUES (?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, vec = excluded.vec').run(id, model, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength))
  }

  /** Current memories without a vector from this model yet (oldest first), to index a few at a time. */
  unindexed(model: string, limit = 32): { id: Id; statement: string }[] {
    return this.db
      .prepare(
        `SELECT m.id, m.statement FROM memory m LEFT JOIN memory_vec v ON v.memory_id = m.id AND v.model = ?
         WHERE m.superseded_by IS NULL AND v.memory_id IS NULL ORDER BY m.created_at LIMIT ?`,
      )
      .all(model, limit) as { id: Id; statement: string }[]
  }

  /** Every current memory's vector from this model. */
  vectors(model: string): { id: Id; vec: Float32Array }[] {
    const rows = this.db
      .prepare(
        `SELECT v.memory_id AS id, v.vec AS vec FROM memory_vec v JOIN memory m ON m.id = v.memory_id
         WHERE v.model = ? AND m.superseded_by IS NULL AND (m.valid_until IS NULL OR m.valid_until > ?)`,
      )
      .all(model, this.clock.now()) as { id: Id; vec: Uint8Array }[]
    return rows.map(r => ({ id: r.id, vec: new Float32Array(Uint8Array.from(r.vec).buffer) }))
  }

  /** Memories by id, in the order asked (missing ones skipped). */
  memoriesByIds(ids: readonly Id[]): MemoryRecord[] {
    const get = this.db.prepare('SELECT * FROM memory WHERE id = ? AND superseded_by IS NULL')
    return ids.flatMap(id => {
      const r = get.get(id)
      return r ? [toMemory(r)] : []
    })
  }

  /** How often and how lately each memory was used, and its strongest neighbours (the brain's links). */
  memoryUse(id: Id): { uses: number; lastUsed: number | null; createdAt: number } | null {
    const r = this.db.prepare('SELECT uses, last_used, created_at FROM memory WHERE id = ?').get(id) as { uses: number; last_used: number | null; created_at: number } | undefined
    return r ? { uses: r.uses, lastUsed: r.last_used, createdAt: r.created_at } : null
  }

  neighbours(id: Id, limit = 3): { id: Id; weight: number }[] {
    return this.db
      .prepare('SELECT CASE WHEN a = ? THEN b ELSE a END AS id, weight FROM memory_link WHERE a = ? OR b = ? ORDER BY weight DESC LIMIT ?')
      .all(id, id, id, limit) as { id: Id; weight: number }[]
  }

  /** Every current memory, oldest first (the Markdown mirror). */
  allMemories(): MemoryRecord[] {
    return this.db.prepare('SELECT * FROM memory WHERE superseded_by IS NULL ORDER BY created_at').all().map(toMemory)
  }

  recent(limit = 10): MemoryRecord[] {
    return this.db
      .prepare('SELECT * FROM memory WHERE superseded_by IS NULL ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map(toMemory)
  }

  // ── tasks ─────────────────────────────────────────────────

  addTask(title: string, opts: { projectId?: Id; dueAt?: number; status?: TaskStatus } = {}): Id {
    const id = newId()
    const now = this.clock.now()
    const status = opts.status ?? 'ready'
    this.db
      .prepare('INSERT INTO task (id, title, project_id, due_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, title, opts.projectId ?? null, opts.dueAt ?? null, status, now, now)
    this.db.prepare('INSERT INTO task_history (task_id, from_status, to_status, at) VALUES (?, NULL, ?, ?)').run(id, status, now)
    return id
  }

  /** Moves a task; completion requires evidence so progress is never invented. */
  transition(id: Id, to: TaskStatus, opts: { evidence?: string; note?: string } = {}) {
    const task = this.getTask(id)
    if (!task) throw new Error(`No task ${id}`)
    if (!TRANSITIONS[task.status].includes(to)) {
      throw new Error(`Task cannot go from ${task.status} to ${to}`)
    }
    if (to === 'completed' && !opts.evidence?.trim()) {
      throw new Error('Completing a task requires evidence')
    }
    const now = this.clock.now()
    this.db
      .prepare('UPDATE task SET status = ?, evidence = COALESCE(?, evidence), updated_at = ? WHERE id = ?')
      .run(to, opts.evidence ?? null, now, id)
    this.db
      .prepare('INSERT INTO task_history (task_id, from_status, to_status, note, at) VALUES (?, ?, ?, ?, ?)')
      .run(id, task.status, to, opts.note ?? null, now)
  }

  /** New due time (null clears it); recorded in the task's history. */
  reschedule(id: Id, dueAt: number | null, note?: string) {
    const task = this.getTask(id)
    if (!task) throw new Error(`No task ${id}`)
    const now = this.clock.now()
    this.db.prepare('UPDATE task SET due_at = ?, updated_at = ? WHERE id = ?').run(dueAt, now, id)
    this.db
      .prepare('INSERT INTO task_history (task_id, from_status, to_status, note, at) VALUES (?, ?, ?, ?, ?)')
      .run(id, task.status, task.status, note ?? `due ${dueAt === null ? 'cleared' : new Date(dueAt).toISOString()}`, now)
  }

  getTask(id: Id): Task | undefined {
    const row = this.db.prepare('SELECT * FROM task WHERE id = ?').get(id)
    return row ? toTask(row) : undefined
  }

  openTasks(): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM task WHERE status IN ('proposed','ready','running','waiting','failed')
         ORDER BY due_at IS NULL, due_at, created_at`,
      )
      .all()
      .map(toTask)
  }

  /** Tasks completed since `since`, newest first, with the evidence given (for the end-of-day wrap-up). */
  tasksCompletedSince(since: number): { id: Id; title: string; evidence: string | null; at: number }[] {
    return (
      this.db
        .prepare(
          `SELECT t.id, t.title, t.evidence, h.at FROM task_history h JOIN task t ON t.id = h.task_id
           WHERE h.to_status = 'completed' AND h.at >= ? AND t.status = 'completed' ORDER BY h.at DESC`,
        )
        .all(since) as { id: string; title: string; evidence: string | null; at: number }[]
    )
  }

  /** Open tasks whose due time has passed: the "kal ye miss hua" list. */
  overdue(): Task[] {
    const now = this.clock.now()
    return this.openTasks().filter(t => t.dueAt !== null && t.dueAt < now)
  }

  taskHistory(id: Id) {
    return this.db.prepare('SELECT from_status, to_status, note, at FROM task_history WHERE task_id = ? ORDER BY rowid').all(id) as {
      from_status: TaskStatus | null
      to_status: TaskStatus
      note: string | null
      at: number
    }[]
  }

  /**
   * After a crash or restart nothing is still running. Mark such tasks as
   * waiting so they are verified before any retry, never blindly repeated.
   */
  recoverInterrupted(): Task[] {
    const stuck = this.db.prepare(`SELECT * FROM task WHERE status = 'running'`).all().map(toTask)
    for (const t of stuck) this.transition(t.id, 'waiting', { note: 'interrupted by restart; verify before retrying' })
    return stuck
  }

  // ── commitments ───────────────────────────────────────────

  addCommitment(input: { who: string; what: string; toWhom: string; dueAt?: number; source: SourceRef; projectId?: Id }): Id {
    const id = newId()
    this.db
      .prepare('INSERT INTO commitment (id, who, what, to_whom, due_at, source, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.who, input.what, input.toWhom, input.dueAt ?? null, JSON.stringify(input.source), input.projectId ?? null)
    if (input.projectId) this.touchProject(input.projectId)
    return id
  }

  /** Unresolved commitments due at or before `until`. */
  dueCommitments(until = this.clock.now()): Commitment[] {
    return this.db
      .prepare('SELECT * FROM commitment WHERE resolved_at IS NULL AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at')
      .all(until)
      .map(toCommitment)
  }

  getCommitment(id: Id): (Commitment & { resolvedAt: number | null }) | undefined {
    const row = this.db.prepare('SELECT * FROM commitment WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? { ...toCommitment(row), resolvedAt: (row.resolved_at as number | null) ?? null } : undefined
  }

  openCommitments(): Commitment[] {
    return this.db.prepare('SELECT * FROM commitment WHERE resolved_at IS NULL ORDER BY due_at IS NULL, due_at').all().map(toCommitment)
  }

  resolveCommitment(id: Id, resolution: string) {
    if (!resolution.trim()) throw new Error('Resolving a commitment requires a resolution note')
    this.db.prepare('UPDATE commitment SET resolved_at = ?, resolution = ? WHERE id = ?').run(this.clock.now(), resolution, id)
  }

  // ── personality (plan section 10) ─────────────────────────

  /** The owner's current profile; defaults until they change something. */
  personality(): PersonalityState {
    const row = this.personalityRow()
    if (!row) return { profile: { ...DEFAULT_PROFILE }, version: 0, canUndo: false, updatedAt: null }
    return { profile: row.profile, version: row.version, canUndo: row.basedOn !== null, updatedAt: row.at }
  }

  /** Applies an already-validated partial change as a new version. An unchanged profile writes nothing. */
  updatePersonality(patch: Partial<PersonalityProfile>, reason: string): PersonalityState {
    const current = this.personality()
    const next = coerceProfile({ ...current.profile, ...patch })
    if (sameProfile(next, current.profile)) return current
    return this.writePersonality(next, reason, current.version)
  }

  /** Back to the defaults, as a new version that undo can reverse. */
  resetPersonality(): PersonalityState {
    const current = this.personality()
    if (sameProfile(current.profile, DEFAULT_PROFILE)) return current
    return this.writePersonality({ ...DEFAULT_PROFILE }, 'reset to defaults', current.version)
  }

  /** Restores the profile this version was derived from. Undo is itself a version, so nothing is lost. */
  undoPersonality(): PersonalityState {
    const current = this.personalityRow()
    if (!current || current.basedOn === null) throw new Error('Nothing to undo')
    const target = current.basedOn === 0 ? undefined : this.personalityRow(current.basedOn)
    return this.writePersonality(target?.profile ?? { ...DEFAULT_PROFILE }, `undo version ${current.version}`, target ? target.basedOn : null)
  }

  personalityHistory(limit = 50): PersonalityVersion[] {
    return (this.db.prepare('SELECT * FROM personality_version ORDER BY version DESC LIMIT ?').all(limit) as unknown as PersonalityRow[]).map(r => {
      const { version, profile, reason, at } = toPersonality(r)
      return { version, profile, reason, at }
    })
  }

  /** Everything needed to inspect or re-create the profile elsewhere; no other owner data. */
  exportPersonality(): PersonalityExport {
    const iso = (ms: number) => new Date(ms).toISOString()
    return {
      format: 'assistant-personality/1',
      exportedAt: iso(this.clock.now()),
      current: this.personality().profile,
      history: this.personalityHistory(10_000).map(v => ({ version: v.version, reason: v.reason, at: iso(v.at), profile: v.profile })),
    }
  }

  /** First-run onboarding finished or skipped. Kept outside the profile, so a reset does not re-run it. */
  isOnboarded(): boolean {
    const row = this.db.prepare(`SELECT value FROM setting WHERE key = 'onboarded'`).get() as { value: string } | undefined
    return row?.value === 'true'
  }

  setOnboarded(done: boolean) {
    this.db.prepare(`INSERT OR REPLACE INTO setting (key, value) VALUES ('onboarded', ?)`).run(String(done))
  }

  private personalityRow(version?: number) {
    const row = (
      version === undefined
        ? this.db.prepare('SELECT * FROM personality_version ORDER BY version DESC LIMIT 1').get()
        : this.db.prepare('SELECT * FROM personality_version WHERE version = ?').get(version)
    ) as PersonalityRow | undefined
    return row ? toPersonality(row) : undefined
  }

  private writePersonality(profile: PersonalityProfile, reason: string, basedOn: number | null): PersonalityState {
    this.db
      .prepare('INSERT INTO personality_version (profile, reason, based_on, created_at) VALUES (?, ?, ?, ?)')
      .run(JSON.stringify(profile), reason.slice(0, MAX_REASON_CHARS) || 'changed', basedOn, this.clock.now())
    return this.personality()
  }

  // ── conversation + logs ───────────────────────────────────

  addMessage(conversationId: Id, speaker: 'owner' | 'assistant', content: string) {
    const now = this.clock.now()
    this.db
      .prepare('INSERT INTO message (id, conversation_id, speaker, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(newId(), conversationId, speaker, content, now)
    // The conversation's first owner words become its title until a better one is written.
    const title = speaker === 'owner' ? content.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
    this.db
      .prepare(
        `INSERT INTO conversation (id, started_at, last_at, title) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_at = excluded.last_at, title = CASE WHEN conversation.title = '' THEN excluded.title ELSE conversation.title END`,
      )
      .run(conversationId, now, now, title)
  }

  conversation(id: Id): Conversation | null {
    const r = this.db.prepare('SELECT c.*, (SELECT COUNT(*) FROM message m WHERE m.conversation_id = c.id) n FROM conversation c WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r ? toConversation(r) : null
  }

  /** Conversations, the most recently used first. */
  conversations(limit = 50, offset = 0): Conversation[] {
    return (this.db.prepare('SELECT c.*, (SELECT COUNT(*) FROM message m WHERE m.conversation_id = c.id) n FROM conversation c ORDER BY last_at DESC LIMIT ? OFFSET ?').all(limit, offset) as Record<string, unknown>[]).map(toConversation)
  }

  /** One conversation's messages, oldest first. */
  conversationMessages(id: Id): { speaker: 'owner' | 'assistant'; content: string; at: number }[] {
    return (
      this.db.prepare('SELECT speaker, content, created_at FROM message WHERE conversation_id = ? ORDER BY created_at, rowid').all(id) as { speaker: 'owner' | 'assistant'; content: string; created_at: number }[]
    ).map(r => ({ speaker: r.speaker, content: r.content, at: r.created_at }))
  }

  /** The rolling summary of a conversation's older part: what it says, up to which message time, and a better title. */
  setConversationSummary(id: Id, summary: string, through: number, title?: string) {
    this.db.prepare('UPDATE conversation SET summary = ?, summarized_through = ?, title = COALESCE(?, title) WHERE id = ?').run(summary, through, title?.trim() || null, id)
  }

  /** Past messages containing every word of the query, newest first, with their conversation. */
  searchMessages(query: string, limit = 12): { conversationId: Id; title: string; speaker: 'owner' | 'assistant'; content: string; at: number }[] {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1).slice(0, 6)
    if (!words.length) return []
    const where = words.map(() => 'lower(m.content) LIKE ?').join(' AND ')
    const rows = this.db
      .prepare(`SELECT m.conversation_id, c.title, m.speaker, m.content, m.created_at FROM message m LEFT JOIN conversation c ON c.id = m.conversation_id WHERE ${where} ORDER BY m.created_at DESC LIMIT ?`)
      .all(...words.map(w => `%${w.replace(/[%_]/g, '')}%`), limit) as { conversation_id: string; title: string | null; speaker: 'owner' | 'assistant'; content: string; created_at: number }[]
    return rows.map(r => ({ conversationId: r.conversation_id, title: r.title ?? '', speaker: r.speaker, content: r.content, at: r.created_at }))
  }

  /** Everything said since `since` (epoch ms), oldest first: the day's conversation across restarts. */
  messagesSince(since: number): { speaker: 'owner' | 'assistant'; content: string; at: number }[] {
    return (
      this.db.prepare('SELECT speaker, content, created_at FROM message WHERE created_at >= ? ORDER BY created_at, rowid').all(since) as {
        speaker: 'owner' | 'assistant'
        content: string
        created_at: number
      }[]
    ).map(r => ({ speaker: r.speaker, content: r.content, at: r.created_at }))
  }

  // ── learning (plan section 8) ─────────────────────────────

  getSetting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | undefined)?.value
  }

  setSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  /** Adds a proposal unless one with the same key was ever made (pending, accepted or rejected). */
  addProposal(p: { kind: ProposalKind; title: string; detail: unknown; evidence: string; dedupKey: string }): Id | null {
    const id = newId()
    const r = this.db
      .prepare('INSERT OR IGNORE INTO proposal (id, kind, title, detail, evidence, status, dedup_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.kind, p.title, JSON.stringify(p.detail), p.evidence, 'pending', p.dedupKey, this.clock.now())
    return Number(r.changes) > 0 ? id : null
  }

  proposals(status?: ProposalStatus, limit = 100): Proposal[] {
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM proposal WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
        : this.db.prepare('SELECT * FROM proposal ORDER BY created_at DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[]
    return rows.map(toProposal)
  }

  proposal(id: Id): Proposal | undefined {
    const row = this.db.prepare('SELECT * FROM proposal WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? toProposal(row) : undefined
  }

  decideProposal(id: Id, status: 'accepted' | 'rejected') {
    this.db.prepare(`UPDATE proposal SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'`).run(status, this.clock.now(), id)
  }

  addStyleSignal(field: string, value: string, text: string) {
    this.db.prepare('INSERT INTO style_signal (field, value, text, at) VALUES (?, ?, ?, ?)').run(field, value, text.slice(0, 300), this.clock.now())
  }

  styleSignals(field: string, value: string, since: number): { text: string; at: number }[] {
    return this.db.prepare('SELECT text, at FROM style_signal WHERE field = ? AND value = ? AND at >= ? ORDER BY at').all(field, value, since) as {
      text: string
      at: number
    }[]
  }

  clearStyleSignals(field: string) {
    this.db.prepare('DELETE FROM style_signal WHERE field = ?').run(field)
  }

  addWorkflow(name: string, steps: readonly string[]): Id {
    const id = newId()
    this.db.prepare('INSERT INTO workflow (id, name, steps, created_at) VALUES (?, ?, ?, ?)').run(id, name, JSON.stringify(steps), this.clock.now())
    return id
  }

  workflows(): { id: Id; name: string; steps: string[]; uses: number; createdAt: number }[] {
    return (this.db.prepare('SELECT * FROM workflow ORDER BY created_at DESC').all() as Record<string, unknown>[]).map(r => ({
      id: r.id as string,
      name: r.name as string,
      steps: JSON.parse(r.steps as string) as string[],
      uses: r.uses as number,
      createdAt: r.created_at as number,
    }))
  }

  removeWorkflow(id: Id) {
    this.db.prepare('DELETE FROM workflow WHERE id = ?').run(id)
  }

  /** Current (not superseded) memories, newest first, optionally of some kinds. */
  memories(kinds?: readonly MemoryKind[], limit = 500): MemoryRecord[] {
    const rows = kinds?.length
      ? this.db
          .prepare(`SELECT * FROM memory WHERE superseded_by IS NULL AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`)
          .all(...kinds, limit)
      : this.db.prepare('SELECT * FROM memory WHERE superseded_by IS NULL ORDER BY created_at DESC LIMIT ?').all(limit)
    return rows.map(toMemory)
  }

  /** Points an old memory at the one that replaces it (a merge or an update). */
  supersede(oldId: Id, newerId: Id) {
    if (oldId !== newerId) this.db.prepare('UPDATE memory SET superseded_by = ? WHERE id = ?').run(newerId, oldId)
  }

  /** Retention: raw conversation older than `before` is deleted; memories built from it stay. */
  deleteMessagesBefore(before: number): number {
    return Number(this.db.prepare('DELETE FROM message WHERE created_at < ?').run(before).changes)
  }

  /** Retention for decided proposals, old style hints and follow-ups long past. */
  pruneLearning(before: number) {
    this.db.prepare(`DELETE FROM proposal WHERE status != 'pending' AND decided_at < ?`).run(before)
    this.db.prepare('DELETE FROM style_signal WHERE at < ?').run(before)
    this.db.prepare('DELETE FROM followup WHERE due_at < ?').run(before)
  }

  // ── curiosity ─────────────────────────────────────────────

  /** Adds a follow-up unless the same one was noted before. */
  addFollowup(f: { about: string; quote: string; dueAt: number; dedupKey: string }): Id | null {
    const id = newId()
    const r = this.db
      .prepare('INSERT OR IGNORE INTO followup (id, about, quote, due_at, dedup_key, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, f.about.slice(0, 200), f.quote.slice(0, 300), f.dueAt, f.dedupKey, this.clock.now())
    return Number(r.changes) > 0 ? id : null
  }

  /** Open follow-ups whose time came between `since` and now, oldest first. */
  dueFollowups(since: number, now = this.clock.now()): Followup[] {
    return (this.db.prepare(`SELECT * FROM followup WHERE status = 'open' AND due_at BETWEEN ? AND ? ORDER BY due_at`).all(since, now) as Record<string, unknown>[]).map(toFollowup)
  }

  followups(limit = 100): Followup[] {
    return (this.db.prepare('SELECT * FROM followup ORDER BY due_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(toFollowup)
  }

  closeFollowup(id: Id) {
    this.db.prepare(`UPDATE followup SET status = 'done' WHERE id = ?`).run(id)
  }

  // ── LLM usage ─────────────────────────────────────────────

  addUsage(day: string, model: string, purpose: string, u: { input: number; output: number; cached: number; cacheWrite?: number }) {
    this.db
      .prepare(
        `INSERT INTO llm_usage (day, model, purpose, input, output, cached, cache_write, calls) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(day, model, purpose) DO UPDATE SET input = input + excluded.input, output = output + excluded.output, cached = cached + excluded.cached, cache_write = cache_write + excluded.cache_write, calls = calls + 1`,
      )
      .run(day, model, purpose, u.input, u.output, u.cached, u.cacheWrite ?? 0)
  }

  /** One call with what its request was made of; the newest 1000 are kept. */
  addCall(c: Omit<CallRow, 'id'>) {
    this.db
      .prepare('INSERT INTO llm_call (at, model, purpose, input, output, cached, cache_write, parts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.at, c.model, c.purpose, c.input, c.output, c.cached, c.cacheWrite, JSON.stringify(c.parts))
    this.db.prepare('DELETE FROM llm_call WHERE id <= (SELECT MAX(id) - 1000 FROM llm_call)').run()
  }

  /** The newest calls first. */
  recentCalls(limit = 20): CallRow[] {
    const rows = this.db.prepare('SELECT * FROM llm_call ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]
    return rows.map(r => ({
      id: Number(r.id),
      at: Number(r.at),
      model: String(r.model),
      purpose: String(r.purpose),
      input: Number(r.input),
      output: Number(r.output),
      cached: Number(r.cached),
      cacheWrite: Number(r.cache_write),
      parts: JSON.parse(String(r.parts)) as Record<string, number>,
    }))
  }

  /** Usage rows from `fromDay` ("2026-10-01") on. */
  usageSince(fromDay: string): UsageRow[] {
    return this.db.prepare('SELECT * FROM llm_usage WHERE day >= ? ORDER BY day').all(fromDay) as unknown as UsageRow[]
  }

  // ── skills ────────────────────────────────────────────────

  /** Saves a taught skill; the same name updates it (keeping its id, runs and auto setting unless given). */
  saveSkill(s: {
    name: string
    goal: string
    steps: string[]
    inputs?: string[]
    check?: string
    approve?: string
    schedule?: SkillSchedule | null
    when?: string | null
    auto?: boolean
  }): { skill: Skill; created: boolean } {
    const now = this.clock.now()
    const existing = this.skill(s.name)
    const row = {
      goal: s.goal,
      steps: JSON.stringify(s.steps),
      inputs: JSON.stringify(s.inputs ?? existing?.inputs ?? []),
      check: s.check ?? existing?.check ?? '',
      approve: s.approve ?? existing?.approve ?? '',
      schedule: s.schedule === undefined ? (existing?.schedule ? JSON.stringify(existing.schedule) : null) : s.schedule ? JSON.stringify(s.schedule) : null,
      when: s.when === undefined ? (existing?.when ?? null) : s.when,
      auto: (s.auto ?? existing?.auto ?? false) ? 1 : 0,
    }
    if (existing) {
      this.db
        .prepare('UPDATE skill SET goal = ?, steps = ?, inputs = ?, check_text = ?, approve = ?, schedule = ?, when_text = ?, auto = ?, updated_at = ? WHERE id = ?')
        .run(row.goal, row.steps, row.inputs, row.check, row.approve, row.schedule, row.when, row.auto, now, existing.id)
      return { skill: this.skill(existing.id)!, created: false }
    }
    const id = newId()
    this.db
      .prepare(
        'INSERT INTO skill (id, name, goal, steps, inputs, check_text, approve, schedule, when_text, auto, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, s.name, row.goal, row.steps, row.inputs, row.check, row.approve, row.schedule, row.when, row.auto, now, now)
    return { skill: this.skill(id)!, created: true }
  }

  /** By id, or by name ignoring case. */
  skill(idOrName: string): Skill | undefined {
    const row = this.db.prepare('SELECT * FROM skill WHERE id = ? OR name = ? COLLATE NOCASE').get(idOrName, idOrName) as Record<string, unknown> | undefined
    return row ? toSkill(row) : undefined
  }

  skills(): Skill[] {
    return (this.db.prepare('SELECT * FROM skill ORDER BY name COLLATE NOCASE').all() as Record<string, unknown>[]).map(toSkill)
  }

  updateSkill(id: Id, patch: { status?: 'active' | 'paused'; auto?: boolean; schedule?: SkillSchedule | null; when?: string | null }) {
    const s = this.skill(id)
    if (!s) throw new Error(`No skill ${id}`)
    this.db
      .prepare('UPDATE skill SET status = ?, auto = ?, schedule = ?, when_text = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.status ?? s.status,
        (patch.auto ?? s.auto) ? 1 : 0,
        patch.schedule === undefined ? (s.schedule ? JSON.stringify(s.schedule) : null) : patch.schedule ? JSON.stringify(patch.schedule) : null,
        patch.when === undefined ? s.when : patch.when,
        this.clock.now(),
        id,
      )
  }

  /** Deletes the skill and its run history. */
  deleteSkill(id: Id) {
    this.db.prepare('DELETE FROM skill_run WHERE skill_id = ?').run(id)
    this.db.prepare('DELETE FROM skill WHERE id = ?').run(id)
  }

  startSkillRun(skillId: Id, trigger: string): Id {
    const id = newId()
    this.db.prepare('INSERT INTO skill_run (id, skill_id, trigger, started_at) VALUES (?, ?, ?, ?)').run(id, skillId, trigger.slice(0, 100), this.clock.now())
    return id
  }

  /** Records the checked outcome of a run. Returns false for an unknown or already finished run. */
  finishSkillRun(runId: Id, ok: boolean, summary: string): boolean {
    const r = this.db.prepare('UPDATE skill_run SET ended_at = ?, ok = ?, summary = ? WHERE id = ? AND ended_at IS NULL').run(this.clock.now(), ok ? 1 : 0, summary.slice(0, 500), runId)
    return Number(r.changes) > 0
  }

  skillRuns(skillId: Id, limit = 20): SkillRun[] {
    return (this.db.prepare('SELECT * FROM skill_run WHERE skill_id = ? ORDER BY started_at DESC LIMIT ?').all(skillId, limit) as Record<string, unknown>[]).map(r => ({
      id: r.id as string,
      skillId: r.skill_id as string,
      trigger: r.trigger as string,
      startedAt: r.started_at as number,
      endedAt: (r.ended_at as number | null) ?? null,
      ok: r.ok === null || r.ok === undefined ? null : r.ok === 1,
      summary: (r.summary as string | null) ?? null,
    }))
  }

  logAction(entry: { tool: string; summary: string; decision: string; ruleId?: string | null; result?: string; evidence?: string }) {
    this.db
      .prepare('INSERT INTO action_log (id, tool, summary, decision, rule_id, result, evidence, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), entry.tool, entry.summary, entry.decision, entry.ruleId ?? null, entry.result ?? null, entry.evidence ?? null, this.clock.now())
  }

  /** Newest first, for the activity view. */
  recentActions(limit = 50): ActionLogEntry[] {
    const rows = this.db
      .prepare('SELECT id, tool, summary, decision, rule_id, result, evidence, at FROM action_log ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[]
    return rows.map(r => ({
      id: r.id as string,
      tool: r.tool as string,
      summary: r.summary as string,
      decision: r.decision as string,
      ruleId: (r.rule_id as string | null) ?? null,
      result: (r.result as string | null) ?? null,
      evidence: (r.evidence as string | null) ?? null,
      at: r.at as number,
    }))
  }

  recordInitiative(dedupKey: string, channel: string, reason: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO initiative_log (dedup_key, channel, reason, at) VALUES (?, ?, ?, ?)')
      .run(dedupKey, channel, reason, this.clock.now())
  }

  /** One initiative log row regardless of age, e.g. a "don't remind me again" marker. */
  initiativeEntry(dedupKey: string): { channel: string; reason: string; at: number } | undefined {
    const row = this.db.prepare('SELECT channel, reason, at FROM initiative_log WHERE dedup_key = ?').get(dedupKey) as
      | { channel: string; reason: string; at: number }
      | undefined
    return row ? { channel: row.channel, reason: row.reason, at: row.at } : undefined
  }

  /** Make a handled item eligible again, e.g. after the owner said "not now". */
  forgetInitiative(dedupKey: string) {
    this.db.prepare('DELETE FROM initiative_log WHERE dedup_key = ?').run(dedupKey)
  }

  initiativeHandled(sinceMs: number): Map<string, number> {
    const rows = this.db
      .prepare('SELECT dedup_key, at FROM initiative_log WHERE at >= ?')
      .all(this.clock.now() - sinceMs) as { dedup_key: string; at: number }[]
    return new Map(rows.map(r => [r.dedup_key, r.at]))
  }
}

interface PersonalityRow {
  version: number
  profile: string
  reason: string
  based_on: number | null
  created_at: number
}

const toPersonality = (r: PersonalityRow) => {
  let profile: unknown = {}
  try {
    profile = JSON.parse(r.profile)
  } catch {
    // A damaged row reads as defaults rather than breaking every reply.
  }
  return { version: r.version, profile: coerceProfile(profile), reason: r.reason, basedOn: r.based_on, at: r.created_at }
}

/** Words too common to say two memories are about the same thing. */
const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'they', 'them', 'their', 'there', 'what', 'when', 'where', 'which', 'would', 'should', 'could', 'about', 'into', 'than', 'then', 'also', 'just', 'like', 'likes', 'want', 'wants', 'does', 'owner', 'user', 'always', 'never', 'very', 'more', 'most', 'some', 'only', 'other', 'your', 'yours', 'been', 'being', 'were', 'will', 'mein', 'hain', 'karna', 'wala', 'wali'])

const toMemory = (row: unknown): MemoryRecord => {
  const r = row as Record<string, unknown>
  return {
    id: r.id as string,
    kind: r.kind as MemoryKind,
    statement: r.statement as string,
    source: JSON.parse(r.source as string) as SourceRef,
    confidence: r.confidence as number,
    projectId: (r.project_id as string | null) ?? null,
    createdAt: r.created_at as number,
  }
}

export interface ActionLogEntry {
  id: Id
  tool: string
  summary: string
  decision: string
  ruleId: string | null
  result: string | null
  evidence: string | null
  at: number
}

export interface Commitment {
  id: Id
  who: string
  what: string
  toWhom: string
  dueAt: number | null
  source: SourceRef
  projectId: Id | null
}

const toProject = (row: unknown): Project => {
  const r = row as Record<string, unknown>
  return {
    id: r.id as string,
    name: r.name as string,
    goals: r.goals as string,
    state: r.state as string,
    status: r.status as ProjectStatus,
    createdAt: r.created_at as number,
    updatedAt: (r.updated_at as number | null) ?? (r.created_at as number),
  }
}

const toCommitment = (row: unknown): Commitment => {
  const r = row as Record<string, unknown>
  return {
    id: r.id as string,
    who: r.who as string,
    what: r.what as string,
    toWhom: r.to_whom as string,
    dueAt: (r.due_at as number | null) ?? null,
    source: JSON.parse(r.source as string) as SourceRef,
    projectId: (r.project_id as string | null) ?? null,
  }
}

export type ProposalKind = 'personality' | 'memory' | 'lesson' | 'workflow'
export type ProposalStatus = 'pending' | 'accepted' | 'rejected'

export interface Proposal {
  id: Id
  kind: ProposalKind
  title: string
  detail: unknown
  evidence: string
  status: ProposalStatus
  createdAt: number
  decidedAt: number | null
}

const toProposal = (r: Record<string, unknown>): Proposal => ({
  id: r.id as string,
  kind: r.kind as ProposalKind,
  title: r.title as string,
  detail: JSON.parse(r.detail as string) as unknown,
  evidence: r.evidence as string,
  status: r.status as ProposalStatus,
  createdAt: r.created_at as number,
  decidedAt: (r.decided_at as number | null) ?? null,
})

const toSkill = (r: Record<string, unknown>): Skill => ({
  id: r.id as string,
  name: r.name as string,
  goal: r.goal as string,
  steps: JSON.parse(r.steps as string) as string[],
  inputs: JSON.parse(r.inputs as string) as string[],
  check: r.check_text as string,
  approve: r.approve as string,
  schedule: r.schedule ? (JSON.parse(r.schedule as string) as SkillSchedule) : null,
  when: (r.when_text as string | null) ?? null,
  auto: r.auto === 1,
  status: r.status === 'paused' ? 'paused' : 'active',
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
})

const toFollowup = (r: Record<string, unknown>): Followup => ({
  id: r.id as string,
  about: r.about as string,
  quote: r.quote as string,
  dueAt: r.due_at as number,
  status: r.status === 'done' ? 'done' : 'open',
  createdAt: r.created_at as number,
})

const toTask = (row: unknown): Task => {
  const r = row as Record<string, unknown>
  return {
    id: r.id as string,
    title: r.title as string,
    projectId: (r.project_id as string | null) ?? null,
    dueAt: (r.due_at as number | null) ?? null,
    status: r.status as TaskStatus,
    evidence: (r.evidence as string | null) ?? null,
  }
}
