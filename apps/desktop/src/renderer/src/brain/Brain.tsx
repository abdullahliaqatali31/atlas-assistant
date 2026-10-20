/**
 * The living brain: Atlas's real memories as glowing points in a slowly
 * turning brain, coloured by kind, joined by strings that shimmer with
 * travelling sparks. Memories in use flare and their strings blaze; a
 * memory just saved is born with a ring. Drag to turn, scroll to zoom, hover
 * for a card, click to pin it. Canvas 2D with its own 3D projection and
 * additive glow; it stops drawing when hidden or off screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import { BRAIN_KIND_COLOR, BRAIN_KIND_LABEL, BRAIN_KINDS, brainLabel, type BrainKind, type BrainNode, type BrainView } from '../../../shared/brain.ts'
const isLite = () => document.documentElement.dataset.lite === 'true'
import { cortexDust, gyri, homeOf, lobeLabelAt, mesh, relax, YOU, type P3 } from './layout.ts'

export type BrainMood = 'idle' | 'listening' | 'thinking' | 'speaking' | 'offline' | 'paused'

const ACTIVE_MS = 12_000
/** Seconds an impulse takes to cross one synapse. */
const HOP = 0.055

/** A repeatable random number from a seed (for lightning that flickers, not crawls). */
const jit = (seed: number) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

/** A jagged bolt between two points: re-struck with a new seed many times a second. */
const bolt = (ax: number, ay: number, bx: number, by: number, seed: number, amp: number) => {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const n = Math.max(4, Math.min(12, Math.round(len / 16)))
  const pts: [number, number][] = [[ax, ay]]
  for (let i = 1; i < n; i++) {
    const f = i / n
    const off = (jit(seed + i * 7.13) - 0.5) * 2 * amp * Math.sin(Math.PI * f)
    pts.push([ax + dx * f + nx * off, ay + dy * f + ny * off])
  }
  pts.push([bx, by])
  return pts
}
const MAX_LINKS = 1800

/** Pre-drawn soft glows, one per colour. */
const sprites = new Map<string, HTMLCanvasElement>()
const glow = (color: string) => {
  let c = sprites.get(color)
  if (c) return c
  c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, color)
  grad.addColorStop(0.22, `${color}aa`)
  grad.addColorStop(0.55, `${color}22`)
  grad.addColorStop(1, `${color}00`)
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  sprites.set(color, c)
  return c
}

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`
}

export interface BrainProps {
  view: BrainView | null
  /** When each memory last lit up (a turn used it). */
  used: ReadonlyMap<string, number>
  /** When each memory was just saved. */
  born: ReadonlyMap<string, number>
  mood: BrainMood
  /** Show one kind; the rest dim. */
  focus: BrainKind | null
  picked: string | null
  onPick: (n: BrainNode | null) => void
}

export function Brain(props: BrainProps) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const live = useRef(props)
  live.current = props
  const [hover, setHover] = useState<{ node: BrainNode; x: number; y: number } | null>(null)
  const hoverId = useRef<string | null>(null)

  // Where everything sits: once per change of memories or links.
  const scene = useMemo(() => {
    const nodes = props.view?.nodes ?? []
    const links = (props.view?.links ?? []).slice(0, MAX_LINKS)
    const kinds = new Map(nodes.map(n => [n.id, n.kind]))
    const pos = new Map<string, P3>(nodes.map(n => [n.id, homeOf(n.id, n.kind)]))
    relax(pos, links, kinds)
    // You are joined to what you told Atlas about yourself (likes and facts, most used first).
    const yours = nodes
      .filter(n => (n.kind === 'preference' || n.kind === 'fact') && n.origin !== 'learned')
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 28)
      .map(n => n.id)
    const lite = isLite()
    const dust = cortexDust(lite ? 600 : 1500)
    const synapses = mesh(dust)
    const adj: number[][] = dust.map(() => [])
    for (const [i, j] of synapses) {
      adj[i]!.push(j)
      adj[j]!.push(i)
    }
    // Each memory's nearest speck of cortex: where its impulses start.
    const nearDust = new Map<string, number>()
    for (const n of nodes) {
      const q = pos.get(n.id)!
      let best = 0
      let bd = Infinity
      for (let i = 0; i < dust.length; i++) {
        const d = dust[i]!
        const dd = (d.x - q.x) ** 2 + (d.y - q.y) ** 2 + (d.z - q.z) ** 2
        if (dd < bd) (bd = dd), (best = i)
      }
      nearDust.set(n.id, best)
    }
    return {
      adj,
      nearDust,
      nodes,
      byId: new Map(nodes.map(n => [n.id, n])),
      pos,
      links: links.map((l, i) => ({ ...l, phase: (i * 0.6180339) % 1 })),
      yours,
      dust,
      synapses,
      folds: gyri(lite ? 24 : 46),
    }
  }, [props.view])
  const sceneRef = useRef(scene)
  sceneRef.current = scene

  useEffect(() => {
    const el = canvas.current
    const box = host.current
    if (!el || !box) return
    const ctx = el.getContext('2d')!
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || isLite()
    let w = 0
    let h = 0
    let dpr = 1
    const resize = () => {
      dpr = Math.min(1.75, devicePixelRatio || 1)
      w = box.clientWidth
      h = box.clientHeight
      el.width = Math.max(1, Math.round(w * dpr))
      el.height = Math.max(1, Math.round(h * dpr))
      el.style.width = `${w}px`
      el.style.height = `${h}px`
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(box)

    // The camera: turned a little, tilted, turning slowly by itself unless held.
    const cam = { yaw: 0.7, pitch: -0.32, zoom: 1, spin: reduced ? 0 : 0.055 }
    let held = false
    let lastTouch = 0
    let drag: { x: number; y: number; yaw: number; pitch: number } | null = null
    let pointer: { x: number; y: number } | null = null

    // Projected points of this frame, for hit testing.
    let shown: { id: string; x: number; y: number; r: number }[] = []
    // Impulses running through the cortex: each crosses one synapse, then its trace fades.
    const fires: { i: number; j: number; at: number; hot: boolean }[] = []
    let nextFire = 0
    const seenUse = new Map<string, number>()
    const cascade = (start: number, at: number, depth: number, hot: boolean) => {
      const adj = sceneRef.current.adj
      let front = [start]
      const seen = new Set(front)
      for (let d = 0; d < depth && front.length; d++) {
        const next: number[] = []
        for (const i of front) {
          const ns = adj[i] ?? []
          const off = Math.floor(Math.random() * (ns.length || 1))
          for (let k = 0; k < ns.length && k < (hot ? 3 : 2); k++) {
            const j = ns[(k + off) % ns.length]!
            if (seen.has(j)) continue
            seen.add(j)
            next.push(j)
            fires.push({ i, j, at: at + d * HOP * (0.8 + Math.random() * 0.5), hot })
          }
        }
        front = next.slice(0, hot ? 10 : 4)
      }
      if (fires.length > 1200) fires.splice(0, fires.length - 1200)
    }
    let px = new Float32Array(0)

    const project = (p: P3, S: number, cx: number, cy: number) => {
      const cy1 = Math.cos(cam.yaw)
      const sy1 = Math.sin(cam.yaw)
      const x1 = p.x * cy1 + p.z * sy1
      const z1 = -p.x * sy1 + p.z * cy1
      const cp = Math.cos(cam.pitch)
      const sp = Math.sin(cam.pitch)
      const y2 = p.y * cp - z1 * sp
      const z2 = p.y * sp + z1 * cp
      const k = 3.4 / (3.4 - z2)
      return { x: cx + x1 * k * S, y: cy - y2 * k * S, z: z2, k }
    }

    let raf = 0
    let running = false
    let last = performance.now()
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const p = live.current
      const s = sceneRef.current
      const t = now / 1000
      if (!held && now - lastTouch > 3000) cam.yaw += cam.spin * dt * (hoverId.current ? 0.25 : 1)
      const S = Math.min(w * 0.34, h * 0.38) * cam.zoom
      const cx = w / 2
      const cy = h / 2 + h * 0.02
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'
      const wall = Date.now()
      const moodPulse = p.mood === 'speaking' ? 0.5 + 0.5 * Math.sin(t * 6) : p.mood === 'thinking' ? 0.5 + 0.5 * Math.sin(t * 3.2) : p.mood === 'listening' ? 0.6 : 0.3 + 0.2 * Math.sin(t * 0.8)
      const dim = p.mood === 'offline' || p.mood === 'paused' ? 0.45 : 1
      const depthA = (z: number) => Math.max(0.12, Math.min(1, 0.45 + z * 0.42))

      // An aura behind it all, breathing with Atlas's mood.
      {
        const r = Math.min(w, h) * (0.62 + 0.04 * moodPulse) * cam.zoom
        ctx.globalAlpha = (0.1 + 0.08 * moodPulse) * dim
        ctx.drawImage(glow(p.mood === 'listening' ? '#fbbf24' : p.mood === 'thinking' ? '#a78bfa' : '#38bdf8'), cx - r, cy - r, r * 2, r * 2)
        ctx.globalAlpha = 1
      }

      // The cortex: dust, the mesh between it, and folds.
      if (px.length !== s.dust.length * 3) px = new Float32Array(s.dust.length * 3)
      for (let i = 0; i < s.dust.length; i++) {
        const d = s.dust[i]!
        const q = project(d, S, cx, cy)
        px[i * 3] = q.x
        px[i * 3 + 1] = q.y
        px[i * 3 + 2] = q.z
        const tw = 0.6 + 0.4 * Math.sin(t * (0.6 + d.s) + d.s * 40)
        ctx.fillStyle = `rgba(125,211,252,${(0.18 + 0.42 * depthA(q.z) * tw * dim).toFixed(3)})`
        const sz = 1 + q.k * 0.8
        ctx.fillRect(q.x, q.y, sz, sz)
      }
      // Synapses in three depth bands, one path each.
      ctx.lineWidth = 0.6
      for (const [lo, hi, a] of [[-9, -0.25, 0.12], [-0.25, 0.3, 0.22], [0.3, 9, 0.34]] as const) {
        ctx.beginPath()
        for (const [i, j] of s.synapses) {
          const z = (px[i * 3 + 2]! + px[j * 3 + 2]!) / 2
          if (z < lo || z >= hi) continue
          ctx.moveTo(px[i * 3]!, px[i * 3 + 1]!)
          ctx.lineTo(px[j * 3]!, px[j * 3 + 1]!)
        }
        ctx.strokeStyle = `rgba(56,189,248,${(a * dim * (0.85 + 0.3 * moodPulse)).toFixed(3)})`
        ctx.stroke()
      }

      // Neurons firing: cascades start on their own (more while Atlas thinks or talks),
      // and from every memory that a turn just used.
      if (!reduced && s.dust.length) {
        const rate = p.mood === 'thinking' ? 7 : p.mood === 'speaking' ? 5 : p.mood === 'listening' ? 3.5 : p.mood === 'offline' || p.mood === 'paused' ? 0.3 : 1.6
        if (t > nextFire) {
          cascade(Math.floor(Math.random() * s.dust.length), t, 4 + Math.floor(Math.random() * 5), false)
          nextFire = t + (0.4 + Math.random()) / rate
        }
      }
      for (const [id, at] of p.used) {
        if (seenUse.get(id) === at) continue
        seenUse.set(id, at)
        const from = s.nearDust.get(id)
        if (from !== undefined && wall - at < 4000) for (let k = 0; k < 3; k++) cascade(from, t + k * 0.18, 9, true)
      }
      ctx.lineCap = 'round'
      let kept = 0
      for (let n = 0; n < fires.length; n++) {
        const f = fires[n]!
        const age = t - f.at
        const life = f.hot ? 0.9 : 0.5
        if (age > HOP + life) continue
        fires[kept++] = f
        if (age < 0) continue
        const x1 = px[f.i * 3]!
        const y1 = px[f.i * 3 + 1]!
        const x2 = px[f.j * 3]!
        const y2 = px[f.j * 3 + 1]!
        const head = Math.min(1, age / HOP)
        const fade = age < HOP ? 1 : Math.exp(-(age - HOP) / (life * 0.35))
        const a = fade * depthA((px[f.i * 3 + 2]! + px[f.j * 3 + 2]!) / 2) * dim
        const hx = x1 + (x2 - x1) * head
        const hy = y1 + (y2 - y1) * head
        ctx.strokeStyle = f.hot ? `rgba(240,249,255,${a.toFixed(3)})` : `rgba(125,211,252,${(0.8 * a).toFixed(3)})`
        ctx.lineWidth = f.hot ? 1.5 : 0.9
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(hx, hy)
        ctx.stroke()
        if (age < HOP + 0.06) {
          const g = f.hot ? 12 : 7
          ctx.globalAlpha = a
          ctx.drawImage(glow(f.hot ? '#f0f9ff' : '#7dd3fc'), hx - g / 2, hy - g / 2, g, g)
          ctx.globalAlpha = 1
        }
      }
      fires.length = kept
      ctx.lineWidth = 1.3
      for (const line of s.folds) {
        ctx.beginPath()
        let front = 0
        line.forEach((pt, i) => {
          const q = project(pt, S, cx, cy)
          front += q.z
          if (i) ctx.lineTo(q.x, q.y)
          else ctx.moveTo(q.x, q.y)
        })
        ctx.strokeStyle = `rgba(125,211,252,${(0.16 + 0.24 * depthA(front / line.length) * dim).toFixed(3)})`
        ctx.stroke()
      }

      const active = (id: string) => {
        const at = p.used.get(id)
        return at !== undefined && wall - at < ACTIVE_MS
      }
      const proj = new Map<string, ReturnType<typeof project>>()
      for (const n of s.nodes) proj.set(n.id, project(s.pos.get(n.id)!, S, cx, cy))
      const you = project(YOU, S, cx, cy)
      const faded = (n: BrainNode | undefined) => (p.focus && n && n.kind !== p.focus ? 0.15 : 1)

      // Strings: you to your own memories, and memory to memory.
      for (const id of s.yours) {
        const q = proj.get(id)
        if (!q) continue
        ctx.strokeStyle = `rgba(226,232,240,${(0.05 * depthA(q.z) * dim * faded(s.byId.get(id))).toFixed(3)})`
        ctx.beginPath()
        ctx.moveTo(you.x, you.y)
        ctx.lineTo(q.x, q.y)
        ctx.stroke()
      }
      for (const l of s.links) {
        const flip = l.phase > 0.5
        const a = proj.get(flip ? l.b : l.a)
        const b = proj.get(flip ? l.a : l.b)
        if (!a || !b) continue
        const na = s.byId.get(l.a)!
        const nb = s.byId.get(l.b)
        const hot = active(l.a) || active(l.b)
        const color = BRAIN_KIND_COLOR[na.kind]
        const depth = depthA((a.z + b.z) / 2)
        const fade = dim * Math.min(faded(na), faded(nb))
        // The axon itself.
        ctx.strokeStyle = rgba(color, (hot ? 0.35 : 0.1 + 0.14 * Math.min(1, l.weight / 4)) * depth * fade)
        ctx.lineWidth = 0.8
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
        // In use: lightning, struck again and again.
        if (hot) {
          const pts = bolt(a.x, a.y, b.x, b.y, Math.floor(t * 16) + l.phase * 977, 7 * Math.min(1.4, (a.k + b.k) / 2))
          for (const [width, style] of [
            [4.5, rgba(color, 0.3 * depth * fade)],
            [1.3, rgba('#f8fafc', 0.95 * depth * fade)],
          ] as const) {
            ctx.lineWidth = width
            ctx.strokeStyle = style
            ctx.beginPath()
            pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
            ctx.stroke()
          }
        }
        if (reduced && !hot) continue
        // An impulse runs the axon now and then: a bright head with a fading tail.
        const period = hot ? 0.45 : (p.mood === 'thinking' ? 1.4 : p.mood === 'speaking' ? 2 : 4.2) / (0.7 + 0.3 * Math.min(3, l.weight))
        const ph = ((t + l.phase * 31) / period) % 1
        const span = hot ? 1 : 0.3
        if (ph < span) {
          const f = ph / span
          const tail = Math.max(0, f - 0.25)
          const hx = a.x + (b.x - a.x) * f
          const hy = a.y + (b.y - a.y) * f
          const tx = a.x + (b.x - a.x) * tail
          const ty = a.y + (b.y - a.y) * tail
          const grad = ctx.createLinearGradient(tx, ty, hx, hy)
          grad.addColorStop(0, rgba(color, 0))
          grad.addColorStop(0.7, rgba(color, 0.6 * depth * fade))
          grad.addColorStop(1, rgba('#f0f9ff', 0.95 * depth * fade))
          ctx.strokeStyle = grad
          ctx.lineWidth = hot ? 2.4 : 1.6
          ctx.beginPath()
          ctx.moveTo(tx, ty)
          ctx.lineTo(hx, hy)
          ctx.stroke()
          const g = (hot ? 12 : 7) * Math.min(1.3, (a.k + b.k) / 2)
          ctx.globalAlpha = depth * fade
          ctx.drawImage(glow('#f0f9ff'), hx - g / 2, hy - g / 2, g, g)
          ctx.globalAlpha = 1
        }
      }

      // You, in the middle: breathing with Atlas's mood.
      {
        const r = (16 + 10 * moodPulse) * you.k
        ctx.globalAlpha = 0.5 * dim
        ctx.drawImage(glow('#e2e8f0'), you.x - r * 2, you.y - r * 2, r * 4, r * 4)
        ctx.globalAlpha = 1
      }

      // Memories, far to near.
      const order = s.nodes.map(n => ({ n, q: proj.get(n.id)! })).sort((a, b) => a.q.z - b.q.z)
      shown = []
      for (const { n, q } of order) {
        const color = BRAIN_KIND_COLOR[n.kind]
        const a = depthA(q.z) * dim * faded(n)
        const usedAt = p.used.get(n.id)
        const flare = usedAt !== undefined ? Math.exp(-(wall - usedAt) / 2600) : 0
        const bornAt = p.born.get(n.id)
        const birth = bornAt !== undefined ? Math.min(1, (wall - bornAt) / 1200) : 1
        const base = (2.4 + 0.9 * Math.sqrt(n.degree) + 0.8 * Math.log2(1 + n.uses)) * q.k * Math.sqrt(cam.zoom) * birth
        const r = base * (1 + 0.6 * flare)
        ctx.globalAlpha = Math.min(1, (0.38 + 0.6 * flare) * a)
        const g = r * (4.5 + 9 * flare)
        ctx.drawImage(glow(color), q.x - g / 2, q.y - g / 2, g, g)
        ctx.globalAlpha = Math.min(1, a * (0.85 + 0.15 * moodPulse))
        ctx.fillStyle = flare > 0.2 ? '#ffffff' : color
        ctx.beginPath()
        ctx.arc(q.x, q.y, Math.max(0.8, r * 0.55), 0, Math.PI * 2)
        ctx.fill()
        if (flare > 0.02 || birth < 1) {
          const ring = birth < 1 ? birth : 1 - flare
          ctx.strokeStyle = rgba(birth < 1 ? '#ffffff' : color, (birth < 1 ? 1 - birth : flare) * 0.9)
          ctx.lineWidth = 1.4
          ctx.beginPath()
          ctx.arc(q.x, q.y, r * (1.2 + ring * 5), 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.globalAlpha = 1
        shown.push({ id: n.id, x: q.x, y: q.y, r: Math.max(5, r) })
      }

      // Words over the light: the lobes, you, and what is lit up right now.
      ctx.globalCompositeOperation = 'source-over'
      ctx.textAlign = 'center'
      ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace'
      for (const kind of BRAIN_KINDS) {
        const q = project(lobeLabelAt(kind), S, cx, cy)
        if (q.z < -0.2) continue
        ctx.fillStyle = rgba(BRAIN_KIND_COLOR[kind], (p.focus && p.focus !== kind ? 0.15 : 0.45) * depthA(q.z) * dim)
        ctx.fillText(BRAIN_KIND_LABEL[kind].toUpperCase(), q.x, q.y)
      }
      ctx.font = '600 11px system-ui, sans-serif'
      ctx.fillStyle = `rgba(241,245,249,${(0.75 * dim).toFixed(2)})`
      ctx.fillText(s.nodes.length ? (live.current.view?.owner || 'You') : 'You', you.x, you.y + 26 * you.k)
      // Labels for what is lit, pinned or hovered: nearest first, never on top of each other.
      ctx.font = '500 11px system-ui, sans-serif'
      const boxes: { x: number; y: number; w: number }[] = []
      const rank = (id: string) => (id === hoverId.current ? 3 : id === p.picked ? 2 : 1)
      const labelled = order.filter(({ n }) => active(n.id) || n.id === p.picked || n.id === hoverId.current).sort((a, b) => rank(b.n.id) - rank(a.n.id) || b.q.z - a.q.z)
      for (const { n, q } of labelled) {
        const text = brainLabel(n.text, 38)
        const tw = ctx.measureText(text).width
        if (boxes.some(b => Math.abs(b.x - q.x) < (b.w + tw) / 2 + 4 && Math.abs(b.y - (q.y - 12)) < 14)) continue
        boxes.push({ x: q.x, y: q.y - 12, w: tw })
        ctx.lineWidth = 3
        ctx.strokeStyle = 'rgba(2,6,23,0.85)'
        ctx.strokeText(text, q.x, q.y - 12)
        ctx.fillStyle = '#f1f5f9'
        ctx.fillText(text, q.x, q.y - 12)
      }

      // Hover: the nearest memory under the pointer.
      if (pointer && !drag) {
        let best: (typeof shown)[number] | null = null
        let bestD = Infinity
        for (const sp of shown) {
          const d = Math.hypot(sp.x - pointer.x, sp.y - pointer.y)
          if (d < sp.r + 7 && d < bestD) (best = sp), (bestD = d)
        }
        const id = best?.id ?? null
        if (id !== hoverId.current) {
          hoverId.current = id
          const node = id ? s.byId.get(id) : undefined
          setHover(node && best ? { node, x: best.x, y: best.y } : null)
        }
      }
    }
    const start = () => {
      if (running || document.hidden) return
      running = true
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(raf)
    }
    // Draw only while it can be seen.
    const io = new IntersectionObserver(([e]) => (e?.isIntersecting ? start() : stop()))
    io.observe(box)
    const vis = () => (document.hidden ? stop() : start())
    document.addEventListener('visibilitychange', vis)

    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId)
      const at = local(e)
      drag = { ...at, yaw: cam.yaw, pitch: cam.pitch }
      held = true
    }
    const move = (e: PointerEvent) => {
      pointer = local(e)
      if (!drag) return
      cam.yaw = drag.yaw + (pointer.x - drag.x) * 0.006
      cam.pitch = Math.max(-1.1, Math.min(0.9, drag.pitch + (pointer.y - drag.y) * 0.004))
    }
    const up = (e: PointerEvent) => {
      const at = local(e)
      const moved = drag ? Math.hypot(at.x - drag.x, at.y - drag.y) : 99
      drag = null
      held = false
      lastTouch = performance.now()
      // A click, not a drag: pin what is under the pointer (or nothing).
      if (moved < 4) {
        const id = hoverId.current
        live.current.onPick(id ? (sceneRef.current.byId.get(id) ?? null) : null)
      }
    }
    const leave = () => {
      pointer = null
      hoverId.current = null
      setHover(null)
    }
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      cam.zoom = Math.max(0.6, Math.min(2.4, cam.zoom * (e.deltaY > 0 ? 0.92 : 1.08)))
      lastTouch = performance.now()
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      stop()
      io.disconnect()
      ro.disconnect()
      document.removeEventListener('visibilitychange', vis)
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('wheel', wheel)
    }
  }, [])

  const card = hover && hover.node.id !== props.picked ? hover : null
  return (
    <div ref={host} className="relative h-full w-full select-none">
      <canvas ref={canvas} className="absolute inset-0 cursor-grab active:cursor-grabbing" aria-label="Atlas's memory, as a brain" role="img" />
      {card && (
        <div className="pointer-events-none absolute z-10 w-64 -translate-x-1/2 rounded-xl border border-white/10 bg-slate-950/85 p-2.5 shadow-2xl backdrop-blur" style={{ left: Math.min(Math.max(card.x, 136), (host.current?.clientWidth ?? 400) - 136), top: card.y + 16 }}>
          <MemoryCard node={card.node} />
        </div>
      )}
    </div>
  )
}

const ORIGIN: Record<string, string> = { conversation: 'You told me', learned: 'I noticed', correction: 'You corrected me', cli: 'Added by hand', skill: 'A skill you taught me', owner: 'You told me' }

export function MemoryCard({ node }: { node: BrainNode }) {
  return (
    <>
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider" style={{ color: BRAIN_KIND_COLOR[node.kind] }}>
        <span className="size-1.5 rounded-full" style={{ background: BRAIN_KIND_COLOR[node.kind] }} />
        {BRAIN_KIND_LABEL[node.kind]}
      </p>
      <p className="mt-1 text-[13px] leading-snug text-slate-100">{node.text}</p>
      <p className="mt-1.5 text-[10px] text-slate-400">
        {[ORIGIN[node.origin] ?? node.origin, node.createdAt ? new Date(node.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '', node.uses ? `used ${node.uses}×` : 'not used yet', `${node.degree} connection${node.degree === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
      </p>
    </>
  )
}
