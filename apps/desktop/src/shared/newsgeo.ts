/**
 * Puts a news headline where it happens, with no network and no model:
 * a small gazetteer (GeoNames cities over 400k and capitals, country
 * names and demonyms, plus regions headlines name) matched against the
 * headline, then the summary. A city beats a region beats a country; an
 * ambiguous city goes to the country the text mentions. Also a rough
 * 0-10 severity from the words used, for marker size.
 */
import gazetteer from './gazetteer.json' with { type: 'json' }

export interface NewsPlace {
  lat: number
  lon: number
  /** The name as matched ("Karachi", "Gaza", "Pakistan"). */
  place: string
  precision: 'city' | 'region' | 'country'
  /** ISO country code when known. */
  country: string | null
}

/** Places headlines name that are not cities: conflict zones, provinces, seas and straits. */
const REGIONS: [string, number, number, string | null][] = [
  ['Gaza', 31.42, 34.36, 'PS'],
  ['Gaza Strip', 31.42, 34.36, 'PS'],
  ['West Bank', 31.95, 35.3, 'PS'],
  ['Kashmir', 34.08, 74.8, null],
  ['Balochistan', 28.5, 65.1, 'PK'],
  ['Khyber Pakhtunkhwa', 34.0, 71.5, 'PK'],
  ['KP', 34.0, 71.5, 'PK'],
  ['Bombay', 19.073, 72.883, 'IN'],
  ['Calcutta', 22.563, 88.363, 'IN'],
  ['FATA', 33.0, 70.3, 'PK'],
  ['AJK', 33.9, 73.8, 'PK'],
  ['Azad Kashmir', 33.9, 73.8, 'PK'],
  ['Sindh', 25.9, 68.5, 'PK'],
  ['Punjab', 31.2, 72.7, null],
  ['Gilgit-Baltistan', 35.8, 74.9, 'PK'],
  ['Crimea', 45.3, 34.4, 'UA'],
  ['Donbas', 48.0, 37.8, 'UA'],
  ['Kharkiv', 49.99, 36.23, 'UA'],
  ['Red Sea', 20.0, 38.5, null],
  ['Strait of Hormuz', 26.57, 56.25, null],
  ['Hormuz', 26.57, 56.25, null],
  ['Persian Gulf', 26.5, 52.0, null],
  ['Gulf of Aden', 12.5, 47.0, null],
  ['Bab el-Mandeb', 12.6, 43.35, null],
  ['Suez Canal', 30.6, 32.33, 'EG'],
  ['Panama Canal', 9.1, -79.68, 'PA'],
  ['South China Sea', 12.0, 114.0, null],
  ['Taiwan Strait', 24.4, 119.5, null],
  ['Black Sea', 43.4, 34.0, null],
  ['Baltic Sea', 58.0, 20.0, null],
  ['Mediterranean', 35.0, 18.0, null],
  ['Sahel', 15.0, 2.0, null],
  ['Darfur', 13.5, 24.0, 'SD'],
  ['Tigray', 14.0, 39.0, 'ET'],
  ['Kurdistan', 36.2, 44.0, null],
  ['Golan Heights', 33.0, 35.75, null],
  ['Nagorno-Karabakh', 39.8, 46.75, 'AZ'],
  ['Xinjiang', 41.1, 85.2, 'CN'],
  ['Tibet', 31.0, 88.0, 'CN'],
  ['Hong Kong', 22.3, 114.17, 'HK'],
  ['Silicon Valley', 37.39, -122.06, 'US'],
  ['Wall Street', 40.706, -74.009, 'US'],
  ['Pentagon', 38.87, -77.056, 'US'],
  ['White House', 38.898, -77.036, 'US'],
  ['Downing Street', 51.503, -0.128, 'GB'],
  ['Brussels', 50.85, 4.35, 'BE'],
  ['Vatican', 41.903, 12.453, 'VA'],
  ['Antarctica', -80.0, 0.0, null],
  ['Arctic', 80.0, 0.0, null],
]

interface Entry {
  lat: number
  lon: number
  place: string
  precision: NewsPlace['precision']
  country: string | null
  pop: number
}

const index = new Map<string, Entry[]>()
const put = (name: string, e: Entry) => {
  const k = name.toLowerCase()
  const list = index.get(k)
  if (list) list.push(e)
  else index.set(k, [e])
}
for (const [name, lat, lon, cc] of REGIONS) put(name, { lat, lon, place: name, precision: 'region', country: cc, pop: Number.MAX_SAFE_INTEGER })
for (const c of gazetteer.countries) {
  const e: Entry = { lat: c.lat, lon: c.lon, place: c.name, precision: 'country', country: c.code, pop: 0 }
  put(c.name, e)
  for (const a of c.aliases) put(a, { ...e, place: c.name })
}
for (const [name, lat, lon, cc, pop] of gazetteer.cities as [string, number, number, string, number][]) put(name, { lat, lon, place: name, precision: 'city', country: cc, pop })

const RANK = { city: 0, region: 1, country: 2 } as const
const MAX_WORDS = 4

/**
 * Every place name in the text, longest first at each position. Names must
 * start with a capital letter as written, so "nice weather" is not Nice.
 */
const findAll = (text: string): Entry[][] => {
  const words = text.match(/[\p{L}\p{M}][\p{L}\p{M}'’.-]*/gu) ?? []
  const found: Entry[][] = []
  for (let i = 0; i < words.length; ) {
    let step = 1
    for (let n = Math.min(MAX_WORDS, words.length - i); n >= 1; n--) {
      const phrase = words.slice(i, i + n).join(' ').replace(/['’]s$/u, '')
      if (!/^\p{Lu}/u.test(phrase)) continue
      const hit = index.get(phrase.toLowerCase()) ?? index.get(phrase.replace(/\.$/, '').toLowerCase())
      if (hit) {
        found.push(hit)
        step = n
        break
      }
    }
    i += step
  }
  return found
}

const choose = (found: Entry[][]): NewsPlace | null => {
  if (!found.length) return null
  const countries = new Set(found.flat().filter(e => e.precision === 'country').map(e => e.country))
  // For each match, the reading that fits the countries mentioned, else the biggest place.
  const picks = found.map(list => [...list].sort((a, b) => Number(countries.has(b.country)) - Number(countries.has(a.country)) || b.pop - a.pop)[0]!)
  const best = [...picks].sort((a, b) => RANK[a.precision] - RANK[b.precision])[0]!
  return { lat: best.lat, lon: best.lon, place: best.place, precision: best.precision, country: best.country }
}

/** Where a headline happens, from its title, else its summary; null when it names no place. */
export const placeHeadline = (title: string, summary = ''): NewsPlace | null => choose(findAll(title)) ?? choose(findAll(summary.slice(0, 400)))

const HEAVY = /\b(killed|kills|dead|deaths?|died|massacre|war|invasion|missiles?|air ?strikes?|bomb(ing|ed|s)?|blast|explosion|attack(s|ed)?|shooting|earthquake|tsunami|cyclone|hurricane|typhoon|floods?|famine|coup|hostages?|terror(ist|ism)?)\b/i
const MEDIUM = /\b(protests?|clash(es)?|arrest(ed|s)?|crisis|sanctions?|strike|wounded|injured|fire|crash|evacuat(e|ed|ion)|emergency|ceasefire|troops|military|election|outbreak)\b/i
const LIGHT = /\b(talks|deal|summit|visit|meets?|agreement|record|launch(es|ed)?|wins?|market|shares|profit)\b/i

/** A rough 0-10: how heavy the words are. Big numbers of dead push it up. */
export const newsSeverity = (title: string, summary = ''): number => {
  const t = `${title} ${summary.slice(0, 300)}`
  let s = HEAVY.test(t) ? 7 : MEDIUM.test(t) ? 5 : LIGHT.test(t) ? 2 : 3
  // "120 killed", "120 people dead", "kills 120", "kills at least 120"
  const dead = /\b(\d{2,6})\s+(people\s+)?(killed|dead|died)\b/i.exec(t) ?? /\bkill(?:s|ed|ing)?\s+(?:at least\s+)?(\d{2,6})\b/i.exec(t)
  if (dead && Number(dead[1]) >= 10) s += Number(dead[1]) >= 100 ? 3 : 2
  return Math.min(10, s)
}
