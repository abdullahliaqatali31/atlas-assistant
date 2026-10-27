/**
 * Windows Hello for the owner check: face, fingerprint or the Windows PIN,
 * through Windows' own "Making sure it's you" dialog (hello.ps1). Atlas never
 * sees the face or finger; Windows only answers whether it was the owner.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import HELLO_PS1 from './hello.ps1?raw'

/** Windows' answers: Available / DeviceNotPresent / NotConfiguredForUser / DisabledByPolicy / DeviceBusy, and for a check Verified / Canceled / RetriesExhausted. */
export type HelloResult = string

export class WindowsHello {
  private available: boolean | null = null

  constructor(
    private readonly dir: string,
    private readonly log: (level: 'info' | 'warn', message: string) => void,
  ) {}

  private run(args: string[], timeoutMs: number): Promise<{ result: string; error?: string }> {
    return new Promise(resolve => {
      if (process.platform !== 'win32') return resolve({ result: 'DeviceNotPresent' })
      mkdirSync(this.dir, { recursive: true })
      const file = join(this.dir, `hello-${createHash('sha256').update(HELLO_PS1).digest('hex').slice(0, 12)}.ps1`)
      if (!existsSync(file)) writeFileSync(file, HELLO_PS1)
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { windowsHide: true })
      let out = ''
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.on('close', () => {
        clearTimeout(timer)
        const line = out.trim().split(/\r?\n/).pop() ?? ''
        try {
          resolve(JSON.parse(line) as { result: string; error?: string })
        } catch {
          resolve({ result: 'Error', error: 'No answer from Windows Hello.' })
        }
      })
      child.on('error', e => {
        clearTimeout(timer)
        resolve({ result: 'Error', error: e.message })
      })
    })
  }

  /** Whether face, fingerprint or PIN is set up for this Windows account (asked once, then remembered). */
  async isAvailable(refresh = false): Promise<boolean> {
    if (this.available !== null && !refresh) return this.available
    const r = await this.run(['-Mode', 'check'], 20_000)
    this.available = r.result === 'Available'
    if (r.error) this.log('warn', `Windows Hello check: ${r.error}`)
    return this.available
  }

  get knownAvailable() {
    return this.available === true
  }

  /** Shows Windows' dialog over the given window; resolves with Windows' answer. */
  async verify(hwnd: bigint, message: string): Promise<HelloResult> {
    const r = await this.run(['-Mode', 'verify', '-Hwnd', hwnd.toString(), '-Message', message.replace(/"/g, "'")], 130_000)
    if (r.error) this.log('warn', `Windows Hello: ${r.error}`)
    return r.result
  }
}
