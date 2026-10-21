import { describe, expect, it } from 'vitest'

import { fuse } from './semantic.ts'

const noInfo = () => ({ uses: 0, lastUsed: null })
const none = () => []

describe('blended recall', () => {
  it('puts what both lists found first, then each list’s best', () => {
    expect(fuse(['a', 'b'], [{ id: 'b', score: 0.85 }, { id: 'c', score: 0.84 }], noInfo, none, 0, 3)).toEqual(['b', 'a', 'c'])
  })

  it('drops meaning matches far below the best (noise for this model)', () => {
    expect(fuse([], [{ id: 'x', score: 0.85 }, { id: 'y', score: 0.7 }], noInfo, none, 0, 5)).toEqual(['x'])
  })

  it('lifts memories used lately, and brings the best hits’ strong neighbours along', () => {
    const info = (id: string) => (id === 'old' ? { uses: 0, lastUsed: null } : { uses: 20, lastUsed: 1000 })
    expect(fuse(['old', 'fresh'], [], info, none, 2000, 2)).toEqual(['fresh', 'old'])
    const neighbours = (id: string) => (id === 'a' ? [{ id: 'sister-wedding-venue', weight: 4 }, { id: 'weak', weight: 1 }] : [])
    expect(fuse(['a'], [], noInfo, neighbours, 0, 5)).toEqual(['a', 'sister-wedding-venue'])
  })
})
