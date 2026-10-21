/**
 * Encrypted backups and restore (plan section 16). A backup holds a
 * consistent snapshot of the database (taken by the runtime, which owns it)
 * and the settings files. API keys are not included: they live in the
 * Windows Credential Manager and are entered again after a restore on a new
 * PC. Speech models are not included either; they download again.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app, dialog } from './host/index.ts'

import { BACKUP_EXT, MIN_PASSPHRASE, openBackup, sealBackup, type BackupEntry } from './backup-format.ts'
import { BC } from '../shared/backup.ts'

/** Settings files in the app's data folder that a backup carries. */
const SETTINGS = ['setup.json', 'wake.json', 'activity.json', 'controls.json', 'mcp.servers.json', 'identity.json'] as const
const DB = 'data/assistant.db'

export interface BackupDeps {
  handle: <T>(channel: string, fn: (arg: unknown) => T | Promise<T>) => void
  /** Owner check: a backup contains everything private. */
  requireOwner: () => void
  /** Folder of the runtime's database. */
  dataDir: () => string
  snapshotDb: (path: string) => Promise<void>
  stopRuntime: () => Promise<void>
  log: (level: 'info' | 'warn', message: string) => void
}

const passphraseOf = (v: unknown) => {
  if (typeof v !== 'string' || v.length < MIN_PASSPHRASE || v.length > 1_000) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`)
  return v
}

export const registerBackupIpc = (deps: BackupDeps) => {
  const userData = app.getPath('userData')
  const scratch = join(userData, 'backups')

  deps.handle(BC.create, async raw => {
    deps.requireOwner()
    const passphrase = passphraseOf(raw)
    const opts = {
      title: 'Save encrypted backup',
      defaultPath: join(app.getPath('documents'), `assistant-backup-${new Date().toISOString().slice(0, 10)}.${BACKUP_EXT}`),
      filters: [{ name: 'Assistant backup', extensions: [BACKUP_EXT] }],
    }
    const picked = await dialog.showSaveDialog(opts)
    if (picked.canceled || !picked.filePath) return null

    mkdirSync(scratch, { recursive: true })
    const snapshot = join(scratch, `snapshot-${Date.now()}.db`)
    try {
      await deps.snapshotDb(snapshot)
      const entries: BackupEntry[] = [{ name: DB, data: readFileSync(snapshot) }]
      for (const name of SETTINGS) {
        const p = join(userData, name)
        if (existsSync(p)) entries.push({ name, data: readFileSync(p) })
      }
      const sealed = await sealBackup(entries, passphrase)
      writeFileSync(picked.filePath, sealed)
      deps.log('info', `Backup written (${entries.length} files, ${sealed.length} bytes).`)
      return { path: picked.filePath, bytes: sealed.length }
    } finally {
      rmSync(snapshot, { force: true })
    }
  })

  deps.handle(BC.restore, async raw => {
    deps.requireOwner()
    const passphrase = passphraseOf(raw)
    const opts = { title: 'Restore from backup', properties: ['openFile' as const], filters: [{ name: 'Assistant backup', extensions: [BACKUP_EXT] }] }
    const picked = await dialog.showOpenDialog(opts)
    if (picked.canceled || !picked.filePaths[0]) return null

    // Wrong passphrase or a damaged file fails here, before anything is touched.
    const { header, entries } = await openBackup(readFileSync(picked.filePaths[0]), passphrase)
    const db = entries.find(e => e.name === DB)
    if (!db) throw new Error('This backup has no database in it.')

    // Safety copy of what is there now, in case the owner restored the wrong file.
    const safety = join(scratch, `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    mkdirSync(join(safety, 'data'), { recursive: true })
    await deps.snapshotDb(join(safety, DB)).catch(() => undefined)
    for (const name of SETTINGS) if (existsSync(join(userData, name))) copyFileSync(join(userData, name), join(safety, name))

    await deps.stopRuntime()
    const dbPath = join(deps.dataDir(), 'assistant.db')
    mkdirSync(deps.dataDir(), { recursive: true })
    for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
    writeFileSync(dbPath, db.data)
    // Only known settings files; anything else in the archive is ignored.
    for (const e of entries) if ((SETTINGS as readonly string[]).includes(e.name)) writeFileSync(join(userData, e.name), e.data)
    deps.log('info', `Restored backup from ${header.createdAt}; safety copy in ${safety}. Restarting.`)

    // Every service rereads its settings on a fresh start.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 300)
    return { createdAt: header.createdAt }
  })
}
