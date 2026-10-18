/**
 * The live world around the places the owner cares about: weather, air
 * quality, earthquakes, natural events (fires, storms, volcanoes, floods) and
 * news, from free open sources that need no key. Shared by the runtime (which
 * fetches and raises alerts), main and the World page.
 */

export interface Place {
  id: string
  name: string
  country: string | null
  lat: number
  lon: number
  timezone: string | null
}

export interface WeatherNow {
  temp: number
  feels: number
  humidity: number
  wind: number
  gusts: number
  code: number
  summary: string
  /** Today and tomorrow. */
  days: { date: string; max: number; min: number; rain: number; gusts: number; code: number; summary: string }[]
}

export interface AirNow {
  aqi: number
  pm25: number
  pm10: number
  level: string
}

export interface Quake {
  id: string
  mag: number
  place: string
  time: number
  lat: number
  lon: number
  depthKm: number
  url: string
  tsunami: boolean
}

export interface NaturalEvent {
  id: string
  title: string
  category: string
  time: number
  lat: number
  lon: number
  url: string
}

export interface NewsItem {
  title: string
  url: string
  domain: string
  time: number
  language: string
}

export interface PlaceStatus {
  place: Place
  weather: WeatherNow | null
  air: AirNow | null
  news: NewsItem[]
  /** Earthquakes and natural events near this place, nearest first. */
  nearby: { kind: 'quake' | 'event'; id: string; title: string; km: number; time: number }[]
}

/** A GDACS disaster alert (UN/EC Global Disaster Alert and Coordination System). */
export interface Disaster {
  id: string
  /** GDACS code: TC cyclone, FL flood, VO volcano, DR drought, WF wildfire, EQ earthquake. */
  type: string
  /** "Tropical cyclone", "Flood"… */
  kind: string
  name: string
  alert: 'Green' | 'Orange' | 'Red'
  country: string
  /** e.g. "maximum wind speed of 194 km/h". */
  severity: string
  from: number
  to: number
  lat: number
  lon: number
  url: string
}

export const DISASTER_KIND: Record<string, string> = { TC: 'Tropical cyclone', FL: 'Flood', VO: 'Volcano', DR: 'Drought', WF: 'Wildfire', EQ: 'Earthquake' }

export interface WorldSnapshot {
  places: PlaceStatus[]
  quakes: Quake[]
  events: NaturalEvent[]
  /** Current GDACS alerts, red first. */
  disasters: Disaster[]
  updatedAt: number | null
  /** Sources that failed on the last refresh, in plain words. */
  problems: string[]
}

/** An aircraft broadcasting its position (ADS-B), from adsb.lol. */
export interface Flight {
  hex: string
  callsign: string
  registration: string
  type: string
  lat: number
  lon: number
  /** Feet; null on the ground or unknown. */
  altitude: number | null
  /** Knots. */
  speed: number
  /** Degrees. */
  track: number
  military: boolean
  /** Transponder code; 7500 hijack, 7600 radio failure, 7700 emergency. */
  squawk: string
  /** Feet per minute, + climbing. */
  verticalRate: number | null
  /** "none" or the declared emergency. */
  emergency: string
  /** Seconds since the last position. */
  seen: number
}

/** Orbit elements of one satellite (CelesTrak OMM JSON), positions are computed on the page. */
export type SatelliteElements = Record<string, string | number>

/** Parses adsb.lol's v2 answer. */
export const parseFlights = (j: unknown): Flight[] => {
  const ac = (j as { ac?: Record<string, unknown>[] })?.ac ?? []
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return ac
    .filter(a => n(a.lat) !== null && n(a.lon) !== null)
    .map(a => ({
      hex: String(a.hex ?? ''),
      callsign: String(a.flight ?? '').trim(),
      registration: String(a.r ?? ''),
      type: String(a.t ?? ''),
      lat: n(a.lat)!,
      lon: n(a.lon)!,
      altitude: a.alt_baro === 'ground' ? null : n(a.alt_baro),
      speed: n(a.gs) ?? 0,
      track: n(a.track) ?? n(a.true_heading) ?? 0,
      // adsb.lol marks military aircraft with bit 1 of dbFlags.
      military: ((n(a.dbFlags) ?? 0) & 1) === 1,
      squawk: String(a.squawk ?? ''),
      verticalRate: n(a.baro_rate) ?? n(a.geom_rate),
      emergency: typeof a.emergency === 'string' ? a.emergency : 'none',
      seen: n(a.seen_pos) ?? n(a.seen) ?? 0,
    }))
}

/** A vessel broadcasting AIS, from AISStream. */
export interface Ship {
  mmsi: number
  name: string
  lat: number
  lon: number
  /** Knots. */
  speed: number
  /** Course over ground, degrees. */
  course: number
  heading: number | null
  /** AIS ship type code. */
  type: number | null
  category: string
  destination: string
  /** Metres. */
  length: number | null
  at: number
}

export interface ShipsResult {
  status: 'no-key' | 'off' | 'connecting' | 'live' | 'error'
  ships: Ship[]
  message: string | null
}

/** AIS ship type codes, grouped the way people talk about ships. */
export const shipCategory = (type: number | null): string => {
  if (type === null) return 'Other'
  if (type === 30) return 'Fishing'
  if (type === 31 || type === 32 || type === 52) return 'Tug'
  if (type === 35) return 'Military'
  if (type === 36 || type === 37) return 'Pleasure'
  if (type >= 40 && type <= 49) return 'High speed'
  if (type >= 60 && type <= 69) return 'Passenger'
  if (type >= 70 && type <= 79) return 'Cargo'
  if (type >= 80 && type <= 89) return 'Tanker'
  if (type >= 50 && type <= 59) return 'Service'
  return 'Other'
}

/** One AISStream message as a partial update to a ship, or null if it is not a ship message. */
export const parseAisMessage = (m: unknown): { mmsi: number; fields: Partial<Ship> & { at: number } } | null => {
  const o = m as { MessageType?: string; MetaData?: Record<string, unknown>; Message?: Record<string, Record<string, unknown>> }
  const meta = o?.MetaData
  const mmsi = typeof meta?.MMSI === 'number' ? meta.MMSI : null
  if (!meta || !mmsi || !o.MessageType || !o.Message) return null
  const body = o.Message[o.MessageType] ?? {}
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const at = Date.parse(String(meta.time_utc ?? '').replace(' +0000 UTC', 'Z').replace(/ (\d{2}:\d{2}:\d{2})\.\d+/, 'T$1')) || Date.now()
  const name = String(meta.ShipName ?? body.Name ?? '').trim()
  if (o.MessageType === 'ShipStaticData') {
    const dim = body.Dimension as Record<string, unknown> | undefined
    const length = dim ? (n(dim.A) ?? 0) + (n(dim.B) ?? 0) : null
    return { mmsi, fields: { name, type: n(body.Type), destination: String(body.Destination ?? '').trim(), length: length || null, at } }
  }
  const lat = n(meta.latitude) ?? n(body.Latitude)
  const lon = n(meta.longitude) ?? n(body.Longitude)
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  const heading = n(body.TrueHeading)
  return { mmsi, fields: { name: name || undefined, lat, lon, speed: n(body.Sog) ?? 0, course: n(body.Cog) ?? 0, heading: heading !== null && heading < 360 ? heading : null, at } as Partial<Ship> & { at: number } }
}

/** A public camera from an official open feed. */
export interface Camera {
  id: string
  name: string
  lat: number
  lon: number
  country: string
  /** Who runs it, credited on the card. */
  source: string
  image: string
  /** Live video: an HLS stream (Caltrans) or a short clip refreshed every few minutes (TfL). */
  video?: { url: string; kind: 'hls' | 'clip' } | undefined
}

/** Where official public cameras are available without a key. */
export const CAMERA_COVERAGE = 'London (TfL), California (Caltrans), Finland (Fintraffic), Hong Kong (Transport Department), Singapore (LTA)'

/** Each agency's own format into one list. Unknown or broken entries are skipped. */
const httpsVideo = (v: unknown, kind: 'hls' | 'clip') => (typeof v === 'string' && /^https:\/\/[^\s]+\.(m3u8|mp4)$/.test(v) ? { url: v, kind } : undefined)

export const parseCameraSources = (raw: { tfl?: unknown; caltrans?: unknown[]; finland?: unknown; hongKong?: string; singapore?: unknown }): Camera[] => {
  const out: Camera[] = []
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN)
  const push = (c: Camera) => {
    if (Number.isFinite(c.lat) && Number.isFinite(c.lon) && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180 && c.image.startsWith('https://')) out.push(c)
  }
  for (const p of Array.isArray(raw.tfl) ? (raw.tfl as Record<string, unknown>[]) : []) {
    const props = (p.additionalProperties as { key: string; value: string }[] | undefined) ?? []
    const prop = (k: string) => props.find(x => x.key === k)?.value
    if (prop('available') === 'false') continue
    push({ id: `tfl:${String(p.id)}`, name: String(p.commonName ?? 'London camera'), lat: num(p.lat), lon: num(p.lon), country: 'United Kingdom', source: 'Transport for London (TfL Open Data)', image: prop('imageUrl') ?? '', video: httpsVideo(prop('videoUrl'), 'clip') })
  }
  for (const d of raw.caltrans ?? []) {
    for (const item of ((d as { data?: { cctv?: Record<string, unknown> }[] })?.data ?? [])) {
      const c = item.cctv
      if (!c || c.inService === 'false') continue
      const loc = (c.location as Record<string, unknown> | undefined) ?? {}
      const data = (c.imageData as Record<string, unknown> | undefined) ?? {}
      const img = (data.static as Record<string, unknown> | undefined)?.currentImageURL
      push({ id: `ct:${String(loc.district)}-${String(c.index)}`, name: String(loc.locationName ?? 'California camera'), lat: num(loc.latitude), lon: num(loc.longitude), country: 'United States', source: 'Caltrans', image: typeof img === 'string' ? img : '', video: httpsVideo(data.streamingVideoURL, 'hls') })
    }
  }
  for (const f of ((raw.finland as { features?: Record<string, unknown>[] })?.features ?? [])) {
    const props = (f.properties as { name?: string; presets?: { id: string; inCollection?: boolean }[] } | undefined) ?? {}
    const preset = props.presets?.find(x => x.inCollection !== false)
    const coords = (f.geometry as { coordinates?: number[] } | undefined)?.coordinates ?? []
    if (!preset) continue
    push({ id: `fi:${preset.id}`, name: String(props.name ?? 'Road weather camera').replace(/_/g, ' '), lat: num(coords[1]), lon: num(coords[0]), country: 'Finland', source: 'Fintraffic Digitraffic (CC BY 4.0)', image: `https://weathercam.digitraffic.fi/${preset.id}.jpg` })
  }
  const xml = raw.hongKong ?? ''
  const tag = (block: string, t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(block)?.[1]?.trim() ?? ''
  for (const block of xml.split('<image>').slice(1)) {
    push({ id: `hk:${tag(block, 'key')}`, name: tag(block, 'description').replace(/&amp;/g, '&'), lat: num(tag(block, 'latitude')), lon: num(tag(block, 'longitude')), country: 'Hong Kong', source: 'Hong Kong Transport Department', image: tag(block, 'url') })
  }
  for (const c of ((raw.singapore as { items?: { cameras?: Record<string, unknown>[] }[] })?.items?.[0]?.cameras ?? [])) {
    const loc = (c.location as { latitude?: number; longitude?: number } | undefined) ?? {}
    push({ id: `sg:${String(c.camera_id)}`, name: `Singapore traffic camera ${String(c.camera_id)}`, lat: num(loc.latitude), lon: num(loc.longitude), country: 'Singapore', source: 'Land Transport Authority (data.gov.sg)', image: String(c.image ?? '') })
  }
  return out
}

export type WorldOp = { kind: 'add'; name: string } | { kind: 'remove'; id: string } | { kind: 'refresh' }

export const WLD = {
  state: 'world:state',
  add: 'world:add',
  remove: 'world:remove',
  refresh: 'world:refresh',
  flights: 'world:flights',
  satellites: 'world:satellites',
  ships: 'world:ships',
  shipsKey: 'world:ships-key',
  cameras: 'world:cameras',
  cameraImage: 'world:camera-image',
  changed: 'world:changed',
} as const

export interface WorldBridge {
  state(): Promise<WorldSnapshot>
  add(name: string): Promise<WorldSnapshot>
  remove(id: string): Promise<WorldSnapshot>
  refresh(): Promise<WorldSnapshot>
  /** Aircraft within dist nautical miles (up to 250) of a point. */
  flights(lat: number, lon: number, dist: number): Promise<Flight[]>
  /** The ISS, stations and the brightest satellites. */
  satellites(): Promise<SatelliteElements[]>
  /** Ships in the area on screen (needs the owner's free AISStream key). */
  ships(box: { south: number; west: number; north: number; east: number }): Promise<ShipsResult>
  /** Saves the AISStream key in the Windows credential store (null removes it). */
  setShipsKey(key: string | null): Promise<{ hasKey: boolean }>
  /** Public cameras from official open feeds (only where such feeds exist). */
  cameras(): Promise<Camera[]>
  /** A camera's latest frame, fetched by Atlas, as a data URL. */
  cameraImage(id: string): Promise<{ dataUrl: string; at: number }>
  onChanged(cb: (s: WorldSnapshot) => void): () => void
}

export const EMPTY_WORLD: WorldSnapshot = { places: [], quakes: [], events: [], disasters: [], updatedAt: null, problems: [] }

export const ATTRIBUTION =
  'Weather and air quality: Open-Meteo.com (CC BY 4.0) · Earthquakes: USGS · Natural events: NASA EONET · Disasters: GDACS (EC/UN) · News: GDELT Project · Flights: adsb.lol (ODbL) · Ships: AISStream · Cameras: TfL, Caltrans, Fintraffic, HK Transport Department, LTA Singapore · Satellites: CelesTrak · Map: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors'

/** Great-circle distance in km. */
export const kmBetween = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** US AQI band in plain words. */
export const aqiLevel = (aqi: number): string =>
  aqi <= 50 ? 'Good' : aqi <= 100 ? 'Moderate' : aqi <= 150 ? 'Unhealthy for sensitive groups' : aqi <= 200 ? 'Unhealthy' : aqi <= 300 ? 'Very unhealthy' : 'Hazardous'

/** WMO weather codes, shortly. */
export const weatherSummary = (code: number): string => {
  if (code === 0) return 'Clear'
  if (code <= 2) return 'Partly cloudy'
  if (code === 3) return 'Overcast'
  if (code === 45 || code === 48) return 'Fog'
  if (code >= 51 && code <= 57) return 'Drizzle'
  if (code >= 61 && code <= 67) return 'Rain'
  if (code >= 71 && code <= 77) return 'Snow'
  if (code >= 80 && code <= 82) return 'Rain showers'
  if (code === 85 || code === 86) return 'Snow showers'
  if (code >= 95) return 'Thunderstorm'
  return 'Mixed'
}
