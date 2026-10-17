/** One factory for every configured LLM provider. */
import { AnthropicProvider } from './anthropic.ts'
import type { LlmProvider } from './llm.ts'
import { LLM_PROVIDERS, modelFor, type LlmConfig } from './llm-presets.ts'
import { OpenAICompatibleProvider } from './openai-compatible.ts'

/** One adapter for any configured provider. */
export const createLlm = (cfg: LlmConfig, purpose: 'chat' | 'background' = 'chat', fetchImpl?: typeof fetch): LlmProvider => {
  const model = modelFor(cfg, purpose)
  if (cfg.provider === 'anthropic') return new AnthropicProvider(cfg.apiKey, model)
  const p = LLM_PROVIDERS[cfg.provider] as { label: string; baseUrl: string | null; maxTokensParam?: 'max_tokens' | 'max_completion_tokens' }
  const baseUrl = cfg.baseUrl || p.baseUrl
  if (!baseUrl) throw new Error('Set the server address (base URL) for this provider.')
  return new OpenAICompatibleProvider({
    label: p.label,
    baseUrl,
    apiKey: cfg.apiKey || null,
    model,
    maxTokensParam: p.maxTokensParam,
    headers: cfg.provider === 'openrouter' ? { 'X-Title': 'Atlas personal assistant' } : undefined,
    fetch: fetchImpl,
  })
}

/** Models the key can use, for Setup. Claude's list comes from its own adapter's known defaults. */
export const listLlmModels = async (cfg: Omit<LlmConfig, 'model'>, signal?: AbortSignal): Promise<string[]> => {
  if (cfg.provider === 'anthropic') return [...new Set([LLM_PROVIDERS.anthropic.defaultModel, 'claude-sonnet-5-5', LLM_PROVIDERS.anthropic.backgroundModel, 'claude-fable-5-1'])]
  const p = createLlm({ ...cfg, model: 'list' }) as OpenAICompatibleProvider
  return p.listModels(signal)
}
