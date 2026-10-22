import { describe, expect, it } from 'vitest'

import { contacts, hit, type Traffic } from './collide.ts'
import { AIRCRAFT, metresBetween, NO_CONTROLS, startInAir, step, type Controls, type FlightState, type Outcome } from './physics.ts'

const fly = (s: FlightState, c: Partial<Controls>, seconds: number, ground = 0, ac = AIRCRAFT.c172) => {
  let state = s
  let outcome: Outcome = { kind: 'flying' }
  for (let t = 0; t < seconds && outcome.kind !== 'crashed'; t += 0.05) ({ state, outcome } = step(state, { ...NO_CONTROLS, ...c }, ac, 0.05, ground))
  return { state, outcome }
}

const start = (ac = AIRCRAFT.c172, alt = 1500) => startInAir(ac, { lat: 31.5, lon: 74.3, alt, heading: 0 })

describe('flight model', () => {
  it('flies along at cruise without falling out of the sky', () => {
    const { state, outcome } = fly(start(), {}, 20)
    expect(outcome.kind).toBe('flying')
    expect(Math.abs(state.alt - 1500)).toBeLessThan(150)
    expect(state.lat).toBeGreaterThan(31.5) // heading north
    expect(state.speed).toBeGreaterThan(AIRCRAFT.c172.stall)
  })

  it('turns when banked, and levels its wings when let go', () => {
    const banked = fly(start(), { roll: 1 }, 0.8).state
    expect(banked.roll).toBeGreaterThan(0.5)
    const turned = fly(banked, {}, 8).state
    expect(turned.heading).toBeGreaterThan(0.3)
    expect(turned.heading).toBeLessThan(Math.PI)
    expect(Math.abs(turned.roll)).toBeLessThan(banked.roll)
  })

  it('speeds up toward its top speed at full throttle', () => {
    const { state } = fly({ ...start(AIRCRAFT.jet, 5000), throttle: 1 }, { throttle: 1 }, 60, 0, AIRCRAFT.jet)
    expect(state.speed).toBeGreaterThan(AIRCRAFT.jet.cruise)
    expect(state.speed).toBeLessThan(AIRCRAFT.jet.top * 1.05)
  })

  it('stalls when too slow: the nose drops and it sinks', () => {
    const slow = { ...start(), speed: 15, throttle: 0 }
    const { state } = fly(slow, {}, 3)
    expect(state.stalled || state.speed > AIRCRAFT.c172.stall).toBe(true)
    expect(state.pitch).toBeLessThan(0)
    expect(state.alt).toBeLessThan(1500)
  })

  it('crashes into the ground in a dive, lands when gentle', () => {
    const dive = fly({ ...start(AIRCRAFT.c172, 300), pitch: -0.6 }, { pitch: -1 }, 30)
    expect(dive.outcome).toEqual({ kind: 'crashed', why: 'Flew into the ground.' })
    // A gentle descent: a little nose down, low speed, wings level.
    const approach = { ...start(AIRCRAFT.c172, 40), speed: 30, throttle: 0.3, pitch: -0.05 }
    const landing = fly(approach, {}, 60)
    expect(landing.outcome.kind).not.toBe('crashed')
    expect(landing.state.onGround).toBe(true)
  })

  it('takes off from the ground with throttle and a pull', () => {
    const parked: FlightState = { ...start(AIRCRAFT.c172, 200), speed: 0, throttle: 1, onGround: true }
    // Full throttle and a gentle pull until the wheels leave, then let the stick go and climb away.
    let s = parked
    for (let t = 0; t < 30 && s.onGround; t += 0.05) s = step(s, { ...NO_CONTROLS, throttle: 1, pitch: 0.4 }, AIRCRAFT.c172, 0.05, 200).state
    expect(s.onGround).toBe(false)
    const { state, outcome } = fly(s, { throttle: 1 }, 6, 200)
    expect(outcome.kind).toBe('flying')
    expect(state.alt).toBeGreaterThan(205)
  })
})

describe('traffic', () => {
  const me = { lat: 31.5, lon: 74.3, alt: 3000 }
  const plane = (id: string, dLatM: number, dAlt = 0): Traffic => ({ id, label: id, lat: 31.5 + dLatM / 111_320, lon: 74.3, alt: 3000 + dAlt, radius: 30 })

  it('hits a plane within reach, misses one well clear', () => {
    expect(hit(me, me, 6, [plane('far', 400), plane('close', 30)])?.id).toBe('close')
    expect(hit(me, me, 6, [plane('above', 0, 300)])).toBeNull()
  })

  it('does not fly through a plane between two frames at high speed', () => {
    const from = { ...me, lat: me.lat - 60 / 111_320 }
    const to = { ...me, lat: me.lat + 60 / 111_320 }
    expect(hit(to, from, 9, [plane('crossed', 0)])?.id).toBe('crossed')
  })

  it('lists the nearest traffic first', () => {
    const list = contacts(me, [plane('b', 5000), plane('a', 1000), plane('gone', 40_000)])
    expect(list.map(c => c.traffic.id)).toEqual(['a', 'b'])
    expect(list[0]!.distance).toBeCloseTo(metresBetween(me, plane('a', 1000)), 0)
  })
})
