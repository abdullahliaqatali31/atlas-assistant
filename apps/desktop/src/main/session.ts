/**
 * OS session watcher: lock/unlock, sleep/resume and idle from Electron's
 * powerMonitor, reported as typed changes for the runtime. Returns carry how
 * long the owner was away so the runtime can decide on a welcome back.
 */
import { powerMonitor } from 'electron'

import type { SessionChange } from '../shared/ipc.ts'

/** No keyboard or mouse input for this long counts as away. */
export const IDLE_AFTER_MS = 5 * 60_000
const POLL_MS = 5_000

export const watchSession = (onChange: (c: SessionChange) => void) => {
  let lockedAt: number | null = null
  let sleptAt: number | null = null
  let idleSince: number | null = null
  const awaySince = () => Math.min(lockedAt ?? Infinity, sleptAt ?? Infinity, idleSince ?? Infinity)

  const onLock = () => {
    lockedAt ??= Date.now()
    onChange({ signal: 'lock' })
  }
  const onUnlock = () => {
    const since = awaySince()
    lockedAt = sleptAt = idleSince = null
    onChange({ signal: 'unlock', idleMs: Number.isFinite(since) ? Date.now() - since : 0 })
  }
  const onSuspend = () => {
    sleptAt ??= Date.now()
    onChange({ signal: 'suspend' })
  }
  const onResume = () => {
    const since = awaySince()
    sleptAt = null
    onChange({ signal: 'resume', idleMs: Number.isFinite(since) ? Date.now() - since : 0 })
  }

  powerMonitor.on('lock-screen', onLock)
  powerMonitor.on('unlock-screen', onUnlock)
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('resume', onResume)

  const poll = setInterval(() => {
    if (lockedAt !== null || sleptAt !== null) return
    const idleMs = powerMonitor.getSystemIdleTime() * 1_000
    if (idleSince === null && idleMs >= IDLE_AFTER_MS) {
      idleSince = Date.now() - idleMs
      onChange({ signal: 'idle' })
    } else if (idleSince !== null && idleMs < IDLE_AFTER_MS) {
      const away = Date.now() - idleSince - idleMs
      idleSince = null
      onChange({ signal: 'active', idleMs: away })
    }
  }, POLL_MS)
  poll.unref()

  return {
    /** Windows itself is locked (its sign-in screen is up). */
    get osLocked() {
      return lockedAt !== null
    },
    /** What a freshly (re)started runtime should assume. */
    get away(): 'lock' | 'suspend' | 'idle' | undefined {
      return sleptAt !== null ? 'suspend' : lockedAt !== null ? 'lock' : idleSince !== null ? 'idle' : undefined
    },
    stop() {
      clearInterval(poll)
      powerMonitor.off('lock-screen', onLock)
      powerMonitor.off('unlock-screen', onUnlock)
      powerMonitor.off('suspend', onSuspend)
      powerMonitor.off('resume', onResume)
    },
  }
}
