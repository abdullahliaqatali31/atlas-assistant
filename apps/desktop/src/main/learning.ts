/**
 * IPC for the Learning screen. Main checks every id and relays to the
 * runtime host, which owns the database; pushes from the host go straight
 * to the window.
 */
import { shell } from './host/index.ts'
import { randomUUID } from 'node:crypto'

import { isLearningId, LC, type LearningHostEvent, type LearningHostRequest, type LearningOp, type LearningView } from '../shared/learning.ts'

export interface LearningIpcDeps {
  handle: <T>(channel: string, fn: (arg: unknown, arg2: unknown) => T | Promise<T>) => void
  post: (msg: LearningHostRequest) => boolean
  isReady: () => boolean
  toRenderer: (channel: string, payload: unknown) => void
  /** Owner check: learning shows private memories. */
  requireOwner: () => void
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
