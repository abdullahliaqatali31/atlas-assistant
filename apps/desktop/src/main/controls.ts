/**
 * The owner's control surfaces, owned by main: which MCP servers run (in
 * mcp.servers.json), which folders and apps they may touch, the standing
 * rules (controls.json in userData) and the pause switch. The runtime gets
 * rules and the app list read-only over IPC; nothing the LLM or a tool says
 * reaches these files, and the Files connector may not be pointed at them.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from 'node:path'

import { connectorById, connectorServer, type BriefingCall } from '@assistant/mcp/connectors'
import { osCredentialStore } from '@assistant/runtime/credentials'
import { app, dialog, globalShortcut, shell, type BrowserWindow } from 'electron'

import {
  CATALOGUE,
  CC,
  isCatalogueId,
  isServerName,
  isShortId,
  isStoredRule,
  parseRuleInput,
  browserArgs,
  DEFAULT_BROWSER,
  parseBrowserSetting,
  parseExtensionToken,
  BROWSER_IDS,
  BROWSER_LABEL,
  type BrowserId,
  type BrowserSetting,
  type ActivityEntry,
  type AppEntry,
  type CatalogueId,
  type ControlHostEvent,
  type ControlHostRequest,
  type ControlState,
  type Rule,
  type RuleView,
  type ServerState,
  type ServerView,
  type ToolView,
} from '../shared/control.ts'
import type { ActionNotice } from '../shared/ipc.ts'

/** Global pause switch: stops everything in flight and blocks tools until pressed again. */
export const PAUSE_HOTKEY = 'CommandOrControl+Alt+P'

interface StoredServer {
  enabled: boolean
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  trusted?: boolean
  overrides?: Record<string, string>
  /** Set on servers created from the catalogue. */
  catalog?: CatalogueId
  /** Folder-scoped servers: the only folders the server is started with. */
  folders?: string[]
  /** The Browser connector: separate browser or the owner's own. */
  browser?: BrowserSetting
  readOnly?: boolean
  briefing?: BriefingCall[]
}

interface McpFile {
  $comment?: string
  servers: Record<string, StoredServer>
}

interface ControlsFile {
  rules: Rule[]
  apps: AppEntry[]
}

const PACKAGES: Record<'playwright' | 'filesystem', string> = {
  // --isolated keeps the browser profile in memory: a dedicated automation browser, never the owner's profile.
  playwright: '@playwright/mcp@latest',
  filesystem: '@modelcontextprotocol/server-filesystem',
}

/** Where each browser usually installs on Windows (per user first). */
const browserPaths = (id: BrowserId): string[] => {
  const local = process.env.LOCALAPPDATA ?? ''
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  switch (id) {
    case 'chrome':
      return [join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')]
    case 'msedge':
      return [join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
    case 'comet':
      return [join(local, 'Perplexity', 'Comet', 'Application', 'comet.exe')]
    case 'brave':
      return [join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]
  }
}
export const findBrowser = (id: BrowserId) => browserPaths(id).find(p => existsSync(p))

const catalogueServer = (id: CatalogueId, folders: string[] = [], browser: BrowserSetting = DEFAULT_BROWSER): StoredServer => {
  if (id === 'playwright') {
    const exe = browser.kind === 'mine' ? findBrowser(browser.browser) : undefined
    return { catalog: id, enabled: false, transport: 'stdio', command: 'npx', args: ['-y', PACKAGES.playwright, ...browserArgs(browser, exe)], browser }
  }
  if (id === 'filesystem') return { catalog: id, enabled: false, transport: 'stdio', command: 'npx', args: ['-y', PACKAGES.filesystem, ...folders], folders }
  // Calendar and email: the curated read-only config from @assistant/mcp.
  return { catalog: id, ...connectorServer(id) }
}

/** The standing rule that lets a read-only connector's reads run (briefing included) without asking each time. */
export const connectorReadRuleId = (name: string) => `owner-connector-${name}`

const writeJson = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

const within = (child: string, parent: string) => {
  const rel = relative(parent.toLowerCase(), child.toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface ControlsDeps {
  handle: (channel: string, fn: (arg: unknown, arg2: unknown) => unknown) => void
  window: () => BrowserWindow | null
  mcpConfigPath: () => string
  /** Post to the runtime host; dropped while it is down (it gets `initMessages` on start). */
  post: (msg: ControlHostRequest) => void
  listActions: () => Promise<ActivityEntry[]>
  /** Push to the renderer and refresh the tray. */
  onChange: (state: ControlState) => void
  /** Silence playback and the mic in the renderer at once. */
  onStop: () => void
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

export class Controls {
  private paused = false
  private hotkey: string | null = null
  private running: ControlState['running'] = []
  private capabilities: { servers: Map<string, { state: ServerState; error?: string | undefined }>; tools: ToolView[]; defaultRules: Rule[] } | null = null
  private reloading = false

  /** The Windows credential store, for the Playwright Extension token. */
  private readonly secrets = osCredentialStore()

  constructor(private readonly deps: ControlsDeps) {}

  private get controlsPath() {
    return join(app.getPath('userData'), 'controls.json')
  }

  // ── files ──

  private readMcp(): McpFile {
    const path = this.deps.mcpConfigPath()
    if (!existsSync(path)) return { servers: {} }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<McpFile>
    return { ...parsed, servers: parsed.servers ?? {} }
  }

  private safeReadMcp(): { file: McpFile; error?: string } {
    try {
      return { file: this.readMcp() }
    } catch {
      return { file: { servers: {} }, error: `${basename(this.deps.mcpConfigPath())} is not valid JSON; fix or delete it.` }
    }
  }

  private writeMcp(file: McpFile) {
    writeJson(this.deps.mcpConfigPath(), {
      $comment: 'Managed by the Connections screen. Servers start disabled; tools without trusted annotations are treated as external-send.',
      ...file,
    })
  }

  private readControls(): ControlsFile {
    try {
      const raw = JSON.parse(readFileSync(this.controlsPath, 'utf8')) as Partial<ControlsFile>
      const now = Date.now()
      return {
        // Re-validated on every read: a hand-edited file cannot add what the UI refuses.
        rules: (raw.rules ?? []).filter(isStoredRule).filter(r => r.expiresAt === undefined || r.expiresAt > now),
        apps: (raw.apps ?? []).filter(a => isShortId(a?.id) && typeof a.name === 'string' && typeof a.path === 'string' && isAbsolute(a.path)),
      }
    } catch {
      return { rules: [], apps: [] }
    }
  }

  private writeControls(next: ControlsFile) {
    writeJson(this.controlsPath, next)
  }

  /** Sent to a (re)starting host before init. */
  initMessages(): ControlHostRequest[] {
    const { rules, apps } = this.readControls()
    return [
      { type: 'set-paused', paused: this.paused },
      { type: 'set-rules', rules },
      { type: 'set-apps', apps: apps.map(({ id, name }) => ({ id, name })) },
    ]
  }

  // ── state ──

  state(): ControlState {
    const { file, error } = this.safeReadMcp()
    const servers: ServerView[] = []
    const names = new Set([...Object.keys(file.servers), ...CATALOGUE.filter(c => c.available).map(c => c.id)])
    for (const name of names) {
      const cfg = file.servers[name] ?? (isCatalogueId(name) ? catalogueServer(name) : undefined)
      if (!cfg) continue
      const catalog = cfg.catalog ?? (isCatalogueId(name) ? name : null)
      const credentialsEnv = catalog ? connectorById(catalog)?.credentialsEnv : undefined
      const reported = this.capabilities?.servers.get(name)
      let state: ServerState = 'off'
      if (cfg.enabled) state = this.reloading || !reported ? 'starting' : reported.state
      servers.push({
        name,
        label: CATALOGUE.find(c => c.id === name)?.label ?? name,
        catalog,
        enabled: cfg.enabled === true,
        trusted: cfg.trusted === true,
        state,
        error: error ?? (state === 'failed' ? reported?.error : undefined),
        folders: cfg.folders ?? [],
        browser: catalog === 'playwright' ? (cfg.browser ?? DEFAULT_BROWSER) : undefined,
        command: [cfg.command, ...(cfg.args ?? [])].join(' '),
        tools: (this.capabilities?.tools ?? []).filter(t => t.server === name),
        readOnly: cfg.readOnly === true,
        briefing: (cfg.briefing ?? []).length > 0,
        credentialsFile: credentialsEnv ? cfg.env?.[credentialsEnv] || null : null,
      })
    }
    return {
      paused: this.paused,
      hotkey: this.hotkey,
      servers,
      apps: this.readControls().apps,
      running: this.running,
      tools: this.capabilities?.tools ?? [],
      browsers: BROWSER_IDS.filter(id => findBrowser(id)).map(id => ({ id, label: BROWSER_LABEL[id] })),
      extensionToken: Boolean(this.secrets.get('PLAYWRIGHT_MCP_EXTENSION_TOKEN')),
    }
  }

  get activeHotkey() {
    return this.hotkey
  }

  get isPaused() {
    return this.paused
  }

  private changed() {
    this.deps.onChange(this.state())
  }

  private reloadMcp() {
    this.reloading = true
    this.deps.post({ type: 'reload-mcp' })
    this.changed()
  }

  // ── runtime events ──

  onHostEvent(e: ControlHostEvent) {
    if (e.type === 'capabilities') {
      // Mid-restart reports still say "starting"; the final one settles every server.
      if (!e.servers.some(s => s.state === 'starting')) this.reloading = false
      this.capabilities = { servers: new Map(e.servers.map(s => [s.name, { state: s.state, error: s.error }])), tools: e.tools, defaultRules: e.defaultRules }
      this.changed()
    } else if (e.type === 'open-app') {
      void this.openApp(e.requestId, e.appId)
    }
  }

  onAction(n: ActionNotice) {
    if (n.status === 'running') this.running = [...this.running, { tool: n.tool, detail: n.detail, since: Date.now() }]
    else {
      const i = this.running.findIndex(r => r.tool === n.tool)
      if (i < 0) return
      this.running = this.running.filter((_, j) => j !== i)
    }
    this.changed()
  }

  /** The host exited: nothing it ran is still running, and its servers died with it. */
  runtimeDown() {
    this.running = []
    this.capabilities = null
    this.reloading = false
    this.changed()
  }

  private async openApp(requestId: string, appId: string) {
    // The host sends only an id; the path comes from the owner's own list.
    const entry = this.readControls().apps.find(a => a.id === appId)
    let error: string | undefined
    if (!entry) error = 'That application is not on the allow list.'
    else {
      const failure = await shell.openPath(entry.path)
      if (failure) error = failure
      this.deps.log('info', `Opened ${entry.name}${failure ? ` (failed: ${failure})` : ''}.`)
    }
    this.deps.post({ type: 'open-app-result', requestId, error })
  }

  // ── safety switches ──

  setPaused(paused: boolean) {
    if (paused) {
      this.deps.onStop()
      this.deps.post({ type: 'stop-all' })
    }
    this.paused = paused
    this.deps.post({ type: 'set-paused', paused })
    this.changed()
  }

  /** Emergency stop from the tray, the hotkey or the UI. */
  stopAll() {
    this.setPaused(true)
  }

  registerHotkey() {
    try {
      this.hotkey = globalShortcut.register(PAUSE_HOTKEY, () => this.setPaused(!this.paused)) ? PAUSE_HOTKEY : null
    } catch {
      this.hotkey = null
    }
    if (!this.hotkey) this.deps.log('warn', `The pause hotkey ${PAUSE_HOTKEY} is taken by another app; use the tray instead.`)
  }

  // ── servers ──

  private mutateMcp(fn: (file: McpFile) => void) {
    let file: McpFile
    try {
      file = this.readMcp()
    } catch {
      throw new Error(`${basename(this.deps.mcpConfigPath())} is not valid JSON; fix or delete it first.`)
    }
    fn(file)
    this.writeMcp(file)
  }

  private serverFor(file: McpFile, name: string): StoredServer {
    const existing = file.servers[name]
    if (existing) return existing
    if (!isCatalogueId(name)) throw new Error('No such connection.')
    file.servers[name] = catalogueServer(name)
    return file.servers[name]
  }

  setServer(name: string, enabled: boolean) {
    let readOnly = false
    this.mutateMcp(file => {
      const cfg = this.serverFor(file, name)
      if (enabled && cfg.catalog === 'filesystem' && !(cfg.folders ?? []).length) throw new Error('Choose at least one folder first.')
      const credentialsEnv = cfg.catalog ? connectorById(cfg.catalog)?.credentialsEnv : undefined
      if (enabled && credentialsEnv && !cfg.env?.[credentialsEnv]) throw new Error('Choose the OAuth client file (gcp-oauth.keys.json) first.')
      cfg.enabled = enabled
      readOnly = cfg.readOnly === true
    })
    // Turning on a read-only connector is the owner's standing yes for its reads; it shows in Permissions.
    if (readOnly) this.setConnectorReadRule(name, enabled)
    this.reloadMcp()
    return this.state()
  }

  private setConnectorReadRule(name: string, on: boolean) {
    const controls = this.readControls()
    const id = connectorReadRuleId(name)
    const others = controls.rules.filter(r => r.id !== id)
    controls.rules = on ? [...others, { id, tool: `${name}__*`, actionClass: 'observe', effect: 'allow' }] : others
    this.writeControls(controls)
    this.deps.post({ type: 'set-rules', rules: controls.rules })
  }

  /** Lets the owner point a connector at its OAuth client file; the file stays where it is. */
  async pickCredentials(name: string) {
    const file = this.safeReadMcp().file
    const catalog = file.servers[name]?.catalog ?? (isCatalogueId(name) ? name : undefined)
    const credentialsEnv = catalog ? connectorById(catalog)?.credentialsEnv : undefined
    if (!credentialsEnv) throw new Error('This connection does not use a credentials file.')
    const win = this.deps.window()
    const opts: Electron.OpenDialogOptions = { title: 'OAuth client file (gcp-oauth.keys.json)', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const path = picked.filePaths[0]
    if (picked.canceled || !path) return this.state()
    if (this.folderProblem(dirname(path)) === 'That folder holds the assistant’s own settings; pick another one.') throw new Error('Keep the credentials file outside the assistant’s own settings folder.')
    let enabled = false
    this.mutateMcp(f => {
      const cfg = this.serverFor(f, name)
      cfg.env = { ...cfg.env, [credentialsEnv]: resolve(path) }
      enabled = cfg.enabled
    })
    if (enabled) this.reloadMcp()
    else this.changed()
    return this.state()
  }

  setTrusted(name: string, trusted: boolean) {
    let enabled = false
    this.mutateMcp(file => {
      const cfg = this.serverFor(file, name)
      cfg.trusted = trusted
      enabled = cfg.enabled
    })
    if (enabled) this.reloadMcp()
    else this.changed()
    return this.state()
  }

  /** Folders that would let the Files connector rewrite rules or server config. */
  private folderProblem(folder: string): string | null {
    const trim = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
    if (trim(folder) === trim(parse(folder).root)) return 'Pick a specific folder, not a whole drive.'
    const guarded = [app.getPath('userData'), this.deps.mcpConfigPath(), this.controlsPath]
    if (guarded.some(p => within(p, folder) || within(folder, p))) return 'That folder holds the assistant’s own settings; pick another one.'
    return null
  }

  /** The token stays in the OS credential store; the runtime hands it to the Browser connector when it starts. */
  setExtensionToken(token: string) {
    if (token) this.secrets.set('PLAYWRIGHT_MCP_EXTENSION_TOKEN', token)
    else this.secrets.delete('PLAYWRIGHT_MCP_EXTENSION_TOKEN')
    this.reloadMcp()
    return this.state()
  }

  /** Switches the Browser connector between its own browser and the owner's Chrome, Edge, Comet or Brave. */
  setBrowser(setting: BrowserSetting) {
    if (setting.kind === 'mine' && !findBrowser(setting.browser)) throw new Error(`${BROWSER_LABEL[setting.browser]} is not installed on this PC.`)
    let enabled = false
    this.mutateMcp(file => {
      const cfg = this.serverFor(file, 'playwright')
      Object.assign(cfg, catalogueServer('playwright', [], setting), { enabled: cfg.enabled, trusted: cfg.trusted })
      enabled = cfg.enabled
    })
    if (enabled) this.reloadMcp()
    else this.changed()
    return this.state()
  }

  async addFolder() {
    const win = this.deps.window()
    const opts: Electron.OpenDialogOptions = { title: 'Folders the assistant may use', properties: ['openDirectory', 'multiSelections'] }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (picked.canceled || !picked.filePaths.length) return this.state()
    const folders = picked.filePaths.map(p => resolve(p))
    for (const f of folders) {
      const problem = this.folderProblem(f)
      if (problem) throw new Error(`${f}: ${problem}`)
    }
    let enabled = false
    this.mutateMcp(file => {
      const cfg = this.serverFor(file, 'filesystem')
      const next = [...new Set([...(cfg.folders ?? []), ...folders])]
      Object.assign(cfg, catalogueServer('filesystem', next), { enabled: cfg.enabled, trusted: cfg.trusted })
      enabled = cfg.enabled
    })
    if (enabled) this.reloadMcp()
    else this.changed()
    return this.state()
  }

  removeFolder(folder: string) {
    let wasEnabled = false
    this.mutateMcp(file => {
      const cfg = this.serverFor(file, 'filesystem')
      wasEnabled = cfg.enabled
      const next = (cfg.folders ?? []).filter(f => f !== folder)
      // Removing the last folder turns the connector off.
      Object.assign(cfg, catalogueServer('filesystem', next), { enabled: cfg.enabled && next.length > 0, trusted: cfg.trusted })
    })
    if (wasEnabled) this.reloadMcp()
    else this.changed()
    return this.state()
  }

  // ── apps ──

  async addApp() {
    const win = this.deps.window()
    const opts: Electron.OpenDialogOptions = {
      title: 'Application the assistant may open',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Applications', extensions: ['exe', 'lnk', 'appref-ms'] }] : [],
    }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const path = picked.filePaths[0]
    if (picked.canceled || !path) return this.state()
    const controls = this.readControls()
    if (!controls.apps.some(a => a.path.toLowerCase() === path.toLowerCase())) {
      const name = basename(path, extname(path))
      controls.apps.push({ id: randomUUID().slice(0, 8), name, path })
      this.writeControls(controls)
      this.deps.post({ type: 'set-apps', apps: controls.apps.map(({ id, name: n }) => ({ id, name: n })) })
    }
    this.changed()
    return this.state()
  }

  removeApp(id: string) {
    const controls = this.readControls()
    controls.apps = controls.apps.filter(a => a.id !== id)
    this.writeControls(controls)
    this.deps.post({ type: 'set-apps', apps: controls.apps.map(({ id: i, name }) => ({ id: i, name })) })
    this.changed()
    return this.state()
  }

  // ── rules ──

  rules(): RuleView[] {
    return [
      ...(this.capabilities?.defaultRules ?? []).map(r => ({ ...r, source: 'built-in' as const })),
      ...this.readControls().rules.map(r => ({ ...r, source: 'owner' as const })),
    ]
  }

  addRule(arg: unknown) {
    const input = parseRuleInput(arg)
    if (typeof input === 'string') throw new Error(input)
    // Folder scopes are stored resolved, so "D:\Work\..\Other" cannot widen a rule.
    const scopePrefix = input.scopePrefix && /^([a-z]:[\\/]|[\\/])/i.test(input.scopePrefix) ? resolve(input.scopePrefix) : input.scopePrefix?.toLowerCase()
    const rule: Rule = {
      id: `owner-${randomUUID().slice(0, 8)}`,
      tool: input.tool,
      actionClass: input.actionClass,
      effect: input.effect,
      ...(scopePrefix ? { scopePrefix } : {}),
      ...(input.expiresInHours ? { expiresAt: Date.now() + input.expiresInHours * 3_600_000 } : {}),
    }
    const controls = this.readControls()
    controls.rules.push(rule)
    this.writeControls(controls)
    this.deps.post({ type: 'set-rules', rules: controls.rules })
    return this.rules()
  }

  removeRule(id: string) {
    const controls = this.readControls()
    controls.rules = controls.rules.filter(r => r.id !== id)
    this.writeControls(controls)
    this.deps.post({ type: 'set-rules', rules: controls.rules })
    return this.rules()
  }

  async pickScopeFolder(): Promise<string | null> {
    const win = this.deps.window()
    const opts: Electron.OpenDialogOptions = { title: 'Folder this rule covers', properties: ['openDirectory'] }
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  }

  // ── IPC ──

  register() {
    const { handle } = this.deps
    const bool = (v: unknown) => {
      if (typeof v !== 'boolean') throw new Error('Expected true or false.')
      return v
    }
    const server = (v: unknown) => {
      if (!isServerName(v)) throw new Error('No such connection.')
      return v
    }
    handle(CC.state, () => this.state())
    handle(CC.setServer, (name, enabled) => this.setServer(server(name), bool(enabled)))
    handle(CC.setTrusted, (name, trusted) => this.setTrusted(server(name), bool(trusted)))
    handle(CC.pickCredentials, name => this.pickCredentials(server(name)))
    handle(CC.addFolder, () => this.addFolder())
    handle(CC.setExtensionToken, raw => {
      const token = parseExtensionToken(raw)
      if (token === null) throw new Error('That does not look like the token from the extension page.')
      return this.setExtensionToken(token)
    })
    handle(CC.setBrowser, raw => {
      const setting = parseBrowserSetting(raw)
      if (typeof setting === 'string') throw new Error(setting)
      return this.setBrowser(setting)
    })
    handle(CC.removeFolder, path => {
      if (typeof path !== 'string' || path.length > 1_000) throw new Error('No such folder.')
      return this.removeFolder(path)
    })
    handle(CC.addApp, () => this.addApp())
    handle(CC.removeApp, id => {
      if (!isShortId(id)) throw new Error('No such application.')
      return this.removeApp(id)
    })
    handle(CC.rules, () => this.rules())
    handle(CC.addRule, input => this.addRule(input))
    handle(CC.removeRule, id => {
      if (typeof id !== 'string' || !id.startsWith('owner-')) throw new Error('Built-in rules cannot be removed.')
      return this.removeRule(id)
    })
    handle(CC.pickScopeFolder, () => this.pickScopeFolder())
    handle(CC.activity, () => this.deps.listActions())
    handle(CC.setPaused, paused => {
      this.setPaused(bool(paused))
      return this.state()
    })
    handle(CC.stopAll, () => {
      this.stopAll()
      return this.state()
    })
  }
}
