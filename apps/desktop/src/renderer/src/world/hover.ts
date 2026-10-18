/**
 * What a map item says about itself: the hover card's lines, the
 * Inspector's facts, and what else sits nearby. Pure, so it is tested
 * without a map (plan §4.3).
 */
import { aqiLevel, kmBetween, type WorldSnapshot } from '../../../shared/world.ts'
import type { FC } from './geo.ts'
import { layerDef, LAYERS, type LayerId } from './layers.ts'

export type Props = Record<string, string | number>

export interface HoverInfo {
  /** "FLIGHT", "EARTHQUAKE"… */
  kind: string
  title: string
  /** Two or three short lines; the first is the most useful. */
  facts: string[]
  color: string
  /** A public camera shows its latest frame in the card. */
  cameraId?: string
}

/** Compact age like a map label: "now", "12 min", "3 h", "10 d". */
export const shortAge = (t: number, now: number) => {
  const m = Math.max(0, Math.round((now - t) / 60_000))
  if (m < 1) return 'now'
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`
}

const str = (v: string | number | undefined) => (v === undefined || v === '' ? '' : String(v))

/** "M5.2 · 10 km SW of Town" → the place part; titles with no "·" stay whole. */
const afterDot = (t: string) => (t.includes(' · ') ? t.slice(t.indexOf(' · ') + 3) : t)

export const hoverInfo = (kind: LayerId, props: Props, world: WorldSnapshot, now: number): HoverInfo => {
  const def = layerDef(kind)
  const base = { kind: def.kind.toUpperCase(), color: typeof props.color === 'string' ? props.color : def.dot }
  const title = str(props.title) || def.kind
  const time = typeof props.time === 'number' && props.time > 0 ? shortAge(props.time, now) : ''
  switch (kind) {
    case 'places': {
      const s = world.places.find(p => p.place.id === props.id)
      const facts: string[] = []
      if (s?.weather) facts.push(`${Math.round(s.weather.temp)}° · ${s.weather.summary}`)
      if (s?.air) facts.push(`Air ${s.air.aqi >= 500 ? '500+' : s.air.aqi} · ${aqiLevel(s.air.aqi)}`)
      if (s?.nearby.length) facts.push(`${s.nearby.length} event${s.nearby.length === 1 ? '' : 's'} nearby`)
      return { ...base, title: s?.place.name ?? title, facts: facts.length ? facts : ['Watched place'] }
    }
    case 'quakes': {
      const mag = typeof props.mag === 'number' ? `Magnitude ${props.mag.toFixed(1)}` : ''
      return { ...base, title: afterDot(title), facts: [mag, time && `${time} ago`].filter(Boolean) }
    }
    case 'events': {
      const [category, ...rest] = title.split(': ')
      return { ...base, kind: (rest.length ? category! : def.kind).toUpperCase(), title: rest.length ? rest.join(': ') : title, facts: [time && `Reported ${time} ago`].filter(Boolean) }
    }
    case 'cameras':
      return { ...base, title, facts: [str(props.source)].filter(Boolean), cameraId: str(props.id) || undefined }
    case 'pins':
      return { ...base, title, facts: [str(props.note)].filter(Boolean) }
    case 'flights':
    case 'ships':
    case 'satellites':
      return { ...base, title, facts: [str(props.detail), time && `Seen ${time} ago`].filter(Boolean) }
  }
}

export interface NearbyItem {
  kind: LayerId
  title: string
  km: number
  lngLat: [number, number]
  props: Props
}

/** Satellites race past; they are never "nearby" in a useful sense. */
const NEARBY_KINDS: LayerId[] = LAYERS.map(l => l.id).filter(id => id !== 'satellites')

/**
 * Everything already on the map within `radiusKm` of a point, nearest
 * first, the picked item itself left out.
 */
export const nearbyItems = (
  at: [number, number],
  sources: Partial<Record<LayerId, FC>>,
  opts: { radiusKm?: number; limit?: number; exclude?: { kind: LayerId; props: Props } } = {},
): NearbyItem[] => {
  const { radiusKm = 100, limit = 8, exclude } = opts
  const [lon, lat] = at
  const out: NearbyItem[] = []
  for (const kind of NEARBY_KINDS) {
    for (const f of sources[kind]?.features ?? []) {
      const [fLon, fLat] = f.geometry.coordinates as [number, number]
      if (exclude && exclude.kind === kind && fLon === lon && fLat === lat && exclude.props.title === f.properties.title) continue
      const km = kmBetween({ lat, lon }, { lat: fLat, lon: fLon })
      if (km <= radiusKm) out.push({ kind, title: str(f.properties.title) || layerDef(kind).kind, km: Math.round(km), lngLat: [fLon, fLat], props: f.properties })
    }
  }
  return out.sort((a, b) => a.km - b.km).slice(0, limit)
}
