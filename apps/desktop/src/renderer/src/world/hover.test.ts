import { describe, expect, it } from 'vitest'

import { EMPTY_WORLD, type WorldSnapshot } from '../../../shared/world.ts'
import type { FC } from './geo.ts'
import { hoverInfo, nearbyItems, shortAge } from './hover.ts'

const NOW = Date.UTC(2026, 9, 18, 12)
const HOUR = 3_600_000

const fc = (items: { lon: number; lat: number; title: string }[]): FC => ({
  type: 'FeatureCollection',
  features: items.map(i => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [i.lon, i.lat] }, properties: { title: i.title } })),
})

describe('shortAge', () => {
  it('reads like a map label', () => {
    expect(shortAge(NOW - 20_000, NOW)).toBe('now')
    expect(shortAge(NOW - 12 * 60_000, NOW)).toBe('12 min')
    expect(shortAge(NOW - 3 * HOUR, NOW)).toBe('3 h')
    expect(shortAge(NOW - 10 * 24 * HOUR, NOW)).toBe('10 d')
    // A clock slightly ahead never shows a negative age.
    expect(shortAge(NOW + 60_000, NOW)).toBe('now')
  })
})

describe('hoverInfo', () => {
  it('splits a natural event into its category and name, like "Wildfire · 10 d"', () => {
    const h = hoverInfo('events', { title: 'Wildfires: Craig Lake 1, Baraga, Michigan', color: '#f97316', time: NOW - 10 * 24 * HOUR }, EMPTY_WORLD, NOW)
    expect(h).toMatchObject({ kind: 'WILDFIRES', title: 'Craig Lake 1, Baraga, Michigan', color: '#f97316' })
    expect(h.facts).toEqual(['Reported 10 d ago'])
  })

  it('leads a quake with its magnitude and place', () => {
    const h = hoverInfo('quakes', { title: 'M5.2 · 40 km SW of Town', mag: 5.2, time: NOW - 2 * HOUR }, EMPTY_WORLD, NOW)
    expect(h).toMatchObject({ kind: 'EARTHQUAKE', title: '40 km SW of Town', facts: ['Magnitude 5.2', '2 h ago'] })
  })

  it('shows a watched place’s weather and air', () => {
    const world: WorldSnapshot = {
      ...EMPTY_WORLD,
      places: [
        {
          place: { id: 'p1', name: 'Karachi', lat: 24.86, lon: 67.0, country: 'Pakistan' },
          weather: { temp: 31.4, feels: 34, wind: 12, humidity: 60, code: 1, summary: 'Mainly clear', days: [] },
          air: { aqi: 162, pm25: 70, pm10: 120, level: 'Unhealthy' },
          news: [],
          nearby: [],
        },
      ],
    } as unknown as WorldSnapshot
    const h = hoverInfo('places', { id: 'p1', title: 'Karachi' }, world, NOW)
    expect(h.facts).toEqual(['31° · Mainly clear', 'Air 162 · Unhealthy'])
  })

  it('gives a camera card its id for the live frame', () => {
    expect(hoverInfo('cameras', { id: 'tfl-1', title: 'A40 Westway', source: 'TfL JamCam' }, EMPTY_WORLD, NOW)).toMatchObject({ cameraId: 'tfl-1', facts: ['TfL JamCam'] })
  })

  it('uses the flight’s own colour (military flights are red)', () => {
    const h = hoverInfo('flights', { title: 'RCH123 · C17 · military', detail: '31,000 ft · 450 kt', color: '#ef4444' }, EMPTY_WORLD, NOW)
    expect(h).toMatchObject({ kind: 'FLIGHT', color: '#ef4444', facts: ['31,000 ft · 450 kt'] })
  })
})

describe('nearbyItems', () => {
  const sources = {
    quakes: fc([{ lon: 67.1, lat: 24.9, title: 'M4.5 · near Karachi' }]),
    cameras: fc([{ lon: 67.0, lat: 24.86, title: 'Here' }]),
    flights: fc([{ lon: 70, lat: 30, title: 'far away' }]),
    satellites: fc([{ lon: 67.0, lat: 24.86, title: 'ISS' }]),
  }

  it('lists what is close, nearest first, without satellites', () => {
    const near = nearbyItems([67.0, 24.86], sources, { radiusKm: 50 })
    expect(near.map(n => n.title)).toEqual(['Here', 'M4.5 · near Karachi'])
    expect(near[1]?.km).toBeGreaterThan(5)
  })

  it('leaves out the picked item itself', () => {
    const near = nearbyItems([67.0, 24.86], sources, { radiusKm: 50, exclude: { kind: 'cameras', props: { title: 'Here' } } })
    expect(near.map(n => n.title)).toEqual(['M4.5 · near Karachi'])
  })
})
