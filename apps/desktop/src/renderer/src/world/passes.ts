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
