/**
 * Moving traffic in the 3D view: the same engine as the flat map, its cars as
 * glowing points on the ground, each at its road's height, and incidents as
 * markers. Roads load for the view each time the camera settles close to
 * the ground; while cars move, the view draws continuously (onLive tells
 * the render governor), and stops when the camera rises or traffic is off.
 */
import type * as CesiumNS from '@cesium/engine'

import { TrafficEngine, type TrafficIncident } from '../../../shared/traffic.ts'
import type { TrafficStatus } from './TrafficLayer2D.tsx'

/** Above this the cars would be specks: only the coloured flow tiles show. */
const MAX_HEIGHT_M = 45_000

const INCIDENT_COLOR: Record<TrafficIncident['kind'], string> = { accident: '#ef4444', jam: '#f97316', roadworks: '#eab308', closure: '#b91c1c', weather: '#38bdf8', hazard: '#f59e0b', other: '#a3a3a3' }

export class Traffic3D {
  private readonly engine = new TrafficEngine()
  private cars: CesiumNS.PointPrimitiveCollection
  private incs: CesiumNS.PointPrimitiveCollection
  private laneHeight: number[] = []
  private incidents: TrafficIncident[] = []
  private colors = new Map<string, ReturnType<typeof CesiumNS.Color.fromCssColorString>>()
  private seq = 0
  private last = performance.now()
  private live = false
  private offMove: () => void
  private offFrame: () => void
  private readonly scratch: ReturnType<typeof CesiumNS.Cartesian3.fromDegrees>

  constructor(
    private readonly viewer: CesiumNS.CesiumWidget,
    private readonly C: typeof CesiumNS,
    private readonly deps: { onStatus: (s: TrafficStatus | null) => void; onLive: (live: boolean) => void },
  ) {
    const scene = viewer.scene
    this.scratch = new C.Cartesian3()
    this.cars = scene.primitives.add(new C.PointPrimitiveCollection()) as CesiumNS.PointPrimitiveCollection
    this.incs = scene.primitives.add(new C.PointPrimitiveCollection()) as CesiumNS.PointPrimitiveCollection
    const move = () => this.load()
    viewer.camera.moveEnd.addEventListener(move)
    this.offMove = () => viewer.camera.moveEnd.removeEventListener(move)
    const frame = () => this.frame()
    scene.preRender.addEventListener(frame)
    this.offFrame = () => scene.preRender.removeEventListener(frame)
    this.load()
  }

  /** The incident behind a picked marker. */
  incident(id: string): TrafficIncident | undefined {
    return this.incidents.find(i => i.id === id)
  }

  private color(css: string, alpha = 1) {
    const k = `${css}/${alpha}`
    let c = this.colors.get(k)
    if (!c) this.colors.set(k, (c = this.C.Color.fromCssColorString(css).withAlpha(alpha)))
    return c
  }

  private setLive(on: boolean) {
    if (on === this.live) return
    this.live = on
    this.deps.onLive(on)
  }

  /** The view's box and a map-like zoom for the camera's height. */
  private view() {
    const C = this.C
    const cam = this.viewer.camera
    const h = cam.positionCartographic.height
    const rect = cam.computeViewRectangle()
    const width = this.viewer.canvas.clientWidth || 1000
    const zoom = Math.log2((40_075_016 * width) / (256 * 1.15 * Math.max(50, h)))
    if (!rect) return null
    // Looking toward the horizon, the view reaches far: keep the box near the camera.
    const lat = C.Math.toDegrees(cam.positionCartographic.latitude)
    const lon = C.Math.toDegrees(cam.positionCartographic.longitude)
    const span = Math.min(0.5, (h / 111_000) * 2.5)
    const box = {
      west: Math.max(C.Math.toDegrees(rect.west), lon - span * 1.4),
      east: Math.min(C.Math.toDegrees(rect.east), lon + span * 1.4),
      south: Math.max(C.Math.toDegrees(rect.south), lat - span),
      north: Math.min(C.Math.toDegrees(rect.north), lat + span),
    }
    if (box.east <= box.west || box.north <= box.south) return null
    return { box, zoom, h }
  }

  private load() {
    const v = this.view()
    const mine = ++this.seq
    if (!v || v.h > MAX_HEIGHT_M) {
      this.engine.setRoads([])
      this.syncCars()
      this.deps.onStatus({ source: 'far', cars: 0, incidents: this.incidents.length })
      if (v && v.h < 400_000) this.loadIncidents(v.box, mine)
      return
    }
    void window.world.trafficFlow(v.box, v.zoom).then(
      f => {
        if (mine !== this.seq || this.viewer.isDestroyed()) return
        this.engine.setRoads(f.roads, v.zoom >= 14 ? 2200 : 1600, Math.round(v.zoom * 1000))
        this.heights()
        this.syncCars()
        this.deps.onStatus({ source: f.source, cars: this.engine.cars.length, incidents: this.incidents.length })
      },
      (e: unknown) => mine === this.seq && this.deps.onStatus({ source: 'error', message: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e), cars: 0, incidents: 0 }),
    )
    this.loadIncidents(v.box, mine)
  }

  private loadIncidents(box: { west: number; south: number; east: number; north: number }, mine: number) {
    void window.world.trafficIncidents(box).then(
      list => {
        if (mine !== this.seq || this.viewer.isDestroyed()) return
        this.incidents = list
        this.incs.removeAll()
        for (const i of list)
          this.incs.add({
            position: this.C.Cartesian3.fromDegrees(i.lon, i.lat, 15),
            pixelSize: i.magnitude >= 3 ? 11 : 9,
            color: this.color(INCIDENT_COLOR[i.kind]),
            outlineColor: this.C.Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            id: { kind: 'incident', id: i.id },
          })
        this.viewer.scene.requestRender()
      },
      () => undefined,
    )
  }

  /** Each road's ground height, sampled once at its middle (the terrain there is loaded: the camera looks at it). */
  private heights() {
    const C = this.C
    const globe = this.viewer.scene.globe
    this.laneHeight = this.engine.lanes.map(l => {
      const mid = l.path[l.path.length >> 1]!
      return (globe.getHeight(C.Cartographic.fromDegrees(mid[0], mid[1])) ?? 0) + 3
    })
  }

  /** One point per car. */
  private syncCars() {
    const n = this.engine.cars.length
    while (this.cars.length < n) this.cars.add({ pixelSize: 2.5, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY })
    for (let i = 0; i < this.cars.length; i++) this.cars.get(i).show = i < n
    this.setLive(n > 0)
    this.viewer.scene.requestRender()
  }

  private frame() {
    const now = performance.now()
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    const e = this.engine
    if (!e.cars.length || document.hidden) return
    const h = this.viewer.camera.positionCartographic.height
    const width = this.viewer.canvas.clientWidth || 1000
    e.step(dt, Math.max(1, Math.min(80, ((1.15 * h) / width) * 1.1)))
    const C = this.C
    for (let i = 0; i < e.cars.length; i++) {
      const car = e.cars[i]!
      const p = e.place(car)
      const pt = this.cars.get(i)
      pt.position = C.Cartesian3.fromDegrees(p.lon, p.lat, this.laneHeight[car.lane] ?? 3, C.Ellipsoid.WGS84, this.scratch)
      pt.color = this.color(p.color)
      pt.outlineColor = this.color(p.color, 0.3)
    }
  }

  destroy() {
    this.seq++
    this.offMove()
    this.offFrame()
    this.setLive(false)
    const prims = this.viewer.isDestroyed() ? null : this.viewer.scene.primitives
    prims?.remove(this.cars)
    prims?.remove(this.incs)
    this.deps.onStatus(null)
  }
}
