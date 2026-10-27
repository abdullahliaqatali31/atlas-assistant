/**
 * Shapes for the 3D view's wider layers: satellite groups (CelesTrak) and the
 * world's submarine cables (TeleGeography's public Submarine Cable Map,
 * fetched at run time and credited; its data is not shipped with Atlas).
 */

/** CelesTrak groups the 3D view shows, in priority order (a satellite in two keeps the first). */
export const SAT_GROUPS = [
  { id: 'stations', label: 'Space stations', color: '#f0abfc' },
  { id: 'visual', label: 'Brightest', color: '#c084fc' },
  { id: 'gps-ops', label: 'GPS', color: '#34d399' },
  { id: 'galileo', label: 'Galileo', color: '#60a5fa' },
  { id: 'glo-ops', label: 'GLONASS', color: '#f87171' },
  { id: 'beidou', label: 'BeiDou', color: '#fbbf24' },
  { id: 'weather', label: 'Weather', color: '#22d3ee' },
  { id: 'geo', label: 'Geostationary', color: '#a3a3a3' },
] as const

export type SatGroupId = (typeof SAT_GROUPS)[number]['id']

export const satGroup = (id: unknown) => SAT_GROUPS.find(g => g.id === id) ?? SAT_GROUPS[1]

/** One cable route: its colour on TeleGeography's map, and its segments as [lon, lat] lines. */
export interface CableLine {
  id: string
  name: string
  color: string
  lines: [number, number][][]
}

export interface Landing {
  id: string
  name: string
  lat: number
  lon: number
}

export interface CableDetail {
  id: string
  name: string
  length: string
  owners: string
  /** Ready for service: a year, or empty. */
  rfs: string
  planned: boolean
  url: string
  landings: { name: string; country: string }[]
}

export interface CablesResult {
  cables: CableLine[]
  landings: Landing[]
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const isPair = (p: unknown): p is [number, number] => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1])

/** cable-geo.json (GeoJSON MultiLineString / LineString features). */
export const parseCables = (j: unknown): CableLine[] => {
  const features = (j as { features?: unknown[] })?.features
  if (!Array.isArray(features)) return []
  const out: CableLine[] = []
  for (const f of features) {
    const p = (f as { properties?: Record<string, unknown> }).properties ?? {}
    const g = (f as { geometry?: { type?: string; coordinates?: unknown } }).geometry
    const raw = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : null
    if (!Array.isArray(raw)) continue
    const lines = raw.map(l => (Array.isArray(l) ? l.filter(isPair).map(([lon, lat]) => [lon, lat] as [number, number]) : [])).filter(l => l.length >= 2)
    const id = str(p.id)
    if (!id || !lines.length) continue
    out.push({ id, name: str(p.name) || id, color: /^#[0-9a-f]{6}$/i.test(str(p.color)) ? str(p.color) : '#39d5ff', lines })
  }
  return out
}

/** landing-point-geo.json (GeoJSON Point features). */
export const parseLandings = (j: unknown): Landing[] => {
  const features = (j as { features?: unknown[] })?.features
  if (!Array.isArray(features)) return []
  const out: Landing[] = []
  for (const f of features) {
    const p = (f as { properties?: Record<string, unknown> }).properties ?? {}
    const c = (f as { geometry?: { coordinates?: unknown } }).geometry?.coordinates
    if (!isPair(c) || !str(p.id)) continue
    out.push({ id: str(p.id), name: str(p.name), lon: c[0], lat: c[1] })
  }
  return out
}

/** cable/{id}.json */
export const parseCableDetail = (j: unknown): CableDetail | null => {
  const r = j as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || !str(r.id)) return null
  const lp = Array.isArray(r.landing_points) ? r.landing_points : []
  const url = str(r.url)
  return {
    id: str(r.id),
    name: str(r.name) || str(r.id),
    length: str(r.length),
    owners: str(r.owners),
    rfs: str(r.rfs) || (typeof r.rfs_year === 'number' ? String(r.rfs_year) : ''),
    planned: r.is_planned === true,
    // Only web links: the page opens them in the browser.
    url: /^https?:\/\//.test(url) ? url : '',
    landings: lp.map(l => ({ name: str((l as Record<string, unknown>).name), country: str((l as Record<string, unknown>).country) })).filter(l => l.name),
  }
}

/** A cable id is a TeleGeography slug: safe to put in its URL. */
export const isCableId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,120}$/.test(id)
