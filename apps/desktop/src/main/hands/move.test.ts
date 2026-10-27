import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import type { CredentialStore, SecretName } from '@assistant/runtime'

import { applyBrainData, checkBundle, exportBrainData } from './move.ts'

const store = (values: Partial<Record<SecretName, string>> = {}): CredentialStore & { values: Partial<Record<SecretName, string>> } => ({
  values,
  get: n => values[n],
  set: (n, v) => void (values[n] = v),
  delete: n => void delete values[n],
})

/** A PC where Atlas ran on its own: a database (with an open WAL), memory files, settings and PC-only files. */
const pcData = () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-pc-'))
  mkdirSync(join(dir, 'data', 'memory-files', 'memory'), { recursive: true })
  const db = new DatabaseSync(join(dir, 'data', 'assistant.db'))
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE memories (text TEXT); INSERT INTO memories VALUES ('sister wedding in December')")
  writeFileSync(join(dir, 'data', 'memory-files', 'MEMORY.md'), '# Memory\n- likes tea\n')
  writeFileSync(join(dir, 'data', 'memory-files', 'memory', '2026-10-27.md'), '- learned something\n')
  writeFileSync(join(dir, 'setup.json'), '{"ownerName":"Owner"}')
  writeFileSync(join(dir, 'habits.json'), '{"pc":"only"}')
  writeFileSync(join(dir, 'mcp.servers.json'), '{"filesystem":"C:\\\\Users"}')
  return { dir, db }
}

describe('moving Atlas data to a server', () => {
  it('brings memory and settings, not what belongs to the PC, and keys only when asked', () => {
    const { dir, db } = pcData()
    const bundle = exportBrainData(dir, 'Dell laptop', null)
    db.close()
    const names = bundle.files.map(f => f.name).sort()
    expect(names).toEqual(['data/assistant.db', 'data/memory-files/MEMORY.md', 'data/memory-files/memory/2026-10-27.md', 'setup.json'])
    expect(bundle.keys).toBeUndefined()
    const withKeys = exportBrainData(dir, 'Dell laptop', store({ OPENAI_API_KEY: 'sk-1' }))
    expect(withKeys.keys).toEqual({ OPENAI_API_KEY: 'sk-1' })
  })

  it('the database copy holds what was written, even with the PC still running', () => {
    const { dir, db } = pcData()
    const bundle = exportBrainData(dir, 'PC', null)
    db.close()
    const server = mkdtempSync(join(tmpdir(), 'atlas-server-'))
    applyBrainData(checkBundle(bundle), server, store())
    const moved = new DatabaseSync(join(server, 'data', 'assistant.db'), { readOnly: true })
    expect(moved.prepare('SELECT text FROM memories').get()).toEqual({ text: 'sister wedding in December' })
    moved.close()
  })

  it('keeps a safety copy of what the server had, and stores the keys sealed', () => {
    const { dir, db } = pcData()
    const bundle = exportBrainData(dir, 'PC', store({ ANTHROPIC_API_KEY: 'sk-ant' }))
    db.close()
    const server = mkdtempSync(join(tmpdir(), 'atlas-server-'))
    mkdirSync(join(server, 'data', 'memory-files'), { recursive: true })
    writeFileSync(join(server, 'setup.json'), '{"ownerName":"Before"}')
    writeFileSync(join(server, 'data', 'memory-files', 'MEMORY.md'), 'old memory')
    const keys = store()
    const done = applyBrainData(checkBundle(bundle), server, keys)
    expect(readFileSync(join(server, 'setup.json'), 'utf8')).toContain('Owner')
    expect(readFileSync(join(done.safety, 'setup.json'), 'utf8')).toContain('Before')
    expect(readFileSync(join(done.safety, 'data', 'memory-files', 'MEMORY.md'), 'utf8')).toBe('old memory')
    expect(keys.values.ANTHROPIC_API_KEY).toBe('sk-ant')
    expect(existsSync(join(server, 'habits.json'))).toBe(false)
  })

  it('refuses anything outside what moves', () => {
    const ok = { from: 'PC', at: '', files: [{ name: 'data/assistant.db', data: '' }] }
    expect(() => checkBundle({ ...ok, files: [...ok.files, { name: '../../etc/passwd', data: '' }] })).toThrow(/Refused/)
    expect(() => checkBundle({ ...ok, files: [...ok.files, { name: 'data/memory-files/../../x', data: '' }] })).toThrow(/Refused/)
    expect(() => checkBundle({ ...ok, files: [...ok.files, { name: 'web-access.json', data: '' }] })).toThrow(/Refused/)
    expect(() => checkBundle({ ...ok, keys: { EVIL: 'x' } })).toThrow(/unknown key/)
    expect(() => checkBundle({ from: 'PC', files: [] })).toThrow(/no Atlas data/)
  })
})
