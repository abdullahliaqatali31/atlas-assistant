/**
 * Files, main side: the folders the owner chose (and what Atlas may do in
 * each), the change history, the Files page IPC, and the model's file tools.
 * Removing uses the Windows Recycle Bin.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, normalize, resolve } from 'node:path'

import { app, dialog, shell, type OpenDialogOptions } from '../host/index.ts'

import { FC, isFileAccess, type FileBatchView, type FileFolderView, type FileOp, type FilesState } from '../../shared/files.ts'
import { notAProject } from '../code/discover.ts'
import { FileOps } from './ops.ts'

interface FilesFile {
  folders: FileFolderView[]
  history: FileBatchView[]
}

const writeAtomic = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, p)
}

export class FileService {
  private readonly file = join(app.getPath('userData'), 'files.json')
  private data: FilesFile
  readonly ops: FileOps

  constructor(
    private readonly deps: {
      handle: <T>(channel: string, fn: (a: unknown, b: unknown) => T | Promise<T>) => void
      toRenderer: (channel: string, payload: unknown) => void
      window: () => unknown
      requireOwner: () => void
      log: (level: 'info' | 'warn' | 'error', message: string) => void
    },
  ) {
    this.data = this.load()
    this.ops = new FileOps({
      folders: () => this.data.folders,
      history: () => this.data.history,
      setHistory: h => {
        this.data.history = h
        this.save()
        this.publish()
      },
      trash: p => shell.trashItem(p),
    })
  }

  private load(): FilesFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FilesFile>
      return { folders: Array.isArray(raw.folders) ? raw.folders : [], history: Array.isArray(raw.history) ? raw.history : [] }
    } catch {
      return { folders: [], history: [] }
    }
  }

  private save() {
    writeAtomic(this.file, `${JSON.stringify(this.data, null, 2)}\n`)
  }

  state(): FilesState {
    return { folders: this.data.folders, history: this.data.history.slice(0, 30) }
  }

  private publish() {
    this.deps.toRenderer(FC.changed, this.state())
  }

  add(path: string) {
    const p = normalize(resolve(path))
    if (!existsSync(p)) throw new Error('That folder does not exist.')
    if (notAProject(p) || p.toLowerCase().startsWith(normalize(app.getPath('userData')).toLowerCase())) {
      throw new Error('Pick a folder such as Downloads or Documents, not a whole drive, your home folder, system folders or app data.')
    }
    const lower = p.toLowerCase()
    if (this.data.folders.some(f => f.path.toLowerCase() === lower)) return
    // A folder inside (or around) one already chosen would give two answers for the same files.
    const overlap = this.data.folders.find(f => lower.startsWith(`${f.path.toLowerCase()}\\`) || f.path.toLowerCase().startsWith(`${lower}\\`))
    if (overlap) throw new Error(`${basename(p)} overlaps ${overlap.name}, which is already chosen.`)
    // Two folders with the same name ("Documents" on two drives): keep names unique for the model.
    let name = basename(p)
    if (this.data.folders.some(f => f.name.toLowerCase() === name.toLowerCase())) name = `${name} (${basename(dirname(p))})`
    this.data.folders.push({ id: randomUUID(), path: p, name, access: 'read', addedAt: Date.now() })
    this.save()
  }

  private async pick() {
    const win = this.deps.window()
    const opts: OpenDialogOptions = { title: 'Folders Atlas may look after', properties: ['openDirectory', 'multiSelections'] }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (picked.canceled) return
    const errors: string[] = []
    for (const f of picked.filePaths) {
      try {
        this.add(f)
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
      }
    }
    if (errors.length) throw new Error(errors.join(' '))
  }

  private folder(id: unknown): FileFolderView {
    const f = this.data.folders.find(x => x.id === id)
    if (!f) throw new Error('That folder is no longer chosen.')
    return f
  }

  /** The model's file tools; failures go back as text the model can relay. */
  handleOp(op: FileOp): Promise<string> {
    return this.ops.handle(op)
  }

  register() {
    const { handle } = this.deps
    const owner = <T>(fn: (a: unknown, b: unknown) => T | Promise<T>) => (a: unknown, b: unknown) => {
      this.deps.requireOwner()
      return fn(a, b)
    }
    const after = async (fn: () => unknown) => {
      await fn()
      this.publish()
      return this.state()
    }
    handle(FC.state, owner(() => this.state()))
    handle(FC.pick, owner(() => after(() => this.pick())))
    handle(FC.remove, owner(id => after(() => {
      const f = this.folder(id)
      this.data.folders = this.data.folders.filter(x => x.id !== f.id)
      this.save()
    })))
    handle(FC.setAccess, owner((id, access) => after(() => {
      if (!isFileAccess(access)) throw new Error('Unknown access level.')
      this.folder(id).access = access
      this.save()
      this.deps.log('info', `Files: ${this.folder(id).name} is now ${access === 'organise' ? 'organisable' : 'read-only'} for Atlas.`)
    })))
    handle(FC.undo, owner(batchId => after(async () => {
      if (typeof batchId !== 'string') throw new Error('Which change?')
      await this.ops.undo(batchId)
    })))
    handle(FC.reveal, owner(async path => {
      if (typeof path !== 'string') throw new Error('Which folder?')
      // Only places inside the chosen folders.
      const r = await this.ops.resolvePath(path, 'read')
      if (existsSync(r.path)) shell.showItemInFolder(r.path)
    }))
  }
}
