import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

const { parseFeed } = await import('./news.ts')

describe('parseFeed', () => {
  it('reads RSS items with CDATA and entities, newest data intact', () => {
    const xml = `<rss><channel><item><title><![CDATA[Rain &amp; floods in <b>Karachi</b>]]></title>
      <link>https://example.com/a</link><pubDate>Sat, 17 Oct 2026 08:00:00 GMT</pubDate></item>
      <item><title>Unsafe</title><link>http://example.com/b</link></item></channel></rss>`
    expect(parseFeed(xml, 'Dawn')).toEqual([
      { title: 'Rain & floods in Karachi', link: 'https://example.com/a', source: 'Dawn', publishedAt: Date.UTC(2026, 9, 17, 8) },
    ])
  })

  it('reads Atom entries with href links', () => {
    const xml = `<feed><entry><title>Chip news</title><link rel="alternate" href="https://example.com/c"/><updated>2026-10-17T09:00:00Z</updated></entry></feed>`
    expect(parseFeed(xml, 'The Verge')[0]).toMatchObject({ title: 'Chip news', link: 'https://example.com/c' })
  })
})
