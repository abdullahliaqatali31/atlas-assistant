import { describe, expect, it } from 'vitest'

import { parseOptions } from './suggest.ts'

describe('quick replies', () => {
  it('keeps up to four short, distinct, clean options', () => {
    expect(parseOptions('Sure: {"options": ["Haan, bhej do", "haan, bhej do", "Nahi abhi", "  Aur   detail do ", "Kal yaad dilana", "Extra"]}')).toEqual(['Haan, bhej do', 'Nahi abhi', 'Aur detail do', 'Kal yaad dilana'])
    expect(parseOptions(String.raw`{"options": ["a\u0007b", 5, ""]}`)).toEqual(['a b'])
    expect(parseOptions('no json')).toEqual([])
    expect(parseOptions('{"options": "x"}')).toEqual([])
  })
})
