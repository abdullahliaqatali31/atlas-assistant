import { describe, expect, it } from 'vitest'

import type { LlmEvent } from './llm.ts'
import { createLlm, listLlmModels } from './llm-providers.ts'
import { modelFor } from './llm-presets.ts'
import { OpenAICompatibleProvider, toMessages } from './openai-compatible.ts'

/** A fake provider: records requests and streams the given SSE chunks. */
const fakeFetch = (chunks: unknown[], status = 200) => {
  const calls: { url: string; init: RequestInit }[] = []
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    if (status !== 200) return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status })
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-x' }, { id: 'models/gemini-y' }] }))
    const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(new Blob([body]).stream(), { status: 200 })
  }) as typeof fetch
  return { f, calls }
}

const collect = async (it: AsyncIterable<LlmEvent>) => {
  const out: LlmEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('OpenAI-compatible adapter', () => {
  it('streams text, joins a tool call split over chunks, and reports usage', async () => {
    const { f, calls } = fakeFetch([
      { choices: [{ delta: { content: 'Let me ' } }] },
      { choices: [{ delta: { content: 'check.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'tasks_', arguments: '{"li' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'list', arguments: 'mit":3}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } },
    ])
    const llm = new OpenAICompatibleProvider({ label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1/', apiKey: 'k', model: 'some-model', fetch: f })
    const events = await collect(llm.stream({ system: ['persona', 'profile'], turns: [{ role: 'user', content: 'tasks?' }], tools: [{ name: 'tasks_list', description: 'List', inputSchema: { type: 'object' } }] }))
    expect(events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('')).toBe('Let me check.')
    expect(events).toContainEqual({ type: 'tool_use', id: 'call_1', name: 'tasks_list', input: { limit: 3 } })
    const done = events.at(-1) as Extract<LlmEvent, { type: 'done' }>
    expect(done).toMatchObject({ type: 'done', stopReason: 'tool_use', usage: { inputTokens: 20, outputTokens: 30, cacheReadTokens: 100 } })
    // The exact assistant message is kept for replay in the tool loop.
    expect(done.raw).toEqual({ role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'tasks_list', arguments: '{"limit":3}' } }] })
    const sent = JSON.parse(String(calls[0]!.init.body))
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer k')
    expect(sent).toMatchObject({ model: 'some-model', stream: true, max_tokens: 8192, tool_choice: 'auto' })
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'persona\n\nprofile' })
    expect(sent.tools[0]).toEqual({ type: 'function', function: { name: 'tasks_list', description: 'List', parameters: { type: 'object' } } })
  })

  it('turns tool results into tool messages and replays the assistant turn exactly', () => {
    const raw = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] }
    const msgs = toMessages('sys', [
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: 'context' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'x', input: {} }], raw },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'boom', isError: true }] },
    ])
    expect(msgs).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi\n\ncontext' },
      raw,
      { role: 'tool', tool_call_id: 'c1', content: 'Error: boom' },
    ])
  })

  it('explains failures in plain words and lists models', async () => {
    const bad = new OpenAICompatibleProvider({ label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'wrong', model: 'm', fetch: fakeFetch([], 401).f })
    expect(await bad.healthCheck()).toEqual({ ok: false, error: 'OpenAI 401 (check the API key): Invalid API key' })
    await expect(collect(bad.stream({ system: 's', turns: [{ role: 'user', content: 'x' }] }))).rejects.toThrow(/401/)
    const ok = new OpenAICompatibleProvider({ label: 'Gemini', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', fetch: fakeFetch([]).f })
    expect(await ok.listModels()).toEqual(['gemini-y', 'gpt-x'])
  })
})

describe('provider factory', () => {
  it('picks the adapter, endpoint and models per provider', () => {
    expect(createLlm({ provider: 'anthropic', apiKey: 'k' }).model).toBe('claude-opus-5-5')
    expect(modelFor({ provider: 'anthropic', apiKey: 'k' }, 'background')).toBe('claude-haiku-5-5')
    expect(modelFor({ provider: 'groq', apiKey: 'k', model: 'llama-x' }, 'background')).toBe('llama-x')
    expect(modelFor({ provider: 'groq', apiKey: 'k', model: 'big', backgroundModel: 'small' }, 'background')).toBe('small')
    expect(createLlm({ provider: 'ollama', apiKey: '', model: 'qwen' }).id).toBe('ollama-free-on-this-pc-')
    expect(() => createLlm({ provider: 'custom', apiKey: 'k', model: 'm' })).toThrow(/base URL/)
  })

  it('uses max_completion_tokens for OpenAI and no auth header for Ollama', async () => {
    const { f, calls } = fakeFetch([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }])
    await collect(createLlm({ provider: 'openai', apiKey: 'k', model: 'm' }, 'chat', f).stream({ system: 's', turns: [{ role: 'user', content: 'x' }] }))
    expect(JSON.parse(String(calls[0]!.init.body))).toHaveProperty('max_completion_tokens', 8192)
    const local = fakeFetch([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }])
    await collect(createLlm({ provider: 'ollama', apiKey: '', model: 'qwen' }, 'chat', local.f).stream({ system: 's', turns: [{ role: 'user', content: 'x' }] }))
    expect(local.calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions')
    expect((local.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('lists Claude models without a network call', async () => {
    expect(await listLlmModels({ provider: 'anthropic', apiKey: 'k' })).toContain('claude-haiku-5-5')
  })
})
