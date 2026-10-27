/**
 * Adapter for every provider that speaks the OpenAI-compatible chat API:
 * OpenAI, Google Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, Ollama and
 * any self-hosted server. Plain fetch, no vendor SDK. Streams text and tool
 * calls, reports token usage when the provider sends it, and replays the
 * assistant's exact message (content + tool_calls) inside a tool loop.
 */
import type { ChatTurn, ContentPart, LlmEvent, LlmProvider, LlmRequest } from './llm.ts'

export interface OpenAICompatibleOptions {
  /** Shown in errors: "OpenAI", "Groq"… */
  label: string
  /** e.g. https://api.openai.com/v1 (no trailing /chat/completions). */
  baseUrl: string
  /** Null for local servers that need none (Ollama). */
  apiKey: string | null
  model: string
  /** Newer OpenAI models take max_completion_tokens; most others take max_tokens. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens'
  /** Extra headers, e.g. OpenRouter's app attribution. */
  headers?: Record<string, string>
  fetch?: typeof fetch
}

type OaiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OaiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

interface OaiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

const text = (c: string | ContentPart[]) => (typeof c === 'string' ? c : c.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n\n'))

/** Our turns as OpenAI chat messages: tool results become role "tool"; replayed assistant turns are sent as returned. */
export const toMessages = (system: string | readonly string[], turns: readonly ChatTurn[]): OaiMessage[] => {
  const out: OaiMessage[] = [{ role: 'system', content: typeof system === 'string' ? system : system.join('\n\n') }]
  for (const t of turns) {
    if (t.role === 'assistant') {
      if (t.raw && typeof t.raw === 'object' && (t.raw as { role?: string }).role === 'assistant') {
        out.push(t.raw as OaiMessage)
        continue
      }
      const calls = typeof t.content === 'string' ? [] : t.content.filter((p): p is Extract<ContentPart, { type: 'tool_use' }> => p.type === 'tool_use')
      out.push({
        role: 'assistant',
        content: text(t.content) || null,
        ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
      })
      continue
    }
    if (typeof t.content === 'string') {
      out.push({ role: 'user', content: t.content })
      continue
    }
    for (const p of t.content) if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.toolUseId, content: p.isError ? `Error: ${p.content}` : p.content })
    const rest = text(t.content)
    const images = t.content.filter((p): p is Extract<ContentPart, { type: 'image' }> => p.type === 'image')
    if (images.length) out.push({ role: 'user', content: [...images.map(i => ({ type: 'image_url' as const, image_url: { url: `data:${i.mediaType};base64,${i.data}` } })), ...(rest ? [{ type: 'text' as const, text: rest }] : [])] })
    else if (rest) out.push({ role: 'user', content: rest })
  }
  return out
}

/** Reads a server-sent-events body into JSON payloads. */
async function* sse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data)
        } catch {
          // A keep-alive or partial line: skip it.
        }
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

const errorText = async (res: Response, label: string) => {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string }
    detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message ?? '')
  } catch {
    // Not JSON.
  }
  const hint = res.status === 401 || res.status === 403 ? ' (check the API key)' : res.status === 404 ? ' (check the model name and base URL)' : res.status === 429 ? ' (rate limit or credits)' : ''
  return `${label} ${res.status}${hint}${detail ? `: ${detail.slice(0, 300)}` : ''}`
}

export class OpenAICompatibleProvider implements LlmProvider {
  readonly id: string
  readonly model: string
  private readonly fetch: typeof fetch

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.id = opts.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    this.model = opts.model
    this.fetch = opts.fetch ?? globalThis.fetch
  }

  private headers() {
    return {
      'content-type': 'application/json',
      ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      ...this.opts.headers,
    }
  }

  private url(path: string) {
    return `${this.opts.baseUrl.replace(/\/+$/, '')}${path}`
  }

  async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toMessages(req.system, req.turns),
      stream: true,
      stream_options: { include_usage: true },
      [this.opts.maxTokensParam ?? 'max_tokens']: req.maxTokens ?? 8192,
    }
    if (req.tools?.length) {
      body.tools = req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
      body.tool_choice = 'auto'
    }
    const res = await this.fetch(this.url('/chat/completions'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal })
    if (!res.ok || !res.body) throw new Error(await errorText(res, this.opts.label))

    let content = ''
    let refused = false
    const calls = new Map<number, { id: string; name: string; args: string }>()
    let finish: string | null = null
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }

    for await (const raw of sse(res.body, signal)) {
      const chunk = raw as {
        choices?: { delta?: { content?: string | null; refusal?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null
      }
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens
        usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens
        usage.cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? usage.cacheReadTokens
      }
      const choice = chunk.choices?.[0]
      if (!choice) continue
      const d = choice.delta
      if (d?.content) {
        content += d.content
        yield { type: 'text', text: d.content }
      }
      if (d?.refusal && !refused) {
        refused = true
        yield { type: 'refused', category: null }
      }
      for (const tc of d?.tool_calls ?? []) {
        const i = tc.index ?? 0
        const cur = calls.get(i) ?? { id: '', name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        calls.set(i, cur)
      }
      if (choice.finish_reason) finish = choice.finish_reason
    }

    const toolCalls: OaiToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => ({ id: c.id || `call_${i}`, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } }))
    for (const c of toolCalls) {
      let input: unknown = {}
      try {
        input = JSON.parse(c.function.arguments)
      } catch {
        // Invalid JSON arguments: the tool loop's validation reports it back to the model.
        input = { __invalid_json: c.function.arguments }
      }
      yield { type: 'tool_use', id: c.id, name: c.function.name, input }
    }
    const stopReason = toolCalls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'stop' || finish === null ? 'end' : 'other'
    // OpenAI-style prompt_tokens include cached ones; the contract counts them separately.
    usage.inputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens)
    yield { type: 'done', stopReason, usage, raw: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }
  }

  /** The models this key can use, for the Setup dropdown. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.fetch(this.url('/models'), { headers: this.headers(), signal })
    if (!res.ok) throw new Error(await errorText(res, this.opts.label))
    const body = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string; id?: string }[] }
    const ids = (body.data ?? body.models ?? []).map(m => (m as { id?: string; name?: string }).id ?? (m as { name?: string }).name ?? '').filter(Boolean)
    return [...new Set(ids.map(id => id.replace(/^models\//, '')))].sort()
  }

  async healthCheck() {
    try {
      const res = await this.fetch(this.url('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: 'Reply with OK.' }], [this.opts.maxTokensParam ?? 'max_tokens']: 16 }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) return { ok: false as const, error: await errorText(res, this.opts.label) }
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, error: `${this.opts.label} unreachable: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}
