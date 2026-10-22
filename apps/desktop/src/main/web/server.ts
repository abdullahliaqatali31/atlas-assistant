/**
 * Web access: Atlas serves its own interface to a browser. The page is the
 * same React app as the window; its bridges talk over a WebSocket to the
 * very handlers the window uses, with the same owner checks. Loopback only
 * unless the owner allows the home network; each browser pairs once with a
 * code from the desktop app and gets a device cookie (only its hash is kept).
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'

import { CH, type ReplyEvent } from '../../shared/ipc.ts'
import { allowedHost, CODE_TTL_MS, DEFAULT_WEB_PORT, DEVICE_COOKIE, deviceName, PairGuard, parseWebChange, readCookie, sameOrigin, TICKET_TTL_MS, WA, WEB_BLOCKED, type WebAccessView } from '../../shared/web.ts'
import { decodeWire, encodeWire, parseClientMessage, SCHEME_PATH, WEB_SCHEMES, type ServerMessage } from '../../shared/wire.ts'
import { acceptUpgrade, refuseUpgrade, type WsConnection } from './socket.ts'

type Handler = (arg: unknown, arg2: unknown, arg3?: unknown, arg4?: unknown) => unknown

interface StoredDevice {
  id: string
  name: string
  /** sha256 of the cookie; the cookie itself is never stored. */
  hash: string
  created: number
  lastSeen: number
}

interface Stored {
  enabled: boolean
  lan: boolean
  port: number
  devices: StoredDevice[]
}

interface Client {
  id: string
  deviceId: string
  conn: WsConnection
}

export interface WebAccessDeps {
  /** Atlas's own addresses (news pictures, the speech model), answered without the network. */
  schemes: Record<(typeof WEB_SCHEMES)[number], (url: URL) => Response | Promise<Response>>
  /** Every IPC handler main registered, by channel. */
  handlers: ReadonlyMap<string, Handler>
  /** Throws unless the owner is confirmed, for the owner-only channels. */
  gate: (channel: string) => void
  requireOwner: () => void
  file: string
  /** The built interface (production), or the dev server to pass requests to. */
  rendererDir: string
  devUrl: string | null
  handle: (channel: string, fn: Handler) => void
  openExternal: (url: string) => void
  /** A browser connected or left. */
  onClients: () => void
  /** The atlas command on this PC: open the page, or quit. Asked with the control token (kept beside the data, never sent to a page). */
  control?: { token: string; act: (action: 'open' | 'quit') => void }
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.xml': 'application/xml',
  '.mp3': 'audio/mpeg',
  '.onnx': 'application/octet-stream',
}
const SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const statOrNull = (file: string) => {
  try {
    return statSync(file)
  } catch {
    return null
  }
}
const MAX_BODY = 4096

export class WebAccess {
  private stored: Stored
  private server: Server | null = null
  private port = 0
  private error: string | null = null
  private code: { value: string; expires: number } | null = null
  /** One-time pairing links (Open in browser, the one printed at start); each works once. */
  private tickets: { value: string; expires: number }[] = []
  private readonly guard = new PairGuard()
  private readonly clients = new Map<string, Client>()
  /** Which browser asked for a reply, so only it speaks the answer. */
  private readonly replyOwners = new Map<string, string>()
  /** One-way messages from the page (what it shows, map results), by channel. */
  private readonly listeners = new Map<string, (payload: unknown) => void>()
  private lastSeenSaved = 0

  constructor(private readonly deps: WebAccessDeps) {
    this.stored = this.load()
  }

  // ── settings ──────────────────────────────────────────────

  private load(): Stored {
    const fallback: Stored = { enabled: true, lan: false, port: DEFAULT_WEB_PORT, devices: [] }
    try {
      const v = JSON.parse(readFileSync(this.deps.file, 'utf8')) as Partial<Stored>
      return {
        enabled: typeof v.enabled === 'boolean' ? v.enabled : fallback.enabled,
        lan: v.lan === true,
        port: Number.isInteger(v.port) && v.port! > 1024 && v.port! < 65536 ? v.port! : fallback.port,
        devices: Array.isArray(v.devices) ? v.devices.filter(d => d && typeof d.hash === 'string' && typeof d.id === 'string') : [],
      }
    } catch {
      return fallback
    }
  }

  private save() {
    try {
      writeFileSync(this.deps.file, JSON.stringify(this.stored, null, 2))
    } catch (e) {
      this.deps.log('warn', `Web access settings not saved: ${(e as Error).message}`)
    }
  }

  private lanAddresses(): string[] {
    if (!this.stored.lan) return []
    return Object.values(networkInterfaces())
      .flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal)
      .map(i => i!.address)
  }

  view(): WebAccessView {
    const online = new Set([...this.clients.values()].map(c => c.deviceId))
    const running = this.server !== null && this.port > 0
    if (this.code && this.code.expires < Date.now()) this.code = null
    return {
      enabled: this.stored.enabled,
      lan: this.stored.lan,
      port: this.port || this.stored.port,
      running,
      urls: running ? [`http://localhost:${this.port}`, ...this.lanAddresses().map(a => `http://${a}:${this.port}`)] : [],
      code: this.code?.value ?? null,
      codeExpiresAt: this.code?.expires ?? null,
      devices: this.stored.devices.map(d => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen, online: online.has(d.id) })).sort((a, b) => b.lastSeen - a.lastSeen),
      error: this.error,
    }
  }

  private publish() {
    this.broadcast(WA.changed, this.view())
  }

  register() {
    const { handle, requireOwner } = this.deps
    handle(WA.state, () => {
      requireOwner()
      return this.view()
    })
    handle(WA.set, async raw => {
      requireOwner()
      const change = parseWebChange(raw)
      if (!change) throw new Error('Invalid web access setting.')
      // The page is how the owner reaches Atlas: it stays on, on this PC at least.
      if (change.enabled === false) throw new Error('Atlas is used through this page, so it stays on (on this PC at least).')
      this.stored = { ...this.stored, ...change }
      this.save()
      await this.restart()
      return this.view()
    })
    handle(WA.newCode, () => {
      requireOwner()
      this.code = { value: String(randomInt(0, 1_000_000)).padStart(6, '0'), expires: Date.now() + CODE_TTL_MS }
      this.guard.reset()
      this.publish()
      return this.view()
    })
    handle(WA.revoke, id => {
      requireOwner()
      if (typeof id !== 'string') throw new Error('Unknown device.')
      this.stored.devices = this.stored.devices.filter(d => d.id !== id)
      this.save()
      for (const c of [...this.clients.values()]) if (c.deviceId === id) c.conn.close(4001)
      this.publish()
      return this.view()
    })
    handle(WA.open, () => {
      requireOwner()
      this.openInBrowser()
    })
  }

  /** Atlas's address on this PC, or null while the server is not up. */
  get url() {
    return this.server ? `http://localhost:${this.port}` : null
  }

  /** Atlas's address with a one-time pairing ticket: whoever opens it within the time is paired. */
  pairingUrl(ttlMs = TICKET_TTL_MS) {
    if (!this.server) throw new Error(this.error ?? 'Atlas is not serving its page.')
    const now = Date.now()
    const ticket = { value: randomBytes(24).toString('base64url'), expires: now + ttlMs }
    this.tickets = [...this.tickets.filter(t => t.expires > now).slice(-3), ticket]
    return `http://localhost:${this.port}/#pair=${ticket.value}`
  }

  /** Opens Atlas in the default browser, paired at once by a one-time ticket. */
  openInBrowser() {
    this.deps.openExternal(this.pairingUrl())
  }

  // ── server ────────────────────────────────────────────────

  async start() {
    await this.listen()
    this.publish()
  }

  private async restart() {
    await this.stop()
    await this.start()
  }

  async stop() {
    for (const c of [...this.clients.values()]) c.conn.close(1001)
    this.clients.clear()
    const s = this.server
    this.server = null
    this.port = 0
    if (s) await new Promise<void>(r => s.close(() => r()))
  }

  private async listen() {
    this.error = null
    const host = this.stored.lan ? '0.0.0.0' : '127.0.0.1'
    // The usual port, or the next free one.
    for (let port = this.stored.port; port < this.stored.port + 10; port++) {
      const server = createServer((req, res) => void this.http(req, res).catch(() => this.send(res, 500, 'Error')))
      server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
      const ok = await new Promise<boolean>(resolve => {
        server.once('error', () => resolve(false))
        server.listen(port, host, () => resolve(true))
      })
      if (ok) {
        this.server = server
        this.port = port
        this.deps.log('info', `Web interface on ${host}:${port}`)
        return
      }
    }
    this.error = `Ports ${this.stored.port}–${this.stored.port + 9} are all in use.`
  }

  private send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) {
    if (res.headersSent) return res.end()
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra })
    res.end(body)
  }

  private device(req: IncomingMessage): StoredDevice | null {
    const token = readCookie(req.headers.cookie, DEVICE_COOKIE)
    if (!token) return null
    const h = hash(token)
    const d = this.stored.devices.find(x => x.hash === h) ?? null
    if (d) {
      d.lastSeen = Date.now()
      if (d.lastSeen - this.lastSeenSaved > 60_000) {
        this.lastSeenSaved = d.lastSeen
        this.save()
      }
    }
    return d
  }

  private body(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0
      const parts: Buffer[] = []
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) {
          reject(new Error('Too large'))
          req.destroy()
        } else parts.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
      req.on('error', reject)
    })
  }

  private async http(req: IncomingMessage, res: ServerResponse) {
    // Only the names Atlas answers to: a page elsewhere cannot point a hostname at this PC and read it.
    if (!allowedHost(req.headers.host, this.port, this.lanAddresses())) return this.send(res, 403, 'Forbidden')
    const url = new URL(req.url ?? '/', 'http://atlas')
    const path = url.pathname

    if (path === '/api/control' && req.method === 'POST') {
      const c = this.deps.control
      const given = req.headers['x-atlas-control']
      // Browsers cannot read the token, and a page's request carries an Origin: the command line never does.
      if (!c || req.headers.origin || typeof given !== 'string' || given.length !== c.token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(c.token))) return this.send(res, 403, 'Forbidden')
      const action = url.searchParams.get('action')
      if (action !== 'open' && action !== 'quit') return this.send(res, 400, 'Unknown action')
      this.send(res, 200, '{"ok":true}', 'application/json')
      return c.act(action)
    }
    if (path === '/api/me' && req.method === 'GET') {
      const d = this.device(req)
      return this.send(res, 200, JSON.stringify({ paired: d !== null, name: d?.name ?? null }), 'application/json')
    }
    if (path === '/api/pair' && req.method === 'POST') return this.pair(req, res)
    if (path === '/api/unpair' && req.method === 'POST') {
      if (!sameOrigin(req.headers.origin, req.headers.host)) return this.send(res, 403, 'Forbidden')
      const d = this.device(req)
      if (d) {
        this.stored.devices = this.stored.devices.filter(x => x.id !== d.id)
        this.save()
        this.publish()
      }
      return this.send(res, 200, '{}', 'application/json', { 'Set-Cookie': `${DEVICE_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
    }
    if (path.startsWith(SCHEME_PATH)) {
      if (!this.device(req)) return this.send(res, 401, 'Pair this browser first.')
      return this.scheme(path, res)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.send(res, 405, 'Method not allowed')
    return this.deps.devUrl ? this.proxy(req, res, this.deps.devUrl) : this.file(path, res, req)
  }

  private async pair(req: IncomingMessage, res: ServerResponse) {
    if (!sameOrigin(req.headers.origin, req.headers.host)) return this.send(res, 403, 'Forbidden')
    const now = Date.now()
    if (!this.guard.allowed(now)) return this.send(res, 429, JSON.stringify({ error: 'Too many wrong codes. Make a new code in the app.' }), 'application/json')
    let input: { code?: unknown; ticket?: unknown }
    try {
      input = JSON.parse(await this.body(req)) as typeof input
    } catch {
      return this.send(res, 400, JSON.stringify({ error: 'Bad request.' }), 'application/json')
    }
    const ticket = typeof input.ticket === 'string' ? this.tickets.find(t => t.value === input.ticket && t.expires > now) : undefined
    const byTicket = ticket !== undefined
    const byCode = typeof input.code === 'string' && this.code !== null && this.code.expires > now && input.code.replace(/\D/g, '') === this.code.value
    if (!byTicket && !byCode) {
      this.guard.fail(now)
      return this.send(res, 401, JSON.stringify({ error: 'That code is not right, or it has expired.' }), 'application/json')
    }
    // Each code and ticket works once.
    if (byTicket) this.tickets = this.tickets.filter(t => t !== ticket)
    else this.code = null
    // A browser already paired keeps its entry (opening Atlas again must not add it twice).
    if (this.device(req)) return this.send(res, 200, '{"ok":true}', 'application/json')
    const token = randomBytes(32).toString('base64url')
    this.stored.devices.push({ id: randomUUID(), name: deviceName(req.headers['user-agent']), hash: hash(token), created: now, lastSeen: now })
    this.save()
    this.publish()
    return this.send(res, 200, '{"ok":true}', 'application/json', { 'Set-Cookie': `${DEVICE_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` })
  }

  /** assistant-news:// pictures and assistant-model:// files, through the same handlers the window uses. */
  private async scheme(path: string, res: ServerResponse) {
    const [scheme, ...rest] = path.slice(SCHEME_PATH.length).split('/')
    if (!WEB_SCHEMES.includes(scheme as (typeof WEB_SCHEMES)[number]) || rest.some(p => p === '..')) return this.send(res, 404, 'Not found')
    try {
      const r = await this.deps.schemes[scheme as (typeof WEB_SCHEMES)[number]](new URL(`${scheme}://${rest.join('/')}`))
      const length = r.headers.get('content-length')
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'max-age=86400', ...(length ? { 'Content-Length': length } : {}), ...SECURITY_HEADERS })
      if (!r.body) return res.end()
      // Passed on as it comes, so a large file never sits whole in memory.
      Readable.fromWeb(r.body as import('node:stream/web').ReadableStream<Uint8Array>).pipe(res)
    } catch {
      this.send(res, 502, 'Unavailable')
    }
  }

  private file(path: string, res: ServerResponse, req?: IncomingMessage) {
    const base = normalize(this.deps.rendererDir)
    const rel = decodeURIComponent(path === '/' ? '/index.html' : path)
    const file = normalize(join(base, rel))
    const st = file.startsWith(base + sep) ? statOrNull(file) : null
    if (!st || st.isDirectory()) return this.send(res, 404, 'Not found')
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    // Built files under assets/ carry a hash in their names; the page itself always comes fresh;
    // the rest (Cesium's files, models) may change with an update, so they are checked by ETag.
    const cache = file.endsWith('.html') ? 'no-store' : rel.startsWith('/assets/') ? 'max-age=31536000, immutable' : 'max-age=86400'
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
    if (req?.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cache })
      return res.end()
    }
    // Copies compressed at build time (scripts/compress.mjs), when the browser takes them.
    const accepts = String(req?.headers['accept-encoding'] ?? '')
    const packed = (['br', 'gzip'] as const).map(enc => ({ enc, at: `${file}.${enc === 'br' ? 'br' : 'gz'}` })).find(p => accepts.includes(p.enc) && statOrNull(p.at)?.isFile())
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, ETag: etag, Vary: 'Accept-Encoding', ...(packed ? { 'Content-Encoding': packed.enc } : {}), ...SECURITY_HEADERS })
    if (req?.method === 'HEAD') return res.end()
    createReadStream(packed?.at ?? file).pipe(res)
  }

  /** Development: the page and its modules come from the Vite dev server. */
  private proxy(req: IncomingMessage, res: ServerResponse, devUrl: string) {
    const target = new URL(req.url ?? '/', devUrl)
    const out = request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, up => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    out.on('error', () => this.send(res, 502, 'The dev server is not answering.'))
    req.pipe(out)
  }

  // ── the socket ────────────────────────────────────────────

  private upgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) {
    const url = new URL(req.url ?? '/', 'http://atlas')
    if (url.pathname !== '/ws') return refuseUpgrade(socket, 404)
    if (!allowedHost(req.headers.host, this.port, this.lanAddresses()) || !sameOrigin(req.headers.origin, req.headers.host)) return refuseUpgrade(socket, 403)
    const device = this.device(req)
    if (!device) return refuseUpgrade(socket, 401)
    const conn = acceptUpgrade(req, socket, head)
    if (!conn) return
    const client: Client = { id: randomUUID(), deviceId: device.id, conn }
    this.clients.set(client.id, client)
    this.publish()
    this.deps.onClients()
    conn.onClose(() => {
      this.clients.delete(client.id)
      this.publish()
      this.deps.onClients()
    })
    conn.onMessage(text => void this.message(client, text))
  }

  private async message(client: Client, text: string) {
    let m
    try {
      m = parseClientMessage(decodeWire(text))
    } catch {
      m = null
    }
    if (!m) return
    // The device may have been removed while connected.
    if (!this.stored.devices.some(d => d.id === client.deviceId)) return client.conn.close(4001)
    if (m.t === 'send') return this.listeners.get(m.ch)?.(m.payload)
    const fn = this.deps.handlers.get(m.ch)
    let reply: ServerMessage
    if (!fn || WEB_BLOCKED.has(m.ch)) reply = { t: 'ret', id: m.id, ok: false, error: 'That works only in the desktop app.' }
    else {
      try {
        this.deps.gate(m.ch)
        const [a, b, c, d] = m.args
        const value = await fn(a, b, c, d)
        if ((m.ch === CH.send || m.ch === CH.sendVoice) && value && typeof value === 'object' && typeof (value as { replyId?: unknown }).replyId === 'string') {
          this.replyOwners.set((value as { replyId: string }).replyId, client.id)
          if (this.replyOwners.size > 200) this.replyOwners.delete(this.replyOwners.keys().next().value!)
        }
        reply = { t: 'ret', id: m.id, ok: true, value }
      } catch (e) {
        reply = { t: 'ret', id: m.id, ok: false, error: e instanceof Error ? e.message : 'That did not work.' }
      }
    }
    client.conn.send(encodeWire(reply))
  }

  /** One-way messages from the page on this channel. */
  onMessage(channel: string, fn: (payload: unknown) => void) {
    this.listeners.set(channel, fn)
  }

  get clientCount() {
    return this.clients.size
  }

  get hasClients() {
    return this.clients.size > 0
  }

  /** An event for every connected browser. */
  broadcast(channel: string, payload: unknown) {
    if (!this.clients.size) return
    const text = encodeWire({ t: 'ev', ch: channel, v: payload } satisfies ServerMessage)
    for (const c of this.clients.values()) c.conn.send(text)
  }

  /** A reply asked for in a browser belongs to it: the others show the text but only it speaks. */
  ownsReply(replyId: string) {
    const owner = this.replyOwners.get(replyId)
    return owner !== undefined && this.clients.has(owner)
  }

  /** Text goes to every browser; the voice to the one that asked, or to all when nobody asked and the window is closed. */
  reply(e: ReplyEvent, windowUp: boolean) {
    if (!this.clients.size) return
    if (e.type !== 'audio') return this.broadcast(CH.reply, e)
    const owner = this.replyOwners.get(e.replyId)
    const c = owner ? this.clients.get(owner) : undefined
    if (c) c.conn.send(encodeWire({ t: 'ev', ch: CH.reply, v: e } satisfies ServerMessage))
    else if (!owner && !windowUp) this.broadcast(CH.reply, e)
  }
}
