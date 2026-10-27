import { describe, expect, it } from 'vitest'

import { decodeWire, encodeWire, fromBase64, parseClientMessage, schemeToWeb, toBase64 } from './wire.ts'

describe('wire', () => {
  it('base64 round-trips every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255)
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
      expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes])
    }
  })

  it('keeps bytes as bytes, Buffers included', () => {
    const msg = { t: 'ev', ch: 'x', v: { type: 'audio', data: Buffer.from([1, 2, 255]), nested: [new Uint8Array([7])] } }
    const back = decodeWire(encodeWire(msg)) as typeof msg
    expect(back.v.data).toBeInstanceOf(Uint8Array)
    expect([...back.v.data]).toEqual([1, 2, 255])
    expect([...back.v.nested[0]!]).toEqual([7])
  })

  it('rewrites Atlas addresses for the browser', () => {
    const back = decodeWire(encodeWire({ image: 'assistant-news://img/0123456789abcdef', link: 'https://x.org' }), schemeToWeb) as Record<string, string>
    expect(back.image).toBe('/_scheme/assistant-news/img/0123456789abcdef')
    expect(back.link).toBe('https://x.org')
  })

  it('accepts only well-formed messages', () => {
    expect(parseClientMessage({ t: 'call', id: 1, ch: 'a', args: [] })).toEqual({ t: 'call', id: 1, ch: 'a', args: [] })
    expect(parseClientMessage({ t: 'call', id: 1.5, ch: 'a', args: [] })).toBeNull()
    expect(parseClientMessage({ t: 'call', id: 1, ch: 'a', args: [1, 2, 3, 4, 5, 6, 7] })).toBeNull()
    expect(parseClientMessage({ t: 'eval', ch: 'a' })).toBeNull()
  })
})
