import { describe, expect, it } from 'vitest'

import { newsSeverity, placeHeadline } from './newsgeo.ts'

describe('placeHeadline', () => {
  it('finds the city in a headline', () => {
    expect(placeHeadline('Heavy rain floods streets in Karachi')).toMatchObject({ place: 'Karachi', precision: 'city', country: 'PK' })
  })

  it('prefers a city over the country it is in', () => {
    expect(placeHeadline('Pakistan: smog closes schools in Lahore')).toMatchObject({ place: 'Lahore', precision: 'city' })
  })

  it('reads demonyms and short names for countries', () => {
    expect(placeHeadline('Iranian officials reject the proposal')).toMatchObject({ place: 'Iran', precision: 'country' })
    expect(placeHeadline('UK inflation falls again')).toMatchObject({ place: 'United Kingdom', country: 'GB' })
  })

  it('puts conflict areas and seas where they are', () => {
    expect(placeHeadline('Aid trucks enter Gaza after weeks of delay')).toMatchObject({ place: 'Gaza', precision: 'region', lat: 31.42 })
    expect(placeHeadline('Tanker held near the Strait of Hormuz')).toMatchObject({ place: 'Strait of Hormuz' })
  })

  it('sends an ambiguous city to the country the text mentions', () => {
    expect(placeHeadline('Hyderabad, India: tech firms expand')?.country).toBe('IN')
    expect(placeHeadline('Hyderabad in Pakistan sees record heat')?.country).toBe('PK')
  })

  it('does not take everyday words for places, and falls back to the summary', () => {
    expect(placeHeadline('A nice day for a walk')).toBeNull()
    expect(placeHeadline('Markets rally on rate hopes', 'Shares rose in Tokyo and Seoul on Monday.')).toMatchObject({ place: 'Tokyo' })
  })
})

describe('newsSeverity', () => {
  it('weighs the words', () => {
    expect(newsSeverity('Earthquake kills 120 in eastern Turkey')).toBe(10)
    expect(newsSeverity('Missile strike hits port')).toBe(7)
    expect(newsSeverity('Protests continue in the capital')).toBe(5)
    expect(newsSeverity('Leaders meet for trade talks')).toBe(2)
  })
})
