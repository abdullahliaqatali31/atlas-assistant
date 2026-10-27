/**
 * Satellites over a place, from their orbit elements: what is above the
 * horizon now, and when the next passes come (rise, highest point, set).
 * All local with satellite.js; nothing is fetched.
 */
import * as satellite from 'satellite.js'

export interface Observer {
  lat: number
  lon: number
  /** Metres above sea level. */
  heightM?: number
}

export interface Pass {
  rise: number
  set: number
  /** Degrees above the horizon at the highest point. */
  maxElevation: number
  maxAt: number
}

const RAD = Math.PI / 180

const observerGd = (o: Observer) => ({ latitude: o.lat * RAD, longitude: o.lon * RAD, height: (o.heightM ?? 0) / 1000 })

/** Degrees above the observer's horizon at `at`, or null when the orbit cannot be computed. */
export const elevationAt = (rec: satellite.SatRec, o: Observer, at: Date): number | null => {
  const pv = satellite.propagate(rec, at)
  if (!pv || typeof pv.position !== 'object' || !pv.position) return null
  const ecf = satellite.eciToEcf(pv.position, satellite.gstime(at))
  return satellite.ecfToLookAngles(observerGd(o), ecf).elevation / RAD
}

/**
 * Passes in the next `hours` that climb at least `minElevation` degrees.
 * Steps every 30 s, then narrows rise and set to the second.
 */
export const nextPasses = (rec: satellite.SatRec, o: Observer, from: number, opts: { hours?: number; minElevation?: number; limit?: number } = {}): Pass[] => {
  const { hours = 48, minElevation = 10, limit = 5 } = opts
  const step = 30_000
  const end = from + hours * 3_600_000
  const elev = (t: number) => elevationAt(rec, o, new Date(t)) ?? -90
  /** The moment between a (below) and b (above), or the other way, where it crosses the horizon. */
  const cross = (a: number, b: number) => {
    let lo = a
    let hi = b
    const rising = elev(a) < 0
    while (hi - lo > 1_000) {
      const mid = (lo + hi) / 2
      if (elev(mid) < 0 === rising) lo = mid
      else hi = mid
    }
    return Math.round((lo + hi) / 2)
  }
  const out: Pass[] = []
  let prevT = from
  let prevE = elev(from)
  let current: { rise: number; max: number; maxAt: number } | null = prevE >= 0 ? { rise: from, max: prevE, maxAt: from } : null
  for (let t = from + step; t <= end && out.length < limit; t += step) {
    const e = elev(t)
    if (prevE < 0 && e >= 0) current = { rise: cross(prevT, t), max: e, maxAt: t }
    else if (current && e >= 0 && e > current.max) current = { ...current, max: e, maxAt: t }
    else if (current && prevE >= 0 && e < 0) {
      if (current.max >= minElevation) out.push({ rise: current.rise, set: cross(prevT, t), maxElevation: Math.round(current.max), maxAt: current.maxAt })
      current = null
    }
    prevT = t
    prevE = e
  }
  return out
}

/** How many of the given satellites are above the horizon now. */
export const aboveNow = (recs: readonly { rec: satellite.SatRec }[], o: Observer, at: Date) => recs.filter(s => (elevationAt(s.rec, o, at) ?? -1) > 0).length

const EARTH_KM = 6371

/** Where the satellite will be over the next `minutes`, one point a minute, longitudes kept continuous. */
export const groundTrack = (rec: satellite.SatRec, from: number, minutes = 95): [number, number][] => {
  const out: [number, number][] = []
  for (let m = 0; m <= minutes; m++) {
    const at = new Date(from + m * 60_000)
    const pv = satellite.propagate(rec, at)
    if (!pv || typeof pv.position !== 'object' || !pv.position) continue
    const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(at))
    let lon = satellite.degreesLong(geo.longitude)
    const prev = out.at(-1)
    if (prev) {
      while (lon - prev[0] > 180) lon -= 360
      while (lon - prev[0] < -180) lon += 360
    }
    out.push([lon, satellite.degreesLat(geo.latitude)])
  }
  return out
}

/** Ground distance to the horizon as seen from `altKm` up: the circle the satellite can see. */
export const horizonKm = (altKm: number) => EARTH_KM * Math.acos(EARTH_KM / (EARTH_KM + Math.max(0, altKm)))

/** A ring of points `radiusKm` around a place, for drawing a footprint. */
export const ring = ([lon, lat]: [number, number], radiusKm: number, steps = 72): [number, number][] => {
  const d = radiusKm / EARTH_KM
  const p1 = lat * RAD
  const l1 = lon * RAD
  const out: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const b = (i / steps) * 2 * Math.PI
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b))
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2))
    out.push([l2 / RAD, p2 / RAD])
  }
  return out
}

export interface OrbitFacts {
  norad: string
  altKm: number
  speedKms: number
  inclination: number
  periodMin: number
  lat: number
  lon: number
}

/** Where it is now and the shape of its orbit, for the satellite's card. */
export const orbitFacts = (rec: satellite.SatRec, at: Date): OrbitFacts | null => {
  const pv = satellite.propagate(rec, at)
  if (!pv || typeof pv.position !== 'object' || !pv.position || typeof pv.velocity !== 'object' || !pv.velocity) return null
  const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(at))
  const v = pv.velocity
  return {
    norad: String(rec.satnum).trim(),
    altKm: Math.round(geo.height),
    speedKms: Math.round(Math.hypot(v.x, v.y, v.z) * 100) / 100,
    inclination: Math.round((rec.inclo / RAD) * 10) / 10,
    // no is in radians per minute.
    periodMin: Math.round(((2 * Math.PI) / rec.no) * 10) / 10,
    lat: satellite.degreesLat(geo.latitude),
    lon: satellite.degreesLong(geo.longitude),
  }
}
