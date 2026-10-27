/**
 * Tools the model may request. Each declares its action class so the policy
 * gate (not the model) decides whether it runs, needs the owner's yes, or is
 * refused. MCP tools are wrapped the same way and their output is untrusted.
 */
import { resolve } from 'node:path'

import type { McpHost } from '@assistant/mcp'
import type { MemoryRecord, MemoryStore, TaskStatus } from '@assistant/memory'
import type { ActionClass, Rule } from '@assistant/policy'
import type { ToolSpec } from '@assistant/providers'
import type { Clock } from '@assistant/shared'

export interface RuntimeTool extends ToolSpec {
  actionClass: ActionClass
  /** True when the output comes from outside the owner (web, mail, MCP). */
  isUntrusted: boolean
  /** Folder or domain this call targets, for scoped rules; undefined means scoped rules cannot match. */
  scope?(input: Record<string, unknown>): string | undefined
  /** `signal` aborts when the owner stops the reply or all automation. */
  run(input: Record<string, unknown>, signal?: AbortSignal): Promise<string>
}

/**
 * The single folder or site an MCP call targets: a resolved `path`, or the
 * host of `url`. Calls with several targets get no scope, so they ask.
 */
export const callScope = (input: Record<string, unknown>): string | undefined => {
  const { path, url } = input
  if (typeof path === 'string' && path && url === undefined) return resolve(path)
  if (typeof url === 'string' && path === undefined) {
    try {
      return new URL(url).hostname || undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

type Schema = { type?: string; properties?: Record<string, { type?: string }>; required?: string[] }

/** Minimal JSON-Schema check for tool input: object shape, required keys, primitive types. */
export const validateInput = (schema: Record<string, unknown>, input: unknown): string | null => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'Input must be an object.'
  const s = schema as Schema
  const obj = input as Record<string, unknown>
  for (const key of s.required ?? []) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') return `Missing required field "${key}".`
  }
  for (const [key, prop] of Object.entries(s.properties ?? {})) {
    const v = obj[key]
    if (v === undefined || !prop.type) continue
    const ok =
      prop.type === 'integer' ? Number.isInteger(v) : prop.type === 'array' ? Array.isArray(v) : typeof v === prop.type
    if (!ok) return `Field "${key}" must be ${prop.type}.`
  }
  return null
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

const fmtTask = (t: { title: string; status: TaskStatus; dueAt: number | null }, i: number) =>
  `${i + 1}. ${t.title} [${t.status}]${t.dueAt ? ` due ${new Date(t.dueAt).toISOString().slice(0, 16)}Z` : ''}`

export const localTools = (memory: MemoryStore, clock: Clock, recall?: (query: string, limit: number) => Promise<MemoryRecord[]>): RuntimeTool[] => [
  {
    name: 'tasks_list',
    description: 'List the owner\'s open tasks, numbered, with status and due time.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    actionClass: 'observe',
    isUntrusted: false,
    run: async () => {
      const open = memory.openTasks()
      return open.length ? open.map(fmtTask).join('\n') : 'No open tasks.'
    },
  },
  {
    name: 'task_add',
    description: 'Add a task the owner asked for. Only add tasks the owner stated or confirmed.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title' },
        due: { type: 'string', description: 'Optional ISO 8601 due time, e.g. 2026-10-18T10:00:00+05:00' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    actionClass: 'modify',
    isUntrusted: false,
    run: async input => {
      const due = input.due ? Date.parse(str(input.due)) : undefined
      memory.addTask(str(input.title), { dueAt: due !== undefined && !Number.isNaN(due) ? due : undefined })
      return `Added task "${str(input.title)}".`
    },
  },
  {
    name: 'task_complete',
    description: 'Mark an open task complete. Requires concrete evidence the owner gave or a tool returned (never assume).',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer', description: 'Task number from tasks_list' },
        evidence: { type: 'string', description: 'What shows it is done, e.g. "Owner said the quote email was sent"' },
      },
      required: ['number', 'evidence'],
      additionalProperties: false,
    },
    actionClass: 'modify',
    isUntrusted: false,
    run: async input => {
      const task = memory.openTasks()[Number(input.number) - 1]
      if (!task) return `No open task number ${String(input.number)}.`
      memory.transition(task.id, 'completed', { evidence: str(input.evidence) })
      return `Completed "${task.title}".`
    },
  },
  {
    name: 'task_update',
    description: 'Reschedule an open task or cancel it, only after the owner decided so.',
    inputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer', description: 'Task number from tasks_list' },
        due: { type: 'string', description: 'New ISO 8601 due time, e.g. 2026-10-20T10:00:00+05:00' },
        cancel: { type: 'boolean', description: 'True when the owner wants to drop the task' },
      },
      required: ['number'],
      additionalProperties: false,
    },
    actionClass: 'modify',
    isUntrusted: false,
    run: async input => {
      const task = memory.openTasks()[Number(input.number) - 1]
      if (!task) return `No open task number ${String(input.number)}.`
      if (input.cancel === true) {
        memory.transition(task.id, 'cancelled', { note: 'owner dropped it' })
        return `Cancelled "${task.title}".`
      }
      const due = Date.parse(str(input.due))
      if (Number.isNaN(due)) return 'Give a new due time or cancel: true.'
      memory.reschedule(task.id, due)
      return `Moved "${task.title}" to ${new Date(due).toISOString().slice(0, 16)}Z.`
    },
  },
  {
    name: 'memory_search',
    description: 'Search long-term memory for facts and preferences.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    actionClass: 'observe',
    isUntrusted: false,
    run: async input => {
      const hits = recall ? await recall(str(input.query), 8) : memory.recall(str(input.query), 8)
      return hits.length ? hits.map(m => `- [${m.id.slice(0, 8)}] ${m.statement} (${m.kind})`).join('\n') : 'Nothing found.'
    },
  },
  {
    name: 'memory_correct',
    description:
      'Replace a remembered fact the owner just corrected ("nahi, deadline Thursday hai"). Find it with memory_search first and pass its [id]. The old version is kept only as hidden history.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The [id] shown by memory_search' },
        statement: { type: 'string', description: 'The corrected fact, one sentence' },
      },
      required: ['id', 'statement'],
      additionalProperties: false,
    },
    actionClass: 'modify',
    isUntrusted: false,
    run: async input => {
      const old = memory.findMemory(str(input.id))
      if (!old) return `No memory with id ${str(input.id)}; search again.`
      memory.correct(old.id, str(input.statement).slice(0, 300), { kind: 'owner', origin: 'correction', retrievedAt: clock.now() })
      return `Corrected: "${old.statement}" → "${str(input.statement)}".`
    },
  },
  {
    name: 'memory_forget',
    description: 'Permanently forget a remembered fact when the owner asks ("ye bhool jao"). Find it with memory_search first and pass its [id].',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The [id] shown by memory_search' } },
      required: ['id'],
      additionalProperties: false,
    },
    // Deleting is permanent: the owner confirms every time.
    actionClass: 'destructive',
    isUntrusted: false,
    run: async input => {
      const old = memory.findMemory(str(input.id))
      if (!old) return `No memory with id ${str(input.id)}; search again.`
      memory.forget(old.id)
      return `Forgot "${old.statement}" (and any older versions of it).`
    },
  },
  {
    name: 'memory_save',
    description: 'Save a durable fact or preference the owner explicitly stated. Do not save guesses about the owner.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string' },
        kind: { type: 'string', enum: ['fact', 'preference'] },
      },
      required: ['statement'],
      additionalProperties: false,
    },
    actionClass: 'modify',
    isUntrusted: false,
    run: async input => {
      const kind = input.kind === 'preference' ? 'preference' : 'fact'
      const id = memory.remember({ kind, statement: str(input.statement), source: { kind: 'owner', origin: 'conversation', retrievedAt: clock.now() } })
      return `Saved [${id.slice(0, 8)}].`
    },
  },
  {
    name: 'project_update',
    description: 'Record where a project stands, in the owner’s words, after they gave a status update.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (or a clear part of it)' },
        state: { type: 'string', description: 'Current state, short, e.g. "drawings approved, quote pending"' },
      },
      required: ['project', 'state'],
      additionalProperties: false,
    },
    actionClass: 'modify',
    isUntrusted: false,
    run: async input => {
      const name = str(input.project).toLowerCase()
      const matches = memory.listProjects().filter(p => p.name.toLowerCase() === name || p.name.toLowerCase().includes(name))
      if (matches.length !== 1) return matches.length ? `Which one: ${matches.map(p => p.name).join(', ')}?` : `No project called "${str(input.project)}".`
      memory.updateProject(matches[0]!.id, { state: str(input.state).slice(0, 2000) })
      return `Updated ${matches[0]!.name}.`
    },
  },
]

/**
 * The owner's answer to a question the assistant raised about something it
 * learned. Only for an answer they actually gave; never on its own.
 */
export const learningTools = (learner: { decide(id: string, accept: boolean): unknown }): RuntimeTool[] => [
  {
    name: 'suggestion_answer',
    description:
      'Apply the owner’s yes or no to a learning suggestion you asked them about (the proposal_id is in your instruction). Use only after they clearly answered.',
    inputSchema: {
      type: 'object',
      properties: { proposal_id: { type: 'string' }, accept: { type: 'boolean' } },
      required: ['proposal_id', 'accept'],
      additionalProperties: false,
    },
    actionClass: 'modify',
    isUntrusted: false,
    run: async input => {
      learner.decide(str(input.proposal_id), input.accept === true)
      return input.accept === true ? 'Saved: the owner confirmed it.' : 'Dismissed: the owner said no.'
    },
  },
]

/** Standing permissions for the local store: reading and editing your own tasks and memory. */
export const DEFAULT_RULES: Rule[] = [
  ...(['tasks_list', 'memory_search', 'skill_list'] as const).map((tool): Rule => ({ id: `default-${tool}`, tool, actionClass: 'observe', effect: 'allow' })),
  ...(['task_add', 'task_complete', 'task_update', 'memory_save', 'memory_correct', 'project_update', 'suggestion_answer', 'skill_save', 'skill_run', 'skill_finish'] as const).map((tool): Rule => ({
    id: `default-${tool}`,
    tool,
    actionClass: 'modify',
    effect: 'allow',
  })),
]

export const mcpTools = (host: McpHost): RuntimeTool[] =>
  host.listTools().map(t => ({
    name: t.name,
    description: `[${t.server}] ${t.description}`.slice(0, 1024),
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
    actionClass: t.actionClass,
    isUntrusted: true,
    scope: callScope,
    run: async (input, signal) => {
      // The assistant's gate already approved this exact call.
      const out = await host.call(t.name, input, { confirmed: true, scope: callScope(input), signal })
      if (out.status === 'ok') return out.untrustedText
      if (out.status === 'error') throw new Error(out.message)
      throw new Error(out.decision.reason)
    },
  }))
