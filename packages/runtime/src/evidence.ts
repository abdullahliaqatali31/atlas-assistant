/**
 * Grounded context for the daily briefing (plan 13.2): calendar and email
 * through read-only MCP connectors, and opt-in window activity. Each source
 * is read with a timeout right before the briefing; what came back goes into
 * the context packet labelled with its source so the briefing can cite it,
 * and a source that failed is named as unavailable instead of silently
 * missing. Connector output is untrusted data, never instructions.
 */
import { resolveBriefingArgs, type McpHost } from '@assistant/mcp'
import type { SourceKind } from '@assistant/shared'

export interface EvidenceSource {
  /** Stable id, e.g. "google-calendar:list-events" or "window-activity". */
  id: string
  /** How the briefing cites it: "Google Calendar". */
  label: string
  kind: SourceKind
  /** False for local observations the owner opted into; true for connector output. */
  untrusted: boolean
  collect(ctx: { now: number; utcOffsetMin: number; signal: AbortSignal }): Promise<string>
}

export interface EvidenceBlock {
  id: string
  label: string
  kind: SourceKind
  untrusted: boolean
  retrievedAt: number
  text?: string
  /** Why nothing came back (timeout, needs permission, server down). */
  unavailable?: string
}

const MAX_SOURCE_CHARS = 4_000
const DEFAULT_TIMEOUT_MS = 8_000

const timeoutError = (ms: number) => new Error(ms >= 1000 ? `no answer within ${Math.round(ms / 1000)} s` : `no answer within ${ms} ms`)

/** Reads every source in parallel; none can hold the briefing longer than `timeoutMs`. */
export const gatherEvidence = async (
  sources: readonly EvidenceSource[],
  ctx: { now: number; utcOffsetMin: number; signal?: AbortSignal | undefined },
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<EvidenceBlock[]> =>
  Promise.all(
    sources.map(async (s): Promise<EvidenceBlock> => {
      const base = { id: s.id, label: s.label, kind: s.kind, untrusted: s.untrusted, retrievedAt: ctx.now }
      const abort = new AbortController()
      const onOuter = () => abort.abort()
      ctx.signal?.addEventListener('abort', onOuter, { once: true })
      let timer: NodeJS.Timeout | undefined
      try {
        const text = await Promise.race([
          s.collect({ now: ctx.now, utcOffsetMin: ctx.utcOffsetMin, signal: abort.signal }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // Settle first so the timeout, not the source's abort error, is reported.
              reject(timeoutError(timeoutMs))
              abort.abort()
            }, timeoutMs)
          }),
        ])
        const trimmed = text.trim()
        return { ...base, text: trimmed.length > MAX_SOURCE_CHARS ? `${trimmed.slice(0, MAX_SOURCE_CHARS)}\n…(truncated)` : trimmed }
      } catch (error) {
        return { ...base, unavailable: error instanceof Error ? error.message : String(error) }
      } finally {
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onOuter)
      }
    }),
  )

const attr = (s: string) => s.replace(/["<>&]/g, '')

/** The context-packet section for the briefing. Empty when no source is connected. */
export const formatEvidence = (blocks: readonly EvidenceBlock[]): string => {
  if (!blocks.length) return ''
  const parts = blocks.map(b => {
    const when = new Date(b.retrievedAt).toISOString().slice(0, 16)
    if (b.unavailable) return `- ${b.label} (${b.kind}): unavailable right now (${b.unavailable}). Say so if it matters; do not guess its contents.`
    const body = b.text || '(nothing returned)'
    return b.untrusted
      ? `<untrusted source="${attr(b.label)}" kind="${b.kind}" retrieved="${when}Z">\n${body}\n</untrusted>`
      : `<observation source="${attr(b.label)}" kind="${b.kind}" retrieved="${when}Z">\n${body}\n</observation>`
  })
  return `Connected sources (cite each item by its source name, e.g. "per Google Calendar"; a preview or a list is not the whole conversation):\n${parts.join('\n')}`
}

/** One briefing source per read a running read-only connector declares. */
export const mcpEvidenceSources = (host: Pick<McpHost, 'briefingCalls' | 'call'>): EvidenceSource[] =>
  host.briefingCalls().map(({ server, qualifiedName, call }) => ({
    id: `${server}:${call.tool}`,
    label: call.label,
    kind: call.kind,
    untrusted: true,
    collect: async ({ now, utcOffsetMin, signal }) => {
      const out = await host.call(qualifiedName, resolveBriefingArgs(call.args, now, utcOffsetMin), { signal })
      if (out.status === 'ok') return out.untrustedText
      if (out.status === 'error') throw new Error(out.message)
      throw new Error(out.status === 'needs-confirmation' ? 'reading it needs a standing permission in Permissions' : out.decision.reason)
    },
  }))
