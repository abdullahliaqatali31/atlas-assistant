/**
 * Finds folders the owner codes in, as suggestions only: VS Code's and
 * Cursor's recent workspaces, and the folders Claude Code sessions ran in.
 * Reads only paths and dates, never file contents or conversations.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, normalize, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Suggestion } from '../../shared/code.ts'

const safeStat = (p: string) => {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

/** First `bytes` of a file, for metadata near the top of a large session log. */
export const readHead = (path: string, bytes = 64 * 1024) => {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const editorRecents = (app: 'Code' | 'Cursor'): Suggestion[] => {
  const root = join(process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')), app, 'User', 'workspaceStorage')
  if (!existsSync(root)) return []
  const out: Suggestion[] = []
  for (const dir of readdirSync(root)) {
    try {
      const meta = JSON.parse(readFileSync(join(root, dir, 'workspace.json'), 'utf8')) as { folder?: string }
      if (!meta.folder?.startsWith('file:')) continue
      const path = normalize(fileURLToPath(meta.folder))
      out.push({ path, name: basename(path), source: 'vscode', lastUsedAt: safeStat(join(root, dir))?.mtimeMs ?? 0 })
    } catch {
      // Not a folder workspace, or unreadable.
    }
  }
  return out
}

export interface ClaudeSession {
  cwd: string
  title: string | null
  lastAt: number
}

/** Claude Code sessions from the last `days` days: the folder each ran in, its title and when it was last active. */
export const claudeSessions = (days = 14): ClaudeSession[] => {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return []
  const since = Date.now() - days * 24 * 60 * 60_000
  const out: ClaudeSession[] = []
  for (const dir of readdirSync(root)) {
    let files: string[]
    try {
      files = readdirSync(join(root, dir)).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const p = join(root, dir, f)
      const st = safeStat(p)
      if (!st || st.mtimeMs < since) continue
      try {
        const head = readHead(p)
        const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
        if (!cwd) continue
        const title = /"customTitle":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1] ?? /"summary":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1] ?? null
        out.push({ cwd: normalize(JSON.parse(`"${cwd}"`) as string), title: title ? (JSON.parse(`"${title}"`) as string) : null, lastAt: st.mtimeMs })
      } catch {
        // Unreadable session: skip it.
      }
    }
  }
  return out
}

/** Folders that are never projects: drive roots, the home folder, app data. */
export const notAProject = (path: string) => {
  const p = normalize(path).replace(/[\\/]+$/, '').toLowerCase()
  const home = normalize(homedir()).toLowerCase()
  // A Mac: the system, installed apps (and anything inside an app bundle), ~/Library.
  if (p.startsWith('/') && (p === home || /^\/(system|library|applications|usr|private|opt\/homebrew)(\/|$)/.test(p) || p.startsWith(`${home}/library/`) || /\.app(\/|$)/.test(p))) return true
  return (
    p === normalize(parse(path).root).replace(/[\\/]+$/, '').toLowerCase() ||
    p === home ||
    p.includes(`${home}\\appdata\\`) ||
    p.startsWith(normalize(process.env.TEMP ?? '~').toLowerCase()) ||
    // Installed programs, system folders and packaged app archives are not the owner's projects.
    /^[a-z]:\\(program files( \(x86\))?|programdata|windows)(\\|$)/.test(p) ||
    p.endsWith('.asar')
  )
}

/** Suggestions newest first, one per folder, only folders that still exist. */
export const discover = (sessions: readonly ClaudeSession[]): Suggestion[] => {
  const all = [
    ...editorRecents('Code'),
    ...editorRecents('Cursor'),
    ...sessions.map((s): Suggestion => ({ path: s.cwd, name: basename(s.cwd), source: 'claude', lastUsedAt: s.lastAt })),
  ]
  const best = new Map<string, Suggestion>()
  for (const s of all) {
    const key = s.path.toLowerCase()
    if (notAProject(s.path)) continue
    const prev = best.get(key)
    if (!prev || s.lastUsedAt > prev.lastUsedAt) best.set(key, s)
  }
  return [...best.values()].filter(s => existsSync(s.path)).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}
