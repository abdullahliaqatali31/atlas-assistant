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
import type { SatWorkerIn, SatWorkerOut } from './sats3d.worker.ts'

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
const MODEL_RANGE_SQ = MODEL_RANGE_M * MODEL_RANGE_M
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
  private readonly moveAt = new Cesium.Cartesian3()
  /** SGP4 for the whole catalogue runs here, off the page's thread (null where workers are missing: then on the page). */
  private worker: Worker | null = null
  private seq = 0
  private waiting: { seq: number; since: number; done: (changed: boolean) => void } | null = null

  constructor(private readonly scene: Cesium.Scene) {
    this.points = scene.primitives.add(new Cesium.PointPrimitiveCollection()) as Cesium.PointPrimitiveCollection
    this.orbits = scene.primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection
    try {
      this.worker = new Worker(new URL('./sats3d.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<SatWorkerOut>) => this.applyMoved(e.data)
      this.worker.onerror = () => {
        // The worker failed to start: propagate on the page instead.
        this.worker?.terminate()
        this.worker = null
        this.waiting?.done(false)
        this.waiting = null
      }
    } catch {
      this.worker = null
    }
  }

  load(elements: SatelliteElements[]) {
    this.points.removeAll()
    this.list.length = 0
    const kept: SatelliteElements[] = []
    for (const s of elements) {
      try {
        const rec = satellite.json2satrec(s as unknown as satellite.OMMJsonObject)
        const name = String(s.OBJECT_NAME ?? '')
        const group = satGroup(s._group).id
        const iss = /ISS \(ZARYA\)/.test(name)
        const point = this.points.add({ pixelSize: iss ? 9 : group === 'stations' ? 6 : 4, color: Cesium.Color.fromCssColorString(satGroup(group).color), outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1, id: { kind: 'sat', i: this.list.length } })
        this.list.push({ i: this.list.length, name, norad: String(s.NORAD_CAT_ID ?? ''), group, rec, point })
        kept.push(s)
      } catch {
        // A malformed element set: skip it.
      }
    }
    // The worker gets the same list, in the same order.
    this.worker?.postMessage({ kind: 'load', elements: kept } satisfies SatWorkerIn)
    // The first positions now, on the page, so the points appear at once.
    this.moveHere(new Date())
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

  /**
   * Propagates every shown satellite to now (hidden groups and modelled ones are skipped), in the
   * worker when there is one; the picked one's orbit ring is redrawn each minute. Resolves true when
   * any point moved, so the view draws only then.
   */
  move(now: Date): Promise<boolean> {
    if (!this.points.show || !this.list.length) return Promise.resolve(false)
    if (this.orbitOf && now.getTime() - this.orbitAt > 60_000) this.drawOrbit(this.orbitOf)
    if (!this.worker) return Promise.resolve(this.moveHere(now))
    // One request at a time (a stuck one is given up after 10 s).
    if (this.waiting && now.getTime() - this.waiting.since < 10_000) return Promise.resolve(false)
    this.waiting?.done(false)
    const skip = new Uint8Array(this.list.length)
    for (const s of this.list) if (!s.point.show || this.models.has(s.i)) skip[s.i] = 1
    const seq = ++this.seq
    return new Promise<boolean>(done => {
      this.waiting = { seq, since: now.getTime(), done }
      this.worker!.postMessage({ kind: 'move', seq, at: now.getTime(), skip } satisfies SatWorkerIn, [skip.buffer])
    })
  }

  /** The worker's answer: x, y, z in metres per satellite (NaN where skipped). */
  private applyMoved(m: SatWorkerOut) {
    const w = this.waiting
    if (!w || w.seq !== m.seq) return
    this.waiting = null
    let changed = false
    const pos = m.pos
    if (this.points.show && pos.length === this.list.length * 3)
      for (const s of this.list) {
        const x = pos[s.i * 3]!
        // Shown or hidden may have changed while the worker ran.
        if (Number.isNaN(x) || !s.point.show || this.models.has(s.i)) continue
        this.moveAt.x = x
        this.moveAt.y = pos[s.i * 3 + 1]!
        this.moveAt.z = pos[s.i * 3 + 2]!
        if (Cesium.Cartesian3.equals(s.point.position, this.moveAt)) continue
        s.point.position = this.moveAt
        changed = true
      }
    w.done(changed)
  }

  /** The same propagation on the page's thread (the first positions, or without a worker). */
  private moveHere(now: Date) {
    let changed = false
    const gmst = satellite.gstime(now)
    for (const s of this.list) {
      if (!s.point.show || this.models.has(s.i)) continue
      const pv = satellite.propagate(s.rec, now)
      if (!pv || typeof pv.position !== 'object' || !pv.position) continue
      const ecf = satellite.eciToEcf(pv.position, gmst)
      this.moveAt.x = ecf.x * 1000
      this.moveAt.y = ecf.y * 1000
      this.moveAt.z = ecf.z * 1000
      if (Cesium.Cartesian3.equals(s.point.position, this.moveAt)) continue
      s.point.position = this.moveAt
      changed = true
    }
    return changed
  }

  /** How many satellites are showing as models: the view draws continuously while any do. */
  get modelCount() {
    return this.models.size
  }

  /**
   * Which satellites get a 3D model: those near the camera, plus the one
   * picked or ridden. Called once a second; models come and go here. True when one was removed (a frame is needed).
   */
  pickModels(camera: { x: number; y: number; z: number }, keep: number | null): boolean {
    const want = new Set<number>()
    let removed = false
    // Models only when the camera is down among the low orbits (or for the one picked or ridden):
    // from high up they would be specks that keep the view drawing continuously.
    const low = Cesium.Cartesian3.magnitude(camera as never) - Cesium.Ellipsoid.WGS84.maximumRadius < 2_500_000
    if (this.points.show) {
      // Squared distances: no square roots over the whole catalogue each second.
      const near: { i: number; d: number }[] = []
      for (const s of this.list) {
        // Shown ones, and those already a model (their point is hidden then).
        if (this.hidden.has(s.group) || (!s.point.show && !this.models.has(s.i))) continue
        const d = Cesium.Cartesian3.distanceSquared(s.point.position, camera as never)
        if (s.i === keep || (low && d < MODEL_RANGE_SQ)) near.push({ i: s.i, d })
      }
      near.sort((a, b) => a.d - b.d)
      for (const n of near.slice(0, MAX_MODELS)) want.add(n.i)
      if (keep !== null) want.add(keep)
    }
    for (const [i, m] of this.models)
      if (!want.has(i)) {
        this.scene.primitives.remove(m)
        this.models.delete(i)
        removed = true
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
    return removed
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
    this.worker?.terminate()
    this.worker = null
    this.waiting?.done(false)
    this.waiting = null
    this.list.length = 0
  }
}
