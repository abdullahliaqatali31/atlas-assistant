/**
 * Runtime configuration. A normal setup requires both an LLM provider and a
 * voice provider; validation names every missing piece at once so setup can
 * show a single checklist.
 */
import {
  AzureSpeechVoice,
  DEFAULT_AZURE_VOICE,
  ElevenLabsVoice,
  azureLocale,
  isAzureRegion,
  isAzureVoiceName,
  isLlmProvider,
  LLM_PROVIDER_IDS,
  LLM_PROVIDERS,
  type LlmConfig,
  type VoiceProvider,
} from '@assistant/providers'

export interface RuntimeConfig {
  owner: { name: string; timezone: string; languages: string[]; utcOffsetMin: number }
  llm: LlmConfig
  voice: VoiceConfig | null
  dataDir: string
  mcpConfigPath: string
}

export type VoiceConfig =
  | { provider: 'elevenlabs'; apiKey: string; voiceId: string }
  /** Azure AI Speech; the free F0 tier has Pakistani Urdu neural voices. voiceId is the voice name. */
  | { provider: 'azure'; apiKey: string; region: string; voiceId: string }

export const VOICE_PROVIDERS = ['elevenlabs', 'azure'] as const
export type VoiceProviderId = (typeof VOICE_PROVIDERS)[number]

/** The credential-store name holding each voice provider's key. */
export const VOICE_KEY_NAME = { elevenlabs: 'ELEVENLABS_API_KEY', azure: 'AZURE_SPEECH_KEY' } as const satisfies Record<VoiceProviderId, string>

export const isVoiceProvider = (v: unknown): v is VoiceProviderId => typeof v === 'string' && (VOICE_PROVIDERS as readonly string[]).includes(v)

/** The voice provider the environment selects (ElevenLabs when unset). */
export const voiceProviderOf = (env: Record<string, string | undefined>): string => env.ASSISTANT_VOICE_PROVIDER || 'elevenlabs'

export type ConfigProblem = { key: string; message: string }

/** Offset of an IANA zone right now, in minutes east of UTC. */
export const utcOffsetFor = (timeZone: string, at = new Date()): number => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at)
  const name = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name)
  if (!m) return 0
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0))
}

export const loadConfig = (
  env: Record<string, string | undefined>,
  cwd: string,
): { config: RuntimeConfig | null; problems: ConfigProblem[]; warnings: string[] } => {
  const problems: ConfigProblem[] = []
  const warnings: string[] = []
  const devSkipVoice = env.ASSISTANT_DEV_SKIP_VOICE === '1'

  const llmProvider = env.ASSISTANT_LLM_PROVIDER || 'anthropic'
  let llm: LlmConfig | null = null
  if (!isLlmProvider(llmProvider)) {
    problems.push({ key: 'ASSISTANT_LLM_PROVIDER', message: `Unsupported LLM provider "${llmProvider}" (supported: ${LLM_PROVIDER_IDS.join(', ')}).` })
  } else {
    const info = LLM_PROVIDERS[llmProvider]
    const apiKey = info.keyName ? (env[info.keyName] ?? '') : ''
    const model = env.ASSISTANT_LLM_MODEL || undefined
    const baseUrl = env.ASSISTANT_LLM_BASE_URL || undefined
    if (info.keyName && !apiKey) problems.push({ key: info.keyName, message: `An API key for ${info.label} is required.` })
    if (!model && !('defaultModel' in info)) problems.push({ key: 'ASSISTANT_LLM_MODEL', message: `Choose a model for ${info.label}.` })
    if (llmProvider === 'custom' && !baseUrl) problems.push({ key: 'ASSISTANT_LLM_BASE_URL', message: 'Set the server address, e.g. http://localhost:8000/v1.' })
    if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) problems.push({ key: 'ASSISTANT_LLM_BASE_URL', message: 'The server address must start with http:// or https://.' })
    llm = {
      provider: llmProvider,
      apiKey,
      model,
      baseUrl,
      backgroundModel: env.ASSISTANT_LLM_BACKGROUND_MODEL || undefined,
      quickModel: env.ASSISTANT_LLM_QUICK_MODEL || undefined,
      routing: env.ASSISTANT_LLM_ROUTING === 'main' ? 'main' : 'auto',
    }
  }

  const voiceProvider = voiceProviderOf(env)
  let voice: RuntimeConfig['voice'] = null
  const missing: ConfigProblem[] = []
  if (voiceProvider === 'elevenlabs') {
    const apiKey = env.ELEVENLABS_API_KEY ?? ''
    const voiceId = env.ELEVENLABS_VOICE_ID ?? ''
    if (!apiKey) missing.push({ key: 'ELEVENLABS_API_KEY', message: 'A voice provider API key is required.' })
    if (!voiceId) missing.push({ key: 'ELEVENLABS_VOICE_ID', message: 'Choose a voice id from your voice provider.' })
    if (apiKey && voiceId) voice = { provider: 'elevenlabs', apiKey, voiceId }
  } else if (voiceProvider === 'azure') {
    const apiKey = env.AZURE_SPEECH_KEY ?? ''
    const region = (env.AZURE_SPEECH_REGION ?? '').trim().toLowerCase()
    const voiceId = env.AZURE_SPEECH_VOICE || DEFAULT_AZURE_VOICE
    if (!apiKey) missing.push({ key: 'AZURE_SPEECH_KEY', message: 'An Azure Speech key is required (the free F0 tier works).' })
    if (!region) missing.push({ key: 'AZURE_SPEECH_REGION', message: 'Set the region of your Azure Speech resource, e.g. eastus or centralindia.' })
    else if (!isAzureRegion(region)) missing.push({ key: 'AZURE_SPEECH_REGION', message: `"${region}" is not an Azure region name (e.g. eastus).` })
    if (!isAzureVoiceName(voiceId)) missing.push({ key: 'AZURE_SPEECH_VOICE', message: `"${voiceId}" is not an Azure neural voice name (e.g. ${DEFAULT_AZURE_VOICE}).` })
    if (missing.length === 0) voice = { provider: 'azure', apiKey, region, voiceId }
  } else {
    problems.push({ key: 'ASSISTANT_VOICE_PROVIDER', message: `Unsupported voice provider "${voiceProvider}" (supported: ${VOICE_PROVIDERS.join(', ')}).` })
  }
  if (missing.length && devSkipVoice) warnings.push('Voice provider skipped (ASSISTANT_DEV_SKIP_VOICE=1). This is for development only.')
  else problems.push(...missing)

  const timezone = env.ASSISTANT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone
  const name = env.ASSISTANT_OWNER_NAME ?? ''
  if (!name) warnings.push('ASSISTANT_OWNER_NAME is not set; the assistant will ask for your name.')

  if (problems.length > 0) return { config: null, problems, warnings }

  return {
    config: {
      owner: {
        name,
        timezone,
        languages: (env.ASSISTANT_LANGUAGES ?? 'en').split(',').map(s => s.trim()).filter(Boolean),
        utcOffsetMin: utcOffsetFor(timezone),
      },
      llm: llm!,
      voice,
      dataDir: env.ASSISTANT_DATA_DIR ?? `${cwd}/data`,
      mcpConfigPath: env.ASSISTANT_MCP_CONFIG ?? `${cwd}/mcp.servers.json`,
    },
    problems,
    warnings,
  }
}

/**
 * The adapter for a configured voice provider. `languages` are the owner's
 * (e.g. ur-Latn,en); Azure uses them as recognition locales when no hint is given.
 */
export const createVoice = (voice: VoiceConfig, languages: string[] = []): VoiceProvider => {
  if (voice.provider === 'elevenlabs') return new ElevenLabsVoice(voice.apiKey, voice.voiceId)
  const locales = [...new Set(languages.map(azureLocale).filter((l): l is string => Boolean(l)))]
  return new AzureSpeechVoice(voice.apiKey, voice.region, voice.voiceId, locales.length ? locales : undefined)
}
