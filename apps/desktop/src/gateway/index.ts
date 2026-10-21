/**
 * Atlas Gateway: the whole assistant as one Node process. It supervises the
 * runtime (the model, memory, tools), keeps the PC services (system status,
 * notifications, browser habits, code projects, files, desktop apps, the
 * world feeds, its own Playwright browser), serves the interface to the
 * owner's browser over HTTP and a WebSocket, and keeps a small tray icon
 * with the global shortcuts. No browser engine of its own.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { isLlmProvider } from '@assistant/providers/llm-presets'
import { osCredentialStore } from '@assistant/runtime'

import { CH, isMode, MODES, parseApproval, parseChatModelChoice, parseChatsOp, parseInitiativeAction, parseMessage, parseSetup, parseVoice, type ChatModelChoice, type InitiativeItem, type ReplyEvent, type RuntimeStatus, type SessionChange, type UiMode, type UsageView } from '../shared/ipc.ts'
import { CC } from '../shared/control.ts'
import { CHALLENGE, IC, isAskWhen } from '../shared/identity.ts'
import { NC } from '../shared/news.ts'
import { GLOBAL_SHORTCUTS, SCT, type GlobalShortcutId, type ShortcutsView } from '../shared/shortcuts.ts'
import { forAtlas, HB, parseWorkHours, ROLE_LABEL, type ProfileRole } from '../shared/habits.ts'
import { parseLiveVoice, LIVE_VOICES, type LiveVoiceName } from '../shared/livevoice.ts'
import { PWC } from '../shared/powerup.ts'
import { PCC, searchWords, type PcState, type SystemOp } from '../shared/system.ts'
import { describeEntry, isProtectedPath, searchMap } from '../shared/sysmap.ts'
import { type VoiceChange } from '../shared/ui.ts'
import { PRS, type PresenceCommand } from '../shared/presence.ts'
import { AudioGate } from '../main/bargein.ts'
import { Controls } from '../main/controls.ts'
import { DesktopService } from '../main/desktop/service.ts'
import { FileService } from '../main/files/service.ts'
import { UiService } from '../main/ui.ts'
import { WorldService } from '../main/world.ts'
import { IdentityGate } from '../main/identity.ts'
import { WindowsHello } from '../main/system/hello.ts'
import { OWNER_ONLY } from '../main/ipc-gate.ts'
import { WebAccess } from '../main/web/server.ts'
import { registerBackupIpc } from '../main/backup.ts'
import { CodeService } from '../main/code/service.ts'
import { ensureStartupDefault, registerStartupIpc, startedHidden } from '../main/startup.ts'
import { registerLearningIpc } from '../main/learning.ts'
import { registerBrainIpc } from '../main/brain.ts'
import { BrowserService } from '../main/browser.ts'
import { NotificationWatcher } from '../main/system/notifications.ts'
import { HabitsService } from '../main/system/habits.ts'
import { NewsService } from '../main/news.ts'
import { WakeService } from '../main/wake.ts'
import { registerDataIpc } from '../main/data.ts'
import { registerPersonalityIpc } from '../main/personality.ts'
import { watchSession } from '../main/session.ts'
import { providerFor, readSetup, runtimeEnv, saveQuietHours, saveSetup, saveSpeakReplies, setupSummary as readSetupSummary, saveLiveVoice } from '../main/settings.ts'
import { RuntimeSupervisor } from '../main/supervisor.ts'
import { SystemService } from '../main/system/service.ts'
import { PowerUp } from '../main/powerup.ts'
import { LiveVoice } from '../main/livevoice.ts'
import { SystemMapService } from '../main/system/sysmap.ts'
import { PcActions } from '../main/system/actions.ts'
import { app, dialog, powerMonitor, shell } from '../main/host/index.ts'
import { Tray } from '../main/host/tray.ts'
import { TimerService } from '../main/timers.ts'
import { TelegramChannel } from '../main/telegram.ts'

const isDev = !app.isPackaged
/** Development: the page comes from the Vite dev server, and the repo root's .env feeds setup (like `pnpm chat`). */
const devUrl = isDev ? (process.env.ATLAS_RENDERER_URL ?? null) : null
const devEnvFile = isDev ? join(app.getAppPath(), '../../.env') : null
const userData = app.getPath('userData')
/** Lets the atlas command (open, stop) talk to this gateway; written to gateway.json beside the data, new every start. */
const CONTROL_TOKEN = randomBytes(24).toString('hex')

let quitting = false
let keys = { llm: false, voice: false }
// Name, voice provider and voice as the runtime sees them: stored setup over the environment (.env in development).
const setupSummary = () => readSetupSummary(runtimeEnv(devEnvFile), keys)
let voiceReady = false
/** Latest cost meter totals from the runtime. */
let usage: UsageView | null = null
const speech = () => {
  const s = readSetup()
  const live = s.liveVoice
  return { available: voiceReady, enabled: s.speakReplies, live: { available: Boolean(osCredentialStore().get('OPENAI_API_KEY') ?? runtimeEnv(devEnvFile).OPENAI_API_KEY), enabled: live.enabled, tier: live.tier, voice: live.voice, capUsd: live.capUsd } }
}
let status: RuntimeStatus = { phase: 'starting', problems: [], warnings: [], mode: 'companion', setup: setupSummary(), approvals: [], speech: speech(), later: [] }
let sessionWatch: ReturnType<typeof watchSession> | null = null

const log = (level: 'info' | 'warn' | 'error', message: string) => console[level](`[atlas] ${message}`)

// ── owner check ─────────────────────────────────────────────
// While locked, the runtime still believes the owner is away: the return that
// would start a briefing is held here until the security code is confirmed.
const identity = new IdentityGate(join(userData, 'identity.json'))
/** Face, fingerprint or PIN through Windows Hello, for the owner check. */
const hello = new WindowsHello(join(userData, 'workers'), (level, message) => log(level, message))
const identityView = () => ({ ...identity.view(), helloAvailable: hello.knownAvailable })
let heldReturn: Extract<SessionChange, { idleMs: number }> | null = null
const publishIdentity = () => {
  toRenderer(IC.changed, identityView())
  // Nobody unconfirmed gets Full control.
  if (identity.locked && controls.fullControlView.on) controls.setFullControl(false)
}
const requireOwner = () => {
  if (identity.locked) throw new Error('Please confirm it is you first.')
}

// ── the page in the owner's browser ─────────────────────────

/** Every handler by channel: the page's calls arrive here over the WebSocket. */
const handlers = new Map<string, (arg: unknown, arg2: unknown, arg3?: unknown, arg4?: unknown) => unknown>()
const handle = <T>(channel: string, fn: (arg: unknown, arg2: unknown, arg3?: unknown, arg4?: unknown) => T | Promise<T>) => {
  handlers.set(channel, fn)
}

const toRenderer = (channel: string, payload: unknown) => {
  // Replies go through replyToRenderer, which knows which browser should speak them.
  if (channel !== CH.reply) web.broadcast(channel, payload)
}

// Audio of a reply the owner talked over or stopped never reaches the speakers.
const audioGate = new AudioGate()
const replyToRenderer = (e: ReplyEvent) => {
  if (audioGate.allows(e)) web.reply(e, false)
}

/** Opens Atlas in the default browser unless one already shows it; waits until the page is listening. */
const openUi = async () => {
  if (web.hasClients) return
  web.openInBrowser()
  for (let i = 0; i < 100 && !web.hasClients; i++) await new Promise(r => setTimeout(r, 150))
  if (!web.hasClients) throw new Error('The browser did not open Atlas.')
}

/** A notice from the tray; clicking it opens Atlas. */
const notify = (title: string, text: string) => tray.balloon(title, text)
const notifyItem = (item: InitiativeItem) => notify(item.kind === 'reminder' ? 'Reminder' : assistantName, item.title)

const publish = (next: Partial<RuntimeStatus>) => {
  status = { ...status, ...next }
  toRenderer(CH.statusChanged, status)
  updateTray()
}

// Connections, standing rules, activity and the pause switch. Only the owner's UI changes them.
const controls: Controls = new Controls({
  handle: (channel, fn) => handle(channel, fn),
  window: () => null,
  mcpConfigPath: () => runtimeEnv(devEnvFile).ASSISTANT_MCP_CONFIG!,
  post: msg => supervisor.control(msg),
  listActions: () => supervisor.listActions(),
  onChange: state => {
    toRenderer(CC.changed, state)
    updateTray()
  },
  onStop: () => toRenderer(CH.silence, null),
  onFullControl: () => updateTray(),
  log,
})

const supervisor: RuntimeSupervisor = new RuntimeSupervisor({
  entry: join(import.meta.dirname, 'runtime.js'),
  env: () => runtimeEnv(devEnvFile),
  cwd: userData,
  onStatus: ({ keys: k, voiceReady: v, phase, problems, warnings }) => {
    if (phase === 'ready') setTimeout(() => void personality.refresh(), 500)
    if (k) keys = k
    if (v !== undefined) voiceReady = v
    // A host that exited can no longer act on any approval.
    const gone = phase === 'restarting' || phase === 'stopped'
    if (gone) controls.runtimeDown()
    const approvals = gone ? [] : status.approvals
    const later = gone ? [] : status.later
    publish({ phase, problems, warnings, mode: supervisor.currentMode, setup: setupSummary(), approvals, speech: speech(), later })
  },
  onReply: (e: ReplyEvent) => {
    // The assistant is speaking up on its own: tell the owner if no page is open to hear it.
    if (e.type === 'initiative' && !web.hasClients) notifyItem(e.item)
    replyToRenderer(e)
    telegram.onReply(e)
  },
  onLater: (later, item) => {
    publish({ later })
    if (item) {
      notifyItem(item)
      telegram.notice(item.kind === 'reminder' ? 'Reminder' : assistantName, item.title)
    }
  },
  away: () => sessionWatch?.away ?? (identity.locked ? 'lock' : undefined),
  onApproval: request => {
    publish({ approvals: [...status.approvals, request] })
    // An approval needs the owner's eyes: say so, and open Atlas if no browser shows it.
    notify(`${assistantName} needs your approval`, `${request.tool}: ${request.reason}`)
    telegram.approval(request)
    if (!web.hasClients) void openUi().catch(() => undefined)
  },
  onApprovalClosed: id => publish({ approvals: status.approvals.filter(a => a.id !== id) }),
  onAction: notice => {
    controls.onAction(notice)
    toRenderer(CH.action, notice)
  },
  controlInit: () => [...controls.initMessages(), data.initMessage(), code.snapshotMessage()],
  onControl: e => controls.onHostEvent(e),
  onPersonality: e => personality.onHostEvent(e),
  onData: e => data.onHostEvent(e),
  onBrain: e => brain.onHostEvent(e),
  onLearning: e => learning.onHostEvent(e),
  onUsage: u => {
    usage = u
    toRenderer(CH.usageChanged, u)
  },
  onWorld: e => world.onHostEvent(e),
  onUi: e => {
    // The model's screen tools.
    void ui.handleOp(e.op).then(
      result => supervisor.files({ type: 'ui-result', requestId: e.requestId, result }),
      error => supervisor.files({ type: 'ui-result', requestId: e.requestId, error: error instanceof Error ? error.message : String(error) }),
    )
  },
  onDesktop: e => {
    // The model's desktop-app tools, answered by request id; failures go back as text the model can relay.
    void desktop.handleOp(e.op).then(
      result => supervisor.files({ type: 'desktop-result', requestId: e.requestId, result }),
      error => supervisor.files({ type: 'desktop-result', requestId: e.requestId, error: error instanceof Error ? error.message : String(error) }),
    )
  },
  onFiles: e => {
    // The model's file tools, answered by request id; failures go back as text the model can relay.
    void files.handleOp(e.op).then(
      result => supervisor.files({ type: 'files-result', requestId: e.requestId, result }),
      error => supervisor.files({ type: 'files-result', requestId: e.requestId, error: error instanceof Error ? error.message : String(error) }),
    )
  },
  onCode: e => {
    if (e.type === 'code-minutes') return code.setMinutes(e.minutes)
    // The model's code tools: answered by request id; failures go back as text the model can relay.
    void code.handleOp(e.op).then(
      result => supervisor.code({ type: 'code-result', requestId: e.requestId, result }),
      error => supervisor.code({ type: 'code-result', requestId: e.requestId, error: error instanceof Error ? error.message : String(error) }),
    )
  },
  log,
})

/** The assistant's own name (Settings › Personality); "Atlas" until the owner gives one. */
let assistantName = 'Atlas'
const setAssistantName = (n: string) => {
  const next = n.trim() || 'Atlas'
  if (next === assistantName) return
  assistantName = next
  updateTray()
}

// ── shortcuts and the tray ──────────────────────────────────

/** Tell the page's conversation to stop, talk or send a quick reply (false while no page is open). */
const pageCommand = (c: PresenceCommand): boolean => {
  if (!web.hasClients) return false
  toRenderer(PRS.command, c)
  return true
}

/** Waits (opening Atlas in the browser if needed) until the page can take a command. */
const whenPageReady = async (run: () => boolean) => {
  if (run()) return
  await openUi().catch(() => undefined)
  for (let i = 0; i < 40; i++) {
    if (run()) return
    await new Promise(r => setTimeout(r, 200))
  }
}

/** Quiet mode from the shortcut remembers the mode it came from. */
let beforeQuiet: UiMode | null = null
const toggleQuiet = () => {
  const now = supervisor.currentMode
  const next: UiMode = now === 'quiet' ? (beforeQuiet ?? 'companion') : 'quiet'
  if (now !== 'quiet') beforeQuiet = now
  supervisor.setMode(next)
  publish({ mode: next })
}

/** What each global shortcut does. */
const shortcutActions: Record<GlobalShortcutId, () => void> = {
  front: () => void (web.hasClients ? notify(assistantName, 'Atlas is open in your browser.') : openUi().catch(() => undefined)),
  talk: () => void whenPageReady(() => pageCommand('talk')),
  stop: () => void pageCommand('stop'),
  quiet: toggleQuiet,
  palette: () => void whenPageReady(() => (web.hasClients ? (ui.send({ palette: true }), true) : false)),
  board: () => void whenPageReady(() => (web.hasClients ? (ui.send({ shortcuts: true }), true) : false)),
  // Registered by Controls (it owns pausing).
  pause: () => undefined,
}

const tray = new Tray({
  icon: join(app.getAppPath(), 'resources', 'tray.png'),
  onClick: id => trayClick(id),
  onBalloonClick: () => void openUi().catch(() => undefined),
  onSession: line => powerMonitor.feed(line),
  log: (level, message) => log(level, message),
})

const registerShortcuts = () => {
  for (const s of GLOBAL_SHORTCUTS) {
    if (s.id === 'pause') continue
    if (!tray.register(s.accelerator, shortcutActions[s.id], s.id)) log('warn', `The shortcut ${s.accelerator} could not be registered.`)
  }
}

const shortcutsView = (): ShortcutsView => ({ global: GLOBAL_SHORTCUTS.map(s => ({ ...s, ok: tray.isRegistered(s.id === 'pause' ? s.accelerator : s.id) })) })

const PHASE_LABEL: Record<RuntimeStatus['phase'], string> = {
  starting: 'Starting…',
  setup: 'Setup needed',
  checking: 'Checking providers…',
  ready: 'Ready',
  restarting: 'Restarting runtime…',
  stopped: 'Stopped',
}

const trayClick = (id: string) => {
  if (id === 'open') return void (web.hasClients ? web.openInBrowser() : openUi().catch(() => undefined))
  if (id.startsWith('mode:')) {
    const m = id.slice(5)
    if (isMode(m)) {
      supervisor.setMode(m)
      publish({ mode: m })
    }
    return
  }
  if (id === 'full-off') return controls.setFullControl(false)
  if (id === 'resume') return controls.setPaused(false)
  if (id === 'stop-all') return controls.stopAll()
  if (id === 'board') return shortcutActions.board()
  if (id === 'quit') return void quit()
}

const updateTray = () => {
  tray.setMenu(`${assistantName}: ${PHASE_LABEL[status.phase]}${controls.fullControlView.on ? ' · Full control' : ''}`, [
    { id: 'open', label: `Open ${assistantName}` },
    { label: PHASE_LABEL[status.phase], enabled: false },
    { separator: true },
    ...MODES.map(m => ({ id: `mode:${m}`, label: `${m[0]!.toUpperCase()}${m.slice(1)} mode`, checked: status.mode === m })),
    { separator: true },
    controls.fullControlView.on ? { id: 'full-off', label: 'Full control is on: turn it off' } : { label: `Normal mode (${assistantName} asks first)`, enabled: false },
    controls.isPaused ? { id: 'resume', label: 'Resume automation' } : { id: 'stop-all', label: 'Stop all automation (Ctrl+Alt+P)' },
    { separator: true },
    { id: 'board', label: 'Keyboard shortcuts' },
    { id: 'quit', label: `Quit ${assistantName}` },
  ])
}

// ── the PC ──────────────────────────────────────────────────

/** The PC itself: Wi-Fi, Bluetooth, battery, VPN, read often while Atlas is on screen, rarely otherwise. */
const pcSystem = new SystemService({
  dir: join(userData, 'system'),
  log: (level, message) => log(level, message),
  onSnapshot: (s, changes) => {
    supervisor.system(s, changes)
    publishPc()
  },
})
/** Where things are on the PC (apps, projects, folders), once the owner turns it on. */
const sysmap = new SystemMapService({
  file: join(userData, 'sysmap.json'),
  apps: () => pcSystem.apps(),
  codeProjects: () => code.state().projects.map(p => ({ name: p.name, path: p.path })),
  log: (level, message) => log(level, message),
  onChange: () => publishPc(),
})
/** Windows notifications, once the owner turns them on: read here, passed to Atlas. */
const pcNotifications = new NotificationWatcher({
  file: join(userData, 'notifications.json'),
  cacheDir: join(userData, 'notifications-cache'),
  onNew: (items, fresh) => supervisor.notifications(items, fresh),
  onChange: () => publishPc(),
  log: (level, message) => log(level, message),
})
const pcState = (): PcState => ({ status: pcSystem.current, changes: pcSystem.changes, map: sysmap.view(), notifications: pcNotifications.view() })
const publishPc = () => toRenderer(PCC.changed, pcState())
const pcActions = new PcActions({ map: () => sysmap.map, foreground: () => pcSystem.foreground() })

/** Atlas's PC requests: status, Settings pages, finding, opening and making things. */
const pcOp = async (op: SystemOp): Promise<string> => {
  switch (op.kind) {
    case 'open':
      return pcActions.open(op.target, op.with, op.prompt)
    case 'launch':
      return pcActions.launch(op.target)
    case 'foreground':
      return pcActions.foreground()
    case 'folder':
      return pcActions.folder(op.where, op.name)
    case 'document':
      return pcActions.document(op.where, op.name, op.markdown, op.open)
    case 'sheet':
      return pcActions.sheet(op.where, op.name, op.sheets, op.open)
    case 'search': {
      const words = searchWords(op.query)
      if (!words.length) throw new Error('Say what to look for (a name or words inside).')
      const since = op.days ? new Date(Date.now() - op.days * 86_400_000).toISOString().slice(0, 10) : null
      let rows: Awaited<ReturnType<typeof pcSystem.search>>
      try {
        rows = await pcSystem.search(words, op.fileKind, since)
      } catch (e) {
        throw new Error(`Windows search did not answer (${e instanceof Error ? e.message : String(e)}). Is the Windows Search service on?`)
      }
      const excluded = sysmap.view().excluded.map(x => x.toLowerCase())
      const found = rows
        .filter(r => r.path && !isProtectedPath(r.path, homedir()) && !excluded.some(x => r.path.toLowerCase().startsWith(x)) && !/\\(node_modules|\.git|\$recycle\.bin)\\/i.test(r.path))
        // Names that say it come before files that only mention it inside; newest first within each.
        .map(r => ({ r, named: words.filter(w => r.name.toLowerCase().includes(w)).length }))
        .sort((a, b) => b.named - a.named || (b.r.modified > a.r.modified ? 1 : b.r.modified < a.r.modified ? -1 : 0))
        .map(x => x.r)
        .slice(0, 20)
      if (!found.length) return `Nothing on this PC matches "${op.query}"${op.fileKind ? ` (${op.fileKind})` : ''}${op.days ? ` from the last ${op.days} days` : ''}.`
      return ['Found on this PC:', ...found.map((r, i) => `${i + 1}. ${r.name} — ${dirname(r.path)}${r.modified ? ` — ${r.modified.slice(0, 10)}` : ''}${r.kind ? ` — ${r.kind}` : ''}`), 'Open one with open_item and its full path.'].join('\n')
    }
    case 'full-control':
      // The runtime asked the owner first (turning on is never automatic); the owner check still applies here.
      if (op.on && identity.locked) throw new Error('The owner check is on: confirm it is you first.')
      controls.setFullControl(op.on, op.mode)
      return op.on ? `Full control is on (${op.mode === 'hour' ? 'for an hour' : op.mode === 'manual' ? 'until you turn it off' : 'until you lock the PC or leave'}).` : 'Full control is off; I will ask before acting again.'
    case 'status':
    case 'settings':
      return pcSystem.handle(op)
  }
  if (!sysmap.enabled) return 'The system map is off. The owner can turn it on in Controls › This PC; until then only the folders, apps and projects they picked are known.'
  if (sysmap.view().building && !sysmap.map.builtAt) return 'The system map is still being built; try again in a minute.'
  const found = searchMap(sysmap.map.entries, op.query, op.mapKind)
  return found.length ? ['Found on this PC:', ...found.map(describeEntry)].join('\n') : `Nothing on this PC matches "${op.query}".`
}

// ── services ────────────────────────────────────────────────

handle(CH.status, () => status)
const news = new NewsService({
  onChange: r => {
    toRenderer(NC.changed, r)
    // The assistant can tell the owner the news; feed text is untrusted.
    supervisor.news(r.headlines.slice(0, 40).map(h => ({ title: h.title, source: h.source, category: h.category, publishedAt: h.publishedAt, summary: h.summary, link: h.link })))
  },
})
news.register(handle, () => requireOwner())
const wake = new WakeService({ handle, toRenderer })
wake.register()

const web: WebAccess = new WebAccess({
  handlers,
  schemes: { 'assistant-news': url => news.serve(url), 'assistant-model': url => wake.serve(url) },
  gate: channel => {
    if (OWNER_ONLY.has(channel)) requireOwner()
  },
  requireOwner: () => requireOwner(),
  file: join(userData, 'web-access.json'),
  rendererDir: join(import.meta.dirname, '..', 'renderer'),
  devUrl,
  handle: (channel, fn) => handle(channel, fn),
  openExternal: url => void shell.openExternal(url),
  control: { token: CONTROL_TOKEN, act: action => (action === 'quit' ? void quit() : web.openInBrowser()) },
  onClients: () => {
    // PC readings stay frequent while a page shows Atlas.
    pcSystem.setActive(web.hasClients)
    ui.clientsChanged()
  },
  log: (level, message) => log(level, message),
})
web.register()

controls.register()
/** Code projects: approved folders, activity scans, dev servers, status files. */
const code = new CodeService({
  handle,
  toRenderer,
  toRuntime: s => supervisor.code({ type: 'code-snapshot', ...s }),
  window: () => null,
  requireOwner: () => requireOwner(),
  log: (level, message) => log(level, message),
})
code.register()
/** Files: chosen folders, organising with undo, Recycle Bin instead of delete. */
const files = new FileService({ handle, toRenderer, window: () => null, requireOwner: () => requireOwner(), log: (level, message) => log(level, message) })
files.register()
/** Desktop apps: the owner's chosen apps, UI Automation through a PowerShell worker, WhatsApp, "watch me". */
const desktop = new DesktopService({ handle, toRenderer, requireOwner: () => requireOwner(), log: (level, message) => log(level, message) })
desktop.register()
/** Atlas's own browser: Chrome or Edge through Playwright, shown in the page as a live picture. */
const atlasBrowser: BrowserService = new BrowserService({
  command: c => ui.send(c),
  mode: () => ui.browserMode(),
  log: (level, message) => log(level, message),
  handle: (channel, fn) => handle(channel, fn),
  toRenderer,
  file: join(userData, 'browser-tabs.json'),
  profileDir: join(userData, 'browser-profile'),
})
atlasBrowser.register()
/** The page in the owner's browser: what it shows, and Atlas's changes to it. */
const ui: UiService = new UiService({
  clients: () => web.clientCount,
  open: () => openUi(),
  toRenderer,
  handle,
  listen: (channel, fn) => web.onMessage(channel, fn),
  requireOwner: () => requireOwner(),
  onChange: state => supervisor.ui(state),
  system: op => pcOp(op),
  browser: (op): Promise<string> => atlasBrowser.handle(op),
  worldData: (op): Promise<string> => world.worldData(op),
  voice: (change): Promise<string> => voiceChange(change),
  timers: op => timers.handle(op),
})
ui.register()
/** Timers and alarms: they ring here (tray sound and notice) and in the page, whatever the mode. */
const timers = new TimerService({
  file: join(userData, 'timers.json'),
  now: () => Date.now(),
  handle,
  toRenderer,
  ring: (label, detail) => {
    tray.alarm()
    tray.balloon(`⏰ ${label}`, detail)
    telegram.notice(`⏰ ${label}`, detail)
  },
  quiet: () => tray.quiet(),
  notice: (title, text) => tray.balloon(title, text),
  log: (level, message) => log(level, message),
})
timers.register()

/** The owner's own Telegram bot: messages and voice notes in, replies, approvals and notices out. */
const telegram: TelegramChannel = new TelegramChannel({
  file: join(userData, 'telegram.json'),
  secrets: osCredentialStore(),
  handle,
  toRenderer,
  requireOwner: () => requireOwner(),
  send: text => {
    const t = parseMessage(text)
    if (t === null) throw new Error('That message is too long.')
    if (status.phase !== 'ready') throw new Error(`${assistantName} is not ready yet; try again in a minute.`)
    return supervisor.send(t)
  },
  sendVoice: (audio, mime) => {
    const v = parseVoice(audio, mime)
    if (!v) throw new Error('That voice note is too long.')
    if (status.phase !== 'ready') throw new Error(`${assistantName} is not ready yet; try again in a minute.`)
    if (!status.speech.available) throw new Error('No voice provider is set up on the PC; write instead.')
    return supervisor.sendVoice(v.audio, v.mime)
  },
  stop: () => {
    audioGate.interrupt(supervisor.currentReply)
    supervisor.stopReply()
  },
  answerApproval: (id, approved) => {
    if (status.approvals.some(a => a.id === id)) supervisor.answerApproval(id, approved)
  },
  pageOpen: () => web.hasClients,
  log: (level, message) => log(level, message),
})
telegram.register()
/** The live world at the owner's places, for the World page. */
const world = new WorldService({ handle, toRenderer, toRuntime: msg => supervisor.world(msg), requireOwner: () => requireOwner(), log: (level, message) => log(level, message), cacheDir: join(userData, 'world-cache') })
world.register()

handle(CH.send, arg => {
  const text = parseMessage(arg)
  if (text === null) throw new Error('Message must be non-empty text under 8000 characters.')
  if (status.phase !== 'ready') throw new Error('The assistant is not ready yet.')
  requireOwner()
  return { replyId: supervisor.send(text) }
})
handle(CH.sendVoice, (audio, mime) => {
  const voice = parseVoice(audio, mime)
  if (!voice) throw new Error('Recording must be audio under 5 MB.')
  if (status.phase !== 'ready') throw new Error('The assistant is not ready yet.')
  if (!status.speech.available) throw new Error('No voice provider is configured; type instead.')
  requireOwner()
  return { replyId: supervisor.sendVoice(voice.audio, voice.mime) }
})
handle(CH.setSpeech, enabled => {
  if (typeof enabled !== 'boolean') throw new Error('Expected true or false.')
  saveSpeakReplies(enabled)
  supervisor.setSpeech(enabled)
  publish({ speech: speech() })
})
handle(CH.stop, () => {
  audioGate.interrupt(supervisor.currentReply)
  supervisor.stopReply()
})
handle(CH.interrupt, () => {
  // Playback stops first, in the page; the host cancels the token in parallel.
  if (!audioGate.interrupt(supervisor.currentReply)) return
  toRenderer(CH.silence, null)
  supervisor.interrupt()
})
handle(SCT.list, () => shortcutsView())
handle(CH.setMode, arg => {
  if (!isMode(arg)) throw new Error('Unknown mode.')
  supervisor.setMode(arg)
  publish({ mode: arg })
})
handle(CH.listTasks, () => {
  requireOwner()
  return supervisor.listTasks()
})
handle(CH.chats, op => {
  const parsed = parseChatsOp(op)
  if (!parsed) throw new Error('Unknown chat request.')
  return supervisor.chats(parsed)
})
handle(CH.listToday, () => {
  requireOwner()
  return supervisor.listToday()
})
handle(CH.answerApproval, (id, approved) => {
  const answer = parseApproval(id, approved)
  // Only requests the host actually raised can be answered.
  if (!answer || !status.approvals.some(a => a.id === answer.id)) throw new Error('No such approval request.')
  supervisor.answerApproval(answer.id, answer.approved)
})
handle(CH.initiativeAction, (id, action) => {
  const parsed = parseInitiativeAction(id, action)
  if (!parsed) throw new Error('Unknown initiative action.')
  supervisor.initiativeAction(parsed.id, parsed.action)
})
handle(PCC.state, () => pcState())
// There is no desktop widget any more: the tray's notices take its place.
handle(PRS.getWhen, () => 'never')
handle(PRS.setWhen, () => 'never')
// The page used to wait for this before replies; the browser gets them as they come.
handle(CH.ready, () => undefined)

// Power up: every key Atlas can use, saved, removed and tested here; values never reach the page.
const powerUp = new PowerUp({
  secrets: osCredentialStore(),
  env: () => runtimeEnv(devEnvFile),
  inUse: () => ({ llm: setupSummary().llmProvider, voice: setupSummary().voiceProvider }),
  listModels: (provider, key) => supervisor.listModels(provider, key, ''),
  azureRegion: () => readSetup().azureRegion,
  restart: async () => {
    await supervisor.restart()
    status = { ...status, phase: 'starting', problems: [], setup: setupSummary() }
  },
  changedWorldKey: (id, key) => {
    try {
      if (id === 'aisstream') world.ships.setKey(key)
      else void world.webcams.setKey(key)
    } catch {
      // The key is saved; the layer picks it up on its next look.
    }
  },
})
handle(PWC.state, () => powerUp.rows())

// Live voice (OpenAI Realtime): the gateway mints each session; the key stays here.
let liveName = 'Atlas'
const liveVoice = new LiveVoice({
  key: () => osCredentialStore().get('OPENAI_API_KEY') ?? runtimeEnv(devEnvFile).OPENAI_API_KEY,
  settings: () => readSetup().liveVoice,
  names: () => ({ assistant: liveName, owner: setupSummary().ownerName }),
})
handle(CH.liveSession, name => {
  // The assistant's own name, as the owner set it in Personality (cleaned again when the session is built).
  liveName = typeof name === 'string' && name.trim() ? name.slice(0, 40) : 'Atlas'
  return liveVoice.mint()
})
/**
 * Atlas changes its own voice (voice_settings). The Live voice changes at
 * once; the spoken (ChatGPT) voice is saved and the runtime restarts as soon
 * as the reply in progress has finished, so nothing is cut off.
 */
const voiceChange = async (change: VoiceChange): Promise<string> => {
  const s = readSetup()
  const done: string[] = []
  if (change.voice !== undefined) {
    const v = change.voice.trim().toLowerCase()
    if (!/^[a-z]{2,20}$/.test(v)) throw new Error('Give an OpenAI voice name, e.g. marin, cedar, coral, sage, shimmer, nova, alloy, ash, ballad, echo, fable, onyx, verse.')
    if ((LIVE_VOICES as readonly string[]).includes(v)) {
      saveLiveVoice({ ...s.liveVoice, voice: v as LiveVoiceName })
      done.push(`Live voice is now ${v}`)
    }
    if (s.voiceProvider === 'openai' && s.openaiVoice !== v) {
      saveSetup({ ownerName: s.ownerName, voiceProvider: 'openai', voiceId: v, llmKey: '', voiceKey: '' }, 'openai')
      done.push(`my spoken voice becomes ${v} in a few seconds, once this reply is done`)
      const restartWhenIdle = (tries = 0) =>
        setTimeout(() => {
          if (supervisor.currentReply && tries < 60) return restartWhenIdle(tries + 1)
          void supervisor.restart().then(() => publish({ setup: setupSummary() }))
        }, 2_000)
      restartWhenIdle()
    } else if (s.voiceProvider !== 'openai' && !(LIVE_VOICES as readonly string[]).includes(v)) throw new Error(`${v} is not a Live voice, and the spoken voice is ${s.voiceProvider || 'ElevenLabs'} (change it in Setup).`)
  }
  if (change.live !== undefined) {
    saveLiveVoice({ ...readSetup().liveVoice, enabled: change.live })
    done.push(`Live voice ${change.live ? 'on' : 'off'}`)
  }
  if (change.speakReplies !== undefined) {
    saveSpeakReplies(change.speakReplies)
    supervisor.setSpeech(change.speakReplies)
    done.push(`spoken replies ${change.speakReplies ? 'on' : 'off'}`)
  }
  publish({ speech: speech() })
  const now = readSetup()
  const state = `Voice: spoken by ${now.voiceProvider === 'openai' ? `ChatGPT (${now.openaiVoice || 'marin'})` : now.voiceProvider || 'ElevenLabs'}, replies ${now.speakReplies ? 'spoken' : 'not spoken'}; Live voice ${now.liveVoice.enabled ? 'on' : 'off'} (${now.liveVoice.voice}).`
  return done.length ? `Done: ${done.join('; ')}. ${state}` : state
}

handle(CH.setLiveVoice, raw => {
  saveLiveVoice(parseLiveVoice(raw))
  publish({ speech: speech() })
})
handle(PWC.save, (id, key) => powerUp.save(id, key))
handle(PWC.remove, id => powerUp.remove(id))
handle(PWC.test, id => powerUp.test(id))
handle(PWC.preview, (provider, voice) => powerUp.previewVoice(provider, voice, status.setup.ownerName))
handle(PCC.setMap, on => {
  if (typeof on !== 'boolean') throw new Error('On or off.')
  sysmap.setEnabled(on)
  return pcState()
})
handle(PCC.setNotifications, on => {
  if (typeof on !== 'boolean') throw new Error('On or off.')
  pcNotifications.setEnabled(on)
  return pcState()
})
/** The Profiles tab: browser profiles and habits, read on this PC once the owner turns it on. */
const habitsService = new HabitsService({
  file: join(userData, 'habits.json'),
  cacheDir: join(userData, 'habits-cache'),
  onChange: v => {
    toRenderer(HB.changed, v)
    supervisor.habits(forAtlas(v))
  },
  log: (level, message) => log(level, message),
})
handle(HB.state, () => habitsService.state())
handle(HB.setEnabled, on => {
  if (typeof on !== 'boolean') throw new Error('On or off.')
  return habitsService.setEnabled(on)
})
handle(HB.setProfile, (key, change) => {
  if (typeof key !== 'string' || key.length > 200) throw new Error('Which profile?')
  const c = (change ?? {}) as { role?: unknown; shared?: unknown }
  const role = c.role === null ? null : typeof c.role === 'string' && c.role in ROLE_LABEL ? (c.role as ProfileRole) : undefined
  return habitsService.setProfile(key, { role, shared: typeof c.shared === 'boolean' ? c.shared : undefined })
})
handle(HB.setWorkHours, w => {
  const hours = parseWorkHours(w)
  if (!hours) throw new Error('Working hours need a start, an end and at least one day.')
  return habitsService.setWorkHours(hours)
})
handle(HB.refresh, () => habitsService.refresh())
handle(PCC.rebuild, () => {
  if (sysmap.enabled) void sysmap.build()
  void pcSystem.refresh()
  return pcState()
})
handle(PCC.addExcluded, async () => {
  const picked = await dialog.showOpenDialog({ title: 'A folder Atlas must never look into', properties: ['openDirectory'] })
  if (!picked.canceled && picked.filePaths[0]) sysmap.setExcluded([...sysmap.view().excluded, picked.filePaths[0]])
  return pcState()
})
handle(PCC.removeExcluded, path => {
  if (typeof path !== 'string') throw new Error('Which folder?')
  sysmap.setExcluded(sysmap.view().excluded.filter(p => p !== path))
  return pcState()
})
registerStartupIpc(handle)
/** Restarts the runtime once the reply in progress is over (settings it reads at start). */
const restartWhenIdle = (tries = 0) =>
  setTimeout(() => {
    if (supervisor.currentReply && tries < 60) return restartWhenIdle(tries + 1)
    void supervisor.restart().then(() => publish({ setup: setupSummary() }))
  }, 2_000)
const QUIET = /^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$/
handle(CH.quietHours, () => {
  const v = runtimeEnv(devEnvFile).ASSISTANT_QUIET_HOURS?.replace(/\s/g, '')
  return v && QUIET.test(v) ? v : null
})
handle(CH.setQuietHours, range => {
  requireOwner()
  const v = typeof range === 'string' ? range.replace(/\s/g, '') : null
  if (v !== null && !QUIET.test(v)) throw new Error('Give a range like 22:00-07:00.')
  if (v && v.split('-')[0] === v.split('-')[1]) throw new Error('Start and end must differ.')
  saveQuietHours(v ?? 'off')
  restartWhenIdle()
  return v
})
handle(CH.usage, () => {
  requireOwner()
  return usage
})
handle(CH.setBudget, usd => {
  requireOwner()
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > 100_000) throw new Error('Enter a monthly budget in dollars (0 for no limit).')
  supervisor.usageSetting({ type: 'set-budget', usd })
})
handle(CH.setPrice, (model, price) => {
  requireOwner()
  if (typeof model !== 'string' || !/^[\w./:@-]{1,120}$/.test(model)) throw new Error('Unknown model.')
  const p = price as { input?: unknown; output?: unknown; cacheRead?: unknown } | null
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 10_000
  if (p !== null && (!ok(p.input) || !ok(p.output) || (p.cacheRead !== undefined && !ok(p.cacheRead)))) throw new Error('Prices are dollars per million tokens.')
  supervisor.usageSetting({ type: 'set-price', model, price: p === null ? null : { input: p.input as number, output: p.output as number, cacheRead: p.cacheRead as number | undefined } })
})
// The chat's model chip: remembered on this PC, re-sent after restarts.
const chatModelFile = join(userData, 'chat-model.json')
const readChatModel = (): ChatModelChoice => {
  try {
    return parseChatModelChoice(JSON.parse(readFileSync(chatModelFile, 'utf8'))) ?? { kind: 'auto' }
  } catch {
    return { kind: 'auto' }
  }
}
const chatModelView = () => {
  const s = setupSummary()
  return { choice: readChatModel(), provider: s.llmProvider, main: s.llmModel, quick: s.llmQuickModel }
}
supervisor.setChatModel(readChatModel())
handle(CH.chatModel, () => chatModelView())
handle(CH.setChatModel, raw => {
  const choice = parseChatModelChoice(raw)
  if (!choice) throw new Error('Unknown model choice.')
  writeFileSync(chatModelFile, JSON.stringify(choice))
  supervisor.setChatModel(choice)
  return chatModelView()
})
handle(CH.listModels, (provider, apiKey, baseUrl) => {
  if (!isLlmProvider(provider)) throw new Error('Unknown provider.')
  const key = typeof apiKey === 'string' ? apiKey.trim().slice(0, 500) : ''
  const url = typeof baseUrl === 'string' ? baseUrl.trim().slice(0, 300) : ''
  if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw new Error('The server address must start with http:// or https://.')
  return supervisor.listModels(provider, key, url)
})
handle(CH.saveSetup, async arg => {
  const input = parseSetup(arg)
  if (!input) throw new Error('Invalid setup values.')
  const provider = providerFor(input, runtimeEnv(devEnvFile))
  const llmProvider = input.llmProvider ?? setupSummary().llmProvider
  const error = await supervisor.storeSecrets(input.llmKey, llmProvider, input.voiceKey, provider)
  if (error) throw new Error(error)
  saveSetup(input, provider)
  await supervisor.restart()
  status = { ...status, phase: 'starting', problems: [], setup: setupSummary() }
  return status
})

// Activity (opt-in window tracking) and Projects.
const data = registerDataIpc({ handle, post: msg => supervisor.data(msg), isReady: () => status.phase === 'ready', toRenderer })
const brain = registerBrainIpc({ handle, post: msg => supervisor.data(msg), isReady: () => status.phase === 'ready', toRenderer })
const learning = registerLearningIpc({ handle, post: msg => supervisor.data(msg), isReady: () => status.phase === 'ready', toRenderer, requireOwner: () => requireOwner() })

registerBackupIpc({
  handle,
  requireOwner: () => requireOwner(),
  dataDir: () => runtimeEnv(devEnvFile).ASSISTANT_DATA_DIR!,
  snapshotDb: path => supervisor.backupDb(path),
  stopRuntime: () => supervisor.stop(),
  log: (level, message) => log(level, message),
})

const personality = registerPersonalityIpc({
  onView: v => setAssistantName(v.profile.assistantName),
  handle,
  post: msg => supervisor.personality(msg),
  isReady: () => status.phase === 'ready',
  speechAvailable: () => status.speech.available,
  toRenderer,
  window: () => null,
})

// ── owner check: the code never leaves the gateway, results carry no secret ──

/** Confirmed: let the held return through, which starts the briefing. */
const releaseOwner = () => {
  const change = heldReturn
  heldReturn = null
  publishIdentity()
  if (change) supervisor.session(change)
}
const afterVerify = (r: ReturnType<IdentityGate['verify']>) => {
  if (r.ok) releaseOwner()
  else publishIdentity()
  return r
}
handle(IC.get, () => identityView())
handle(IC.hello, async () => {
  if (!identity.hello) throw new Error('Windows Hello is off for the owner check.')
  if (!identity.locked) return { ok: true, result: 'Verified' }
  const result = await hello.verify(0n, `${status.setup.ownerName ? `${status.setup.ownerName}, c` : 'C'}onfirm it is you to open ${assistantName}`)
  if (result === 'Verified' && identity.locked) {
    identity.passHello()
    releaseOwner()
  }
  return { ok: result === 'Verified', result }
})
handle(IC.setHello, async on => {
  if (typeof on !== 'boolean') throw new Error('On or off.')
  if (identity.locked) throw new Error('Please confirm it is you first.')
  if (on && !identity.configured) throw new Error('Set a typed code first: it stays the fallback when Windows Hello is not at hand.')
  if (on && !(await hello.isAvailable(true))) throw new Error('Windows Hello is not set up on this PC (Settings › Accounts › Sign-in options).')
  identity.setHello(on)
  publishIdentity()
  return identityView()
})
handle(IC.verify, code => {
  if (typeof code !== 'string' || code.length > 500) throw new Error('Type the code.')
  return afterVerify(identity.verify(code))
})
handle(IC.verifyVoice, async (audio, mime) => {
  const heard = await personality.transcribe(audio, mime)
  if (!heard.trim()) return { ok: false as const, attemptsLeft: identity.view().attemptsLeft, lockoutUntil: identity.view().lockoutUntil, reason: 'not-heard' as const }
  return afterVerify(identity.verify(heard))
})
handle(IC.setCode, (code, current) => {
  const v = identity.setCode(code, current)
  publishIdentity()
  return v
})
handle(IC.removeCode, current => {
  const v = identity.removeCode(current)
  if (!identity.locked && heldReturn) releaseOwner()
  publishIdentity()
  return v
})
handle(IC.setAskWhen, when => {
  if (!isAskWhen(when)) throw new Error('Choose daily, away or off.')
  // Turning the check off while it is waiting would be a bypass: confirm first.
  if (identity.locked) throw new Error('Please confirm it is you first.')
  const v = identity.setAskWhen(when)
  publishIdentity()
  return v
})
handle(IC.speakChallenge, language => {
  if (language !== 'en' && language !== 'ur-Latn' && language !== 'ur-Arab') throw new Error('Unknown language.')
  return personality.speakFixed(CHALLENGE[language](setupSummary().ownerName))
})

// ── lifecycle ───────────────────────────────────────────────

/** Where the running gateway leaves its process id and address, for the atlas command (stop, status, open). */
const STATE_FILE = join(userData, 'gateway.json')

/** Another Atlas already answers on this PC: show it instead of starting a second one. */
const alreadyRunning = async (): Promise<boolean> => {
  try {
    const r = await fetch('http://127.0.0.1:47800/api/me', { signal: AbortSignal.timeout(1_500) })
    return r.ok && typeof ((await r.json()) as { paired?: unknown }).paired === 'boolean'
  } catch {
    return false
  }
}

const quit = async () => {
  if (quitting) return
  quitting = true
  app.quitting()
  sessionWatch?.stop()
  powerMonitor.stop()
  desktop.stop()
  world.ships.stop()
  pcSystem.stop()
  sysmap.stop()
  timers.stop()
  telegram.stop()
  tray.stop()
  await atlasBrowser.close()
  await web.stop()
  rmSync(STATE_FILE, { force: true })
  await supervisor.stop().catch(() => undefined)
  process.exit(0)
}

const start = async () => {
  if (await alreadyRunning()) {
    console.log('Atlas is already running: opening it in your browser.')
    // The running one opens its page with a pairing ticket; a plain address is the fallback.
    try {
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { url: string; control: string }
      await fetch(`${s.url.replace('localhost', '127.0.0.1')}/api/control?action=open`, { method: 'POST', headers: { 'x-atlas-control': s.control }, signal: AbortSignal.timeout(3_000) })
    } catch {
      await shell.openExternal('http://localhost:47800')
    }
    process.exit(0)
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void quit())
  // Started by a parent (the dev runner, the installer's service): it asks over IPC, as Windows has no gentle signals.
  process.on('message', m => {
    if ((m as { type?: unknown } | null)?.type === 'quit') void quit()
  })
  process.on('unhandledRejection', e => log('error', `Unhandled: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`))

  await web.start()
  if (!web.url) {
    log('error', 'Atlas could not serve its page (the ports are all taken).')
    process.exit(1)
  }
  writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, url: web.url, control: CONTROL_TOKEN, version: app.getVersion(), started: new Date().toISOString() }))
  // A link that pairs whichever browser opens it in the next 10 minutes (for a browser Atlas did not open itself).
  console.log(`\n  ${assistantName} is running: ${web.url}\n  Pair a browser on this PC: ${web.pairingUrl(10 * 60_000)}\n`)
  code.start()
  supervisor.setSpeech(readSetup().speakReplies)
  tray.start()
  updateTray()
  controls.registerHotkey((accelerator, fn) => tray.register(accelerator, fn))
  // Ctrl+Alt+A opens Atlas, Ctrl+Alt+Space talks, and the rest of the board (shared/shortcuts.ts).
  registerShortcuts()
  // The installed Atlas starts with Windows (page open) unless the owner has chosen otherwise.
  ensureStartupDefault()
  void hello.isAvailable().then(() => publishIdentity())
  sessionWatch = watchSession(change => {
    // Leaving (lock, sleep, away): a session's Full control ends here.
    if (change.signal === 'lock' || change.signal === 'suspend' || change.signal === 'idle') controls.endFullControlSession()
    if (change.signal === 'lock' || change.signal === 'suspend') {
      // Privacy first: playback and the mic stop here, before the runtime even hears about it.
      toRenderer(CH.silence, null)
      // "After every sleep or lock": close the check now, so nothing private shows when the lid opens.
      if (identity.locksOnLeave && !identity.locked) {
        identity.lock()
        publishIdentity()
      }
    }
    // Coming back: ask for the code first when the owner's policy says so; hold the return until then.
    if ('idleMs' in change && (identity.locked || identity.shouldAsk(change.idleMs, change.signal === 'active' ? 'idle' : 'wake'))) {
      identity.lock()
      heldReturn = change
      publishIdentity()
      return
    }
    supervisor.session(change)
  })
  // A fresh start of the day asks too; the runtime starts as if the owner were away.
  if (identity.shouldAsk(Number.POSITIVE_INFINITY)) {
    identity.lock()
    heldReturn = { signal: 'unlock', idleMs: 0 }
  }
  supervisor.start()
  pcSystem.start()
  pcSystem.setActive(false)
  timers.start()
  void telegram.start()
  sysmap.start()
  // Started by Windows at login set to start quietly: stay in the tray. Otherwise the page opens.
  if (!startedHidden() && !process.argv.includes('--no-open')) setTimeout(() => void openUi().catch(() => undefined), 800)
}

void start()
