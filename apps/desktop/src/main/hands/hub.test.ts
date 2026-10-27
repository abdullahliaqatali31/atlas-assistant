import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { describeMachines, HANDS_OP, nextPresence, parseHandsMessage } from '../../shared/hands.ts'
import { HandsHub, type HubDeps } from './hub.ts'

const deps = (over: Partial<HubDeps> = {}): HubDeps => {
  const handlers = new Map<string, (a: unknown, b: unknown) => unknown>()
  return {
    file: join(mkdtempSync(join(tmpdir(), 'atlas-hub-')), 'machines.json'),
    local: null,
    toRenderer: () => undefined,
    onNote: () => undefined,
    onSession: () => undefined,
    onActive: () => undefined,
    onPresence: () => undefined,
    ticket: () => 'ticket',
    ownerLocked: () => false,
    handle: (ch, fn) => void handlers.set(ch, fn),
    requireOwner: () => undefined,
    brainUrl: () => 'http://localhost:47800',
    log: () => undefined,
    ...over,
  }
}

describe('HandsHub', () => {
  it('a server with no machine says so to the model', async () => {
    const hub = new HandsHub(deps())
    await expect(hub.call(HANDS_OP.system, [{ kind: 'status' }])).rejects.toThrow(/No PC is connected/)
  })

  it('pairs a machine once with the code, then refuses the same code', () => {
    const channels = new Map<string, (a?: unknown, b?: unknown) => unknown>() as Map<string, (...a: unknown[]) => unknown>
    const hub = new HandsHub(deps({ handle: (ch, fn) => void channels.set(ch, fn) }))
    hub.register()
    const view = channels.get('machines:new-code')!() as { code: string }
    expect(view.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    const ok = hub.pair(JSON.stringify({ code: view.code.toLowerCase().replace('-', ' '), name: 'Laptop', platform: 'mac' }))
    expect(ok.status).toBe(200)
    expect((ok.body as { token: string }).token.length).toBeGreaterThan(30)
    expect(hub.pair(JSON.stringify({ code: view.code, name: 'Again' })).status).toBe(401)
    const machines = hub.view().machines
    expect(machines).toHaveLength(1)
    // The first machine a server pairs is the one it works on; it is offline until it connects.
    expect(machines[0]).toMatchObject({ name: 'Laptop', platform: 'mac', active: true, online: false })
  })

  it('stops answering after five wrong codes', () => {
    const hub = new HandsHub(deps())
    for (let i = 0; i < 5; i++) expect(hub.pair(JSON.stringify({ code: 'WRONG-CODE' })).status).toBe(401)
    expect(hub.pair(JSON.stringify({ code: 'WRONG-CODE' })).status).toBe(429)
  })

  it('an offline active machine is named in the answer', async () => {
    const channels = new Map<string, (...a: unknown[]) => unknown>()
    const hub = new HandsHub(deps({ handle: (ch, fn) => void channels.set(ch, fn) }))
    hub.register()
    const { code } = channels.get('machines:new-code')!() as { code: string }
    hub.pair(JSON.stringify({ code, name: 'Work laptop' }))
    await expect(hub.call(HANDS_OP.files, [{}])).rejects.toThrow(/Work laptop is offline/)
  })

  it('on this PC, calls go straight to its own hands', async () => {
    const handlers = new Map<string, (a: unknown) => unknown>([[HANDS_OP.system, op => `did ${(op as { kind: string }).kind}`]])
    const hub = new HandsHub(deps({ local: { name: 'This PC', handlers, capabilities: ['system'], version: '0.4.0' } }))
    expect(hub.activeIsLocal).toBe(true)
    await expect(hub.call(HANDS_OP.system, [{ kind: 'status' }])).resolves.toBe('did status')
    // A machine's page channel is passed on; the brain's own are not.
    expect(hub.handlerFor('pc:state')).toBeTypeOf('function')
    expect(hub.handlerFor('assistant:send')).toBeUndefined()
  })
})

describe('parseHandsMessage', () => {
  it('keeps what a machine may say and drops the rest', () => {
    expect(parseHandsMessage({ t: 'hello', v: 1, name: 'PC', platform: 'linux', version: '0.4.0', capabilities: ['files', 'root'], channels: ['pc:state', 5] })).toMatchObject({ platform: 'linux', capabilities: ['files'], channels: ['pc:state'] })
    expect(parseHandsMessage({ t: 'session', line: 'lock' })).toEqual({ t: 'session', line: 'lock' })
    expect(parseHandsMessage({ t: 'session', line: 'rm -rf' })).toBeNull()
    expect(parseHandsMessage({ t: 'ask', id: 1, what: 'ticket', path: '/widget.html' })).not.toBeNull()
    expect(parseHandsMessage({ t: 'ask', id: 1, what: 'ticket', path: 'https://evil' })).toBeNull()
    expect(parseHandsMessage({ t: 'rt', note: { kind: 'shell', cmd: 'x' } })).toBeNull()
    expect(parseHandsMessage('hello')).toBeNull()
  })
})

describe('how machines are', () => {
  it('follows what a machine says', () => {
    expect(nextPresence('awake', 'suspend')).toBe('asleep')
    expect(nextPresence('asleep', 'resume')).toBe('awake')
    expect(nextPresence('awake', 'shutdown')).toBe('off')
    expect(nextPresence('awake', 'quit')).toBe('closed')
    expect(nextPresence('awake', 'lock')).toBe('locked')
    expect(nextPresence('awake', 'idle 400')).toBe('idle')
    expect(nextPresence('idle', 'idle 5')).toBe('awake')
    expect(nextPresence('awake', 'idle 5')).toBeNull()
    // Idle time means nothing while the sign-in screen is up.
    expect(nextPresence('locked', 'idle 900')).toBeNull()
  })

  it('tells Atlas about each machine in one line', () => {
    const now = new Date('2026-10-27T10:00:00').getTime()
    const line = describeMachines(
      [
        { id: 'a', name: 'Dell laptop', platform: 'windows', local: false, online: false, active: true, capabilities: [], version: '', created: 0, lastSeen: 0, presence: { state: 'asleep', since: now - 40 * 60_000 }, history: [] },
        { id: 'b', name: 'Work PC', platform: 'windows', local: false, online: true, active: false, capabilities: [], version: '', created: 0, lastSeen: 0, presence: { state: 'awake', since: now }, history: [] },
      ],
      now,
    )
    expect(line).toMatch(/^Dell laptop \[you work on this one\]: asleep since .+ \(40 min\); Work PC: on and in use$/)
  })

  it("this PC's tray moves its state, and the change is told", () => {
    let told = 0
    const hub = new HandsHub(deps({ local: { name: 'This PC', handlers: new Map(), capabilities: [], version: '0.4.0' }, onPresence: () => void told++ }))
    hub.localSession('lock')
    hub.localSession('idle 900')
    expect(hub.view().machines[0]!.presence?.state).toBe('locked')
    hub.localSession('unlock')
    expect(hub.view().machines[0]!.presence?.state).toBe('awake')
    expect(hub.view().machines[0]!.history.map(h => h.state)).toEqual(['awake', 'locked'])
    expect(told).toBe(2)
  })
})
