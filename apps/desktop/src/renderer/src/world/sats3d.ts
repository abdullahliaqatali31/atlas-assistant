/**
 * Satellites in the 3D view: every tracked object as a point at its real
 * height, coloured by group (stations, GPS, Galileo, GLONASS, BeiDou,
 * weather, geostationary), the picked one's orbit as a ring, and the camera
 * modes that ride one (follow it, or look straight down from it).
 */
import * as Cesium from '@cesium/engine'
import * as satellite from 'satellite.js'

import { satGroup, SAT_GROUPS, type SatGroupId } from '../../../shared/space.ts'
import type { SatelliteElements } from '../../../shared/world.ts'
import { orbitFacts, type OrbitFacts } from './passes.ts'

export interface Sat3D {
  i: number
  name: string
  norad: string
  group: SatGroupId
  rec: satellite.SatRec
  point: Cesium.PointPrimitive
}

const ORBIT_STEPS = 180

export class Satellites3D {
  readonly list: Sat3D[] = []
  private readonly points: Cesium.PointPrimitiveCollection
  private readonly orbits: Cesium.PolylineCollection
  private hidden = new Set<SatGroupId>()
  private orbitOf: Sat3D | null = null
  private orbitAt = 0

  constructor(private readonly scene: Cesium.Scene) {
    this.points = scene.primitives.add(new Cesium.PointPrimitiveCollection()) as Cesium.PointPrimitiveCollection
    this.orbits = scene.primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection
  }

  load(elements: SatelliteElements[]) {
    this.points.removeAll()
    this.list.length = 0
    for (const s of elements) {
      try {
        const rec = satellite.json2satrec(s as unknown as satellite.OMMJsonObject)
        const name = String(s.OBJECT_NAME ?? '')
        const group = satGroup(s._group).id
        const iss = /ISS \(ZARYA\)/.test(name)
        const point = this.points.add({ pixelSize: iss ? 9 : group === 'stations' ? 6 : 4, color: Cesium.Color.fromCssColorString(satGroup(group).color), outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1, id: { kind: 'sat', i: this.list.length } })
        this.list.push({ i: this.list.length, name, norad: String(s.NORAD_CAT_ID ?? ''), group, rec, point })
      } catch {
        // A malformed element set: skip it.
      }
    }
    this.move(new Date())
  }

  /** How many are in each group, for the legend. */
  counts(): Record<SatGroupId, number> {
    const out = Object.fromEntries(SAT_GROUPS.map(g => [g.id, 0])) as Record<SatGroupId, number>
    for (const s of this.list) out[s.group]++
    return out
  }

  setVisible(on: boolean) {
    this.points.show = on
    this.orbits.show = on
  }

  setGroupHidden(group: SatGroupId, hide: boolean) {
    if (hide) this.hidden.add(group)
    else this.hidden.delete(group)
    for (const s of this.list) s.point.show = !this.hidden.has(s.group)
  }

  /** Propagates every shown satellite to now; the picked one's orbit ring is redrawn each minute. */
  move(now: Date) {
    if (!this.points.show) return
    for (const s of this.list) {
      if (!s.point.show) continue
      const f = orbitFacts(s.rec, now)
      if (f) s.point.position = Cesium.Cartesian3.fromDegrees(f.lon, f.lat, f.altKm * 1000)
    }
    if (this.orbitOf && now.getTime() - this.orbitAt > 60_000) this.drawOrbit(this.orbitOf)
  }

  facts(s: Sat3D): OrbitFacts | null {
    return orbitFacts(s.rec, new Date())
  }

  /** One full revolution, drawn in the Earth's frame as it is now: the ring the satellite is flying around. */
  showOrbit(s: Sat3D | null) {
    this.orbitOf = s
    this.orbits.removeAll()
    if (s) this.drawOrbit(s)
  }

  private drawOrbit(s: Sat3D) {
    this.orbits.removeAll()
    this.orbitAt = Date.now()
    const now = new Date()
    const period = this.facts(s)?.periodMin ?? 95
    const gmst = satellite.gstime(now)
    const positions: ReturnType<typeof Cesium.Cartesian3.fromDegrees>[] = []
    for (let k = 0; k <= ORBIT_STEPS; k++) {
      const pv = satellite.propagate(s.rec, new Date(now.getTime() + (k / ORBIT_STEPS) * period * 60_000))
      if (!pv || typeof pv.position !== 'object' || !pv.position) continue
      const ecf = satellite.eciToEcf(pv.position, gmst)
      positions.push(new Cesium.Cartesian3(ecf.x * 1000, ecf.y * 1000, ecf.z * 1000))
    }
    if (positions.length > 2) this.orbits.add({ positions, width: 1.6, material: Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString(satGroup(s.group).color).withAlpha(0.85) }) })
  }

  /** Where it is now, and which way it is moving over the ground (degrees from north). */
  where(s: Sat3D): { lat: number; lon: number; altM: number; heading: number } | null {
    const now = orbitFacts(s.rec, new Date())
    const next = orbitFacts(s.rec, new Date(Date.now() + 1000))
    if (!now || !next) return null
    const y = Math.sin(((next.lon - now.lon) * Math.PI) / 180) * Math.cos((next.lat * Math.PI) / 180)
    const x = Math.cos((now.lat * Math.PI) / 180) * Math.sin((next.lat * Math.PI) / 180) - Math.sin((now.lat * Math.PI) / 180) * Math.cos((next.lat * Math.PI) / 180) * Math.cos(((next.lon - now.lon) * Math.PI) / 180)
    return { lat: now.lat, lon: now.lon, altM: now.altKm * 1000, heading: (Math.atan2(y, x) * 180) / Math.PI }
  }

  destroy() {
    // The scene destroys its primitives with the widget.
    this.list.length = 0
  }
}
