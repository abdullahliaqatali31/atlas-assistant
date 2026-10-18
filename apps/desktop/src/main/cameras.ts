/**
 * Public traffic and road-weather cameras for the World map, only from
 * official open feeds that need no key: London (TfL JamCams), California
 * (Caltrans), Finland (Fintraffic Digitraffic), Hong Kong (Transport
 * Department), New Zealand (NZTA) and Singapore (LTA via data.gov.sg). Places without such a feed
 * (Pakistan among them) simply have none. Like the agencies' own sites, only
 * the latest still frame is shown; nothing is recorded or analysed.
 */
import { parseCameraSources, type Camera } from '../shared/world.ts'

const LIST_TTL = 12 * 3_600_000
const IMAGE_TTL = 30_000
const MAX_IMAGE = 3 * 1024 * 1024
const UA = { 'user-agent': 'Atlas personal assistant (open source)', 'Digitraffic-User': 'Atlas personal assistant (open source)' }

const get = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000), headers: UA })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res
}

/** Fetches one camera image and returns it as a data URL; refuses anything that is not a JPEG or PNG. */
export const imageDataUrl = async (url: string): Promise<{ dataUrl: string; at: number }> => {
  const res = await get(url)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_IMAGE) throw new Error('The image is too large.')
  // Some feeds label JPEGs as generic data: trust the image's own first bytes.
  const sniffed = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 ? 'image/png' : null
  const header = res.headers.get('content-type') ?? ''
  const type = sniffed ?? (header.startsWith('image/') ? header : null)
  if (!type) throw new Error('The camera did not send an image.')
  return { dataUrl: `data:${type.split(';')[0]};base64,${buf.toString('base64')}`, at: Date.now() }
}

export class CameraDirectory {
  private list: { at: number; cameras: Camera[] } | null = null
  private loading: Promise<Camera[]> | null = null
  private images = new Map<string, { at: number; dataUrl: string }>()
  /** Singapore's image links change with every snapshot: the latest list, briefly cached. */
  private singapore: { at: number; urls: Map<string, string> } | null = null

  constructor(private readonly log: (level: 'info' | 'warn', message: string) => void = () => {}) {}

  async cameras(): Promise<Camera[]> {
    if (this.list && Date.now() - this.list.at < LIST_TTL) return this.list.cameras
    this.loading ??= this.load().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  private async load(): Promise<Camera[]> {
    const text = async (url: string) => (await get(url)).text()
    const json = async (url: string) => (await get(url)).json() as Promise<unknown>
    const tries = await Promise.allSettled([
      json('https://api.tfl.gov.uk/Place/Type/JamCam').then(j => ({ tfl: j })),
      Promise.allSettled(Array.from({ length: 12 }, (_, i) => json(`https://cwwp2.dot.ca.gov/data/d${i + 1}/cctv/cctvStatusD${String(i + 1).padStart(2, '0')}.json`))).then(r => ({
        caltrans: r.flatMap(x => (x.status === 'fulfilled' ? [x.value] : [])),
      })),
      json('https://tie.digitraffic.fi/api/weathercam/v1/stations').then(j => ({ finland: j })),
      json('https://www.journeys.nzta.govt.nz/assets/map-data-cache/cameras.json').then(j => ({ nz: j })),
      text('https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml').then(x => ({ hongKong: x })),
      json('https://api.data.gov.sg/v1/transport/traffic-images').then(j => ({ singapore: j })),
    ])
    const raw = Object.assign({}, ...tries.flatMap(t => (t.status === 'fulfilled' ? [t.value] : [])))
    for (const t of tries) if (t.status === 'rejected') this.log('warn', `Cameras: a source failed (${t.reason instanceof Error ? t.reason.message : String(t.reason)}).`)
    const cameras = parseCameraSources(raw)
    if (cameras.length) this.list = { at: Date.now(), cameras }
    return cameras
  }

  private async singaporeUrl(id: string): Promise<string | undefined> {
    if (!this.singapore || Date.now() - this.singapore.at > 60_000) {
      const j = (await (await get('https://api.data.gov.sg/v1/transport/traffic-images')).json()) as { items?: { cameras?: { camera_id: string; image: string }[] }[] }
      this.singapore = { at: Date.now(), urls: new Map((j.items?.[0]?.cameras ?? []).map(c => [`sg:${c.camera_id}`, c.image])) }
    }
    return this.singapore.urls.get(id)
  }

  /** The camera's latest frame as a data URL; only for cameras on the list, only images. */
  async image(id: string): Promise<{ dataUrl: string; at: number }> {
    const cam = (await this.cameras()).find(c => c.id === id)
    if (!cam) throw new Error('Unknown camera.')
    const hit = this.images.get(id)
    if (hit && Date.now() - hit.at < IMAGE_TTL) return hit
    const url = cam.id.startsWith('sg:') ? ((await this.singaporeUrl(cam.id)) ?? cam.image) : cam.image
    if (!url.startsWith('https://')) throw new Error('No image for this camera.')
    const out = await imageDataUrl(`${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / IMAGE_TTL)}`)
    this.images.set(id, out)
    if (this.images.size > 40) this.images.delete(this.images.keys().next().value!)
    return out
  }
}
