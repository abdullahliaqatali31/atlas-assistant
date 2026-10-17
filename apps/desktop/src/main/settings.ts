/**
 * Non-secret setup values (owner name, voice provider, voice, Azure region)
 * kept by the main process as JSON in userData. Provider keys never land
 * here: the runtime host writes them to the OS credential store and reads
 * them back itself.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { app } from 'electron'

import { VOICE_PROVIDERS, type SetupInput, type SetupSummary, type VoiceProviderChoice } from '../shared/ipc.ts'

interface Stored {
  ownerName: string
  /** ElevenLabs voice id. */
  voiceId: string
  /** Empty: follow the environment (ElevenLabs by default). */
  voiceProvider: VoiceProviderChoice | ''
  azureRegion: string
  /** Azure voice name; empty means the runtime default (ur-PK-UzmaNeural). */
  azureVoice: string
  /** Speak replies aloud when a voice provider is configured. */
  speakReplies: boolean
}

const DEFAULTS: Stored = { ownerName: '', voiceId: '', voiceProvider: '', azureRegion: '', azureVoice: '', speakReplies: true }
const DEFAULT_AZURE_VOICE = 'ur-PK-UzmaNeural'
const AZURE_VOICE = /^[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z0-9]+Neural$/
const file = () => join(app.getPath('userData'), 'setup.json')

export const readSetup = (): Stored => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(file(), 'utf8')) as Partial<Stored>) }
  } catch {
    return { ...DEFAULTS }
  }
}

const write = (next: Stored) => {
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(next, null, 2))
}

/** The provider a save applies to: the one chosen, else the one in use. */
export const providerFor = (input: Pick<SetupInput, 'voiceProvider'>, env: Record<string, string>): VoiceProviderChoice => {
  if (input.voiceProvider) return input.voiceProvider
  const current = env.ASSISTANT_VOICE_PROVIDER
  return (VOICE_PROVIDERS as readonly string[]).includes(current ?? '') ? (current as VoiceProviderChoice) : 'elevenlabs'
}

/**
 * The voice field belongs to the selected provider. An ElevenLabs id typed
 * while Azure is selected (or the reverse) is not carried across.
 */
export const saveSetup = (input: SetupInput, provider: VoiceProviderChoice) => {
  const s = readSetup()
  const next: Stored = { ...s, ownerName: input.ownerName, voiceProvider: provider }
  if (provider === 'azure') {
    if (input.azureRegion !== undefined) next.azureRegion = input.azureRegion
    if (AZURE_VOICE.test(input.voiceId)) next.azureVoice = input.voiceId
  } else if (input.voiceId && !AZURE_VOICE.test(input.voiceId)) {
    next.voiceId = input.voiceId
  }
  write(next)
}

export const saveSpeakReplies = (speakReplies: boolean) => write({ ...readSetup(), speakReplies })

const RUNTIME_VARS = /^(ASSISTANT_|ELEVENLABS_|AZURE_SPEECH_)|^ANTHROPIC_API_KEY$/

/**
 * Environment for `loadConfig` in the host: assistant-related variables from
 * the process environment (plus the repo's .env during development),
 * overlaid with what setup stored.
 */
export const runtimeEnv = (devEnvFile: string | null): Record<string, string> => {
  if (devEnvFile && existsSync(devEnvFile)) {
    try {
      process.loadEnvFile(devEnvFile)
    } catch {
      // Malformed .env: ignore, setup will report what is missing.
    }
  }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && RUNTIME_VARS.test(k)) env[k] = v
  }
  const s = readSetup()
  if (s.ownerName) env.ASSISTANT_OWNER_NAME = s.ownerName
  if (s.voiceProvider) env.ASSISTANT_VOICE_PROVIDER = s.voiceProvider
  if (s.voiceId) env.ELEVENLABS_VOICE_ID = s.voiceId
  if (s.azureRegion) env.AZURE_SPEECH_REGION = s.azureRegion
  if (s.azureVoice) env.AZURE_SPEECH_VOICE = s.azureVoice
  env.ASSISTANT_DATA_DIR ??= join(app.getPath('userData'), 'data')
  env.ASSISTANT_MCP_CONFIG ??= join(app.getPath('userData'), 'mcp.servers.json')
  return env
}

/** Setup as the runtime sees it: stored values over the environment (.env in development). */
export const setupSummary = (env: Record<string, string>, keys: { llm: boolean; voice: boolean }): SetupSummary => {
  const voiceProvider = providerFor({}, env)
  return {
    ownerName: env.ASSISTANT_OWNER_NAME ?? '',
    voiceProvider,
    voiceId: voiceProvider === 'azure' ? (env.AZURE_SPEECH_VOICE ?? DEFAULT_AZURE_VOICE) : (env.ELEVENLABS_VOICE_ID ?? ''),
    azureRegion: voiceProvider === 'azure' ? (env.AZURE_SPEECH_REGION ?? '') : '',
    hasLlmKey: keys.llm,
    hasVoiceKey: keys.voice,
  }
}
