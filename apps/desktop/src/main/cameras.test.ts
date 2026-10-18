import { describe, expect, it, vi } from 'vitest'

import { parseCameraSources } from '../shared/world.ts'
import { CameraDirectory } from './cameras.ts'

describe('public cameras', () => {
  it('reads each agency’s format into one list, skipping broken entries', () => {
    const cams = parseCameraSources({
      tfl: [
        { id: 'JamCams_00002.00865', commonName: 'A406 Billet Upass E', lat: 51.60067, lon: -0.01594, additionalProperties: [{ key: 'available', value: 'true' }, { key: 'imageUrl', value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.jpg' }] },
        { id: 'JamCams_off', commonName: 'Off', lat: 51.5, lon: -0.1, additionalProperties: [{ key: 'available', value: 'false' }, { key: 'imageUrl', value: 'https://x/y.jpg' }] },
      ],
      caltrans: [
        {
          data: [
            { cctv: { index: '1', inService: 'true', location: { district: '7', locationName: 'I-110 : Avenue 26', latitude: '34.0837', longitude: '-118.2215' }, imageData: { static: { currentImageURL: 'https://cwwp2.dot.ca.gov/data/d7/cctv/image/a/a.jpg' } } } },
            { cctv: { index: '2', inService: 'false', location: { district: '7', latitude: '34', longitude: '-118' }, imageData: { static: { currentImageURL: 'https://x/y.jpg' } } } },
          ],
        },
      ],
      finland: { features: [{ id: 'C01503', geometry: { coordinates: [23.99616, 60.05374, 0] }, properties: { name: 'kt51_Inkoo', presets: [{ id: 'C0150301', inCollection: true }] } }] },
      hongKong: '<image-list><image><key>H429F</key><description>Aberdeen Praya Road near Fish Market [H429F]</description><latitude>22.24845</latitude><longitude>114.1505</longitude><url>https://tdcctv.data.one.gov.hk/H429F.JPG</url></image></image-list>',
      singapore: { items: [{ cameras: [{ camera_id: '2701', image: 'https://images.data.gov.sg/api/traffic-images/2026/10/a.jpg', location: { latitude: 1.447, longitude: 103.77 } }, { camera_id: 'bad', image: 'http://insecure/x.jpg', location: { latitude: 1, longitude: 103 } }] }] },
    })
    expect(cams.map(c => c.id)).toEqual(['tfl:JamCams_00002.00865', 'ct:7-1', 'fi:C0150301', 'hk:H429F', 'sg:2701'])
    expect(cams.find(c => c.id === 'fi:C0150301')).toMatchObject({ name: 'kt51 Inkoo', image: 'https://weathercam.digitraffic.fi/C0150301.jpg', country: 'Finland' })
    expect(cams.find(c => c.id === 'ct:7-1')).toMatchObject({ lat: 34.0837, lon: -118.2215, source: 'Caltrans' })
  })

  it('only fetches images of cameras on the list, and only images', async () => {
    const dir = new CameraDirectory()
    // A list with one camera, without touching the network.
    ;(dir as unknown as { list: unknown }).list = { at: Date.now(), cameras: [{ id: 'hk:H429F', name: 'x', lat: 22, lon: 114, country: 'Hong Kong', source: 'HK', image: 'https://tdcctv.data.one.gov.hk/H429F.JPG' }] }
    await expect(dir.image('hk:OTHER')).rejects.toThrow(/Unknown camera/)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>', { headers: { 'content-type': 'text/html' } }))
    await expect(dir.image('hk:H429F')).rejects.toThrow(/did not send an image/)
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } }))
    const r = await dir.image('hk:H429F')
    expect(r.dataUrl).toBe('data:image/jpeg;base64,/9j/')
    fetchMock.mockRestore()
  })
})

describe.skipIf(!process.env.ATLAS_LIVE)('public cameras, live', () => {
  it('loads the real lists and one real frame per country', { timeout: 180_000 }, async () => {
    const dir = new CameraDirectory((l, m) => console.log(l, m))
    const cams = await dir.cameras()
    const by = new Map<string, typeof cams>()
    for (const c of cams) by.set(c.country, [...(by.get(c.country) ?? []), c])
    console.log([...by].map(([k, v]) => `${k}: ${v.length}`).join(', '))
    for (const [country, list] of by) {
      const r = await dir.image(list[0]!.id).catch(e => ({ dataUrl: `ERROR ${String(e.message)}`, at: 0 }))
      console.log(`  ${country}: ${r.dataUrl.startsWith('data:image/') ? `${Math.round((r.dataUrl.length * 3) / 4 / 1024)} KB frame` : r.dataUrl}`)
    }
    expect(by.size).toBeGreaterThanOrEqual(4)
  })
})
