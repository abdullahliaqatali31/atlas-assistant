/**
 * The desktop worker: Windows PowerShell running a small compiled C# helper
 * for UI Automation, window focus, keyboard and mouse input. Both ship with
 * every Windows 10/11, so nothing extra is installed. One request at a time
 * over JSON lines; restarted on demand if it exits.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import UIA_CS from './uia/Uia.cs?raw'
import WORKER_PS1 from './uia/worker.ps1?raw'

const REQUEST_TIMEOUT_MS = 45_000
const START_TIMEOUT_MS = 60_000

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class DesktopWorker {
  private child: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<void> | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  /** Requests run one after another: input and focus must not interleave. */
  private queue: Promise<unknown> = Promise.resolve()
  error: string | null = null

  constructor(
    private readonly dir: string,
    private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void,
    private readonly onState: () => void = () => {},
  ) {}

  get ready() {
    return this.child !== null
  }

  /** Writes the helper files (named by content hash, so an update recompiles) and starts PowerShell. */
  private start(): Promise<void> {
    if (this.child) return Promise.resolve()
    this.starting ??= new Promise<void>((resolve, reject) => {
      if (process.platform !== 'win32') return reject(new Error('Desktop app control works on Windows only.'))
      const hash = createHash('sha256').update(UIA_CS).update(WORKER_PS1).digest('hex').slice(0, 12)
      mkdirSync(this.dir, { recursive: true })
      const cs = join(this.dir, `Uia-${hash}.cs`)
      const ps1 = join(this.dir, `worker-${hash}.ps1`)
      const dll = join(this.dir, `Uia-${hash}.dll`)
      // Old versions are left from earlier builds; a DLL in use by a running worker cannot be removed, which is fine.
      for (const f of readdirSync(this.dir)) {
        if (f.includes(hash)) continue
        try {
          rmSync(join(this.dir, f), { force: true })
        } catch {
          // Still loaded by an older worker; removed next time.
        }
      }
      if (!existsSync(cs)) writeFileSync(cs, UIA_CS)
      if (!existsSync(ps1)) writeFileSync(ps1, WORKER_PS1)
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Cs', cs, '-Dll', dll], { windowsHide: true })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('The desktop worker did not start in time.'))
      }, START_TIMEOUT_MS)
      let ready = false
      const lines = createInterface({ input: child.stdout })
      lines.on('line', line => {
        let msg: { ready?: boolean; error?: string; id?: number | null; ok?: boolean; result?: unknown }
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (!ready && 'ready' in msg) {
          clearTimeout(timer)
          if (!msg.ready) return reject(new Error(`The desktop worker could not compile: ${msg.error ?? 'unknown error'}`))
          ready = true
          this.child = child
          this.error = null
          this.onState()
          return resolve()
        }
        const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined
        if (!p) return
        this.pending.delete(msg.id as number)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error ?? 'The desktop worker failed.'))
      })
      child.stderr.on('data', (d: Buffer) => this.log('warn', `Desktop worker: ${d.toString().trim().slice(0, 300)}`))
      child.on('exit', code => {
        clearTimeout(timer)
        this.child = null
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error('The desktop worker stopped.'))
        }
        this.pending.clear()
        if (!ready) reject(new Error(`The desktop worker exited (${code}).`))
        else this.log('info', `Desktop worker exited (${code}).`)
        this.onState()
      })
    }).finally(() => {
      this.starting = null
    })
    return this.starting.catch(e => {
      this.error = e instanceof Error ? e.message : String(e)
      this.onState()
      throw e
    })
  }

  request<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const run = async () => {
      await this.start()
      const child = this.child
      if (!child) throw new Error('The desktop worker is not running.')
      const id = this.nextId++
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error('Windows did not answer in time.'))
        }, timeoutMs)
        this.pending.set(id, { resolve: v => resolve(v as T), reject, timer })
        child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`)
      })
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  stop() {
    this.child?.stdin.end()
    this.child?.kill()
    this.child = null
  }
}
