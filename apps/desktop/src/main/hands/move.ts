/**
 * Moving Atlas's brain data from a PC to the brain elsewhere (a server), over
 * that PC's own connection: Settings › Machines › "Bring its Atlas data here".
 *
 * What moves is what the brain keeps: memory (the database, MEMORY.md and the
 * daily notes), skills, and the settings the brain reads (name and providers,
 * rules and connections, the security code, the chosen model, timers,
 * watches, Telegram). API keys move only when the owner ticks it. What
 * belongs to the PC itself (its folders, apps, habits, connectors pointing at
 * its disk) stays there: the PC keeps doing that work as Atlas's hands.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { SECRET_NAMES, type CredentialStore, type SecretName } from '@assistant/runtime'

/** Settings files the brain reads, beside its data. */
export const MOVE_SETTINGS = ['setup.json', 'wake.json', 'controls.json', 'identity.json', 'chat-model.json', 'timers.json', 'watches.json', 'telegram.json'] as const
/** Folders under data/ that move whole. */
const MOVE_DIRS = ['memory-files', 'skills'] as const
const DB = 'data/assistant.db'
/** One message on the connection; Atlas's data is far below (about a megabyte). */
const MAX_BYTES = 20 * 1024 * 1024

export interface MoveBundle {
  from: string
  at: string
  files: { name: string; data: string }[]
  /** Only when the owner asked for the keys too. */
  keys?: Record<string, string>
}

const safe = (name: string) => !name.split('/').some(p => p === '..' || p === '' || p.includes(':')) && !name.startsWith('/')

const walk = (root: string, dir: string, out: string[]) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(root, p, out)
    else out.push(relative(root, p).split(sep).join('/'))
  }
}

/** On the PC: its Atlas data as one bundle (the database copied consistently, even while Atlas runs there). */
export const exportBrainData = (userData: string, from: string, keys: CredentialStore | null): MoveBundle => {
  const dbPath = join(userData, DB)
  if (!existsSync(dbPath)) throw new Error('There is no Atlas data on this PC to bring (Atlas never ran here on its own).')
  const files: MoveBundle['files'] = []
  let bytes = 0
  const add = (name: string, data: Buffer) => {
    bytes += data.length
    if (bytes > MAX_BYTES) throw new Error('This Atlas data is larger than 20 MB: make a backup on the PC and restore it on the server instead.')
    files.push({ name, data: data.toString('base64') })
  }
  // A consistent copy of the database, WAL and all.
  const snap = join(userData, 'backups', `move-${Date.now()}.db`)
  mkdirSync(join(userData, 'backups'), { recursive: true })
  try {
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`)
    } finally {
      db.close()
    }
    add(DB, readFileSync(snap))
  } finally {
    rmSync(snap, { force: true })
  }
  for (const d of MOVE_DIRS) {
    const root = join(userData, 'data', d)
    if (!existsSync(root)) continue
    const names: string[] = []
    walk(root, root, names)
    for (const n of names) add(`data/${d}/${n}`, readFileSync(join(root, n)))
  }
  for (const name of MOVE_SETTINGS) if (existsSync(join(userData, name))) add(name, readFileSync(join(userData, name)))
  const bundle: MoveBundle = { from, at: new Date().toISOString(), files }
  if (keys) {
    const found: Record<string, string> = {}
    for (const n of SECRET_NAMES) {
      const v = keys.get(n)
      if (v) found[n] = v
    }
    bundle.keys = found
  }
  return bundle
}

/** Checks a bundle: only the names above, nothing outside the data folder. */
export const checkBundle = (raw: unknown): MoveBundle => {
  const b = raw as Partial<MoveBundle> | null
  if (!b || !Array.isArray(b.files) || !b.files.some(f => f?.name === DB)) throw new Error('That machine sent no Atlas data.')
  const allowed = (n: string) => n === DB || (MOVE_SETTINGS as readonly string[]).includes(n) || MOVE_DIRS.some(d => n.startsWith(`data/${d}/`))
  for (const f of b.files) if (typeof f?.name !== 'string' || typeof f.data !== 'string' || !safe(f.name) || !allowed(f.name)) throw new Error(`Refused a file in the data: ${String(f?.name)}`)
  if (b.keys && (typeof b.keys !== 'object' || Object.keys(b.keys).some(k => !(SECRET_NAMES as readonly string[]).includes(k)))) throw new Error('Refused an unknown key name in the data.')
  return { from: String(b.from ?? 'a PC'), at: String(b.at ?? ''), files: b.files, keys: b.keys }
}

/**
 * On the brain: keeps a safety copy of what is here, then puts the bundle in
 * place (the runtime must be stopped). Returns where the safety copy is.
 */
export const applyBrainData = (bundle: MoveBundle, userData: string, keys: CredentialStore): { safety: string; files: number; keys: number } => {
  const safety = join(userData, 'backups', `before-move-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(safety, { recursive: true })
  for (const name of [...MOVE_SETTINGS]) if (existsSync(join(userData, name))) copyFileSync(join(userData, name), join(safety, name))
  for (const d of ['data/assistant.db', ...MOVE_DIRS.map(x => `data/${x}`)]) {
    const p = join(userData, d)
    if (existsSync(p)) cpSync(p, join(safety, d), { recursive: true })
  }
  // The old database's journal must not be replayed onto the new one; the moved folders replace the old ones whole.
  for (const suffix of ['-wal', '-shm']) rmSync(join(userData, DB) + suffix, { force: true })
  for (const d of MOVE_DIRS) rmSync(join(userData, 'data', d), { recursive: true, force: true })
  for (const f of bundle.files) {
    const p = join(userData, ...f.name.split('/'))
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, Buffer.from(f.data, 'base64'))
  }
  let n = 0
  for (const [k, v] of Object.entries(bundle.keys ?? {})) {
    keys.set(k as SecretName, v)
    n++
  }
  return { safety, files: bundle.files.length, keys: n }
}
