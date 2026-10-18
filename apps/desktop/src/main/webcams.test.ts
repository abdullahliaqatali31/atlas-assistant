import type { CredentialStore } from '@assistant/runtime'
import { describe, expect, it } from 'vitest'

import { parseCameraSources, parseOpenSky, parseWindyClusters, windyBox } from '../shared/world.ts'
import { WebcamService } from './webcams.ts'

const WINDY = [
  {
    webcamId: 1234567890,
    title: 'Karachi: Clifton beach',
    status: 'active',
    location: { latitude: 24.81, longitude: 67.03, city: 'Karachi', country: 'Pakistan' },
    images: { current: { preview: 'https://imgproxy.windy.com/_/preview/plain/current/1234567890/original.jpg?token=x', thumbnail: 'https://imgproxy.windy.com/t.jpg' } },
    player: { live: 'https://webcams.windy.com/webcams/public/embed/player/1234567890/live', day: 'https://webcams.windy.com/webcams/public/embed/player/1234567890/day' },
    urls: { detail: 'https://www.windy.com/webcams/1234567890' },
  },
  { webcamId: 2, title: 'Inactive', status: 'inactive', location: { latitude: 1, longitude: 1 }, images: { current: { preview: 'https://x/y.jpg' } } },
  { webcamId: 3, title: 'No picture', status: 'active', location: { latitude: 1, longitude: 1 }, images: { current: {} } },
  { webcamId: 4, title: 'Timelapse only', status: 'active', location: { latitude: 2, longitude: 2, country: 'Oman' }, images: { current: { preview: 'https://imgproxy.windy.com/p4.jpg' } }, player: { day: 'https://webcams.windy.com/day4' } },
]

const memoryStore = (): CredentialStore => {
  const m = new Map<string, string>()
  return { get: k => m.get(k) ?? null, set: (k, v) => void m.set(k, v), delete: k => void m.delete(k) } as unknown as CredentialStore
}

describe('Windy webcams', () => {
  it('reads active cameras with a picture, preferring the live player over the timelapse', () => {
    const cams = parseWindyClusters(WINDY)
    expect(cams.map(c => c.id)).toEqual(['wc:1234567890', 'wc:4'])
    expect(cams[0]).toMatchObject({ name: 'Karachi: Clifton beach', country: 'Pakistan', source: 'Windy Webcams', player: { kind: 'live' }, link: 'https://www.windy.com/webcams/1234567890' })
    expect(cams[1]?.player).toEqual({ url: 'https://webcams.windy.com/day4', kind: 'timelapse' })
  })

  it('cuts the view to the box Windy allows at each zoom, around its centre', () => {
    // Zoom 4 allows 22.5° of latitude and 45° of longitude.
    expect(windyBox({ south: -10, north: 60, west: 0, east: 120 }, 4)).toEqual({ zoom: 4, north: 36.25, south: 13.75, east: 82.5, west: 37.5 })
    // A small view is left as it is; zoom is clamped to 4-18 and rounded.
    expect(windyBox({ south: 24, north: 25, west: 66, east: 68 }, 6.6)).toEqual({ zoom: 7, north: 25, south: 24, east: 68, west: 66 })
    expect(windyBox({ south: 0, north: 1, west: 0, east: 1 }, 2).zoom).toBe(4)
  })

  it('asks for a key first, keeps it in the credential store, and caches each view', async () => {
    const urls: string[] = []
    const secrets = memoryStore()
    const service = new WebcamService({
      secrets,
      fetch: (async (url: string, init?: RequestInit) => {
        urls.push(url)
        expect((init?.headers as Record<string, string>)['x-windy-api-key']).toBe('abcdefghijklmnopqrstuvwxyz123456')
        return new Response(JSON.stringify(WINDY), { status: 200 })
      }) as typeof fetch,
    })
    const box = { south: 24, north: 25, west: 66, east: 68 }
    expect((await service.view(box, 7)).status).toBe('no-key')
    expect(() => service.setKey('short')).toThrow('Windy Webcams API key')
    service.setKey('abcdefghijklmnopqrstuvwxyz123456')
    expect(secrets.get('WINDY_WEBCAMS_API_KEY')).toBe('abcdefghijklmnopqrstuvwxyz123456')
    const first = await service.view(box, 7)
    expect(first).toMatchObject({ status: 'ok', cameras: [{ id: 'wc:1234567890' }, { id: 'wc:4' }] })
    await service.view(box, 7)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/webcams/api/v3/map/clusters?northLat=25.0000&southLat=24.0000&eastLon=68.0000&westLon=66.0000&zoom=7')
    // Too far out: nothing asked.
    expect((await service.view(box, 3)).cameras).toEqual([])
    expect(urls).toHaveLength(1)
  })

  it('says plainly when Windy refuses the key', async () => {
    const service = new WebcamService({ secrets: memoryStore(), fetch: (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch })
    service.setKey('abcdefghijklmnopqrstuvwxyz123456')
    expect(await service.view({ south: 0, north: 1, west: 0, east: 1 }, 8)).toMatchObject({ status: 'error', message: expect.stringContaining('did not accept the key') })
  })
})

describe('OpenSky', () => {
  it('turns state vectors into aircraft in feet, knots and feet per minute', () => {
    const f = parseOpenSky({
      time: 1000,
      states: [
        ['80162f', 'AIC1ZX  ', 'India', 995, 990, 74.53, 25.89, 11887.2, false, 242.7, 356.7, -0.65, null, 12451, '7700', false, 0],
        ['801645', '', 'India', 998, 998, 77.08, 28.56, null, true, 0, 8.4, null, null, null, null, false, 0],
        ['bad', '', 'X', 0, 0, null, null, null, false, 0, 0, null, null, null, null, false, 0],
      ],
    })
    expect(f).toHaveLength(2)
    expect(f[0]).toMatchObject({ hex: '80162f', callsign: 'AIC1ZX', altitude: 39000, speed: 472, verticalRate: -128, squawk: '7700', seen: 10 })
    expect(f[1]).toMatchObject({ altitude: null, speed: 0 })
  })
})

describe('New Zealand cameras', () => {
  it('reads NZTA cameras and skips ones offline or under maintenance', () => {
    const nz = {
      features: [
        { properties: { id: 1430, Name: 'SH1 WBB Groynes Dr South', Direction: 'Southbound', Offline: 0, UnderMaintenance: 0, ImageUrl: 'https://www.trafficnz.info/camera/706.jpg', Latitude: '-43.449229', Longitude: '172.61162' } },
        { properties: { id: 2, Name: 'Down', Offline: 1, ImageUrl: 'https://www.trafficnz.info/camera/2.jpg', Latitude: '-41', Longitude: '174' } },
      ],
    }
    const cams = parseCameraSources({ nz })
    expect(cams).toHaveLength(1)
    expect(cams[0]).toMatchObject({ id: 'nz:1430', name: 'SH1 WBB Groynes Dr South · Southbound', country: 'New Zealand', lat: -43.449229 })
  })
})
