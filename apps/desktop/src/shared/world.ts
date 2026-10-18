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

export interface WorldSnapshot {
  places: PlaceStatus[]
  quakes: Quake[]
  events: NaturalEvent[]
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
  onChanged(cb: (s: WorldSnapshot) => void): () => void
}

export const EMPTY_WORLD: WorldSnapshot = { places: [], quakes: [], events: [], updatedAt: null, problems: [] }

export const ATTRIBUTION =
  'Weather and air quality: Open-Meteo.com (CC BY 4.0) · Earthquakes: USGS · Natural events: NASA EONET · News: GDELT Project · Flights: adsb.lol (ODbL) · Ships: AISStream · Satellites: CelesTrak · Map: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors'

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
