import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '@assistant/memory'
import { evaluate } from '@assistant/policy'
import { DEFAULT_RULES } from '@assistant/runtime'
import { fixedClock, HOUR, MINUTE } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { kmBetween, parseFlights } from '../shared/world.ts'
import { parseAir, parseEvents, parseGeocode, parseNews, parseQuakes, parseWeather, quakeMatters, WORLD_RULES, WorldWatch } from './world.ts'

const NOW = Date.parse('2026-10-18T08:00:00Z')

// Sample responses, shaped like the real APIs.
const GEO = { results: [{ name: 'Lahore', latitude: 31.558, longitude: 74.3507, country: 'Pakistan', timezone: 'Asia/Karachi' }] }
const WEATHER = {
  current: { temperature_2m: 29.2, apparent_temperature: 30.6, relative_humidity_2m: 41, weather_code: 0, wind_speed_10m: 4.2, wind_gusts_10m: 9 },
  daily: { time: ['2026-10-18', '2026-10-19'], temperature_2m_max: [33, 44], temperature_2m_min: [19, 25], precipitation_sum: [0, 0], wind_gusts_10m_max: [20, 30], weather_code: [0, 3] },
}
const AIR = { current: { us_aqi: 212, pm2_5: 160.2, pm10: 210 } }
const QUAKES = {
  features: [
    { id: 'near', properties: { mag: 5.1, place: '40 km N of Kasur', time: NOW - 20 * MINUTE, url: 'https://earthquake.usgs.gov/x', tsunami: 0 }, geometry: { coordinates: [74.45, 31.45, 10] } },
    { id: 'far', properties: { mag: 5.0, place: 'Alaska', time: NOW - 10 * MINUTE, url: 'https://earthquake.usgs.gov/y', tsunami: 0 }, geometry: { coordinates: [-150, 60, 30] } },
    { id: 'old', properties: { mag: 6.0, place: 'near Lahore', time: NOW - 12 * HOUR, url: 'https://earthquake.usgs.gov/z', tsunami: 0 }, geometry: { coordinates: [74.3, 31.6, 10] } },
  ],
}
const EVENTS = {
  events: [
    { id: 'EONET_1', title: 'Fire near Sheikhupura', link: 'https://eonet.gsfc.nasa.gov/1', categories: [{ id: 'wildfires', title: 'Wildfires' }], geometry: [{ date: '2026-10-18T02:00:00Z', type: 'Point', coordinates: [74.0, 31.7] }] },
    { id: 'EONET_2', title: 'Tropical Cyclone 01P', link: 'https://eonet.gsfc.nasa.gov/2', categories: [{ id: 'severeStorms', title: 'Severe Storms' }], geometry: [{ date: '2026-10-16T06:00:00Z', type: 'Point', coordinates: [-163.3, -10.8] }] },
  ],
}
// GDACS EVENTS4APP, trimmed: a red flood 150 km from Lahore, a green fire nearby, an orange cyclone far away, a red quake (USGS covers quakes), an old one.
const gd = (type: string, id: number, alert: string, lon: number, lat: number, name: string, current = 'true') => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: {
    eventtype: type,
    eventid: id,
    name,
    alertlevel: alert,
    iscurrent: current,
    country: 'Pakistan',
    fromdate: '2026-10-16T00:00:00',
    todate: '2026-10-18T06:00:00',
    url: { report: `https://www.gdacs.org/report.aspx?eventid=${id}` },
    severitydata: { severitytext: type === 'TC' ? 'Hurricane/Typhoon > 74 mph (maximum wind speed of 194 km/h)' : 'Major flooding' },
  },
})
const GDACS = {
  type: 'FeatureCollection',
  features: [
    gd('WF', 1, 'Green', 74.2, 31.4, 'Forest fires in Pakistan'),
    gd('FL', 2, 'Red', 73.0, 32.2, 'Flood in Punjab'),
    gd('TC', 3, 'Orange', 142.3, 13.1, 'Tropical Cyclone CHAMPI-26'),
    gd('EQ', 4, 'Red', 74.3, 31.5, 'Earthquake in Pakistan'),
    gd('FL', 5, 'Red', 74.3, 31.5, 'Old flood', 'false'),
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { eventtype: 'FL', iscurrent: 'true' } },
  ],
}
const NEWS = {
  articles: [
    { url: 'https://dawn.com/a', title: 'Smog returns to Lahore', seendate: '20261018T070000Z', domain: 'dawn.com', language: 'English' },
    { url: 'https://dawn.com/a2', title: 'Smog returns to Lahore', seendate: '20261018T070500Z', domain: 'dawn.com', language: 'English' },
    { url: 'http://insecure.example/x', title: 'Not https', seendate: '20261018T070000Z', domain: 'insecure.example', language: 'English' },
  ],
}

const dirs: string[] = []
const stores: MemoryStore[] = []
afterEach(() => {
  for (const m of stores.splice(0)) m.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const setup = (overrides: Partial<Record<'geo' | 'weather' | 'air' | 'quakes' | 'events' | 'news' | 'gdacs', unknown>> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-world-'))
  dirs.push(dir)
  const clock = fixedClock(NOW)
  const memory = new MemoryStore(join(dir, 'a.db'), clock)
  stores.push(memory)
  const calls: string[] = []
  const sleeps: number[] = []
  const pick = (url: string) => {
    if (url.includes('geocoding-api')) return overrides.geo ?? GEO
    if (url.includes('air-quality-api')) return overrides.air ?? AIR
    if (url.includes('api.open-meteo.com')) return overrides.weather ?? WEATHER
    if (url.includes('earthquake.usgs.gov')) return overrides.quakes ?? QUAKES
    if (url.includes('eonet')) return overrides.events ?? EVENTS
    if (url.includes('gdacs.org')) return overrides.gdacs ?? GDACS
    if (url.includes('gdeltproject')) return overrides.news ?? NEWS
    throw new Error(`unexpected ${url}`)
  }
  const watch = new WorldWatch({
    memory,
    now: () => clock.now(),
    fetchJson: async url => {
      calls.push(url)
      const r = pick(url)
      if (r instanceof Error) throw r
      return r
    },
    sleep: async ms => {
      sleeps.push(ms)
    },
  })
  return { watch, memory, clock, calls, sleeps }
}

describe('parsers', () => {
  it('read each source’s shape', () => {
    expect(parseGeocode(GEO)).toEqual({ name: 'Lahore', country: 'Pakistan', lat: 31.558, lon: 74.3507, timezone: 'Asia/Karachi' })
    expect(parseGeocode({ results: [] })).toBeNull()
    const w = parseWeather(WEATHER)!
    expect(w.summary).toBe('Clear')
    expect(w.days[1]).toMatchObject({ date: '2026-10-19', max: 44, summary: 'Overcast' })
    expect(parseAir(AIR)).toEqual({ aqi: 212, pm25: 160.2, pm10: 210, level: 'Very unhealthy' })
    expect(parseQuakes(QUAKES)[0]).toMatchObject({ id: 'near', mag: 5.1, lat: 31.45, lon: 74.45, depthKm: 10 })
    expect(parseEvents(EVENTS)[0]).toMatchObject({ id: 'EONET_1', category: 'Wildfires', lat: 31.7, lon: 74 })
    const news = parseNews(NEWS)
    expect(news).toHaveLength(1)
    expect(news[0]).toMatchObject({ title: 'Smog returns to Lahore', time: Date.parse('2026-10-18T07:00:00Z') })
  })

  it('reads live flights from adsb.lol, marking military aircraft and planes on the ground', () => {
    const flights = parseFlights({
      ac: [
        { hex: '491d88', flight: 'NJE576G ', r: 'CS-GLH', t: 'GLEX', lat: 31.9, lon: 74.1, alt_baro: 40000, gs: 472.6, track: 348.4 },
        { hex: 'ae1234', flight: 'RCH123', t: 'C17', lat: 30.1, lon: 72.2, alt_baro: 'ground', gs: 0, true_heading: 90, dbFlags: 1 },
        { hex: 'nopos', flight: 'X' },
      ],
    })
    expect(flights).toHaveLength(2)
    expect(flights[0]).toMatchObject({ callsign: 'NJE576G', registration: 'CS-GLH', type: 'GLEX', altitude: 40000, track: 348.4, military: false })
    expect(flights[1]).toMatchObject({ altitude: null, track: 90, military: true })
  })

  it('measures distance and judges which quakes matter', () => {
    expect(Math.round(kmBetween({ lat: 31.558, lon: 74.35 }, { lat: 24.86, lon: 67.0 }))).toBeGreaterThan(1000)
    expect(quakeMatters({ mag: 5.1 } as never, 20)).toBe(true)
    expect(quakeMatters({ mag: 4.0 } as never, 300)).toBe(false)
    expect(quakeMatters({ mag: 3.6 } as never, 60)).toBe(true)
    expect(quakeMatters({ mag: 6.8 } as never, 900)).toBe(true)
  })
})

describe('WorldWatch', () => {
  it('adds places by name, refreshes everything, and spaces out news requests', async () => {
    const { watch, calls, sleeps } = setup()
    await watch.addPlace('Lahore')
    await watch.refresh()
    await watch.addPlace('Riyadh') // same geocode result here: kept as one place
    expect(watch.places()).toHaveLength(1)
    const s = watch.snapshot()
    expect(s.places[0]!.weather?.temp).toBe(29.2)
    expect(s.places[0]!.air?.aqi).toBe(212)
    expect(s.places[0]!.news[0]!.title).toBe('Smog returns to Lahore')
    // Nearby lists the last two days by distance (the far Alaska quake is not near); alerts only use the last six hours.
    expect(s.places[0]!.nearby.map(n => n.id)).toEqual(expect.arrayContaining(['near', 'old', 'EONET_1']))
    expect(s.places[0]!.nearby.map(n => n.id)).not.toContain('far')
    expect(calls.some(u => u.includes('gdeltproject'))).toBe(true)
    expect(sleeps.every(ms => ms >= 5000)).toBe(true)
  })

  it('keeps going when a source fails, and says which', async () => {
    const { watch } = setup({ quakes: new Error('HTTP 503') })
    await watch.addPlace('Lahore')
    await watch.refresh()
    const s = watch.snapshot()
    expect(s.problems.join(' ')).toMatch(/earthquakes \(USGS\): HTTP 503/)
    expect(s.places[0]!.weather).not.toBeNull()
  })

  it('backs off when GDELT is busy, and fills in from the owner’s own feeds', async () => {
    const { watch, memory, clock, calls } = setup({ news: new Error('HTTP 429') })
    const withFeeds = new WorldWatch({
      memory,
      now: () => clock.now(),
      fetchJson: async url => {
        calls.push(url)
        if (url.includes('gdeltproject')) throw new Error('HTTP 429')
        if (url.includes('geocoding')) return GEO
        if (url.includes('air-quality')) return { current: { us_aqi: 872, pm2_5: 210, pm10: 900 } }
        if (url.includes('open-meteo')) return WEATHER
        if (url.includes('usgs')) return QUAKES
        return EVENTS
      },
      sleep: async () => {},
      localNews: place => (place === 'Lahore' ? [{ title: 'Lahore metro extended', url: 'https://www.dawn.com/m', domain: 'Dawn', time: NOW - HOUR, language: '' }] : []),
    })
    void watch
    await withFeeds.addPlace('Lahore')
    await withFeeds.refresh(true)
    const s = withFeeds.snapshot()
    expect(s.places[0]!.news.map(n => n.title)).toEqual(['Lahore metro extended'])
    expect(s.places[0]!.air).toMatchObject({ aqi: 500, level: 'Hazardous' })
    const before = calls.filter(u => u.includes('gdeltproject')).length
    await withFeeds.refresh(true)
    expect(calls.filter(u => u.includes('gdeltproject')).length).toBe(before)
    expect(withFeeds.snapshot().problems.join(' ')).toMatch(/GDELT\): busy/)
  })

  it('raises each alert once: near quake, nearby fire, bad air, extreme heat; not the far or old quake', async () => {
    const { watch, clock } = setup()
    await watch.addPlace('Lahore')
    await watch.refresh()
    const items = watch.agenda(clock.now())
    const titles = items.map(i => i.title)
    expect(titles).toEqual(expect.arrayContaining(['Earthquake near Lahore', 'Wildfires near Lahore', 'Bad air in Lahore', 'Extreme weather in Lahore']))
    expect(items.filter(i => i.title.startsWith('Earthquake'))).toHaveLength(1)
    expect(items.find(i => i.title === 'Extreme weather in Lahore')!.instruction).toContain('up to 44°C')
    expect(watch.agenda(clock.now() + MINUTE)).toHaveLength(0)
  })

  it('raises an orange or red GDACS alert near a place once; not green, far, earthquake or old ones', async () => {
    const { watch, clock } = setup()
    await watch.addPlace('Lahore')
    await watch.refresh()
    const disasters = watch.agenda(clock.now()).filter(i => i.key.startsWith('world:disaster:'))
    expect(disasters.map(i => i.title)).toEqual(['Flood near Lahore'])
    expect(disasters[0]!.instruction).toContain('red alert for Flood in Punjab')
    expect(disasters[0]!.priority).toBe(80)
    // On the map: current points only, red first.
    expect(watch.snapshot().disasters.map(d => d.name)).toEqual(['Flood in Punjab', 'Earthquake in Pakistan', 'Tropical Cyclone CHAMPI-26', 'Forest fires in Pakistan'])
    expect(watch.snapshot().places[0]!.nearby.some(n => n.title === 'GDACS red alert: Flood in Punjab')).toBe(true)
  })

  it('answers the assistant in plain words, and watching places needs no confirmation', async () => {
    const { watch } = setup()
    const tools = Object.fromEntries(watch.tools().map(t => [t.name, t]))
    expect(await tools.world_now!.run({})).toBe('No places watched yet.')
    expect(await tools.world_place_add!.run({ name: 'Lahore' })).toMatch(/Watching Lahore, Pakistan/)
    await watch.refresh()
    const text = await tools.world_now!.run({ place: 'lahore' })
    expect(text).toContain('Weather now 29°C')
    expect(text).toContain('Air quality: US AQI 212 (Very unhealthy)')
    expect(text).toContain('News: Smog returns to Lahore')
    expect(await tools.world_place_remove!.run({ name: 'Lahore' })).toBe('Stopped watching Lahore.')
    const rules = [...DEFAULT_RULES, ...WORLD_RULES]
    expect(evaluate({ tool: 'world_place_add', actionClass: 'modify' }, rules, NOW).effect).toBe('allow')
    expect(evaluate({ tool: 'world_now', actionClass: 'observe' }, rules, NOW).effect).toBe('allow')
  })
})
