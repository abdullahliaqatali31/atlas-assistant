import { describe, expect, it } from 'vitest'

import { classify, countryStats, oblastName, parseGdeltExport, rollUpAlerts, severityOf, titleFromUrl } from './intel.ts'

const row = (o: { id?: string; root?: string; mentions?: number; fips?: string; lat?: number; lon?: number; url: string; added?: string }) => {
  const c = Array.from({ length: 61 }, () => '')
  c[0] = o.id ?? '1'
  c[28] = o.root ?? '19'
  c[31] = String(o.mentions ?? 1)
  c[52] = 'Kharkiv, Kharkivs\'ka Oblast\', Ukraine'
  c[53] = o.fips ?? 'UP'
  c[56] = String(o.lat ?? 49.98)
  c[57] = String(o.lon ?? 36.25)
  c[59] = o.added ?? '20261020014500'
  c[60] = o.url
  return c.join('\t')
}
const COUNTRIES = new Map([['UP', { iso: 'UA', name: 'Ukraine' }], ['RS', { iso: 'RU', name: 'Russia' }]])

describe('conflict events from GDELT', () => {
  it('keeps conflict, drops crime, courts and sport, and names the kind', () => {
    expect(classify('https://x.com/news/russian-drones-hit-kharkiv-overnight', '19')).toBe('drones')
    expect(classify('https://x.com/ukraine-war-briefing-interceptor-missile-deliveries', '19')).toBe('missiles')
    expect(classify('https://x.com/israeli-airstrikes-on-southern-lebanon', '19')).toBe('airstrikes')
    expect(classify('https://x.com/troops-advance-near-pokrovsk-front-line', '19')).toBe('ground')
    expect(classify('https://x.com/hezbollah-says-ceasefire-holding', '18')).toBe('other')
    expect(classify('https://x.com/lapd-seeks-suv-driver-who-killed-pedestrian', '19')).toBeNull()
    expect(classify('https://x.com/ipswich-sexual-assault-bail-denied', '18')).toBeNull()
    expect(classify('https://x.com/teen-killed-in-shooting', '19')).toBeNull()
    expect(classify('https://x.com/protesters-clash-with-police', '14')).toBeNull()
    expect(classify('https://x.com/protesters-fill-the-capital-square', '14')).toBe('protest')
    expect(classify('https://x.com/hyundai-demonstrate-autonomous-vessel', '14')).toBeNull()
    expect(classify('not a url', '19')).toBeNull()
  })

  it('makes a title from the article address', () => {
    expect(titleFromUrl('https://www.theguardian.com/world/2026/oct/20/russia-strikes-28-energy-facilities-ukraine')).toBe('Russia strikes 28 energy facilities ukraine')
    expect(titleFromUrl('https://x.com/story/9371565/missile-hits-port-city-overnight/')).toBe('Missile hits port city overnight')
    expect(titleFromUrl('https://x.com/a/123456')).toBe('')
  })

  it('reads an export: one event per article (most mentions wins), FIPS to ISO, severity by reach', () => {
    const tsv = [
      row({ id: '1', mentions: 2, url: 'https://a.com/russian-drones-hit-kharkiv' }),
      row({ id: '2', mentions: 25, url: 'https://a.com/russian-drones-hit-kharkiv' }),
      row({ id: '3', url: 'https://b.com/court-case-adjourned-again' }),
      row({ id: '4', root: '04', url: 'https://c.com/missile-talks' }),
      row({ id: '5', fips: 'XX', lat: 0, lon: 0, url: 'https://d.com/troops-on-the-border' }),
    ].join('\n')
    const ev = parseGdeltExport(tsv, COUNTRIES)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ id: '2', country: 'UA', countryName: 'Ukraine', category: 'drones', severity: 4, mentions: 25, source: 'a.com', title: 'Russian drones hit kharkiv', at: Date.UTC(2026, 9, 20, 1, 45, 0) })
    expect([severityOf(1), severityOf(3), severityOf(8), severityOf(20)]).toEqual([1, 2, 3, 4])
  })

  it('counts by country, most first, with categories', () => {
    const e = (country: string, category: 'drones' | 'ground') => ({ id: '', title: '', url: '', source: '', at: 0, lat: 0, lon: 0, place: '', country, countryName: country, category, severity: 1 as const, mentions: 1 })
    expect(countryStats([e('UA', 'drones'), e('RU', 'ground'), e('UA', 'ground'), e('', 'drones')])).toEqual([
      { iso: 'UA', name: 'UA', count: 2, byCategory: { drones: 1, ground: 1 } },
      { iso: 'RU', name: 'RU', count: 1, byCategory: { ground: 1 } },
    ])
  })
})

describe('Ukraine air-raid alerts', () => {
  const regions = {
    states: [
      { regionId: '22', regionName: 'Харківська область', regionType: 'State', regionChildIds: [{ regionId: '120', regionName: 'Харківський район', regionType: 'District', regionChildIds: [{ regionId: '1300', regionType: 'Community', regionChildIds: [] }] }] },
      { regionId: '16', regionName: 'Луганська область', regionType: 'State', regionChildIds: [] },
      { regionId: '31', regionName: 'м. Київ', regionType: 'State', regionChildIds: [] },
    ],
  }
  it('rolls districts and communities up to their oblast; an oblast-wide alert is "full"', () => {
    const alerts = [
      { regionId: '120', regionType: 'District', lastUpdate: '2026-10-20T01:00:00Z', activeAlerts: [{ type: 'AIR' }] },
      { regionId: '1300', regionType: 'Community', lastUpdate: '2026-10-20T00:30:00Z', activeAlerts: [{ type: 'AIR' }] },
      { regionId: '16', regionType: 'State', lastUpdate: '2022-04-04T16:45:00Z', activeAlerts: [{ type: 'AIR' }] },
      { regionId: '31', regionType: 'State', lastUpdate: '2026-10-20T01:00:00Z', activeAlerts: [] },
      { regionId: '999', regionType: 'District', activeAlerts: [{ type: 'AIR' }] },
    ]
    expect(rollUpAlerts(alerts, regions)).toEqual([
      { name: 'Kharkiv Oblast', level: 'partial', since: Date.parse('2026-10-20T00:30:00Z'), parts: 2 },
      { name: 'Luhansk Oblast', level: 'full', since: Date.parse('2022-04-04T16:45:00Z'), parts: 0 },
    ])
    expect(rollUpAlerts(null, null)).toEqual([])
  })
  it('names oblasts as the boundaries do', () => {
    expect([oblastName('Харківська область'), oblastName('м. Київ'), oblastName('Атлантида')]).toEqual(['Kharkiv Oblast', 'Kyiv', null])
  })
})
