/**
 * The PC's own state for Atlas: Wi-Fi, Bluetooth, battery, VPN. One
 * long-lived Windows PowerShell process answers JSON lines (probe.ps1,
 * read-only), polled every 45 s and at once when Electron sees the network,
 * power or lock change. Each reading goes to the runtime with what changed.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { net, powerMonitor, shell } from 'electron'

import { diffSnapshots, interpretProbe, SETTINGS_PAGES, describeSystem, type SystemChange, type SystemOp, type SystemSnapshot } from '../../shared/system.ts'
import PROBE_PS1 from './probe.ps1?raw'

const POLL_MS = 45_000
const ONLINE_CHECK_MS = 5_000
const REQUEST_TIMEOUT_MS = 60_000

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

/** A PowerShell script answering one JSON request per line. */
export class PsWorker {
  private child: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<void> | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  constructor(
    private readonly dir: string,
    private readonly name: string,
    private readonly script: string,
    private readonly log: (level: 'info' | 'warn', message: string) => void,
  ) {}

  private start(): Promise<void> {
    if (this.child) return Promise.resolve()
    this.starting ??= new Promise<void>((resolve, reject) => {
      if (process.platform !== 'win32') return reject(new Error('This works on Windows only.'))
      mkdirSync(this.dir, { recursive: true })
      const file = join(this.dir, `${this.name}-${createHash('sha256').update(this.script).digest('hex').slice(0, 12)}.ps1`)
      if (!existsSync(file)) writeFileSync(file, this.script)
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`${this.name} did not start in time.`))
      }, 30_000)
      let ready = false
      createInterface({ input: child.stdout }).on('line', line => {
        let msg: { ready?: boolean; id?: number | null; ok?: boolean; result?: unknown; error?: string }
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (!ready && msg.ready) {
          ready = true
          clearTimeout(timer)
          this.child = child
          return resolve()
        }
        const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
        if (!p) return
        this.pending.delete(msg.id as number)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error ?? `${this.name} failed.`))
      })
      child.stderr.on('data', (d: Buffer) => this.log('warn', `${this.name}: ${d.toString().trim().slice(0, 200)}`))
      child.on('exit', code => {
        clearTimeout(timer)
        this.child = null
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error(`${this.name} stopped.`))
        }
        this.pending.clear()
        if (!ready) reject(new Error(`${this.name} exited (${code}).`))
      })
    }).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async request<T>(cmd: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    await this.start()
    const child = this.child
    if (!child) throw new Error(`${this.name} is not running.`)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.name} did not answer in time.`))
      }, timeoutMs)
      this.pending.set(id, { resolve: v => resolve(v as T), reject, timer })
      child.stdin.write(`${JSON.stringify({ id, cmd })}\n`)
    })
  }

  stop() {
    this.child?.kill()
    this.child = null
  }
}

export class SystemService {
  private readonly worker: PsWorker
  private snapshot: SystemSnapshot | null = null
  private recent: SystemChange[] = []
  private timer: NodeJS.Timeout | null = null
  private onlineTimer: NodeJS.Timeout | null = null
  private busy: Promise<void> | null = null
  private wasOnline = true

  constructor(
    private readonly deps: {
      dir: string
      log: (level: 'info' | 'warn', message: string) => void
      /** Each new reading and what changed since the last one. */
      onSnapshot: (s: SystemSnapshot, changes: SystemChange[]) => void
    },
  ) {
    this.worker = new PsWorker(deps.dir, 'system-probe', PROBE_PS1, deps.log)
  }

  get current() {
    return this.snapshot
  }

  get changes() {
    return this.recent
  }

  /** Reads everything now (one at a time; a reading already running is shared). */
  refresh(): Promise<void> {
    this.busy ??= (async () => {
      try {
        const raw = await this.worker.request<unknown>('status')
        const next = interpretProbe(raw, Date.now())
        const changes = diffSnapshots(this.snapshot, next)
        this.snapshot = next
        if (changes.length) this.recent = [...this.recent, ...changes].slice(-30)
        this.deps.onSnapshot(next, changes)
      } catch (e) {
        this.deps.log('warn', `System status: ${e instanceof Error ? e.message : String(e)}`)
      }
    })().finally(() => {
      this.busy = null
    })
    return this.busy
  }

  start() {
    if (process.platform !== 'win32') return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
    this.timer.unref?.()
    // Cheap signals between readings: the network coming and going, power and lock.
    this.onlineTimer = setInterval(() => {
      const online = net.isOnline()
      if (online !== this.wasOnline) {
        this.wasOnline = online
        void this.refresh()
      }
    }, ONLINE_CHECK_MS)
    this.onlineTimer.unref?.()
    for (const ev of ['on-ac', 'on-battery', 'resume', 'unlock-screen'] as const) powerMonitor.on(ev as 'resume', () => void this.refresh())
  }

  /** The runtime's PC requests. */
  async handle(op: SystemOp): Promise<string> {
    switch (op.kind) {
      case 'status':
        await this.refresh()
        return this.snapshot ? describeSystem(this.snapshot) : 'The PC status is not available right now.'
      case 'settings': {
        const url = SETTINGS_PAGES[op.page]
        if (!url) throw new Error('Unknown Settings page.')
        await shell.openExternal(url)
        return `Opened Windows Settings › ${op.page}.`
      }
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    if (this.onlineTimer) clearInterval(this.onlineTimer)
    this.worker.stop()
  }
}
