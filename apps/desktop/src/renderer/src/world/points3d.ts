/**
 * A plain layer of picked-on-click points in the 3D view (radio stations,
 * news): one cheap point primitive each, coloured and sized by the caller,
 * drawn just above the ground.
 */
import * as Cesium from '@cesium/engine'

export interface Point3D {
  lat: number
  lon: number
  color: string
  size?: number | undefined
}

export class Points3D<T> {
  items: T[] = []
  private readonly points: Cesium.PointPrimitiveCollection
  loaded = false

  constructor(
    scene: Cesium.Scene,
    private readonly kind: string,
  ) {
    this.points = scene.primitives.add(new Cesium.PointPrimitiveCollection()) as Cesium.PointPrimitiveCollection
    this.points.show = false
  }

  load(items: T[], place: (item: T) => Point3D | null) {
    this.points.removeAll()
    this.items = items
    items.forEach((item, i) => {
      const p = place(item)
      if (!p) return
      this.points.add({ position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 60), pixelSize: p.size ?? 6, color: Cesium.Color.fromCssColorString(p.color), outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1, scaleByDistance: new Cesium.NearFarScalar(1e4, 1.5, 1e7, 0.7), id: { kind: this.kind, i } })
    })
    this.loaded = true
  }

  setVisible(on: boolean) {
    this.points.show = on
  }
}
