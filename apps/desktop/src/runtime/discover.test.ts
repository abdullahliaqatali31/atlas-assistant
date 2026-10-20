import { describe, expect, it } from 'vitest'

import { candidatesFrom, parsePick } from './discover.ts'

describe("today's find", () => {
  it('turns the featured feed into candidates, without repeats, with pictures on the allowed host', () => {
    const page = (t: string, extract: string) => ({ titles: { normalized: t }, extract, content_urls: { desktop: { page: `https://en.wikipedia.org/wiki/${t}` } }, thumbnail: { source: `https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/${t}.png/330px-${t}.png?utm_source=x` } })
    const list = candidatesFrom({
      tfa: page('Indus', 'A river.'),
      news: [{ story: '<b>Leap second</b> abolished', links: [page('Leap second', 'A one-second adjustment.')] }],
      mostread: { articles: [page('Indus', 'Again.'), page('Cricket', 'A bat-and-ball game.')] },
      onthisday: [{ text: 'Something happened', year: 1950, pages: [page('Karachi', 'A city.')] }],
    })
    expect(list.map(c => c.title)).toEqual(['Indus', 'Leap second', 'Cricket', 'Karachi'])
    expect(list[1]!.text).toContain('Leap second abolished — ')
    expect(list[3]!.text).toContain('On this day in 1950')
    expect(list[0]!.image).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Indus.png/330px-Indus.png')
    expect(candidatesFrom(null)).toEqual([])
  })

  it('reads the pick out of the answer', () => {
    expect(parsePick('Here: {"pick": 2, "title": "Leap second", "fact": "Ab leap second nahi hoga.", "why": "Tech news."}')).toEqual({ pick: 2, title: 'Leap second', fact: 'Ab leap second nahi hoga.', why: 'Tech news.' })
    expect(parsePick('no json')).toBeNull()
    expect(parsePick('{"pick": "two", "fact": "x"}')).toBeNull()
  })
})
