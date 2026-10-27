/**
 * The brain's side of Atlas's hands: the machines it may work on. This PC
 * (when the brain runs here) is one; others pair once with a code from
 * Settings › Machines and then connect by themselves (`atlas connect`). Each
 * keeps a device token (only its hash is stored here); revoking it closes
 * the connection at once.
 *
 * One machine is active: Atlas's PC tools, the This PC settings and what the
 * runtime hears about "the PC" come from it. Calls to a machine that is not
 * connected fail with a sentence the model can pass on.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import {
  HANDS_CHANNEL,
  HANDS_VERSION,
  MACHINE_CODE_ALPHABET,
  MACHINE_CODE_TTL_MS,
  MCH,
  normalizeMachineCode,
  OP_CAPABILITY,
  parseHandsMessage,
  platformOf,
  type BrainMessage,
  type Capability,
  type HandsMessage,
  type HandsPlatform,
  type MachinesView,
  type MachineView,
  nextPresence,
  type Presence,
  type PresenceEvent,
  type PresenceState,
  type RuntimeNote,
} from '../../shared/hands.ts'
import { PairGuard } from '../../shared/web.ts'
import { acceptUpgrade, refuseUpgrade, type WsConnection } from '../web/socket.ts'

type Handler = (arg: unknown, arg2: unknown, arg3?: unknown, arg4?: unknown) => unknown

interface StoredMachine {
  id: string
  name: string
  platform: HandsPlatform
  /** sha256 of the machine's token. */
  hash: string
  created: number
  lastSeen: number
  version: string
  capabilities: Capability[]
  /** How it was when last heard of (asleep, shut down…), kept across the brain's restarts. */
  presence?: Presence
  history?: PresenceEvent[]
}

interface Stored {
  machines: StoredMachine[]
  /** 'local' or a machine id. */
  active: string | null
}

interface Link {
  machineId: string
  conn: WsConnection
  hello: Extract<HandsMessage, { t: 'hello' }>
  channels: Set<string>
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>
  nextId: number
}

/** This PC's hands, when the brain runs here. */
export interface LocalHands {
  name: string
  handlers: ReadonlyMap<string, Handler>
  capabilities: readonly Capability[]
  version: string
}

export interface HubDeps {
  file: string
  local: LocalHands | null
  /** A page event from the active machine. */
  toRenderer: (channel: string, payload: unknown) => void
  /** What the runtime should hear from the active machine. */
  onNote: (note: RuntimeNote) => void
  /** Lock / unlock / idle from the active machine. */
  onSession: (line: string) => void
  /** The active machine changed (or connected / left). */
  onActive: () => void
  /** A machine woke, slept, locked, shut down, went quiet… (Atlas's context follows it). */
  onPresence: () => void
  /** A one-time pairing ticket for a machine's widget page. */
  ticket: () => string
  /** The owner check, for calls a machine makes on the owner's behalf. */
  ownerLocked: () => boolean
  handle: (channel: string, fn: Handler) => void
  requireOwner: () => void
  /** The address machines should use (as the page sees it). */
  brainUrl: () => string | null
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const LOCAL = 'local'
/** A call to a machine gives up after this long (a long code run reports through its own events). */
const CALL_MS = 5 * 60_000
const PAGE_CALL_MS = 60_000

export class HandsHub {
  private stored: Stored
  private readonly links = new Map<string, Link>()
  private code: { value: string; expires: number } | null = null
  private readonly guard = new PairGuard()

  constructor(private readonly deps: HubDeps) {
    this.stored = this.load()
    if (!this.stored.active) this.stored.active = deps.local ? LOCAL : (this.stored.machines[0]?.id ?? null)
    // The brain was away itself: a machine that was on then and has not come back within a minute is out of reach.
    setTimeout(() => {
      for (const m of this.stored.machines) if (!this.links.has(m.id) && (!m.presence || ['awake', 'idle', 'locked'].includes(m.presence.state))) this.setPresence(m.id, 'lost')
    }, 60_000).unref?.()
  }

  private load(): Stored {
    try {
      const v = JSON.parse(readFileSync(this.deps.file, 'utf8')) as Partial<Stored>
      return {
        machines: Array.isArray(v.machines) ? v.machines.filter(m => m && typeof m.id === 'string' && typeof m.hash === 'string') : [],
        active: typeof v.active === 'string' ? v.active : null,
      }
    } catch {
      return { machines: [], active: null }
    }
  }

  private save() {
    try {
      writeFileSync(this.deps.file, JSON.stringify(this.stored, null, 2), { mode: 0o600 })
    } catch (e) {
      this.deps.log('warn', `Machines not saved: ${(e as Error).message}`)
    }
  }

  // ── the page: Settings › Machines ─────────────────────────

  view(): MachinesView {
    if (this.code && this.code.expires < Date.now()) this.code = null
    const local: MachineView[] = this.deps.local
      ? [{ id: LOCAL, name: this.deps.local.name, platform: platformOf(), local: true, online: true, active: this.stored.active === LOCAL, capabilities: [...this.deps.local.capabilities], version: this.deps.local.version, created: 0, lastSeen: Date.now(), presence: this.localPresence, history: this.localHistory }]
      : []
    const remote = this.stored.machines.map(m => {
      const link = this.links.get(m.id)
      return { id: m.id, name: m.name, platform: link?.hello.platform ?? m.platform, local: false, online: Boolean(link), active: this.stored.active === m.id, capabilities: link ? link.hello.capabilities : m.capabilities, version: link?.hello.version ?? m.version, created: m.created, lastSeen: link ? Date.now() : m.lastSeen, presence: m.presence ?? null, history: m.history ?? [] }
    })
    return { machines: [...local, ...remote], code: this.code?.value ?? null, codeExpiresAt: this.code?.expires ?? null, brainUrl: this.deps.brainUrl() }
  }

  // ── how each machine is ────────────────────────────────────

  private localPresence: Presence = { state: 'awake', since: Date.now() }
  private localHistory: PresenceEvent[] = []

  /** Moves a machine to a new state (nothing when it is already there), keeps the last 12, and tells. */
  private setPresence(id: string, state: PresenceState) {
    const now = Date.now()
    const m = id === LOCAL ? null : this.stored.machines.find(x => x.id === id)
    const current = id === LOCAL ? this.localPresence : m?.presence
    if (current?.state === state) return
    const next: Presence = { state, since: now }
    if (id === LOCAL) {
      this.localPresence = next
      this.localHistory = [{ at: now, state }, ...this.localHistory].slice(0, 12)
    } else if (m) {
      m.presence = next
      m.history = [{ at: now, state }, ...(m.history ?? [])].slice(0, 12)
      this.save()
    } else return
    this.publish()
    this.deps.onPresence()
  }

  /** This PC's own tray said something (lock, sleep, idle…). */
  localSession(line: string) {
    if (!this.deps.local) return
    const next = nextPresence(this.localPresence.state, line)
    if (next) this.setPresence(LOCAL, next)
  }

  private publish() {
    this.deps.toRenderer(MCH.changed, this.view())
  }

  register() {
    const { handle, requireOwner } = this.deps
    handle(MCH.state, () => this.view())
    handle(MCH.newCode, () => {
      requireOwner()
      let value = ''
      for (let i = 0; i < 8; i++) value += MACHINE_CODE_ALPHABET[randomInt(0, MACHINE_CODE_ALPHABET.length)]
      this.code = { value: `${value.slice(0, 4)}-${value.slice(4)}`, expires: Date.now() + MACHINE_CODE_TTL_MS }
      this.guard.reset()
      this.publish()
      return this.view()
    })
    handle(MCH.setActive, id => {
      requireOwner()
      if (typeof id !== 'string' || !(id === LOCAL ? this.deps.local : this.stored.machines.some(m => m.id === id))) throw new Error('Unknown machine.')
      this.setActive(id)
      return this.view()
    })
    handle(MCH.rename, (id, name) => {
      requireOwner()
      const m = this.stored.machines.find(x => x.id === id)
      if (!m || typeof name !== 'string' || !name.trim() || name.length > 60) throw new Error('Give a name under 60 characters.')
      m.name = name.trim()
      this.save()
      this.publish()
      return this.view()
    })
    handle(MCH.revoke, id => {
      requireOwner()
      if (typeof id !== 'string' || id === LOCAL) throw new Error('Unknown machine.')
      this.stored.machines = this.stored.machines.filter(m => m.id !== id)
      this.links.get(id)?.conn.close(4001)
      this.links.delete(id)
      if (this.stored.active === id) this.stored.active = this.deps.local ? LOCAL : (this.stored.machines[0]?.id ?? null)
      this.save()
      this.publish()
      this.deps.onActive()
      return this.view()
    })
  }

  private setActive(id: string) {
    if (this.stored.active === id) return
    const before = this.stored.active
    this.stored.active = id
    this.save()
    for (const [mid, link] of this.links) if (mid === id || mid === before) this.post(link, { t: 'active', on: mid === id })
    this.publish()
    this.deps.onActive()
  }

  // ── pairing: POST /api/hands/pair ─────────────────────────

  /** A machine trades the code shown in Settings › Machines for its own token (once). */
  pair(body: string): { status: number; body: unknown } {
    const now = Date.now()
    if (!this.guard.allowed(now)) return { status: 429, body: { error: 'Too many wrong codes. Make a new code in Settings › Machines.' } }
    let input: { code?: unknown; name?: unknown; platform?: unknown }
    try {
      input = JSON.parse(body) as typeof input
    } catch {
      return { status: 400, body: { error: 'Bad request.' } }
    }
    const given = typeof input.code === 'string' ? normalizeMachineCode(input.code) : ''
    const want = this.code && this.code.expires > now ? normalizeMachineCode(this.code.value) : ''
    if (!want || given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want))) {
      this.guard.fail(now)
      return { status: 401, body: { error: 'That code is not right, or it has expired. Make a new one in Settings › Machines.' } }
    }
    this.code = null
    const token = randomBytes(32).toString('base64url')
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 60) : 'A PC'
    const platform: HandsPlatform = input.platform === 'mac' || input.platform === 'linux' ? input.platform : 'windows'
    const machine: StoredMachine = { id: randomUUID(), name, platform, hash: hash(token), created: now, lastSeen: now, version: '', capabilities: [] }
    this.stored.machines.push(machine)
    // A brain with no PC of its own (a server) works on the first machine that pairs.
    if (!this.stored.active || (this.stored.active !== LOCAL && !this.stored.machines.some(m => m.id === this.stored.active))) this.stored.active = machine.id
    this.save()
    this.publish()
    this.deps.log('info', `Machine paired: ${name} (${platform}).`)
    return { status: 200, body: { machineId: machine.id, token } }
  }

  // ── the connection: /hands ────────────────────────────────

  accept(req: IncomingMessage, socket: Duplex, head: Buffer) {
    // A browser page always sends its Origin: only Atlas's own hands connect here.
    if (req.headers.origin) return refuseUpgrade(socket, 403)
    const auth = req.headers.authorization
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const h = token ? hash(token) : ''
    const machine = h ? this.stored.machines.find(m => m.hash.length === h.length && timingSafeEqual(Buffer.from(m.hash), Buffer.from(h))) : undefined
    if (!machine) return refuseUpgrade(socket, 401)
    const conn = acceptUpgrade(req, socket, head)
    if (!conn) return
    // One connection per machine: a new one replaces the old.
    this.links.get(machine.id)?.conn.close(4002)
    let link: Link | null = null
    const timeout = setTimeout(() => conn.close(4003), 15_000)
    conn.onMessage(text => {
      let m: HandsMessage | null
      try {
        m = parseHandsMessage(JSON.parse(text))
      } catch {
        m = null
      }
      if (!m) return
      if (!link) {
        if (m.t !== 'hello') return
        clearTimeout(timeout)
        if (m.v !== HANDS_VERSION) {
          this.deps.log('warn', `${machine.name} runs another version of Atlas's hands (${m.version}); update it.`)
          return conn.close(4004)
        }
        link = { machineId: machine.id, conn, hello: m, channels: new Set(m.channels), pending: new Map(), nextId: 1 }
        this.links.set(machine.id, link)
        Object.assign(machine, { platform: m.platform, version: m.version, capabilities: m.capabilities, lastSeen: Date.now() })
        if (m.name && machine.name === 'A PC') machine.name = m.name
        this.save()
        this.post(link, { t: 'welcome', machineId: machine.id, brain: this.deps.brainUrl() ?? '', active: this.stored.active === machine.id })
        this.post(link, { t: 'owner', locked: this.deps.ownerLocked() })
        this.deps.log('info', `${machine.name} connected (${m.platform}).`)
        // Connecting means it is on (it says so if it is locked).
        this.setPresence(machine.id, 'awake')
        this.publish()
        if (this.stored.active === machine.id) this.deps.onActive()
        return
      }
      this.onMessage(link, machine, m)
    })
    conn.onClose(() => {
      clearTimeout(timeout)
      const l = this.links.get(machine.id)
      if (!l || l.conn !== conn) return
      this.links.delete(machine.id)
      for (const p of l.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(`${machine.name} went offline.`))
      }
      machine.lastSeen = Date.now()
      this.save()
      // Gone: asleep, shut down or closed if it said so on the way; otherwise nobody knows why.
      const said = machine.presence?.state
      if (said !== 'asleep' && said !== 'off' && said !== 'closed') this.setPresence(machine.id, 'lost')
      this.deps.log('info', `${machine.name} disconnected${said === 'asleep' || said === 'off' || said === 'closed' ? ` (${said})` : ''}.`)
      this.publish()
      if (this.stored.active === machine.id) this.deps.onActive()
    })
  }

  private onMessage(link: Link, machine: StoredMachine, m: HandsMessage) {
    const active = this.stored.active === machine.id
    switch (m.t) {
      case 'ret': {
        const p = link.pending.get(m.id)
        if (!p) return
        link.pending.delete(m.id)
        clearTimeout(p.timer)
        if (m.ok) p.resolve(m.value)
        else p.reject(new Error(m.error ?? 'That did not work on the machine.'))
        return
      }
      case 'ev':
        // Only the machine Atlas works on fills the This PC settings.
        if (active) this.deps.toRenderer(m.ch, m.v)
        return
      case 'rt':
        if (active) this.deps.onNote(m.note)
        return
      case 'session': {
        const next = nextPresence(machine.presence?.state ?? 'awake', m.line)
        if (next) this.setPresence(machine.id, next)
        if (active && m.line !== 'quit') this.deps.onSession(m.line)
        return
      }
      case 'ask':
        try {
          this.post(link, { t: 'ret', id: m.id, ok: true, value: this.deps.ticket() })
        } catch (e) {
          this.post(link, { t: 'ret', id: m.id, ok: false, error: (e as Error).message })
        }
        return
    }
  }

  private post(link: Link, m: BrainMessage) {
    link.conn.send(JSON.stringify(m))
  }

  /** The owner check changed on the brain: machines follow it. */
  ownerChanged(locked: boolean) {
    for (const link of this.links.values()) this.post(link, { t: 'owner', locked })
  }

  // ── calling the active machine ────────────────────────────

  private activeName() {
    const a = this.stored.active
    if (a === LOCAL) return this.deps.local?.name ?? 'This PC'
    return this.stored.machines.find(m => m.id === a)?.name ?? 'The PC'
  }

  /** The machine Atlas works on is here and connected. */
  get activeOnline() {
    const a = this.stored.active
    return a === LOCAL ? Boolean(this.deps.local) : a !== null && this.links.has(a)
  }

  /** The active machine is this PC. */
  get activeIsLocal() {
    return this.stored.active === LOCAL && Boolean(this.deps.local)
  }

  get activeLabel() {
    return this.activeName()
  }

  /** Does the active machine answer this channel (so the page's call goes there)? */
  answers(channel: string): boolean {
    const a = this.stored.active
    if (a === LOCAL) return Boolean(this.deps.local?.handlers.has(channel))
    const link = a ? this.links.get(a) : undefined
    return link ? link.channels.has(channel) : false
  }

  /** A page handler that goes to whichever machine is active when it is called (for channels the brain does not answer itself). */
  handlerFor(channel: string): Handler | undefined {
    if (!this.answers(channel) && !this.knownChannel(channel)) return undefined
    return (a, b, c, d) => this.call(channel, [a, b, c, d], PAGE_CALL_MS)
  }

  /** A machine's channel (the page may ask before its machine connects: it then hears that none is). */
  private knownChannel(channel: string) {
    if (HANDS_CHANNEL.test(channel)) return true
    if (this.deps.local?.handlers.has(channel)) return true
    for (const link of this.links.values()) if (link.channels.has(channel)) return true
    return false
  }

  /** Calls the active machine. */
  async call(channel: string, args: unknown[], timeoutMs = CALL_MS, machineId?: string): Promise<unknown> {
    const a = machineId ?? this.stored.active
    if (!a) throw new Error('No PC is connected to Atlas yet. Pair one in Settings › Machines (run `atlas connect` on it).')
    if (a === LOCAL && this.deps.local) {
      const fn = this.deps.local.handlers.get(channel)
      if (!fn) throw new Error('This PC cannot do that.')
      const [x, y, z, w] = args
      return fn(x, y, z, w)
    }
    const link = this.links.get(a)
    const name = this.stored.machines.find(m => m.id === a)?.name ?? this.activeName()
    if (!link) throw new Error(`${name} is offline. Start Atlas there (atlas connect), or pick another machine in Settings › Machines.`)
    const need = OP_CAPABILITY[channel]
    if (need && !link.hello.capabilities.includes(need)) throw new Error(`On ${name}, the owner switched that off.`)
    if (!link.channels.has(channel)) throw new Error(`${name} cannot do that (${link.hello.platform}).`)
    const id = link.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(id)
        reject(new Error(`${name} did not answer in time.`))
      }, timeoutMs)
      link.pending.set(id, { resolve, reject, timer })
      // Trailing undefined arguments stay off the wire.
      const trimmed = [...args]
      while (trimmed.length && trimmed[trimmed.length - 1] === undefined) trimmed.pop()
      this.post(link, { t: 'call', id, ch: channel, args: trimmed })
    })
  }

  /** Tells every connected machine (notices, alarms): best effort, never waits. */
  broadcast(channel: string, args: unknown[]) {
    for (const link of this.links.values()) {
      if (!link.channels.has(channel)) continue
      const need = OP_CAPABILITY[channel]
      if (need && !link.hello.capabilities.includes(need)) continue
      this.post(link, { t: 'call', id: 0, ch: channel, args })
    }
  }

  /** Machines connected now (not counting this PC). */
  get connectedCount() {
    return this.links.size
  }

  stop() {
    for (const link of this.links.values()) link.conn.close(1001)
    this.links.clear()
  }
}
