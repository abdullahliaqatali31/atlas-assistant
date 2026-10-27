/**
 * Ships as real 3D models, made here rather than downloaded: a hull with a
 * pointed bow, a deck, the bridge and a funnel, and for each kind what makes
 * it recognisable (container stacks on a cargo ship, a long white
 * superstructure on a passenger ship, a pipe deck on a tanker). Built as a
 * tiny glTF (length 1, bow along +Z, waterline at 0), scaled to the ship's
 * real length when it is placed.
 */

export type ShipKind = 'cargo' | 'tanker' | 'passenger' | 'small' | 'other'

export const shipKind = (category: string, type: number | null): ShipKind => {
  const c = category.toLowerCase()
  if (/cargo|container|bulk/.test(c) || (type !== null && type >= 70 && type < 80)) return 'cargo'
  if (/tank/.test(c) || (type !== null && type >= 80 && type < 90)) return 'tanker'
  if (/passenger|ferry|cruise/.test(c) || (type !== null && type >= 60 && type < 70)) return 'passenger'
  if (/fish|tug|pilot|sail|pleasure|yacht|law|search|dredg|diving/.test(c) || (type !== null && ((type >= 30 && type < 60) || type === 0))) return 'small'
  return 'other'
}

/** A believable length when AIS does not give one (metres). */
export const defaultLength: Record<ShipKind, number> = { cargo: 190, tanker: 230, passenger: 170, small: 22, other: 60 }

type V = [number, number, number]
type Tri = [V, V, V]

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V): V => {
  const l = Math.hypot(...a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** A closed prism: an outline in the x/z plane (counter-clockwise from above), from y0 to y1. */
const prism = (outline: [number, number][], y0: number, y1: number): Tri[] => {
  const tris: Tri[] = []
  const n = outline.length
  const cx = outline.reduce((s, p) => s + p[0], 0) / n
  const cz = outline.reduce((s, p) => s + p[1], 0) / n
  for (let i = 0; i < n; i++) {
    const [ax, az] = outline[i]!
    const [bx, bz] = outline[(i + 1) % n]!
    // Side wall.
    tris.push([[ax, y0, az], [bx, y0, bz], [bx, y1, bz]], [[ax, y0, az], [bx, y1, bz], [ax, y1, az]])
    // Top and bottom caps (a fan: the outlines are convex).
    tris.push([[cx, y1, cz], [ax, y1, az], [bx, y1, bz]], [[cx, y0, cz], [bx, y0, bz], [ax, y0, az]])
  }
  return tris
}

const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
  prism(
    [
      [x0, z0],
      [x0, z1],
      [x1, z1],
      [x1, z0],
    ],
    y0,
    y1,
  )

interface Part {
  tris: Tri[]
  color: [number, number, number]
  metal?: number
}

/** The parts of each kind of ship (bow at +z, beam along x). */
const partsFor = (kind: ShipKind): Part[] => {
  const beam = kind === 'small' ? 0.13 : kind === 'passenger' ? 0.085 : 0.075
  // The hull, seen from above: a square stern, straight sides, a pointed bow.
  const hull: [number, number][] = [
    [-beam * 0.85, -0.5],
    [beam * 0.85, -0.5],
    [beam, -0.3],
    [beam, 0.3],
    [beam * 0.55, 0.44],
    [0, 0.5],
    [-beam * 0.55, 0.44],
    [-beam, 0.3],
    [-beam, -0.3],
  ]
  const deckY = kind === 'small' ? 0.09 : 0.06
  const hullColor: Record<ShipKind, [number, number, number]> = { cargo: [0.55, 0.1, 0.1], tanker: [0.12, 0.16, 0.22], passenger: [0.92, 0.93, 0.95], small: [0.85, 0.85, 0.82], other: [0.2, 0.28, 0.4] }
  const parts: Part[] = [
    { tris: prism(hull, -0.035, deckY), color: hullColor[kind] },
    // The deck, a hair above the hull top.
    { tris: prism(hull.map(([x, z]) => [x * 0.94, z * 0.97]), deckY, deckY + 0.004), color: kind === 'passenger' ? [0.55, 0.42, 0.3] : [0.32, 0.34, 0.33] },
  ]
  const white: [number, number, number] = [0.93, 0.94, 0.95]
  if (kind === 'passenger') {
    // Long white decks stepping up, and a funnel.
    parts.push({ tris: [...box(-beam * 0.9, beam * 0.9, deckY, deckY + 0.06, -0.42, 0.3), ...box(-beam * 0.8, beam * 0.8, deckY + 0.06, deckY + 0.1, -0.36, 0.22), ...box(-beam * 0.6, beam * 0.6, deckY + 0.1, deckY + 0.13, -0.25, 0.12)], color: white })
    parts.push({ tris: box(-0.025, 0.025, deckY + 0.13, deckY + 0.19, -0.22, -0.15), color: [0.75, 0.12, 0.12] })
  } else {
    const aft = kind === 'small' ? -0.1 : -0.42
    const fore = kind === 'small' ? 0.12 : -0.3
    const tall = kind === 'small' ? 0.07 : 0.11
    // The bridge (aft on big ships, midships on small boats) and a funnel behind it.
    parts.push({ tris: [...box(-beam * 0.85, beam * 0.85, deckY, deckY + tall, aft, fore), ...box(-beam * 1.1, beam * 1.1, deckY + tall * 0.82, deckY + tall * 0.92, fore - 0.035, fore)], color: white })
    if (kind !== 'small') parts.push({ tris: box(-0.018, 0.018, deckY + tall, deckY + tall + 0.06, aft + 0.01, aft + 0.06), color: [0.15, 0.15, 0.17] })
  }
  if (kind === 'cargo') {
    // Container stacks in four colours.
    const colors: [number, number, number][] = [
      [0.8, 0.25, 0.15],
      [0.15, 0.35, 0.7],
      [0.2, 0.55, 0.3],
      [0.85, 0.6, 0.15],
    ]
    for (let k = 0; k < 8; k++) {
      const z0 = -0.27 + k * 0.075
      const h = 0.03 + ((k * 7) % 3) * 0.012
      parts.push({ tris: box(-beam * 0.82, beam * 0.82, deckY, deckY + h, z0, z0 + 0.065), color: colors[k % 4]! })
    }
  } else if (kind === 'tanker') {
    // A pipe run down the middle and the manifold.
    parts.push({ tris: [...box(-0.006, 0.006, deckY, deckY + 0.012, -0.28, 0.4), ...box(-beam * 0.7, beam * 0.7, deckY, deckY + 0.015, 0.02, 0.05)], color: [0.6, 0.62, 0.6], metal: 0.6 })
  } else if (kind === 'other') {
    parts.push({ tris: box(-beam * 0.6, beam * 0.6, deckY, deckY + 0.025, -0.2, 0.25), color: [0.45, 0.47, 0.5] })
  }
  return parts
}

const b64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

const cache = new Map<ShipKind, object>()

/** The glTF for a kind of ship (cached): one mesh, one primitive per coloured part. */
export const shipGltf = (kind: ShipKind): object => {
  const hit = cache.get(kind)
  if (hit) return hit
  const parts = partsFor(kind)
  const floats: number[] = []
  const views: { byteOffset: number; byteLength: number }[] = []
  const accessors: object[] = []
  const primitives: object[] = []
  const materials: object[] = []
  parts.forEach((p, i) => {
    const pos: number[] = []
    const nrm: number[] = []
    const min: V = [Infinity, Infinity, Infinity]
    const max: V = [-Infinity, -Infinity, -Infinity]
    for (const t of p.tris) {
      const n = norm(cross(sub(t[1], t[0]), sub(t[2], t[0])))
      for (const v of t) {
        pos.push(...v)
        nrm.push(...n)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, v[k]!)
          max[k] = Math.max(max[k]!, v[k]!)
        }
      }
    }
    const count = pos.length / 3
    const offPos = floats.length * 4
    floats.push(...pos)
    const offNrm = floats.length * 4
    floats.push(...nrm)
    views.push({ byteOffset: offPos, byteLength: pos.length * 4 }, { byteOffset: offNrm, byteLength: nrm.length * 4 })
    accessors.push({ bufferView: i * 2, componentType: 5126, count, type: 'VEC3', min, max }, { bufferView: i * 2 + 1, componentType: 5126, count, type: 'VEC3' })
    materials.push({ pbrMetallicRoughness: { baseColorFactor: [...p.color, 1], metallicFactor: p.metal ?? 0.1, roughnessFactor: 0.7 }, doubleSided: true })
    primitives.push({ attributes: { POSITION: i * 2, NORMAL: i * 2 + 1 }, material: i, mode: 4 })
  })
  const bin = new Uint8Array(new Float32Array(floats).buffer)
  const gltf = {
    asset: { version: '2.0', generator: 'Atlas ship3d' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials,
    accessors,
    bufferViews: views.map(v => ({ buffer: 0, ...v, target: 34962 })),
    buffers: [{ byteLength: bin.byteLength, uri: `data:application/octet-stream;base64,${b64(bin)}` }],
  }
  cache.set(kind, gltf)
  return gltf
}
