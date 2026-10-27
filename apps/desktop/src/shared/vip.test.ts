import { describe, expect, it } from 'vitest'

import { csvFields, parsePlaneAlert, parseRichest } from './vip.ts'

const CSV = `$ICAO,$Registration,$Operator,$Type,$ICAO Type,#CMPG,$Tag 1,$#Tag 2,$#Tag 3,Category,$#Link
000004,FAC1282,Colombian Aerospace Force,CASA C-295 M,C295,Mil,Cargo,Tactical Transport,Marching Powder,Other Air Forces,https://w.wiki/8pa2
09A01A,C5-RTG,Gov of Gambia,Ilyushin IL-62M,IL62,Gov,Government,Adama Barrow,Free And Fair Elections,Head of State,https://data.dictatoralert.org/dictatorships
34254B,EC-KBC,Christian Ronaldo,Gulfstream G200,GALX,Civ,Football,"Ronaldo, CR7",,Don't you know who I am?,https://en.wikipedia.org/wiki/Cristiano_Ronaldo
XYZ123,BAD,Nobody,X,X,Civ,,,,Oligarch,`

describe('VIP aircraft', () => {
  it('splits CSV lines with quoted commas', () => {
    expect(csvFields('a,"b, c",d')).toEqual(['a', 'b, c', 'd'])
    expect(csvFields('a,"say ""hi""",')).toEqual(['a', 'say "hi"', ''])
  })
  it('keeps the VIP categories, names the leader of state aircraft, the owner otherwise', () => {
    const m = parsePlaneAlert(CSV)
    expect([...m.keys()]).toEqual(['09a01a', '34254b'])
    expect(m.get('09a01a')).toMatchObject({ who: 'Adama Barrow', operator: 'Gov of Gambia', category: 'Head of State', registration: 'C5-RTG' })
    expect(m.get('34254b')).toMatchObject({ who: 'Christian Ronaldo', category: "Don't you know who I am?", link: 'https://en.wikipedia.org/wiki/Cristiano_Ronaldo' })
  })
})

describe('the richest', () => {
  it('reads Wikidata net worth with a Commons thumbnail', () => {
    expect(parseRichest({ results: { bindings: [{ pLabel: { value: 'Elon Musk' }, worth: { value: '7.9E11' }, image: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/Elon%20Musk.jpg' } }, { pLabel: { value: 'Q123' }, worth: { value: '1' } }] } })).toEqual([{ name: 'Elon Musk', worth: 7.9e11, image: 'https://commons.wikimedia.org/wiki/Special:FilePath/Elon%20Musk.jpg?width=64' }])
  })
})
