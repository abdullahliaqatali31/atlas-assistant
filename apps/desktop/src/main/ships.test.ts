import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseAisMessage, shipCategory } from '../shared/world.ts'
import { ShipFeed } from './ships.ts'

const KEY = 'abcdef0123456789abcdef0123456789abcdef01'

/** A stand-in for AISStream's WebSocket. */
class FakeSocket {
  static last: FakeSocket | null = null
  readyState = 0
  sent: string[] = []
  private handlers: Record<string, ((ev: { data?: unknown }) => void)[]> = {}
  constructor(readonly url: string) {
    FakeSocket.last = this
  }
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void) {
    ;(this.handlers[type] ??= []).push(fn)
  }
  send(text: string) {
    this.sent.push(text)
  }
  close() {
    this.readyState = 3
    this.emit('close')
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.handlers[type] ?? []) fn({ data })
  }
  open() {
    this.readyState = 1
    this.emit('open')
  }
}

const store = () => {
  const m = new Map<string, string>()
  return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v), delete: (k: string) => void m.delete(k), raw: m }
}

const POSITION = {
  MessageType: 'PositionReport',
  MetaData: { MMSI: 463012345, ShipName: 'KARACHI STAR  ', latitude: 24.8, longitude: 66.95, time_utc: '2026-10-18 08:30:12.123456789 +0000 UTC' },
  Message: { PositionReport: { Sog: 11.2, Cog: 245, TrueHeading: 247 } },
}
const STATIC = {
  MessageType: 'ShipStaticData',
  MetaData: { MMSI: 463012345, ShipName: 'KARACHI STAR', latitude: 24.8, longitude: 66.95, time_utc: '2026-10-18 08:31:00.000 +0000 UTC' },
  Message: { ShipStaticData: { Name: 'KARACHI STAR', Type: 71, Destination: 'JEBEL ALI ', Dimension: { A: 150, B: 40, C: 15, D: 15 } } },
}

afterEach(() => vi.useRealTimers())

describe('AIS messages', () => {
  it('read positions and ship details', () => {
    expect(parseAisMessage(POSITION)).toEqual({
      mmsi: 463012345,
      fields: { name: 'KARACHI STAR', lat: 24.8, lon: 66.95, speed: 11.2, course: 245, heading: 247, at: Date.parse('2026-10-18T08:30:12Z') },
    })
    expect(parseAisMessage(STATIC)?.fields).toMatchObject({ type: 71, destination: 'JEBEL ALI', length: 190 })
    expect(parseAisMessage({ MessageType: 'PositionReport', MetaData: { MMSI: 1, latitude: 91, longitude: 0 }, Message: { PositionReport: {} } })).toBeNull()
    expect(parseAisMessage({ hello: 1 })).toBeNull()
    expect([shipCategory(71), shipCategory(84), shipCategory(60), shipCategory(30), shipCategory(35), shipCategory(null)]).toEqual(['Cargo', 'Tanker', 'Passenger', 'Fishing', 'Military', 'Other'])
  })
})

describe('ShipFeed', () => {
  it('needs a key, checks it, and keeps it only in the credential store', () => {
    const secrets = store()
    const feed = new ShipFeed({ secrets: secrets as never, log: () => {}, WebSocketImpl: FakeSocket as never })
    expect(feed.view({ south: 20, west: 60, north: 30, east: 70 }).status).toBe('no-key')
    expect(() => feed.setKey('short')).toThrow(/does not look like/)
    feed.setKey(KEY)
    expect(secrets.raw.get('AISSTREAM_API_KEY')).toBe(KEY)
    expect(feed.hasKey).toBe(true)
    feed.setKey(null)
    expect(feed.hasKey).toBe(false)
  })

  it('subscribes to the area on screen and shows the ships reported there', async () => {
    vi.useFakeTimers()
    const secrets = store()
    secrets.set('AISSTREAM_API_KEY', KEY)
    const feed = new ShipFeed({ secrets: secrets as never, log: () => {}, WebSocketImpl: FakeSocket as never })
    const box = { south: 22, west: 60, north: 27, east: 70 }
    expect(feed.view(box).status).toBe('connecting')
    const ws = FakeSocket.last!
    ws.open()
    const sub = JSON.parse(ws.sent[0]!)
    expect(sub.APIKey).toBe(KEY)
    expect(sub.BoundingBoxes[0][0][0]).toBeLessThan(22)
    expect(sub.BoundingBoxes[0][1][1]).toBeGreaterThan(70)
    vi.setSystemTime(Date.parse('2026-10-18T08:35:00Z'))
    ws.emit('message', JSON.stringify(POSITION))
    ws.emit('message', JSON.stringify(STATIC))
    await Promise.resolve()
    const r = feed.view(box)
    expect(r.status).toBe('live')
    expect(r.ships[0]).toMatchObject({ name: 'KARACHI STAR', category: 'Cargo', destination: 'JEBEL ALI', speed: 11.2 })
    // A small pan inside the wider subscription sends nothing new; a far one re-subscribes.
    feed.view({ south: 23, west: 61, north: 26, east: 69 })
    expect(ws.sent).toHaveLength(1)
    feed.view({ south: 40, west: 0, north: 45, east: 10 })
    expect(ws.sent).toHaveLength(2)
    // The map stops asking: the connection closes after a minute and a half.
    vi.advanceTimersByTime(91_000)
    expect(ws.readyState).toBe(3)
  })

  it('reconnects after a drop, keeping the last positions, with growing waits', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-10-18T08:35:00Z'))
    const secrets = store()
    secrets.set('AISSTREAM_API_KEY', KEY)
    const feed = new ShipFeed({ secrets: secrets as never, log: () => {}, WebSocketImpl: FakeSocket as never })
    const box = { south: 22, west: 60, north: 27, east: 70 }
    feed.view(box)
    const first = FakeSocket.last!
    first.open()
    first.emit('message', JSON.stringify(POSITION))
    await Promise.resolve()
    // The network blips: an error, then a close.
    first.emit('error')
    first.emit('close')
    let r = feed.view(box)
    expect(r.status).toBe('reconnecting')
    expect(r.ships).toHaveLength(1)
    expect(r.message).toMatch(/last positions/)
    expect(FakeSocket.last).toBe(first)
    vi.advanceTimersByTime(2_000)
    const second = FakeSocket.last!
    expect(second).not.toBe(first)
    second.open()
    expect(JSON.parse(second.sent[0]!).BoundingBoxes[0][0][0]).toBeLessThan(22)
    // It drops again at once: the next wait is longer.
    second.emit('close')
    vi.advanceTimersByTime(2_000)
    expect(FakeSocket.last).toBe(second)
    vi.advanceTimersByTime(3_000)
    expect(FakeSocket.last).not.toBe(second)
    FakeSocket.last!.open()
    FakeSocket.last!.emit('message', JSON.stringify(POSITION))
    await Promise.resolve()
    r = feed.view(box)
    expect(r).toMatchObject({ status: 'live', message: null })
  })

  it('replaces a socket that goes quiet, and retries on errors other than the key', async () => {
    vi.useFakeTimers()
    const secrets = store()
    secrets.set('AISSTREAM_API_KEY', KEY)
    const logs: string[] = []
    const feed = new ShipFeed({ secrets: secrets as never, log: (_l, m) => logs.push(m), WebSocketImpl: FakeSocket as never })
    const box = { south: 22, west: 60, north: 27, east: 70 }
    feed.view(box)
    const quiet = FakeSocket.last!
    quiet.open()
    vi.advanceTimersByTime(30_000)
    feed.view(box)
    vi.advanceTimersByTime(16_000)
    expect(quiet.readyState).toBe(3)
    vi.advanceTimersByTime(2_000)
    const next = FakeSocket.last!
    expect(next).not.toBe(quiet)
    next.open()
    next.emit('message', JSON.stringify({ error: 'Concurrent connections per user exceeded' }))
    await Promise.resolve()
    expect(feed.view(box).status).toBe('reconnecting')
    expect(logs.join(' ')).toMatch(/Concurrent connections/)
  })

  it('reports a rejected key without repeating it, and stops trying', () => {
    const secrets = store()
    secrets.set('AISSTREAM_API_KEY', KEY)
    const logs: string[] = []
    const feed = new ShipFeed({ secrets: secrets as never, log: (_l, m) => logs.push(m), WebSocketImpl: FakeSocket as never })
    feed.view({ south: 20, west: 60, north: 30, east: 70 })
    const ws = FakeSocket.last!
    ws.open()
    ws.emit('message', JSON.stringify({ error: `Api Key Is Not Valid: ${KEY}` }))
    const r = feed.view({ south: 20, west: 60, north: 30, east: 70 })
    expect(r).toMatchObject({ status: 'error', message: 'AISStream did not accept the key.' })
    expect(logs.join(' ')).not.toContain(KEY)
    expect(FakeSocket.last).toBe(ws)
  })
})
