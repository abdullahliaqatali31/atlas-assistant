import { describe, expect, it } from 'vitest'

import { parseBlocks } from './Markdown.tsx'

describe('parseBlocks', () => {
  it('splits paragraphs, headings, lists and code', () => {
    expect(
      parseBlocks('## Aaj ka plan\n\n**Do kaam** hain:\n- Quote bhejna\n- Drawings check\n1. pehla\n2. doosra\n```\ncode here\n```\nBas.'),
    ).toEqual([
      { type: 'h', text: 'Aaj ka plan' },
      { type: 'p', text: '**Do kaam** hain:' },
      { type: 'ul', items: ['Quote bhejna', 'Drawings check'] },
      { type: 'ol', items: ['pehla', 'doosra'] },
      { type: 'code', text: 'code here' },
      { type: 'p', text: 'Bas.' },
    ])
  })

  it('keeps line breaks inside a paragraph and survives an unfinished stream', () => {
    expect(parseBlocks('line one\nline two')).toEqual([{ type: 'p', text: 'line one\nline two' }])
    expect(parseBlocks('```\nhalf a code block')).toEqual([{ type: 'code', text: 'half a code block' }])
  })
})
