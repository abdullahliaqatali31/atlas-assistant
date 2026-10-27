/**
 * A public camera's view in 3D: the pyramid it sees (apex at the camera,
 * looking along its compass heading, tilted down) and the screen at its far
 * end where its live frame is shown. Local east-north-up metres; the 3D view
 * turns them into Earth-fixed coordinates at the camera.
 */

export type V3 = [number, number, number]

const RAD = Math.PI / 180
const add = (...v: V3[]): V3 => v.reduce((a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], [0, 0, 0])
const mul = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

export interface ViewCone {
  forward: V3
  right: V3
  up: V3
  /** Far corners: top-left, top-right, bottom-right, bottom-left (as seen from the camera). */
  corners: [V3, V3, V3, V3]
  centre: V3
  width: number
  height: number
}

/** Road cameras typically look a little down the road, about 60° wide. */
export const viewCone = (headingDeg: number, opts: { tiltDeg?: number; fovDeg?: number; aspect?: number; range?: number } = {}): ViewCone => {
  const h = headingDeg * RAD
  const t = (opts.tiltDeg ?? 8) * RAD
  const range = opts.range ?? 140
  const width = 2 * range * Math.tan(((opts.fovDeg ?? 60) * RAD) / 2)
  const height = width / (opts.aspect ?? 16 / 9)
  const forward: V3 = [Math.sin(h) * Math.cos(t), Math.cos(h) * Math.cos(t), -Math.sin(t)]
  const right: V3 = [Math.cos(h), -Math.sin(h), 0]
  const up = cross(right, forward)
  const centre = mul(forward, range)
  const r = mul(right, width / 2)
  const u = mul(up, height / 2)
  return { forward, right, up, centre, width, height, corners: [add(centre, mul(r, -1), u), add(centre, r, u), add(centre, r, mul(u, -1)), add(centre, mul(r, -1), mul(u, -1))] }
}
