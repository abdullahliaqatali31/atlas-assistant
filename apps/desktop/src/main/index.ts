/**
 * Electron main process: owns the tray, the companion window and the
 * supervised runtime. Closing the window destroys its renderer while the
 * runtime keeps running; Quit from the tray stops everything.
 */
import { join } from 'node:path'

import { isLlmProvider } from '@assistant/providers/llm-presets'
import { app, BrowserWindow, dialog, protocol, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, session, shell, Tray, type IpcMainInvokeEvent } from 'electron'

import {
  CH,
  isMode,
  parseApproval,
  parseChatsOp,
  parseInitiativeAction,
  parseMessage,
  parseSetup,
  parseVoice,
  type InitiativeItem,
  type ReplyEvent,
  type RuntimeStatus,
  type UsageView,
  type SessionChange,
} from '../shared/ipc.ts'
import { CC } from '../shared/control.ts'
import { CHALLENGE, IC, isAskWhen } from '../shared/identity.ts'
import { NC } from '../shared/news.ts'
import { AudioGate } from './bargein.ts'
import { Controls } from './controls.ts'
import { DesktopService } from './desktop/service.ts'
import { FileService } from './files/service.ts'
import { UiService } from './ui.ts'
import { WorldService } from './world.ts'
import { IdentityGate } from './identity.ts'
import { gateIpc } from './ipc-gate.ts'
import { mainWebPreferences } from './window-prefs.ts'
import { registerBackupIpc } from './backup.ts'
import { CodeService } from './code/service.ts'
import { registerStartupIpc, startedHidden } from './startup.ts'
import { registerLearningIpc } from './learning.ts'
import { NewsService, newsSchemePrivileges } from './news.ts'
import { modelSchemePrivileges, WakeService } from './wake.ts'
import { registerDataIpc } from './data.ts'
import { registerPersonalityIpc } from './personality.ts'
import { watchSession } from './session.ts'
import { providerFor, readSetup, runtimeEnv, saveSetup, saveSpeakReplies, setupSummary as readSetupSummary } from './settings.ts'
import { RuntimeSupervisor } from './supervisor.ts'
import { PresenceWidget } from './presence.ts'
import { GlassPanel } from './glass.ts'
import { SystemService } from './system/service.ts'
import { SystemMapService } from './system/sysmap.ts'
import { PcActions } from './system/actions.ts'
import { PCC, type PcState, type SystemOp } from '../shared/system.ts'
import { describeEntry, searchMap } from '../shared/sysmap.ts'
import { PRS, WIDGET_WHEN, type WidgetWhen } from '../shared/presence.ts'

// Privileged scheme for the local speech model must be declared before 'ready'.
// Electron takes one list of privileged schemes, before 'ready': local speech models and news pictures.
protocol.registerSchemesAsPrivileged([modelSchemePrivileges, newsSchemePrivileges])

// Development only: lets tooling inspect the window (never in a packaged build).
if (!app.isPackaged && /^\d{4,5}$/.test(process.env.ASSISTANT_DEBUG_PORT ?? '')) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.ASSISTANT_DEBUG_PORT!)
  app.commandLine.appendSwitch('remote-allow-origins', 'http://127.0.0.1')
}

const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)
// In development the repo root's .env feeds setup, like `pnpm chat`.
const devEnvFile = app.isPackaged ? null : join(app.getAppPath(), '../../.env')
const ACCENT = { r: 0x14, g: 0xb8, b: 0xa6 }
/** Brings Atlas to the front from anywhere. */
const SUMMON_HOTKEY = 'CommandOrControl+Alt+A'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let keys = { llm: false, voice: false }
// Name, voice provider and voice as the runtime sees them: stored setup over the environment (.env in development).
const setupSummary = () => readSetupSummary(runtimeEnv(devEnvFile), keys)
let voiceReady = false
/** Latest cost meter totals from the runtime. */
let usage: UsageView | null = null
const speech = () => ({ available: voiceReady, enabled: readSetup().speakReplies })
let status: RuntimeStatus = { phase: 'starting', problems: [], warnings: [], mode: 'companion', setup: setupSummary(), approvals: [], speech: speech(), later: [] }
let sessionWatch: ReturnType<typeof watchSession> | null = null

// ── owner check ─────────────────────────────────────────────
// While locked, the runtime still believes the owner is away: the return that
// would start a briefing is held here until the security code is confirmed.
const identity = new IdentityGate(join(app.getPath('userData'), 'identity.json'))
let heldReturn: Extract<SessionChange, { idleMs: number }> | null = null
const publishIdentity = () => {
  toRenderer(IC.changed, identity.view())
  presence.refresh()
  // Nothing stays on the desktop while the owner check is on, and nobody unconfirmed gets Full control.
  if (identity.locked) {
    glass.close()
    if (controls.fullControlView.on) controls.setFullControl(false)
  }
}
const requireOwner = () => {
  if (identity.locked) throw new Error('Please confirm it is you first.')
}

// The host scrubs key values from everything it reports before it reaches here.
const log = (level: 'info' | 'warn' | 'error', message: string) => console[level](`[runtime] ${message}`)

// ── runtime ─────────────────────────────────────────────────

const toRenderer = (channel: string, payload: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/**
 * A window opened for the assistant speaking up is still loading when the
 * reply starts, so reply events wait here until the companion says it is
 * listening (CH.ready). Main sends in order, so nothing is lost or doubled.
 */
let rendererReady = false
let heldReplies: ReplyEvent[] = []
const MAX_HELD = 500
// Audio of a reply the owner talked over or stopped never reaches the speakers.
const audioGate = new AudioGate()
const replyToRenderer = (e: ReplyEvent) => {
  if (!win || win.isDestroyed() || !audioGate.allows(e)) return
  if (rendererReady) return toRenderer(CH.reply, e)
  if (heldReplies.length < MAX_HELD) heldReplies.push(e)
}

/** Bring the companion forward without stealing focus: reopen it if closed, flash it in the taskbar. */
const drawAttention = () => {
  if (!win || win.isDestroyed()) createWindow({ inactive: true })
  else if (!win.isVisible()) win.showInactive()
  if (!win?.isFocused()) win?.flashFrame(true)
}

const notify = (item: InitiativeItem) => {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: item.kind === 'reminder' ? 'Reminder' : 'Assistant', body: item.title, silent: true })
  n.on('click', () => createWindow())
  n.show()
}

const publish = (next: Partial<RuntimeStatus>) => {
  status = { ...status, ...next }
  toRenderer(CH.statusChanged, status)
  presence.refresh()
  updateTray()
}

// Connections, standing rules, activity and the pause switch. Only the owner's UI changes them.
const controls: Controls = new Controls({
  handle: (channel, fn) => handle(channel, fn),
  window: () => win,
  mcpConfigPath: () => runtimeEnv(devEnvFile).ASSISTANT_MCP_CONFIG!,
  post: msg => supervisor.control(msg),
  listActions: () => supervisor.listActions(),
  onChange: state => {
    toRenderer(CC.changed, state)
    updateTray()
  },
  onStop: () => toRenderer(CH.silence, null),
  // Full control shows everywhere: the widget's amber ring, the tray, the title bar (from the controls state).
  onFullControl: v => presence.fullControl(v.on),
  log,
})

const supervisor: RuntimeSupervisor = new RuntimeSupervisor({
  entry: join(import.meta.dirname, 'runtime.js'),
  env: () => runtimeEnv(devEnvFile),
  cwd: app.getPath('userData'),
  onStatus: ({ keys: k, voiceReady: v, phase, problems, warnings }) => {
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
    // The assistant is speaking up on its own: make sure the owner can see and hear it.
    if (e.type === 'initiative') {
      drawAttention()
      presence.spokeUp(e.item)
    }
    replyToRenderer(e)
  },
  onLater: (later, item) => {
    publish({ later })
    if (item) notify(item)
  },
  away: () => sessionWatch?.away ?? (identity.locked ? 'lock' : undefined),
  onApproval: request => {
    publish({ approvals: [...status.approvals, request] })
    // An approval needs the owner's eyes: bring the companion back if it was closed.
    createWindow()
    if (tray && !win?.isFocused()) tray.displayBalloon?.({ title: 'Assistant needs your approval', content: `${request.tool}: ${request.reason}` })
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
  onLearning: e => learning.onHostEvent(e),
  onUsage: u => {
    usage = u
    toRenderer(CH.usageChanged, u)
  },
  onWorld: e => world.onHostEvent(e),
  onUi: e => {
    // The model's window tools.
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

// ── desktop widget ──────────────────────────────────────────

const presence = new PresenceWidget({
  file: join(app.getPath('userData'), 'presence.json'),
  preload: join(import.meta.dirname, '../preload/presence.cjs'),
  isDev,
  load: (w, page) => void (isDev ? w.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html`) : w.loadFile(join(import.meta.dirname, `../renderer/${page}.html`))),
  openMain: () => createWindow(),
  command: c => {
    if (!win || win.isDestroyed() || !rendererReady) return false
    toRenderer(PRS.command, c)
    return true
  },
  answerApproval: (id, approved) => supervisor.answerApproval(id, approved),
  initiativeAction: (id, action) => supervisor.initiativeAction(id, action),
  approvals: () => status.approvals,
  locked: () => identity.locked,
  name: () => 'Atlas',
})
presence.register()

/** The glass panel beside the widget: news, a story, a map or a note, when the owner asks Atlas for one. */
const glass = new GlassPanel({
  preload: join(import.meta.dirname, '../preload/glass.cjs'),
  isDev,
  load: (w, page) => void (isDev ? w.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html`) : w.loadFile(join(import.meta.dirname, `../renderer/${page}.html`))),
  headlines: async () => (await news.list()).headlines,
  widget: () => presence.bounds(),
  locked: () => identity.locked,
  world: (kind, box) => world.glassData(kind, box),
  onShown: shown => presence.glass(shown),
})
glass.register()

/** The PC itself: Wi-Fi, Bluetooth, battery, VPN, read every 45 s and on network or power changes. */
const pcSystem = new SystemService({
  dir: join(app.getPath('userData'), 'system'),
  log: (level, message) => log(level, message),
  onSnapshot: (s, changes) => {
    supervisor.system(s, changes)
    publishPc()
  },
})

/** Where things are on the PC (apps, projects, folders), once the owner turns it on. */
const sysmap = new SystemMapService({
  file: join(app.getPath('userData'), 'sysmap.json'),
  apps: () => pcSystem.apps(),
  codeProjects: () => code.state().projects.map(p => ({ name: p.name, path: p.path })),
  log: (level, message) => log(level, message),
  onChange: () => publishPc(),
})
const pcState = (): PcState => ({ status: pcSystem.current, changes: pcSystem.changes, map: sysmap.view() })
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

/** The app opens on exactly what the glass panel was showing; the panel folds away. */
const handOffGlass = () => {
  const v = glass.current
  if (!v) return
  glass.close()
  const done = (p: Promise<unknown>) => void p.catch(e => log('warn', `Glass hand-off: ${e instanceof Error ? e.message : String(e)}`))
  switch (v.kind) {
    case 'news':
      return done(ui.showNews(v.category ?? 'all', null))
    case 'story':
      return done(ui.showNews(v.item.category, v.item.id))
    case 'map':
      return done(
        ui
          .handleOp({ kind: 'map', op: { kind: 'view', lat: v.lat, lon: v.lon, zoom: v.zoom, label: v.title || undefined } })
          .then(() => (v.pins.length ? ui.handleOp({ kind: 'map', op: { kind: 'pins', add: v.pins.map(p => ({ lat: p.lat, lon: p.lon, label: p.label })), clear: true } }) : '')),
      )
    case 'note':
      return done(ui.apply({ chat: true }))
  }
}

// ── window ──────────────────────────────────────────────────

const createWindow = ({ inactive = false } = {}) => {
  // The owner check is waiting and someone is at the unlocked computer: ask aloud.
  if (identity.locked && !sessionWatch?.osLocked && identity.prompt()) publishIdentity()
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return
  }
  rendererReady = false
  heldReplies = []
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: 'Assistant',
    icon: appIcon(),
    // Windows 11 acrylic behind the glass UI; a transparent base avoids a flash of solid colour.
    // Older Windows ignores the material and the page's own tinted background shows instead.
    ...(process.platform === 'win32' ? { backgroundMaterial: 'acrylic' as const, backgroundColor: '#00000000' } : { backgroundColor: '#0b1020' }),
    // No native title bar: the page draws its own (drag region + logo); Windows keeps
    // its real minimize/maximize/close buttons, drawn transparently over the page.
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    autoHideMenuBar: true,
    webPreferences: mainWebPreferences(join(import.meta.dirname, '../preload/index.cjs'), isDev),
  })
  // Belt and braces: should tools open anyway in the installed app, close them at once.
  if (!isDev) win.webContents.on('devtools-opened', () => win?.webContents.closeDevTools())
  win.once('ready-to-show', () => (inactive ? win?.showInactive() : win?.show()))
  ui.watch(win)
  win.on('focus', () => win?.flashFrame(false))
  // The desktop widget steps in while Atlas's window is out of sight or behind other apps.
  const seen = () => {
    const inView = Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused())
    presence.mainWindow(inView)
    // Coming to the front with something on the glass panel: the app takes it over, the widget goes compact.
    if (inView) handOffGlass()
  }
  for (const ev of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur'] as const) win.on(ev as 'show', seen)
  // Closing the window destroys the renderer (keeping idle RAM low); the tray and runtime stay up.
  win.on('closed', () => {
    win = null
    presence.mainWindow(false)
    rendererReady = false
    heldReplies = []
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', e => e.preventDefault())

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
}

// ── tray ────────────────────────────────────────────────────

/** Height of the page's own title bar (TITLE_BAR_HEIGHT in the renderer must match). */
const TITLE_BAR_HEIGHT = 40
/** Transparent caption buttons whose glyphs follow the light/dark theme. */
const titleBarOverlay = () => ({
  color: '#00000000',
  symbolColor: nativeTheme.shouldUseDarkColors ? '#cfe3ff' : '#1e293b',
  height: TITLE_BAR_HEIGHT,
})
nativeTheme.on('updated', () => {
  if (win && !win.isDestroyed()) win.setTitleBarOverlay(titleBarOverlay())
})

/** App and tray icons rendered from resources/icon.svg (`pnpm --filter @assistant/desktop icons`). */
const resource = (name: string) => join(app.getAppPath(), 'resources', name)
const appIcon = () => nativeImage.createFromPath(resource('icon.png'))

const trayIcon = () => {
  // tray@2x.png sits beside tray.png, so high-DPI taskbars get the sharp version.
  const image = nativeImage.createFromPath(resource('tray.png'))
  return image.isEmpty() ? fallbackTrayIcon() : image
}

/** A filled accent dot drawn in code, used if the icon files are missing. */
const fallbackTrayIcon = () => {
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 15.5, y - 15.5)
      const a = Math.max(0, Math.min(1, 13.5 - d))
      const i = (y * size + x) * 4
      buf[i] = ACCENT.b
      buf[i + 1] = ACCENT.g
      buf[i + 2] = ACCENT.r
      buf[i + 3] = Math.round(a * 255)
    }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 })
}

const PHASE_LABEL: Record<RuntimeStatus['phase'], string> = {
  starting: 'Starting…',
  setup: 'Setup needed',
  checking: 'Checking providers…',
  ready: 'Ready',
  restarting: 'Restarting runtime…',
  stopped: 'Stopped',
}

const updateTray = () => {
  if (!tray) return
  tray.setToolTip(`Assistant: ${PHASE_LABEL[status.phase]}${controls.fullControlView.on ? ' · Full control' : ''}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open assistant', click: () => createWindow() },
      { label: PHASE_LABEL[status.phase], enabled: false },
      { type: 'separator' },
      controls.fullControlView.on
        ? { label: 'Full control is on: turn it off', click: () => controls.setFullControl(false) }
        : { label: 'Normal mode (Atlas asks first)', enabled: false },
      controls.isPaused
        ? { label: 'Resume automation', click: () => controls.setPaused(false) }
        : { label: 'Stop all automation', accelerator: controls.activeHotkey ?? undefined, click: () => controls.stopAll() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  )
}

// ── IPC: every handler validates its sender and payload ─────

const fromOurWindow = (e: IpcMainInvokeEvent) => {
  const url = e.senderFrame?.url ?? ''
  return win !== null && e.sender === win.webContents && (isDev ? url.startsWith(process.env.ELECTRON_RENDERER_URL!) : url.startsWith('file://'))
}

const handle = <T>(channel: string, fn: (arg: unknown, arg2: unknown, arg3?: unknown, arg4?: unknown) => T | Promise<T>) =>
  ipcMain.handle(channel, gateIpc(channel, fn, { fromOurWindow, requireOwner: () => requireOwner() }))

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
controls.register()
/** Code projects: approved folders, activity scans, dev servers, status files. */
const code = new CodeService({
  handle,
  toRenderer,
  toRuntime: s => supervisor.code({ type: 'code-snapshot', ...s }),
  window: () => win,
  requireOwner: () => requireOwner(),
  log: (level, message) => log(level, message),
})
code.register()
/** Files: chosen folders, organising with undo, Recycle Bin instead of delete. */
const files = new FileService({ handle, toRenderer, window: () => win, requireOwner: () => requireOwner(), log: (level, message) => log(level, message) })
files.register()
/** Desktop apps: the owner's chosen apps, UI Automation through a PowerShell worker, WhatsApp, "watch me". */
const desktop = new DesktopService({ handle, toRenderer, requireOwner: () => requireOwner(), log: (level, message) => log(level, message) })
desktop.register()
/** Atlas's own window: page, conversation, size, compact mode, kept on top. */
const ui = new UiService({
  window: () => win,
  open: async () => {
    createWindow()
    for (let i = 0; i < 100 && !rendererReady; i++) await new Promise(r => setTimeout(r, 100))
    if (!win) throw new Error('The window did not open.')
    return win
  },
  toRenderer,
  handle,
  requireOwner: () => requireOwner(),
  onChange: state => supervisor.ui(state),
  glass: op => glass.handle(op),
  system: op => pcOp(op),
})
ui.register()
/** The live world at the owner's places, for the World page. */
const world = new WorldService({ handle, toRenderer, toRuntime: msg => supervisor.world(msg), requireOwner: () => requireOwner(), log: (level, message) => log(level, message) })
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
  // Playback stops first, in the renderer; the host cancels the token in parallel.
  if (!audioGate.interrupt(supervisor.currentReply)) return
  toRenderer(CH.silence, null)
  supervisor.interrupt()
})
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
handle(PRS.update, raw => presence.update(raw))
handle(PCC.state, () => pcState())
handle(PCC.setMap, on => {
  if (typeof on !== 'boolean') throw new Error('On or off.')
  sysmap.setEnabled(on)
  return pcState()
})
handle(PCC.rebuild, () => {
  if (sysmap.enabled) void sysmap.build()
  void pcSystem.refresh()
  return pcState()
})
handle(PCC.addExcluded, async () => {
  const opts = { title: 'A folder Atlas must never look into', properties: ['openDirectory' as const] }
  const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (!picked.canceled && picked.filePaths[0]) sysmap.setExcluded([...sysmap.view().excluded, picked.filePaths[0]])
  return pcState()
})
handle(PCC.removeExcluded, path => {
  if (typeof path !== 'string') throw new Error('Which folder?')
  sysmap.setExcluded(sysmap.view().excluded.filter(p => p !== path))
  return pcState()
})
handle(PRS.getWhen, () => presence.when)
handle(PRS.setWhen, when => {
  requireOwner()
  if (!WIDGET_WHEN.includes(when as WidgetWhen)) throw new Error('Unknown widget setting.')
  presence.setWhen(when as WidgetWhen)
  return presence.when
})
handle(CH.ready, () => {
  for (const e of heldReplies.splice(0)) toRenderer(CH.reply, e)
  rendererReady = true
})
registerStartupIpc(handle)
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
const data = registerDataIpc({
  handle,
  post: msg => supervisor.data(msg),
  isReady: () => status.phase === 'ready',
  toRenderer,
})
const learning = registerLearningIpc({
  handle,
  post: msg => supervisor.data(msg),
  isReady: () => status.phase === 'ready',
  toRenderer,
  requireOwner: () => requireOwner(),
})

registerBackupIpc({
  handle,
  requireOwner: () => requireOwner(),
  dataDir: () => runtimeEnv(devEnvFile).ASSISTANT_DATA_DIR!,
  snapshotDb: path => supervisor.backupDb(path),
  stopRuntime: () => supervisor.stop(),
  log: (level, message) => log(level, message),
})

const personality = registerPersonalityIpc({
  handle,
  post: msg => supervisor.personality(msg),
  isReady: () => status.phase === 'ready',
  speechAvailable: () => status.speech.available,
  toRenderer,
  window: () => win,
})

// ── owner check IPC: the code never leaves main, results carry no secret ──

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
handle(IC.get, () => identity.view())
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

// ── permissions: the companion may use the microphone, nothing else ──

const isCompanion = (wc: Electron.WebContents | null) => win !== null && !win.isDestroyed() && wc === win.webContents

const allowMicrophoneOnlyForCompanion = () => {
  const s = session.defaultSession
  s.setPermissionRequestHandler((wc, permission, callback, details) => {
    const audioOnly = permission === 'media' && 'mediaTypes' in details && (details.mediaTypes ?? []).every(t => t === 'audio')
    callback(isCompanion(wc) && audioOnly)
  })
  s.setPermissionCheckHandler((wc, permission) => isCompanion(wc) && permission === 'media')
}

// ── lifecycle ───────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => createWindow())
  app.whenReady().then(() => {
    app.setAppUserModelId('dev.personal-assistant.desktop')
    allowMicrophoneOnlyForCompanion()
    wake.registerProtocol()
    news.registerProtocol()
    code.start()
    supervisor.setSpeech(readSetup().speakReplies)
    tray = new Tray(trayIcon())
    tray.on('click', () => createWindow())
    controls.registerHotkey()
    // Ctrl+Alt+A brings Atlas forward from anywhere (opens it if closed).
    try {
      if (!globalShortcut.register(SUMMON_HOTKEY, () => void ui.apply({ front: true }).catch(() => createWindow()))) log('warn', `The hotkey ${SUMMON_HOTKEY} is taken by another app; use the widget or the tray.`)
    } catch {
      log('warn', `The hotkey ${SUMMON_HOTKEY} could not be registered.`)
    }
    updateTray()
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
        // Waking from sleep, Windows often shows its own sign-in first: ask once it is unlocked, not to an empty room.
        // The unlock arrives as its own change and comes back here.
        if (change.signal === 'resume') setTimeout(() => !sessionWatch?.osLocked && identity.locked && createWindow({ inactive: true }), 2_500)
        else if (!sessionWatch?.osLocked) createWindow({ inactive: true })
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
    sysmap.start()
    // The glass panel loads hidden in the background, so it opens at once when asked.
    setTimeout(() => glass.prewarm(), 4_000).unref?.()
    // Started by Windows at login: stay in the tray until the owner opens Atlas (the widget shows meanwhile).
    if (!startedHidden()) createWindow()
    else presence.mainWindow(false)
  })
  // Staying alive in the tray is the point: never quit when the last window closes.
  app.on('window-all-closed', () => {})
  app.on('before-quit', e => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    globalShortcut.unregisterAll()
    sessionWatch?.stop()
    desktop.stop()
    world.ships.stop()
    presence.stop()
    glass.stop()
    pcSystem.stop()
    sysmap.stop()
    void supervisor.stop().finally(() => {
      tray?.destroy()
      app.quit()
    })
  })
}
