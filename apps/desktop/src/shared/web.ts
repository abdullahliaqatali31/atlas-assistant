/**
 * The web interface: Atlas on this PC serves its own screens to a browser.
 * Loopback only unless the owner allows the home network; every browser is
 * paired once with a code shown in the desktop app, and can be removed.
 */
import { BC } from './backup.ts'
import { BRT } from './browser.ts'
import { CH } from './ipc.ts'
import { MC } from './map.ts'
import { PRS } from './presence.ts'
import { UC } from './ui.ts'

export const WA = {
  state: 'web:state',
  changed: 'web:changed',
  set: 'web:set',
  newCode: 'web:new-code',
  revoke: 'web:revoke',
  open: 'web:open',
} as const

export const DEFAULT_WEB_PORT = 47800
/** Pairing codes and the "Open in browser" ticket last this long. */
export const CODE_TTL_MS = 10 * 60_000
export const TICKET_TTL_MS = 2 * 60_000
export const DEVICE_COOKIE = 'atlas_device'

export interface WebDevice {
  id: string
  name: string
  created: number
  lastSeen: number
  online: boolean
}

export interface WebAccessView {
  enabled: boolean
  /** Also on the home network (other devices can reach it; still paired only). */
  lan: boolean
  port: number
  running: boolean
  /** Where it can be opened: this PC first, then the home network addresses. */
  urls: string[]
  code: string | null
  codeExpiresAt: number | null
  devices: WebDevice[]
  error: string | null
}

export interface WebAccessBridge {
  state(): Promise<WebAccessView>
  set(change: { enabled?: boolean; lan?: boolean }): Promise<WebAccessView>
  newCode(): Promise<WebAccessView>
  revoke(id: string): Promise<WebAccessView>
  /** Opens the interface in the default browser, already paired. */
  open(): Promise<void>
  onChanged(cb: (v: WebAccessView) => void): () => void
}

/**
 * Calls a browser may never make: the ones that only make sense from the
 * desktop window itself (its page reports, its map, the widget's feed, the
 * window's own look), web access itself, and backups (they open file
 * dialogs on the PC).
 */
export const WEB_BLOCKED: ReadonlySet<string> = new Set([
  UC.report,
  UC.solid,
  MC.result,
  PRS.update,
  BRT.report,
  CH.ready,
  BC.create,
  BC.restore,
  ...Object.values(WA),
])

/** Host names a browser may use to reach Atlas, against DNS rebinding: loopback, plus the PC's own addresses when the home network is allowed. */
export const allowedHost = (host: string | undefined, port: number, lanAddresses: readonly string[]): boolean => {
  if (!host) return false
  const names = ['127.0.0.1', 'localhost', ...lanAddresses]
  return names.some(n => host === `${n}:${port}`)
}

/** The page and the socket must come from the same place. */
export const sameOrigin = (origin: string | undefined, host: string | undefined) => Boolean(origin && host && origin === `http://${host}`)

export const readCookie = (header: string | undefined, name: string): string | null => {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

/** "Chrome on Android" and the like, so the owner knows which device is which. */
export const deviceName = (ua: string | undefined): string => {
  const s = ua ?? ''
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Browser'
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows' : /Mac OS X/.test(s) ? 'Mac' : /Linux/.test(s) ? 'Linux' : 'a device'
  return `${browser} on ${os}`
}

/** At most `max` wrong codes in `windowMs`; after that pairing waits for a new code. */
export class PairGuard {
  private fails: number[] = []
  constructor(
    private readonly max = 5,
    private readonly windowMs = 10 * 60_000,
  ) {}
  allowed(now: number) {
    this.fails = this.fails.filter(t => now - t < this.windowMs)
    return this.fails.length < this.max
  }
  fail(now: number) {
    this.fails.push(now)
  }
  reset() {
    this.fails = []
  }
}

export const parseWebChange = (v: unknown): { enabled?: boolean; lan?: boolean } | null => {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const out: { enabled?: boolean; lan?: boolean } = {}
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== 'boolean') return null
    out.enabled = o.enabled
  }
  if (o.lan !== undefined) {
    if (typeof o.lan !== 'boolean') return null
    out.lan = o.lan
  }
  return out
}
