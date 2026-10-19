/** GeoJSON for the World map's own layers, and the icons they draw with. */
import * as satellite from 'satellite.js'

import { aircraftName, squawkMeaning } from '../../../shared/aircraft.ts'
import type { Flight, Launch, RadioStation, Ship, WorldSnapshot } from '../../../shared/world.ts'

export const cleanError = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'

export const EVENT_COLOR: Record<string, string> = { Wildfires: '#f97316', 'Severe Storms': '#a78bfa', Volcanoes: '#ef4444', Floods: '#38bdf8' }

/** Minimal GeoJSON shapes for the map sources. */
export interface PointGeometry {
  type: 'Point'
  coordinates: number[]
}
export interface FC {
  type: 'FeatureCollection'
  features: { type: 'Feature'; geometry: PointGeometry; properties: Record<string, string | number> }[]
}

export const ALERT_COLOR: Record<string, string> = { Red: '#ef4444', Orange: '#f97316', Green: '#22c55e' }

export const toFeatures = (w: WorldSnapshot): { places: FC; quakes: FC; events: FC; disasters: FC } => ({
  places: { type: 'FeatureCollection', features: w.places.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.place.lon, p.place.lat] }, properties: { id: p.place.id, title: p.place.name } })) },
  quakes: {
    type: 'FeatureCollection',
    features: w.quakes.map(q => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [q.lon, q.lat] }, properties: { title: `M${q.mag.toFixed(1)} · ${q.place}`, mag: q.mag, url: q.url, time: q.time } })),
  },
  events: {
    type: 'FeatureCollection',
    features: w.events.map(e => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.lon, e.lat] }, properties: { title: `${e.category}: ${e.title}`, category: e.category, color: EVENT_COLOR[e.category] ?? '#94a3b8', url: e.url, time: e.time } })),
  },
  disasters: {
    type: 'FeatureCollection',
    features: (w.disasters ?? []).map(d => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
      properties: { id: d.id, title: d.name, kind: d.kind, alert: d.alert, rank: d.alert === 'Red' ? 2 : d.alert === 'Orange' ? 1 : 0, color: ALERT_COLOR[d.alert] ?? '#22c55e', country: d.country, severity: d.severity, url: d.url, time: d.to },
    })),
  },
})

/** An arrow pointing up, drawn once; tinted per aircraft (signed distance field). */
export const planeIcon = () => {
  const size = 32
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.beginPath()
  g.moveTo(16, 2)
  g.lineTo(27, 28)
  g.lineTo(16, 22)
  g.lineTo(5, 28)
  g.closePath()
  g.fill()
  return g.getImageData(0, 0, size, size)
}

/** A boat seen from above, pointing up; tinted per type. */
export const shipIcon = () => {
  const size = 32
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.beginPath()
  g.moveTo(16, 3)
  g.lineTo(23, 13)
  g.lineTo(22, 29)
  g.lineTo(10, 29)
  g.lineTo(9, 13)
  g.closePath()
  g.fill()
  return g.getImageData(0, 0, size, size)
}

export const SHIP_COLOR: Record<string, string> = { Cargo: '#34d399', Tanker: '#f87171', Passenger: '#60a5fa', Fishing: '#fbbf24', Military: '#ef4444', Tug: '#a3e635', Pleasure: '#f0abfc', 'High speed': '#22d3ee', Service: '#a3a3a3', Other: '#94a3b8' }

export const shipFeatures = (ships: Ship[]): FC => ({
  type: 'FeatureCollection',
  features: ships.map(v => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
    properties: {
      title: `${v.name || `MMSI ${v.mmsi}`} · ${v.category}`,
      detail: `${v.speed.toFixed(1)} kn${v.destination ? ` · to ${v.destination}` : ''}${v.length ? ` · ${v.length} m` : ''}`,
      id: `s:${v.mmsi}`,
      mmsi: v.mmsi,
      name: v.name,
      category: v.category,
      speed: v.speed,
      course: v.course,
      destination: v.destination,
      ...(v.length ? { length: v.length } : {}),
      rotation: v.heading ?? v.course,
      color: SHIP_COLOR[v.category] ?? SHIP_COLOR.Other!,
      time: v.at,
    },
  })),
})

/** "PIA301 FL340" above 18,000 ft (flight level), "PIA301 9,500 ft" below, the callsign alone on the ground. */
export const flightLabel = (f: Flight) => {
  const name = f.callsign || f.registration || f.hex.toUpperCase()
  if (f.altitude === null || f.altitude <= 0) return name
  return f.altitude >= 18_000 ? `${name} FL${String(Math.round(f.altitude / 100)).padStart(3, '0')}` : `${name} ${(Math.round(f.altitude / 100) * 100).toLocaleString()} ft`
}

/**
 * Where an aircraft is now, carried forward from its last report along its
 * track at its ground speed (at most 90 s, never for one on the ground), so
 * planes glide between polls instead of jumping.
 */
export const deadReckon = (f: Flight, seconds: number): Flight => {
  const s = Math.min(90, Math.max(0, seconds))
  if (!s || f.altitude === null || f.speed < 40) return f
  const nm = (f.speed * s) / 3600
  const rad = (f.track * Math.PI) / 180
  const lat = f.lat + (nm * Math.cos(rad)) / 60
  const lon = f.lon + (nm * Math.sin(rad)) / (60 * Math.max(0.05, Math.cos((f.lat * Math.PI) / 180)))
  return { ...f, lat: Math.max(-85, Math.min(85, lat)), lon: ((lon + 540) % 360) - 180 }
}

export const flightFeatures = (flights: Flight[]): FC => ({
  type: 'FeatureCollection',
  features: flights.map(f => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
    properties: {
      title: `${f.callsign || f.registration || f.hex}${f.type ? ` · ${f.type}` : ''}${f.military ? ' · military' : ''}`,
      detail: `${f.altitude === null ? 'On the ground' : `${Math.round(f.altitude).toLocaleString()} ft`} · ${Math.round(f.speed)} kt${f.registration ? ` · ${f.registration}` : ''}`,
      id: `f:${f.hex}`,
      hex: f.hex,
      callsign: f.callsign,
      registration: f.registration,
      type: f.type,
      typeName: aircraftName(f.type),
      military: f.military ? 1 : 0,
      altitude: f.altitude ?? 0,
      onGround: f.altitude === null ? 1 : 0,
      speed: f.speed,
      track: f.track,
      squawk: f.squawk,
      verticalRate: f.verticalRate ?? 0,
      emergency: f.emergency !== 'none' ? f.emergency : squawkMeaning(f.squawk),
      seen: f.seen,
      label: flightLabel(f),
      // Emergencies first, then military, then everyone else, when labels compete for room.
      rank: f.emergency !== 'none' || squawkMeaning(f.squawk) ? 0 : f.military ? 1 : 2,
      color: f.emergency !== 'none' || squawkMeaning(f.squawk) ? '#ef4444' : f.military ? '#fbbf24' : '#7dd3fc',
    },
  })),
})

/** Satellite positions now, from their orbit elements. */
export const satelliteFeatures = (sats: { name: string; rec: satellite.SatRec }[], at: Date): FC => {
  const gmst = satellite.gstime(at)
  const features: FC['features'] = []
  for (const s of sats) {
    const pv = satellite.propagate(s.rec, at)
    if (!pv || typeof pv.position !== 'object' || !pv.position) continue
    const geo = satellite.eciToGeodetic(pv.position, gmst)
    const iss = /^ISS \(ZARYA\)/.test(s.name)
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [satellite.degreesLong(geo.longitude), satellite.degreesLat(geo.latitude)] },
      properties: { id: `sat:${String(s.rec.satnum).trim()}`, norad: String(s.rec.satnum).trim(), name: s.name, title: iss ? 'ISS · International Space Station' : s.name, detail: `${Math.round(geo.height)} km up`, label: iss ? 'ISS' : '', size: iss ? 7 : 3.5 },
    })
  }
  return { type: 'FeatureCollection', features }
}

/** "in 2 d 4 h", "in 35 min", "launched 3 h ago". */
export const launchWhen = (at: number, now: number) => {
  const d = at - now
  const abs = Math.abs(d)
  const parts = abs >= 86_400_000 ? `${Math.floor(abs / 86_400_000)} d ${Math.floor((abs % 86_400_000) / 3_600_000)} h` : abs >= 3_600_000 ? `${Math.floor(abs / 3_600_000)} h ${Math.floor((abs % 3_600_000) / 60_000)} min` : `${Math.max(1, Math.round(abs / 60_000))} min`
  return d >= 0 ? `in ${parts}` : `launched ${parts} ago`
}

const LAUNCH_COLOR: Record<string, string> = { Go: '#22c55e', TBC: '#94a3b8', TBD: '#94a3b8', 'In Flight': '#22d3ee', Success: '#84cc16', Failure: '#ef4444', 'Partial Failure': '#f97316', Hold: '#f59e0b' }

export const launchFeatures = (list: Launch[], now: number): FC => {
  const nextId = [...list].filter(l => l.at > now - 3_600_000).sort((a, b) => a.at - b.at)[0]?.id
  return {
    type: 'FeatureCollection',
    features: list.map(l => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
      properties: {
        id: `l:${l.id}`,
        title: l.name,
        label: `${l.rocket || l.name} · ${launchWhen(l.at, now)}`,
        at: l.at,
        status: l.status,
        provider: l.provider,
        rocket: l.rocket,
        mission: l.mission,
        orbit: l.orbit,
        pad: l.pad,
        location: l.location,
        webcast: l.webcast ? 1 : 0,
        upcoming: l.at > now ? 1 : 0,
        next: l.id === nextId ? 1 : 0,
        color: LAUNCH_COLOR[l.status] ?? '#a3e635',
      },
    })),
  }
}

export const radioFeatures = (list: RadioStation[]): FC => ({
  type: 'FeatureCollection',
  features: list.map(r => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
    properties: { id: `r:${r.id}`, title: r.name, country: r.country, tags: r.tags, codec: r.codec, bitrate: r.bitrate, url: r.url, color: '#e879f9' },
  })),
})

/** NASA IMERG rain tiles: the newest 30-minute frame when known, else yesterday's daily total. */
export const rainTiles = (time: string | null, now = Date.now()) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate${time ? '_30min' : ''}/default/${time ?? new Date(now - 86_400_000).toISOString().slice(0, 10)}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`
