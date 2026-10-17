import { describe, expect, it } from 'vitest'

import { matchWake, parseWakePatch, soundKey, wakeRequest } from './wake.ts'

describe('soundKey', () => {
  it('merges common spelling variants of a name', () => {
    expect(soundKey('Zara')).toBe(soundKey('Zaara'))
    expect(soundKey('Zara')).toBe(soundKey('Sara'))
    expect(soundKey('Zara')).toBe(soundKey('Zahra'))
    expect(soundKey('Jarvis')).toBe(soundKey('Jarviss'))
  })
})

describe('matchWake', () => {
  const aliases = ['Zara']

  it('finds the name at the start and keeps the rest as the request', () => {
    expect(matchWake('Zara, aaj kya hai?', aliases, 'normal')).toEqual({ alias: 'Zara', heard: 'Zara,', rest: 'aaj kya hai?' })
  })

  it('tolerates how the model spells it, by sensitivity', () => {
    expect(matchWake('Zahra are you there', aliases, 'normal')).not.toBeNull()
    expect(matchWake('Zahra are you there', aliases, 'strict')).toBeNull()
    expect(matchWake('hey Zaraa', aliases, 'strict')).toBeNull()
    expect(matchWake('hey Zaraa', aliases, 'normal')?.rest).toBe('')
  })

  it('matches a name the model split into two words', () => {
    expect(matchWake('jar vis open my mail', ['Jarvis'], 'normal')).toMatchObject({ heard: 'jar vis', rest: 'open my mail' })
  })

  it('matches Urdu-script spellings learned in training', () => {
    expect(matchWake('زارا آج کیا ہے', ['Zara', 'زارا'], 'normal')).toMatchObject({ alias: 'زارا' })
  })

  it('ignores the name deep inside a sentence and unrelated speech', () => {
    expect(matchWake('I was telling my friend about Zara yesterday', aliases, 'normal')).toBeNull()
    expect(matchWake('the weather is nice today', aliases, 'relaxed')).toBeNull()
  })

  it('never matches without aliases', () => {
    expect(matchWake('Zara', [], 'relaxed')).toBeNull()
  })
})

describe('parseWakePatch', () => {
  it('accepts valid patches and dedupes aliases', () => {
    expect(parseWakePatch({ enabled: true, sensitivity: 'relaxed', aliases: ['Zara', 'Zara', 'Sara'] })).toEqual({ enabled: true, sensitivity: 'relaxed', aliases: ['Zara', 'Sara'] })
  })
  it('rejects bad values', () => {
    expect(parseWakePatch({ sensitivity: 'loud' })).toBeNull()
    expect(parseWakePatch({ enabled: 'yes' })).toBeNull()
    expect(parseWakePatch(null)).toBeNull()
  })
})

describe('training', () => {
  it('learns the closest spelling and ignores filler the model invents', async () => {
    const { learnAlias } = await import('./wake.ts')
    expect(learnAlias('Adlers', 'Atlas')).toBe('Adlers')
    expect(learnAlias('You', 'Atlas')).toBeNull()
    expect(learnAlias('Thank you.', 'Atlas')).toBeNull()
    expect(learnAlias('The weather is nice', 'Atlas')).toBeNull()
    expect(learnAlias('Hey, At las!', 'Atlas')).toBe('At las')
  })

  it('relaxed sensitivity accepts one sound off for a single word', () => {
    expect(matchWake('Adlers', ['Atlas'], 'normal')).toBeNull()
    expect(matchWake('Adlers', ['Atlas'], 'relaxed')).not.toBeNull()
    expect(matchWake('at least we tried', ['Atlas'], 'relaxed')).toBeNull()
  })
})

describe('training rejects what the owner saw added', () => {
  it('drops "So that\'s", "At first" and "You" for Atlas', async () => {
    const { learnAlias } = await import('./wake.ts')
    expect(learnAlias("So that's it", 'Atlas')).toBeNull()
    expect(learnAlias('At first,', 'Atlas')).toBeNull()
    expect(learnAlias('You', 'Atlas')).toBeNull()
    expect(learnAlias('Atlas', 'Atlas')).toBe('Atlas')
  })
})

describe('short common words never pass for a short name', () => {
  it('"I was telling…" does not wake Atlas even when relaxed', () => {
    expect(matchWake('I was telling my friend about the Atlas', ['Atlas'], 'relaxed')).toBeNull()
  })
})

describe('wakeRequest', () => {
  const req = (heard: string) => wakeRequest(matchWake(heard, ['Atlas'], 'normal')!, ['Atlas'], 'normal')
  it('sends a real request said with the name', () => {
    expect(req('Atlas open my email please')).toBe('open my email please')
    expect(req('Atlas, Atlas, what is on today')).toBe('what is on today')
  })
  it('just listens for the name alone, a repeated name or a stray word or two', () => {
    expect(req('Atlas')).toBeNull()
    expect(req('Atlas at 10')).toBeNull()
    expect(req('Atlas Atlas Atlas')).toBeNull()
  })
})
