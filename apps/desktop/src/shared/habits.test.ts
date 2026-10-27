import { describe, expect, it } from 'vitest'

import { categorize, DEFAULT_WORK_HOURS, estimate, habitsForAtlas, inferRole, insights, ownWords, PRIVATE_HOST, ribbon, summarize, type ProfileInfo } from './habits.ts'

const MIN = 60_000
const info = (key: string, name: string): ProfileInfo => ({ key, browser: 'Chrome', name, account: 'a@gmail.com', color: '#38bdf8', picture: null })
/** A Wednesday, 10:00 local. */
const wed10 = new Date(2026, 9, 14, 10, 0).getTime()

describe('browser habits', () => {
  it('sorts sites into categories, own businesses as work, adult sites hidden', () => {
    expect(categorize('youtube.com')).toBe('video')
    expect(categorize('moviefox.pro')).toBe('video')
    expect(categorize('github.com')).toBe('work')
    expect(categorize('claude.ai')).toBe('ai')
    expect(categorize('crm.brightpixel.app')).toBe('work')
    expect(categorize('brightpixel.app', ['brightpixel'])).toBe('work')
    expect(categorize('example.org')).toBe('other')
    const spent = estimate([{ t: wed10, dur: 5 * MIN, url: 'https://lewdsite.com/x', title: 'secret' }])
    expect(spent[0]).toMatchObject({ host: PRIVATE_HOST, cat: 'video', url: '', title: '' })
  })

  it('finds business words in profile names and company emails, not in people’s names', () => {
    expect(ownWords([
      { name: 'BrightPixel', account: 'x@gmail.com', person: 'Hamza Khan' },
      { name: 'Hamza', account: 'a@acmeestimates.com', person: 'Hamza Khan' },
      { name: 'Profile 3', account: '', person: '' },
    ]).sort()).toEqual(['acmeestimates', 'brightpixel'])
  })

  it('counts time until the next visit, capped, never overlapping', () => {
    const s = estimate([
      { t: wed10, dur: 60 * MIN, url: 'https://github.com/a', title: 'a' },
      { t: wed10 + 10 * MIN, dur: 0, url: 'https://youtube.com/watch?v=1', title: 'Cricket highlights - YouTube' },
      { t: wed10 + 11 * MIN, dur: 2 * MIN, url: 'https://github.com/b', title: 'b' },
    ])
    expect(s.map(x => x.ms)).toEqual([10 * MIN, 1 * MIN, 2 * MIN])
    expect(ribbon(s, wed10, wed10 + 3_600_000).map(r => r.cat)).toEqual(['work', 'video', 'work'])
  })

  it('guesses roles and advises: leisure in a work profile, best hours', () => {
    const work = estimate(
      Array.from({ length: 30 }, (_, i) => ({ t: wed10 + i * 4 * MIN, dur: 4 * MIN, url: i % 5 === 4 ? 'https://youtube.com/watch?v=x' : 'https://github.com/x', title: 'x' })),
    )
    const p = summarize(info('chrome:Profile 1', 'BrightPixel'), work, wed10 - 3_600_000, wed10 + 6 * 3_600_000, { workHours: DEFAULT_WORK_HOURS, role: null, shared: true })
    expect(p.inferred.role).toBe('work')
    expect(p.workHoursMs).toBe(p.totalMs)
    expect(inferRole({ ...p.byCategory, work: 0, video: 100 }, 100, 0).role).toBe('personal')
    const { insights: ins, guides } = insights([p], DEFAULT_WORK_HOURS, 1)
    expect(ins.find(i => i.kind === 'leisure-at-work')?.detail).toContain('youtube.com')
    expect(ins.some(i => i.tone === 'good' && i.title.startsWith('Your best work hours'))).toBe(true)
    expect(guides[0]?.keepOut).toContain('youtube.com')
    // Atlas never gets the account (email) or pictures.
    const text = habitsForAtlas({ days: 1, profiles: [p], insights: ins, guides }, DEFAULT_WORK_HOURS)
    expect(text).toContain('BrightPixel')
    expect(text).not.toContain('@gmail.com')
  })
})
