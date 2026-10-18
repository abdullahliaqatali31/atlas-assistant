/**
 * Provider keys live in the OS credential store (Windows Credential Manager,
 * macOS Keychain, libsecret), never in the database, logs or renderer.
 * Environment variables still win so CI and development stay simple.
 */
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
] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export const isSecretName = (name: string): name is SecretName => (SECRET_NAMES as readonly string[]).includes(name)

export interface CredentialStore {
  get(name: SecretName): string | undefined
  set(name: SecretName, value: string): void
  delete(name: SecretName): void
}

export const osCredentialStore = (): CredentialStore => ({
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
})

/** Environment first, then the credential store, for each provider secret. */
export const withStoredSecrets = (env: Record<string, string | undefined>, store: CredentialStore) => {
  const merged = { ...env }
  for (const name of SECRET_NAMES) {
    if (!merged[name]) merged[name] = store.get(name)
  }
  return merged
}
