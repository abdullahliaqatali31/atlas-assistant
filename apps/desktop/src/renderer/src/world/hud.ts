/**
 * The World map's display: visual modes (night vision, thermal, CRT, noir)
 * and the numbers on the tactical HUD. Pure helpers here; Display.tsx draws.
 * Modes are CSS filters on the map plus light overlays, so they cost almost
 * nothing and work in Lite mode too.
 */

export const DISPLAY_MODES = ['normal', 'nvg', 'thermal', 'crt', 'noir'] as const
export type DisplayMode = (typeof DISPLAY_MODES)[number]

export const MODE_LABEL: Record<DisplayMode, string> = { normal: 'Normal', nvg: 'Night vision', thermal: 'Thermal', crt: 'CRT terminal', noir: 'Noir' }

/** CSS filters per mode; thermal maps brightness through the ironbow palette (an SVG filter in Display.tsx). */
export const MODE_FILTER: Record<DisplayMode, string> = {
  normal: 'none',
  nvg: 'grayscale(1) brightness(1.08) contrast(1.4) sepia(1) hue-rotate(58deg) saturate(4.2)',
  thermal: 'url(#atlas-ironbow) contrast(1.12)',
  crt: 'grayscale(1) contrast(1.45) brightness(0.95) sepia(1) hue-rotate(-8deg) saturate(2.8)',
  noir: 'grayscale(1) contrast(1.5) brightness(0.9)',
}

export interface DisplayPrefs {
  mode: DisplayMode
  hud: boolean
  scope: boolean
}

const KEY = 'world.display'
export const DEFAULT_DISPLAY: DisplayPrefs = { mode: 'normal', hud: false, scope: false }

export const readDisplay = (): DisplayPrefs => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DisplayPrefs>
    return { mode: DISPLAY_MODES.includes(raw.mode as DisplayMode) ? (raw.mode as DisplayMode) : 'normal', hud: raw.hud === true, scope: raw.scope === true }
  } catch {
    return DEFAULT_DISPLAY
  }
}

export const saveDisplay = (p: DisplayPrefs) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // A display that is not remembered is fine.
  }
}

/** Ground resolution at the map centre: metres covered by one screen pixel (Web Mercator, 512 px tiles). */
export const groundResolution = (lat: number, zoom: number) => (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom)

/** "1.2 km", "340 m", "2.1 m". */
export const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : m >= 10 ? `${Math.round(m)} m` : `${m.toFixed(1)} m`)

/** Sun elevation in degrees at a place and moment (declination and hour angle; within about a degree). */
export const sunElevation = (lat: number, lon: number, at: Date) => {
  const start = Date.UTC(at.getUTCFullYear(), 0, 0)
  const day = (at.getTime() - start) / 86_400_000
  const decl = (23.44 * Math.PI) / 180 * Math.sin(((2 * Math.PI) / 365) * (day - 81))
  const hours = at.getUTCHours() + at.getUTCMinutes() / 60 + lon / 15
  const hourAngle = ((hours - 12) * 15 * Math.PI) / 180
  const phi = (lat * Math.PI) / 180
  return (Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(hourAngle)) * 180) / Math.PI
}

/** 24°51′36″N 67°00′36″E */
export const dms = (lat: number, lon: number) => {
  const one = (v: number, pos: string, neg: string) => {
    const a = Math.abs(v)
    const d = Math.floor(a)
    const m = Math.floor((a - d) * 60)
    const s = Math.round(((a - d) * 60 - m) * 60)
    return `${d}°${String(m).padStart(2, '0')}′${String(s === 60 ? 59 : s).padStart(2, '0')}″${v >= 0 ? pos : neg}`
  }
  return `${one(lat, 'N', 'S')} ${one(lon, 'E', 'W')}`
}
