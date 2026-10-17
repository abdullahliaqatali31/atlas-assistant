import { describe, expect, it } from 'vitest'

import { sentenceChunker } from './voice.ts'

describe('sentenceChunker', () => {
  it('emits sentences as soon as they end, across chunks', () => {
    const c = sentenceChunker()
    expect(c.push('Abdullah, do important items ')).toEqual([])
    expect(c.push('hain. Revised quote pending hai! Pehle')).toEqual(['Abdullah, do important items hain.', 'Revised quote pending hai!'])
    expect(c.push(' kis ko clear karein?')).toEqual(['Pehle kis ko clear karein?'])
    expect(c.flush()).toEqual([])
  })

  it('handles Urdu full stop and question mark', () => {
    const c = sentenceChunker()
    expect(c.push('آج دو کام ہیں۔ پہلے کون سا؟ ')).toEqual(['آج دو کام ہیں۔', 'پہلے کون سا؟'])
  })

  it('flushes a trailing fragment', () => {
    const c = sentenceChunker()
    c.push('no punctuation yet')
    expect(c.flush()).toEqual(['no punctuation yet'])
  })
})
