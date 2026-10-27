/**
 * Provider-neutral LLM contract. Adapters translate to one vendor's API; the
 * runtime never imports a vendor SDK directly.
 *
 * History rule: within one tool loop the request is append-only and assistant
 * turns are replayed through `raw` exactly as the provider returned them
 * (some providers bind reasoning blocks to the exact prefix). Across owner
 * turns only text is kept, so per-turn context never edits a replayed block.
 */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  /** A picture in an owner turn (a screenshot to look at), base64. Vision-capable models only. */
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg'; data: string }

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
  /** Provider-native assistant content, replayed verbatim inside a tool loop. */
  raw?: unknown
  /**
   * Everything up to and including this turn stays the same on the next
   * call (the end of the conversation history): providers with explicit
   * prompt caching put a cache marker here.
   */
  cacheBreak?: boolean
}

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the tool input (an object schema). */
  inputSchema: Record<string, unknown>
}

export interface LlmRequest {
  /**
   * Stable persona + policy summary: byte-identical across calls so it caches.
   * Several blocks go most stable first; each is cached on its own, so a
   * change to a later block (the owner's profile) keeps the earlier ones warm.
   */
  system: string | readonly string[]
  turns: ChatTurn[]
  /** The full tool set for the session; declared up front and kept stable. */
  tools?: ToolSpec[]
  maxTokens?: number
  /** Coarse depth hint; adapters map it to the vendor's knob. */
  effort?: 'low' | 'medium' | 'high'
}

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'done'; stopReason: 'end' | 'tool_use' | 'max_tokens' | 'other'; usage: LlmUsage; raw: unknown }
  | { type: 'refused'; category: string | null }

export interface LlmUsage {
  /** Input tokens not served from cache (adapters subtract cached ones where the API includes them). */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Input tokens written to the prompt cache this call (billed a little above normal input). */
  cacheWriteTokens?: number
}

export interface LlmProvider {
  readonly id: string
  readonly model: string
  /** Streams one reply. Abort the signal to cancel (e.g. owner interrupts). */
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent>
  /** Cheap call used by setup to verify the key works. */
  healthCheck(): Promise<{ ok: true } | { ok: false; error: string }>
}
