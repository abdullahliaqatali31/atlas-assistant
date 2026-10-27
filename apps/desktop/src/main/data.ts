/**
 * IPC for the Activity (opt-in window tracking) and Projects screens. Main
 * owns the activity settings (activity.json in userData) and validates every
 * payload; the runtime host owns the database and answers by request id.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DEFAULT_EXCLUDED_APPS } from '@assistant/runtime/activity-defaults'
import { app } from './host/index.ts'

import { AC, parseAppName, parseHours, RETENTION_DAYS, type ActivityHostEvent, type ActivityHostRequest, type ActivitySettings, type ActivityView } from '../shared/activity.ts'
import { parseProjectOp, PJ, type ProjectOp, type ProjectsHostEvent, type ProjectsHostRequest } from '../shared/projects.ts'

const TIMEOUT_MS = 10_000

export interface DataIpcDeps {
  /** Registers a handler that already checks the sender frame. */
  handle: <T>(channel: string, fn: (arg: unknown, arg2: unknown, arg3?: unknown) => T | Promise<T>) => void
  /** False when the runtime host is not running. */
  post: (msg: ActivityHostRequest | ProjectsHostRequest) => boolean
  isReady: () => boolean
  toRenderer: (channel: string, payload: unknown) => void
}

const settingsFile = () => join(app.getPath('userData'), 'activity.json')

export const readActivitySettings = (): ActivitySettings => {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<ActivitySettings>
    const excluded = Array.isArray(raw.excludedApps) ? raw.excludedApps.map(parseAppName).filter((a): a is string => a !== null) : [...DEFAULT_EXCLUDED_APPS]
    return { enabled: raw.enabled === true, excludedApps: [...new Set(excluded)] }
  } catch {
    // Off by default; the defaults keep password managers out even before the owner looks.
    return { enabled: false, excludedApps: [...DEFAULT_EXCLUDED_APPS] }
  }
}

const writeActivitySettings = (s: ActivitySettings) => {
  const path = settingsFile()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, `${JSON.stringify(s, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}

export const registerDataIpc = (deps: DataIpcDeps) => {
  const pending = new Map<string, (e: ActivityHostEvent | Extract<ProjectsHostEvent, { type: 'projects' }>) => void>()

  const ask = <E extends ActivityHostEvent | Extract<ProjectsHostEvent, { type: 'projects' }>>(msg: { type: 'activity'; op: Extract<ActivityHostRequest, { type: 'activity' }>['op'] } | { type: 'projects'; op: ProjectOp }) =>
    new Promise<E>((resolve, reject) => {
      if (!deps.isReady()) return reject(new Error('The assistant is not ready yet.'))
      const requestId = randomUUID()
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('The runtime did not answer in time.'))
      }, TIMEOUT_MS)
      pending.set(requestId, e => {
        clearTimeout(timer)
        resolve(e as E)
      })
      if (!deps.post({ ...msg, requestId } as ActivityHostRequest | ProjectsHostRequest)) {
        clearTimeout(timer)
        pending.delete(requestId)
        reject(new Error('The runtime is not running.'))
      }
    })

  // ── activity ──

  const activityView = async (hours = 24): Promise<ActivityView> => {
    const settings = readActivitySettings()
    const empty = { hours, totalMinutes: 0, apps: [] }
    if (!deps.isReady()) return { ...settings, available: process.platform === 'win32', retentionDays: RETENTION_DAYS, summary: empty }
    const e = await ask<ActivityHostEvent>({ type: 'activity', op: { kind: 'summary', hours } })
    if (e.error) throw new Error(e.error)
    return { ...settings, available: e.available ?? process.platform === 'win32', retentionDays: RETENTION_DAYS, summary: e.summary ?? empty }
  }

  const changeSettings = async (fn: (s: ActivitySettings) => ActivitySettings) => {
    const next = fn(readActivitySettings())
    writeActivitySettings(next)
    deps.post({ type: 'set-activity', settings: next })
    const v = await activityView()
    deps.toRenderer(AC.changed, v)
    return v
  }

  deps.handle(AC.get, hours => {
    const h = parseHours(hours)
    if (h === null) throw new Error('Hours must be a whole number from 1 to 168.')
    return activityView(h)
  })
  deps.handle(AC.setEnabled, enabled => {
    if (typeof enabled !== 'boolean') throw new Error('Expected true or false.')
    return changeSettings(s => ({ ...s, enabled }))
  })
  deps.handle(AC.addExcluded, name => {
    const a = parseAppName(name)
    if (!a) throw new Error('Give the application’s process name, e.g. WhatsApp or KeePassXC.')
    // Excluding an app also forgets what was already recorded for it.
    return changeSettings(s => ({ ...s, excludedApps: [...new Set([...s.excludedApps, a])] })).then(async v => {
      if (deps.isReady()) await ask<ActivityHostEvent>({ type: 'activity', op: { kind: 'clear', app: a } })
      return activityView()
    })
  })
  deps.handle(AC.removeExcluded, name => {
    const a = parseAppName(name)
    if (!a) throw new Error('No such application.')
    return changeSettings(s => ({ ...s, excludedApps: s.excludedApps.filter(x => x.toLowerCase() !== a.toLowerCase()) }))
  })
  deps.handle(AC.clear, async name => {
    const a = name === undefined ? undefined : parseAppName(name)
    if (a === null) throw new Error('No such application.')
    const e = await ask<ActivityHostEvent>({ type: 'activity', op: { kind: 'clear', app: a } })
    if (e.error) throw new Error(e.error)
    const v = await activityView()
    deps.toRenderer(AC.changed, v)
    return v
  })

  // ── projects ──

  for (const channel of [PJ.list, PJ.get, PJ.create, PJ.update, PJ.addTask, PJ.assignTask, PJ.setTaskStatus, PJ.addCommitment, PJ.assignCommitment, PJ.resolveCommitment]) {
    deps.handle(channel, async (a, b, c) => {
      const op = parseProjectOp(channel, a, b, c)
      if (typeof op === 'string') throw new Error(op)
      if (!deps.isReady()) {
        if (op.kind === 'list' || op.kind === 'get') return null
        throw new Error('The assistant is not ready yet.')
      }
      const e = await ask<Extract<ProjectsHostEvent, { type: 'projects' }>>({ type: 'projects', op })
      if (e.error) throw new Error(e.error)
      return e.result ?? null
    })
  }

  return {
    /** Sent to a (re)starting host before init. */
    initMessage: (): ActivityHostRequest => ({ type: 'set-activity', settings: readActivitySettings() }),
    onHostEvent(e: ActivityHostEvent | ProjectsHostEvent) {
      if (e.type === 'project-changed') return deps.toRenderer(PJ.changed, e.projectId)
      pending.get(e.requestId)?.(e)
      pending.delete(e.requestId)
    },
  }
}
