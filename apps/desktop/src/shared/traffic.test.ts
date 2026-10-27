import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { fitIncidentBox, flowColor, parseIncidents, roadsFromTile, tilesFor, TrafficEngine } from './traffic.ts'

/** A real TomTom flow tile (central London, zoom 13), saved once. */
const fixture = JSON.parse(readFileSync(new URL('./traffic.fixture.json', import.meta.url), 'utf8')) as { z: number; x: number; y: number; b64: string }
const bytes = Uint8Array.from(Buffer.from(fixture.b64, 'base64'))

describe('traffic', () => {
  it('reads roads and their flow out of a real tile', () => {
    const roads = roadsFromTile(bytes, fixture)
    expect(roads.length).toBeGreaterThan(50)
    for (const r of roads.slice(0, 50)) {
      expect(r.level).toBeGreaterThanOrEqual(0)
      expect(r.level).toBeLessThanOrEqual(1)
      // Inside (or just around) central London.
      for (const [lon, lat] of r.path) {
        expect(lon).toBeGreaterThan(-0.25)
        expect(lon).toBeLessThan(0.0)
        expect(lat).toBeGreaterThan(51.4)
        expect(lat).toBeLessThan(51.6)
      }
    }
  })

  it('moves cars along the roads, more where it jams', () => {
    const e = new TrafficEngine()
    e.setRoads([
      { path: [[0, 0], [0.01, 0]], level: 1, rank: 2, closed: false },
      { path: [[0, 0.01], [0.01, 0.01]], level: 0.1, rank: 2, closed: false },
      { path: [[0, 0.02], [0.01, 0.02]], level: 0.5, rank: 2, closed: true },
    ])
    const per = [0, 0, 0]
    for (const c of e.cars) per[c.lane]!++
    expect(e.lanes).toHaveLength(2)
    expect(per[1]).toBeGreaterThan(per[0]!)
    const c = e.cars[0]!
    const before = e.place(c).lon
    e.step(1, 1)
    expect(e.place(c).lon).not.toBe(before)
    expect(e.place(c).heading).toBeCloseTo(0, 1)
  })

  it('picks tiles, colours and incident boxes', () => {
    expect(tilesFor({ west: -0.2, south: 51.45, east: 0, north: 51.55 }, 13).length).toBeGreaterThan(1)
    expect(tilesFor({ west: -10, south: 40, east: 10, north: 60 }, 13, 9)).toHaveLength(9)
    expect(flowColor(0.9)).toBe('#22c55e')
    expect(flowColor(0.1)).toBe('#ef4444')
    const b = fitIncidentBox({ west: 0, south: 0, east: 5, north: 5 })
    expect((b.north - b.south) * 111 * (b.east - b.west) * 111).toBeLessThan(10_000)
  })

  it('reads incidents', () => {
    const list = parseIncidents({
      incidents: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-0.1, 51.5], [-0.11, 51.51]] }, properties: { id: 'a', iconCategory: 1, magnitudeOfDelay: 3, events: [{ description: 'Accident' }], from: 'A', to: 'B', roadNumbers: ['A4'], delay: 600, length: 1200, startTime: '2026-10-20T08:00:00Z', endTime: null } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-0.12, 51.52] }, properties: { iconCategory: 9 } },
        { bad: true },
      ],
    })
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ kind: 'accident', magnitude: 3, road: 'A4', delay: 600, lat: 51.5, lon: -0.1 })
    expect(list[1]!.kind).toBe('roadworks')
  })
})
