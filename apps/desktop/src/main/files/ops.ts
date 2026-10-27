/**
 * File operations inside the folders the owner chose. Every path is resolved
 * and checked against those folders (after following junctions and links),
 * nothing is overwritten (a free "name (2).ext" is used instead), nothing is
 * deleted outright (removing goes to the Recycle Bin), and every change is
 * recorded in a batch that can be undone.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

import { readDocument } from './reader.ts'
import { numbered, size, typeFolderOf, type FileBatchView, type FileChange, type FileFolderView, type FileOp, type OrganizeBy } from '../../shared/files.ts'

/** Folders never walked when listing or searching: tools and caches, not the owner's files. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.next', '.cache', '$recycle.bin', 'system volume information'])
/** Files Windows and browsers keep for themselves. */
const SKIP_FILES = /^(desktop\.ini|thumbs\.db|\.ds_store)$|\.(crdownload|part|partial|tmp|download)$/i
const MAX_WALK = 30_000
const MAX_BATCH = 500
const HISTORY_KEEP = 50

const lower = (p: string) => p.toLowerCase()
const inside = (child: string, parent: string) => {
  const c = lower(normalize(child)).replace(/[\\/]+$/, '')
  const p = lower(normalize(parent)).replace(/[\\/]+$/, '')
  return c === p || c.startsWith(p + sep)
}
const when = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface FileOpsDeps {
  folders: () => FileFolderView[]
  history: () => FileBatchView[]
  setHistory: (h: FileBatchView[]) => void
  /** Moves a file or folder to the Recycle Bin. */
  trash: (path: string) => Promise<void>
  now?: () => number
}

interface Resolved {
  path: string
  folder: FileFolderView
}

export class FileOps {
  constructor(private readonly deps: FileOpsDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  // ── paths ────────────────────────────────────────────────

  /**
   * An absolute path, a folder name ("Downloads"), or a path starting with
   * one ("Downloads/old/a.pdf"); relative to the only folder when there is one.
   */
  async resolvePath(input: string, need: 'read' | 'organise'): Promise<Resolved> {
    const folders = this.deps.folders()
    if (!folders.length) throw new Error('No folders chosen yet. The owner adds them in Files.')
    const raw = input.trim().replace(/^["']|["']$/g, '')
    if (!raw) throw new Error('Which file or folder?')
    let full: string
    if (isAbsolute(raw)) full = normalize(resolve(raw))
    else {
      const [first, ...rest] = raw.split(/[\\/]+/)
      const byName = folders.filter(f => lower(f.name) === lower(first ?? ''))
      if (byName.length === 1) full = normalize(join(byName[0]!.path, ...rest))
      else if (folders.length === 1) full = normalize(join(folders[0]!.path, raw))
      else throw new Error(`Say which folder: ${folders.map(f => f.name).join(', ')}.`)
    }
    const folder = folders.filter(f => inside(full, f.path)).sort((a, b) => b.path.length - a.path.length)[0]
    if (!folder) throw new Error(`"${raw}" is outside the folders the owner chose (${folders.map(f => f.name).join(', ')}).`)
    // Junctions and links must not lead out of the chosen folder.
    let probe = full
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
    const [realProbe, realRoot] = await Promise.all([realpath(probe), realpath(folder.path)])
    if (!inside(realProbe, realRoot)) throw new Error(`"${raw}" leads outside ${folder.name}.`)
    if (relative(folder.path, full).split(/[\\/]/).some(s => lower(s) === '.git')) throw new Error('Atlas does not touch .git folders.')
    if (need === 'organise' && folder.access !== 'organise') throw new Error(`${folder.name} is read-only for Atlas. The owner can allow organising it in Files.`)
    return { path: full, folder }
  }

  /** A path shown to the model: the folder name plus the rest. */
  private show(r: Resolved | string): string {
    const path = typeof r === 'string' ? r : r.path
    const folder = typeof r === 'string' ? this.deps.folders().find(f => inside(path, f.path)) : r.folder
    if (!folder) return path
    const rest = relative(folder.path, path)
    return rest ? `${folder.name}/${rest.replace(/\\/g, '/')}` : folder.name
  }

  private async freeName(target: string): Promise<string> {
    if (!existsSync(target)) return target
    const dir = dirname(target)
    const name = basename(target)
    for (let n = 2; n < 10_000; n++) {
      const candidate = join(dir, numbered(name, n))
      if (!existsSync(candidate)) return candidate
    }
    throw new Error(`No free name for ${name}.`)
  }

  /** Creates missing parent folders and returns the ones it made, outermost first. */
  private async makeDirs(dir: string): Promise<string[]> {
    const made: string[] = []
    let p = dir
    while (!existsSync(p)) {
      made.unshift(p)
      p = dirname(p)
    }
    if (made.length) await mkdir(dir, { recursive: true })
    return made
  }

  private async moveOne(from: string, to: string, copy: boolean) {
    if (copy) return cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    try {
      await rename(from, to)
    } catch (e) {
      // Another drive: copy, then remove the original (this is a move, not a delete).
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      await cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
      await rm(from, { recursive: true })
    }
  }

  private record(summary: string, by: string, changes: FileChange[]): FileBatchView | null {
    if (!changes.length) return null
    const batch: FileBatchView = { id: randomUUID(), at: this.now(), summary, by, changes, undoneAt: null }
    this.deps.setHistory([batch, ...this.deps.history()].slice(0, HISTORY_KEEP))
    return batch
  }

  private friendlyError(e: unknown, what: string) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EBUSY' || code === 'EPERM') return `${what}: in use or protected (close the app using it).`
    if (code === 'ENOENT') return `${what}: not found.`
    if (code === 'EACCES') return `${what}: Windows denied access.`
    return `${what}: ${e instanceof Error ? e.message : String(e)}`
  }

  // ── operations ───────────────────────────────────────────

  async handle(op: FileOp): Promise<string> {
    switch (op.kind) {
      case 'folders':
        return this.folders()
      case 'list':
        return this.list(op.path, op.recursive ?? false, op.limit)
      case 'search':
        return this.search(op)
      case 'read':
        return this.read(op.path)
      case 'move':
        return this.move(op.items, op.copy ?? false, op.by ?? 'conversation')
      case 'mkdir':
        return this.makeFolder(op.path, op.by ?? 'conversation')
      case 'trash':
        return this.trash(op.paths, op.by ?? 'conversation')
      case 'organize':
        return this.organize(op.folder, op.by, op.apply, op.requestedBy ?? 'conversation')
      case 'undo':
        return this.undo(op.batch)
      case 'history':
        return this.historyText(op.limit)
    }
  }

  folders(): string {
    const folders = this.deps.folders()
    if (!folders.length) return 'No folders chosen yet. The owner adds them in Files.'
    return folders.map(f => `${f.name}: ${f.path} (${f.access === 'organise' ? 'can organise: move, rename, copy, new folders, Recycle Bin' : 'read only'})`).join('\n')
  }

  async list(path: string, recursive: boolean, limit = 200): Promise<string> {
    const root = await this.resolvePath(path, 'read')
    const st = await stat(root.path)
    if (!st.isDirectory()) return `${this.show(root)}: file, ${size(st.size)}, modified ${when(st.mtimeMs)}.`
    const max = Math.min(Math.max(1, limit), 1000)
    const rows: { path: string; dir: boolean; size: number; mtime: number }[] = []
    const walk = async (dir: string, depth: number) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (rows.length >= max * 4) return
        if (e.isDirectory() ? SKIP_DIRS.has(lower(e.name)) : SKIP_FILES.test(e.name)) continue
        const p = join(dir, e.name)
        const s = await lstat(p).catch(() => null)
        if (!s) continue
        rows.push({ path: p, dir: s.isDirectory(), size: s.size, mtime: s.mtimeMs })
        if (recursive && s.isDirectory() && depth < 5) await walk(p, depth + 1)
      }
    }
    await walk(root.path, 0)
    if (!rows.length) return `${this.show(root)} is empty.`
    rows.sort((a, b) => (a.dir === b.dir ? b.mtime - a.mtime : a.dir ? -1 : 1))
    const shown = rows.slice(0, max)
    const files = rows.filter(r => !r.dir)
    const head = `${this.show(root)}: ${rows.length - files.length} folder(s), ${files.length} file(s)${rows.length >= max * 4 ? ' (stopped counting)' : ''}, ${size(files.reduce((n, r) => n + r.size, 0))}. Newest first:`
    const lines = shown.map(r => {
      const name = relative(root.path, r.path).replace(/\\/g, '/')
      return r.dir ? `  [folder] ${name}/` : `  ${name}  ${size(r.size)}  ${when(r.mtime)}`
    })
    return [head, ...lines, rows.length > max ? `  …and ${rows.length - max} more.` : ''].filter(Boolean).join('\n')
  }

  async search(op: Extract<FileOp, { kind: 'search' }>): Promise<string> {
    const words = op.query.toLowerCase().split(/\s+/).filter(Boolean)
    const exts = (op.ext ?? []).map(e => e.toLowerCase().replace(/^\./, '')).filter(Boolean)
    if (!words.length && !exts.length && !op.days) throw new Error('Search by name words, file types or how recent.')
    const roots = op.in ? [await this.resolvePath(op.in, 'read')] : this.deps.folders().map(f => ({ path: f.path, folder: f }))
    const since = op.days ? this.now() - op.days * 86_400_000 : 0
    const max = Math.min(Math.max(1, op.limit ?? 50), 300)
    const hits: { path: string; size: number; mtime: number; dir: boolean }[] = []
    let visited = 0
    const walk = async (dir: string, depth: number) => {
      if (depth > 10 || visited > MAX_WALK) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        visited++
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(lower(e.name)) || e.name.startsWith('.')) continue
        } else if (SKIP_FILES.test(e.name)) continue
        const p = join(dir, e.name)
        const name = lower(e.name)
        const extOk = !exts.length || (!e.isDirectory() && exts.some(x => name.endsWith(`.${x}`)))
        const wordsOk = words.every(w => name.includes(w))
        if (extOk && wordsOk) {
          const s = await stat(p).catch(() => null)
          if (s && s.mtimeMs >= since) hits.push({ path: p, size: s.size, mtime: s.mtimeMs, dir: s.isDirectory() })
        }
        if (e.isDirectory()) await walk(p, depth + 1)
      }
    }
    for (const r of roots) await walk(r.path, 0)
    if (!hits.length) return `Nothing found${visited > MAX_WALK ? ' (stopped after 30,000 entries; narrow it to one folder)' : ''}.`
    hits.sort((a, b) => b.mtime - a.mtime)
    return [
      `${hits.length} found${hits.length > max ? `, newest ${max} shown` : ''}:`,
      ...hits.slice(0, max).map(h => `  ${this.show(h.path)}${h.dir ? '/' : `  ${size(h.size)}`}  ${when(h.mtime)}`),
    ].join('\n')
  }

  /** A file's text: Word, Excel, PowerPoint, PDF or plain text (the owner confirms each read). */
  async read(path: string): Promise<string> {
    const r = await this.resolvePath(path, 'read')
    const st = await stat(r.path)
    if (st.isDirectory()) return this.list(path, false)
    return readDocument(r.path, this.show(r))
  }

  /** Moves or copies; `to` is a folder (existing, or ending in /) or a full new name. Creates missing folders. */
  async move(items: { from: string; to: string }[], copy: boolean, by: string, summary?: string): Promise<string> {
    if (!items.length) throw new Error('Nothing to move.')
    if (items.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} at a time.`)
    const changes: FileChange[] = []
    const done: string[] = []
    const failed: string[] = []
    for (const item of items) {
      try {
        const from = await this.resolvePath(item.from, 'organise')
        if (!existsSync(from.path)) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
        if (lower(from.path) === lower(normalize(from.folder.path))) throw new Error('a chosen folder itself cannot be moved')
        const toFolder = /[\\/]$/.test(item.to.trim())
        let dest = await this.resolvePath(item.to, 'organise')
        let target = dest.path
        const isDir = existsSync(target) && (await stat(target)).isDirectory()
        if (toFolder || isDir) target = join(target, basename(from.path))
        if (target === from.path) continue
        if (inside(target, from.path)) throw new Error('cannot move a folder into itself')
        // Same file, different letter case: Windows renames in place.
        const caseOnly = lower(target) === lower(from.path)
        const free = caseOnly ? target : await this.freeName(target)
        for (const d of await this.makeDirs(dirname(free))) changes.push({ kind: 'mkdir', path: d })
        await this.moveOne(from.path, free, copy)
        changes.push(copy ? { kind: 'copy', from: from.path, to: free } : { kind: 'move', from: from.path, to: free })
        dest = { ...dest, path: free }
        done.push(`${this.show(from)} → ${this.show(dest)}${free !== target ? ' (name was taken)' : ''}`)
      } catch (e) {
        failed.push(this.friendlyError(e, item.from))
      }
    }
    const verb = copy ? 'Copied' : 'Moved'
    const batch = this.record(summary ?? `${verb} ${done.length} item(s)${done.length === 1 ? `: ${done[0]}` : ''}`, by, changes)
    return [
      done.length ? `${verb} ${done.length}:` : `Nothing was ${copy ? 'copied' : 'moved'}.`,
      ...done.slice(0, 60).map(d => `  ${d}`),
      done.length > 60 ? `  …and ${done.length - 60} more.` : '',
      ...failed.map(f => `  Failed: ${f}`),
      batch ? `(Undo is available: batch ${batch.id.slice(0, 8)}.)` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  async makeFolder(path: string, by: string): Promise<string> {
    const r = await this.resolvePath(path, 'organise')
    if (existsSync(r.path)) return `${this.show(r)} already exists.`
    const made = await this.makeDirs(r.path)
    this.record(`Made folder ${this.show(r)}`, by, made.map(d => ({ kind: 'mkdir', path: d })))
    return `Made ${this.show(r)}.`
  }

  async trash(paths: string[], by: string): Promise<string> {
    if (!paths.length) throw new Error('Nothing to remove.')
    if (paths.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} at a time.`)
    const changes: FileChange[] = []
    const done: string[] = []
    const failed: string[] = []
    for (const p of paths) {
      try {
        const r = await this.resolvePath(p, 'organise')
        if (lower(r.path) === lower(normalize(r.folder.path))) throw new Error('a chosen folder itself cannot be removed')
        if (!existsSync(r.path)) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
        await this.deps.trash(r.path)
        changes.push({ kind: 'trash', path: r.path })
        done.push(this.show(r))
      } catch (e) {
        failed.push(this.friendlyError(e, p))
      }
    }
    this.record(`Moved ${done.length} item(s) to the Recycle Bin${done.length === 1 ? `: ${done[0]}` : ''}`, by, changes)
    return [
      done.length ? `Moved ${done.length} to the Recycle Bin (restorable from there):` : 'Nothing was removed.',
      ...done.slice(0, 60).map(d => `  ${d}`),
      ...failed.map(f => `  Failed: ${f}`),
    ].join('\n')
  }

  /** Loose files at the top of a folder into subfolders by type, month or year. A plan unless `apply`. */
  async organize(folder: string, by: OrganizeBy, apply: boolean, requestedBy: string): Promise<string> {
    const root = await this.resolvePath(folder, apply ? 'organise' : 'read')
    const entries = await readdir(root.path, { withFileTypes: true })
    const plan = new Map<string, string[]>()
    for (const e of entries) {
      if (!e.isFile() || SKIP_FILES.test(e.name) || e.name.startsWith('.')) continue
      const s = await stat(join(root.path, e.name)).catch(() => null)
      if (!s) continue
      const d = new Date(s.mtimeMs)
      const group = by === 'type' ? typeFolderOf(e.name) : by === 'year' ? String(d.getFullYear()) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      plan.set(group, [...(plan.get(group) ?? []), e.name])
    }
    const total = [...plan.values()].reduce((n, l) => n + l.length, 0)
    if (!total) return `${this.show(root)} has no loose files to organise.`
    const groups = [...plan.entries()].sort((a, b) => b[1].length - a[1].length)
    if (!apply) {
      return [
        `Plan for ${this.show(root)} (${total} loose file(s), by ${by}); nothing moved yet:`,
        ...groups.map(([g, names]) => `  ${g}/: ${names.length} (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''})`),
        root.folder.access === 'organise' ? 'Ask the owner, then call again with apply: true.' : `${root.folder.name} is read-only; the owner must allow organising it in Files first.`,
      ].join('\n')
    }
    const items = groups.flatMap(([g, names]) => names.map(n => ({ from: join(root.path, n), to: `${join(root.path, g)}${sep}` })))
    const result = await this.move(items.slice(0, MAX_BATCH), false, requestedBy, `Organised ${this.show(root)} by ${by}: ${groups.map(([g, n]) => `${g} ${n.length}`).join(', ')}`)
    return `${result}${items.length > MAX_BATCH ? `\nOnly the first ${MAX_BATCH} were moved; run it again for the rest.` : ''}`
  }

  async undo(batchId?: string): Promise<string> {
    const history = this.deps.history()
    const batch = batchId ? history.find(b => b.id === batchId || b.id.startsWith(batchId)) : history.find(b => !b.undoneAt)
    if (!batch) return batchId ? 'No such change in the history.' : 'Nothing to undo.'
    if (batch.undoneAt) return `"${batch.summary}" was already undone.`
    const notes: string[] = []
    let reverted = 0
    for (const c of [...batch.changes].reverse()) {
      try {
        if (c.kind === 'move') {
          if (!existsSync(c.to)) notes.push(`${basename(c.to)} is no longer where Atlas put it`)
          else if (existsSync(c.from)) notes.push(`something new is at ${basename(c.from)}'s old place; left ${basename(c.to)} where it is`)
          else {
            await mkdir(dirname(c.from), { recursive: true })
            await this.moveOne(c.to, c.from, false)
            reverted++
          }
        } else if (c.kind === 'copy') {
          if (existsSync(c.to)) {
            await this.deps.trash(c.to)
            reverted++
          }
        } else if (c.kind === 'mkdir') {
          if (existsSync(c.path) && !(await readdir(c.path)).length) {
            await rmdir(c.path)
            reverted++
          }
        } else notes.push(`${basename(c.path)} is in the Recycle Bin: restore it from there`)
      } catch (e) {
        notes.push(this.friendlyError(e, basename(c.kind === 'move' || c.kind === 'copy' ? c.to : c.path)))
      }
    }
    this.deps.setHistory(history.map(b => (b.id === batch.id ? { ...b, undoneAt: this.now() } : b)))
    return [`Undid "${batch.summary}" (${reverted} change(s) reversed).`, ...notes.map(n => `  Note: ${n}.`)].join('\n')
  }

  historyText(limit = 10): string {
    const h = this.deps.history().slice(0, Math.min(Math.max(1, limit), 50))
    if (!h.length) return 'No file changes yet.'
    return h.map(b => `${when(b.at)} [${b.id.slice(0, 8)}] ${b.summary} (by ${b.by})${b.undoneAt ? ' — undone' : ''}`).join('\n')
  }
}
