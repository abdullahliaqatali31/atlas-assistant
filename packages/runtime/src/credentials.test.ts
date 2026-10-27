import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { fileCredentialStore } from './credentials.ts'

describe('fileCredentialStore (a server without a keyring)', () => {
  const before = process.env.ATLAS_SECRET_KEY
  afterEach(() => {
    if (before === undefined) delete process.env.ATLAS_SECRET_KEY
    else process.env.ATLAS_SECRET_KEY = before
  })

  it('keeps keys sealed: the file never holds the value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-secrets-'))
    const store = fileCredentialStore(dir)
    store.set('OPENAI_API_KEY', 'sk-test-value-123')
    expect(store.get('OPENAI_API_KEY')).toBe('sk-test-value-123')
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).not.toContain('sk-test-value-123')
    store.delete('OPENAI_API_KEY')
    expect(store.get('OPENAI_API_KEY')).toBeUndefined()
  })

  it('a value moved under another name does not open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-secrets-'))
    const store = fileCredentialStore(dir)
    store.set('OPENAI_API_KEY', 'one')
    const all = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Record<string, string>
    const swapped = fileCredentialStore(dir)
    swapped.set('GEMINI_API_KEY', 'two')
    const file = join(dir, 'secrets.json')
    const now = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
    now.GEMINI_API_KEY = all.OPENAI_API_KEY!
    writeFileSync(file, JSON.stringify(now))
    expect(swapped.get('GEMINI_API_KEY')).toBeUndefined()
  })

  it('uses ATLAS_SECRET_KEY when given, and a different key cannot read it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-secrets-'))
    process.env.ATLAS_SECRET_KEY = 'first key'
    fileCredentialStore(dir).set('TELEGRAM_BOT_TOKEN', '123:abc')
    expect(fileCredentialStore(dir).get('TELEGRAM_BOT_TOKEN')).toBe('123:abc')
    process.env.ATLAS_SECRET_KEY = 'another key'
    expect(fileCredentialStore(dir).get('TELEGRAM_BOT_TOKEN')).toBeUndefined()
  })
})
