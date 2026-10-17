/**
 * MCP client host. Connects to owner-configured MCP servers, classifies their
 * tools for the policy gate, and routes every call through it. Tool output is
 * returned as untrusted data tagged with its server.
 */
import { readFileSync } from 'node:fs'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { classifyMcpTool, evaluate, type ActionClass, type Decision, type Rule, type ToolAnnotations } from '@assistant/policy'

export interface ServerConfig {
  enabled: boolean
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Owner marks a server trusted to let its annotations relax classification. */
  trusted?: boolean
  /** Per-tool class overrides set by the owner. */
  overrides?: Record<string, ActionClass>
  /**
   * Only tools whose class (after overrides) is observe are offered or
   * callable. Curated calendar and email connectors start this way.
   */
  readOnly?: boolean
  /** Read calls whose results ground the daily briefing, cited by label. */
  briefing?: BriefingCall[]
}

/** One read a connector contributes to the briefing. */
export interface BriefingCall {
  kind: 'calendar' | 'email'
  /** How the briefing cites it, e.g. "Google Calendar". */
  label: string
  tool: string
  /** String values may use {dayStart}, {dayEnd}, {now} (owner-local ISO with offset) and {today} (YYYY/MM/DD). */
  args?: Record<string, unknown>
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Fills the placeholders of a briefing call for the owner's day. */
export const resolveBriefingArgs = (args: Record<string, unknown> = {}, now: number, utcOffsetMin: number): Record<string, unknown> => {
  const local = new Date(now + utcOffsetMin * 60_000)
  const date = local.toISOString().slice(0, 10)
  const abs = Math.abs(utcOffsetMin)
  const off = `${utcOffsetMin < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  const values: Record<string, string> = {
    dayStart: `${date}T00:00:00${off}`,
    dayEnd: `${date}T23:59:59${off}`,
    now: `${local.toISOString().slice(0, 19)}${off}`,
    today: date.replaceAll('-', '/'),
  }
  const fill = (v: unknown) => (typeof v === 'string' ? v.replace(/\{(dayStart|dayEnd|now|today)\}/g, (_, name: string) => values[name]!) : v)
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, fill(v)]))
}

export interface McpConfig {
  servers: Record<string, ServerConfig>
}

export const loadMcpConfig = (path: string): McpConfig => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as McpConfig
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: {} }
    throw error
  }
}

export interface HostedTool {
  /** Qualified name the LLM sees: "<server>__<tool>". */
  name: string
  server: string
  tool: string
  description: string
  inputSchema: unknown
  actionClass: ActionClass
}

export type CallOutcome =
  | { status: 'ok'; server: string; untrustedText: string }
  | { status: 'needs-confirmation'; decision: Decision }
  | { status: 'denied'; decision: Decision }
  | { status: 'error'; message: string }

export const qualify = (server: string, tool: string) => `${server}__${tool}`

export const toHostedTool = (
  server: string,
  config: Pick<ServerConfig, 'trusted' | 'overrides'>,
  tool: { name: string; description?: string; inputSchema: unknown; annotations?: ToolAnnotations },
): HostedTool => ({
  name: qualify(server, tool.name),
  server,
  tool: tool.name,
  description: tool.description ?? '',
  inputSchema: tool.inputSchema,
  actionClass: config.overrides?.[tool.name] ?? classifyMcpTool(tool.annotations, config.trusted === true),
})

export class McpHost {
  private readonly clients = new Map<string, Client>()
  private tools = new Map<string, HostedTool>()

  constructor(
    private readonly config: McpConfig,
    private readonly rules: () => readonly Rule[],
    private readonly now: () => number,
  ) {}

  /** Starts enabled servers. A server that fails to start is reported, not fatal. */
  async start(): Promise<{ server: string; error: string }[]> {
    const failures: { server: string; error: string }[] = []
    for (const [name, cfg] of Object.entries(this.config.servers)) {
      if (!cfg.enabled) continue
      try {
        const client = new Client({ name: 'personal-assistant', version: '0.1.0' })
        await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env: cfg.env }))
        this.clients.set(name, client)
        const { tools } = await client.listTools()
        for (const t of tools) {
          const hosted = toHostedTool(name, cfg, t as Parameters<typeof toHostedTool>[2])
          // A read-only connector's write tools are never offered, whatever a rule says.
          if (cfg.readOnly && hosted.actionClass !== 'observe') continue
          this.tools.set(hosted.name, hosted)
        }
      } catch (error) {
        failures.push({ server: name, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return failures
  }

  listTools(): HostedTool[] {
    return [...this.tools.values()]
  }

  /** Briefing reads of running servers whose tool is actually offered. */
  briefingCalls(): { server: string; qualifiedName: string; call: BriefingCall }[] {
    return Object.entries(this.config.servers).flatMap(([server, cfg]) =>
      cfg.enabled && this.clients.has(server)
        ? (cfg.briefing ?? []).flatMap(call => (this.tools.has(qualify(server, call.tool)) ? [{ server, qualifiedName: qualify(server, call.tool), call }] : []))
        : [],
    )
  }

  /** `confirmed` is set only after the owner approved this exact call in the UI. */
  async call(
    qualifiedName: string,
    args: Record<string, unknown>,
    opts: { scope?: string | undefined; confirmed?: boolean; signal?: AbortSignal | undefined } = {},
  ): Promise<CallOutcome> {
    const tool = this.tools.get(qualifiedName)
    if (!tool) return { status: 'error', message: `Unknown tool ${qualifiedName}` }

    const decision = evaluate({ tool: qualifiedName, actionClass: tool.actionClass, scope: opts.scope }, this.rules(), this.now())
    if (decision.effect === 'deny') return { status: 'denied', decision }
    if (decision.effect === 'ask' && !opts.confirmed) return { status: 'needs-confirmation', decision }

    const client = this.clients.get(tool.server)
    if (!client) return { status: 'error', message: `Server ${tool.server} is not running` }
    try {
      // Aborting sends the server a cancellation and rejects at once.
      const result = await client.callTool({ name: tool.tool, arguments: args }, undefined, opts.signal ? { signal: opts.signal } : undefined)
      const content = (result.content ?? []) as { type: string; text?: string }[]
      const text = content.map(c => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n')
      // A tool-level failure (e.g. "Access denied") is an error, not a result.
      if (result.isError === true) return { status: 'error', message: text || `${qualifiedName} failed` }
      return { status: 'ok', server: tool.server, untrustedText: text }
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  async stop() {
    await Promise.allSettled([...this.clients.values()].map(c => c.close()))
    this.clients.clear()
    this.tools = new Map()
  }
}

export { CONNECTORS, connectorById, connectorServer, type ConnectorEntry, type ConnectorId } from './connectors.ts'
