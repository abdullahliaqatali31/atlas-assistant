/**
 * Measures one approved project: git history, which files changed on which
 * day, Claude Code sessions that ran there, its stack, run commands it
 * offers and its .atlas/STATUS.md. Reads metadata and a few small manifest
 * files (package.json); never source code or .env files.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import {
  detectStack,
  EMPTY_DAY,
  parseGitLog,
  parseStatus,
  STATUS_FILE,
  suggestProfiles,
  type CodeProjectView,
  type DayStats,
  type RunProfile,
  type StatusDoc,
} from '../../shared/code.ts'
import type { ClaudeSession } from './discover.ts'

/** Folders that hold dependencies, build output or tool state, not the owner's work. */
const SKIP = new Set(['node_modules', '.git', '.atlas', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', '.turbo', '.cache', '.parcel-cache', 'venv', '.venv', 'env', '__pycache__', 'target', 'release', '.vite', '.idea', '.vs', 'vendor', 'bin', 'obj', '.expo', '.gradle'])
const MAX_FILES = 6000
const MAX_DEPTH = 8
const DAYS = 14
/** Subfolders that often hold a separate app with its own dev command. */
const APP_DIRS = ['client', 'server', 'frontend', 'backend', 'web', 'api', 'app', 'admin', 'dashboard']

/** Local calendar day, "2026-10-18". */
export const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The last `n` local days, oldest first. */
export const lastDays = (now: number, n = DAYS) => Array.from({ length: n }, (_, i) => dayKey(now - (n - 1 - i) * 24 * 60 * 60_000))

const git = (cwd: string, args: string[]) =>
  new Promise<string | null>(resolve =>
    execFile('git', ['-C', cwd, ...args], { timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout)),
  )

const readJson = (p: string): unknown => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

const listFiles = (dir: string) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Modification times of the owner's files, bounded so huge folders stay fast. */
const fileTimes = (root: string): number[] => {
  const times: number[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || times.length >= MAX_FILES) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (times.length >= MAX_FILES) return
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name), depth + 1)
      } else if (e.isFile() && !/^\.env/.test(e.name) && !e.name.endsWith('.log')) {
        try {
          times.push(statSync(join(dir, e.name)).mtimeMs)
        } catch {
          // Gone between listing and stat.
        }
      }
    }
  }
  walk(root, 0)
  return times
}

export interface ScanInput {
  id: string
  path: string
  name: string
  access: CodeProjectView['access']
  profiles: RunProfile[]
}

export interface ScanResult {
  view: Omit<CodeProjectView, 'week' | 'trend' | 'today'>
  /** Measured stats per local day for the last 14 days. */
  days: Record<string, DayStats>
}

export const scanProject = async (p: ScanInput, sessions: readonly ClaudeSession[], now = Date.now()): Promise<ScanResult> => {
  const days: Record<string, DayStats> = Object.fromEntries(lastDays(now).map(d => [d, { ...EMPTY_DAY }]))
  const base = { id: p.id, name: p.name, path: p.path, access: p.access, profiles: p.profiles }
  if (!existsSync(p.path)) {
    return { view: { ...base, exists: false, stack: [], git: null, lastActivityAt: null, sessionTitles: [], status: null, suggestedProfiles: [] }, days }
  }

  // Manifests: stack and run commands, from the root and common app subfolders.
  const rootFiles = listFiles(p.path)
  const rootPkg = rootFiles.includes('package.json') ? readJson(join(p.path, 'package.json')) : null
  const stack = detectStack(rootFiles, rootPkg)
  let suggested = suggestProfiles('', rootFiles, rootPkg)
  const subdirs = [...APP_DIRS, ...['apps', 'packages'].flatMap(g => listFiles(join(p.path, g)).map(d => `${g}/${d}`))].slice(0, 20)
  for (const rel of subdirs) {
    const dir = join(p.path, ...rel.split('/'))
    const files = listFiles(dir)
    if (!files.length) continue
    const pkg = files.includes('package.json') ? readJson(join(dir, 'package.json')) : null
    // A workspace package uses the repo root's package manager when it has no lockfile of its own.
    suggested = suggested.concat(suggestProfiles(rel, [...files, ...rootFiles.filter(f => /lock/.test(f))], pkg))
    for (const s of detectStack(files, pkg)) if (!stack.includes(s)) stack.push(s)
  }
  const approved = new Set(p.profiles.map(x => `${x.cwd}|${x.command}`))
  suggested = suggested.filter(s => !approved.has(`${s.cwd}|${s.command}`)).slice(0, 12)

  // Git: branch, last commit, uncommitted changes, commits and lines per day.
  let gitView: CodeProjectView['git'] = null
  if ((await git(p.path, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true') {
    const branch = (await git(p.path, ['branch', '--show-current']))?.trim() || 'detached'
    const last = (await git(p.path, ['log', '-1', '--format=%ct%x09%s']))?.trim() ?? ''
    const [ct, ...subject] = last.split('\t')
    const status = (await git(p.path, ['status', '--porcelain'])) ?? ''
    gitView = {
      branch,
      lastCommitAt: ct ? Number(ct) * 1000 : null,
      lastCommit: subject.join('\t').slice(0, 200),
      uncommitted: status.split(/\r?\n/).filter(Boolean).length,
    }
    const since = new Date(now - DAYS * 24 * 60 * 60_000).toISOString()
    const log = (await git(p.path, ['log', `--since=${since}`, '--no-merges', '--numstat', '--format=@%ct'])) ?? ''
    // Split per commit so lines land on the commit's day.
    for (const chunk of log.split(/(?=^@)/m)) {
      const one = parseGitLog(chunk)
      const t = one.times[0]
      if (!t) continue
      const d = days[dayKey(t)]
      if (!d) continue
      d.commits += one.commits
      d.added += one.added
      d.removed += one.removed
    }
  }

  // Files edited per day (by last modification).
  let lastActivityAt = gitView?.lastCommitAt ?? null
  for (const t of fileTimes(p.path)) {
    const d = days[dayKey(t)]
    if (d) d.files++
    if (lastActivityAt === null || t > lastActivityAt) lastActivityAt = t
  }

  // Claude Code sessions that ran inside this folder.
  const root = p.path.toLowerCase().replace(/[\\/]+$/, '')
  const mine = sessions.filter(s => {
    const c = s.cwd.toLowerCase()
    return c === root || c.startsWith(root + sep) || c.startsWith(`${root}/`)
  })
  for (const s of mine) {
    const d = days[dayKey(s.lastAt)]
    if (d) d.sessions++
    if (lastActivityAt === null || s.lastAt > lastActivityAt) lastActivityAt = s.lastAt
  }
  const sessionTitles = [...mine]
    .sort((a, b) => b.lastAt - a.lastAt)
    .map(s => s.title)
    .filter((t): t is string => Boolean(t))
    .slice(0, 5)

  // .atlas/STATUS.md, kept by the owner's coding agents.
  let status: StatusDoc | null = null
  const statusPath = join(p.path, ...STATUS_FILE.split('/'))
  if (existsSync(statusPath)) {
    try {
      const st = statSync(statusPath)
      status = parseStatus(readFileSync(statusPath, 'utf8').slice(0, 20_000), st.mtimeMs)
    } catch {
      status = null
    }
  }

  return { view: { ...base, exists: true, stack, git: gitView, lastActivityAt, sessionTitles, status, suggestedProfiles: suggested }, days }
}

/** For logs and errors: a path shown relative to the project. */
export const rel = (root: string, p: string) => relative(root, p) || '.'
