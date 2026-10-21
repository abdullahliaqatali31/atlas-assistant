/**
 * The web interface's wire: JSON over a WebSocket, with bytes (recorded voice,
 * spoken sentences) carried as base64, and the messages both sides send.
 */

/** Browser → Atlas. */
export type ClientMessage =
  | { t: 'call'; id: number; ch: string; args: unknown[] }
  | { t: 'send'; ch: string; payload: unknown }

/** Atlas → browser. */
export type ServerMessage =
  | { t: 'ret'; id: number; ok: true; value: unknown }
  | { t: 'ret'; id: number; ok: false; error: string }
  | { t: 'ev'; ch: string; v: unknown }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export const toBase64 = (bytes: Uint8Array): string => {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i]! << 16
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += B64[n >> 18]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '='
  }
  return out
}

const LOOKUP = new Uint8Array(128)
for (let i = 0; i < B64.length; i++) LOOKUP[B64.charCodeAt(i)] = i

export const fromBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/=+$/, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)]!
    const b = LOOKUP[clean.charCodeAt(i + 1)]!
    const c = LOOKUP[clean.charCodeAt(i + 2)] ?? 0
    const d = LOOKUP[clean.charCodeAt(i + 3)] ?? 0
    const n = (a << 18) | (b << 12) | (c << 6) | d
    if (o < out.length) out[o++] = n >> 16
    if (o < out.length) out[o++] = (n >> 8) & 255
    if (o < out.length) out[o++] = n & 255
  }
  return out
}

/** JSON with byte arrays kept as bytes (Node's Buffer included). */
export const encodeWire = (value: unknown): string =>
  JSON.stringify(value, function (this: Record<string, unknown>, key, v: unknown) {
    const raw = this[key]
    return raw instanceof Uint8Array ? { $u8: toBase64(raw) } : v
  })

/**
 * Parses what encodeWire wrote. `rewrite` may change any string on the way
 * in: the browser turns Atlas's private addresses (assistant-news://…) into
 * ones its server answers.
 */
export const decodeWire = (text: string, rewrite?: (s: string) => string): unknown =>
  JSON.parse(text, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as { $u8?: unknown }
      if (typeof o.$u8 === 'string' && Object.keys(o).length === 1) return fromBase64(o.$u8)
    }
    return rewrite && typeof v === 'string' ? rewrite(v) : v
  })

/** Atlas's own schemes, served to the browser under this path. */
export const WEB_SCHEMES = ['assistant-news', 'assistant-model'] as const
export const SCHEME_PATH = '/_scheme/'

/** assistant-news://img/abc → /_scheme/assistant-news/img/abc; anything else unchanged. */
export const schemeToWeb = (s: string): string => {
  for (const scheme of WEB_SCHEMES) if (s.startsWith(`${scheme}://`)) return `${SCHEME_PATH}${scheme}/${s.slice(scheme.length + 3)}`
  return s
}

export const parseClientMessage = (v: unknown): ClientMessage | null => {
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  if (typeof m.ch !== 'string' || m.ch.length > 80) return null
  if (m.t === 'call' && Number.isInteger(m.id) && Array.isArray(m.args) && m.args.length <= 6) return { t: 'call', id: m.id as number, ch: m.ch, args: m.args }
  if (m.t === 'send') return { t: 'send', ch: m.ch, payload: m.payload }
  return null
}
