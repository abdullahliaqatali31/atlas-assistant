/**
 * A small WebSocket server side (RFC 6455) for the web interface: text
 * messages, fragmentation, ping and close, and compression (RFC 7692,
 * permessage-deflate without context takeover: each message stands alone).
 * Nothing else is needed, and a few dozen lines are easier to audit than
 * another dependency.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { constants, deflateRaw, inflateRawSync } from 'node:zlib'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** A message larger than this closes the connection (recorded voice is well below). */
export const MAX_MESSAGE = 24 * 1024 * 1024
const PING_MS = 25_000
/** Messages smaller than this go as they are: compressing them saves nothing worth the time. */
const COMPRESS_FROM = 1024
const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff])

export class WsConnection {
  private buf: Buffer = Buffer.alloc(0)
  private parts: Buffer[] = []
  private partsBytes = 0
  private closed = false
  private alive = true
  private readonly ping: NodeJS.Timeout
  private messageCb: (text: string) => void = () => undefined
  private closeCbs: (() => void)[] = []
  /** The message being read was compressed (its first frame said so). */
  private compressed = false
  /** Sends in order: a compressed message may take a moment, and nothing may overtake it. */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly socket: Duplex,
    private readonly deflate = false,
  ) {
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
    if (this.closed) return
    const raw = Buffer.from(text, 'utf8')
    if (!this.deflate || raw.length < COMPRESS_FROM) {
      this.queue = this.queue.then(() => this.frame(0x1, raw))
      return
    }
    // Compressed off the main thread (zlib's pool); level 5 is most of the saving for little time.
    const packed = new Promise<Buffer | null>(res => deflateRaw(raw, { level: 5, finishFlush: constants.Z_SYNC_FLUSH }, (err, out) => res(err ? null : out)))
    this.queue = this.queue.then(async () => {
      const out = await packed
      // The sync flush ends in 00 00 ff ff, which the extension leaves out.
      if (out && out.subarray(-4).equals(TAIL)) this.frame(0x1, out.subarray(0, -4), true)
      else this.frame(0x1, raw)
    })
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

  private frame(opcode: number, payload: Buffer, compressed = false) {
    if (this.closed && opcode !== 0x8) return
    const n = payload.length
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
    head[0] = 0x80 | (compressed ? 0x40 : 0) | opcode
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
      // RSV1 on the first frame of a message: it is compressed (only when agreed).
      if (opcode !== 0x0) this.compressed = (b0 & 0x40) !== 0
      if (this.compressed && !this.deflate) return this.close(1002)
      this.partsBytes += payload.length
      if (this.partsBytes > MAX_MESSAGE) return this.close(1009)
      this.parts.push(payload)
      if (!fin) continue
      let whole = Buffer.concat(this.parts)
      this.parts = []
      this.partsBytes = 0
      if (this.compressed) {
        try {
          whole = inflateRawSync(Buffer.concat([whole, TAIL]), { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: MAX_MESSAGE })
        } catch {
          return this.close(1007)
        }
      }
      this.messageCb(whole.toString('utf8'))
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
  // Compression when the browser offers it; neither side keeps a dictionary between messages, so memory stays flat.
  const deflate = String(req.headers['sec-websocket-extensions'] ?? '')
    .split(',')
    .some(e => e.split(';')[0]!.trim() === 'permessage-deflate')
  const ext = deflate ? ['Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover'] : []
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, ...ext, '', ''].join('\r\n'))
  const conn = new WsConnection(socket, deflate)
  if (head.length) socket.unshift(head)
  return conn
}

/** Refuses an upgrade with a plain HTTP status. */
export const refuseUpgrade = (socket: Duplex, status: 401 | 403 | 404) => {
  const text = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found'
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
}
