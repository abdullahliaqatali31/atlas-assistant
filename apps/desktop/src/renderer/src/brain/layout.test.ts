import { describe, expect, it } from 'vitest'

import { cortexDust, gyri, homeOf, relax, shellRadius, type P3 } from './layout.ts'

describe('brain layout', () => {
  it('puts a memory in the same place every time, in its lobe, inside the cortex', () => {
    const a = homeOf('m-1', 'preference')
    expect(homeOf('m-1', 'preference')).toEqual(a)
    const r = shellRadius(a)
    expect(r).toBeGreaterThan(0.6)
    expect(r).toBeLessThan(0.96)
    // Likes sit in front, lessons behind, on average.
    const avg = (kind: 'preference' | 'lesson' | 'fact' | 'hypothesis', axis: 'z' | 'y') => Array.from({ length: 60 }, (_, i) => homeOf(`id-${i}`, kind)[axis]).reduce((s, v) => s + v, 0) / 60
    expect(avg('preference', 'z')).toBeGreaterThan(0.3)
    expect(avg('lesson', 'z')).toBeLessThan(-0.3)
    expect(avg('fact', 'y')).toBeGreaterThan(0.3)
    expect(avg('hypothesis', 'y')).toBeLessThan(-0.2)
  })

  it('keeps skills in the core and memories out of the groove between hemispheres', () => {
    for (let i = 0; i < 40; i++) {
      expect(shellRadius(homeOf(`s-${i}`, 'skill'))).toBeLessThan(0.5)
      expect(Math.abs(homeOf(`m-${i}`, 'fact').x)).toBeGreaterThanOrEqual(0.08)
    }
  })

  it('draws linked memories closer without leaving the brain', () => {
    const pos = new Map<string, P3>([
      ['a', homeOf('a', 'fact')],
      ['b', homeOf('b', 'lesson')],
    ])
    const before = Math.hypot(pos.get('a')!.x - pos.get('b')!.x, pos.get('a')!.y - pos.get('b')!.y, pos.get('a')!.z - pos.get('b')!.z)
    relax(pos, [{ a: 'a', b: 'b', weight: 5 }], new Map([['a', 'fact'], ['b', 'lesson']]))
    const after = Math.hypot(pos.get('a')!.x - pos.get('b')!.x, pos.get('a')!.y - pos.get('b')!.y, pos.get('a')!.z - pos.get('b')!.z)
    expect(after).toBeLessThan(before)
    for (const p of pos.values()) expect(shellRadius(p)).toBeLessThanOrEqual(0.951)
  })

  it('keeps tightly linked memories from collapsing into one point', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `f-${i}`)
    const pos = new Map<string, P3>(ids.map(id => [id, homeOf(id, 'fact')]))
    const links = ids.flatMap((a, i) => ids.slice(i + 1).map(b => ({ a, b, weight: 12 })))
    relax(pos, links, new Map(ids.map(id => [id, 'fact' as const])))
    const ps = [...pos.values()]
    let min = Infinity
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) min = Math.min(min, Math.hypot(ps[i]!.x - ps[j]!.x, ps[i]!.y - ps[j]!.y, ps[i]!.z - ps[j]!.z))
    expect(min).toBeGreaterThan(0.08)
  })

  it('has a surface to draw before any memory exists', () => {
    expect(cortexDust(500).length).toBeGreaterThan(300)
    const dust = cortexDust(400)
    // Most of it is the cortex itself (the rest is the cerebellum and brainstem).
    expect(dust.filter(p => shellRadius(p) > 0.75).length / dust.length).toBeGreaterThan(0.7)
    expect(gyri().length).toBeGreaterThan(20)
  })
})
