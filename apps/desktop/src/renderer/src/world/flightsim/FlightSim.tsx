/**
 * Fly a plane yourself on the 3D globe: a Cessna, an airliner or a fighter
 * jet, from the cockpit or behind it, over real terrain, among the real
 * planes in the sky right now. Fly into one of them (or the ground) and it
 * ends in a fireball; Enter flies again.
 *
 * Keyboard: W/S or ↑/↓ the stick (forward is nose down), A/D or ←/→ bank,
 * Q/E rudder, R/F or +/− throttle, B brakes, C camera, M sound, P pause,
 * Enter fly again, Esc leave. A game controller works too (left stick,
 * triggers for throttle, bumpers for rudder).
 */
import { Cartesian2, Cartesian3, Cartographic, Color, FixedFrameTransforms as Transforms, Matrix3, Matrix4, Quaternion } from '@cesium/core'
import { type Billboard, BillboardCollection, Model, type CesiumWidget } from '@cesium/engine'
import { useEffect, useRef, useState } from 'react'

import type { Flight } from '../../../../shared/world.ts'
import { deadReckon } from '../geo.ts'
import { headingTape, modelFor, type ModelId } from '../models3d.ts'
import { contacts, hit, type Contact, type Traffic } from './collide.ts'
import { AIRCRAFT, metresBetween, NO_CONTROLS, startInAir, step, type AircraftId, type Controls, type FlightState } from './physics.ts'

export type FlyStart = 'here' | 'traffic'

type FlightsRef = { current: { list: Flight[]; at: number; byHex: Map<string, Flight> } }

const panel = 'rounded-2xl border border-accent/30 bg-[rgba(4,10,20,0.78)] text-white shadow-[0_0_18px_rgba(34,211,238,0.18)]'
const mono = 'font-mono uppercase tracking-[0.12em]'
const KT = 1.943844
const FT = 3.28084
const INVERT_KEY = 'atlas.flightsim.invert'

/** Half a wingspan for each kind of model the live planes are drawn with (m). */
const RADIUS: Record<ModelId, number> = { airplane: 32, b789: 30, atr72: 14, c172: 6, citation2: 8, bell206: 5, mq9: 10, jet: 6, ship: 0 }
/**
 * How the shared aircraft models sit once Cesium has loaded them: nose along −Y,
 * right wing along −X, top along +Z (so a plane heading north is the model turned
 * half round). Pitch turns about the wing, roll about the nose.
 */
const NOSE = Math.PI
const WING = new Cartesian3(-1, 0, 0)
const FORWARD = new Cartesian3(0, -1, 0)

const altM = (f: Flight) => (f.altitude === null ? 0 : Math.max(0, f.altitude * 0.3048))
const wrap = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
const deg = (r: number) => (r * 180) / Math.PI

interface Hud {
  s: FlightState
  agl: number
  near: Contact[]
  paused: boolean
  view: 'cockpit' | 'chase'
  sound: boolean
}

interface Ending {
  kind: 'crashed'
  why: string
  /** The plane it flew into, if any. */
  into?: string
}

interface Stats {
  seconds: number
  km: number
  topKt: number
  closeCalls: number
}

/** A soft round spark, drawn once, for the fireball. */
const spark = (() => {
  let url = ''
  return () => {
    if (url) return url
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')!
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    r.addColorStop(0, 'rgba(255,255,255,1)')
    r.addColorStop(0.35, 'rgba(255,200,80,0.9)')
    r.addColorStop(1, 'rgba(255,80,0,0)')
    g.fillStyle = r
    g.fillRect(0, 0, 64, 64)
    url = c.toDataURL()
    return url
  }
})()

/** Engine hum and a crash, made by the browser (no sound files). */
class Sound {
  private ctx: AudioContext | null = null
  private osc: OscillatorNode | null = null
  private gain: GainNode | null = null
  on = true
  start() {
    try {
      this.ctx = new AudioContext()
      const osc = this.ctx.createOscillator()
      const filter = this.ctx.createBiquadFilter()
      const gain = this.ctx.createGain()
      osc.type = 'sawtooth'
      filter.type = 'lowpass'
      filter.frequency.value = 420
      gain.gain.value = 0
      osc.connect(filter).connect(gain).connect(this.ctx.destination)
      osc.start()
      this.osc = osc
      this.gain = gain
    } catch {
      this.ctx = null
    }
  }
  engine(throttle: number, running: boolean) {
    if (!this.ctx || !this.osc || !this.gain) return
    const t = this.ctx.currentTime
    this.osc.frequency.setTargetAtTime(48 + throttle * 90, t, 0.2)
    this.gain.gain.setTargetAtTime(this.on && running ? 0.025 + throttle * 0.035 : 0, t, 0.15)
  }
  boom() {
    if (!this.ctx || !this.on) return
    const len = this.ctx.sampleRate * 1.6
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.5
    const src = this.ctx.createBufferSource()
    const filter = this.ctx.createBiquadFilter()
    const gain = this.ctx.createGain()
    filter.type = 'lowpass'
    filter.frequency.value = 900
    gain.gain.value = 0.5
    src.buffer = buf
    src.connect(filter).connect(gain).connect(this.ctx.destination)
    src.start()
  }
  stop() {
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
  }
}

export function FlightSim({ widget, flights, aircraft, start, onExit }: { widget: CesiumWidget; flights: FlightsRef; aircraft: AircraftId; start: FlyStart; onExit: () => void }) {
  const ac = AIRCRAFT[aircraft]
  const [hud, setHud] = useState<Hud | null>(null)
  const [ending, setEnding] = useState<Ending | null>(null)
  const [landed, setLanded] = useState(false)
  const [stats, setStats] = useState<Stats>({ seconds: 0, km: 0, topKt: 0, closeCalls: 0 })
  const [invert, setInvert] = useState(() => {
    try {
      return localStorage.getItem(INVERT_KEY) === '1'
    } catch {
      return false
    }
  })
  const [help, setHelp] = useState(true)
  const invertRef = useRef(invert)
  invertRef.current = invert
  const exitRef = useRef(onExit)
  exitRef.current = onExit
  /** Set by the effect: fly again from the last safe place. */
  const again = useRef<() => void>(() => undefined)

  useEffect(() => {
    const scene = widget.scene
    const camera = widget.camera
    const ellipsoid = scene.globe.ellipsoid
    const sound = new Sound()
    sound.start()
    const inputsWere = scene.screenSpaceCameraController.enableInputs
    scene.screenSpaceCameraController.enableInputs = false
    camera.lookAtTransform(Matrix4.IDENTITY)

    // ── where it starts ──
    const startState = (): FlightState => {
      const canvas = scene.canvas
      const centre = camera.pickEllipsoid(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2), ellipsoid)
      const c = centre ? Cartographic.fromCartesian(centre, ellipsoid) : camera.positionCartographic
      const lat = deg(c.latitude)
      const lon = deg(c.longitude)
      if (start === 'traffic') {
        // Behind the nearest real plane in the air, off to one side and a little below, at its speed:
        // something to chase (it is up to the pilot to close in, or to fly into it).
        const now = (Date.now() - flights.current.at) / 1000
        const air = flights.current.list.filter(f => f.altitude !== null && f.altitude > 3000).map(f => deadReckon(f, f.seen + now))
        // A small plane joins the low traffic (it could not keep up with an airliner at 37,000 ft); the others join anyone.
        const fits = aircraft === 'c172' ? air.filter(f => (f.altitude ?? 0) < 12_000) : air
        const target = (fits.length ? fits : air).map(f => ({ f, m: metresBetween({ lat, lon, alt: 0 }, { lat: f.lat, lon: f.lon, alt: 0 }) })).sort((a, b) => a.m - b.m)[0]?.f
        if (target) {
          const h = (target.track * Math.PI) / 180
          const back = 1500
          const side = 300
          const dn = -Math.cos(h) * back - Math.sin(h) * side
          const de = -Math.sin(h) * back + Math.cos(h) * side
          const s = startInAir(ac, { lat: target.lat + dn / 111_320, lon: target.lon + de / (111_320 * Math.cos((target.lat * Math.PI) / 180)), alt: altM(target) - 150, heading: h })
          return { ...s, speed: Math.min(ac.top * 0.95, Math.max(ac.stall * 1.4, target.speed / KT)) }
        }
      }
      // The sea is the floor (the terrain includes the seabed).
      const ground = Math.max(0, scene.globe.getHeight(Cartographic.fromDegrees(lon, lat)) ?? 0)
      return startInAir(ac, { lat, lon, alt: ground + (aircraft === 'c172' ? 700 : 1800), heading: camera.heading })
    }

    let state = startState()
    let graceUntil = performance.now() + 2500
    let lastSafe = state
    let crashed = false
    let paused = false
    let view: 'cockpit' | 'chase' = 'chase'
    let camHeading = state.heading
    let trafficList: Traffic[] = []
    let trafficAt = 0
    let groundAt = 0
    let ground = 0
    let hudAt = 0
    const close = new Set<string>()
    const stat: Stats = { seconds: 0, km: 0, topKt: 0, closeCalls: 0 }
    const keys = new Set<string>()
    const stick: Controls = { ...NO_CONTROLS }

    // ── my plane ──
    let model: Model | null = null
    let gone = false
    const qh = new Quaternion()
    const qp = new Quaternion()
    const qr = new Quaternion()
    const turn = new Matrix3()
    const pos = new Cartesian3()
    const enu = new Matrix4()
    const scratch = new Cartesian3()
    const place = () => {
      Cartesian3.fromDegrees(state.lon, state.lat, state.alt, ellipsoid, pos)
      if (!model) return
      // Heading (clockwise from north, about −Z), then pitch about the wing, then roll about the nose: the body's own order.
      Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, -(state.heading + NOSE), qh)
      Quaternion.fromAxisAngle(WING, state.pitch, qp)
      Quaternion.fromAxisAngle(FORWARD, state.roll, qr)
      Quaternion.multiply(Quaternion.multiply(qh, qp, qp), qr, qr)
      Transforms.eastNorthUpToFixedFrame(pos, ellipsoid, enu)
      model.modelMatrix = Matrix4.multiplyByMatrix3(enu, Matrix3.fromQuaternion(qr, turn), model.modelMatrix)
    }
    void Model.fromGltfAsync({ url: `./models/${ac.model}.glb`, modelMatrix: Matrix4.IDENTITY.clone(), id: { kind: 'my-plane' } }).then(m => {
      if (gone) return
      model = scene.primitives.add(m) as Model
      place()
    }, () => undefined)

    // ── a fireball: sparks flung out from the wreck, growing and fading, moved by this loop (not the scene's clock) ──
    type Spark = { b: Billboard; frame: Matrix4; v: Cartesian3; at: Cartesian3; life: number; age: number; size: number }
    const sparks: Spark[] = []
    const booms = new BillboardCollection({ scene })
    scene.primitives.add(booms)
    const hot = Color.fromCssColorString('#fff1b8')
    const cool = Color.fromCssColorString('#ff5a1f')
    const smoke = Color.fromCssColorString('#2b2622')
    const explode = (at: Cartesian3, size: number) => {
      const frame = Transforms.eastNorthUpToFixedFrame(at, ellipsoid)
      for (let i = 0; i < 90; i++) {
        // A random direction, mostly outward and up.
        const a = Math.random() * Math.PI * 2
        const up = Math.random() * 0.9 + 0.1
        const speed = size * (1.5 + Math.random() * 4)
        const v = new Cartesian3(Math.cos(a) * Math.sqrt(1 - up * up) * speed, Math.sin(a) * Math.sqrt(1 - up * up) * speed, up * speed)
        const b = booms.add({ position: at, image: spark(), width: size, height: size, sizeInMeters: true, color: hot.clone() })
        sparks.push({ b, frame, v, at: new Cartesian3(), life: 1.2 + Math.random() * 1.6, age: 0, size })
      }
    }
    const burn = (dt: number) => {
      for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i]!
        p.age += dt
        const k = p.age / p.life
        if (k >= 1) {
          booms.remove(p.b)
          sparks.splice(i, 1)
          continue
        }
        // Slowing as it goes, rising a little (hot air), growing into smoke.
        Cartesian3.multiplyByScalar(p.v, Math.max(0, 1 - dt * 1.8), p.v)
        p.v.z += dt * 6
        Cartesian3.add(p.at, Cartesian3.multiplyByScalar(p.v, dt, scratch), p.at)
        p.b.position = Matrix4.multiplyByPoint(p.frame, p.at, p.b.position)
        const grow = p.size * (1 + k * 4)
        p.b.width = grow
        p.b.height = grow
        const c = k < 0.35 ? Color.lerp(hot, cool, k / 0.35, p.b.color) : Color.lerp(cool, smoke, (k - 0.35) / 0.65, p.b.color)
        c.alpha = (1 - k) ** 1.3
        p.b.color = c
      }
    }

    // ── the traffic around: the real planes, glided to now ──
    const traffic = () => {
      const now = (Date.now() - flights.current.at) / 1000
      const out: Traffic[] = []
      for (const raw of flights.current.list) {
        if (Math.abs(raw.lat - state.lat) > 0.5 || Math.abs(raw.lon - state.lon) > 0.7) continue
        const f = deadReckon(raw, raw.seen + now)
        out.push({ id: f.hex, label: f.callsign || f.registration || f.hex, lat: f.lat, lon: f.lon, alt: altM(f), radius: RADIUS[modelFor(f.type, f.military)] })
      }
      return out
    }

    const crash = (why: string, into?: Traffic) => {
      crashed = true
      Cartesian3.fromDegrees(state.lon, state.lat, Math.max(state.alt, ground + 2), ellipsoid, scratch)
      explode(Cartesian3.clone(scratch), Math.max(18, ac.radius * 3))
      if (into) {
        Cartesian3.fromDegrees(into.lon, into.lat, into.alt, ellipsoid, scratch)
        explode(Cartesian3.clone(scratch), Math.max(18, into.radius * 3))
      }
      if (model) model.show = false
      // The camera steps back and up to watch the fireball.
      const wreck = Cartesian3.fromDegrees(state.lon, state.lat, Math.max(state.alt, ground + 2), ellipsoid)
      Transforms.eastNorthUpToFixedFrame(wreck, ellipsoid, enu)
      const h = state.heading
      const back = 160 + ac.radius * 6
      const rise = 70 + ac.radius * 2
      camera.setView({ destination: Matrix4.multiplyByPoint(enu, new Cartesian3(-Math.sin(h) * back, -Math.cos(h) * back, rise), new Cartesian3()), orientation: { heading: h, pitch: -Math.atan2(rise, back), roll: 0 } })
      sound.boom()
      sound.engine(0, false)
      setEnding({ kind: 'crashed', why, ...(into ? { into: into.label } : {}) })
      setStats({ ...stat })
    }

    again.current = () => {
      // From the last place it flew well, a little higher, wings level.
      state = { ...lastSafe, alt: lastSafe.alt + 300, pitch: 0, roll: 0, speed: Math.max(lastSafe.speed, ac.cruise), onGround: false, stalled: false }
      camHeading = state.heading
      graceUntil = performance.now() + 2500
      crashed = false
      if (model) model.show = view === 'chase'
      setEnding(null)
      setLanded(false)
    }

    // ── controls ──
    const typing = () => {
      const el = document.activeElement
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)
    }
    const FLIGHT_KEYS = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'KeyB', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'])
    const down = (e: KeyboardEvent) => {
      if (typing() || e.ctrlKey || e.metaKey || e.altKey) return
      if (FLIGHT_KEYS.has(e.code)) {
        keys.add(e.code)
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (e.code === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        exitRef.current()
      } else if (e.code === 'KeyC') {
        view = view === 'chase' ? 'cockpit' : 'chase'
        if (model) model.show = view === 'chase' && !crashed
      } else if (e.code === 'KeyM') sound.on = !sound.on
      else if (e.code === 'KeyP') paused = !paused
      else if (e.code === 'Enter' && crashed) again.current()
      else return
      e.preventDefault()
    }
    const up = (e: KeyboardEvent) => void keys.delete(e.code)
    const blur = () => keys.clear()
    // Capture, so the rest of the page (shortcuts, the globe's own keys) does not act on flying keys.
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)

    const read = (dt: number): Controls => {
      const k = (...codes: string[]) => (codes.some(c => keys.has(c)) ? 1 : 0)
      const pad = navigator.getGamepads?.().find(g => g?.connected) ?? null
      const dead = (v: number | undefined) => (v === undefined || Math.abs(v) < 0.12 ? 0 : v)
      // Keys: forward on the stick is nose down (a real stick); Invert swaps it.
      let pitchKey = k('KeyS', 'ArrowDown') - k('KeyW', 'ArrowUp')
      if (invertRef.current) pitchKey = -pitchKey
      const target = {
        pitch: pad ? dead(pad.axes[1]) * (invertRef.current ? -1 : 1) || pitchKey : pitchKey,
        roll: (pad ? dead(pad.axes[0]) : 0) || k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft'),
        yaw: (pad ? (pad.buttons[5]?.value ?? 0) - (pad.buttons[4]?.value ?? 0) : 0) || k('KeyE') - k('KeyQ'),
        throttle: (pad ? (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0) : 0) || k('KeyR', 'Equal', 'NumpadAdd') - k('KeyF', 'Minus', 'NumpadSubtract'),
      }
      // Keys are all or nothing: the stick eases toward them, so the plane moves smoothly.
      const ease = (from: number, to: number) => from + (to - from) * Math.min(1, dt * 5)
      stick.pitch = ease(stick.pitch, target.pitch)
      stick.roll = ease(stick.roll, target.roll)
      stick.yaw = ease(stick.yaw, target.yaw)
      stick.throttle = target.throttle
      stick.brake = keys.has('KeyB') || !!pad?.buttons[1]?.pressed
      return stick
    }

    // ── the camera ──
    const look = (dt: number) => {
      Cartesian3.fromDegrees(state.lon, state.lat, state.alt, ellipsoid, pos)
      Transforms.eastNorthUpToFixedFrame(pos, ellipsoid, enu)
      if (view === 'cockpit') {
        const h = state.heading
        const p = state.pitch
        const o = new Cartesian3(Math.sin(h) * Math.cos(p) * ac.cockpit.ahead, Math.cos(h) * Math.cos(p) * ac.cockpit.ahead, Math.sin(p) * ac.cockpit.ahead + ac.cockpit.up)
        camera.setView({ destination: Matrix4.multiplyByPoint(enu, o, scratch), orientation: { heading: h, pitch: p, roll: state.roll } })
        return
      }
      // Behind and a little above, turning after the plane rather than with it.
      let d = state.heading - camHeading
      d = Math.atan2(Math.sin(d), Math.cos(d))
      camHeading = wrap(camHeading + d * Math.min(1, dt * 3))
      const back = ac.chase.back
      const o = new Cartesian3(-Math.sin(camHeading) * back, -Math.cos(camHeading) * back, ac.chase.up - Math.sin(state.pitch) * back * 0.6)
      camera.setView({ destination: Matrix4.multiplyByPoint(enu, o, scratch), orientation: { heading: camHeading, pitch: -Math.atan2(ac.chase.up, back) + state.pitch * 0.4, roll: 0 } })
    }

    // ── every frame ──
    let last = performance.now()
    const frame = () => {
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (document.hidden) return
      const c = read(dt)
      if (!crashed && !paused) {
        // The ground under the plane: the terrain where the globe shows, else the 3D tiles (sampled less often).
        if (scene.globe.show) ground = Math.max(0, scene.globe.getHeight(Cartographic.fromDegrees(state.lon, state.lat)) ?? ground)
        else if (now - groundAt > 150 && scene.sampleHeightSupported) {
          groundAt = now
          ground = Math.max(0, scene.sampleHeight(Cartographic.fromDegrees(state.lon, state.lat), model ? [model] : []) ?? ground)
        }
        if (now - trafficAt > 250) {
          trafficAt = now
          trafficList = traffic()
        }
        // Just started: the ground is still coming in from coarse tiles. If it turns out above the plane, lift the plane over it.
        if (performance.now() < graceUntil && state.alt - ground < 60) state = { ...state, alt: ground + 300 }
        const from = state
        const r = step(state, c, ac, dt, ground)
        state = r.state
        stat.seconds += dt
        stat.km += (state.speed * dt) / 1000
        stat.topKt = Math.max(stat.topKt, state.speed * KT)
        if (r.outcome.kind === 'crashed') crash(r.outcome.why)
        else {
          const t = state.onGround ? null : hit(state, from, ac.radius, trafficList)
          if (t) crash(`You flew into ${t.label}.`, t)
          else {
            if (r.outcome.kind === 'landed') setLanded(true)
            if (!state.onGround && state.alt - ground > 150 && !state.stalled) lastSafe = state
            for (const n of contacts(state, trafficList, 1, 3)) if (n.distance < 400 && !close.has(n.traffic.id)) (close.add(n.traffic.id), stat.closeCalls++)
          }
        }
        place()
      }
      if (sparks.length) burn(dt)
      if (!crashed) look(dt)
      sound.engine(state.throttle, !crashed && !paused)
      if (now - hudAt > 100) {
        hudAt = now
        setHud({ s: state, agl: state.alt - ground, near: contacts(state, trafficList, 15, 5), paused, view, sound: sound.on })
      }
    }
    // Development: the flight state, for checking the model and camera from the console.
    if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) (window as unknown as { __flight?: () => FlightState & { ground: number } }).__flight = () => ({ ...state, ground })
    const remove = scene.preUpdate.addEventListener(frame)
    scene.requestRenderMode = false

    return () => {
      gone = true
      remove()
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
      sound.stop()
      if (!widget.isDestroyed()) {
        if (model) scene.primitives.remove(model)
        scene.primitives.remove(booms)
        scene.screenSpaceCameraController.enableInputs = inputsWere
        camera.lookAtTransform(Matrix4.IDENTITY)
      }
    }
  }, [widget, flights, aircraft, start, ac])

  const saveInvert = (on: boolean) => {
    setInvert(on)
    try {
      localStorage.setItem(INVERT_KEY, on ? '1' : '0')
    } catch {
      // Remembered for this time only.
    }
  }

  if (!hud) return null
  const { s, agl, near } = hud
  const pullUp = !ending && !s.onGround && agl < 200 && s.vs < -12
  const traffic = !ending && near[0] && near[0].distance < 1500 ? near[0] : null
  const clock = (c: Contact) => {
    const rel = wrap(c.bearing - s.heading)
    return `${Math.round(rel / (Math.PI / 6)) % 12 || 12} o'clock`
  }
  return (
    <>
      {/* The horizon: the ladder turns with the bank and slides with the pitch. */}
      <div className={`pointer-events-none absolute inset-0 place-items-center overflow-hidden ${ending ? 'hidden' : 'grid'}`}>
        <div className="relative h-72 w-72" style={{ transform: `rotate(${-deg(s.roll)}deg)` }}>
          <div className="absolute inset-x-0 top-1/2" style={{ transform: `translateY(${deg(s.pitch) * 6}px)` }}>
            {[-20, -10, 0, 10, 20].map(d => (
              <div key={d} className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2" style={{ top: `${-d * 6}px` }}>
                <span className={`block h-px ${d === 0 ? 'w-64 bg-accent/80' : 'w-20 bg-white/50'}`} />
                {d !== 0 && <span className={`text-[10px] text-white/60 ${mono}`}>{d}</span>}
              </div>
            ))}
          </div>
        </div>
        <div className="absolute grid place-items-center">
          <span className="block h-0.5 w-16 bg-amber-300 shadow-[0_0_6px_rgba(0,0,0,0.8)]" />
          <span className="absolute block size-1.5 rounded-full bg-amber-300" />
        </div>
      </div>

      {/* Heading. */}
      <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
        <div className="relative h-8 w-80 overflow-hidden rounded-full border border-accent/30 bg-black/40">
          {headingTape(deg(s.heading)).map(t => (
            <span key={`${t.deg}-${t.offset}`} className={`absolute top-1.5 -translate-x-1/2 text-[11px] ${mono} ${/[NESW]/.test(t.label) ? 'text-accent' : 'text-white/70'}`} style={{ left: `${(t.offset + 0.5) * 100}%` }}>
              {t.label}
            </span>
          ))}
          <span className="absolute left-1/2 top-0 h-2 w-px bg-accent" />
        </div>
      </div>

      {/* Speed, climb, height. */}
      <div className={`pointer-events-none absolute bottom-28 left-1/2 flex -translate-x-1/2 items-end gap-10 ${mono}`}>
        <div className="text-center">
          <p className="text-[10px] text-accent/70">Airspeed · kt</p>
          <p className={`text-4xl font-light [text-shadow:0_0_12px_rgba(0,0,0,0.9)] ${s.stalled ? 'text-red-400' : 'text-white'}`}>{Math.round(s.speed * KT)}</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-accent/70">ft/min</p>
          <p className="text-2xl font-light text-white/80">{`${s.vs > 0.5 ? '+' : ''}${Math.round((s.vs * FT * 60) / 10) * 10}`}</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] text-accent/70">Altitude · ft</p>
          <p className="text-4xl font-light text-white [text-shadow:0_0_12px_rgba(0,0,0,0.9)]">{Math.round(s.alt * FT).toLocaleString()}</p>
          <p className="text-[10px] text-white/50">{s.onGround ? 'on the ground' : `${Math.round(agl * FT).toLocaleString()} ft above ground`}</p>
        </div>
      </div>

      {/* Throttle. */}
      <div className={`pointer-events-none absolute bottom-28 left-6 flex flex-col items-center gap-1 ${mono}`}>
        <div className="relative h-32 w-3 overflow-hidden rounded-full border border-accent/40 bg-black/50">
          <div className="absolute inset-x-0 bottom-0 bg-accent" style={{ height: `${Math.round(s.throttle * 100)}%` }} />
        </div>
        <p className="text-[10px] text-accent/80">Thr {Math.round(s.throttle * 100)}%</p>
      </div>

      {/* Warnings. */}
      <div className={`pointer-events-none absolute left-1/2 top-[30%] flex -translate-x-1/2 flex-col items-center gap-1 text-sm font-semibold ${mono}`}>
        {s.stalled && !ending && <span className="animate-pulse rounded bg-red-600/80 px-3 py-1 text-white">Stall · nose down</span>}
        {pullUp && <span className="animate-pulse rounded bg-red-600/80 px-3 py-1 text-white">Pull up</span>}
        {traffic && (
          <span className="rounded bg-amber-500/85 px-3 py-1 text-black">
            Traffic {clock(traffic)} · {Math.round(traffic.distance)} m {traffic.above > 30 ? 'above' : traffic.above < -30 ? 'below' : 'level'}
          </span>
        )}
        {landed && s.onGround && <span className="rounded bg-emerald-600/80 px-3 py-1 text-white">Landed</span>}
        {hud.paused && <span className="rounded bg-black/70 px-3 py-1 text-white">Paused · P</span>}
      </div>

      {/* The planes around: real flights, right now. */}
      <div className={`absolute right-3 top-14 w-60 p-3 ${panel}`}>
        <p className={`mb-1.5 text-[10px] text-accent/80 ${mono}`}>Real traffic around you</p>
        {near.length ? (
          <ul className="space-y-1">
            {near.map(n => (
              <li key={n.traffic.id} className="flex items-center gap-2 text-[11px]">
                <span className="min-w-0 flex-1 truncate">{n.traffic.label}</span>
                <span className="text-white/50">{n.distance < 1000 ? `${Math.round(n.distance)} m` : `${(n.distance / 1000).toFixed(1)} km`}</span>
                <span className="w-12 text-right text-white/40">{n.above >= 0 ? '+' : ''}{Math.round((n.above * FT) / 100) * 100}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-white/45">No planes within 15 km. Turn the Flights layer on, or start with "Join live traffic".</p>
        )}
      </div>

      {/* What you fly, and how. */}
      <div className={`absolute left-3 top-14 w-64 space-y-2 p-3 ${panel}`}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">{AIRCRAFT[aircraft].name}</p>
          <button type="button" className="text-[11px] text-accent hover:underline" onClick={() => setHelp(h => !h)}>
            {help ? 'Hide keys' : 'Keys'}
          </button>
        </div>
        {help && (
          <ul className="space-y-0.5 text-[11px] text-white/70">
            <li>
              <b className="text-white">W/S</b> or <b className="text-white">↑/↓</b> stick: {invert ? 'up is nose up' : 'forward is nose down'}
            </li>
            <li>
              <b className="text-white">A/D</b> or <b className="text-white">←/→</b> bank · <b className="text-white">Q/E</b> rudder
            </li>
            <li>
              <b className="text-white">R/F</b> or <b className="text-white">+/−</b> throttle · <b className="text-white">B</b> brakes
            </li>
            <li>
              <b className="text-white">C</b> {hud.view === 'chase' ? 'cockpit' : 'chase'} view · <b className="text-white">M</b> sound {hud.sound ? 'off' : 'on'} · <b className="text-white">P</b> pause · <b className="text-white">Esc</b> leave
            </li>
            <li className="text-white/50">A game controller works too.</li>
          </ul>
        )}
        <label className="flex items-center gap-2 text-[11px] text-white/70">
          <input type="checkbox" checked={invert} onChange={e => saveInvert(e.target.checked)} /> Up arrow is nose up
        </label>
      </div>

      <button type="button" onClick={onExit} className={`absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-xs text-warm ${panel}`}>
        Stop flying (Esc)
      </button>

      {/* The end: what happened, and fly again (low on the screen, so the fireball above it stays in view). */}
      {ending && (
        <div className="absolute inset-0 flex items-end justify-center bg-gradient-to-t from-red-950/50 to-transparent pb-24">
          <div className={`w-80 space-y-3 p-5 text-center ${panel}`}>
            <p className={`text-2xl font-semibold text-red-400 ${mono}`}>Crashed</p>
            <p className="text-sm">{ending.why}</p>
            {ending.into && <p className="text-[11px] text-white/50">(Only in your game: {ending.into} flies on in the real sky.)</p>}
            <div className={`grid grid-cols-2 gap-2 text-[11px] text-white/70 ${mono}`}>
              <span>Flew {Math.floor(stats.seconds / 60)}:{String(Math.floor(stats.seconds % 60)).padStart(2, '0')}</span>
              <span>{stats.km.toFixed(1)} km</span>
              <span>Top {Math.round(stats.topKt)} kt</span>
              <span>Close calls {stats.closeCalls}</span>
            </div>
            <div className="flex justify-center gap-2">
              <button type="button" className="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-black" onClick={() => again.current()}>
                Fly again (Enter)
              </button>
              <button type="button" className="rounded-full border border-white/30 px-4 py-1.5 text-xs" onClick={onExit}>
                Leave (Esc)
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
