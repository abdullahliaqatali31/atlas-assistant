import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { normalizeCode } from '../shared/identity.ts'
import { IdentityGate } from './identity.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const gate = (start = new Date(2026, 9, 17, 9).getTime()) => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-id-'))
  dirs.push(dir)
  let t = start
  const file = join(dir, 'identity.json')
  return { g: new IdentityGate(file, () => t), file, advance: (ms: number) => (t += ms), at: () => t }
}

describe('normalizeCode', () => {
  it('ignores case, accents, punctuation and spacing', () => {
    expect(normalizeCode('  Neela   Aasmaan! ')).toBe('neela aasmaan')
    expect(normalizeCode('Café-Latte')).toBe('cafe latte')
  })
})

describe('IdentityGate', () => {
  it('never asks before a code is set', () => {
    const { g } = gate()
    expect(g.shouldAsk(Infinity)).toBe(false)
  })

  it('stores only a hash and verifies typed or transcribed variants', () => {
    const { g, file } = gate()
    g.setCode('Neela Aasmaan')
    expect(readFileSync(file, 'utf8')).not.toMatch(/neela|aasmaan/i)
    g.lock()
    expect(g.verify('neela aasmaan.')).toEqual({ ok: true })
    expect(g.locked).toBe(false)
  })

  it('asks once per day in daily mode, and after long absences in away mode', () => {
    const { g, advance } = gate()
    g.setCode('blue sky 42')
    expect(g.shouldAsk(Infinity)).toBe(false) // setting the code counts for today
    advance(24 * 3600_000)
    expect(g.shouldAsk(60_000)).toBe(true)
    g.verify('blue sky 42')
    g.setAskWhen('away')
    expect(g.shouldAsk(5 * 60_000)).toBe(false)
    expect(g.shouldAsk(45 * 60_000)).toBe(true)
  })

  it('locks out after three wrong tries for ten minutes', () => {
    const { g, advance } = gate()
    g.setCode('blue sky 42')
    g.lock()
    expect(g.verify('red')).toMatchObject({ ok: false, attemptsLeft: 2 })
    g.verify('red')
    const third = g.verify('red')
    expect(third).toMatchObject({ ok: false, attemptsLeft: 0 })
    expect(g.verify('blue sky 42')).toMatchObject({ ok: false, reason: 'locked-out' })
    advance(10 * 60_000 + 1)
    expect(g.verify('blue sky 42')).toEqual({ ok: true })
  })

  it('needs the current code to change or remove it', () => {
    const { g } = gate()
    g.setCode('blue sky 42')
    expect(() => g.setCode('green field')).toThrow(/current code/)
    expect(() => g.setCode('green field', 'wrong one')).toThrow(/not right/)
    g.setCode('green field', 'blue sky 42')
    expect(() => g.removeCode('blue sky 42')).toThrow()
    expect(g.removeCode('green field').configured).toBe(false)
  })

  it('rejects codes that are too short', () => {
    const { g } = gate()
    expect(() => g.setCode('ab!')).toThrow(/at least/)
  })
})
