#!/usr/bin/env node
/**
 * Builds apps/desktop/src/shared/gazetteer.json, the small place list the
 * World map uses to put news headlines where they happen.
 *
 * Source: GeoNames (https://www.geonames.org), CC BY 4.0:
 *   https://download.geonames.org/export/dump/cities15000.zip (unzipped)
 *   https://download.geonames.org/export/dump/countryInfo.txt
 *
 * Usage: node tools/atlas-data/build-gazetteer.mjs <cities15000.txt> <countryInfo.txt>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [citiesPath, countriesPath] = process.argv.slice(2)
if (!citiesPath || !countriesPath) {
  console.error('Usage: build-gazetteer.mjs <cities15000.txt> <countryInfo.txt>')
  process.exit(1)
}

/** Cities at least this big, plus every capital. */
const MIN_POPULATION = 400_000

/** Names headlines use for countries besides the official one: short names and demonyms. */
const ALIASES = {
  US: ['United States', 'US', 'U.S.', 'USA', 'America', 'American', 'Americans', 'Washington'],
  GB: ['UK', 'U.K.', 'Britain', 'British', 'England', 'English', 'Scotland', 'Scottish', 'Wales', 'Welsh'],
  PK: ['Pakistani', 'Pakistanis'],
  IN: ['Indian', 'Indians'],
  CN: ['Chinese', 'Beijing'],
  RU: ['Russian', 'Russians', 'Kremlin', 'Moscow'],
  UA: ['Ukrainian', 'Ukrainians', 'Kyiv'],
  IR: ['Iranian', 'Iranians', 'Tehran'],
  IQ: ['Iraqi', 'Iraqis'],
  SY: ['Syrian', 'Syrians'],
  IL: ['Israeli', 'Israelis'],
  PS: ['Palestinian', 'Palestinians', 'Gaza', 'West Bank', 'Palestine'],
  LB: ['Lebanese', 'Hezbollah'],
  SA: ['Saudi', 'Saudis', 'Saudi Arabia'],
  AE: ['UAE', 'Emirati', 'Emiratis', 'Dubai', 'Abu Dhabi'],
  QA: ['Qatari'],
  YE: ['Yemeni', 'Houthi', 'Houthis'],
  AF: ['Afghan', 'Afghans', 'Taliban'],
  TR: ['Turkish', 'Turkey', 'Türkiye', 'Erdogan'],
  EG: ['Egyptian', 'Egyptians'],
  DE: ['German', 'Germans'],
  FR: ['French'],
  IT: ['Italian', 'Italians'],
  ES: ['Spanish'],
  JP: ['Japanese'],
  KR: ['South Korea', 'South Korean', 'Seoul'],
  KP: ['North Korea', 'North Korean', 'Pyongyang'],
  TW: ['Taiwanese', 'Taipei'],
  BD: ['Bangladeshi'],
  LK: ['Sri Lankan'],
  NP: ['Nepali', 'Nepalese'],
  AU: ['Australian', 'Australians'],
  CA: ['Canadian', 'Canadians'],
  MX: ['Mexican', 'Mexicans'],
  BR: ['Brazilian', 'Brazilians'],
  AR: ['Argentine', 'Argentinian'],
  VE: ['Venezuelan', 'Venezuelans'],
  CO: ['Colombian'],
  NG: ['Nigerian', 'Nigerians'],
  ZA: ['South African', 'South Africans'],
  KE: ['Kenyan', 'Kenyans'],
  ET: ['Ethiopian', 'Ethiopians'],
  SD: ['Sudanese'],
  SS: ['South Sudanese'],
  SO: ['Somali', 'Somalis'],
  LY: ['Libyan'],
  DZ: ['Algerian'],
  MA: ['Moroccan'],
  TN: ['Tunisian'],
  CD: ['Congolese', 'DR Congo', 'DRC'],
  ML: ['Malian'],
  NE: ['Nigerien'],
  PL: ['Polish', 'Poles'],
  NL: ['Dutch', 'Netherlands'],
  BE: ['Belgian'],
  SE: ['Swedish'],
  NO: ['Norwegian'],
  FI: ['Finnish'],
  DK: ['Danish'],
  GR: ['Greek'],
  HU: ['Hungarian'],
  RO: ['Romanian'],
  RS: ['Serbian'],
  BY: ['Belarusian', 'Belarus'],
  GE: ['Georgian'],
  AM: ['Armenian'],
  AZ: ['Azerbaijani'],
  KZ: ['Kazakh'],
  UZ: ['Uzbek'],
  MM: ['Myanmar', 'Burmese', 'Burma'],
  TH: ['Thai'],
  VN: ['Vietnamese'],
  PH: ['Filipino', 'Philippine'],
  ID: ['Indonesian', 'Indonesians'],
  MY: ['Malaysian'],
  SG: ['Singaporean'],
  NZ: ['New Zealander'],
  IE: ['Irish'],
  PT: ['Portuguese'],
  CH: ['Swiss'],
  AT: ['Austrian'],
  CZ: ['Czech'],
  CU: ['Cuban'],
  HT: ['Haitian'],
  CL: ['Chilean'],
  PE: ['Peruvian'],
}

/** City names that are also everyday English words or famous elsewhere: never matched on their own. */
const SKIP = new Set(['Mobile', 'Reading', 'Nice', 'Of', 'Bath', 'Split', 'Bat', 'Male', 'Victoria', 'Mercedes', 'Florida', 'Hope', 'Orange', 'Paris', 'Lincoln', 'Jackson', 'Columbus', 'Hamilton', 'Kingston', 'Georgetown', 'Santiago', 'Valencia', 'Cordoba', 'Leon', 'Trump', 'Ali', 'Gaza'])

const cols = line => line.split('\t')
const cities = readFileSync(citiesPath, 'utf8').split('\n').filter(Boolean).map(cols)
const capitals = new Map()
for (const c of cities) if (c[7] === 'PPLC') capitals.set(c[8], c)

const countries = []
for (const line of readFileSync(countriesPath, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue
  const c = cols(line)
  const code = c[0]
  const cap = capitals.get(code)
  if (!cap) continue
  const round = v => Math.round(Number(v) * 100) / 100
  countries.push({ code, name: c[4], lat: round(cap[4]), lon: round(cap[5]), aliases: ALIASES[code] ?? [] })
}

const seen = new Set()
const out = []
for (const c of cities.sort((a, b) => Number(b[14]) - Number(a[14]))) {
  const pop = Number(c[14])
  if (pop < MIN_POPULATION && c[7] !== 'PPLC') continue
  const name = c[1]
  if (SKIP.has(name) || seen.has(`${name}|${c[8]}`)) continue
  seen.add(`${name}|${c[8]}`)
  const round = v => Math.round(Number(v) * 1000) / 1000
  out.push([name, round(c[4]), round(c[5]), c[8], pop])
  if (c[2] !== name && /^[\x20-\x7e]+$/.test(c[2]) && !SKIP.has(c[2])) out.push([c[2], round(c[4]), round(c[5]), c[8], pop])
}

const target = join(dirname(fileURLToPath(import.meta.url)), '../../apps/desktop/src/shared/gazetteer.json')
writeFileSync(target, `${JSON.stringify({ source: 'GeoNames (geonames.org), CC BY 4.0', countries, cities: out })}\n`)
console.log(`Wrote ${countries.length} countries and ${out.length} city names to ${target}`)
