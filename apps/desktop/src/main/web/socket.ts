/**
 * A small WebSocket server side (RFC 6455) for the web interface: text
 * messages, fragmentation, ping and close. Nothing else is needed, and a
 * few dozen lines are easier to audit than another dependency.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** A message larger than this closes the connection (recorded voice is well below). */
export const MAX_MESSAGE = 24 * 1024 * 1024
const PING_MS = 25_000

export class WsConnection {
  private buf: Buffer = Buffer.alloc(0)
  private parts: Buffer[] = []
  private partsBytes = 0
  private closed = false
  private alive = true
  private readonly ping: NodeJS.Timeout
  private messageCb: (text: string) => void = () => undefined
  private closeCbs: (() => void)[] = []

  constructor(private readonly socket: Duplex) {
    socket.on('data', (d: Buffer) => this.read(d))
    socket.on('close', () => this.finish())
    socket.on('error', () => this.finish())
    // A connection that stops answering pings (a laptop lid shut) is dropped.
    this.ping = setInterval(() => {
      if (!this.alive) return this.destroy()
      this.alive = false
      this.frame(0x9, Buffer.alloc(0))
    }, PING_MS)
    this.ping.unref?.()
  }

  get isOpen() {
    return !this.closed
  }

  onMessage(cb: (text: string) => void) {
    this.messageCb = cb
  }

  onClose(cb: () => void) {
    this.closeCbs.push(cb)
  }

  send(text: string) {
    if (!this.closed) this.frame(0x1, Buffer.from(text, 'utf8'))
  }

  close(code = 1000) {
    if (this.closed) return
    const body = Buffer.alloc(2)
    body.writeUInt16BE(code)
    this.frame(0x8, body)
    this.socket.end()
    this.finish()
  }

  destroy() {
    this.socket.destroy()
    this.finish()
  }

  private finish() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.ping)
    for (const cb of this.closeCbs.splice(0)) cb()
  }

  private frame(opcode: number, payload: Buffer) {
    const n = payload.length
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
    head[0] = 0x80 | opcode
    if (n < 126) head[1] = n
    else if (n < 65536) {
      head[1] = 126
      head.writeUInt16BE(n, 2)
    } else {
      head[1] = 127
      head.writeBigUInt64BE(BigInt(n), 2)
    }
    this.socket.write(Buffer.concat([head, payload]))
  }

  private read(data: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data
    for (;;) {
      if (this.closed || this.buf.length < 2) return
      const b0 = this.buf[0]!
      const b1 = this.buf[1]!
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      // Browsers always mask; an unmasked frame is not a browser.
      if ((b1 & 0x80) === 0) return this.close(1002)
      let len = b1 & 0x7f
      let at = 2
      if (len === 126) {
        if (this.buf.length < 4) return
        len = this.buf.readUInt16BE(2)
        at = 4
      } else if (len === 127) {
        if (this.buf.length < 10) return
        const big = this.buf.readBigUInt64BE(2)
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009)
        len = Number(big)
        at = 10
      }
      if (len > MAX_MESSAGE) return this.close(1009)
      if (this.buf.length < at + 4 + len) return
      const mask = this.buf.subarray(at, at + 4)
      const payload = Buffer.from(this.buf.subarray(at + 4, at + 4 + len))
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!
      this.buf = this.buf.subarray(at + 4 + len)
      this.alive = true

      if (opcode === 0x8) return this.close()
      if (opcode === 0x9) {
        this.frame(0xa, payload)
        continue
      }
      if (opcode === 0xa) continue
      if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) return this.close(1002)
      this.partsBytes += payload.length
      if (this.partsBytes > MAX_MESSAGE) return this.close(1009)
      this.parts.push(payload)
      if (!fin) continue
      const text = Buffer.concat(this.parts).toString('utf8')
      this.parts = []
      this.partsBytes = 0
      this.messageCb(text)
    }
  }
}

/** Answers the HTTP upgrade and returns the connection, or null (the socket is closed) when it is not a WebSocket request. */
export const acceptUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): WsConnection | null => {
  const key = req.headers['sec-websocket-key']
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return null
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'))
  const conn = new WsConnection(socket)
  if (head.length) socket.unshift(head)
  return conn
}

/** Refuses an upgrade with a plain HTTP status. */
export const refuseUpgrade = (socket: Duplex, status: 401 | 403 | 404) => {
  const text = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found'
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
}
