/**
 * VIP aircraft (after Argos): heads of state, governments, royals,
 * oligarchs, celebrities and the like, by ICAO hex, from the community
 * plane-alert-db (sdr-enthusiasts, ODbL). "Flying now" is that list met
 * with every aircraft Atlas currently sees.
 */

export const VIP_CATEGORIES = ['Head of State', 'Dictator Alert', 'Royal Aircraft', 'Governments', 'Oligarch', "Don't you know who I am?", 'Football', 'Jesus he Knows me', 'Bizjets'] as const
export type VipCategory = (typeof VIP_CATEGORIES)[number]

export const VIP_LABEL: Record<VipCategory, string> = {
  'Head of State': 'Heads of state',
  'Dictator Alert': 'Dictators',
  'Royal Aircraft': 'Royals',
  Governments: 'Governments',
  Oligarch: 'Oligarchs',
  "Don't you know who I am?": 'Celebrities',
  Football: 'Football',
  'Jesus he Knows me': 'Televangelists',
  Bizjets: 'Business jets',
}

export interface VipPlane {
  hex: string
  registration: string
  /** Who it carries or belongs to: the leader for state aircraft, else the operator. */
  who: string
  operator: string
  type: string
  category: VipCategory
  link: string
}

/** One CSV line into fields (quotes allowed, doubled quotes inside). */
export const csvFields = (line: string): string[] => {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') (out.push(cur), (cur = ''))
    else cur += ch
  }
  out.push(cur)
  return out
}

/** plane-alert-db.csv: $ICAO,$Registration,$Operator,$Type,$ICAO Type,#CMPG,$Tag 1,$#Tag 2,$#Tag 3,Category,$#Link */
export const parsePlaneAlert = (csv: string): Map<string, VipPlane> => {
  const out = new Map<string, VipPlane>()
  for (const line of csv.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue
    const f = csvFields(line)
    const category = f[9] as VipCategory
    const hex = (f[0] ?? '').trim().toLowerCase()
    if (!(VIP_CATEGORIES as readonly string[]).includes(category) || !/^[0-9a-f]{6}$/.test(hex)) continue
    const operator = (f[2] ?? '').trim()
    // State aircraft name their leader in the second tag.
    const leader = (category === 'Head of State' || category === 'Dictator Alert' || category === 'Royal Aircraft') && f[7] && !/^(government|vip)$/i.test(f[7]) ? f[7].trim() : ''
    const link = (f[10] ?? '').trim()
    out.set(hex, { hex, registration: (f[1] ?? '').trim(), who: leader || operator, operator, type: (f[3] ?? '').trim(), category, link: /^https:\/\//.test(link) ? link : '' })
  }
  return out
}

export interface VipFlying extends VipPlane {
  callsign: string
  lat: number
  lon: number
  altitude: number | null
  speed: number
}

/** The richest people (Wikidata; net worth in US dollars, dates vary). */
export interface RichPerson {
  name: string
  worth: number
  image: string | null
}

export const RICHEST_QUERY = `SELECT ?p ?pLabel (MAX(?w) AS ?worth) (SAMPLE(?img) AS ?image) WHERE { ?p wdt:P31 wd:Q5; p:P2218 ?st. ?st psv:P2218 [wikibase:quantityAmount ?w; wikibase:quantityUnit wd:Q4917]. FILTER(?w > 40000000000) OPTIONAL { ?p wdt:P18 ?img } SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } GROUP BY ?p ?pLabel ORDER BY DESC(?worth) LIMIT 30`

export const parseRichest = (j: unknown): RichPerson[] => {
  const rows = (j as { results?: { bindings?: Record<string, { value?: string }>[] } })?.results?.bindings
  if (!Array.isArray(rows)) return []
  return rows
    .map(r => {
      const file = (r.image?.value ?? '').replace(/^https?:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//, '')
      return { name: r.pLabel?.value ?? '', worth: Number(r.worth?.value), image: file ? `https://commons.wikimedia.org/wiki/Special:FilePath/${file}?width=64` : null }
    })
    .filter(p => p.name && Number.isFinite(p.worth) && !/^Q\d+$/.test(p.name))
}
