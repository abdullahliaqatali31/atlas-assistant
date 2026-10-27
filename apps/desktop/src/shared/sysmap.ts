/**
 * The system map: where things are on the owner's PC, so "open my WSL
 * project in VS Code" or "WhatsApp kholo" needs no path. Names and places
 * only, never file contents. Built in main when the owner turns it on.
 */

export type MapKind = 'app' | 'project' | 'folder'

export interface MapEntry {
  /** Stable within one build: kind + place. */
  id: string
  kind: MapKind
  name: string
  /** Windows path (C:\…) for files and folders; a Linux path for WSL projects. */
  path: string | null
  /** WSL distro for projects inside Linux. */
  wsl: string | null
  /** Start-menu launch id (apps only). */
  appId: string | null
  /** Where it came from: start-menu, vscode, cursor, claude, scan, known-folder, wsl-scan, code-project. */
  source: string
  /** Last used, when known (editors and Claude sessions). */
  usedAt: number
}

export interface SystemMap {
  builtAt: number | null
  entries: MapEntry[]
}

export const EMPTY_MAP: SystemMap = { builtAt: null, entries: [] }

/** A Mac's (any Unix path's) places that are never indexed or touched: the system, installed apps, ~/Library, other people. */
const isProtectedMacPath = (path: string, home: string): boolean => {
  const p = path.replace(/\/+$/, '').toLowerCase() || '/'
  const h = home.replace(/\/+$/, '').toLowerCase()
  if (p === '/' || p === '/users' || p === '/volumes') return true
  if (/^\/(system|library|applications|usr|bin|sbin|private|etc|var|tmp|cores|dev|opt|nix)(\/|$)/.test(p)) return true
  if (/^\/users\/[^/]+$/.test(p) && p !== h) return true
  if (/^\/users\/shared(\/|$)/.test(p)) return true
  if (p.startsWith(`${h}/`) && /^\/(library|\.trash)(\/|$)/.test(p.slice(h.length))) return true
  return false
}

/** Places that are never indexed or touched: the OS, installed programs, app data, other people (Windows or Mac). */
export const isProtectedPath = (path: string, home: string): boolean => {
  if (path.startsWith('/')) return isProtectedMacPath(path, home)
  const p = path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const h = home.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  if (/^[a-z]:$/.test(p)) return true
  if (/^[a-z]:\\(windows|program files( \(x86\))?|programdata|\$recycle\.bin|system volume information|recovery|perflogs)(\\|$)/.test(p)) return true
  if (/^[a-z]:\\users\\[^\\]+$/.test(p) && p !== h) return true
  if (/^[a-z]:\\users\\(public|default|all users)(\\|$)/.test(p)) return true
  if (p.startsWith(h) && /\\appdata(\\|$)/.test(p.slice(h.length))) return true
  return false
}

/** Folder names never worth indexing (inside any place). */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', '.next', '.venv', 'venv', '__pycache__', '.cache', 'vendor', 'bin', 'obj', '.idea', '.vscode', 'appdata', '$recycle.bin'])

/** VS Code's workspace URIs: file:///c%3A/… or vscode-remote://wsl%2Bubuntu/home/… */
export const parseWorkspaceUri = (uri: string): { path: string; wsl: string | null } | null => {
  try {
    if (uri.startsWith('file:')) {
      const u = new URL(uri)
      const p = decodeURIComponent(u.pathname).replace(/^\/([a-zA-Z]:)/, '$1').replace(/\//g, '\\')
      return { path: p, wsl: null }
    }
    const m = /^vscode-remote:\/\/wsl(?:%2B|\+)([^/]+)(\/.*)$/i.exec(uri)
    if (m) return { path: decodeURIComponent(m[2]!), wsl: decodeURIComponent(m[1]!) }
  } catch {
    // Not a URI we understand.
  }
  return null
}

/** A UNC path into WSL (\\wsl.localhost\Ubuntu\home\…) as distro + Linux path. */
export const fromWslUnc = (path: string): { wsl: string; path: string } | null => {
  const m = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i.exec(path)
  return m ? { wsl: m[1]!, path: (m[2] ?? '\\').replace(/\\/g, '/') } : null
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9\u0600-\u06ff]+/)
    .filter(Boolean)

/** Words the owner says that are about the kind or place, not the name. */
const KIND_WORDS: Record<string, MapKind> = { app: 'app', application: 'app', project: 'project', repo: 'project', code: 'project', folder: 'folder', directory: 'folder', dir: 'folder' }
const FILLER = new Set(['my', 'the', 'open', 'in', 'on', 'mera', 'meri', 'mere', 'wala', 'wali', 'wale', 'ka', 'ki', 'ke', 'kholo', 'karo', 'please'])

/**
 * Best matches for what the owner said: name words first (whole, then
 * prefix), then path words; "wsl" prefers Linux projects; "project",
 * "folder", "app" prefer that kind. Recently used things win ties.
 */
export const searchMap = (entries: readonly MapEntry[], query: string, kind: MapKind | null = null, limit = 8): MapEntry[] => {
  const q = words(query)
  let want: MapKind | null = kind
  let wantWsl = false
  const terms: string[] = []
  for (const w of q) {
    if (KIND_WORDS[w] && !want) want = KIND_WORDS[w]!
    else if (w === 'wsl' || w === 'linux' || w === 'ubuntu') wantWsl = true
    else if (!FILLER.has(w) && !KIND_WORDS[w]) terms.push(w)
  }
  const scored: { e: MapEntry; score: number }[] = []
  for (const e of entries) {
    if (want && e.kind !== want) continue
    const name = words(e.name)
    const path = words(e.path ?? '')
    let score = 0
    for (const t of terms) {
      if (name.includes(t)) score += 10
      else if (name.some(n => n.startsWith(t) || (t.length > 3 && n.includes(t)))) score += 6
      else if (path.includes(t)) score += 3
      else if (path.some(n => n.startsWith(t))) score += 1
      else score -= 4
    }
    if (terms.length && score <= 0) continue
    if (wantWsl) score += e.wsl ? 8 : -6
    if (!terms.length && !wantWsl && !want) continue
    // Exact whole-name match, then recency, as tie breakers.
    if (terms.length && words(e.name).join(' ') === terms.join(' ')) score += 5
    score += Math.min(3, e.usedAt > 0 ? 3 - Math.min(3, (Date.now() - e.usedAt) / (14 * 86_400_000)) : 0)
    scored.push({ e, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || b.e.usedAt - a.e.usedAt || a.e.name.localeCompare(b.e.name))
    .slice(0, limit)
    .map(s => s.e)
}

/** How Atlas sees one entry in a tool result. */
export const describeEntry = (e: MapEntry) =>
  `[${e.id}] ${e.kind} "${e.name}"${e.wsl ? ` in WSL ${e.wsl}: ${e.path}` : e.path ? `: ${e.path}` : ''}${e.source === 'start-menu' ? '' : ` (from ${e.source})`}`

export const mapCounts = (m: SystemMap) => ({
  apps: m.entries.filter(e => e.kind === 'app').length,
  projects: m.entries.filter(e => e.kind === 'project').length,
  folders: m.entries.filter(e => e.kind === 'folder').length,
})
