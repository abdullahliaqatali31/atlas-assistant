/**
 * The live world around the places the owner cares about: weather, air
 * quality, earthquakes, natural events (fires, storms, volcanoes, floods) and
 * news, from free open sources that need no key. Shared by the runtime (which
 * fetches and raises alerts), main and the World page.
 */

import type { CableDetail, CablesResult } from './space.ts'
import type { AlertRegion, countryStats, IntelEvent } from './intel.ts'
import type { Quote } from './markets.ts'
import type { RichPerson, VipCategory, VipFlying } from './vip.ts'

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

/** A map area, in degrees. */
export interface GeoBox {
  south: number
  west: number
  north: number
  east: number
}

/** adsb.lol answers up to this far around a point; the sweep covers a wide view with circles this size. */
export const SWEEP_RADIUS_NM = 1000
/** Degrees of latitude between sweep rows: a 22° square fits inside a 1000 nm circle. */
const SWEEP_STEP = 22

/**
 * The 1000 nm areas that cover a map view, on a fixed world grid (so a pan
 * reuses what was already fetched). Rows run from 55° S to 77° N, where the
 * aircraft are; each row's longitude step is set at its equator-side edge,
 * where a degree of longitude is widest, so the circles always overlap.
 */
export const sweepCells = (box: GeoBox): { id: string; lat: number; lon: number }[] => {
  const cells: { id: string; lat: number; lon: number }[] = []
  for (let i = 0; i < 7; i++) {
    const lat = -55 + SWEEP_STEP * i
    if (lat - SWEEP_STEP / 2 > box.north || lat + SWEEP_STEP / 2 < box.south) continue
    const edge = Math.max(0, Math.abs(lat) - SWEEP_STEP / 2)
    const count = Math.ceil(360 / (SWEEP_STEP / Math.cos((edge * Math.PI) / 180)))
    const step = 360 / count
    for (let j = 0; j < count; j++) {
      const lon = -180 + step * (j + 0.5)
      if (lon + step / 2 < box.west || lon - step / 2 > box.east) continue
      cells.push({ id: `${i}:${j}`, lat, lon: Math.round(lon * 1000) / 1000 })
    }
  }
  return cells
}

/** Aircraft over a wide view, filled in area by area. */
export interface FlightsArea {
  flights: Flight[]
  /** Areas that cover the view, and how many have been fetched so far. */
  cells: number
  loaded: number
}

export interface Airport {
  iata: string
  icao: string
  name: string
  city: string
  country: string
  lat: number
  lon: number
}

/** Where a flight is going, by its callsign (adsbdb.com). */
export interface FlightRoute {
  callsign: string
  airline: string
  origin: Airport
  destination: Airport
}

/** The aircraft itself (adsbdb by ICAO hex): what it is, who flies it, and a photo of this very airframe. */
export interface AircraftInfo {
  type: string
  icaoType: string
  manufacturer: string
  registration: string
  owner: string
  country: string
  /** https only (airport-data.com, via adsbdb); null when there is none. */
  photo: string | null
  photoThumb: string | null
}

export const isHex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{6}$/i.test(v)

export const parseAdsbdbAircraft = (j: unknown): AircraftInfo | null => {
  const a = (j as { response?: { aircraft?: Record<string, unknown> } })?.response?.aircraft
  if (!a || typeof a !== 'object') return null
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const https = (v: unknown) => (typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v) ? v : null)
  return { type: s(a.type), icaoType: s(a.icao_type), manufacturer: s(a.manufacturer), registration: s(a.registration), owner: s(a.registered_owner), country: s(a.registered_owner_country_name), photo: https(a.url_photo), photoThumb: https(a.url_photo_thumbnail) }
}

/** What Wikidata knows about a ship (by MMSI) or a satellite (by NORAD number): only notable ones are there. */
export interface WikiThing {
  label: string
  description: string
  /** A Commons thumbnail (https) and its file page, for the credit. */
  image: string | null
  imagePage: string | null
  operator: string
  country: string
  /** Launch or commissioning date, ISO day. */
  since: string
  wikidata: string
}

export const wikiQuery = (kind: 'ship' | 'satellite', id: string) => `SELECT ?item ?itemLabel ?itemDescription ?image ?operatorLabel ?countryLabel ?flagLabel ?launch WHERE { ?item wdt:${kind === 'ship' ? 'P587' : 'P377'} "${id}" . OPTIONAL { ?item wdt:P18 ?image } OPTIONAL { ?item wdt:P137 ?operator } OPTIONAL { ?item wdt:P17 ?country } OPTIONAL { ?item wdt:P8047 ?flag } OPTIONAL { ?item wdt:P619 ?launch } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 8`

/** Only ids that are what they claim: MMSI nine digits, NORAD up to nine. */
export const isWikiId = (kind: unknown, id: unknown): id is string => typeof id === 'string' && (kind === 'ship' ? /^\d{9}$/.test(id) : kind === 'satellite' ? /^\d{1,9}$/.test(id) : false)

export const parseWikiThing = (j: unknown): WikiThing | null => {
  const rows = (j as { results?: { bindings?: Record<string, { value?: string }>[] } })?.results?.bindings
  if (!Array.isArray(rows) || !rows.length) return null
  const v = (r: Record<string, { value?: string }>, k: string) => (typeof r[k]?.value === 'string' ? r[k]!.value! : '')
  const first = rows[0]!
  const uniq = (k: string) => [...new Set(rows.map(r => v(r, k)).filter(Boolean))].join(', ')
  const file = v(first, 'image').replace(/^https?:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//, '')
  const item = v(first, 'item')
  return {
    label: v(first, 'itemLabel'),
    description: v(first, 'itemDescription'),
    image: file ? `https://commons.wikimedia.org/wiki/Special:FilePath/${file}?width=480` : null,
    imagePage: file ? `https://commons.wikimedia.org/wiki/File:${file}` : null,
    operator: uniq('operatorLabel'),
    // Ships carry their flag as country of registry (P8047); satellites a country (P17).
    country: uniq('flagLabel') || uniq('countryLabel'),
    since: v(first, 'launch').slice(0, 10),
    wikidata: /^http:\/\/www\.wikidata\.org\/entity\/Q\d+$/.test(item) ? item.replace('http://', 'https://') : '',
  }
}

/** A country's card (Wikidata, by ISO code): capital, people, size, money, languages and who leads it. */
export interface CountryCard {
  iso: string
  name: string
  description: string
  capital: string
  population: number | null
  areaKm2: number | null
  currency: string
  languages: string
  headOfState: string
  headOfGovernment: string
}

export const countryQuery = (iso: string) => `SELECT ?countryLabel ?countryDescription ?capitalLabel ?population ?area ?currencyLabel ?langLabel ?hosLabel ?hogLabel WHERE { ?country wdt:P297 "${iso}" . OPTIONAL { ?country wdt:P36 ?capital } OPTIONAL { ?country wdt:P1082 ?population } OPTIONAL { ?country wdt:P2046 ?area } OPTIONAL { ?country wdt:P38 ?currency } OPTIONAL { ?country wdt:P37 ?lang } OPTIONAL { ?country p:P35 ?s1 . ?s1 ps:P35 ?hos . FILTER NOT EXISTS { ?s1 pq:P582 ?e1 } } OPTIONAL { ?country p:P6 ?s2 . ?s2 ps:P6 ?hog . FILTER NOT EXISTS { ?s2 pq:P582 ?e2 } } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 60`

export const parseCountryCard = (iso: string, j: unknown): CountryCard | null => {
  const rows = (j as { results?: { bindings?: Record<string, { value?: string }>[] } })?.results?.bindings
  if (!Array.isArray(rows) || !rows.length) return null
  const v = (r: Record<string, { value?: string }>, k: string) => (typeof r[k]?.value === 'string' ? r[k]!.value! : '')
  const uniq = (k: string, max = 4) => [...new Set(rows.map(r => v(r, k)).filter(x => x && !/^Q\d+$/.test(x)))].slice(0, max).join(', ')
  const most = (k: string) => {
    const nums = rows.map(r => Number(v(r, k))).filter(n => Number.isFinite(n) && n > 0)
    return nums.length ? Math.max(...nums) : null
  }
  return { iso, name: v(rows[0]!, 'countryLabel'), description: v(rows[0]!, 'countryDescription'), capital: uniq('capitalLabel', 2), population: most('population'), areaKm2: most('area'), currency: uniq('currencyLabel', 2), languages: uniq('langLabel', 4), headOfState: uniq('hosLabel', 2), headOfGovernment: uniq('hogLabel', 2) }
}

/** This flight's path so far (OpenSky): altitude over time, for the card's profile. */
export interface FlightTrack {
  callsign: string
  start: number
  points: { t: number; altM: number | null; ground: boolean }[]
}

/** OpenSky /tracks/all: { startTime, callsign, path: [[time, lat, lon, baroAltM, track, onGround]] }. */
export const parseOpenSkyTrack = (j: unknown): FlightTrack | null => {
  const r = j as { startTime?: unknown; callsign?: unknown; path?: unknown }
  if (!r || !Array.isArray(r.path)) return null
  const points = r.path
    .filter((p): p is unknown[] => Array.isArray(p) && typeof p[0] === 'number')
    .map(p => ({ t: (p[0] as number) * 1000, altM: typeof p[3] === 'number' ? p[3] : null, ground: p[5] === true }))
  if (points.length < 2) return null
  return { callsign: typeof r.callsign === 'string' ? r.callsign.trim() : '', start: typeof r.startTime === 'number' ? r.startTime * 1000 : points[0]!.t, points }
}

/** adsbdb's { response: { flightroute: { origin, destination, airline } } }; null when it has no route. */
export const parseAdsbdbRoute = (j: unknown): FlightRoute | null => {
  const r = (j as { response?: { flightroute?: Record<string, unknown> } })?.response?.flightroute
  if (!r || typeof r !== 'object') return null
  const airport = (a: unknown): Airport | null => {
    const o = a as Record<string, unknown> | null
    if (!o || typeof o.latitude !== 'number' || typeof o.longitude !== 'number' || Math.abs(o.latitude) > 90 || Math.abs(o.longitude) > 180) return null
    const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : '')
    return { iata: str(o.iata_code), icao: str(o.icao_code), name: str(o.name), city: str(o.municipality), country: str(o.country_name), lat: o.latitude, lon: o.longitude }
  }
  const origin = airport(r.origin)
  const destination = airport(r.destination)
  if (!origin || !destination) return null
  const airline = (r.airline as { name?: unknown } | null)?.name
  return { callsign: typeof r.callsign === 'string' ? r.callsign : '', airline: typeof airline === 'string' ? airline.slice(0, 80) : '', origin, destination }
}

/**
 * OpenSky Network state vectors ({ time, states: [[icao24, callsign, country,
 * timePosition, lastContact, lon, lat, baroAltitudeM, onGround, velocityMs,
 * track, verticalRateMs, sensors, geoAltitudeM, squawk, spi, source], ...] })
 * into the same shape as adsb.lol's aircraft.
 */
export const parseOpenSky = (j: unknown): Flight[] => {
  const o = j as { time?: unknown; states?: unknown[][] | null }
  const now = typeof o?.time === 'number' ? o.time : 0
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const out: Flight[] = []
  for (const s of o?.states ?? []) {
    if (!Array.isArray(s)) continue
    const lon = n(s[5])
    const lat = n(s[6])
    if (lat === null || lon === null) continue
    const altM = n(s[7]) ?? n(s[13])
    const vr = n(s[11])
    out.push({
      hex: String(s[0] ?? ''),
      callsign: String(s[1] ?? '').trim(),
      registration: '',
      type: '',
      lat,
      lon,
      altitude: s[8] === true || altM === null ? null : Math.round(altM * 3.28084),
      speed: Math.round((n(s[9]) ?? 0) * 1.943844),
      track: n(s[10]) ?? 0,
      military: false,
      squawk: typeof s[14] === 'string' ? s[14] : '',
      verticalRate: vr === null ? null : Math.round(vr * 196.85),
      emergency: 'none',
      seen: now && n(s[4]) !== null ? Math.max(0, now - n(s[4])!) : 0,
    })
  }
  return out
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
  status: 'no-key' | 'off' | 'connecting' | 'reconnecting' | 'live' | 'error'
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
  /** An embeddable player page (Windy webcams: live stream or today's timelapse). */
  player?: { url: string; kind: 'live' | 'timelapse' } | undefined
  /** The camera's own page. */
  link?: string | undefined
  /** Which way it looks, degrees from north, where the agency says (for its view cone in 3D). */
  heading?: number | undefined
}

/** Where official public cameras are available without a key. */
/** The IBI "511" networks (one platform, one parser): host and who runs it. */
export const IBI_HOSTS: Record<string, string> = {
  '511ga.org': 'Georgia DOT (511GA)',
  'fl511.com': 'Florida DOT (FL511)',
  'www.511pa.com': 'PennDOT (511PA)',
  '511on.ca': 'Ontario MTO (511ON)',
  'www.nvroads.com': 'Nevada DOT',
  'az511.com': 'Arizona DOT (AZ511)',
  '511.idaho.gov': 'Idaho Transportation Department',
  '511.alberta.ca': 'Alberta 511',
  '511la.org': 'Louisiana DOTD',
  '511.alaska.gov': 'Alaska DOT&PF',
}

/** The CARS networks (Castle Rock): state code and who runs it. */
export const CARS_STATES: Record<string, string> = { mn: 'Minnesota DOT', co: 'Colorado DOT (COtrip)', ia: 'Iowa DOT', in: 'Indiana DOT', ks: 'Kansas DOT', ne: 'Nebraska DOT', ma: 'MassDOT', sd: 'South Dakota DOT' }

export const CAMERA_COVERAGE = 'London (TfL), California (Caltrans), Georgia, Florida, Pennsylvania, Nevada, Arizona, Idaho, Louisiana, Alaska, Minnesota, Colorado, Iowa, Indiana, Kansas, Nebraska, Massachusetts, South Dakota, Oregon, Washington State (WSDOT), Delaware (DelDOT, live video), Ontario, Alberta, British Columbia (DriveBC), Calgary, Toronto, Spain (DGT), Finland (Fintraffic), Norway (Statens vegvesen), New South Wales, Queensland, New Zealand (NZTA), Hong Kong (Transport Department), Singapore (LTA)'

/** A compass word from a camera feed ("N", "SW", "NB", "Northbound") as degrees; undefined when it is not one. */
export const compassDegrees = (v: unknown): number | undefined => {
  if (typeof v !== 'string') return undefined
  const w = v.trim().toUpperCase().replace(/BOUND$|B$/, '')
  const map: Record<string, number> = { N: 0, NORTH: 0, NE: 45, NORTHEAST: 45, E: 90, EAST: 90, SE: 135, SOUTHEAST: 135, S: 180, SOUTH: 180, SW: 225, SOUTHWEST: 225, W: 270, WEST: 270, NW: 315, NORTHWEST: 315 }
  return map[w]
}

/** Web Mercator metres (EPSG:3857) to degrees. */
const fromMercator = (x: number, y: number) => ({ lon: (x / 6378137) * (180 / Math.PI), lat: (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * (180 / Math.PI) })

/** Each agency's own format into one list. Unknown or broken entries are skipped. */
const httpsVideo = (v: unknown, kind: 'hls' | 'clip') => (typeof v === 'string' && /^https:\/\/[^\s]+\.(m3u8|mp4)$/.test(v) ? { url: v, kind } : undefined)

export const parseCameraSources = (raw: { tfl?: unknown; caltrans?: unknown[]; finland?: unknown; nz?: unknown; hongKong?: string; singapore?: unknown; driveBc?: unknown; calgary?: unknown; nsw?: unknown; wsdot?: unknown; toronto?: string; deldot?: unknown; norway?: unknown; ibi?: { host: string; data: unknown[] }[]; cars?: { state: string; list: unknown }[]; dgt?: string; oregon?: unknown; qld?: unknown }): Camera[] => {
  const out: Camera[] = []
  const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN)
  const push = (c: Camera) => {
    // A still frame, or (DelDOT) live video alone.
    if (Number.isFinite(c.lat) && Number.isFinite(c.lon) && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180 && (c.image.startsWith('https://') || (c.image === '' && c.video))) out.push(c)
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
  for (const f of ((raw.nz as { features?: { properties?: Record<string, unknown> }[] })?.features ?? [])) {
    const p = f.properties ?? {}
    if (p.Offline === 1 || p.UnderMaintenance === 1) continue
    push({ id: `nz:${String(p.id ?? p.ExternalId)}`, name: [p.Name, p.Direction].filter(Boolean).join(' · ') || 'New Zealand camera', lat: num(p.Latitude), lon: num(p.Longitude), country: 'New Zealand', source: 'NZ Transport Agency Waka Kotahi', image: String(p.ImageUrl ?? '') })
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
  // British Columbia: frames are built from the numeric id on DriveBC's own host.
  for (const c of Array.isArray(raw.driveBc) ? (raw.driveBc as Record<string, unknown>[]) : []) {
    const id = c.id
    const coords = (c.location as { coordinates?: number[] } | undefined)?.coordinates ?? []
    if (typeof id !== 'number' || c.marked_stale === true || c.is_on === false) continue
    push({ id: `bc:${id}`, name: [c.name, c.caption].filter(x => typeof x === 'string' && x).join(' · ') || 'British Columbia camera', lat: num(coords[1]), lon: num(coords[0]), country: 'Canada', source: 'DriveBC (Government of British Columbia)', image: `https://www.drivebc.ca/images/${id}.jpg`, heading: compassDegrees(c.orientation) })
  }
  // Calgary: listed as http://, served (and pinned) on https://trafficcam.calgary.ca.
  for (const c of Array.isArray(raw.calgary) ? (raw.calgary as Record<string, unknown>[]) : []) {
    const url = String((c.camera_url as { url?: string } | undefined)?.url ?? '').replace(/^http:\/\//, 'https://')
    const coords = (c.point as { coordinates?: number[] } | undefined)?.coordinates ?? []
    if (!url.startsWith('https://trafficcam.calgary.ca/')) continue
    push({ id: `yyc:${url.replace(/^.*\//, '').replace(/\.jpg$/, '')}`, name: String(c.camera_location ?? 'Calgary camera'), lat: num(coords[1]), lon: num(coords[0]), country: 'Canada', source: 'City of Calgary (Open Calgary)', image: url })
  }
  // New South Wales (Live Traffic NSW).
  for (const f of ((raw.nsw as { features?: Record<string, unknown>[] })?.features ?? [])) {
    const p = (f.properties as Record<string, unknown> | undefined) ?? {}
    const coords = (f.geometry as { coordinates?: number[] } | undefined)?.coordinates ?? []
    push({ id: `nsw:${String(f.id)}`, name: String(p.title ?? 'NSW camera'), lat: num(coords[1]), lon: num(coords[0]), country: 'Australia', source: 'Transport for NSW (Live Traffic)', image: String(p.href ?? ''), heading: compassDegrees(p.direction) })
  }
  // Washington State: an ArcGIS layer in Web Mercator.
  for (const f of ((raw.wsdot as { features?: { attributes?: Record<string, unknown>; geometry?: { x?: number; y?: number } }[] })?.features ?? [])) {
    const a = f.attributes ?? {}
    const g = f.geometry ?? {}
    if (typeof g.x !== 'number' || typeof g.y !== 'number') continue
    const at = fromMercator(g.x, g.y)
    push({ id: `wa:${String(a.CameraID)}`, name: String(a.CameraTitle ?? 'Washington camera'), lat: at.lat, lon: at.lon, country: 'United States', source: 'Washington State DOT', image: String(a.ImageURL ?? ''), heading: compassDegrees(a.CompassDirection) })
  }
  // Toronto: a JSONP list; frames are built from the digits-only camera number.
  const toronto = /\(([\s\S]*)\)\s*;?\s*$/.exec(raw.toronto ?? '')?.[1]
  if (toronto)
    try {
      for (const c of ((JSON.parse(toronto) as { Data?: Record<string, unknown>[] }).Data ?? [])) {
        const n = String(c.Number ?? '')
        if (!/^\d{1,6}$/.test(n)) continue
        push({ id: `yyz:${n}`, name: String(c.Name ?? 'Toronto camera'), lat: num(c.Latitude), lon: num(c.Longitude), country: 'Canada', source: 'City of Toronto (Open Data)', image: `https://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages/loc${n}.jpg` })
      }
    } catch {
      // A broken list: no Toronto cameras this time.
    }
  // Delaware: live HLS video only, from DelDOT's own video host.
  for (const c of ((raw.deldot as { videoCameras?: Record<string, unknown>[] })?.videoCameras ?? [])) {
    const hls = String((c.urls as Record<string, unknown> | undefined)?.m3u8s ?? '')
    if (c.enabled === false || !hls.startsWith('https://video.deldot.gov')) continue
    push({ id: `de:${String(c.id)}`, name: String(c.title ?? 'Delaware camera'), lat: num(c.lat), lon: num(c.lon), country: 'United States', source: 'Delaware DOT', image: '', video: httpsVideo(hls, 'hls') })
  }
  // The IBI 511 networks: one record per camera site, a still per site (their streams need a login).
  for (const { host, data } of raw.ibi ?? []) {
    if (!IBI_HOSTS[host]) continue
    for (const r of data as Record<string, unknown>[]) {
      const wkt = String((r.latLng as { geography?: { wellKnownText?: string } } | undefined)?.geography?.wellKnownText ?? '')
      const m = /POINT \(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(wkt)
      const img = (r.images as { imageUrl?: string; disabled?: boolean; blocked?: boolean }[] | undefined)?.find(i => !i.disabled && !i.blocked && typeof i.imageUrl === 'string' && /^\/map\/Cctv\/\d+$/.test(i.imageUrl))
      if (!m || !img || r.visible === false) continue
      push({ id: `ibi:${host}:${String(r.id)}`, name: String(r.location ?? r.roadway ?? 'Road camera'), lat: Number(m[2]), lon: Number(m[1]), country: String(r.country ?? (host.endsWith('.ca') ? 'Canada' : 'United States')), source: IBI_HOSTS[host]!, image: `https://${host}${img.imageUrl}`, heading: compassDegrees(r.direction) })
    }
  }
  // The CARS networks: a preview still on public.carsprogram.org.
  for (const { state, list } of raw.cars ?? []) {
    if (!CARS_STATES[state]) continue
    for (const c of Array.isArray(list) ? (list as Record<string, unknown>[]) : []) {
      const loc = (c.location as { latitude?: number; longitude?: number } | undefined) ?? {}
      const view = (c.views as { videoPreviewUrl?: string }[] | undefined)?.find(v => typeof v.videoPreviewUrl === 'string' && v.videoPreviewUrl.startsWith('https://public.carsprogram.org/'))
      if (!view || c.public === false) continue
      push({ id: `cars:${state}:${String(c.id)}`, name: String(c.name ?? 'Road camera'), lat: num(loc.latitude), lon: num(loc.longitude), country: 'United States', source: CARS_STATES[state]!, image: view.videoPreviewUrl! })
    }
  }
  // Spain (DGT, DATEX II): every camera device with its still.
  for (const block of (raw.dgt ?? '').split('<ns2:device ').slice(1)) {
    if (!/<ns2:typeOfDevice>camera<\/ns2:typeOfDevice>/.test(block)) continue
    const lat = num(/<loc:latitude>([^<]+)<\/loc:latitude>/.exec(block)?.[1])
    const lon = num(/<loc:longitude>([^<]+)<\/loc:longitude>/.exec(block)?.[1])
    const url = /<fse:deviceUrl>(https:\/\/etraffic\.dgt\.es\/[^<]+\.jpg)<\/fse:deviceUrl>/.exec(block)?.[1]
    const id = /^[^>]*\bid="(\d+)"/.exec(block)?.[1]
    const road = /<loc:roadName>([^<]*)<\/loc:roadName>/.exec(block)?.[1] ?? ''
    const towards = /<loc:roadDestination>([^<]*)<\/loc:roadDestination>/.exec(block)?.[1] ?? ''
    if (!url || !id) continue
    push({ id: `es:${id}`, name: [road, towards ? `towards ${towards}` : ''].filter(Boolean).join(' · ') || 'Spain road camera', lat, lon, country: 'Spain', source: 'DGT (Dirección General de Tráfico)', image: url })
  }
  // Oregon (TripCheck): Esri JSON, a still by file name.
  for (const f of ((raw.oregon as { features?: { attributes?: Record<string, unknown> }[] })?.features ?? [])) {
    const a = f.attributes ?? {}
    const file = String(a.filename ?? '')
    if (!/^[\w .()-]+\.jpg$/i.test(file)) continue
    push({ id: `or:${String(a.cameraId)}`, name: String(a.title ?? a.route ?? 'Oregon camera'), lat: num(a.latitude), lon: num(a.longitude), country: 'United States', source: 'Oregon DOT (TripCheck)', image: `https://tripcheck.com/RoadCams/cams/${encodeURIComponent(file)}` })
  }
  // Queensland (QLDTraffic, CC BY 4.0).
  for (const f of ((raw.qld as { features?: { geometry?: { coordinates?: number[] }; properties?: Record<string, unknown> }[] })?.features ?? [])) {
    const p = f.properties ?? {}
    const c = f.geometry?.coordinates ?? []
    push({ id: `qld:${String(p.id)}`, name: String(p.description ?? 'Queensland camera'), lat: num(c[1]), lon: num(c[0]), country: 'Australia', source: 'Queensland TMR (QLDTraffic)', image: String(p.image_url ?? ''), heading: compassDegrees(p.direction) })
  }
  // Norway: still frames for all, HLS where the record says so.
  for (const f of ((raw.norway as { features?: Record<string, unknown>[] })?.features ?? [])) {
    const p = (f.properties as Record<string, unknown> | undefined) ?? {}
    const coords = (f.geometry as { coordinates?: number[] } | undefined)?.coordinates ?? []
    const id = String(p.cameraId ?? '')
    const still = String(p.stillImageUrl ?? '')
    if (!/^[\w-]{1,40}$/.test(id) || !still.startsWith('https://kamera.atlas.vegvesen.no/')) continue
    push({ id: `no:${id}`, name: [p.roadNumber, p.orientationDescription].filter(x => typeof x === 'string' && x).join(' · ') || 'Norway road camera', lat: num(coords[1]), lon: num(coords[0]), country: 'Norway', source: 'Statens vegvesen (NLOD)', image: still, video: p.videoEncodingStandard === 'hls' ? httpsVideo(`https://kamera.vegvesen.no/public/${id}/manifest.m3u8`, 'hls') : undefined })
  }
  return out
}

/** Windy Webcams map clusters (API v3, the owner's own free key): cameras for one map view. */
export const parseWindyClusters = (j: unknown): Camera[] => {
  const out: Camera[] = []
  for (const w of Array.isArray(j) ? (j as Record<string, unknown>[]) : []) {
    if (w.status !== 'active') continue
    const loc = (w.location as Record<string, unknown> | undefined) ?? {}
    const img = ((w.images as Record<string, unknown> | undefined)?.current as Record<string, unknown> | undefined) ?? {}
    const player = (w.player as Record<string, unknown> | undefined) ?? {}
    const https = (v: unknown) => (typeof v === 'string' && v.startsWith('https://') ? v : undefined)
    const live = https(player.live)
    const day = https(player.day)
    const lat = typeof loc.latitude === 'number' ? loc.latitude : NaN
    const lon = typeof loc.longitude === 'number' ? loc.longitude : NaN
    const image = https(img.preview) ?? https(img.thumbnail) ?? ''
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !image) continue
    out.push({
      id: `wc:${String(w.webcamId)}`,
      name: String(w.title ?? [loc.city, loc.country].filter(Boolean).join(', ') ?? 'Webcam'),
      lat,
      lon,
      country: String(loc.country ?? ''),
      source: 'Windy Webcams',
      image,
      player: live ? { url: live, kind: 'live' } : day ? { url: day, kind: 'timelapse' } : undefined,
      link: https((w.urls as Record<string, unknown> | undefined)?.detail),
    })
  }
  return out
}

/**
 * Windy only answers for a box small enough for its zoom (22.5° by 45° at
 * zoom 4, half that per step): the view, cut down around its centre to fit.
 */
export const windyBox = (b: { south: number; west: number; north: number; east: number }, zoom: number) => {
  const z = Math.max(4, Math.min(18, Math.round(zoom)))
  const latSpan = 22.5 / 2 ** (z - 4)
  const lonSpan = 45 / 2 ** (z - 4)
  const cLat = (b.south + b.north) / 2
  const cLon = b.west <= b.east ? (b.west + b.east) / 2 : ((b.west + b.east + 360) / 2 + 180) % 360 - 180
  const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v))
  const half = (span: number, want: number) => Math.min(span, Math.abs(want)) / 2
  const hLat = half(latSpan, b.north - b.south)
  const hLon = half(lonSpan, b.west <= b.east ? b.east - b.west : b.east + 360 - b.west)
  return { zoom: z, north: clamp(cLat + hLat, 90), south: clamp(cLat - hLat, 90), east: clamp(cLon + hLon, 180), west: clamp(cLon - hLon, 180) }
}

export type WorldOp = { kind: 'add'; name: string } | { kind: 'remove'; id: string } | { kind: 'refresh' }

/** A space launch, upcoming or recent (Launch Library 2). */
export interface Launch {
  id: string
  name: string
  /** Epoch ms of the launch (NET: no earlier than). */
  at: number
  status: string
  provider: string
  rocket: string
  mission: string
  orbit: string
  pad: string
  location: string
  lat: number
  lon: number
  webcast: boolean
}

export const parseLaunches = (j: unknown): Launch[] => {
  const results = (j as { results?: unknown[] })?.results ?? []
  const out: Launch[] = []
  const str = (v: unknown, n = 120) => (typeof v === 'string' ? v.slice(0, n) : '')
  for (const r of results) {
    const o = (r ?? {}) as { id?: unknown; name?: unknown; net?: unknown; webcast_live?: unknown; status?: { abbrev?: unknown; name?: unknown }; launch_service_provider?: { name?: unknown }; rocket?: { configuration?: { name?: unknown } }; mission?: { name?: unknown; orbit?: { name?: unknown } }; pad?: { name?: unknown; latitude?: unknown; longitude?: unknown; location?: { name?: unknown } } }
    const lat = Number(o.pad?.latitude)
    const lon = Number(o.pad?.longitude)
    const at = Date.parse(str(o.net, 40))
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !Number.isFinite(at)) continue
    out.push({
      id: str(o.id, 60),
      name: str(o.name),
      at,
      status: str(o.status?.abbrev ?? o.status?.name, 30),
      provider: str(o.launch_service_provider?.name),
      rocket: str(o.rocket?.configuration?.name),
      mission: str(o.mission?.name),
      orbit: str(o.mission?.orbit?.name, 60),
      pad: str(o.pad?.name),
      location: str(o.pad?.location?.name),
      lat,
      lon,
      webcast: o.webcast_live === true,
    })
  }
  return out
}

/** An internet radio station with a place (Radio Browser). */
export interface RadioStation {
  id: string
  name: string
  country: string
  tags: string
  codec: string
  bitrate: number
  /** https stream, played straight from the broadcaster. */
  url: string
  lat: number
  lon: number
}

export const parseRadio = (j: unknown): RadioStation[] =>
  (Array.isArray(j) ? j : [])
    .map(r => (r ?? {}) as Record<string, unknown>)
    .filter(r => typeof r.url_resolved === 'string' && /^https:\/\//.test(r.url_resolved) && r.lastcheckok !== 0 && Number.isFinite(Number(r.geo_lat)) && Number.isFinite(Number(r.geo_long)) && !(Number(r.geo_lat) === 0 && Number(r.geo_long) === 0))
    .map(r => ({
      id: String(r.stationuuid ?? '').slice(0, 60),
      name: String(r.name ?? '').trim().slice(0, 80),
      country: String(r.country ?? '').slice(0, 60),
      tags: String(r.tags ?? '').split(',').slice(0, 4).join(', ').slice(0, 80),
      codec: String(r.codec ?? '').slice(0, 12),
      bitrate: Number(r.bitrate) || 0,
      url: String(r.url_resolved).slice(0, 500),
      lat: Number(r.geo_lat),
      lon: Number(r.geo_long),
    }))
    .filter(r => r.id && r.name && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180)

export const WLD = {
  state: 'world:state',
  add: 'world:add',
  remove: 'world:remove',
  refresh: 'world:refresh',
  flights: 'world:flights',
  flightsArea: 'world:flights-area',
  flightRoute: 'world:flight-route',
  aircraft: 'world:aircraft',
  wiki: 'world:wiki',
  intelEvents: 'world:intel-events',
  markets: 'world:markets',
  image: 'world:image',
  vip: 'world:vip',
  richest: 'world:richest',
  country: 'world:country',
  intelStats: 'world:intel-stats',
  intelCountries: 'world:intel-countries',
  intelAlerts: 'world:intel-alerts',
  intelUkraine: 'world:intel-ukraine',
  track: 'world:track',
  launches: 'world:launches',
  trafficFlow: 'world:traffic-flow',
  trafficIncidents: 'world:traffic-incidents',
  radio: 'world:radio',
  rain: 'world:rain',
  map3dKeys: 'world:map3d-keys',
  satellites: 'world:satellites',
  cables: 'world:cables',
  cable: 'world:cable',
  ships: 'world:ships',
  shipsKey: 'world:ships-key',
  cameras: 'world:cameras',
  cameraImage: 'world:camera-image',
  webcams: 'world:webcams',
  webcamsKey: 'world:webcams-key',
  changed: 'world:changed',
} as const

export interface WorldBridge {
  state(): Promise<WorldSnapshot>
  add(name: string): Promise<WorldSnapshot>
  remove(id: string): Promise<WorldSnapshot>
  refresh(): Promise<WorldSnapshot>
  /** Aircraft within dist nautical miles (up to 1000) of a point, plus military worldwide; fill asks OpenSky too where coverage is thin. */
  flights(lat: number, lon: number, dist: number, fill?: boolean): Promise<Flight[]>
  /** Every aircraft over a wide view, filled in area by area as Atlas sweeps it, plus military worldwide. */
  flightsArea(box: GeoBox): Promise<FlightsArea>
  /** Where a flight flies from and to, by callsign; null when no route is known. */
  flightRoute(callsign: string): Promise<FlightRoute | null>
  /** The airframe behind an ICAO hex: type, owner, a photo (adsbdb); null when unknown. */
  aircraft(hex: string): Promise<AircraftInfo | null>
  /** Wikidata on a notable ship (MMSI) or satellite (NORAD number): photo, description, operator; null when unknown. */
  wiki(kind: 'ship' | 'satellite', id: string): Promise<WikiThing | null>
  /** Conflict events of the last hours (GDELT, filtered and categorised), newest first. */
  intelEvents(hours: number): Promise<IntelEvent[]>
  /** Indices, commodities, crypto, currencies and sectors, with their month (Yahoo, cached 30 min). */
  markets(): Promise<Quote[]>
  /** A Wikimedia Commons or airport-data.com picture, fetched by main, as a data URL; null when it cannot be had. */
  image(url: string): Promise<string | null>
  /** VIP aircraft: how many of each kind are known, and which are flying now among the aircraft Atlas sees. */
  vip(): Promise<{ total: number; counts: Partial<Record<VipCategory, number>>; flying: VipFlying[] }>
  /** The richest people (Wikidata), most first. */
  richest(): Promise<RichPerson[]>
  /** A country's card by ISO code (Wikidata), null when unknown. */
  country(iso: string): Promise<CountryCard | null>
  /** Events per country, most first. */
  intelStats(hours: number): Promise<ReturnType<typeof countryStats>>
  /** Country shapes (Natural Earth 110m) with iso and name, for highlighting. */
  intelCountries(): Promise<{ type: 'FeatureCollection'; features: { type: 'Feature'; geometry: unknown; properties: Record<string, unknown> }[] }>
  /** Ukraine's oblasts under an air-raid alert right now. */
  intelAlerts(): Promise<AlertRegion[]>
  /** Ukraine's oblast shapes, for the alert highlight. */
  intelUkraine(): Promise<{ type: 'FeatureCollection'; features: { type: 'Feature'; geometry: unknown; properties: Record<string, unknown> }[] }>
  /** This flight's track so far (OpenSky, keyless, sparing): null when it has none. */
  track(hex: string): Promise<FlightTrack | null>
  /** Space launches: the next 30 days and the last 7 (Launch Library 2, keyless). */
  launches(): Promise<Launch[]>
  /** Roads with live flow around a view (TomTom; OpenStreetMap roads, simulated, where TomTom has none). */
  trafficFlow(box: GeoBox, zoom: number): Promise<import('./traffic.ts').TrafficFlowView>
  /** Traffic incidents in a view (TomTom). */
  trafficIncidents(box: GeoBox): Promise<import('./traffic.ts').TrafficIncident[]>
  /** Internet radio stations with a place (Radio Browser, keyless). */
  radio(): Promise<RadioStation[]>
  /** The newest global rain frame (NASA IMERG, 30-minute) as a GIBS time; null: use yesterday's daily. */
  rain(): Promise<string | null>
  /** Keys for the 3D view (browser-side by nature): Google photorealistic tiles, Cesium ion. */
  map3dKeys(): Promise<{ google: string | null; ion: string | null; tomtom: string | null }>
  /** The ISS, stations and the brightest satellites. */
  /** Orbit elements: space stations and the brightest; 'all' adds navigation, weather and geostationary groups (each tagged _group). */
  satellites(which?: 'all'): Promise<SatelliteElements[]>
  /** The world's submarine cables and landing points (TeleGeography, fetched daily); null when unreachable. */
  cables(): Promise<CablesResult | null>
  /** One cable's card: length, owners, landings, ready-for-service year. */
  cable(id: string): Promise<CableDetail | null>
  /** Ships in the area on screen (needs the owner's free AISStream key). */
  ships(box: { south: number; west: number; north: number; east: number }): Promise<ShipsResult>
  /** Saves the AISStream key in the Windows credential store (null removes it). */
  setShipsKey(key: string | null): Promise<{ hasKey: boolean }>
  /** Public cameras from official open feeds (only where such feeds exist). */
  cameras(): Promise<Camera[]>
  /** A camera's latest frame, fetched by Atlas, as a data URL. */
  cameraImage(id: string): Promise<{ dataUrl: string; at: number }>
  /** Worldwide webcams in a map view (the owner's free Windy key; zoom 4 and closer). */
  webcams(box: { south: number; west: number; north: number; east: number }, zoom: number): Promise<{ status: 'no-key' | 'ok' | 'error'; cameras: Camera[]; message: string | null }>
  /** Saves the Windy Webcams key in the Windows credential store (null removes it). */
  setWebcamsKey(key: string | null): Promise<{ hasKey: boolean }>
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
