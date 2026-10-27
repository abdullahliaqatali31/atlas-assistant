import { describe, expect, it } from 'vitest'

import { brandOf } from './BrandIcon.tsx'
import { BRAND_SVG } from './brands.ts'

describe('brand marks', () => {
  it('finds a service by its id, an alias or one of its words', () => {
    expect(brandOf('telegram')).toBe(BRAND_SVG.telegram)
    expect(brandOf('googlecalendar')).toBe(BRAND_SVG['google-calendar'])
    expect(brandOf('mcp-github')).toBe(BRAND_SVG.github)
    expect(brandOf('Opera GX')).toBe(BRAND_SVG.opera)
    expect(brandOf('Chrome Beta')).toBe(BRAND_SVG.chrome)
    expect(brandOf('openai-compatible')).toBe(BRAND_SVG.openai)
  })

  it('gives nothing rather than a wrong mark', () => {
    expect(brandOf('custom')).toBeNull()
    expect(brandOf('research-notes')).toBeNull()
    expect(brandOf('filesystem')).toBeNull()
  })
})
