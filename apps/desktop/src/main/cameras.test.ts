import { describe, expect, it, vi } from 'vitest'

import { compassDegrees, parseCameraSources } from '../shared/world.ts'
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

  it('reads the North American, Australian and Norwegian packs, with headings and pinned image hosts', () => {
    const cams = parseCameraSources({
      driveBc: [
        { id: 1081, name: 'Lantzville - N', caption: 'Highway 19 near McKercher Road', location: { coordinates: [-124.110543, 49.251992] }, orientation: 'N', marked_stale: false },
        { id: 9, name: 'Stale', location: { coordinates: [-124, 49] }, marked_stale: true },
      ],
      calgary: [
        { camera_url: { url: 'http://trafficcam.calgary.ca/loc86.jpg' }, camera_location: 'Stoney Trail / Deerfoot Trail SE', point: { coordinates: [-113.9766, 50.9007] } },
        { camera_url: { url: 'http://elsewhere.example/loc1.jpg' }, camera_location: 'Off host', point: { coordinates: [-114, 51] } },
      ],
      nsw: { features: [{ id: 'abc', geometry: { coordinates: [151.10533, -34.02977] }, properties: { title: '5 Ways (Miranda)', direction: 'W', href: 'https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5ways.jpg' } }] },
      wsdot: { features: [{ attributes: { CameraID: 1001, CompassDirection: 'S', CameraTitle: 'I-5 at Interstate Bridge SB', ImageURL: 'https://www.tripcheck.com/RoadCams/cams/a.jpg' }, geometry: { x: -13656007.1, y: 5719738.5 } }] },
      toronto: 'jsonTMCEarthCamerasCallback({"Data":[{"Number":"8001","Name":"YORK ST & BREMNER BLVD","Latitude":"43.643120","Longitude":"-79.381386"},{"Number":"../x","Name":"Bad","Latitude":"43","Longitude":"-79"}]});',
      deldot: { videoCameras: [{ id: 'KCAM001', title: 'DE 1 @ MILFORD NECK ROAD', lat: 38.990931, lon: -75.448625, enabled: true, urls: { m3u8s: 'https://video.deldot.gov:443/live/KCAM001.stream/playlist.m3u8' } }, { id: 'X', title: 'Off', lat: 39, lon: -75, enabled: false, urls: { m3u8s: 'https://video.deldot.gov/x.m3u8' } }] },
      norway: { features: [{ geometry: { coordinates: [5.459189, 61.832706] }, properties: { cameraId: '3000063_1', stillImageUrl: 'https://kamera.atlas.vegvesen.no/api/images/3000063_1', roadNumber: 'F614', orientationDescription: 'Svelgen', videoEncodingStandard: 'hls' } }] },
    })
    expect(cams.map(c => c.id)).toEqual(['bc:1081', 'yyc:loc86', 'nsw:abc', 'wa:1001', 'yyz:8001', 'de:KCAM001', 'no:3000063_1'])
    expect(cams.find(c => c.id === 'bc:1081')).toMatchObject({ image: 'https://www.drivebc.ca/images/1081.jpg', heading: 0 })
    expect(cams.find(c => c.id === 'yyc:loc86')?.image).toBe('https://trafficcam.calgary.ca/loc86.jpg')
    expect(cams.find(c => c.id === 'nsw:abc')?.heading).toBe(270)
    const wa = cams.find(c => c.id === 'wa:1001')!
    expect(wa.lat).toBeCloseTo(45.62, 1)
    expect(wa.lon).toBeCloseTo(-122.67, 1)
    expect(wa.heading).toBe(180)
    expect(cams.find(c => c.id === 'yyz:8001')?.image).toBe('https://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages/loc8001.jpg')
    expect(cams.find(c => c.id === 'de:KCAM001')).toMatchObject({ image: '', video: { url: 'https://video.deldot.gov:443/live/KCAM001.stream/playlist.m3u8', kind: 'hls' } })
    expect(cams.find(c => c.id === 'no:3000063_1')?.video?.url).toBe('https://kamera.vegvesen.no/public/3000063_1/manifest.m3u8')
  })

  it('reads compass words as degrees', () => {
    expect([compassDegrees('N'), compassDegrees('se'), compassDegrees('NB'), compassDegrees('Westbound'), compassDegrees('B'), compassDegrees('')]).toEqual([0, 135, 0, 270, undefined, undefined])
  })

  it('keeps live video links: Caltrans streams and TfL clips, https only', () => {
    const cams = parseCameraSources({
      tfl: [
        {
          id: 'JamCams_00002.00865',
          commonName: 'Westway',
          lat: 51.52,
          lon: -0.2,
          additionalProperties: [
            { key: 'imageUrl', value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.jpg' },
            { key: 'videoUrl', value: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.mp4' },
          ],
        },
      ],
      caltrans: [
        {
          data: [
            {
              cctv: {
                index: '1',
                inService: 'true',
                location: { district: '7', locationName: 'I-110 Avenue 26', latitude: '34.08', longitude: '-118.22' },
                imageData: { streamingVideoURL: 'https://wzmedia.dot.ca.gov/D7/CCTV-196.stream/playlist.m3u8', static: { currentImageURL: 'https://cwwp2.dot.ca.gov/x.jpg' } },
              },
            },
            {
              cctv: {
                index: '2',
                inService: 'true',
                location: { district: '7', locationName: 'No stream', latitude: '34.1', longitude: '-118.3' },
                imageData: { streamingVideoURL: 'http://insecure.example/x.m3u8', static: { currentImageURL: 'https://cwwp2.dot.ca.gov/y.jpg' } },
              },
            },
          ],
        },
      ],
    })
    expect(cams.find(c => c.name === 'Westway')?.video).toEqual({ url: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00002.00865.mp4', kind: 'clip' })
    expect(cams.find(c => c.name === 'I-110 Avenue 26')?.video).toEqual({ url: 'https://wzmedia.dot.ca.gov/D7/CCTV-196.stream/playlist.m3u8', kind: 'hls' })
    expect(cams.find(c => c.name === 'No stream')?.video).toBeUndefined()
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
