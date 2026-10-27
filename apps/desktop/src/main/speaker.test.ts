import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SpeakerService } from './speaker.ts'

let dir = ''
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'atlas-voice-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A stand-in model: the "voice" is the first sample's sign and level, so two voices are easy to make. */
const fakeExtractor = () => {
  let last: Float32Array = new Float32Array(0)
  return {
    createStream: () => ({ acceptWaveform: (w: { samples: Float32Array }) => void (last = w.samples), inputFinished: () => undefined }),
    compute: () => Float32Array.from([last[0]! > 0 ? 1 : 0, last[0]! > 0 ? 0 : 1, 0.05]),
  }
}
const voice = (sign: number) => new Float32Array(16_000 * 2).fill(0.2 * sign)

const setup = () => {
  const secrets = new Map<string, string>()
  const make = () =>
    new SpeakerService({
      dir,
      secrets: { get: k => secrets.get(k), set: (k, v) => void secrets.set(k, v) },
      handle: () => undefined,
      toRenderer: () => undefined,
      requireOwner: () => undefined,
      log: () => undefined,
      createExtractor: fakeExtractor,
    })
  return { make, secrets }
}

describe('voice ID service', () => {
  it('enrols the owner, keeps only an encrypted print, and knows the owner again after a restart', () => {
    const { make, secrets } = setup()
    const a = make()
    a.enrol('Hamza', true, [voice(1), voice(1), voice(1)])
    expect(secrets.get('SPEAKER_PROFILE_KEY')).toBeTruthy()
    // The file holds no readable name or numbers.
    expect(readFileSync(join(dir, 'voices.enc')).toString('latin1')).not.toContain('Hamza')
    const b = make()
    expect(b.identify(voice(1))).toMatchObject({ name: 'Hamza', verdict: 'owner' })
    expect(b.identify(voice(-1)).verdict).toBe('guest')
    expect(b.enabled).toBe(true)
  })

  it('refuses phrases that do not sound like one voice, and too-short ones', () => {
    const { make } = setup()
    const s = make()
    expect(() => s.enrol('Hamza', true, [voice(1), voice(-1), voice(1)])).toThrow(/one voice/)
    expect(() => s.print(new Float32Array(8_000))).toThrow(/too short/)
  })

  it('has one owner: enrolling the owner again replaces the old print', () => {
    const { make } = setup()
    const s = make()
    s.enrol('Hamza', true, [voice(1), voice(1), voice(1)])
    s.enrol('Sara', false, [voice(-1), voice(-1), voice(-1)])
    s.enrol('Hamza', true, [voice(1), voice(1), voice(1)])
    expect(s.view().people.map(p => [p.name, p.owner])).toEqual([
      ['Sara', false],
      ['Hamza', true],
    ])
    expect(s.identify(voice(-1))).toMatchObject({ name: 'Sara', verdict: 'known' })
  })
})
