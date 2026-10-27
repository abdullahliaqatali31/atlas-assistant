/**
 * Provider keys live in the OS credential store (Windows Credential Manager,
 * macOS Keychain, libsecret), never in the database, logs or renderer.
 * Environment variables still win so CI and development stay simple.
 *
 * A Linux server usually has no keyring (no desktop session, no Secret
 * Service): there the keys go into one file, each value sealed with
 * AES-256-GCM. The key comes from ATLAS_SECRET_KEY (a Docker or systemd
 * secret, kept apart from the data) or, failing that, from a key file beside
 * the data, readable by this user only.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Entry } from '@napi-rs/keyring'

export const SERVICE = 'personal-assistant'

/** The only names the store accepts: provider secrets, nothing else. */
export const SECRET_NAMES = [
  // LLM providers (one per provider in @assistant/providers LLM_PROVIDERS).
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'LLM_API_KEY',
  // Voice providers.
  'ELEVENLABS_API_KEY',
  'AZURE_SPEECH_KEY',
  'PLAYWRIGHT_MCP_EXTENSION_TOKEN',
  // Map data.
  'AISSTREAM_API_KEY',
  'WINDY_WEBCAMS_API_KEY',
  // The 3D World view: photorealistic cities (Google) and world terrain + buildings (Cesium ion).
  'GOOGLE_MAPS_API_KEY',
  'CESIUM_ION_TOKEN',
  // Live traffic flow on the World map (TomTom; free tier).
  'TOMTOM_API_KEY',
  // More flight data (OpenSky Network API client, stored as clientId:clientSecret).
  'OPENSKY_CLIENT',
  // The owner's Telegram bot (Atlas from the phone).
  'TELEGRAM_BOT_TOKEN',
  // Voice ID: the key the voice prints are encrypted with.
  'SPEAKER_PROFILE_KEY',
] as const
/** Remote MCP connectors keep their tokens under their own name: MCP_REMOTE_<NAME>. */
export type RemoteConnectorSecret = `MCP_REMOTE_${string}`
export type SecretName = (typeof SECRET_NAMES)[number] | RemoteConnectorSecret

export const isRemoteConnectorSecret = (name: string): name is RemoteConnectorSecret => /^MCP_REMOTE_[A-Z0-9_]{1,40}$/.test(name)
export const isSecretName = (name: string): name is SecretName => (SECRET_NAMES as readonly string[]).includes(name) || isRemoteConnectorSecret(name)

export interface CredentialStore {
  get(name: SecretName): string | undefined
  set(name: SecretName, value: string): void
  delete(name: SecretName): void
}

const keyringStore: CredentialStore = {
  get: name => {
    try {
      return new Entry(SERVICE, name).getPassword() ?? undefined
    } catch {
      return undefined
    }
  },
  set: (name, value) => new Entry(SERVICE, name).setPassword(value),
  delete: name => {
    try {
      new Entry(SERVICE, name).deletePassword()
    } catch {
      // Already absent.
    }
  },
}

/** Where the sealed file lives when there is no keyring (the same folder as Atlas's data on Linux). */
const secretsDir = () => process.env.ATLAS_SECRETS_DIR ?? process.env.ATLAS_DATA_DIR ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'atlas')

/** The sealing key: ATLAS_SECRET_KEY (any text, hashed to 32 bytes), else a key file made once. */
const sealingKey = (dir: string): Buffer => {
  const given = process.env.ATLAS_SECRET_KEY
  if (given) return createHash('sha256').update(given).digest()
  const file = join(dir, 'secret.key')
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 })
  }
  return createHash('sha256').update(readFileSync(file, 'utf8').trim()).digest()
}

/** Keys sealed one by one in secrets.json: iv (12) + tag (16) + ciphertext, base64; the name is bound in as associated data. */
export const fileCredentialStore = (dir = secretsDir()): CredentialStore => {
  const file = join(dir, 'secrets.json')
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }
  const write = (all: Record<string, string>) => {
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
    renameSync(tmp, file)
    try {
      chmodSync(file, 0o600)
    } catch {
      // Windows: the folder's own permissions apply.
    }
  }
  return {
    get: name => {
      const sealed = read()[name]
      if (!sealed) return undefined
      try {
        const raw = Buffer.from(sealed, 'base64')
        const d = createDecipheriv('aes-256-gcm', sealingKey(dir), raw.subarray(0, 12))
        d.setAAD(Buffer.from(name))
        d.setAuthTag(raw.subarray(12, 28))
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
      } catch {
        // Sealed with another key: as good as absent.
        return undefined
      }
    },
    set: (name, value) => {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', sealingKey(dir), iv)
      c.setAAD(Buffer.from(name))
      const body = Buffer.concat([c.update(value, 'utf8'), c.final()])
      write({ ...read(), [name]: Buffer.concat([iv, c.getAuthTag(), body]).toString('base64') })
    },
    delete: name => {
      const all = read()
      if (!(name in all)) return
      delete all[name]
      write(all)
    },
  }
}

/** Does the OS keyring answer here? (On Linux it needs a Secret Service, which servers lack.) */
let keyringWorks: boolean | null = null
const keyringUsable = () => {
  if (keyringWorks !== null) return keyringWorks
  if (process.platform !== 'linux') return (keyringWorks = true)
  try {
    new Entry(SERVICE, 'ATLAS_KEYRING_PROBE').getPassword()
    keyringWorks = true
  } catch {
    keyringWorks = false
  }
  return keyringWorks
}

/** The keyring where there is one; the sealed file when ATLAS_SECRETS=file or the keyring cannot be reached. */
export const osCredentialStore = (): CredentialStore => (process.env.ATLAS_SECRETS === 'file' || !keyringUsable() ? fileCredentialStore() : keyringStore)

/** Environment first, then the credential store, for each provider secret. */
export const withStoredSecrets = (env: Record<string, string | undefined>, store: CredentialStore) => {
  const merged = { ...env }
  for (const name of SECRET_NAMES) {
    if (!merged[name]) merged[name] = store.get(name)
  }
  return merged
}
