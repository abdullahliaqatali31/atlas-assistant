/**
 * The web interface's side of the bridges: when this page runs in a browser
 * instead of Atlas's window, the same bridges (shared/bridges.ts) are built
 * over a WebSocket to Atlas on the PC. Calls wait while it connects; when the
 * connection drops, the page reconnects and reloads, so nothing stays stale.
 */
import { buildBridges, type Transport } from '../../../shared/bridges.ts'
import { WEB_BLOCKED } from '../../../shared/web.ts'
import { decodeWire, encodeWire, schemeToWeb, type ClientMessage, type ServerMessage } from '../../../shared/wire.ts'

/** In a browser, not in one of Atlas's own windows. */
export const isWeb = typeof navigator !== 'undefined' && !/Electron\//.test(navigator.userAgent)

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** Connection state for the little banner while Atlas is out of reach. */
export type Link = 'connecting' | 'open' | 'lost'
const linkListeners = new Set<(l: Link) => void>()
let link: Link = 'connecting'
const setLink = (l: Link) => {
  link = l
  for (const cb of linkListeners) cb(l)
}
export const linkState = () => link
export const onLink = (cb: (l: Link) => void) => {
  linkListeners.add(cb)
  return () => void linkListeners.delete(cb)
}

class SocketTransport implements Transport {
  private ws: WebSocket | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly queue: string[] = []
  private readonly listeners = new Map<string, Set<(v: unknown) => void>>()
  private everOpen = false
  private retry = 0

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${location.pathname.startsWith('/widget') ? '?client=widget' : ''}`)
      this.ws = ws
      ws.onopen = () => {
        const reconnected = this.everOpen
        this.everOpen = true
        this.retry = 0
        setLink('open')
        // Back after a drop: start fresh rather than show what may have changed meanwhile.
        if (reconnected) return location.reload()
        for (const m of this.queue.splice(0)) ws.send(m)
        resolve()
      }
      ws.onmessage = e => this.receive(String(e.data))
      ws.onclose = () => {
        for (const p of this.pending.values()) p.reject(new Error('The connection to Atlas was lost.'))
        this.pending.clear()
        if (!this.everOpen) return reject(new Error('Atlas did not accept this browser.'))
        setLink('lost')
        // Try again, slower each time, up to every 10 s; a browser the owner removed goes back to pairing.
        const wait = Math.min(10_000, 500 * 2 ** this.retry++)
        setTimeout(() => {
          void fetch('/api/me')
            .then(r => r.json() as Promise<{ paired: boolean }>)
            .then(me => (me.paired ? this.connect() : location.reload()))
            .catch(() => this.ws?.onclose?.(new CloseEvent('close')))
        }, wait)
      }
    })
  }

  private receive(text: string) {
    let m: ServerMessage
    try {
      m = decodeWire(text, schemeToWeb) as ServerMessage
    } catch {
      return
    }
    if (m.t === 'ret') {
      const p = this.pending.get(m.id)
      this.pending.delete(m.id)
      if (m.ok) p?.resolve(m.value)
      else p?.reject(new Error(m.error))
    } else if (m.t === 'ev') {
      for (const cb of this.listeners.get(m.ch) ?? []) cb(m.v)
    }
  }

  private post(m: ClientMessage) {
    const text = encodeWire(m)
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text)
    else this.queue.push(text)
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    // Left-overs of the desktop window: answered here, quietly.
    if (WEB_BLOCKED.has(channel)) return Promise.resolve(undefined)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.post({ t: 'call', id, ch: channel, args })
    })
  }

  send(channel: string, payload: unknown) {
    if (!WEB_BLOCKED.has(channel)) this.post({ t: 'send', ch: channel, payload })
  }

  on<T>(channel: string, cb: (v: T) => void) {
    const set = this.listeners.get(channel) ?? new Set()
    set.add(cb as (v: unknown) => void)
    this.listeners.set(channel, set)
    return () => void set.delete(cb as (v: unknown) => void)
  }
}

/** Pairs with the one-time ticket from "Open in browser", if the address carries one. */
const pairFromTicket = async () => {
  const m = /^#pair=([\w-]{16,64})$/.exec(location.hash)
  if (!m) return
  history.replaceState(null, '', location.pathname + location.search)
  await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: m[1] }) }).catch(() => undefined)
}

export const pairWithCode = async (code: string): Promise<string | null> => {
  const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).catch(() => null)
  if (!res) return 'Atlas is not answering. Is it running on the PC?'
  if (res.ok) return null
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  return body.error ?? 'That did not work.'
}

export const unpair = () => fetch('/api/unpair', { method: 'POST' }).then(() => location.reload())

/**
 * Connects this browser and puts the bridges where the app expects them.
 * False when the browser is not paired yet (show the pairing screen).
 */
export const startWeb = async (): Promise<boolean> => {
  await pairFromTicket()
  const me = (await fetch('/api/me')
    .then(r => r.json())
    .catch(() => ({ paired: false }))) as { paired: boolean }
  if (!me.paired) return false
  const t = new SocketTransport()
  Object.assign(window, buildBridges(t))
  try {
    await t.connect()
    return true
  } catch {
    return false
  }
}
