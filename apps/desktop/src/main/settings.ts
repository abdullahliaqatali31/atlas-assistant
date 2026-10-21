/**
 * Non-secret setup values (owner name, voice provider, voice, Azure region)
 * kept by the main process as JSON in userData. Provider keys never land
 * here: the runtime host writes them to the OS credential store and reads
 * them back itself.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { isLlmProvider, type LlmProviderId } from '@assistant/providers/llm-presets'
import { app } from './host/index.ts'

import { VOICE_PROVIDERS, type SetupInput, type SetupSummary, type VoiceProviderChoice } from '../shared/ipc.ts'
import { DEFAULT_LIVE_VOICE, parseLiveVoice, type LiveVoiceSettings } from '../shared/livevoice.ts'

interface Stored {
  ownerName: string
  /** ElevenLabs voice id. */
  voiceId: string
  /** Empty: follow the environment (ElevenLabs by default). */
  voiceProvider: VoiceProviderChoice | ''
  azureRegion: string
  /** Azure voice name; empty means the runtime default (ur-PK-UzmaNeural). */
  azureVoice: string
  /** OpenAI voice name; empty means marin. */
  openaiVoice?: string
  /** Speak replies aloud when a voice provider is configured. */
  speakReplies: boolean
  /** Empty: follow the environment (Claude by default). */
  llmProvider: LlmProviderId | ''
  llmModel: string
  llmBaseUrl: string
  llmBackgroundModel: string
  /** Model for short, simple messages; empty uses the provider's quick default. */
  llmQuickModel: string
  /** 'main' turns the quick model off. */
  llmRouting: 'auto' | 'main'
  /** Live voice (OpenAI Realtime): on/off, tier, voice, per-conversation cost cap. */
  liveVoice: LiveVoiceSettings
}

const DEFAULTS: Stored = { ownerName: '', voiceId: '', voiceProvider: '', azureRegion: '', azureVoice: '', speakReplies: true, llmProvider: '', llmModel: '', llmBaseUrl: '', llmBackgroundModel: '', llmQuickModel: '', llmRouting: 'auto', liveVoice: DEFAULT_LIVE_VOICE }
const DEFAULT_AZURE_VOICE = 'ur-PK-UzmaNeural'
const AZURE_VOICE = /^[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z0-9]+Neural$/
const file = () => join(app.getPath('userData'), 'setup.json')

export const readSetup = (): Stored => {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Stored>
    return { ...DEFAULTS, ...raw, liveVoice: parseLiveVoice(raw.liveVoice) }
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
  if (input.llmProvider) {
    next.llmProvider = input.llmProvider
    next.llmModel = input.llmModel ?? ''
    next.llmBaseUrl = input.llmBaseUrl ?? ''
    next.llmBackgroundModel = input.llmBackgroundModel ?? ''
    next.llmQuickModel = input.llmQuickModel ?? ''
  }
  if (input.llmRouting) next.llmRouting = input.llmRouting
  if (provider === 'azure') {
    if (input.azureRegion !== undefined) next.azureRegion = input.azureRegion
    if (AZURE_VOICE.test(input.voiceId)) next.azureVoice = input.voiceId
  } else if (provider === 'openai') {
    if (/^[a-z]{2,20}$/.test(input.voiceId)) next.openaiVoice = input.voiceId
  } else if (input.voiceId && !AZURE_VOICE.test(input.voiceId)) {
    next.voiceId = input.voiceId
  }
  write(next)
}

export const saveSpeakReplies = (speakReplies: boolean) => write({ ...readSetup(), speakReplies })
export const saveLiveVoice = (liveVoice: LiveVoiceSettings) => write({ ...readSetup(), liveVoice })

const RUNTIME_VARS = /^(ASSISTANT_|ELEVENLABS_|AZURE_SPEECH_|OPENAI_TTS_)|^(ANTHROPIC|OPENAI|GEMINI|OPENROUTER|GROQ|DEEPSEEK|MISTRAL|XAI|LLM)_API_KEY$/

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
  if (s.llmProvider) {
    env.ASSISTANT_LLM_PROVIDER = s.llmProvider
    // A provider chosen in Setup brings its own model settings; blanks fall back to its defaults.
    if (s.llmModel) env.ASSISTANT_LLM_MODEL = s.llmModel
    else delete env.ASSISTANT_LLM_MODEL
    if (s.llmBaseUrl) env.ASSISTANT_LLM_BASE_URL = s.llmBaseUrl
    else delete env.ASSISTANT_LLM_BASE_URL
    if (s.llmBackgroundModel) env.ASSISTANT_LLM_BACKGROUND_MODEL = s.llmBackgroundModel
    else delete env.ASSISTANT_LLM_BACKGROUND_MODEL
    if (s.llmQuickModel) env.ASSISTANT_LLM_QUICK_MODEL = s.llmQuickModel
    else delete env.ASSISTANT_LLM_QUICK_MODEL
  }
  if (s.llmRouting === 'main') env.ASSISTANT_LLM_ROUTING = 'main'
  else if (s.llmRouting === 'auto') delete env.ASSISTANT_LLM_ROUTING
  if (s.voiceId) env.ELEVENLABS_VOICE_ID = s.voiceId
  if (s.azureRegion) env.AZURE_SPEECH_REGION = s.azureRegion
  if (s.azureVoice) env.AZURE_SPEECH_VOICE = s.azureVoice
  if (s.openaiVoice) env.OPENAI_TTS_VOICE = s.openaiVoice
  env.ASSISTANT_DATA_DIR ??= join(app.getPath('userData'), 'data')
  env.ASSISTANT_MCP_CONFIG ??= join(app.getPath('userData'), 'mcp.servers.json')
  return env
}

/** Setup as the runtime sees it: stored values over the environment (.env in development). */
export const setupSummary = (env: Record<string, string>, keys: { llm: boolean; voice: boolean }): SetupSummary => {
  const voiceProvider = providerFor({}, env)
  return {
    ownerName: env.ASSISTANT_OWNER_NAME ?? '',
    llmProvider: isLlmProvider(env.ASSISTANT_LLM_PROVIDER) ? env.ASSISTANT_LLM_PROVIDER : 'anthropic',
    llmModel: env.ASSISTANT_LLM_MODEL ?? '',
    llmBaseUrl: env.ASSISTANT_LLM_BASE_URL ?? '',
    llmBackgroundModel: env.ASSISTANT_LLM_BACKGROUND_MODEL ?? '',
    llmQuickModel: env.ASSISTANT_LLM_QUICK_MODEL ?? '',
    llmRouting: env.ASSISTANT_LLM_ROUTING === 'main' ? 'main' : 'auto',
    voiceProvider,
    voiceId: voiceProvider === 'azure' ? (env.AZURE_SPEECH_VOICE ?? DEFAULT_AZURE_VOICE) : voiceProvider === 'openai' ? (env.OPENAI_TTS_VOICE ?? 'marin') : (env.ELEVENLABS_VOICE_ID ?? ''),
    azureRegion: voiceProvider === 'azure' ? (env.AZURE_SPEECH_REGION ?? '') : '',
    hasLlmKey: keys.llm,
    hasVoiceKey: keys.voice,
  }
}
