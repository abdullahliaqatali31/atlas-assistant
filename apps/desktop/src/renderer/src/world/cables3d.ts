/**
 * The world's submarine cables in the 3D view (TeleGeography's public map,
 * fetched by main once a day): every route in its own colour along the sea
 * floor's surface, landing stations as points, and the picked cable lit up.
 * Static, so it costs nothing between frames.
 */
import * as Cesium from '@cesium/engine'

import type { CablesResult } from '../../../shared/space.ts'

export class Cables3D {
  private readonly lines: Cesium.PolylineCollection
  private readonly landings: Cesium.PointPrimitiveCollection
  private byId = new Map<string, Cesium.Polyline[]>()
  private lit: string | null = null
  loaded = false
  names = new Map<string, string>()

  constructor(scene: Cesium.Scene) {
    this.lines = scene.primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection
    this.landings = scene.primitives.add(new Cesium.PointPrimitiveCollection()) as Cesium.PointPrimitiveCollection
    this.setVisible(false)
  }

  load(data: CablesResult) {
    this.lines.removeAll()
    this.landings.removeAll()
    this.byId.clear()
    for (const c of data.cables) {
      this.names.set(c.id, c.name)
      const material = Cesium.Material.fromType('Color', { color: Cesium.Color.fromCssColorString(c.color).withAlpha(0.85) })
      const parts: Cesium.Polyline[] = []
      for (const line of c.lines) parts.push(this.lines.add({ positions: Cesium.Cartesian3.fromDegreesArray(line.flat()), width: 1.8, material, id: { kind: 'cable', id: c.id } }))
      this.byId.set(c.id, parts)
    }
    const landing = Cesium.Color.fromCssColorString('#8fffd2')
    for (const l of data.landings) this.landings.add({ position: Cesium.Cartesian3.fromDegrees(l.lon, l.lat, 30), pixelSize: 4, color: landing, outlineColor: Cesium.Color.BLACK.withAlpha(0.5), outlineWidth: 1, scaleByDistance: new Cesium.NearFarScalar(2e5, 1.6, 1.5e7, 0.7), id: { kind: 'landing', name: l.name } })
    this.loaded = true
  }

  setVisible(on: boolean) {
    this.lines.show = on
    this.landings.show = on
  }

  /** Thicker and brighter for the picked cable; null puts it back. */
  highlight(id: string | null) {
    if (this.lit) for (const p of this.byId.get(this.lit) ?? []) p.width = 1.8
    this.lit = id
    if (id) for (const p of this.byId.get(id) ?? []) p.width = 5
  }

  /** A point on the cable to fly to: the middle of its longest segment. */
  centre(id: string): ReturnType<typeof Cesium.Cartesian3.fromDegrees> | null {
    const parts = this.byId.get(id)
    if (!parts?.length) return null
    const longest = parts.reduce((a, b) => (b.positions.length > a.positions.length ? b : a))
    return longest.positions[Math.floor(longest.positions.length / 2)] ?? null
  }
}
