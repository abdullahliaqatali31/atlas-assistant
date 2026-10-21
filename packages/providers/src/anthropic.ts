import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextBlockParam,
  BetaTool,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'

import type { ChatTurn, LlmEvent, LlmProvider, LlmRequest } from './llm.ts'

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'

/** Models with server-side refusal fallback and thinking-binding controls. */
const WITH_FALLBACK = /^claude-(opus-5|opus-5-5|fable-5-1|sonnet-5-5)$/

const BETAS = [
  // Server-side refusal fallback: routes a declined request by category.
  'server-side-fallback-2026-07-01',
  // Lets a mismatched replayed thinking block be dropped instead of failing the request.
  'thinking-binding-controls-2026-08-01',
]

/**
 * Claude adapter. The persona and the owner's profile are separate cached
 * system blocks that never change per turn; per-turn context travels in the
 * user message instead.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic'
  private readonly client: Anthropic

  constructor(
    apiKey: string,
    readonly model: string = DEFAULT_ANTHROPIC_MODEL,
  ) {
    this.client = new Anthropic({ apiKey })
  }

  async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent> {
    const system: BetaTextBlockParam[] = (typeof req.system === 'string' ? [req.system] : req.system).map(text => ({
      type: 'text',
      text,
      cache_control: { type: 'ephemeral' },
    }))
    const tools: BetaTool[] | undefined = req.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as BetaTool['input_schema'],
      eager_input_streaming: true,
    }))

    // Cache markers (at most 4): one per system block (above), one at the end of the conversation
    // history, and the API's automatic marker on the newest block for the tool loop's growing tail.
    const messages = req.turns.map(toMessage)
    const markers = applyCacheMarkers(req.turns, messages, system.length)

    const params: BetaMessageStreamParams = {
      model: this.model,
      max_tokens: req.maxTokens ?? 8192,
      system,
      messages,
      ...(markers < MAX_CACHE_MARKERS ? { cache_control: { type: 'ephemeral' } } : {}),
      ...(tools && tools.length > 0 ? { tools, tool_choice: { type: 'auto' } } : {}),
      // Server-side refusal fallback and thinking-binding controls exist only on the larger models; Haiku gets plain adaptive thinking.
      ...(WITH_FALLBACK.test(this.model)
        ? { thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }, betas: BETAS, fallbacks: 'default' }
        : { thinking: { type: 'adaptive' } }),
      output_config: { effort: req.effort ?? 'low' },
    } as BetaMessageStreamParams

    const stream = this.client.beta.messages.stream(params, { signal })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text }
      }
    }

    const final = await stream.finalMessage()
    if (final.stop_reason === 'refusal') {
      yield { type: 'refused', category: final.stop_details?.category ?? null }
      return
    }
    for (const block of final.content) {
      // Tool input arrives already parsed; an eager stream can still yield a
      // truncated object, so the runtime validates it against the schema.
      if (block.type === 'tool_use') yield { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    }
    yield {
      type: 'done',
      stopReason:
        final.stop_reason === 'end_turn' ? 'end' : final.stop_reason === 'tool_use' ? 'tool_use' : final.stop_reason === 'max_tokens' ? 'max_tokens' : 'other',
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
      raw: final.content,
    }
  }

  async healthCheck() {
    try {
      await this.client.models.retrieve(this.model)
      return { ok: true as const }
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) return { ok: false as const, error: 'The API key was rejected.' }
      if (error instanceof Anthropic.NotFoundError) return { ok: false as const, error: `Model ${this.model} is not available to this key.` }
      if (error instanceof Anthropic.APIConnectionError) return { ok: false as const, error: 'Could not reach the Anthropic API.' }
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

const MAX_CACHE_MARKERS = 4
/** Blocks that can carry a cache marker (thinking blocks cannot). */
const CACHEABLE = new Set(['text', 'image', 'tool_use', 'tool_result', 'document'])

/** Puts a cache marker on a message's last markable block, copying rather than touching replayed content. */
const markLast = (m: BetaMessageParam): boolean => {
  if (typeof m.content === 'string') {
    m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
    return true
  }
  const blocks = [...m.content]
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i] as { type: string }
    if (!CACHEABLE.has(b.type)) continue
    blocks[i] = { ...(b as object), cache_control: { type: 'ephemeral' } } as BetaContentBlockParam
    m.content = blocks
    return true
  }
  return false
}

/**
 * Marks the turns flagged cacheBreak (the end of the history), within the
 * 4-marker limit after the system blocks. Returns how many markers are used,
 * so the caller knows whether the automatic marker still fits.
 */
export const applyCacheMarkers = (turns: readonly ChatTurn[], messages: BetaMessageParam[], systemMarkers: number): number => {
  let markers = systemMarkers
  for (let i = 0; i < turns.length && markers < MAX_CACHE_MARKERS; i++) if (turns[i]!.cacheBreak && markLast(messages[i]!)) markers++
  return markers
}

export const toMessage = (turn: ChatTurn): BetaMessageParam => {
  if (turn.role === 'assistant' && turn.raw !== undefined) {
    return { role: 'assistant', content: turn.raw as BetaContentBlockParam[] }
  }
  if (typeof turn.content === 'string') return { role: turn.role, content: turn.content }
  const content: BetaContentBlockParam[] = turn.content.map(part => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text }
      case 'tool_use':
        return { type: 'tool_use', id: part.id, name: part.name, input: part.input }
      case 'tool_result':
        return { type: 'tool_result', tool_use_id: part.toolUseId, content: part.content, is_error: part.isError ?? false }
      case 'image':
        return { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }
    }
  })
  return { role: turn.role, content }
}
