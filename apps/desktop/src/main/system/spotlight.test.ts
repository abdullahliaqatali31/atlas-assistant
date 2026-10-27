import { describe, expect, it } from 'vitest'

import { spotlightQuery } from './spotlight.ts'

describe('Spotlight search query', () => {
  it('needs every word in the name or the text, with kind and date when given', () => {
    expect(spotlightQuery(['invoice', 'Ali'], null, null)).toBe('(kMDItemFSName == "*invoice*"cd || kMDItemTextContent == "invoice*"cd) && (kMDItemFSName == "*Ali*"cd || kMDItemTextContent == "Ali*"cd)')
    expect(spotlightQuery(['car'], 'picture', '2026-10-15')).toBe('(kMDItemFSName == "*car*"cd || kMDItemTextContent == "car*"cd) && (kMDItemContentTypeTree == "public.image") && kMDItemFSContentChangeDate >= $time.iso(2026-10-15T00:00:00Z)')
  })

  it('keeps anything that could break out of the query away from it', () => {
    expect(spotlightQuery(['a"b', 'x) || (y', '*'], null, null)).toBeNull()
    expect(spotlightQuery(['report', 'a"b'], null, 'yesterday')).toBe('(kMDItemFSName == "*report*"cd || kMDItemTextContent == "report*"cd)')
  })
})
