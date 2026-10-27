/**
 * Web access: Atlas serves its own interface to a browser. The page is the
 * same React app as the window; its bridges talk over a WebSocket to the
 * very handlers the window uses, with the same owner checks. Loopback only
 * unless the owner allows the home network; each browser pairs once with a
 * code from the desktop app and gets a device cookie (only its hash is kept).
 *
 * With a domain (Settings › Security › Address & HTTPS) Atlas also answers
 * at https://<domain>: on ports 443 and 80 with its own Let's Encrypt
 * certificate (main/web/tls.ts), or behind a proxy that does HTTPS.
 */
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve4 } from 'node:dns/promises'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { networkInterfaces } from 'node:os'
import { dirname, extname, join, normalize, sep } from 'node:path'
import type { TLSSocket } from 'node:tls'
import { Readable } from 'node:stream'

import { CH, type ReplyEvent } from '../../shared/ipc.ts'
import { allowedHost, CODE_TTL_MS, DEFAULT_WEB_PORT, DEVICE_COOKIE, deviceName, PairGuard, parseWebChange, readCookie, sameOrigin, TICKET_TTL_MS, WA, WEB_BLOCKED, type WebAccessView } from '../../shared/web.ts'
import { decodeWire, encodeWire, parseClientMessage, SCHEME_PATH, WEB_SCHEMES, type ServerMessage } from '../../shared/wire.ts'
import { HANDS_PATH } from '../../shared/hands.ts'
import { ACX, DEFAULT_ACCESS, isDomainHost, parseAccess, parseDomain, type AccessSettings, type AccessView } from '../../shared/access.ts'
import { acceptUpgrade, refuseUpgrade, type WsConnection } from './socket.ts'
import { Certificates, explainAcme } from './tls.ts'
import { traefikPanel, writeTraefikRoute, type TraefikPanel } from './traefik.ts'
import { cleanCode } from '../hands/installer.ts'

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
  /** A domain, and who does its HTTPS. */
  access: AccessSettings
}

/**
 * The first start's domain from the environment (a Docker or Dokploy deployment): ATLAS_DOMAIN, and
 * ATLAS_HTTPS=proxy (the default: Dokploy, Traefik, Caddy do HTTPS) or acme (Atlas does it). After that,
 * Settings › Address & HTTPS is where it changes.
 */
const envAccess = (): AccessSettings => {
  const domain = parseDomain(process.env.ATLAS_DOMAIN)
  if (!domain) return DEFAULT_ACCESS
  return { mode: process.env.ATLAS_HTTPS === 'acme' ? 'acme' : 'proxy', domain, email: null }
}

/** Ports for a domain with Atlas's own HTTPS (80 for Let's Encrypt and the redirect). */
const HTTP_PORT = Number(process.env.ATLAS_HTTP_PORT) || 80
const HTTPS_PORT = Number(process.env.ATLAS_HTTPS_PORT) || 443

interface Client {
  id: string
  deviceId: string
  conn: WsConnection
  /** The full page in a browser, or the desktop widget (?client=widget). */
  kind: 'page' | 'widget'
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
  /** The atlas command on this PC: open the page, or quit, or a new pairing code (a server). Asked with the control token (kept beside the data, never sent to a page). */
  control?: { token: string; act: (action: 'open' | 'quit') => void }
  /** Other machines' hands: pairing, their connections, and the page's calls that go to the machine Atlas works on. */
  hands?: {
    pair: (body: string) => { status: number; body: unknown }
    accept: (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void
    handlerFor: (channel: string) => Handler | undefined
    /** The hands package and the one-line installers (main/hands/installer.ts). */
    package: () => Buffer
    script: (kind: 'ps1' | 'sh', brain: string, code: string) => string
  }
  /**
   * A server: Atlas listens on every address and answers to any host name
   * (it is meant to be reached from outside, by IP or by its domain), and the
   * first browser pairs with a code printed in the server's log.
   */
  server?: boolean
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
  /** Atlas's own certificate, when it does the domain's HTTPS. */
  private readonly certs: Certificates
  private secure: import('node:https').Server | null = null
  private plain: Server | null = null
  private accessError: string | null = null
  private dns: AccessView['dns'] = null
  private renewTimer: NodeJS.Timeout | null = null
  /** Dokploy's Traefik on this server (install.sh prepared its route file), or null. */
  private readonly panel: TraefikPanel | null = traefikPanel()

  constructor(private readonly deps: WebAccessDeps) {
    this.stored = this.load()
    this.certs = new Certificates({ dir: join(dirname(deps.file), 'tls'), log: deps.log })
  }

  // ── settings ──────────────────────────────────────────────

  private load(): Stored {
    const fallback: Stored = { enabled: true, lan: false, port: DEFAULT_WEB_PORT, devices: [], access: envAccess() }
    try {
      const v = JSON.parse(readFileSync(this.deps.file, 'utf8')) as Partial<Stored>
      return {
        enabled: typeof v.enabled === 'boolean' ? v.enabled : fallback.enabled,
        lan: v.lan === true,
        port: Number.isInteger(v.port) && v.port! > 1024 && v.port! < 65536 ? v.port! : fallback.port,
        devices: Array.isArray(v.devices) ? v.devices.filter(d => d && typeof d.hash === 'string' && typeof d.id === 'string') : [],
        access: v.access ? { ...DEFAULT_ACCESS, ...(parseAccess(v.access) ?? {}) } : envAccess(),
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
    if (!this.stored.lan && !this.deps.server) return []
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
      urls: running ? [...(this.publicUrl ? [this.publicUrl] : []), `http://localhost:${this.port}`, ...this.lanAddresses().map(a => `http://${a}:${this.port}`)] : [],
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
      this.newCode()
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

    handle(ACX.state, () => {
      requireOwner()
      return this.accessView()
    })
    handle(ACX.set, async raw => {
      requireOwner()
      const change = parseAccess(raw)
      if (!change) throw new Error('Check the domain (like atlas.example.com) and the email.')
      const next = { ...this.stored.access, ...change }
      if (next.mode !== 'off' && !next.domain) throw new Error('Type the domain first (like atlas.example.com).')
      if (this.panel && next.mode === 'acme') throw new Error(`${this.panel.name} already serves ports 80 and 443 on this server: choose “through ${this.panel.name}”, and it gives the domain its certificate.`)
      this.stored = { ...this.stored, access: next }
      this.accessError = null
      this.dns = null
      this.save()
      this.routeThroughPanel()
      await this.listenPublic()
      this.publishAccess()
      // Let's Encrypt chosen and no certificate yet: ask for one now (the page shows the progress).
      if (next.mode === 'acme' && next.domain && this.certs.needsRenewal(next.domain)) void this.issue()
      return this.accessView()
    })
    handle(ACX.issue, () => {
      requireOwner()
      if (this.stored.access.mode !== 'acme' || !this.stored.access.domain) throw new Error("Choose “My domain, HTTPS by Atlas” first.")
      void this.issue()
      return this.accessView()
    })
    handle(ACX.checkDns, async () => {
      requireOwner()
      await this.checkDns()
      return this.accessView()
    })
  }

  // ── a domain and HTTPS ────────────────────────────────────

  /** The address to open Atlas at from anywhere: https://<domain> once it serves HTTPS. */
  get publicUrl(): string | null {
    const a = this.stored.access
    if (!a.domain) return null
    if (a.mode === 'proxy') return `https://${a.domain}`
    if (a.mode === 'acme' && this.secure && this.certs.current?.domain === a.domain) return `https://${a.domain}${HTTPS_PORT === 443 ? '' : `:${HTTPS_PORT}`}`
    return null
  }

  /** Behind the panel's Traefik: the route file follows the domain (none when it is off). */
  private routeThroughPanel() {
    if (!this.panel) return
    const a = this.stored.access
    try {
      writeTraefikRoute(this.panel, a.mode === 'proxy' ? a.domain : null)
      if (a.mode === 'proxy' && a.domain) this.deps.log('info', `${this.panel.name}'s Traefik routes https://${a.domain} to Atlas.`)
    } catch (e) {
      this.accessError = (e as Error).message
      this.deps.log('warn', this.accessError)
    }
  }

  accessView(): AccessView {
    const a = this.stored.access
    const held = a.domain ? this.certs.load(a.domain) : null
    return {
      ...a,
      certificate: held ? { domain: held.domain, expires: held.expires, issuer: held.issuer } : null,
      issuing: this.certs.issuing,
      listening: { http: this.plain !== null, https: this.secure !== null },
      url: this.publicUrl,
      dns: this.dns,
      panel: this.panel?.name ?? null,
      error: this.accessError,
    }
  }

  private publishAccess() {
    this.broadcast(ACX.changed, this.accessView())
    this.publish()
  }

  /** Where the domain points, and this server's public address, so the owner can see a mismatch. */
  private async checkDns() {
    const d = this.stored.access.domain
    if (!d) return
    const [addresses, publicIp] = await Promise.all([
      resolve4(d).catch(() => [] as string[]),
      fetch('https://api.ipify.org', { signal: AbortSignal.timeout(6_000) })
        .then(r => (r.ok ? r.text() : null))
        .then(t => (t && /^\d{1,3}(\.\d{1,3}){3}$/.test(t.trim()) ? t.trim() : null))
        .catch(() => null),
    ])
    this.dns = { addresses, publicIp }
  }

  private async issue() {
    const { domain, email } = this.stored.access
    if (!domain) return
    this.accessError = null
    const job = this.certs.issue(domain, email)
    this.publishAccess()
    try {
      await job
      await this.listenPublic()
    } catch (e) {
      this.accessError = explainAcme(e, domain)
      this.deps.log('warn', this.accessError)
      await this.checkDns()
    }
    this.publishAccess()
  }

  /** Was this request made over HTTPS (here, or at the proxy in front)? */
  private isSecure(req: IncomingMessage) {
    return Boolean((req.socket as TLSSocket).encrypted) || (this.stored.access.mode === 'proxy' && req.headers['x-forwarded-proto'] === 'https')
  }

  /**
   * Ports 80 and 443 for a domain with Atlas's own HTTPS: 80 answers Let's
   * Encrypt and sends everyone else to https; 443 serves Atlas with the
   * certificate (swapped in on renewal without a restart).
   */
  private async listenPublic() {
    const a = this.stored.access
    const want = a.mode === 'acme' && a.domain !== null
    const close = (s: Server | null) => (s ? new Promise<void>(r => s.close(() => r())) : Promise.resolve())
    if (!want) {
      await Promise.all([close(this.plain), close(this.secure)])
      this.plain = this.secure = null
      if (this.renewTimer) clearInterval(this.renewTimer)
      this.renewTimer = null
      return
    }
    const bind = (s: Server, port: number) =>
      new Promise<string | null>(resolve => {
        s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message))
        s.listen(port, process.env.ATLAS_HOST ?? '0.0.0.0', () => resolve(null))
      })
    const portHelp = (port: number, code: string) =>
      code === 'EACCES'
        ? `Port ${port} needs permission. On Linux: sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(which node)")" (install.sh does this), or run Atlas in Docker with the ports mapped.`
        : code === 'EADDRINUSE'
          ? `Port ${port} is already used by another program (a web server?). Stop it, or put Atlas behind it and choose “behind a proxy”.`
          : `Port ${port}: ${code}`
    if (!this.plain) {
      const s = createServer((req, res) => this.port80(req, res))
      const err = await bind(s, HTTP_PORT)
      if (err) this.accessError = portHelp(HTTP_PORT, err)
      else this.plain = s
    }
    const held = this.certs.load(a.domain!)
    // Another domain now, with no certificate yet: nothing is served under the old one.
    if (this.secure && !held) {
      await close(this.secure)
      this.secure = null
    }
    // A renewed certificate is swapped in without a restart (for every client, with or without SNI).
    if (this.secure && held) this.secure.setSecureContext({ cert: held.cert, key: held.key })
    if (!this.secure && held) {
      const s = createHttpsServer({ cert: held.cert, key: held.key }, (req, res) => void this.http(req, res).catch(() => this.send(res, 500, 'Error')))
      s.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
      const err = await bind(s, HTTPS_PORT)
      if (err) this.accessError = portHelp(HTTPS_PORT, err)
      else {
        this.secure = s
        this.deps.log('info', `Atlas answers at ${this.publicUrl}`)
      }
    }
    // Renewal: looked at twice a day, done when fewer than 30 days are left.
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => {
        const d = this.stored.access.domain
        if (this.stored.access.mode === 'acme' && d && this.certs.needsRenewal(d) && !this.certs.issuing) void this.issue()
      }, 12 * 3600_000)
      this.renewTimer.unref()
    }
  }

  /** Port 80: Let's Encrypt's challenge, else on to https (or Atlas itself until there is a certificate). */
  private port80(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://atlas')
    const m = /^\/\.well-known\/acme-challenge\/([\w-]{10,200})$/.exec(url.pathname)
    if (m) {
      const answer = this.certs.challenge(m[1]!)
      return answer ? this.send(res, 200, answer) : this.send(res, 404, 'Not found')
    }
    const domain = this.stored.access.domain
    if (domain && this.secure && isDomainHost(req.headers.host, domain)) {
      res.writeHead(301, { Location: `https://${domain}${HTTPS_PORT === 443 ? '' : `:${HTTPS_PORT}`}${req.url ?? '/'}`, ...SECURITY_HEADERS })
      return res.end()
    }
    void this.http(req, res).catch(() => this.send(res, 500, 'Error'))
  }

  /** Atlas's address on this PC, or null while the server is not up. */
  get url() {
    return this.server ? `http://localhost:${this.port}` : null
  }

  /** Atlas's address with a one-time pairing ticket: whoever opens it within the time is paired. */
  pairingUrl(ttlMs = TICKET_TTL_MS, path = '/') {
    return `http://localhost:${this.port}${path}#pair=${this.ticket(ttlMs)}`
  }

  /** A one-time pairing ticket (a machine's widget opens the page with it). */
  ticket(ttlMs = TICKET_TTL_MS) {
    if (!this.server) throw new Error(this.error ?? 'Atlas is not serving its page.')
    const now = Date.now()
    const ticket = { value: randomBytes(24).toString('base64url'), expires: now + ttlMs }
    this.tickets = [...this.tickets.filter(t => t.expires > now).slice(-7), ticket]
    return ticket.value
  }

  /** A pairing code for the next browser (a server prints it: there is no desktop app to show it). */
  newCode() {
    this.code = { value: String(randomInt(0, 1_000_000)).padStart(6, '0'), expires: Date.now() + CODE_TTL_MS }
    this.guard.reset()
    this.publish()
    return this.code.value
  }

  /** Browsers paired so far. */
  get pairedCount() {
    return this.stored.devices.length
  }

  /** Names this Atlas answers to: a server answers to any (its IP, its domain), a PC to its own and its domain. */
  private hostOk(host: string | undefined) {
    return this.deps.server ? Boolean(host) : allowedHost(host, this.port, this.lanAddresses()) || (this.stored.access.mode !== 'off' && isDomainHost(host, this.stored.access.domain))
  }

  /** Opens Atlas in the default browser, paired at once by a one-time ticket. */
  openInBrowser() {
    this.deps.openExternal(this.pairingUrl())
  }

  // ── server ────────────────────────────────────────────────

  async start() {
    await this.listen()
    // A domain set before (or from ATLAS_DOMAIN on the first start): its route is there again.
    this.routeThroughPanel()
    await this.listenPublic()
    this.publish()
    // A certificate close to its end at start: renew it now.
    const a = this.stored.access
    if (a.mode === 'acme' && a.domain && this.plain && this.certs.needsRenewal(a.domain)) void this.issue()
  }

  private async restart() {
    await this.stop()
    await this.start()
  }

  async stop() {
    for (const c of [...this.clients.values()]) c.conn.close(1001)
    this.clients.clear()
    const all = [this.server, this.secure, this.plain]
    this.server = this.secure = this.plain = null
    this.port = 0
    if (this.renewTimer) clearInterval(this.renewTimer)
    this.renewTimer = null
    await Promise.all(all.map(s => (s ? new Promise<void>(r => s.close(() => r())) : undefined)))
  }

  private async listen() {
    this.error = null
    const host = this.deps.server ? (process.env.ATLAS_HOST ?? '0.0.0.0') : this.stored.lan ? '0.0.0.0' : '127.0.0.1'
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
    if (!this.hostOk(req.headers.host)) return this.send(res, 403, 'Forbidden')
    const url = new URL(req.url ?? '/', 'http://atlas')
    const path = url.pathname

    // The one-line installers for a PC, and the hands package they fetch (no data, no keys: the open-source code).
    if (this.deps.hands && req.method === 'GET' && (path === '/hands/atlas-hands.tgz' || path === '/hands/install.ps1' || path === '/hands/install.sh')) {
      try {
        if (path.endsWith('.tgz')) {
          const data = this.deps.hands.package()
          res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': String(data.length), 'Cache-Control': 'no-store', ...SECURITY_HEADERS })
          return res.end(data)
        }
        const code = cleanCode(url.searchParams.get('code'))
        if (!code) return this.send(res, 400, 'Add the code: ?code=ABCD-EFGH (Settings › Machines › Add a machine).')
        // The address this PC used to reach Atlas: the one its hands should use too.
        const brain = `${this.isSecure(req) ? 'https' : 'http'}://${req.headers.host}`
        return this.send(res, 200, this.deps.hands.script(path.endsWith('.ps1') ? 'ps1' : 'sh', brain, code))
      } catch (e) {
        return this.send(res, 500, e instanceof Error ? e.message : 'Could not make the installer.')
      }
    }
    if (path === '/api/hands/pair' && req.method === 'POST') {
      // Atlas's hands on another machine, never a page.
      if (!this.deps.hands || req.headers.origin) return this.send(res, 403, 'Forbidden')
      let text: string
      try {
        text = await this.body(req)
      } catch {
        return this.send(res, 413, 'Too large')
      }
      const r = this.deps.hands.pair(text)
      return this.send(res, r.status, JSON.stringify(r.body), 'application/json')
    }
    if (path === '/api/control' && req.method === 'POST') {
      const c = this.deps.control
      const given = req.headers['x-atlas-control']
      // Browsers cannot read the token, and a page's request carries an Origin: the command line never does.
      if (!c || req.headers.origin || typeof given !== 'string' || given.length !== c.token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(c.token))) return this.send(res, 403, 'Forbidden')
      const action = url.searchParams.get('action')
      // A new pairing code, for the atlas command on a server (atlas pair).
      if (action === 'code') return this.send(res, 200, JSON.stringify({ code: this.newCode(), expires: this.code!.expires }), 'application/json')
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
    return this.send(res, 200, '{"ok":true}', 'application/json', { 'Set-Cookie': `${DEVICE_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${this.isSecure(req) ? '; Secure' : ''}` })
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
    if (url.pathname === HANDS_PATH && this.deps.hands) {
      if (!this.hostOk(req.headers.host)) return refuseUpgrade(socket, 403)
      return this.deps.hands.accept(req, socket, head)
    }
    if (url.pathname !== '/ws') return refuseUpgrade(socket, 404)
    if (!this.hostOk(req.headers.host) || !sameOrigin(req.headers.origin, req.headers.host)) return refuseUpgrade(socket, 403)
    const device = this.device(req)
    if (!device) return refuseUpgrade(socket, 401)
    const conn = acceptUpgrade(req, socket, head)
    if (!conn) return
    const client: Client = { id: randomUUID(), deviceId: device.id, conn, kind: url.searchParams.get('client') === 'widget' ? 'widget' : 'page' }
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
    // The brain's own channels first; the rest go to the machine Atlas works on (its This PC settings).
    const fn = this.deps.handlers.get(m.ch) ?? this.deps.hands?.handlerFor(m.ch)
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

  /** Something shows Atlas: a page or the desktop widget. */
  get hasClients() {
    return this.clients.size > 0
  }

  /** A full page is open in a browser (the widget alone does not count). */
  get hasPages() {
    return [...this.clients.values()].some(c => c.kind === 'page')
  }

  /** The desktop widget is connected. */
  get hasWidget() {
    return [...this.clients.values()].some(c => c.kind === 'widget')
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
    const send = (to: Client) => to.conn.send(encodeWire({ t: 'ev', ch: CH.reply, v: e } satisfies ServerMessage))
    if (c) return send(c)
    if (owner || windowUp) return
    // Nobody asked (Atlas spoke up): the desktop widget is its voice when there is one, so a page and the widget never both speak.
    const widget = [...this.clients.values()].find(x => x.kind === 'widget')
    if (widget) send(widget)
    else this.broadcast(CH.reply, e)
  }
}
