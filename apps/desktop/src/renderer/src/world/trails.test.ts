import { describe, expect, it } from 'vitest'

import { aircraftName, squawkMeaning } from '../../../shared/aircraft.ts'
import { Trails } from './trails.ts'

describe('Trails', () => {
  it('keeps each item’s path in order, skipping repeats', () => {
    let t = 0
    const trails = new Trails(() => t)
    trails.add([{ id: 'a', lon: 10, lat: 50 }])
    t += 20_000
    trails.add([{ id: 'a', lon: 10, lat: 50 }])
    t += 20_000
    trails.add([{ id: 'a', lon: 11, lat: 50.5 }])
    expect(trails.path('a')).toEqual([
      [10, 50],
      [11, 50.5],
    ])
    expect(trails.path('nobody')).toEqual([])
  })

  it('forgets points older than half an hour', () => {
    let t = 0
    const trails = new Trails(() => t)
    trails.add([{ id: 'a', lon: 0, lat: 0 }])
    t += 31 * 60_000
    trails.add([{ id: 'a', lon: 1, lat: 1 }])
    expect(trails.path('a')).toEqual([[1, 1]])
  })

  it('keeps a path over the Pacific continuous', () => {
    let t = 0
    const trails = new Trails(() => t)
    trails.add([{ id: 'a', lon: 179.5, lat: 40 }])
    t += 20_000
    trails.add([{ id: 'a', lon: -179.5, lat: 40 }])
    expect(trails.path('a')).toEqual([
      [179.5, 40],
      [180.5, 40],
    ])
  })
})

describe('aircraft names', () => {
  it('turns type codes into plain names and reads emergency squawks', () => {
    expect(aircraftName('b77w')).toBe('Boeing 777-300ER')
    expect(aircraftName('ZZZZ')).toBe('')
    expect(squawkMeaning('7700')).toBe('General emergency')
    expect(squawkMeaning('2237')).toBe('')
  })
})
