import { describe, expect, it } from 'vitest'

import { searchCommands } from './search.ts'

const all = [
  { label: 'World', group: 'Go to', keywords: 'world' },
  { label: 'Theme: Daylight', group: 'Appearance', keywords: 'theme light' },
  { label: 'Theme: Midnight', group: 'Appearance', keywords: 'theme dark' },
  { label: 'Multan', group: 'Places', hint: '31° Clear' },
]

describe('command palette search', () => {
  it('needs every word, in any field and any case', () => {
    expect(searchCommands(all, 'theme LIGHT').map(c => c.label)).toEqual(['Theme: Daylight'])
    expect(searchCommands(all, 'places clear').map(c => c.label)).toEqual(['Multan'])
    expect(searchCommands(all, 'nothing here')).toEqual([])
  })

  it('shows everything (up to the limit) for an empty query', () => {
    expect(searchCommands(all, '  ')).toHaveLength(4)
    expect(searchCommands(all, '', 2)).toHaveLength(2)
  })
})
