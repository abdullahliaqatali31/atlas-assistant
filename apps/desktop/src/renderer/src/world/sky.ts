/**
 * Where the Sun and Moon are, for the 3D view's celestial ring: the point on
 * Earth each is straight above, and the Moon's phase. Low-precision formulas
 * (the Astronomical Almanac's solar position, a truncated lunar series):
 * well under a degree, plenty for a ring around the globe.
 */

const RAD = Math.PI / 180
const norm360 = (d: number) => ((d % 360) + 360) % 360
const norm180 = (d: number) => norm360(d + 180) - 180

/** Days since J2000.0 (2000-01-01 12:00 UTC). */
const daysJ2000 = (at: Date) => at.getTime() / 86_400_000 - 10_957.5

/** Greenwich mean sidereal time, degrees. */
const gmst = (d: number) => norm360(280.46061837 + 360.98564736629 * d)

const OBLIQUITY = 23.4393

/** Right ascension and declination (degrees) of ecliptic coordinates. */
const toEquatorial = (lon: number, lat: number) => {
  const e = OBLIQUITY * RAD
  const l = lon * RAD
  const b = lat * RAD
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l))
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l))
  return { ra: norm360(ra / RAD), dec: dec / RAD }
}

export interface SubPoint {
  /** The point on Earth it stands straight above. */
  lat: number
  lon: number
  /** Ecliptic longitude, degrees (for the phase). */
  eclLon: number
}

export const sunPosition = (at: Date): SubPoint => {
  const d = daysJ2000(at)
  const g = norm360(357.529 + 0.98560028 * d) * RAD
  const q = norm360(280.459 + 0.98564736 * d)
  const eclLon = norm360(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g))
  const { ra, dec } = toEquatorial(eclLon, 0)
  return { lat: dec, lon: norm180(ra - gmst(d)), eclLon }
}

export const moonPosition = (at: Date): SubPoint => {
  const d = daysJ2000(at)
  const L = norm360(218.316 + 13.176396 * d)
  const M = norm360(134.963 + 13.064993 * d) * RAD
  const F = norm360(93.272 + 13.22935 * d) * RAD
  const D = norm360(297.85 + 12.190749 * d) * RAD
  const Ms = norm360(357.529 + 0.98560028 * d) * RAD
  const eclLon = norm360(L + 6.289 * Math.sin(M) + 1.274 * Math.sin(2 * D - M) + 0.658 * Math.sin(2 * D) - 0.186 * Math.sin(Ms) + 0.214 * Math.sin(2 * M))
  const eclLat = 5.128 * Math.sin(F)
  const { ra, dec } = toEquatorial(eclLon, eclLat)
  return { lat: dec, lon: norm180(ra - gmst(d)), eclLon }
}

const PHASES = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'] as const

/** How much of the Moon is lit (0-1), whether it is growing, and the phase's name. */
export const moonPhase = (at: Date): { fraction: number; waxing: boolean; name: (typeof PHASES)[number] } => {
  const age = norm360(moonPosition(at).eclLon - sunPosition(at).eclLon)
  const fraction = (1 - Math.cos(age * RAD)) / 2
  return { fraction, waxing: age < 180, name: PHASES[Math.round(age / 45) % 8]! }
}

/** Unit vector from Earth's centre toward a point above lat/lon (Earth-fixed x, y, z). */
export const towards = (p: { lat: number; lon: number }): [number, number, number] => {
  const la = p.lat * RAD
  const lo = p.lon * RAD
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]
}

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!

/**
 * Where a direction falls on a ring around the globe on screen: the angle
 * (radians, 0 = right, counter-clockwise) from the camera's right and up
 * vectors, and how visible it is (0 when it points straight at or away from
 * the viewer, so the angle means nothing).
 */
export const ringAngle = (dir: readonly number[], right: readonly number[], up: readonly number[], forward: readonly number[]) => {
  const along = Math.abs(dot(dir, forward))
  return { angle: Math.atan2(dot(dir, up), dot(dir, right)), visibility: Math.max(0, Math.min(1, (1 - along) / 0.045)) }
}

export const latLonLabel = (p: { lat: number; lon: number }) => `${Math.abs(p.lat).toFixed(1)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(1)}°${p.lon >= 0 ? 'E' : 'W'}`
