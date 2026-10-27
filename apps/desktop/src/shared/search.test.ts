import { describe, expect, it } from 'vitest'

import { searchWords } from './system.ts'

describe('PC search words', () => {
  it('keeps only safe words, drops filler, at most six', () => {
    expect(searchWords('mera invoice wali file from Ali')).toEqual(['invoice', 'from', 'ali'])
    expect(searchWords("x'; DROP TABLE -- report")).toEqual(['drop', 'table', '--', 'report'])
    expect(searchWords('a b c d e f g h i j k l')).toEqual([])
    expect(searchWords('one two three four five six seven')).toHaveLength(6)
  })
})
