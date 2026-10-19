import { describe, expect, it } from 'vitest'

import { headingTape, heightForZoom, modelFor } from './models3d.ts'

describe('modelFor', () => {
  it('picks a model by ICAO type', () => {
    expect(modelFor('B789', false)).toBe('b789')
    expect(modelFor('A388', false)).toBe('b789')
    expect(modelFor('AT76', false)).toBe('atr72')
    expect(modelFor('C172', false)).toBe('c172')
    expect(modelFor('GLF6', false)).toBe('citation2')
    expect(modelFor('EC35', false)).toBe('bell206')
    expect(modelFor('Q9', true)).toBe('mq9')
    expect(modelFor('A320', false)).toBe('airplane')
    expect(modelFor('', false)).toBe('airplane')
  })
  it('military fixed-wing is a jet; military helicopters stay helicopters', () => {
    expect(modelFor('F16', true)).toBe('jet')
    expect(modelFor('H60', true)).toBe('bell206')
  })
  it('is case-insensitive', () => {
    expect(modelFor('b77w', false)).toBe('b789')
  })
})

describe('heightForZoom', () => {
  it('goes down as you zoom in, never below 300 m', () => {
    expect(heightForZoom(3, 0)).toBeGreaterThan(heightForZoom(10, 0))
    expect(heightForZoom(22, 0)).toBe(300)
  })
})

describe('headingTape', () => {
  it('marks the cardinal points and centres the heading', () => {
    const tape = headingTape(0)
    expect(tape.find(t => t.label === 'N')?.offset).toBe(0)
    expect(tape.map(t => t.label)).toContain('33')
    expect(tape.map(t => t.label)).toContain('03')
  })
  it('wraps across north and keeps offsets inside the span', () => {
    const tape = headingTape(355)
    expect(tape.some(t => t.label === 'N')).toBe(true)
    expect(tape.every(t => t.offset >= -0.5 && t.offset <= 0.5)).toBe(true)
  })
  it('labels east, south and west', () => {
    expect(headingTape(90).find(t => t.offset === 0)?.label).toBe('E')
    expect(headingTape(180).find(t => t.offset === 0)?.label).toBe('S')
    expect(headingTape(270).find(t => t.offset === 0)?.label).toBe('W')
  })
})
