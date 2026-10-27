/**
 * The flight model for flying a plane yourself on the 3D globe: arcade, not a
 * simulator. Thrust against drag along the flight path, gravity pulling the
 * nose's climb back, banked turns (the bank turns the plane, as in a real
 * one), a stall below the wing's speed, and the ground. Pure and stepwise, so
 * it is tested without a globe.
 */

export const G = 9.81
const M_PER_DEG_LAT = 111_320

export type AircraftId = 'c172' | 'airplane' | 'jet'

export interface Aircraft {
  id: AircraftId
  name: string
  /** The 3D model file in /models. */
  model: 'c172' | 'airplane' | 'jet' | 'b789'
  /** Below this the wing stops flying (m/s). */
  stall: number
  /** Where thrust and drag balance at full throttle in level flight (m/s). */
  top: number
  /** Thrust at full throttle, as an acceleration (m/s²). */
  thrust: number
  /** Most the nose moves per second at full stick (rad/s). */
  pitchRate: number
  rollRate: number
  yawRate: number
  /** Most it may bank (rad), so a turn never rolls it over by accident. */
  maxBank: number
  /** Distance from centre to wingtip (m): what hits another plane. */
  radius: number
  /** Speed and throttle when it starts in the air. */
  cruise: number
  cruiseThrottle: number
  /** Camera: how far behind and above it in chase view (m), and where the pilot sits ahead of centre. */
  chase: { back: number; up: number }
  cockpit: { ahead: number; up: number }
}

export const AIRCRAFT: Record<AircraftId, Aircraft> = {
  c172: { id: 'c172', name: 'Cessna 172', model: 'c172', stall: 24, top: 64, thrust: 4.2, pitchRate: 0.7, rollRate: 1.3, yawRate: 0.25, maxBank: 1.2, radius: 6, cruise: 52, cruiseThrottle: 0.75, chase: { back: 28, up: 6 }, cockpit: { ahead: 0.8, up: 0.9 } },
  airplane: { id: 'airplane', name: 'Airliner', model: 'b789', stall: 70, top: 260, thrust: 3.4, pitchRate: 0.35, rollRate: 0.6, yawRate: 0.1, maxBank: 0.9, radius: 30, cruise: 230, cruiseThrottle: 0.85, chase: { back: 110, up: 22 }, cockpit: { ahead: 26, up: 3 } },
  jet: { id: 'jet', name: 'Fighter jet', model: 'jet', stall: 60, top: 560, thrust: 14, pitchRate: 1.3, rollRate: 3.2, yawRate: 0.3, maxBank: Math.PI, radius: 9, cruise: 240, cruiseThrottle: 0.6, chase: { back: 45, up: 9 }, cockpit: { ahead: 4, up: 1.2 } },
}

export interface Controls {
  /** Stick back (+1, nose up) to forward (-1, nose down). */
  pitch: number
  /** Right (+1) or left (-1). */
  roll: number
  /** Rudder: right (+1) or left (-1). */
  yaw: number
  /** Throttle change per second (-1 to +1). */
  throttle: number
  /** Brakes on the ground. */
  brake: boolean
}

export const NO_CONTROLS: Controls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: false }

export interface FlightState {
  lat: number
  lon: number
  /** Metres above the sea (the ellipsoid). */
  alt: number
  /** Radians from north, clockwise. */
  heading: number
  /** Radians, nose up positive. */
  pitch: number
  /** Radians, right wing down positive. */
  roll: number
  /** Airspeed along the flight path (m/s). */
  speed: number
  throttle: number
  /** Climb or sink (m/s), for the instruments. */
  vs: number
  onGround: boolean
  /** True while the wing is not flying. */
  stalled: boolean
}

export type Outcome = { kind: 'flying' } | { kind: 'landed' } | { kind: 'crashed'; why: string }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const wrap = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
/** An angle to -π..π. */
const signed = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** A start in the air: level, at cruise speed, pointing where the camera looked. */
export const startInAir = (ac: Aircraft, at: { lat: number; lon: number; alt: number; heading: number }): FlightState => ({
  lat: at.lat,
  lon: at.lon,
  alt: at.alt,
  heading: wrap(at.heading),
  pitch: 0,
  roll: 0,
  speed: ac.cruise,
  throttle: ac.cruiseThrottle,
  vs: 0,
  onGround: false,
  stalled: false,
})

/**
 * One step of `dt` seconds. `ground` is the height of the ground (or a roof)
 * under the plane, in metres above the sea.
 */
export const step = (s: FlightState, c: Controls, ac: Aircraft, dt: number, ground: number): { state: FlightState; outcome: Outcome } => {
  dt = clamp(dt, 0, 0.1)
  const throttle = clamp(s.throttle + c.throttle * 0.5 * dt, 0, 1)
  // How well the controls bite: little at walking pace, full once the wing flies.
  const authority = clamp(s.speed / (ac.stall * 1.3), 0.15, 1)
  const stalled = !s.onGround && s.speed < ac.stall

  // Roll: the stick banks; let go and a stable plane slowly levels its wings.
  let roll = s.roll + c.roll * ac.rollRate * authority * dt
  if (!c.roll && ac.maxBank < Math.PI) roll -= roll * Math.min(1, 0.6 * dt)
  roll = ac.maxBank >= Math.PI ? signed(roll) : clamp(roll, -ac.maxBank, ac.maxBank)

  // Pitch: the stick moves the nose in the plane's own frame, so in a steep bank pulling turns more than it climbs.
  let pitch = s.pitch + c.pitch * ac.pitchRate * authority * Math.cos(roll) * dt
  let heading = s.heading + c.pitch * ac.pitchRate * authority * Math.sin(roll) * dt
  // A stalled wing drops the nose until it flies again.
  if (stalled) pitch -= (0.9 + (ac.stall - s.speed) / ac.stall) * dt
  pitch = clamp(pitch, -1.45, 1.45)

  // Turning: a banked wing turns the plane (coordinated, g·tan(bank)/v), the rudder a little more.
  const v = Math.max(s.speed, 1)
  if (!s.onGround) heading += ((G * Math.tan(clamp(roll, -1.4, 1.4))) / v) * Math.cos(pitch) * dt
  heading += c.yaw * ac.yawRate * dt * (s.onGround ? 2 : 1)
  heading = wrap(heading)

  // Speed: thrust against drag (drag grows with the square of speed, so full throttle levels out at `top`), and climbing costs speed.
  const drag = ac.thrust * (s.speed / ac.top) ** 2
  let speed = s.speed + (ac.thrust * throttle - drag - G * Math.sin(pitch)) * dt
  if (s.onGround) speed -= (c.brake ? 6 : 0.4) * dt
  speed = Math.max(0, speed)

  // Moving: along the flight path; a stalled plane also sinks.
  const sink = stalled ? Math.min(25, (ac.stall - s.speed) * 1.2 + 4) : 0
  let vs = speed * Math.sin(pitch) - sink
  const horizontal = speed * Math.cos(pitch)
  const dn = horizontal * Math.cos(heading) * dt
  const de = horizontal * Math.sin(heading) * dt
  const lat = clamp(s.lat + dn / M_PER_DEG_LAT, -89.5, 89.5)
  let lon = s.lon + de / (M_PER_DEG_LAT * Math.max(0.05, Math.cos((s.lat * Math.PI) / 180)))
  lon = ((lon + 540) % 360) - 180
  let alt = s.alt + vs * dt
  // On its wheels it stays on the ground until rotation speed, whatever the stick does.
  const rotate = speed > ac.stall * 1.15 && c.pitch > 0
  if (s.onGround && !rotate) alt = Math.min(alt, ground)

  let onGround = false
  let outcome: Outcome = { kind: 'flying' }
  if (alt <= ground) {
    // Touching down: gentle, wings level and nose not buried is a landing; anything else is a crash.
    const sinkRate = -vs
    const gentle = sinkRate < 6 && Math.abs(signed(roll)) < 0.26 && pitch > -0.17 && speed < ac.stall * 2.2
    if (s.onGround || gentle) {
      onGround = true
      alt = ground
      vs = 0
      // On the wheels the nose rises only a little (the tail would touch), and only once it is nearly flying.
      pitch = speed > ac.stall ? Math.min(0.15, Math.max(0, pitch)) : 0
      roll = 0
      if (!s.onGround) outcome = { kind: 'landed' }
    } else {
      alt = ground
      outcome = { kind: 'crashed', why: sinkRate > 30 || pitch < -0.5 ? 'Flew into the ground.' : Math.abs(signed(roll)) >= 0.26 ? 'A wing hit the ground.' : 'Landed too hard.' }
    }
  }
  // Off the ground again once it is past rotation speed (a margin over the stall) and the nose comes up.
  if (onGround && rotate) {
    onGround = false
    alt = ground + 0.5
    pitch = 0.08
  }
  return { state: { lat, lon, alt, heading, pitch, roll, speed, throttle, vs, onGround, stalled }, outcome }
}

/** Metres between two points (flat earth: only used over a few kilometres). */
export const metresBetween = (a: { lat: number; lon: number; alt: number }, b: { lat: number; lon: number; alt: number }) => {
  const dn = (b.lat - a.lat) * M_PER_DEG_LAT
  let dLon = b.lon - a.lon
  if (dLon > 180) dLon -= 360
  if (dLon < -180) dLon += 360
  const de = dLon * M_PER_DEG_LAT * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180)
  return Math.hypot(dn, de, b.alt - a.alt)
}

/** Compass bearing from a to b (radians from north, clockwise). */
export const bearing = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  let dLon = b.lon - a.lon
  if (dLon > 180) dLon -= 360
  if (dLon < -180) dLon += 360
  return wrap(Math.atan2(dLon * Math.cos((a.lat * Math.PI) / 180), b.lat - a.lat))
}
