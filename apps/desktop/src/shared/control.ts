/**
 * Contract for the owner's control surfaces: Connections (MCP servers and
 * allow-listed apps), Permissions (standing rules), Activity and the safety
 * switches. Only the owner, through these screens, changes any of it: main
 * stores it and hands rules to the runtime read-only, so the LLM has no path
 * to edit a rule.
 */
import { CONNECTORS, type ConnectorId } from '@assistant/mcp/connectors'
import { ACTION_CLASSES, type ActionClass, type Rule } from '@assistant/policy'

export { ACTION_CLASSES, type ActionClass, type Rule }

/** Tool that opens an allow-listed application. Owner rules can never auto-allow it. */
export const OPEN_APP_TOOL = 'open_application'

/** Classes that always ask whatever a rule says, so an allow rule for them would mislead. */
export const ALWAYS_ASK: readonly ActionClass[] = ['destructive', 'credential', 'payment']

export type CatalogueId = 'playwright' | 'filesystem' | ConnectorId

export interface CatalogueEntry {
  id: CatalogueId
  label: string
  description: string
  /** False for connectors that are planned but not offered yet. */
  available: boolean
  /** Calendar and email connectors: only read tools are offered, and they feed the daily briefing. */
  readOnly?: boolean
  kinds?: ('calendar' | 'email')[]
  /** One-time steps before enabling (OAuth client, sign-in), shown beside the switch. */
  setup?: string
  homepage?: string
  /** The connector needs an OAuth client file the owner picks (`pickCredentials`). */
  needsCredentialsFile?: boolean
}

export const isCatalogueId = (v: string): v is CatalogueId => v === 'playwright' || v === 'filesystem' || CONNECTORS.some(c => c.id === v)

export const CATALOGUE: readonly CatalogueEntry[] = [
  {
    id: 'playwright',
    label: 'Browser (Playwright)',
    description:
      'Websites for the assistant. Either a separate browser with a fresh, empty profile each start, or your own Chrome or Edge with your sign-ins, through the Playwright Extension.',
    available: true,
  },
  {
    id: 'filesystem',
    label: 'Files',
    description: 'Read and write only inside the folders you choose here.',
    available: true,
  },
  ...CONNECTORS.map(
    (c): CatalogueEntry => ({
      id: c.id,
      label: c.label,
      description: c.description,
      available: true,
      readOnly: true,
      kinds: c.kinds,
      setup: c.setup,
      homepage: c.homepage,
      needsCredentialsFile: Boolean(c.credentialsEnv),
    }),
  ),
]

export type ServerState = 'off' | 'starting' | 'running' | 'failed'

export interface ToolView {
  name: string
  actionClass: ActionClass
  /** MCP server name, absent for built-in tools. */
  server?: string | undefined
}

/** Chromium browsers the Playwright Extension runs in. Chrome and Edge are Playwright channels; the rest are started by their program file. */
export const BROWSER_IDS = ['chrome', 'msedge', 'comet', 'brave'] as const
export type BrowserId = (typeof BROWSER_IDS)[number]
export const BROWSER_LABEL: Record<BrowserId, string> = { chrome: 'Google Chrome', msedge: 'Microsoft Edge', comet: 'Comet (may be blocked)', brave: 'Brave (untested)' }
/** Known to refuse the extension's connect page (ERR_BLOCKED_BY_CLIENT): Comet locks down extension pages opened from outside. */
export const BROWSER_WARNING: Partial<Record<BrowserId, string>> = {
  comet: 'Comet blocks the Playwright Extension from connecting (it shows ERR_BLOCKED_BY_CLIENT). Use Chrome or Edge for this; Playwright supports only those two officially.',
  brave: 'Brave is not officially supported by Playwright; if it does not connect, use Chrome or Edge.',
}
/** Where each settings page lives, to find the profile name. */
export const BROWSER_VERSION_PAGE: Record<BrowserId, string> = { chrome: 'chrome://version', msedge: 'edge://version', comet: 'comet://version', brave: 'brave://version' }

/** Which browser the Browser connector drives. */
export type BrowserSetting = { kind: 'separate' } | { kind: 'mine'; browser: BrowserId; profile: string }
export const DEFAULT_BROWSER: BrowserSetting = { kind: 'separate' }

/** Playwright MCP arguments for a browser setting; `executable` is the program file for browsers that are not Playwright channels. */
export const browserArgs = (b: BrowserSetting, executable?: string): string[] => {
  if (b.kind === 'separate') return ['--isolated']
  const which = b.browser === 'chrome' || b.browser === 'msedge' ? ['--browser', b.browser] : executable ? ['--browser', 'chrome', '--executable-path', executable] : ['--browser', 'chrome']
  return ['--extension', ...which, ...(b.profile ? ['--profile-dir-name', b.profile] : [])]
}

/** A browser setting from the renderer, or an error message. */
export const parseBrowserSetting = (v: unknown): BrowserSetting | string => {
  if (typeof v !== 'object' || v === null) return 'Expected a browser setting.'
  const o = v as Record<string, unknown>
  if (o.kind === 'separate') return { kind: 'separate' }
  if (o.kind !== 'mine') return 'Unknown browser mode.'
  if (!(BROWSER_IDS as readonly unknown[]).includes(o.browser)) return 'Choose Chrome, Edge, Comet or Brave.'
  const profile = typeof o.profile === 'string' ? o.profile.trim() : ''
  // A profile folder name like "Default" or "Profile 1": nothing that could become another argument or a path.
  if (profile && (!/^\w[\w ()-]{0,39}$/.test(profile) || profile.includes('--'))) return 'Profile names look like "Default" or "Profile 1".'
  return { kind: 'mine', browser: o.browser as BrowserId, profile }
}

/** The Playwright Extension's connection token: letters, digits, - and _ only. Empty clears it. */
export const parseExtensionToken = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.trim().replace(/^PLAYWRIGHT_MCP_EXTENSION_TOKEN=/, '')
  return t === '' || /^[\w-]{16,200}$/.test(t) ? t : null
}

export interface ServerView {
  name: string
  label: string
  catalog: CatalogueId | null
  enabled: boolean
  /** Owner lets this server's tool hints (read-only, destructive…) set the action class. */
  trusted: boolean
  state: ServerState
  error?: string | undefined
  /** Folder-scoped servers only. */
  folders: string[]
  /** The Browser connector only: which browser it drives. */
  browser?: BrowserSetting | undefined
  /** Command line, for display. */
  command: string
  tools: ToolView[]
  /** Only read tools are offered; enabling it also adds a standing allow for its reads (removable in Permissions). */
  readOnly: boolean
  /** Contributes to the daily briefing as a cited source. */
  briefing: boolean
  /** The OAuth client file this connector uses, when it needs one; null until picked. */
  credentialsFile: string | null
}

export interface AppEntry {
  id: string
  name: string
  path: string
}

export interface RunningAction {
  tool: string
  detail?: string | undefined
  since: number
}

/** How long Full control lasts once on: until the owner locks, leaves or the PC sleeps; an hour; or until turned off. */
export const FULL_CONTROL_MODES = ['session', 'hour', 'manual'] as const
export type FullControlMode = (typeof FULL_CONTROL_MODES)[number]

export interface FullControlView {
  on: boolean
  mode: FullControlMode | null
  /** When it turns itself off (hour mode). */
  until: number | null
  since: number | null
}

export interface ControlState {
  /** Automation is stopped: no tool runs until the owner resumes. */
  paused: boolean
  /** Atlas runs the owner's commands without asking (the irreversible and injection guards stay). */
  fullControl: FullControlView
  /** Accelerator for the global pause switch, or null when another app holds it. */
  hotkey: string | null
  servers: ServerView[]
  apps: AppEntry[]
  running: RunningAction[]
  /** Every tool the runtime currently offers, built-in and MCP. */
  tools: ToolView[]
  /** Chromium browsers installed on this PC that the Browser connector can use. */
  browsers: { id: BrowserId; label: string }[]
  /** A Playwright Extension token is stored (in the OS credential store), so it connects without asking each time. */
  extensionToken: boolean
}

export interface RuleView extends Rule {
  source: 'built-in' | 'owner'
}

export interface RuleInput {
  /** A tool name, or "<server>__*" for all of one server's tools. */
  tool: string
  actionClass: ActionClass
  effect: Rule['effect']
  scopePrefix?: string | undefined
  /** Hours until the rule lapses; absent means it stays until removed. */
  expiresInHours?: number | undefined
}

export interface ActivityEntry {
  id: string
  tool: string
  summary: string
  decision: string
  ruleId: string | null
  result: string | null
  evidence: string | null
  at: number
}

export const CC = {
  state: 'controls:state',
  changed: 'controls:changed',
  setServer: 'controls:set-server',
  setTrusted: 'controls:set-trusted',
  addFolder: 'controls:add-folder',
  removeFolder: 'controls:remove-folder',
  addApp: 'controls:add-app',
  removeApp: 'controls:remove-app',
  rules: 'controls:rules',
  addRule: 'controls:add-rule',
  removeRule: 'controls:remove-rule',
  pickScopeFolder: 'controls:pick-scope-folder',
  activity: 'controls:activity',
  setPaused: 'controls:set-paused',
  setFullControl: 'controls:set-full-control',
  stopAll: 'controls:stop-all',
  pickCredentials: 'controls:pick-credentials',
  setBrowser: 'controls:set-browser',
  setExtensionToken: 'controls:set-extension-token',
} as const

/** Exposed by the preload as `window.controls`. */
export interface ControlBridge {
  state(): Promise<ControlState>
  onState(cb: (s: ControlState) => void): () => void
  /** Turns a catalogue connector or configured server on or off; only the MCP host restarts. */
  setServer(name: string, enabled: boolean): Promise<ControlState>
  setTrusted(name: string, trusted: boolean): Promise<ControlState>
  /** Opens a folder chooser and adds the picks to the Files connector. */
  addFolder(): Promise<ControlState>
  removeFolder(path: string): Promise<ControlState>
  /** Opens a file chooser for an application to allow-list. */
  addApp(): Promise<ControlState>
  removeApp(id: string): Promise<ControlState>
  rules(): Promise<RuleView[]>
  addRule(input: RuleInput): Promise<RuleView[]>
  removeRule(id: string): Promise<RuleView[]>
  /** Folder chooser for a rule's scope; null when cancelled. */
  pickScopeFolder(): Promise<string | null>
  activity(): Promise<ActivityEntry[]>
  /** Pausing also stops everything in flight. */
  setPaused(paused: boolean): Promise<ControlState>
  /** Emergency stop: cancels the reply, in-flight tools and pending approvals, and pauses automation. */
  stopAll(): Promise<ControlState>
  /** File chooser for a connector's OAuth client JSON (Google Calendar's gcp-oauth.keys.json). */
  pickCredentials(name: string): Promise<ControlState>
  /** Separate automation browser, or your own Chrome/Edge through the Playwright Extension. */
  setBrowser(setting: BrowserSetting): Promise<ControlState>
  /** Stores the Playwright Extension token in the OS credential store; empty removes it. */
  setExtensionToken(token: string): Promise<ControlState>
  /** Full control on (with how long it lasts) or off. Owner only. */
  setFullControl(on: boolean, mode?: FullControlMode): Promise<ControlState>
}

// ── validation (main process side) ──────────────────────────

const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/i
const TOOL_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/i
const MAX_EXPIRY_HOURS = 24 * 365

export const isServerName = (v: unknown): v is string => typeof v === 'string' && SERVER_NAME.test(v)

export const isShortId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64

/** A rule the owner may add: narrow (names a tool or one server), and never auto-allowing an approval-only tool. */
export const parseRuleInput = (v: unknown): RuleInput | string => {
  if (typeof v !== 'object' || v === null) return 'Invalid rule.'
  const o = v as Record<string, unknown>
  const tool = typeof o.tool === 'string' ? o.tool.trim() : ''
  const serverWide = tool.endsWith('__*') && isServerName(tool.slice(0, -3))
  if (!serverWide && !TOOL_NAME.test(tool)) return 'Pick a tool, or all tools of one connection.'
  if (typeof o.actionClass !== 'string' || !(ACTION_CLASSES as readonly string[]).includes(o.actionClass)) return 'Pick an action class.'
  const actionClass = o.actionClass as ActionClass
  if (o.effect !== 'allow' && o.effect !== 'ask' && o.effect !== 'deny') return 'Pick allow, ask or deny.'
  const effect = o.effect
  if (effect === 'allow' && ALWAYS_ASK.includes(actionClass)) return `${actionClass} actions always ask; a standing allow is not possible.`
  if (effect === 'allow' && tool === OPEN_APP_TOOL) return 'Opening applications always needs your approval.'
  let scopePrefix: string | undefined
  if (o.scopePrefix !== undefined && o.scopePrefix !== '') {
    if (typeof o.scopePrefix !== 'string' || o.scopePrefix.trim().length > 500) return 'Scope must be a folder path or a site, under 500 characters.'
    scopePrefix = o.scopePrefix.trim()
  }
  let expiresInHours: number | undefined
  if (o.expiresInHours !== undefined && o.expiresInHours !== null) {
    if (typeof o.expiresInHours !== 'number' || !(o.expiresInHours > 0 && o.expiresInHours <= MAX_EXPIRY_HOURS)) return 'Expiry must be between an hour and a year.'
    expiresInHours = o.expiresInHours
  }
  return { tool, actionClass, effect, scopePrefix, expiresInHours }
}

/** Re-checks rules read back from disk, so a hand-edited file cannot widen what the UI allows. */
export const isStoredRule = (v: unknown): v is Rule => {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id.startsWith('owner-')) return false
  if (o.expiresAt !== undefined && typeof o.expiresAt !== 'number') return false
  return typeof parseRuleInput({ ...o, expiresInHours: undefined }) !== 'string'
}

// ── main ⇄ runtime host messages ────────────────────────────

export type ControlHostRequest =
  /** Owner rules, re-sent whenever they change. The host never writes them. */
  | { type: 'set-rules'; rules: Rule[] }
  | { type: 'set-paused'; paused: boolean }
  | { type: 'set-full-control'; on: boolean; mode: FullControlMode | null; until: number | null }
  | { type: 'stop-all' }
  /** mcp.servers.json changed: restart only the MCP host. */
  | { type: 'reload-mcp' }
  | { type: 'set-apps'; apps: { id: string; name: string }[] }
  | { type: 'list-actions'; requestId: string }
  | { type: 'open-app-result'; requestId: string; error?: string | undefined }

export type ControlHostEvent =
  | { type: 'capabilities'; servers: { name: string; state: ServerState; error?: string | undefined }[]; tools: ToolView[]; defaultRules: Rule[] }
  | { type: 'actions'; requestId: string; entries: ActivityEntry[] }
  /** The open_application tool, after approval, asks main to open an allow-listed app by id. */
  | { type: 'open-app'; requestId: string; appId: string }
