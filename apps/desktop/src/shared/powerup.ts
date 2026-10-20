/**
 * Power up: every service Atlas can use, in one list — what each unlocks,
 * what it costs, where to get a key, and what still works without one.
 * Setup's Power up page, the key tests and "needs X" hints all read this.
 * Keys live in the Windows credential store; the page only ever learns
 * whether one is set, never its value.
 */
import { LLM_PROVIDERS, type LlmProviderId } from '@assistant/providers/llm-presets'

export type PowerTier = 'free' | 'free-tier' | 'metered'
export type PowerGroup = 'brain' | 'voice' | 'world'

export interface PowerProvider {
  id: string
  title: string
  group: PowerGroup
  /** One sentence: what turns on with this key. */
  unlocks: string
  /** Credential-store name. */
  secret: string
  tier: PowerTier
  /** Where to make a key, and where to manage it once you have one. */
  getUrl: string
  manageUrl: string
  /** What works without it. */
  without: string
  /** The LLM provider this key belongs to (brain rows). */
  llm?: LlmProviderId
}

const BRAIN: { llm: LlmProviderId; unlocks: string; tier: PowerTier; manage?: string }[] = [
  { llm: 'anthropic', unlocks: 'Claude as Atlas’s brain: the best at tools and long tasks.', tier: 'metered', manage: 'https://console.anthropic.com/settings/billing' },
  { llm: 'openai', unlocks: 'GPT models as the brain, and Live voice (OpenAI Realtime, coming next).', tier: 'metered', manage: 'https://platform.openai.com/usage' },
  { llm: 'gemini', unlocks: 'Gemini models as the brain; generous free tier.', tier: 'free-tier' },
  { llm: 'openrouter', unlocks: 'One key for hundreds of models from many companies.', tier: 'metered', manage: 'https://openrouter.ai/settings/credits' },
  { llm: 'groq', unlocks: 'Very fast open models; free tier.', tier: 'free-tier' },
  { llm: 'deepseek', unlocks: 'DeepSeek models, low cost.', tier: 'metered' },
  { llm: 'mistral', unlocks: 'Mistral models.', tier: 'metered' },
  { llm: 'xai', unlocks: 'Grok models.', tier: 'metered' },
]

export const POWER_PROVIDERS: readonly PowerProvider[] = Object.freeze([
  ...BRAIN.map(
    (b): PowerProvider => ({
      id: b.llm,
      title: LLM_PROVIDERS[b.llm].label,
      group: 'brain',
      unlocks: b.unlocks,
      secret: LLM_PROVIDERS[b.llm].keyName as string,
      tier: b.tier,
      getUrl: (LLM_PROVIDERS[b.llm] as { keyUrl?: string }).keyUrl ?? '',
      manageUrl: b.manage ?? (LLM_PROVIDERS[b.llm] as { keyUrl?: string }).keyUrl ?? '',
      without: 'Any one brain is enough; Ollama runs free on this PC without a key.',
      llm: b.llm,
    }),
  ),
  {
    id: 'elevenlabs',
    title: 'ElevenLabs',
    group: 'voice',
    unlocks: 'Atlas’s most natural voice, and speech-to-text.',
    secret: 'ELEVENLABS_API_KEY',
    tier: 'metered',
    getUrl: 'https://elevenlabs.io/app/settings/api-keys',
    manageUrl: 'https://elevenlabs.io/app/subscription',
    without: 'Use Azure (free tier) instead, or replies stay on screen.',
  },
  {
    id: 'azure-speech',
    title: 'Azure AI Speech',
    group: 'voice',
    unlocks: 'Speech in and out with Pakistani Urdu voices; the free F0 tier is enough.',
    secret: 'AZURE_SPEECH_KEY',
    tier: 'free-tier',
    getUrl: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices',
    manageUrl: 'https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/SpeechServices',
    without: 'Use ElevenLabs instead, or replies stay on screen.',
  },
  {
    id: 'aisstream',
    title: 'AISStream',
    group: 'world',
    unlocks: 'Live ships worldwide on the World map.',
    secret: 'AISSTREAM_API_KEY',
    tier: 'free',
    getUrl: 'https://aisstream.io/apikeys',
    manageUrl: 'https://aisstream.io/apikeys',
    without: 'No ships; everything else on the map works.',
  },
  {
    id: 'windy',
    title: 'Windy Webcams',
    group: 'world',
    unlocks: 'Webcams everywhere in the world, live and timelapse.',
    secret: 'WINDY_WEBCAMS_API_KEY',
    tier: 'free',
    getUrl: 'https://api.windy.com/keys',
    manageUrl: 'https://api.windy.com/keys',
    without: 'Official city traffic cameras (London, California, Finland…) still work.',
  },
  {
    id: 'cesium-ion',
    title: 'Cesium ion',
    group: 'world',
    unlocks: 'The 3D World view in full: real mountains (world terrain) and 3D buildings in every city.',
    secret: 'CESIUM_ION_TOKEN',
    tier: 'free',
    getUrl: 'https://ion.cesium.com/signup',
    manageUrl: 'https://ion.cesium.com/tokens',
    without: 'The 3D view still works with free satellite imagery and basic terrain.',
  },
  {
    id: 'google-maps',
    title: 'Google Maps 3D',
    group: 'world',
    unlocks: 'Photorealistic 3D cities in the 3D World view (the Map Tiles API). Used from the page, so restrict the key to the Map Tiles API in Google Cloud.',
    secret: 'GOOGLE_MAPS_API_KEY',
    tier: 'metered',
    getUrl: 'https://developers.google.com/maps/documentation/tile/get-api-key',
    manageUrl: 'https://console.cloud.google.com/google/maps-apis/credentials',
    without: 'The 3D view uses Cesium ion or free imagery instead.',
  },
  {
    id: 'tomtom',
    title: 'TomTom Traffic',
    group: 'world',
    unlocks: 'Live traffic on the World map, flat and 3D: every road coloured by how fast it is moving now. Used from the page (map tiles), about 50,000 free tiles a day.',
    secret: 'TOMTOM_API_KEY',
    tier: 'free-tier',
    getUrl: 'https://developer.tomtom.com/user/register',
    manageUrl: 'https://developer.tomtom.com/user/me/apps',
    without: 'No live traffic layer; everything else on the map works.',
  },
  {
    id: 'opensky',
    title: 'OpenSky Network',
    group: 'world',
    unlocks: 'About ten times more flight data from OpenSky: aircraft filled in where the volunteer feeds are thin (much of Pakistan and Asia) and each plane’s flown track. Make an API client in your OpenSky account and paste it as clientId:clientSecret.',
    secret: 'OPENSKY_CLIENT',
    tier: 'free',
    getUrl: 'https://opensky-network.org/my-opensky/account',
    manageUrl: 'https://opensky-network.org/my-opensky/account',
    without: 'OpenSky is still used anonymously, about 400 credits a day.',
  },
])

export const powerProvider = (id: string) => POWER_PROVIDERS.find(p => p.id === id)

export const TIER_LABEL: Record<PowerTier, string> = { free: 'Free key', 'free-tier': 'Free tier', metered: 'Pay as you go' }

/** A pasted key that looks like a key: printable, no spaces or quotes, a sane length. */
export const keyProblem = (value: string): string | null => {
  const v = value.trim()
  if (v.length < 8) return 'That is too short to be a key.'
  if (v.length > 512) return 'That is too long to be a key.'
  if (!/^[\x21-\x7e]+$/.test(v) || /["'`$\\#]/.test(v)) return 'A key has no spaces, quotes or special characters like # $ \\ — paste only the key.'
  return null
}

export interface PowerRow {
  id: string
  set: boolean
  /** Set outside Atlas (environment / .env), so read-only here. */
  external: boolean
  /** The brain or voice Atlas uses right now. */
  inUse: boolean
  /** The last test, this session. */
  test: { ok: boolean; message: string; at: number } | null
}

export const PWC = {
  state: 'powerup:state',
  save: 'powerup:save',
  remove: 'powerup:remove',
  test: 'powerup:test',
} as const

export interface PowerUpBridge {
  state(): Promise<PowerRow[]>
  save(id: string, key: string): Promise<PowerRow[]>
  remove(id: string): Promise<PowerRow[]>
  test(id: string): Promise<PowerRow[]>
}
