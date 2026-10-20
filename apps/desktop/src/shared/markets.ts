/**
 * Markets for the World page's "world trade" panel: stock indices,
 * commodities, crypto, currencies and a few sectors (defence, technology,
 * energy), each with its last month as a sparkline. From Yahoo Finance's
 * chart data (keyless, unofficial: personal use, cached half an hour).
 */

export const MARKET_GROUPS = ['indices', 'commodities', 'crypto', 'currencies', 'defence', 'technology', 'energy'] as const
export type MarketGroup = (typeof MARKET_GROUPS)[number]

export const GROUP_LABEL: Record<MarketGroup, string> = { indices: 'Stock indices', commodities: 'Commodities', crypto: 'Crypto', currencies: 'Currencies', defence: 'Defence', technology: 'Technology', energy: 'Energy' }

export interface Instrument {
  symbol: string
  name: string
  group: MarketGroup
  /** Two-letter country for a flag, where there is one. */
  cc?: string
}

export const INSTRUMENTS: readonly Instrument[] = [
  { symbol: '^GSPC', name: 'S&P 500', group: 'indices', cc: 'us' },
  { symbol: '^NDX', name: 'Nasdaq 100', group: 'indices', cc: 'us' },
  { symbol: '^DJI', name: 'Dow Jones', group: 'indices', cc: 'us' },
  { symbol: '^STOXX50E', name: 'Euro Stoxx 50', group: 'indices', cc: 'eu' },
  { symbol: '^GDAXI', name: 'DAX', group: 'indices', cc: 'de' },
  { symbol: '^FTSE', name: 'FTSE 100', group: 'indices', cc: 'gb' },
  { symbol: '^FCHI', name: 'CAC 40', group: 'indices', cc: 'fr' },
  { symbol: '^N225', name: 'Nikkei 225', group: 'indices', cc: 'jp' },
  { symbol: '^HSI', name: 'Hang Seng', group: 'indices', cc: 'hk' },
  { symbol: '000001.SS', name: 'Shanghai Composite', group: 'indices', cc: 'cn' },
  { symbol: '^BSESN', name: 'Sensex', group: 'indices', cc: 'in' },
  { symbol: 'BZ=F', name: 'Brent crude', group: 'commodities' },
  { symbol: 'CL=F', name: 'WTI crude', group: 'commodities' },
  { symbol: 'NG=F', name: 'Natural gas', group: 'commodities' },
  { symbol: 'GC=F', name: 'Gold', group: 'commodities' },
  { symbol: 'SI=F', name: 'Silver', group: 'commodities' },
  { symbol: 'HG=F', name: 'Copper', group: 'commodities' },
  { symbol: 'ZW=F', name: 'Wheat', group: 'commodities' },
  { symbol: 'BTC-USD', name: 'Bitcoin', group: 'crypto' },
  { symbol: 'ETH-USD', name: 'Ethereum', group: 'crypto' },
  { symbol: 'SOL-USD', name: 'Solana', group: 'crypto' },
  { symbol: 'PKR=X', name: 'USD / PKR', group: 'currencies', cc: 'pk' },
  { symbol: 'EURUSD=X', name: 'EUR / USD', group: 'currencies', cc: 'eu' },
  { symbol: 'GBPUSD=X', name: 'GBP / USD', group: 'currencies', cc: 'gb' },
  { symbol: 'JPY=X', name: 'USD / JPY', group: 'currencies', cc: 'jp' },
  { symbol: 'CNY=X', name: 'USD / CNY', group: 'currencies', cc: 'cn' },
  { symbol: 'INR=X', name: 'USD / INR', group: 'currencies', cc: 'in' },
  { symbol: 'SAR=X', name: 'USD / SAR', group: 'currencies', cc: 'sa' },
  { symbol: 'LMT', name: 'Lockheed Martin', group: 'defence', cc: 'us' },
  { symbol: 'RTX', name: 'RTX', group: 'defence', cc: 'us' },
  { symbol: 'NOC', name: 'Northrop Grumman', group: 'defence', cc: 'us' },
  { symbol: 'BA.L', name: 'BAE Systems', group: 'defence', cc: 'gb' },
  { symbol: 'RHM.DE', name: 'Rheinmetall', group: 'defence', cc: 'de' },
  { symbol: 'NVDA', name: 'NVIDIA', group: 'technology', cc: 'us' },
  { symbol: 'AAPL', name: 'Apple', group: 'technology', cc: 'us' },
  { symbol: 'MSFT', name: 'Microsoft', group: 'technology', cc: 'us' },
  { symbol: 'GOOGL', name: 'Alphabet', group: 'technology', cc: 'us' },
  { symbol: 'TSM', name: 'TSMC', group: 'technology', cc: 'tw' },
  { symbol: 'XOM', name: 'ExxonMobil', group: 'energy', cc: 'us' },
  { symbol: 'SHEL', name: 'Shell', group: 'energy', cc: 'gb' },
  { symbol: '2222.SR', name: 'Saudi Aramco', group: 'energy', cc: 'sa' },
]

export interface Quote {
  symbol: string
  name: string
  group: MarketGroup
  cc?: string | undefined
  currency: string
  price: number
  /** Change today, percent. */
  changePct: number
  /** Daily closes over the last month, oldest first. */
  closes: number[]
}

/** Yahoo's v8 chart answer for one instrument. */
export const parseYahooChart = (j: unknown, ins: Instrument): Quote | null => {
  const r = (j as { chart?: { result?: { meta?: Record<string, unknown>; indicators?: { quote?: { close?: (number | null)[] }[] } }[] } })?.chart?.result?.[0]
  const meta = r?.meta
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null
  const closes = (r.indicators?.quote?.[0]?.close ?? []).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  const prev = typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose : closes.at(-2)
  const pct = typeof meta.regularMarketChangePercent === 'number' ? meta.regularMarketChangePercent : prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0
  return { symbol: ins.symbol, name: ins.name, group: ins.group, cc: ins.cc, currency: typeof meta.currency === 'string' ? meta.currency : '', price: meta.regularMarketPrice, changePct: pct, closes }
}

/** A sparkline path for a box of w by h. */
export const sparkPath = (values: readonly number[], w: number, h: number): string => {
  if (values.length < 2) return ''
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  return values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)},${(h - 1 - ((v - lo) / span) * (h - 2)).toFixed(1)}`).join(' ')
}
