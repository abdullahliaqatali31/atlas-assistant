/** GeoJSON for the World map's own layers, and the icons they draw with. */
import * as satellite from 'satellite.js'

import type { Flight, Ship, WorldSnapshot } from '../../../shared/world.ts'

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

export const toFeatures = (w: WorldSnapshot): { places: FC; quakes: FC; events: FC } => ({
  places: { type: 'FeatureCollection', features: w.places.map(p => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.place.lon, p.place.lat] }, properties: { id: p.place.id, title: p.place.name } })) },
  quakes: {
    type: 'FeatureCollection',
    features: w.quakes.map(q => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [q.lon, q.lat] }, properties: { title: `M${q.mag.toFixed(1)} · ${q.place}`, mag: q.mag, url: q.url, time: q.time } })),
  },
  events: {
    type: 'FeatureCollection',
    features: w.events.map(e => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [e.lon, e.lat] }, properties: { title: `${e.category}: ${e.title}`, color: EVENT_COLOR[e.category] ?? '#94a3b8', url: e.url, time: e.time } })),
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
      name: v.name,
      rotation: v.heading ?? v.course,
      color: SHIP_COLOR[v.category] ?? SHIP_COLOR.Other!,
      time: v.at,
    },
  })),
})

export const flightFeatures = (flights: Flight[]): FC => ({
  type: 'FeatureCollection',
  features: flights.map(f => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
    properties: {
      title: `${f.callsign || f.registration || f.hex}${f.type ? ` · ${f.type}` : ''}${f.military ? ' · military' : ''}`,
      detail: `${f.altitude === null ? 'On the ground' : `${Math.round(f.altitude).toLocaleString()} ft`} · ${Math.round(f.speed)} kt${f.registration ? ` · ${f.registration}` : ''}`,
      callsign: f.callsign,
      track: f.track,
      color: f.military ? '#ef4444' : '#fbbf24',
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
      properties: { title: iss ? 'ISS · International Space Station' : s.name, detail: `${Math.round(geo.height)} km up`, label: iss ? 'ISS' : '', size: iss ? 7 : 3.5 },
    })
  }
  return { type: 'FeatureCollection', features }
}
