import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PROFILE, fixedClock, MINUTE } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryStore } from './index.ts'

const dirs: string[] = []
const stores: MemoryStore[] = []
const open = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-pers-'))
  dirs.push(dir)
  const clock = fixedClock(Date.UTC(2026, 9, 17))
  const path = join(dir, 'assistant.db')
  const store = new MemoryStore(path, clock)
  stores.push(store)
  return { store, path, clock }
}
afterEach(() => {
  for (const s of stores.splice(0)) if (s.db.isOpen) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('personality profile', () => {
  it('starts at defaults with nothing to undo and not onboarded', () => {
    const { store } = open()
    expect(store.personality()).toEqual({ profile: DEFAULT_PROFILE, version: 0, canUndo: false, updatedAt: null })
    expect(store.isOnboarded()).toBe(false)
    expect(() => store.undoPersonality()).toThrow('Nothing to undo')
  })

  it('versions every change and survives a restart', () => {
    const { store, path, clock } = open()
    store.updatePersonality({ ownerNickname: 'Boss', language: 'ur-Latn' }, 'onboarding')
    clock.advance(MINUTE)
    const s = store.updatePersonality({ humour: false }, 'setup')
    expect(s.version).toBe(2)
    expect(s.profile).toMatchObject({ ownerNickname: 'Boss', language: 'ur-Latn', humour: false })
    store.close()

    const again = new MemoryStore(path, clock)
    stores.push(again)
    expect(again.personality().profile).toEqual(s.profile)
    expect(again.personalityHistory().map(v => [v.version, v.reason])).toEqual([
      [2, 'setup'],
      [1, 'onboarding'],
    ])
    again.close()
  })

  it('writes no version when nothing changed', () => {
    const { store } = open()
    store.updatePersonality({ assistantName: 'Zara' }, 'a')
    expect(store.updatePersonality({ assistantName: 'Zara' }, 'b').version).toBe(1)
    expect(store.personalityHistory()).toHaveLength(1)
  })

  it('undo walks back through changes, then to defaults, and is itself recorded', () => {
    const { store } = open()
    store.updatePersonality({ ownerNickname: 'Boss' }, 'one')
    store.updatePersonality({ verbosity: 'detailed' }, 'two')

    const u1 = store.undoPersonality()
    expect(u1.profile).toEqual({ ...DEFAULT_PROFILE, ownerNickname: 'Boss' })
    expect(u1.canUndo).toBe(true)

    const u2 = store.undoPersonality()
    expect(u2.profile).toEqual(DEFAULT_PROFILE)
    expect(u2.canUndo).toBe(false)
    expect(() => store.undoPersonality()).toThrow()

    expect(store.personalityHistory().map(v => v.reason)).toEqual(['undo version 3', 'undo version 2', 'two', 'one'])
  })

  it('reset goes to defaults and can be undone', () => {
    const { store } = open()
    store.updatePersonality({ ownerNickname: 'Boss', disagreement: 'firm' }, 'setup')
    expect(store.resetPersonality().profile).toEqual(DEFAULT_PROFILE)
    expect(store.undoPersonality().profile).toMatchObject({ ownerNickname: 'Boss', disagreement: 'firm' })
    // Resetting an already-default profile writes nothing.
    store.resetPersonality()
    const v = store.personality().version
    expect(store.resetPersonality().version).toBe(v)
  })

  it('a change after undo becomes undoable to the undone state', () => {
    const { store } = open()
    store.updatePersonality({ ownerNickname: 'A' }, '1')
    store.updatePersonality({ ownerNickname: 'B' }, '2')
    store.undoPersonality() // back to A
    store.updatePersonality({ ownerNickname: 'C' }, '4')
    expect(store.undoPersonality().profile.ownerNickname).toBe('A')
  })

  it('exports current profile and full history', () => {
    const { store } = open()
    store.updatePersonality({ assistantName: 'Zara' }, 'onboarding')
    const out = store.exportPersonality()
    expect(out.format).toBe('assistant-personality/1')
    expect(out.current.assistantName).toBe('Zara')
    expect(out.history).toEqual([{ version: 1, reason: 'onboarding', at: '2026-10-17T00:00:00.000Z', profile: out.current }])
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })

  it('reads a damaged row as defaults instead of failing', () => {
    const { store } = open()
    store.db.prepare(`INSERT INTO personality_version (profile, reason, based_on, created_at) VALUES ('{"humour":"yes","language":"klingon","verbosity":"detailed"', 'x', 0, 0)`).run()
    expect(store.personality().profile).toEqual(DEFAULT_PROFILE)
    store.db.prepare(`INSERT INTO personality_version (profile, reason, based_on, created_at) VALUES ('{"humour":"yes","verbosity":"detailed"}', 'y', 1, 0)`).run()
    expect(store.personality().profile).toEqual({ ...DEFAULT_PROFILE, verbosity: 'detailed' })
  })

  it('keeps onboarding state separate from the profile', () => {
    const { store } = open()
    store.setOnboarded(true)
    store.updatePersonality({ humour: false }, 'x')
    store.resetPersonality()
    expect(store.isOnboarded()).toBe(true)
    store.setOnboarded(false)
    expect(store.isOnboarded()).toBe(false)
  })
})
