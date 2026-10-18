import { useEffect, useRef } from 'react'

export type OrbState = 'offline' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'paused'

interface Look {
  /** Ring rotation speed, radians per second. */
  spin: number
  /** 0–1 glow strength of the core. */
  glow: number
  hue: 'accent' | 'warm' | 'danger' | 'muted'
  wave: boolean
}

const LOOKS: Record<OrbState, Look> = {
  offline: { spin: 0.08, glow: 0.25, hue: 'muted', wave: false },
  paused: { spin: 0.05, glow: 0.35, hue: 'danger', wave: false },
  idle: { spin: 0.25, glow: 0.55, hue: 'accent', wave: false },
  listening: { spin: 0.6, glow: 0.85, hue: 'warm', wave: true },
  thinking: { spin: 1.6, glow: 0.75, hue: 'accent', wave: false },
  speaking: { spin: 0.7, glow: 1, hue: 'accent', wave: true },
}

const cssColor = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

/** Hex or rgb() → "r g b" components for rgba() with custom alpha. */
const rgbOf = (color: string): [number, number, number] => {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return [34, 211, 238]
  ctx.fillStyle = color
  const hex = ctx.fillStyle
  if (hex.startsWith('#')) {
    const n = parseInt(hex.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const m = hex.match(/\d+/g)?.map(Number) ?? [34, 211, 238]
  return [m[0] ?? 34, m[1] ?? 211, m[2] ?? 238]
}

/**
 * The assistant's presence: a canvas orb whose rings, glow and waveform show
 * what it is doing. `level` (0–1) drives the waveform while listening; while
 * speaking a synthetic voice envelope is used. Respects reduced motion and
 * stops drawing while the window is hidden.
 */
export function Orb({ state, level = 0, size = 220 }: { state: OrbState; level?: number; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef(state)
  const levelRef = useRef(level)
  stateRef.current = state
  levelRef.current = level
  // With reduced motion the orb is drawn once per state change instead of animating.
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const redrawKey = reduced ? state : null

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size * dpr
    canvas.height = size * dpr
    ctx.scale(dpr, dpr)

    const palette = {
      accent: rgbOf(cssColor('--accent', '#22d3ee')),
      warm: rgbOf(cssColor('--warm', '#fbbf24')),
      danger: rgbOf(cssColor('--danger', '#fb7185')),
      muted: rgbOf(cssColor('--muted', '#8ea0bd')),
    }
    const particles = Array.from({ length: 36 }, (_, i) => ({ a: (i / 36) * Math.PI * 2, r: 0.62 + Math.random() * 0.3, s: 0.2 + Math.random() * 0.6, z: Math.random() }))

    let raf = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let last = performance.now()
    let angle = 0
    let glow = LOOKS[stateRef.current].glow
    let wave = 0

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const look = LOOKS[stateRef.current]
      // Ease between states instead of snapping.
      glow += (look.glow - glow) * Math.min(1, dt * 4)
      angle += look.spin * dt
      const targetWave = look.wave ? (stateRef.current === 'listening' ? Math.min(1, levelRef.current * 2.2) : 0.35 + 0.35 * Math.abs(Math.sin(now / 160)) * Math.abs(Math.sin(now / 410))) : 0
      wave += (targetWave - wave) * Math.min(1, dt * 10)

      const [r, g, b] = palette[look.hue]
      const c = (a: number) => `rgba(${r},${g},${b},${a})`
      const cx = size / 2
      const cy = size / 2
      const R = size * 0.36
      ctx.clearRect(0, 0, size, size)

      // Halo
      const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.35)
      halo.addColorStop(0, c(0.28 * glow))
      halo.addColorStop(1, c(0))
      ctx.fillStyle = halo
      ctx.fillRect(0, 0, size, size)

      ctx.lineCap = 'round'

      // Outer segmented ring (4 arcs) rotating
      ctx.lineWidth = size * 0.022
      ctx.strokeStyle = c(0.85)
      ctx.shadowColor = c(0.9)
      ctx.shadowBlur = 12 * glow
      for (let i = 0; i < 4; i++) {
        const start = angle + (i * Math.PI) / 2 + 0.22
        ctx.beginPath()
        ctx.arc(cx, cy, R, start, start + Math.PI / 2 - 0.44)
        ctx.stroke()
      }

      // Counter-rotating tick ring
      ctx.shadowBlur = 0
      ctx.lineWidth = 1.5
      ctx.strokeStyle = c(0.45)
      for (let i = 0; i < 60; i++) {
        const a = -angle * 0.6 + (i / 60) * Math.PI * 2
        const inner = R * 0.8
        const outer = R * (i % 5 === 0 ? 0.87 : 0.84)
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
        ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer)
        ctx.stroke()
      }

      // Warm accent arc (attention marker)
      const [wr, wg, wb] = palette.warm
      ctx.strokeStyle = `rgba(${wr},${wg},${wb},0.9)`
      ctx.lineWidth = size * 0.012
      ctx.beginPath()
      ctx.arc(cx, cy, R * 0.92, angle * 1.4 - 0.35, angle * 1.4 + 0.35)
      ctx.stroke()

      // Waveform ring (listening / speaking)
      if (wave > 0.01) {
        ctx.strokeStyle = c(0.9)
        ctx.lineWidth = 2
        ctx.beginPath()
        const base = R * 0.62
        for (let i = 0; i <= 120; i++) {
          const a = (i / 120) * Math.PI * 2
          const noise = Math.sin(a * 6 + now / 120) * 0.5 + Math.sin(a * 11 - now / 90) * 0.3 + Math.sin(a * 17 + now / 70) * 0.2
          const rr = base + noise * R * 0.16 * wave
          const x = cx + Math.cos(a) * rr
          const y = cy + Math.sin(a) * rr
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      } else {
        ctx.strokeStyle = c(0.5)
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(cx, cy, R * 0.62, 0, Math.PI * 2)
        ctx.stroke()
      }

      // Orbiting particles
      for (const p of particles) {
        p.a += p.s * dt * (look.spin + 0.1)
        const rr = R * p.r
        const x = cx + Math.cos(p.a) * rr
        const y = cy + Math.sin(p.a) * rr * 0.96
        ctx.fillStyle = c(0.25 + 0.5 * p.z * glow)
        ctx.beginPath()
        ctx.arc(x, y, 0.8 + p.z * 1.4, 0, Math.PI * 2)
        ctx.fill()
      }

      // Core
      const pulse = 1 + 0.06 * Math.sin(now / (stateRef.current === 'thinking' ? 180 : 700)) + wave * 0.12
      const core = ctx.createRadialGradient(cx, cy - R * 0.05, 0, cx, cy, R * 0.45 * pulse)
      core.addColorStop(0, `rgba(255,255,255,${0.75 + 0.25 * glow})`)
      core.addColorStop(0.35, c(0.85 * glow + 0.1))
      core.addColorStop(1, c(0))
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx, cy, R * 0.45 * pulse, 0, Math.PI * 2)
      ctx.fill()

      if (!reduced) schedule()
    }

    // Full frame rate only while listening, thinking or speaking; a calm 20 fps (8 in Lite mode) at rest.
    const schedule = () => {
      const active = LOOKS[stateRef.current].wave || stateRef.current === 'thinking'
      const lite = document.documentElement.dataset.lite === 'true'
      const fps = active ? (lite ? 30 : 60) : lite ? 8 : 20
      if (fps >= 60) raf = requestAnimationFrame(draw)
      else timer = setTimeout(() => (raf = requestAnimationFrame(draw)), 1000 / fps)
    }

    const stop = () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
    const start = () => {
      stop()
      last = performance.now()
      raf = requestAnimationFrame(draw)
    }
    const onVisibility = () => (document.hidden ? stop() : start())
    document.addEventListener('visibilitychange', onVisibility)
    start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [size, reduced, redrawKey])

  return <canvas ref={canvasRef} style={{ width: size, height: size }} role="img" aria-label={`Assistant is ${state}`} />
}
