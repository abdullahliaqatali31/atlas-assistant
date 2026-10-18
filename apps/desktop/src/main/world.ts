/**
 * The live world, main side: keeps the runtime's latest snapshot for the
 * World page and relays the page's requests (add or remove a place, refresh).
 */
import { randomUUID } from 'node:crypto'

import type { HostEvent, HostRequest } from '../shared/ipc.ts'
import { EMPTY_WORLD, WLD, type WorldOp, type WorldSnapshot } from '../shared/world.ts'

const TIMEOUT_MS = 60_000

export class WorldService {
  private snapshot: WorldSnapshot = EMPTY_WORLD
  private readonly pending = new Map<string, (error?: string) => void>()

  constructor(
    private readonly deps: {
      handle: <T>(channel: string, fn: (a: unknown, b: unknown) => T | Promise<T>) => void
      toRenderer: (channel: string, payload: unknown) => void
      toRuntime: (msg: Extract<HostRequest, { type: 'world-op' }>) => boolean
      requireOwner: () => void
    },
  ) {}

  onHostEvent(e: Extract<HostEvent, { type: 'world' | 'world-result' }>) {
    if (e.type === 'world') {
      this.snapshot = e.snapshot
      this.deps.toRenderer(WLD.changed, e.snapshot)
      return
    }
    this.pending.get(e.requestId)?.(e.error)
    this.pending.delete(e.requestId)
  }

  private ask(op: WorldOp): Promise<WorldSnapshot> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The assistant did not answer in time.'))
      }, TIMEOUT_MS)
      this.pending.set(requestId, error => {
        clearTimeout(timer)
        if (error) reject(new Error(error))
        else resolve(this.snapshot)
      })
      if (!this.deps.toRuntime({ type: 'world-op', requestId, op })) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new Error('The assistant is not ready yet.'))
      }
    })
  }

  register() {
    const { handle } = this.deps
    const owner = <T>(fn: (a: unknown) => T | Promise<T>) => (a: unknown) => {
      this.deps.requireOwner()
      return fn(a)
    }
    handle(WLD.state, owner(() => this.snapshot))
    handle(WLD.add, owner(name => {
      if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Type a city or place.')
      return this.ask({ kind: 'add', name: name.trim() })
    }))
    handle(WLD.remove, owner(id => {
      if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id)) throw new Error('Unknown place.')
      return this.ask({ kind: 'remove', id })
    }))
    handle(WLD.refresh, owner(() => this.ask({ kind: 'refresh' })))
  }
}
