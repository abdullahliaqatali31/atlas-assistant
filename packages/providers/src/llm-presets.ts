/**
 * The LLM providers Atlas works with, as plain data (no SDKs), so the Setup
 * screen can show them. Claude uses its own adapter; every other provider
 * speaks the OpenAI-compatible API. Model names are not hard-coded for the
 * others: Setup lists what the owner's key can use, straight from the provider.
 */

export interface LlmProviderInfo {
  label: string
  /** Credential-store / environment name of its key; null when none is needed. */
  keyName: string | null
  /** OpenAI-compatible endpoint; null for Claude (own adapter) and for custom servers (owner sets it). */
  baseUrl: string | null
  /** Known good defaults, only where they are certain. */
  defaultModel?: string
  /** A cheaper model for background work (learning, curiosity), when one is known. */
  backgroundModel?: string
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens'
  /** Where to get a key. */
  keyUrl?: string
  note?: string
}

export const LLM_PROVIDERS = {
  anthropic: {
    label: 'Anthropic Claude',
    keyName: 'ANTHROPIC_API_KEY',
    baseUrl: null,
    defaultModel: 'claude-opus-5-5',
    backgroundModel: 'claude-haiku-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: { label: 'OpenAI', keyName: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', maxTokensParam: 'max_completion_tokens', keyUrl: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Google Gemini', keyName: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey', note: 'Has a free tier.' },
  openrouter: {
    label: 'OpenRouter',
    keyName: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    note: 'One key for hundreds of models from many companies.',
  },
  groq: { label: 'Groq', keyName: 'GROQ_API_KEY', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', note: 'Very fast open models; has a free tier.' },
  deepseek: { label: 'DeepSeek', keyName: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys' },
  mistral: { label: 'Mistral', keyName: 'MISTRAL_API_KEY', baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
  xai: { label: 'xAI Grok', keyName: 'XAI_API_KEY', baseUrl: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai' },
  ollama: { label: 'Ollama (free, on this PC)', keyName: null, baseUrl: 'http://localhost:11434/v1', keyUrl: 'https://ollama.com/download', note: 'Runs open models on your own computer; needs a capable PC and a model that supports tools.' },
  custom: { label: 'Other (OpenAI-compatible)', keyName: 'LLM_API_KEY', baseUrl: null, note: 'Any server with an OpenAI-compatible /chat/completions endpoint.' },
} as const satisfies Record<string, LlmProviderInfo>

export type LlmProviderId = keyof typeof LLM_PROVIDERS
export const LLM_PROVIDER_IDS = Object.keys(LLM_PROVIDERS) as LlmProviderId[]
export const isLlmProvider = (v: unknown): v is LlmProviderId => typeof v === 'string' && v in LLM_PROVIDERS
/** Every credential name an LLM key can be stored under. */
/** US dollars per million tokens. `cacheRead` absent: cached input is counted at the input price (a safe overestimate). */
export interface Price {
  input: number
  output: number
  cacheRead?: number
}

/**
 * Published first-party prices (Anthropic, checked 2026-10). Other providers'
 * prices change often and differ by plan, so the owner enters them in Setup;
 * until then usage shows tokens without dollars.
 */
export const KNOWN_PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
}

/** Dollars for some usage at a price, or null when the price is unknown. */
export const costOf = (u: { input: number; output: number; cached: number }, price: Price | undefined): number | null =>
  price ? (u.input * price.input + u.output * price.output + u.cached * (price.cacheRead ?? price.input)) / 1_000_000 : null

export const LLM_KEY_NAMES =[...new Set(Object.values(LLM_PROVIDERS).map(p => p.keyName).filter((k): k is NonNullable<typeof k> => k !== null))]

export interface LlmConfig {
  provider: LlmProviderId
  apiKey: string
  model?: string | undefined
  /** Custom servers; overrides the preset's endpoint for others. */
  baseUrl?: string | undefined
  /** Model for background work; falls back to the provider's known cheap model, then the main model. */
  backgroundModel?: string | undefined
}

const info = (id: LlmProviderId): LlmProviderInfo => LLM_PROVIDERS[id]

/** The model a config resolves to, for the main conversation or for background work. */
export const modelFor = (cfg: LlmConfig, purpose: 'chat' | 'background' = 'chat'): string => {
  const main = cfg.model || info(cfg.provider).defaultModel || ''
  return purpose === 'background' ? cfg.backgroundModel || info(cfg.provider).backgroundModel || main : main
}

