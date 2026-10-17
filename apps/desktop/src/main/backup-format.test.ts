import { describe, expect, it } from 'vitest'

import { openBackup, safeName, sealBackup } from './backup-format.ts'

const entries = [
  { name: 'data/assistant.db', data: Buffer.from('SQLite format 3\u0000 pretend database with Ahmed Raza quote') },
  { name: 'wake.json', data: Buffer.from('{"enabled":true}') },
]

describe('encrypted backups', () => {
  it('round-trips every file with the right passphrase', async () => {
    const sealed = await sealBackup(entries, 'correct horse battery')
    const { header, entries: back } = await openBackup(sealed, 'correct horse battery')
    expect(header.files.map(f => f.name)).toEqual(['data/assistant.db', 'wake.json'])
    expect(back.map(e => e.data.toString())).toEqual(entries.map(e => e.data.toString()))
  })

  it('hides the contents: nothing readable in the file', async () => {
    const sealed = await sealBackup(entries, 'correct horse battery')
    expect(sealed.includes(Buffer.from('Ahmed'))).toBe(false)
    expect(sealed.includes(Buffer.from('assistant.db'))).toBe(false)
  })

  it('refuses a wrong passphrase and any tampering', async () => {
    const sealed = await sealBackup(entries, 'correct horse battery')
    await expect(openBackup(sealed, 'wrong horse battery')).rejects.toThrow(/Wrong passphrase/)
    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 5]! ^= 1
    await expect(openBackup(tampered, 'correct horse battery')).rejects.toThrow(/Wrong passphrase|damaged/)
    await expect(openBackup(Buffer.from('not a backup at all'), 'x')).rejects.toThrow(/not an assistant backup/)
  })

  it('needs a real passphrase and never writes outside the data folder', async () => {
    await expect(sealBackup(entries, 'short')).rejects.toThrow(/at least 8/)
    expect(safeName('data/assistant.db')).toBe(true)
    for (const bad of ['../evil.db', 'C:/Windows/x', '/etc/passwd', 'a/../../b']) expect(safeName(bad)).toBe(false)
    await expect(sealBackup([{ name: '../evil', data: Buffer.from('x') }], 'long enough pass')).rejects.toThrow(/Unsafe/)
  })
})
