/**
 * Code projects (plan: "projects the owner codes on"): folders the owner
 * approved, what happened in them (measured from git, file times, Claude Code
 * sessions and VS Code time), an `.atlas/STATUS.md` their coding agents keep
 * current, and dev servers Atlas starts and stops on request. Main owns the
 * folders and processes; the runtime gets snapshots and asks main to act.
 * This module holds the contract and the pure helpers, which are tested.
 */

// ── access and data ─────────────────────────────────────────

/** What Atlas may do in a project: see activity, also keep its status file, also run approved commands. */
export const ACCESS_LEVELS = ['see', 'status', 'run'] as const
export type Access = (typeof ACCESS_LEVELS)[number]
export const ACCESS_LABEL: Record<Access, string> = { see: 'See activity', status: 'See + status file', run: 'See + status + run' }

export interface RunProfile {
  id: string
  /** Short name the owner says: "web", "api". */
  name: string
  /** One command line, e.g. "npm run dev". No chaining or redirection. */
  command: string
  /** Folder inside the project to run it in ("" = project root). */
  cwd: string
}

export interface DayStats {
  commits: number
  added: number
  removed: number
  /** Files modified that day (outside node_modules, .git, build output). */
  files: number
  /** Claude Code sessions active that day. */
  sessions: number
  /** Minutes the project's VS Code window was in front (only with window tracking on). */
  minutes: number
}
export const EMPTY_DAY: DayStats = { commits: 0, added: 0, removed: 0, files: 0, sessions: 0, minutes: 0 }

export interface StatusDoc {
  now: string
  next: string
  recent: string
  run: string
  issues: string
  updatedAt: number
}

export type RunState = 'starting' | 'running' | 'exited' | 'crashed'

export interface RunView {
  id: string
  projectId: string
  projectName: string
  profile: string
  command: string
  state: RunState
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  /** First local URL the server printed, e.g. http://localhost:5173. */
  url: string | null
  /** Last line that looked like an error. */
  lastError: string | null
}

export interface CodeProjectView {
  id: string
  name: string
  path: string
  access: Access
  exists: boolean
  stack: string[]
  git: { branch: string; lastCommitAt: number | null; lastCommit: string; uncommitted: number } | null
  today: DayStats
  week: DayStats
  /** Last 14 days, oldest first: a rough activity score per day for the sparkline. */
  trend: number[]
  lastActivityAt: number | null
  /** Recent Claude Code session titles, newest first. */
  sessionTitles: string[]
  status: StatusDoc | null
  profiles: RunProfile[]
  /** Commands found in package.json and friends, not yet approved. */
  suggestedProfiles: Omit<RunProfile, 'id'>[]
}

export interface Suggestion {
  path: string
  name: string
  source: 'vscode' | 'claude'
  lastUsedAt: number
}

export interface AgentInstructions {
  /** The global instruction file exists or can be created. */
  available: boolean
  enabled: boolean
  file: string
}

export interface CodeState {
  projects: CodeProjectView[]
  suggestions: Suggestion[]
  running: RunView[]
  agents: { claude: AgentInstructions; codex: AgentInstructions }
  scanning: boolean
  lastScanAt: number | null
}

// ── IPC ─────────────────────────────────────────────────────

export const KC = {
  state: 'code:state',
  changed: 'code:changed',
  add: 'code:add',
  pick: 'code:pick',
  remove: 'code:remove',
  setAccess: 'code:set-access',
  dismiss: 'code:dismiss',
  scan: 'code:scan',
  start: 'code:start',
  stop: 'code:stop',
  stopAll: 'code:stop-all',
  logs: 'code:logs',
  addProfile: 'code:add-profile',
  removeProfile: 'code:remove-profile',
  createStatus: 'code:create-status',
  setAgent: 'code:set-agent',
  openEditor: 'code:open-editor',
  openUrl: 'code:open-url',
} as const

export interface CodeBridge {
  state(): Promise<CodeState>
  onChanged(cb: (s: CodeState) => void): () => void
  /** Approve a suggested folder. */
  add(path: string): Promise<CodeState>
  /** Choose any folder with a dialog and approve it. */
  pick(): Promise<CodeState>
  remove(projectId: string): Promise<CodeState>
  setAccess(projectId: string, access: Access): Promise<CodeState>
  dismiss(path: string): Promise<CodeState>
  scan(): Promise<CodeState>
  start(projectId: string, profileId: string): Promise<CodeState>
  stop(runId: string): Promise<CodeState>
  stopAll(): Promise<CodeState>
  logs(runId: string): Promise<string[]>
  addProfile(projectId: string, profile: Omit<RunProfile, 'id'>): Promise<CodeState>
  removeProfile(projectId: string, profileId: string): Promise<CodeState>
  createStatus(projectId: string): Promise<CodeState>
  setAgent(agent: 'claude' | 'codex', enabled: boolean): Promise<CodeState>
  openEditor(projectId: string): Promise<void>
  openUrl(runId: string): Promise<void>
}

/** Runtime → main requests (the model's tools), answered by request id. */
export type CodeOp =
  | { kind: 'start'; project: string; profile?: string | undefined }
  | { kind: 'stop'; project?: string | undefined }
  | { kind: 'logs'; project: string; lines?: number | undefined }
  | { kind: 'status'; project: string; section: keyof Omit<StatusDoc, 'updatedAt'>; text: string }
  /** An improvement brief, written only to .atlas/improvements/ in a project the owner allowed a status file. */
  | { kind: 'brief'; project: string; file: string; text: string }

// ── validation ──────────────────────────────────────────────

export const isAccess = (v: unknown): v is Access => (ACCESS_LEVELS as readonly unknown[]).includes(v)
export const isId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{6,64}$/.test(v)

/**
 * A command line the owner approved. Runs through cmd.exe, so anything that
 * could chain a second command or redirect output is refused.
 */
export const commandProblem = (command: string): string | null => {
  const c = command.trim()
  if (!c) return 'Enter a command, e.g. npm run dev.'
  if (c.length > 300) return 'That command is too long.'
  if (/[&|<>^`\r\n%]/.test(c)) return 'One command only: no &, |, <, >, ^, % or line breaks.'
  if (/^\s*(rm|del|rmdir|rd|format|shutdown|reg|powershell|pwsh|cmd)\b/i.test(c)) return 'That command is not allowed as a run profile.'
  return null
}

export const parseProfile = (v: unknown): Omit<RunProfile, 'id'> | string => {
  if (typeof v !== 'object' || v === null) return 'Expected a run profile.'
  const o = v as Record<string, unknown>
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  const command = typeof o.command === 'string' ? o.command.trim() : ''
  const cwd = typeof o.cwd === 'string' ? o.cwd.trim().replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '') : ''
  if (!/^[\w .-]{1,30}$/.test(name)) return 'Give it a short name like "web" or "api".'
  const problem = commandProblem(command)
  if (problem) return problem
  if (cwd && (cwd.split('/').includes('..') || /^[a-z]:/i.test(cwd) || !/^[\w ./-]+$/.test(cwd))) return 'The folder must be inside the project.'
  return { name, command, cwd }
}

// ── run profiles found in project files ─────────────────────

const DEV_SCRIPTS = ['dev', 'start', 'serve', 'preview', 'start:dev', 'dev:web', 'dev:api'] as const

/** The package manager a folder uses, from its lockfile. */
export const packageManager = (files: readonly string[]): 'pnpm' | 'yarn' | 'bun' | 'npm' =>
  files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : files.includes('bun.lockb') || files.includes('bun.lock') ? 'bun' : 'npm'

/**
 * Suggested run profiles for one folder of a project, from its package.json
 * scripts and well-known files. `rel` is the folder inside the project.
 */
export const suggestProfiles = (rel: string, files: readonly string[], packageJson: unknown): Omit<RunProfile, 'id'>[] => {
  const out: Omit<RunProfile, 'id'>[] = []
  const prefix = rel ? `${rel.split('/').at(-1)} ` : ''
  const scripts = (packageJson as { scripts?: Record<string, unknown> } | null)?.scripts
  if (scripts && typeof scripts === 'object') {
    const pm = packageManager(files)
    for (const s of DEV_SCRIPTS) {
      if (typeof scripts[s] !== 'string') continue
      const command = pm === 'npm' && s === 'start' ? 'npm start' : `${pm} run ${s}`
      out.push({ name: `${prefix}${s}`.trim(), command, cwd: rel })
    }
  }
  if (files.includes('manage.py')) out.push({ name: `${prefix}django`.trim(), command: 'python manage.py runserver', cwd: rel })
  if (files.some(f => /^(docker-)?compose\.ya?ml$/.test(f))) out.push({ name: `${prefix}docker`.trim(), command: 'docker compose up', cwd: rel })
  return out
}

/** The technologies a project uses, for its card. */
export const detectStack = (files: readonly string[], packageJson: unknown): string[] => {
  const deps = { ...((packageJson as { dependencies?: object })?.dependencies ?? {}), ...((packageJson as { devDependencies?: object })?.devDependencies ?? {}) } as Record<string, unknown>
  const has = (d: string) => d in deps
  const stack: string[] = []
  if (has('next')) stack.push('Next.js')
  else if (has('react')) stack.push('React')
  if (has('vue')) stack.push('Vue')
  if (has('@angular/core')) stack.push('Angular')
  if (has('svelte')) stack.push('Svelte')
  if (has('electron')) stack.push('Electron')
  if (has('express')) stack.push('Express')
  if (has('@nestjs/core')) stack.push('NestJS')
  if (has('vite')) stack.push('Vite')
  if (has('tailwindcss')) stack.push('Tailwind')
  if (has('prisma') || has('@prisma/client')) stack.push('Prisma')
  if (has('typescript')) stack.push('TypeScript')
  if (files.includes('manage.py')) stack.push('Django')
  else if (files.includes('requirements.txt') || files.includes('pyproject.toml')) stack.push('Python')
  if (files.includes('composer.json')) stack.push('PHP')
  if (files.includes('go.mod')) stack.push('Go')
  if (files.includes('Cargo.toml')) stack.push('Rust')
  if (files.some(f => /^(docker-)?compose\.ya?ml$/.test(f) || f === 'Dockerfile')) stack.push('Docker')
  return [...new Set(stack)]
}

// ── dev server output ───────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
export const stripAnsi = (s: string) => s.replace(ANSI, '')

/** The local address a dev server says it is listening on. */
export const findLocalUrl = (line: string): string | null => {
  const m = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d{2,5}[^\s'")]*/i.exec(stripAnsi(line))
  return m ? m[0].replace('0.0.0.0', 'localhost').replace(/[.,;]+$/, '') : null
}

/** A line worth surfacing as the reason a server failed. */
export const looksLikeError = (line: string) => /\b(error|failed|exception|EADDRINUSE|cannot find module|not recognized|ENOENT)\b/i.test(stripAnsi(line))

// ── git output ──────────────────────────────────────────────

/**
 * Parses `git log --numstat --format=@%ct` output: one "@<unix time>" line per
 * commit followed by "<added>\t<removed>\t<path>" lines.
 */
export const parseGitLog = (out: string): { commits: number; added: number; removed: number; times: number[] } => {
  let commits = 0
  let added = 0
  let removed = 0
  const times: number[] = []
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('@')) {
      commits++
      times.push(Number(line.slice(1)) * 1000)
      continue
    }
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line)
    if (m) {
      added += m[1] === '-' ? 0 : Number(m[1])
      removed += m[2] === '-' ? 0 : Number(m[2])
    }
  }
  return { commits, added, removed, times }
}

// ── STATUS.md ───────────────────────────────────────────────

export const STATUS_FILE = '.atlas/STATUS.md'
const SECTIONS: [keyof Omit<StatusDoc, 'updatedAt'>, string][] = [
  ['now', 'Now'],
  ['next', 'Next'],
  ['recent', 'Recently changed'],
  ['run', 'How to run'],
  ['issues', 'Known issues'],
]

export const statusTemplate = (name: string, run: string) =>
  [
    `# ${name}: status`,
    '',
    '<!-- Kept by your coding agents and Atlas. Short and current; never put secrets here. -->',
    '',
    ...SECTIONS.flatMap(([key, title]) => [`## ${title}`, '', key === 'run' && run ? run : '-', '']),
  ].join('\n')

/** The sections of a STATUS.md, empty where missing. */
export const parseStatus = (md: string, updatedAt: number): StatusDoc => {
  const doc: StatusDoc = { now: '', next: '', recent: '', run: '', issues: '', updatedAt }
  const parts = md.split(/^##\s+/m).slice(1)
  for (const part of parts) {
    const [title = '', ...body] = part.split(/\r?\n/)
    const key = SECTIONS.find(([, t]) => t.toLowerCase() === title.trim().toLowerCase())?.[0]
    if (key) doc[key] = body.join('\n').trim().replace(/^-$/, '')
  }
  return doc
}

/** Replaces one section's text, keeping the rest of the file as it was. */
export const setStatusSection = (md: string, key: keyof Omit<StatusDoc, 'updatedAt'>, text: string): string => {
  const title = SECTIONS.find(([k]) => k === key)![1]
  const re = new RegExp(`(^##\\s+${title}\\s*\\r?\\n)([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm')
  const body = `\n${text.trim() || '-'}\n\n`
  return re.test(md) ? md.replace(re, (_m, head: string) => `${head}${body}`) : `${md.trimEnd()}\n\n## ${title}\n${body}`
}

// ── instructions for coding agents ──────────────────────────

export const AGENT_BLOCK_START = '<!-- atlas:status:start -->'
export const AGENT_BLOCK_END = '<!-- atlas:status:end -->'
export const AGENT_BLOCK = [
  AGENT_BLOCK_START,
  '## Project status for Atlas',
  '',
  'If the project you are working in has `.atlas/STATUS.md`, keep it current: when you finish a task or the session ends, update its sections',
  '"Now" (what the project is doing), "Next" (the next concrete steps), "Recently changed" (date and one line per change, newest first, keep about 10),',
  '"How to run" and "Known issues". Keep it short and factual. Never write secrets, keys or personal data in it. Do not create the file if it is missing.',
  AGENT_BLOCK_END,
].join('\n')

export const hasAgentBlock = (text: string) => text.includes(AGENT_BLOCK_START)

/** Adds or removes the Atlas block, leaving everything else in the file untouched. */
export const withAgentBlock = (text: string, on: boolean): string => {
  const start = text.indexOf(AGENT_BLOCK_START)
  const end = text.indexOf(AGENT_BLOCK_END)
  const without = start >= 0 && end > start ? `${text.slice(0, start).trimEnd()}\n${text.slice(end + AGENT_BLOCK_END.length).replace(/^\s*\n/, '')}`.replace(/^\n+/, '') : text
  if (!on) return without.trim() ? `${without.trimEnd()}\n` : ''
  return `${without.trimEnd()}${without.trim() ? '\n\n' : ''}${AGENT_BLOCK}\n`
}

// ── activity score ──────────────────────────────────────────

/** One number per day for the sparkline: commits weigh most, then sessions, then edited files. */
export const activityScore = (d: DayStats) => d.commits * 3 + d.sessions * 2 + Math.min(d.files, 30) / 3 + d.minutes / 30

export const sumDays = (days: readonly DayStats[]): DayStats =>
  days.reduce((a, d) => ({ commits: a.commits + d.commits, added: a.added + d.added, removed: a.removed + d.removed, files: a.files + d.files, sessions: a.sessions + d.sessions, minutes: a.minutes + d.minutes }), { ...EMPTY_DAY })
