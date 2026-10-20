/**
 * Satellites in the 3D view: every tracked object as a point at its real
 * height, coloured by group (stations, GPS, Galileo, GLONASS, BeiDou,
 * weather, geostationary), the picked one's orbit as a ring, and the camera
 * modes that ride one (follow it, or look straight down from it).
 */
import * as Cesium from '@cesium/engine'
import { FixedFrameTransforms as Transforms } from '@cesium/core'
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
/** Satellites closer to the camera than this show as a 3D model (at most MAX_MODELS of them). */
const MODEL_RANGE_M = 3_000_000
const MAX_MODELS = 20

export class Satellites3D {
  readonly list: Sat3D[] = []
  private readonly points: Cesium.PointPrimitiveCollection
  private readonly orbits: Cesium.PolylineCollection
  private hidden = new Set<SatGroupId>()
  private orbitOf: Sat3D | null = null
  private orbitAt = 0
  private models = new Map<number, Cesium.Model>()
  private loadingModels = new Set<number>()
  private readonly hpr = new Cesium.HeadingPitchRoll()
  private readonly at = new Cesium.Cartesian3()

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
    for (const m of this.models.values()) m.show = on
  }

  setGroupHidden(group: SatGroupId, hide: boolean) {
    if (hide) this.hidden.add(group)
    else this.hidden.delete(group)
    for (const s of this.list) s.point.show = !this.hidden.has(s.group) && !this.models.has(s.i)
    for (const [i, m] of this.models) m.show = !this.hidden.has(this.list[i]!.group)
  }

  /** Propagates every shown satellite to now; the picked one's orbit ring is redrawn each minute. */
  move(now: Date) {
    if (!this.points.show) return
    for (const s of this.list) {
      if (!s.point.show || this.models.has(s.i)) continue
      const f = orbitFacts(s.rec, now)
      if (f) s.point.position = Cesium.Cartesian3.fromDegrees(f.lon, f.lat, f.altKm * 1000)
    }
    if (this.orbitOf && now.getTime() - this.orbitAt > 60_000) this.drawOrbit(this.orbitOf)
  }

  /** How many satellites are showing as models: the view draws continuously while any do. */
  get modelCount() {
    return this.models.size
  }

  /**
   * Which satellites get a 3D model: those near the camera, plus the one
   * picked or ridden. Called once a second; models come and go here.
   */
  pickModels(camera: { x: number; y: number; z: number }, keep: number | null) {
    const want = new Set<number>()
    // Models only when the camera is down among the low orbits (or for the one picked or ridden):
    // from high up they would be specks that keep the view drawing continuously.
    const low = Cesium.Cartesian3.magnitude(camera as never) - Cesium.Ellipsoid.WGS84.maximumRadius < 2_500_000
    if (this.points.show) {
      const near = this.list
        .filter(s => s.point.show && (s.i === keep || (low && Cesium.Cartesian3.distance(s.point.position, camera as never) < MODEL_RANGE_M)))
        .sort((a, b) => Cesium.Cartesian3.distance(a.point.position, camera as never) - Cesium.Cartesian3.distance(b.point.position, camera as never))
        .slice(0, MAX_MODELS)
      for (const s of near) want.add(s.i)
      if (keep !== null) want.add(keep)
    }
    for (const [i, m] of this.models)
      if (!want.has(i)) {
        this.scene.primitives.remove(m)
        this.models.delete(i)
        const s = this.list[i]
        if (s) s.point.show = !this.hidden.has(s.group)
      }
    for (const i of want) {
      if (this.models.has(i) || this.loadingModels.has(i)) continue
      const s = this.list[i]
      if (!s) continue
      this.loadingModels.add(i)
      // Stations are much bigger than a typical satellite.
      const scale = s.group === 'stations' ? 8 : 1
      void Cesium.Model.fromGltfAsync({ url: './models/satellite.glb', scale, minimumPixelSize: s.group === 'stations' ? 56 : 40, maximumScale: 20_000, id: { kind: 'sat', i } }).then(
        model => {
          this.loadingModels.delete(i)
          if (this.scene.isDestroyed()) return model.destroy()
          this.models.set(i, this.scene.primitives.add(model) as Cesium.Model)
          s.point.show = false
          this.frame()
          this.scene.requestRender()
        },
        () => this.loadingModels.delete(i),
      )
    }
  }

  /** Moves the modelled satellites to this very moment, wings across their path: every frame while any show. */
  frame() {
    for (const [i, m] of this.models) {
      const s = this.list[i]
      const w = s ? this.where(s) : null
      if (!s || !w) continue
      Cesium.Cartesian3.fromDegrees(w.lon, w.lat, w.altM, Cesium.Ellipsoid.WGS84, this.at)
      s.point.position = this.at
      this.hpr.heading = Cesium.Math.toRadians(w.heading)
      m.modelMatrix = Transforms.headingPitchRollToFixedFrame(this.at, this.hpr, Cesium.Ellipsoid.WGS84, undefined, m.modelMatrix)
    }
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
