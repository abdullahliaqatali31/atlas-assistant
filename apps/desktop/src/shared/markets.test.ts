import { describe, expect, it } from 'vitest'

import { INSTRUMENTS, parseYahooChart, sparkPath } from './markets.ts'

describe('markets', () => {
  const spx = INSTRUMENTS[0]!
  it('reads a Yahoo chart: price, today’s change and the month, skipping gaps', () => {
    const q = parseYahooChart({ chart: { result: [{ meta: { currency: 'USD', regularMarketPrice: 7690.73, regularMarketChangePercent: 0.409 }, indicators: { quote: [{ close: [7744.06, null, 7659.44, 7690.73] }] } }] } }, spx)
    expect(q).toEqual({ symbol: '^GSPC', name: 'S&P 500', group: 'indices', cc: 'us', currency: 'USD', price: 7690.73, changePct: 0.409, closes: [7744.06, 7659.44, 7690.73] })
  })
  it('works out today’s change from the previous close when Yahoo leaves it out', () => {
    const q = parseYahooChart({ chart: { result: [{ meta: { regularMarketPrice: 110, chartPreviousClose: 100 }, indicators: { quote: [{ close: [100, 110] }] } }] } }, spx)
    expect(q?.changePct).toBeCloseTo(10)
    expect(parseYahooChart({ chart: { result: [] } }, spx)).toBeNull()
  })
  it('draws a sparkline inside its box', () => {
    expect(sparkPath([1, 3, 2], 100, 20)).toBe('M0.0,19.0 L50.0,1.0 L100.0,10.0')
    expect(sparkPath([5], 100, 20)).toBe('')
  })
  it('has unique symbols', () => {
    expect(new Set(INSTRUMENTS.map(i => i.symbol)).size).toBe(INSTRUMENTS.length)
  })
})
