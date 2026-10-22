/**
 * The other planes in the sky are real (live flights, glided between polls):
 * this finds the one the owner's plane hits, and the nearest one around for
 * the traffic warning. Generous on purpose: a game should not be denied a
 * collision by a few metres of position noise.
 */
import { bearing, metresBetween } from './physics.ts'

export interface Traffic {
  id: string
  label: string
  lat: number
  lon: number
  /** Metres above the sea. */
  alt: number
  /** How big it is: half its wingspan, roughly (m). */
  radius: number
}

export interface Contact {
  traffic: Traffic
  /** Metres away. */
  distance: number
  /** Radians from north. */
  bearing: number
  /** Metres above (+) or below (-) the owner's plane. */
  above: number
}

/** A quick box test first (most of the sky is far away), then real distance. */
const near = (a: { lat: number; lon: number }, b: { lat: number; lon: number }, km: number) => Math.abs(a.lat - b.lat) < km / 111 && Math.abs(((b.lon - a.lon + 540) % 360) - 180) * Math.cos((a.lat * Math.PI) / 180) < km / 111

/**
 * What the plane at `me` touches: the first plane closer than both radii plus
 * `slack` metres. Also checks the line it flew since the last step (`from`),
 * so at 500 m/s nothing is skipped between frames.
 */
export const hit = (me: { lat: number; lon: number; alt: number }, from: { lat: number; lon: number; alt: number }, radius: number, traffic: readonly Traffic[], slack = 15): Traffic | null => {
  for (const t of traffic) {
    if (!near(me, t, 3)) continue
    const reach = radius + t.radius + slack
    // A few points along the path flown this step.
    for (let k = 0; k <= 4; k++) {
      const f = k / 4
      const p = { lat: from.lat + (me.lat - from.lat) * f, lon: from.lon + (me.lon - from.lon) * f, alt: from.alt + (me.alt - from.alt) * f }
      if (metresBetween(p, t) < reach) return t
    }
  }
  return null
}

/** The nearest planes within `km`, closest first. */
export const contacts = (me: { lat: number; lon: number; alt: number }, traffic: readonly Traffic[], km = 15, limit = 5): Contact[] =>
  traffic
    .filter(t => near(me, t, km))
    .map(t => ({ traffic: t, distance: metresBetween(me, t), bearing: bearing(me, t), above: t.alt - me.alt }))
    .filter(c => c.distance < km * 1000)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
