/**
 * IPC for the Learning screen. Main checks every id and relays to the
 * runtime host, which owns the database; pushes from the host go straight
 * to the window.
 */
import { shell } from './host/index.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isLearningId, isMemoryPath, LC, type MemoryFileEntry, type MemoryFileText, type LearningHostEvent, type LearningHostRequest, type LearningOp, type LearningView } from '../shared/learning.ts'

export interface LearningIpcDeps {
  handle: <T>(channel: string, fn: (arg: unknown, arg2: unknown, arg3?: unknown) => T | Promise<T>) => void
  post: (msg: LearningHostRequest) => boolean
  isReady: () => boolean
  toRenderer: (channel: string, payload: unknown) => void
  /** Owner check: learning shows private memories. */
  requireOwner: () => void
  /** Where MEMORY.md and the daily notes are (readable before the runtime is ready, a fresh server too). */
  memoryDir: () => string
}

export const registerLearningIpc = (deps: LearningIpcDeps) => {
  const pending = new Map<string, (e: Extract<LearningHostEvent, { type: 'learning' }>) => void>()

  const ask = (op: LearningOp, timeoutMs = 10_000) =>
    new Promise<LearningView>((resolve, reject) => {
      deps.requireOwner()
      if (!deps.isReady()) return reject(new Error('The assistant is not ready yet.'))
      const requestId = randomUUID()
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('The runtime did not answer in time.'))
      }, timeoutMs)
      pending.set(requestId, e => {
        clearTimeout(timer)
        if (e.view) resolve(e.view)
        else reject(new Error(e.error ?? 'Learning request failed.'))
      })
      if (!deps.post({ type: 'learning', requestId, op })) {
        clearTimeout(timer)
        pending.delete(requestId)
        reject(new Error('The runtime is not running.'))
      }
    })

  const id = (v: unknown) => {
    if (!isLearningId(v)) throw new Error('Unknown item.')
    return v
  }

  deps.handle(LC.get, () => ask({ kind: 'get' }))
  deps.handle(LC.decide, (v, accept) => {
    if (typeof accept !== 'boolean') throw new Error('Expected yes or no.')
    return ask({ kind: 'decide', id: id(v), accept })
  })
  deps.handle(LC.forget, v => ask({ kind: 'forget', id: id(v) }))
  deps.handle(LC.removeWorkflow, v => ask({ kind: 'remove-workflow', id: id(v) }))
  deps.handle(LC.dropFollowup, v => ask({ kind: 'drop-followup', id: id(v) }))
  deps.handle(LC.skillUpdate, (v, patch) => {
    const p = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>
    const status = p.status === 'active' || p.status === 'paused' ? p.status : undefined
    const auto = typeof p.auto === 'boolean' ? p.auto : undefined
    if (status === undefined && auto === undefined) throw new Error('Nothing to change.')
    return ask({ kind: 'skill-update', id: id(v), status, auto })
  })
  deps.handle(LC.skillDelete, v => ask({ kind: 'skill-delete', id: id(v) }))
  deps.handle(LC.skillRun, v => ask({ kind: 'skill-run', id: id(v) }))
  deps.handle(LC.teach, () => ask({ kind: 'teach' }))
  // A learning pass makes one model call; give it time.
  deps.handle(LC.runNow, () => ask({ kind: 'run' }, 120_000))
  deps.handle(LC.improvementDone, v => ask({ kind: 'improvement-done', id: id(v) }))
  deps.handle(LC.improvementRemove, v => ask({ kind: 'improvement-remove', id: id(v) }))
  deps.handle(LC.welcomeReset, () => ask({ kind: 'welcome-reset' }))
  deps.handle(LC.semantic, on => {
    if (typeof on !== 'boolean') throw new Error('On or off.')
    // The first time downloads the model: allow for it.
    return ask({ kind: 'semantic', on }, 60_000)
  })
  deps.handle(LC.openMemory, async what => {
    const v = await ask({ kind: 'get' })
    const target = what === 'folder' ? v.memory.folder : v.memory.file
    if (!target) throw new Error('The memory files are not ready yet.')
    const err = await shell.openPath(target)
    if (err) throw new Error(err)
  })
  // The memory files in the page: they sit with the brain (a server too), so the page reads and saves them here.
  const memoryFolder = async () => {
    deps.requireOwner()
    const dir = deps.memoryDir()
    if (!existsSync(join(dir, 'MEMORY.md'))) throw new Error('The memory files are not ready yet.')
    return dir
  }
  const entry = (folder: string, path: string): MemoryFileEntry => {
    const st = statSync(join(folder, path))
    return { path, size: st.size, modified: st.mtimeMs, editable: path === 'MEMORY.md' }
  }
  deps.handle(LC.memoryList, async () => {
    const folder = await memoryFolder()
    const days = existsSync(join(folder, 'memory')) ? readdirSync(join(folder, 'memory')).map(n => `memory/${n}`).filter(isMemoryPath) : []
    return [...(existsSync(join(folder, 'MEMORY.md')) ? ['MEMORY.md'] : []), ...days.sort().reverse()].map(p => entry(folder, p))
  })
  deps.handle(LC.memoryRead, async path => {
    if (!isMemoryPath(path)) throw new Error('Not one of the memory files.')
    const folder = await memoryFolder()
    if (!existsSync(join(folder, path))) throw new Error('That file is gone.')
    const e = entry(folder, path)
    if (e.size > 2 * 1024 * 1024) throw new Error('That file is too large to show here.')
    return { ...e, text: readFileSync(join(folder, path), 'utf8') } satisfies MemoryFileText
  })
  deps.handle(LC.memorySave, async (path, text, modified) => {
    if (path !== 'MEMORY.md') throw new Error('Only MEMORY.md is edited here; the daily notes are a record.')
    if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new Error('That is too long.')
    const folder = await memoryFolder()
    const file = join(folder, path)
    // Changed since it was opened (Atlas learned something, or another page saved): never overwrite it blind.
    if (typeof modified === 'number' && existsSync(file) && statSync(file).mtimeMs > modified + 1) throw new Error('MEMORY.md changed since you opened it. Reload it, then make your change again.')
    writeFileSync(file, text)
    return { ...entry(folder, path), text } satisfies MemoryFileText
  })
  deps.handle(LC.improvementProject, v => {
    if (v !== null && (typeof v !== 'string' || !v.trim() || v.length > 200)) throw new Error('Choose a project.')
    return ask({ kind: 'improvement-project', name: v })
  })

  return {
    onHostEvent(e: LearningHostEvent) {
      if (e.type === 'learning-changed') return deps.toRenderer(LC.changed, e.view)
      pending.get(e.requestId)?.(e)
      pending.delete(e.requestId)
    },
  }
}
