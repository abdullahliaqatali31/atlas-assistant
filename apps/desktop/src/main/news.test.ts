import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, protocol: { handle: vi.fn() }, app: { getPath: () => '/tmp' } }))

const { findImage, parseFeed, idOf } = await import('./news.ts')

const DAWN = { source: 'Dawn', category: 'pakistan' as const }

describe('parseFeed', () => {
  it('reads RSS items with CDATA and entities, a summary and the picture', () => {
    const xml = `<rss><channel><item><title><![CDATA[Rain &amp; floods in <b>Karachi</b>]]></title>
      <link>https://example.com/a</link><pubDate>Sat, 17 Oct 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[<p>Heavy rain hit the city on Saturday.</p>]]></description>
      <media:content url="https://img.example.com/small.jpg" medium="image" width="400"/>
      <media:content url="https://img.example.com/large.jpg" medium="image" width="1800"/></item>
      <item><title>Unsafe</title><link>http://example.com/b</link></item></channel></rss>`
    expect(parseFeed(xml, DAWN, u => `proxied:${u}`)).toEqual([
      {
        id: idOf('https://example.com/a'),
        title: 'Rain & floods in Karachi',
        link: 'https://example.com/a',
        source: 'Dawn',
        category: 'pakistan',
        publishedAt: Date.UTC(2026, 9, 17, 8),
        summary: 'Heavy rain hit the city on Saturday.',
        image: 'proxied:https://img.example.com/large.jpg',
      },
    ])
  })

  it('reads Atom entries with href links', () => {
    const xml = `<feed><entry><title>Chip news</title><link rel="alternate" href="https://example.com/c"/><updated>2026-10-17T09:00:00Z</updated></entry></feed>`
    expect(parseFeed(xml, { source: 'The Verge', category: 'tech' })[0]).toMatchObject({ title: 'Chip news', link: 'https://example.com/c', image: null })
  })

  it('shortens long summaries at a word', () => {
    const long = 'word '.repeat(100)
    const [h] = parseFeed(`<rss><item><title>T</title><link>https://e.com/x</link><description>${long}</description></item></rss>`, DAWN)
    expect(h!.summary.length).toBeLessThanOrEqual(261)
    expect(h!.summary.endsWith('word…')).toBe(true)
  })
})

describe('findImage', () => {
  it('finds pictures the way each feed embeds them, https only', () => {
    expect(findImage('<media:thumbnail url="https://bbc.example/t.jpg" width="240"/>')).toBe('https://bbc.example/t.jpg')
    expect(findImage('<enclosure url="https://e.com/p.png" type="image/png"/>')).toBe('https://e.com/p.png')
    // Tribune: an <img> in the description, as CDATA.
    expect(findImage('<description><![CDATA[<img src="https://i.tribune.com.pk/a.jpeg" class="featured_image"/> Text]]></description>')).toBe('https://i.tribune.com.pk/a.jpeg')
    // The Verge: an escaped <img> in the content.
    expect(findImage('<content type="html">&lt;img alt="" src="https://platform.theverge.com/x.jpg?w=1"&gt;</content>')).toBe('https://platform.theverge.com/x.jpg?w=1')
    expect(findImage('<media:thumbnail url="http://insecure.example/t.jpg"/>')).toBeNull()
    expect(findImage('<description>No picture here</description>')).toBeNull()
  })
})
