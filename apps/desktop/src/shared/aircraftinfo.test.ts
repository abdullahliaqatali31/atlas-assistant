import { describe, expect, it } from 'vitest'

import { isHex, parseAdsbdbAircraft, parseOpenSkyTrack } from './world.ts'

describe('the aircraft card', () => {
  it('reads the airframe from adsbdb, keeping only https photos', () => {
    const a = parseAdsbdbAircraft({ response: { aircraft: { type: '737NG 8AS/W', icao_type: 'B738', manufacturer: 'Boeing', registration: 'EI-EVJ', registered_owner: 'Ryanair', registered_owner_country_name: 'Ireland', url_photo: 'https://image.airport-data.com/aircraft/001584193.jpg', url_photo_thumbnail: 'http://insecure/x.jpg' } } })
    expect(a).toEqual({ type: '737NG 8AS/W', icaoType: 'B738', manufacturer: 'Boeing', registration: 'EI-EVJ', owner: 'Ryanair', country: 'Ireland', photo: 'https://image.airport-data.com/aircraft/001584193.jpg', photoThumb: null })
    expect(parseAdsbdbAircraft({ response: 'unknown aircraft' })).toBeNull()
  })

  it('reads the flight so far from OpenSky, in milliseconds', () => {
    const t = parseOpenSkyTrack({ icao24: '4ca9d2', callsign: 'RYR28KJ ', startTime: 1792440000, path: [[1792440000, 51.4, -0.4, 0, 90, true], [1792440600, 51.5, 0.5, 9000, 92, false], ['bad']] })
    expect(t).toEqual({ callsign: 'RYR28KJ', start: 1792440000000, points: [{ t: 1792440000000, altM: 0, ground: true }, { t: 1792440600000, altM: 9000, ground: false }] })
    expect(parseOpenSkyTrack({ path: [[1, 0, 0, 0]] })).toBeNull()
    expect(parseOpenSkyTrack(null)).toBeNull()
  })

  it('accepts only six-digit hex ids for the lookups', () => {
    expect(isHex('4CA9D2')).toBe(true)
    expect(isHex('4ca9d')).toBe(false)
    expect(isHex('../x12')).toBe(false)
  })
})

describe('Wikidata for ships and satellites', () => {
  it('reads one notable thing, joining several operators, with a Commons thumbnail and credit page', async () => {
    const { parseWikiThing, isWikiId } = await import('./world.ts')
    const row = (op: string) => ({ item: { value: 'http://www.wikidata.org/entity/Q25271' }, itemLabel: { value: 'International Space Station' }, itemDescription: { value: 'modular space station' }, image: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/ISS%20(cropped).jpg' }, operatorLabel: { value: op }, launch: { value: '1998-11-20T00:00:00Z' } })
    expect(parseWikiThing({ results: { bindings: [row('NASA'), row('ESA'), row('NASA')] } })).toEqual({ label: 'International Space Station', description: 'modular space station', image: 'https://commons.wikimedia.org/wiki/Special:FilePath/ISS%20(cropped).jpg?width=480', imagePage: 'https://commons.wikimedia.org/wiki/File:ISS%20(cropped).jpg', operator: 'NASA, ESA', country: '', since: '1998-11-20', wikidata: 'https://www.wikidata.org/entity/Q25271' })
    expect(parseWikiThing({ results: { bindings: [] } })).toBeNull()
    expect([isWikiId('ship', '353136000'), isWikiId('ship', '35313'), isWikiId('satellite', '25544'), isWikiId('satellite', '25544"}'), isWikiId('x', '1')]).toEqual([true, false, true, false, false])
  })
})
