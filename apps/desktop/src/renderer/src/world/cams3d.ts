/**
 * Public cameras in the 3D view (the official open feeds main gathers): a
 * point for each, red where the agency streams live video. The picked camera
 * shows what it sees, as in God's Eye View: a wireframe pyramid along its
 * compass heading and, at the far end, a screen with its latest frame, or
 * the live stream itself where there is one. Cameras without a heading get
 * their frame floating above them instead.
 */
import * as Cesium from '@cesium/engine'
import { FixedFrameTransforms as Transforms } from '@cesium/core'

import type { Camera } from '../../../shared/world.ts'
import { viewCone, type V3 } from './camview.ts'

const STILL = Cesium.Color.fromCssColorString('#2dd4bf')
const LIVE = Cesium.Color.fromCssColorString('#f87171')
/** Height of the camera above the ground: a mast. */
const MAST_M = 12

export interface CameraView {
  /** The camera's eye, Earth-fixed, and its heading and tilt: for "view from here". */
  eye: ReturnType<typeof Cesium.Cartesian3.fromDegrees>
  heading?: number | undefined
  tiltDeg: number
}

export class Cameras3D {
  list: Camera[] = []
  private readonly points: Cesium.PointPrimitiveCollection
  private readonly lines: Cesium.PolylineCollection
  private readonly floating: Cesium.BillboardCollection
  private screen: Cesium.Primitive | null = null
  loaded = false

  constructor(private readonly scene: Cesium.Scene) {
    this.points = scene.primitives.add(new Cesium.PointPrimitiveCollection()) as Cesium.PointPrimitiveCollection
    this.lines = scene.primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection
    this.floating = scene.primitives.add(new Cesium.BillboardCollection({ scene })) as Cesium.BillboardCollection
  }

  load(cameras: Camera[]) {
    this.points.removeAll()
    this.list = cameras
    cameras.forEach((c, i) => {
      this.points.add({ position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 20), pixelSize: c.video ? 6 : 5, color: c.video ? LIVE : STILL, outlineColor: Cesium.Color.BLACK.withAlpha(0.6), outlineWidth: 1, scaleByDistance: new Cesium.NearFarScalar(5e3, 1.6, 8e6, 0.6), id: { kind: 'cam', i } })
    })
    this.loaded = true
  }

  setVisible(on: boolean) {
    this.points.show = on
    this.lines.show = on
    this.floating.show = on
    if (this.screen) this.screen.show = on
  }

  /** Clears the picked camera's cone and screen. */
  clear() {
    this.lines.removeAll()
    this.floating.removeAll()
    if (this.screen) this.scene.primitives.remove(this.screen)
    this.screen = null
  }

  /**
   * Draws the picked camera's view: the cone and a screen showing `frame`
   * (a still as a data URL, or a playing <video>). Returns where its eye is.
   */
  show(c: Camera, frame: string | HTMLVideoElement | null): CameraView {
    this.clear()
    const ground = this.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(c.lon, c.lat)) ?? 0
    const eye = Cesium.Cartesian3.fromDegrees(c.lon, c.lat, ground + MAST_M)
    const tiltDeg = 8
    if (c.heading === undefined) {
      // No heading known: the frame floats above the camera, facing the viewer.
      if (typeof frame === 'string') this.floating.add({ position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, ground + 60), image: frame, width: 192, height: 108, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY })
      return { eye, tiltDeg }
    }
    const cone = viewCone(c.heading, { tiltDeg })
    const enu = Transforms.eastNorthUpToFixedFrame(eye, Cesium.Ellipsoid.WGS84)
    const at = (v: V3) => Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(v[0], v[1], v[2]), new Cesium.Cartesian3())
    const dir = (v: V3, k = 1) => Cesium.Matrix4.multiplyByPointAsVector(enu, new Cesium.Cartesian3(v[0] * k, v[1] * k, v[2] * k), new Cesium.Cartesian3())
    // One material per line: Cesium destroys a polyline's material with it.
    const material = () => Cesium.Material.fromType('Color', { color: (c.video ? LIVE : STILL).withAlpha(0.9) })
    const far = cone.corners.map(at)
    for (const p of far) this.lines.add({ positions: [eye, p], width: 1.5, material: material() })
    this.lines.add({ positions: [...far, far[0]!], width: 2, material: material() })
    if (frame) {
      // The plane's x and y run along the camera's right and up, so the frame reads correctly from the camera's side.
      const x = dir(cone.right, cone.width)
      const y = dir(cone.up, cone.height)
      const z = dir(cone.forward, -1)
      const rotation = Cesium.Matrix3.fromColumnMajorArray([x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z])
      const modelMatrix = Cesium.Matrix4.fromRotationTranslation(rotation, at(cone.centre))
      this.screen = this.scene.primitives.add(
        new Cesium.Primitive({
          geometryInstances: new Cesium.GeometryInstance({ geometry: new Cesium.PlaneGeometry({ vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat }), modelMatrix }),
          appearance: new Cesium.MaterialAppearance({ material: Cesium.Material.fromType('Image', { image: frame }), materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED, translucent: false, closed: false, faceForward: true }),
          asynchronous: false,
        }),
      ) as Cesium.Primitive
    }
    return { eye, heading: c.heading, tiltDeg }
  }
}
