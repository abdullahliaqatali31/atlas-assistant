/**
 * Encrypted backup archives (plan section 16). One file holds the database
 * snapshot and the settings files:
 *
 *   "PABK1" | salt (16) | iv (12) | auth tag (16) | AES-256-GCM( gzip( header length (4) | JSON header | file bytes… ) )
 *
 * The key comes from the owner's passphrase through scrypt, so the file is
 * useless without it, and GCM's tag makes any tampering or a wrong
 * passphrase fail loudly instead of restoring garbage. Each file also carries
 * its SHA-256, checked on open. Pure Node, no Electron, so it is unit tested.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

const MAGIC = Buffer.from('PABK1')
const SALT = 16
const IV = 12
const TAG = 16
/** scrypt cost: about a quarter second on a laptop, 32 MB of memory. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
export const MIN_PASSPHRASE = 8
export const BACKUP_EXT = 'pabackup'

export interface BackupEntry {
  /** Relative path inside the data folder, e.g. "data/assistant.db". */
  name: string
  data: Buffer
}

export interface BackupHeader {
  format: 1
  app: string
  createdAt: string
  files: { name: string; size: number; sha256: string }[]
}

const deriveKey = (passphrase: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => scrypt(passphrase.normalize('NFKC'), salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))))

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Only plain relative names: no drive letters, no "..", no absolute paths. */
export const safeName = (name: string) => /^[\w.-]+(\/[\w.-]+)*$/.test(name) && !name.split('/').includes('..')

export const sealBackup = async (entries: BackupEntry[], passphrase: string, app = 'Personal Assistant'): Promise<Buffer> => {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`)
  for (const e of entries) if (!safeName(e.name)) throw new Error(`Unsafe file name in backup: ${e.name}`)
  const header: BackupHeader = { format: 1, app, createdAt: new Date().toISOString(), files: entries.map(e => ({ name: e.name, size: e.data.length, sha256: sha256(e.data) })) }
  const head = Buffer.from(JSON.stringify(header))
  const len = Buffer.alloc(4)
  len.writeUInt32BE(head.length)
  const plain = gzipSync(Buffer.concat([len, head, ...entries.map(e => e.data)]))
  const salt = randomBytes(SALT)
  const iv = randomBytes(IV)
  const cipher = createCipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv)
  cipher.setAAD(MAGIC)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body])
}

export const openBackup = async (file: Buffer, passphrase: string): Promise<{ header: BackupHeader; entries: BackupEntry[] }> => {
  if (file.length < MAGIC.length + SALT + IV + TAG || !file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not an assistant backup file.')
  let at = MAGIC.length
  const salt = file.subarray(at, (at += SALT))
  const iv = file.subarray(at, (at += IV))
  const tag = file.subarray(at, (at += TAG))
  const decipher = createDecipheriv('aes-256-gcm', await deriveKey(passphrase, salt), iv)
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(tag)
  let plain: Buffer
  try {
    plain = gunzipSync(Buffer.concat([decipher.update(file.subarray(at)), decipher.final()]))
  } catch {
    throw new Error('Wrong passphrase, or the backup file is damaged.')
  }
  const headLen = plain.readUInt32BE(0)
  const header = JSON.parse(plain.subarray(4, 4 + headLen).toString('utf8')) as BackupHeader
  if (header.format !== 1 || !Array.isArray(header.files)) throw new Error('Unsupported backup version.')
  let pos = 4 + headLen
  const entries = header.files.map(f => {
    if (!safeName(f.name)) throw new Error(`Unsafe file name in backup: ${f.name}`)
    const data = plain.subarray(pos, (pos += f.size))
    if (data.length !== f.size || sha256(data) !== f.sha256) throw new Error(`Backup file ${f.name} failed its integrity check.`)
    return { name: f.name, data: Buffer.from(data) }
  })
  return { header, entries }
}
