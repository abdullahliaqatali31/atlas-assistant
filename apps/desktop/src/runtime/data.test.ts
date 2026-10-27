import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '@assistant/memory'
import type { WindowSample } from '@assistant/runtime'
import { fixedClock, MINUTE } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { parseAppName, parseHours } from '../shared/activity.ts'
import { parseProjectOp, PJ, type ProjectDetailView, type ProjectOp } from '../shared/projects.ts'
import { HostActivity } from './activity.ts'
import { runProjectsOp } from './projects.ts'
import { parseSampleLine } from './window-sampler.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const store = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-data-'))
  dirs.push(dir)
  const clock = fixedClock(Date.UTC(2026, 9, 17, 4))
  return { clock, memory: new MemoryStore(join(dir, 'a.db'), clock) }
}

describe('HostActivity', () => {
  it('starts the sampler only when the owner opts in, pauses on lock and stops when switched off', () => {
    const { clock, memory } = store()
    let emit: ((s: WindowSample) => void) | null = null
    let running = 0
    const activity = new HostActivity({
      memory,
      clock,
      startSampler: onSample => {
        emit = onSample
        running++
        return { stop: () => running-- }
      },
      log: () => undefined,
    })
    activity.configure({ enabled: false, excludedApps: [] })
    expect(running).toBe(0)
    expect(activity.briefingSources()).toEqual([])

    activity.configure({ enabled: true, excludedApps: ['WhatsApp'] })
    expect(running).toBe(1)
    emit!({ app: 'EXCEL.EXE', title: 'Quote_v3.xlsx' })
    clock.advance(30 * MINUTE)
    activity.session({ signal: 'lock' })
    clock.advance(60 * MINUTE)
    activity.session({ signal: 'unlock', idleMs: 60 * MINUTE })
    clock.advance(10 * MINUTE)
    emit!({ app: 'WhatsApp', title: 'Client chat' })
    clock.advance(10 * MINUTE)
    const summary = activity.summary(24)
    expect(summary.apps.map(a => [a.app, a.minutes])).toEqual([['EXCEL', 40]])
    expect(activity.briefingSources().map(s => s.label)).toEqual(['Window activity'])

    activity.configure({ enabled: false, excludedApps: [] })
    expect(running).toBe(0)
    memory.close()
  })

  it('reports unavailable where there is no sampler, and clears one app on request', () => {
    const { clock, memory } = store()
    memory.recordWindowSpan({ app: 'chrome', title: 'x', startedAt: clock.now() - 20 * MINUTE, endedAt: clock.now() - 10 * MINUTE })
    memory.recordWindowSpan({ app: 'Code', title: 'y', startedAt: clock.now() - 20 * MINUTE, endedAt: clock.now() - 10 * MINUTE })
    const activity = new HostActivity({ memory, clock, startSampler: () => null, log: () => undefined })
    activity.configure({ enabled: true, excludedApps: [] })
    const e = activity.handle({ type: 'activity', requestId: 'r', op: { kind: 'clear', app: 'chrome' } })
    expect(e.available).toBe(false)
    expect(e.summary?.apps.map(a => a.app)).toEqual(['Code'])
    memory.close()
  })

  it('parses only well-formed sampler lines', () => {
    expect(parseSampleLine('{"app":"EXCEL","title":"Quote آج"}')).toEqual({ app: 'EXCEL', title: 'Quote آج' })
    expect(parseSampleLine('{"app":1}')).toBeNull()
    expect(parseSampleLine('not json')).toBeNull()
  })

  it('validates activity IPC input', () => {
    expect(parseAppName(' WhatsApp.exe ')).toBe('WhatsApp')
    expect(parseAppName('../../etc')).toBeNull()
    expect(parseAppName('')).toBeNull()
    expect(parseHours(undefined)).toBe(24)
    expect(parseHours(169)).toBeNull()
  })
})

describe('Projects IPC', () => {
  const op = (channel: string, a?: unknown, b?: unknown, c?: unknown) => {
    const parsed = parseProjectOp(channel, a, b, c)
    if (typeof parsed === 'string') throw new Error(parsed)
    return parsed
  }

  it('creates a project and keeps its tasks and commitments together', () => {
    const { memory, clock } = store()
    const run = (o: ProjectOp) => runProjectsOp(memory, clock, 'Hamza', o)

    const created = run(op(PJ.create, { name: 'Client quote', goals: 'Send revised quote' }))
    const project = created.result as ProjectDetailView
    expect(created.changed).toBe(project.id)
    expect(() => run(op(PJ.create, { name: 'client QUOTE' }))).toThrow(/already exists/)

    let d = run(op(PJ.addTask, project.id, { title: 'Review drawings', dueAt: clock.now() + 3_600_000 })).result as ProjectDetailView
    d = run(op(PJ.addCommitment, project.id, { what: 'Send revised quote', toWhom: 'client', dueAt: clock.now() + 86_400_000 })).result as ProjectDetailView
    expect(d.tasks.map(t => [t.title, t.status])).toEqual([['Review drawings', 'ready']])
    expect(d.commitments).toMatchObject([{ who: 'Hamza', what: 'Send revised quote', toWhom: 'client', source: 'owner', resolvedAt: null }])

    // A task from elsewhere can be moved in.
    const loose = memory.addTask('Call supplier')
    d = run(op(PJ.assignTask, loose, project.id)).result as ProjectDetailView
    expect(d.tasks).toHaveLength(2)

    // Completion still needs evidence.
    const taskId = d.tasks.find(t => t.title === 'Review drawings')!.id
    expect(() => run(op(PJ.setTaskStatus, taskId, 'completed'))).toThrow(/evidence/)
    d = run(op(PJ.setTaskStatus, taskId, 'completed', 'Drawings checked with the client on the call')).result as ProjectDetailView
    expect(d.tasks.at(-1)).toMatchObject({ title: 'Review drawings', status: 'completed', evidence: 'Drawings checked with the client on the call' })

    const commitmentId = d.commitments[0]!.id
    d = run(op(PJ.resolveCommitment, commitmentId, 'Quote sent by email')).result as ProjectDetailView
    expect(d.commitments[0]).toMatchObject({ resolution: 'Quote sent by email' })
    expect(() => run(op(PJ.resolveCommitment, commitmentId, 'again'))).toThrow(/already resolved/)

    d = run(op(PJ.update, project.id, { status: 'paused', state: 'Waiting on client sign-off' })).result as ProjectDetailView
    expect(d).toMatchObject({ status: 'paused', state: 'Waiting on client sign-off' })
    const list = run(op(PJ.list)).result as { name: string; openTasks: number; openCommitments: number }[]
    expect(list).toMatchObject([{ name: 'Client quote', openTasks: 1, openCommitments: 0 }])
    run(op(PJ.update, project.id, { status: 'archived' }))
    expect(run(op(PJ.list)).result).toEqual([])
    expect(run(op(PJ.list, true)).result).toHaveLength(1)
    memory.close()
  })

  it('rejects malformed calls before they reach the runtime', () => {
    expect(parseProjectOp(PJ.create, { name: '' }, undefined)).toMatch(/name/)
    expect(parseProjectOp(PJ.get, 'x; DROP TABLE', undefined)).toMatch(/No such/)
    expect(parseProjectOp(PJ.update, '0123456789abcdef', { status: 'deleted' })).toMatch(/status/)
    expect(parseProjectOp(PJ.addTask, '0123456789abcdef', { title: 'x', dueAt: 'tomorrow' })).toMatch(/due/)
    expect(parseProjectOp(PJ.setTaskStatus, '0123456789abcdef', 'done')).toMatch(/status/)
    expect(parseProjectOp(PJ.resolveCommitment, '0123456789abcdef', '  ')).toMatch(/note/)
    expect(parseProjectOp('projects:drop', 1, 2)).toMatch(/Unknown/)
  })
})
