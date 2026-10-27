/**
 * Where everything sits in the brain view, in brain space (about -1.3..1.3 on
 * each axis; x left/right, y up, z front). Two hemispheres (ellipsoids with a
 * groove between them); each kind of memory has its lobe: likes in front,
 * facts on top, lessons at the back, observations at the temples, hunches
 * low behind (the cerebellum), skills in the core. A memory always lands in
 * the same place (seeded by its id), near the cortex; linked memories drift a
 * little toward each other. Dust and folds draw the brain's own surface.
 */
import type { BrainKind } from '../../../shared/brain.ts'

export interface P3 {
  x: number
  y: number
  z: number
}

const CX = 0.42
const R = { x: 0.52, y: 0.82, z: 1.18 }

/** The cerebellum (low at the back) and the brainstem, for the silhouette. */
const CEREBELLUM = { y: -0.6, z: -0.86, cx: 0.27, r: { x: 0.33, y: 0.24, z: 0.3 } }

/**
 * A point on the cortex for a direction from a hemisphere's centre: an
 * ellipsoid shaped toward a brain (flatter underneath, narrower in front,
 * a temporal lobe bulging low at the side), with a little wrinkle.
 */
const cortexAt = (side: number, d: P3, wrinkle = 1): P3 => {
  const out = Math.max(0, d.x * side)
  const temporal = Math.exp(-((d.y + 0.42) ** 2 + (d.z - 0.2) ** 2) / 0.07) * out
  const narrow = 1 - 0.14 * Math.max(0, d.z) ** 2 - 0.08 * Math.max(0, -d.z) ** 3
  const y = d.y < 0 ? d.y * (0.78 + 0.1 * Math.max(0, d.z)) : d.y * (1 - 0.06 * d.z * d.z)
  return {
    x: side * CX + (d.x * narrow * R.x + side * 0.07 * temporal) * wrinkle,
    y: (y * R.y - 0.07 * temporal) * wrinkle,
    z: d.z * R.z * wrinkle,
  }
}

/** Each kind's lobe, as a direction from a hemisphere's centre. */
const LOBE: Record<BrainKind, P3> = {
  preference: { x: 0.15, y: 0.35, z: 0.85 },
  fact: { x: 0.25, y: 0.9, z: 0.05 },
  lesson: { x: 0.15, y: 0.3, z: -0.9 },
  observation: { x: 0.9, y: -0.25, z: 0.2 },
  hypothesis: { x: 0.35, y: -0.75, z: -0.6 },
  skill: { x: 0.2, y: -0.1, z: 0 },
}

/** A small seeded random generator (mulberry32). */
export const rng = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

const norm = (p: P3) => {
  const l = Math.hypot(p.x, p.y, p.z) || 1
  return { x: p.x / l, y: p.y / l, z: p.z / l }
}

/** How far out a point is in its hemisphere (1 = on the surface). */
export const shellRadius = (p: P3) => {
  const cx = p.x >= 0 ? CX : -CX
  return Math.hypot((p.x - cx) / R.x, p.y / R.y, p.z / R.z)
}

/** The point moved (from its hemisphere centre) to a given shell radius. */
const toShell = (p: P3, r: number): P3 => {
  const cx = p.x >= 0 ? CX : -CX
  const cur = shellRadius(p) || 1e-6
  const k = r / cur
  return { x: cx + (p.x - cx) * k, y: p.y * k, z: p.z * k }
}

/** A memory's home: its lobe, its hemisphere, a little scatter; cortex for memories, core for skills. */
export const homeOf = (id: string, kind: BrainKind): P3 => {
  const r = rng(hash(id))
  const side = r() < 0.5 ? -1 : 1
  const lobe = norm(LOBE[kind])
  const g = () => (r() + r() + r() - 1.5) * 0.55
  const dir = norm({ x: lobe.x * side + g() * 0.6, y: lobe.y + g(), z: lobe.z + g() })
  const cx = side * CX
  const base = { x: cx + dir.x * R.x, y: dir.y * R.y, z: dir.z * R.z }
  const depth = kind === 'skill' ? 0.18 + r() * 0.3 : 0.66 + r() * 0.26
  const p = toShell(base, depth)
  // Keep each memory in its own hemisphere, out of the groove.
  return { ...p, x: side > 0 ? Math.max(0.08, p.x) : Math.min(-0.08, p.x) }
}

/** Linked memories drift toward each other but keep a little room apart, and everything stays inside the brain. */
export const relax = (pos: Map<string, P3>, links: readonly { a: string; b: string; weight: number }[], kinds: ReadonlyMap<string, BrainKind>, rounds = 30, room = 0.3) => {
  const all = [...pos.values()]
  for (let k = 0; k < rounds; k++) {
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!
        const b = all[j]!
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dz = b.z - a.z
        const d = Math.hypot(dx, dy, dz) || 1e-4
        if (d >= room) continue
        const push = ((room - d) / d) * 0.25
        a.x -= dx * push
        a.y -= dy * push
        a.z -= dz * push
        b.x += dx * push
        b.y += dy * push
        b.z += dz * push
      }
    for (const l of links) {
      const a = pos.get(l.a)
      const b = pos.get(l.b)
      if (!a || !b) continue
      const pull = Math.min(0.02, 0.005 * l.weight)
      const dx = (b.x - a.x) * pull
      const dy = (b.y - a.y) * pull
      const dz = (b.z - a.z) * pull
      a.x += dx
      a.y += dy
      a.z += dz
      b.x -= dx
      b.y -= dy
      b.z -= dz
    }
    for (const [id, p] of pos) {
      const core = kinds.get(id) === 'skill'
      const r = shellRadius(p)
      const fixed = core ? (r > 0.5 ? toShell(p, 0.5) : p) : r > 0.95 ? toShell(p, 0.95) : r < 0.6 ? toShell(p, 0.6) : p
      p.x = fixed.x
      p.y = fixed.y
      p.z = fixed.z
    }
  }
  return pos
}

/** Dust on the cortex: the brain's silhouette even before it knows much. */
export const cortexDust = (n = 1400, seed = 7): (P3 & { s: number })[] => {
  const r = rng(seed)
  const out: (P3 & { s: number })[] = []
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1
    // A uniform direction, then onto the hemisphere's surface, a little wrinkled.
    const u = r() * 2 - 1
    const t = r() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const d = { x: s * Math.cos(t), y: u, z: s * Math.sin(t) }
    // Not inside the groove between the hemispheres.
    if (d.x * side < -0.55) continue
    const wrinkle = 0.97 + 0.04 * Math.sin(d.y * 19 + d.z * 13) * Math.cos(d.z * 17 - d.x * 11)
    // Leave the back of the underside to the cerebellum.
    if (d.y < -0.55 && d.z < -0.35) continue
    out.push({ ...cortexAt(side, d, wrinkle), s: r() })
  }
  // The cerebellum: two small lobes, finely striped.
  for (let i = 0; i < n * 0.16; i++) {
    const side = i % 2 ? 1 : -1
    const u = r() * 2 - 1
    const t = r() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const stripe = 0.96 + 0.05 * Math.sin(u * 40)
    const C = CEREBELLUM
    out.push({ x: side * C.cx + s * Math.cos(t) * C.r.x * stripe, y: C.y + u * C.r.y * stripe, z: C.z + s * Math.sin(t) * C.r.z * stripe, s: r() })
  }
  // The brainstem.
  for (let i = 0; i < n * 0.05; i++) {
    const f = r()
    const a = r() * Math.PI * 2
    const rad = 0.12 - 0.03 * f
    out.push({ x: Math.cos(a) * rad, y: -0.42 - f * 0.62, z: -0.3 - f * 0.18 + Math.sin(a) * rad, s: r() })
  }
  return out
}

/** The neural mesh: pairs of nearby cortex specks (each to its two nearest), drawn as faint synapses. */
export const mesh = (pts: readonly P3[], k = 2, max = 0.16): [number, number][] => {
  const out: [number, number][] = []
  const seen = new Set<number>()
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!
    const near: { j: number; d: number }[] = []
    for (let j = 0; j < pts.length; j++) {
      if (j === i) continue
      const b = pts[j]!
      const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2
      if (d > max * max) continue
      near.push({ j, d })
    }
    near.sort((x, y) => x.d - y.d)
    for (const { j } of near.slice(0, k)) {
      const key = i < j ? i * 100_000 + j : j * 100_000 + i
      if (seen.has(key)) continue
      seen.add(key)
      out.push([i, j])
    }
  }
  return out
}

/** Folds (gyri): wandering curves on the surface. */
export const gyri = (count = 44, steps = 22, seed = 11): P3[][] => {
  const r = rng(seed)
  const lines: P3[][] = []
  for (let c = 0; c < count; c++) {
    const side = c % 2 ? 1 : -1
    let th = r() * Math.PI * 2
    let ph = Math.acos(r() * 1.6 - 0.8)
    let dth = (r() - 0.5) * 0.25
    let dph = (r() - 0.5) * 0.18
    const line: P3[] = []
    for (let i = 0; i < steps; i++) {
      const d = { x: Math.sin(ph) * Math.cos(th), y: Math.cos(ph), z: Math.sin(ph) * Math.sin(th) }
      if (d.x * side < -0.5) break
      if (d.y < -0.55 && d.z < -0.35) break
      line.push(cortexAt(side, d, 0.985))
      dth += (r() - 0.5) * 0.12
      dph += (r() - 0.5) * 0.1
      th += dth
      ph = Math.min(Math.PI - 0.15, Math.max(0.15, ph + dph))
    }
    if (line.length > 4) lines.push(line)
  }
  // The longitudinal fissure's rims, and the cerebellum's folia.
  for (const side of [-1, 1]) {
    const rim: P3[] = []
    for (let i = 0; i <= 28; i++) {
      const a = -0.15 + (i / 28) * (Math.PI + 0.1)
      rim.push(cortexAt(side, { x: -side * 0.42, y: Math.sin(a) * 0.9, z: Math.cos(a) * 0.9 }, 0.99))
    }
    lines.push(rim)
    const C = CEREBELLUM
    for (let k = 1; k < 6; k++) {
      const u = -0.8 + k * 0.3
      const s = Math.sqrt(1 - u * u)
      const arc: P3[] = []
      for (let i = 0; i <= 16; i++) {
        const t = Math.PI * (0.55 + (i / 16) * 0.9) + (side > 0 ? Math.PI * 0.55 : 0)
        arc.push({ x: side * C.cx + s * Math.cos(t) * C.r.x, y: C.y + u * C.r.y, z: C.z + s * Math.sin(t) * C.r.z })
      }
      lines.push(arc)
    }
  }
  return lines
}

/** Where to write each lobe's name. */
export const lobeLabelAt = (kind: BrainKind): P3 => {
  const l = norm(LOBE[kind])
  return kind === 'skill' ? { x: 0, y: -0.05, z: 0 } : { x: CX * 0.4 + l.x * R.x * 0.2, y: l.y * R.y * 1.08, z: l.z * R.z * 1.08 }
}

/** You: the centre of it all. */
export const YOU: P3 = { x: 0, y: -0.2, z: 0.05 }
