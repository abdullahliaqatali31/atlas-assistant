/**
 * The brain view, main side: relays the owner's requests to the runtime
 * (which owns the memory database) and pushes "memories used" to the window.
 * Owner-only: these are private memories.
 */
import { randomUUID } from 'node:crypto'

import { BR, type BrainHostEvent, type BrainHostRequest, type BrainOp } from '../shared/brain.ts'

export const registerBrainIpc = (deps: {
  handle: <T>(channel: string, fn: (a: unknown) => T | Promise<T>) => void
  post: (msg: BrainHostRequest) => boolean
  isReady: () => boolean
  toRenderer: (channel: string, payload: unknown) => void
}) => {
  const pending = new Map<string, (e: Extract<BrainHostEvent, { type: 'brain' }>) => void>()
  const ask = (op: BrainOp, timeout = 10_000) =>
    new Promise<Extract<BrainHostEvent, { type: 'brain' }> | null>((resolve, reject) => {
      if (!deps.isReady()) return resolve(null)
      const requestId = randomUUID()
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('The runtime did not answer in time.'))
      }, timeout)
      pending.set(requestId, e => {
        clearTimeout(timer)
        if (e.error) reject(new Error(e.error))
        else resolve(e)
      })
      if (!deps.post({ type: 'brain', requestId, op })) {
        clearTimeout(timer)
        pending.delete(requestId)
        resolve(null)
      }
    })
  deps.handle(BR.view, async () => (await ask({ kind: 'view' }))?.view ?? null)
  deps.handle(BR.find, async refresh => (await ask({ kind: 'find', refresh: refresh === true }, 60_000))?.find ?? null)
  deps.handle(BR.forget, id => {
    if (typeof id !== 'string' || !/^[\w-]{6,64}$/.test(id)) throw new Error('Unknown memory.')
    return ask({ kind: 'forget', id }).then(e => e?.view ?? null)
  })
  return {
    onHostEvent(e: BrainHostEvent) {
      if (e.type === 'memory-used') return deps.toRenderer(BR.used, { ids: e.ids, why: e.why })
      pending.get(e.requestId)?.(e)
      pending.delete(e.requestId)
    },
  }
}
