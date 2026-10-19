/**
 * The runtime side of the owner's controls: owner rules (received from main,
 * never written here), the pause switch, MCP server (re)starts and the
 * open_application tool. Rules reach the policy gate through `rules()` only.
 */
import { randomUUID } from 'node:crypto'

import { loadMcpConfig, McpHost } from '@assistant/mcp'
import type { Rule } from '@assistant/policy'
import { DEFAULT_RULES, mcpEvidenceSources, mcpTools, type Assistant, type EvidenceSource, type RuntimeTool } from '@assistant/runtime'

import { OPEN_APP_TOOL, type ControlHostEvent, type ServerState, type ToolView } from '../shared/control.ts'

const OPEN_APP_TIMEOUT_MS = 15_000

export interface HostControlsDeps {
  post: (e: ControlHostEvent) => void
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  now: () => number
  /** The Playwright Extension token, from the OS credential store. */
  extensionToken?: () => string | undefined
  /** Standing allows for the host's own tools (e.g. code projects). */
  extraRules?: Rule[]
}

export class HostControls {
  paused = false
  /** Set by main: the owner turned Full control on. */
  fullControl: { on: boolean; mode: string | null; until: number | null } = { on: false, mode: null, until: null }
  private ownerRules: Rule[] = []
  private apps: { id: string; name: string }[] = []
  private mcp: McpHost | null = null
  private servers: { name: string; state: ServerState; error?: string | undefined }[] = []
  private local: RuntimeTool[] = []
  private assistant: Assistant | null = null
  private mcpPath = ''
  private queue: Promise<void> = Promise.resolve()
  private readonly openRequests = new Map<string, (error?: string) => void>()

  constructor(private readonly deps: HostControlsDeps) {}

  /** What the policy gate sees. Opening an app can never be allowed without asking, whatever arrives. */
  readonly rules = (): Rule[] => [...DEFAULT_RULES, ...(this.deps.extraRules ?? []), ...this.ownerRules.filter(r => !(r.tool === OPEN_APP_TOOL && r.effect === 'allow'))]

  setRules(rules: Rule[]) {
    this.ownerRules = rules.filter(r => r.id.startsWith('owner-'))
  }

  setApps(apps: { id: string; name: string }[]) {
    this.apps = apps
    this.refreshTools()
  }

  /** Called once the assistant exists; MCP servers then start in the background. */
  attach(assistant: Assistant, local: RuntimeTool[], mcpPath: string) {
    this.assistant = assistant
    this.local = local
    this.mcpPath = mcpPath
    this.refreshTools()
    return this.reloadMcp()
  }

  /** Restart only the MCP host; queued so overlapping changes apply in order. */
  reloadMcp(): Promise<void> {
    this.queue = this.queue.then(() => this.restartMcp()).catch(error => this.deps.log('error', `MCP restart failed: ${error instanceof Error ? error.message : String(error)}`))
    return this.queue
  }

  private async restartMcp() {
    if (!this.assistant) return
    // Reports during the restart say "starting", never "running with no tools".
    this.servers = this.servers.map(({ name }) => ({ name, state: 'starting' as const }))
    await this.mcp?.stop()
    this.mcp = null
    this.refreshTools()
    let config
    try {
      config = loadMcpConfig(this.mcpPath)
    } catch {
      this.servers = []
      this.deps.log('error', 'mcp.servers.json is not valid JSON; no connections started.')
      return this.report()
    }
    // The Playwright Extension token lives in the OS credential store; only the server that uses it gets it.
    const token = this.deps.extensionToken?.()
    if (token) for (const cfg of Object.values(config.servers)) if (cfg.args?.includes('--extension')) cfg.env = { ...cfg.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token }
    const host = new McpHost(config, this.rules, this.deps.now)
    const failures = new Map((await host.start()).map(f => [f.server, f.error]))
    for (const [server, error] of failures) this.deps.log('warn', `MCP server ${server} failed to start: ${error}`)
    this.mcp = host
    this.servers = Object.entries(config.servers)
      .filter(([, cfg]) => cfg.enabled)
      .map(([name]) => (failures.has(name) ? { name, state: 'failed' as const, error: failures.get(name) } : { name, state: 'running' as const }))
    this.refreshTools()
    this.report()
  }

  private tools(): RuntimeTool[] {
    const open = this.apps.length ? [this.openAppTool()] : []
    return [...this.local, ...open, ...(this.mcp ? mcpTools(this.mcp) : [])].map(t => this.guard(t))
  }

  private refreshTools() {
    if (!this.assistant) return
    this.assistant.setTools(this.tools())
    this.report()
  }

  private report() {
    const tools: ToolView[] = this.tools().map(t => ({ name: t.name, actionClass: t.actionClass, server: this.mcp?.listTools().find(m => m.name === t.name)?.server }))
    this.deps.post({ type: 'capabilities', servers: this.servers, tools, defaultRules: DEFAULT_RULES })
  }

  /** While paused, nothing runs, even under a standing allow rule. */
  private guard(tool: RuntimeTool): RuntimeTool {
    return {
      ...tool,
      run: (input, signal) => (this.paused ? Promise.reject(new Error('Automation is paused by the owner.')) : tool.run(input, signal)),
    }
  }

  private openAppTool(): RuntimeTool {
    const names = this.apps.map(a => a.name)
    return {
      name: OPEN_APP_TOOL,
      description: `Open one of the owner's allow-listed desktop applications (${names.join(', ')}). Nothing else can be opened; the owner approves each time.`,
      inputSchema: {
        type: 'object',
        properties: { app: { type: 'string', enum: names, description: 'Application name from the list' } },
        required: ['app'],
        additionalProperties: false,
      },
      actionClass: 'modify',
      isUntrusted: false,
      run: async (input, signal) => {
        const wanted = typeof input.app === 'string' ? input.app.trim().toLowerCase() : ''
        const app = this.apps.find(a => a.name.toLowerCase() === wanted)
        if (!app) throw new Error(`"${String(input.app)}" is not on the owner's allow list.`)
        const requestId = randomUUID()
        const error = await new Promise<string | undefined>(resolve => {
          const done = (e?: string) => {
            if (!this.openRequests.delete(requestId)) return
            clearTimeout(timer)
            resolve(e)
          }
          const timer = setTimeout(() => done('Opening the application timed out.'), OPEN_APP_TIMEOUT_MS)
          signal?.addEventListener('abort', () => done('Stopped.'), { once: true })
          this.openRequests.set(requestId, done)
          this.deps.post({ type: 'open-app', requestId, appId: app.id })
        })
        if (error) throw new Error(error)
        return `Opened ${app.name}.`
      },
    }
  }

  /** Briefing reads of running read-only connectors; none while automation is paused. */
  briefingSources(): EvidenceSource[] {
    return this.mcp && !this.paused ? mcpEvidenceSources(this.mcp) : []
  }

  onOpenResult(requestId: string, error?: string) {
    this.openRequests.get(requestId)?.(error)
  }

  async stop() {
    await this.mcp?.stop()
  }
}
