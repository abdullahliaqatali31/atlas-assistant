/**
 * Atlas Gateway: the whole assistant as one Node process. It supervises the
 * runtime (the model, memory, tools), keeps the world feeds and its own
 * Playwright browser, serves the interface to the owner's browser over HTTP
 * and a WebSocket, and keeps a small tray icon with the global shortcuts.
 *
 * Atlas's hands (the PC services: status, apps, files, code, the widget) are
 * gateway/hands.ts: here on this PC, and on any other machine that paired
 * (`atlas connect`). With --server (a Linux box, Docker) there are no hands
 * here at all: the brain runs alone and works on the machines that connect.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { isLlmProvider } from '@assistant/providers/llm-presets'
import { osCredentialStore } from '@assistant/runtime'

import { CH, isMode, MODES, parseApproval, parseChatModelChoice, parseChatsOp, parseInitiativeAction, parseMessage, parseSetup, parseVoice, type ChatModelChoice, type InitiativeItem, type ReplyEvent, type RuntimeStatus, type SessionChange, type UiMode, type UsageView } from '../shared/ipc.ts'
import { CC } from '../shared/control.ts'
import { CHALLENGE, IC, isAskWhen } from '../shared/identity.ts'
import { NC } from '../shared/news.ts'
import { GLOBAL_SHORTCUTS, SCT, type GlobalShortcutId, type ShortcutsView } from '../shared/shortcuts.ts'
import { parseLiveVoice, LIVE_VOICES, type LiveVoiceName } from '../shared/livevoice.ts'
import { PWC } from '../shared/powerup.ts'
import { type SystemOp } from '../shared/system.ts'
import { describeMachines, HANDS_OP, MCH, platformOf, type RuntimeNote } from '../shared/hands.ts'
import type { CodeProjectView, RunView } from '../shared/code.ts'
import type { HabitsForAtlas } from '../shared/habits.ts'
import type { PcNotification } from '../shared/notifications.ts'
import { type VoiceChange } from '../shared/ui.ts'
import { PRS, type PresenceCommand } from '../shared/presence.ts'
import { AudioGate } from '../main/bargein.ts'
import { Controls } from '../main/controls.ts'
import { UiService } from '../main/ui.ts'
import { WorldService } from '../main/world.ts'
import { IdentityGate } from '../main/identity.ts'
import { WindowsHello } from '../main/system/hello.ts'
import { OWNER_ONLY } from '../main/ipc-gate.ts'
import { WebAccess } from '../main/web/server.ts'
import { registerBackupIpc } from '../main/backup.ts'
import { ensureStartupDefault, registerStartupIpc, startedHidden } from '../main/startup.ts'
import { registerLearningIpc } from '../main/learning.ts'
import { registerBrainIpc } from '../main/brain.ts'
import { BrowserService } from '../main/browser.ts'
import { NewsService } from '../main/news.ts'
import { WakeService } from '../main/wake.ts'
import { registerDataIpc } from '../main/data.ts'
import { registerPersonalityIpc } from '../main/personality.ts'
import { watchSession } from '../main/session.ts'
import { providerFor, readSetup, runtimeEnv, saveQuietHours, saveSpeakLimits, saveSetup, saveSpeakReplies, setupSummary as readSetupSummary, saveLiveVoice } from '../main/settings.ts'
import { RuntimeSupervisor } from '../main/supervisor.ts'
import { PowerUp } from '../main/powerup.ts'
import { LiveVoice } from '../main/livevoice.ts'
import { app, powerMonitor, shell } from '../main/host/index.ts'
import { Tray } from '../main/host/tray.ts'
import { TimerService } from '../main/timers.ts'
import { TelegramChannel } from '../main/telegram.ts'
import { SkillLibrary } from '../main/skill-library.ts'
import { SK } from '../shared/skillmd.ts'
import { SpeakerService, speakerDir } from '../main/speaker.ts'
import { bytesToSamples, type SpeakerResult } from '../shared/speaker.ts'
import { atlasProfile, openInProfile } from '../main/web/opener.ts'
import { HandsHub } from '../main/hands/hub.ts'
import { WatchService } from '../main/watches.ts'
import { applyBrainData, checkBundle } from '../main/hands/move.ts'
import { handsPackage, installScript } from '../main/hands/installer.ts'
import type { SystemSnapshot } from '../shared/system.ts'
import { createHands, type Hands } from './hands.ts'

const isDev = !app.isPackaged
/** A server: the brain alone (no tray, no PC services here); machines connect to it with their hands. */
const SERVER = process.argv.includes('--server') || process.env.ATLAS_ROLE === 'server'
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
/** How the page words things (Windows, a Mac): the machine Atlas works on. */
const hostOf = (p: string): RuntimeStatus['host'] => (p === 'windows' ? 'windows' : p === 'mac' ? 'mac' : 'other')
let status: RuntimeStatus = { phase: 'starting', problems: [], warnings: [], mode: 'companion', setup: setupSummary(), approvals: [], speech: speech(), later: [], host: SERVER ? 'other' : hostOf(platformOf()) }
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
  hub.ownerChanged(identity.locked)
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
  if (web.hasPages) return
  // A server has no screen: the machine Atlas works on opens the page in its browser.
  if (SERVER || !hub.activeIsLocal) {
    if (!hub.activeOnline) throw new Error(`Open Atlas in your browser (${hub.activeLabel} is not connected to show it).`)
    await hub.call(HANDS_OP.show, [])
  } else web.openInBrowser()
  for (let i = 0; i < 100 && !web.hasPages; i++) await new Promise(r => setTimeout(r, 150))
  if (!web.hasPages) throw new Error('The browser did not open Atlas.')
}

/**
 * "Show me Atlas" from anywhere (the tray, a notice, the atlas command, a shortcut): an open page is
 * asked to come forward (it shows a notice that brings its tab back), never a second tab; with no page
 * open, the browser opens, in the profile the owner uses for Atlas.
 */
const showAtlas = () => {
  if (web.hasPages) return void ui.send({ attention: true })
  void openUi().catch(() => undefined)
}

/** A notice from the tray (this PC's, and every connected machine's); clicking it opens Atlas. */
const notify = (title: string, text: string) => {
  if (!SERVER) tray.balloon(title, text)
  hub.broadcast(HANDS_OP.notify, [title, text])
}
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
  controlInit: () => [...controls.initMessages(), data.initMessage(), { type: 'code-snapshot' as const, ...lastCode }],
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
  onSkillsChanged: () => toRenderer(SK.changed, skillLibrary().list()),
  // An instant command the runtime recognised: carried out here, at once.
  onQuick: action => {
    if (action.kind === 'stop') {
      audioGate.interrupt(supervisor.currentReply)
      toRenderer(CH.silence, null)
    } else if (action.kind === 'mode') {
      supervisor.setMode(action.mode)
      publish({ mode: action.mode })
    } else if (action.kind === 'pause') controls.setPaused(action.on)
    else if (action.kind === 'volume') ui.send({ volume: action.dir })
    else if (action.kind === 'open') void ui.apply({ view: action.view }).catch(() => undefined)
    else if (action.kind === 'timer') timers.handle({ kind: 'set', label: 'Timer', inMinutes: action.minutes })
  },
  onUi: e => {
    // The model's screen tools.
    void ui.handleOp(e.op).then(
      result => supervisor.files({ type: 'ui-result', requestId: e.requestId, result }),
      error => supervisor.files({ type: 'ui-result', requestId: e.requestId, error: error instanceof Error ? error.message : String(error) }),
    )
  },
  onDesktop: e => {
    // The model's desktop-app tools, answered by request id (on the machine Atlas works on); failures go back as text the model can relay.
    void (hub.call(HANDS_OP.desktop, [e.op]) as Promise<string>).then(
      result => supervisor.files({ type: 'desktop-result', requestId: e.requestId, result }),
      error => supervisor.files({ type: 'desktop-result', requestId: e.requestId, error: error instanceof Error ? error.message : String(error) }),
    )
  },
  onFiles: e => {
    // The model's file tools, answered by request id; failures go back as text the model can relay.
    void (hub.call(HANDS_OP.files, [e.op]) as Promise<string>).then(
      result => supervisor.files({ type: 'files-result', requestId: e.requestId, result }),
      error => supervisor.files({ type: 'files-result', requestId: e.requestId, error: error instanceof Error ? error.message : String(error) }),
    )
  },
  onCode: e => {
    if (e.type === 'code-minutes') return void hub.call(HANDS_OP.code, [e.minutes, 'minutes']).catch(() => undefined)
    // The model's code tools: answered by request id; failures go back as text the model can relay.
    void (hub.call(HANDS_OP.code, [e.op]) as Promise<string>).then(
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
  front: showAtlas,
  talk: () => void whenPageReady(() => pageCommand('talk')),
  stop: () => void pageCommand('stop'),
  quiet: toggleQuiet,
  palette: () => void whenPageReady(() => (web.hasPages ? (ui.send({ palette: true }), true) : false)),
  board: () => void whenPageReady(() => (web.hasPages ? (ui.send({ shortcuts: true }), true) : false)),
  // Registered by Controls (it owns pausing).
  pause: () => undefined,
}

const tray = new Tray({
  icon: join(app.getAppPath(), 'resources', 'tray.png'),
  onClick: id => trayClick(id),
  onBalloonClick: showAtlas,
  onSession: line => {
    powerMonitor.feed(line)
    hub.localSession(line)
  },
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
  if (id === 'open') return showAtlas()
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

// ── the PC: Atlas's hands, here and on other machines ───────

/** The last code projects the machine Atlas works on reported (sent again to a restarted runtime). */
let lastCode: { projects: CodeProjectView[]; running: RunView[] } = { projects: [], running: [] }
/** What the machine Atlas works on tells the runtime. */
const onNote = (n: RuntimeNote) => {
  if (n.kind === 'system') {
    supervisor.system(n.snapshot as Parameters<RuntimeSupervisor['system']>[0], n.changes as Parameters<RuntimeSupervisor['system']>[1])
    watches.onReading(n.snapshot as SystemSnapshot)
  }
  else if (n.kind === 'notifications') supervisor.notifications(n.items as PcNotification[], n.fresh)
  else if (n.kind === 'habits') supervisor.habits(n.data as HabitsForAtlas | null)
  else {
    lastCode = n.snapshot as typeof lastCode
    supervisor.code({ type: 'code-snapshot', ...lastCode })
  }
}

/** Is this PC the machine Atlas works on? (Asked before the hub exists too: then it is.) */
let localActive = () => true
/** This PC's hands (none on a server). */
const hands: Hands | null = SERVER
  ? null
  : createHands({
      dataDir: userData,
      appPath: app.getAppPath(),
      toRenderer: (channel, payload) => {
        // Only the machine Atlas works on fills the This PC settings.
        if (localActive()) toRenderer(channel, payload)
      },
      note: n => {
        if (localActive()) onNote(n)
      },
      requireOwner: () => requireOwner(),
      widgetUrl: () => web.pairingUrl(5 * 60_000, '/widget.html'),
      showAtlas: () => showAtlas(),
      openExternal: url => void shell.openExternal(url),
      log: (level, message) => log(level, message),
    })

/** The machines Atlas works on: this PC and those that paired. */
const hub: HandsHub = new HandsHub({
  file: join(userData, 'machines.json'),
  local: hands ? { name: `This PC (${hostname()})`, handlers: hands.handlers, capabilities: hands.capabilities, version: app.getVersion() } : null,
  toRenderer,
  onNote,
  onSession: line => powerMonitor.feed(line),
  // Atlas hears how every machine is: asleep, shut down, locked, out of reach.
  onPresence: () => {
    const machines = hub.view().machines
    // With only this PC there is nothing to tell: the brain sleeps and wakes with it.
    supervisor.machines(machines.some(m => !m.local) ? describeMachines(machines, Date.now()) : null)
  },
  onActive: () => {
    // The machine Atlas works on now reads often while a watch is set.
    watches.start()
    const active = hub.view().machines.find(m => m.active)
    publish({ host: active ? hostOf(active.platform) : 'other' })
    // The page shows the new machine's This PC settings.
    toRenderer(MCH.changed, hub.view())
  },
  ticket: () => web.ticket(5 * 60_000),
  ownerLocked: () => identity.locked,
  handle,
  requireOwner: () => requireOwner(),
  brainUrl: () => publicUrl(),
  log,
})
hub.register()
localActive = () => hub.activeIsLocal

/**
 * Starts Atlas again with fresh settings: under systemd or Docker, ending is enough (they start it again);
 * run by hand, it starts its own successor first.
 */
const restartSelf = () =>
  setTimeout(() => {
    const supervised = Boolean(process.env.INVOCATION_ID) || existsSync('/.dockerenv')
    if (!supervised) app.relaunch()
    app.exit(0)
  }, 800)

/** Settings › Machines › "Bring its Atlas data here": that PC's memory and settings move to this brain. */
handle(MCH.importFrom, async (id, keys) => {
  requireOwner()
  if (typeof id !== 'string' || id === 'local') throw new Error('Choose a connected PC.')
  const bundle = checkBundle(await hub.call(HANDS_OP.export, [{ keys: keys === true }], 120_000, id))
  await supervisor.stop()
  const done = applyBrainData(bundle, userData, osCredentialStore())
  log('info', `Atlas data from ${bundle.from} put in place (${done.files} files, ${done.keys} keys); the old data is in ${done.safety}. Restarting.`)
  restartSelf()
  return { from: bundle.from, files: done.files, keys: done.keys }
})

/** The address other machines and browsers use for this brain: the domain when one is set, else this PC's. */
const publicUrl = () => web.publicUrl ?? web.url

/** Atlas's PC requests go to the machine it works on; Full control is the brain's own switch. */
const pcOp = async (op: SystemOp): Promise<string> => {
  if (op.kind === 'full-control') {
    // The runtime asked the owner first (turning on is never automatic); the owner check still applies here.
    if (op.on && identity.locked) throw new Error('The owner check is on: confirm it is you first.')
    controls.setFullControl(op.on, op.mode)
    return op.on ? `Full control is on (${op.mode === 'hour' ? 'for an hour' : op.mode === 'manual' ? 'until you turn it off' : 'until you lock the PC or leave'}).` : 'Full control is off; I will ask before acting again.'
  }
  return (await hub.call(HANDS_OP.system, [op])) as string
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
  // Atlas's own page: in the browser profile the owner uses for it (main/web/opener.ts), else the default browser.
  openExternal: url => {
    if (!openInProfile(url, atlasProfile(Number(new URL(url).port) || 80, join(userData, 'cache')))) void shell.openExternal(url)
  },
  control: { token: CONTROL_TOKEN, act: action => (action === 'quit' ? void quit() : showAtlas()) },
  hands: {
    pair: body => hub.pair(body),
    accept: (req, socket, head) => hub.accept(req, socket, head),
    handlerFor: channel => hub.handlerFor(channel),
    package: () => handsPackage(app.getAppPath()),
    script: (kind, brain, code) => installScript(kind, brain, code),
  },
  server: SERVER,
  onClients: () => {
    // PC readings stay frequent while a page shows Atlas.
    hands?.setWatched(web.hasClients)
    ui.clientsChanged()
  },
  log: (level, message) => log(level, message),
})
web.register()

controls.register()
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
  watches: op => watches.handle(op),
  widget: op => hub.call(HANDS_OP.widget, [op]) as Promise<string>,
})
ui.register()
/** Timers and alarms: they ring here (tray sound and notice) and in the page, whatever the mode. */
const timers = new TimerService({
  file: join(userData, 'timers.json'),
  now: () => Date.now(),
  handle,
  toRenderer,
  ring: (label, detail) => {
    if (!SERVER) tray.alarm()
    hub.broadcast(HANDS_OP.alarm, [])
    notify(`⏰ ${label}`, detail)
    telegram.notice(`⏰ ${label}`, detail)
  },
  quiet: () => tray.quiet(),
  notice: (title, text) => notify(title, text),
  log: (level, message) => log(level, message),
})
timers.register()

/**
 * Atlas's watches (battery low and not charging → a notice every 2 minutes): checked on every reading
 * of the PC it works on, sent wherever the owner is, whatever the mode.
 */
const watches: WatchService = new WatchService({
  file: join(userData, 'watches.json'),
  now: () => Date.now(),
  handle,
  toRenderer,
  deliver: (title, text) => {
    notify(title, text)
    telegram.notice(title, text)
  },
  pace: often => {
    hands?.setPace(often)
    hub.broadcast(HANDS_OP.pace, [often])
  },
  log: (level, message) => log(level, message),
})
watches.register()

/** Voice ID: who is speaking, from voice prints made and kept (encrypted) on this PC. */
const speaker = new SpeakerService({
  dir: speakerDir(userData),
  secrets: osCredentialStore(),
  handle,
  toRenderer,
  requireOwner: () => requireOwner(),
  log: (level, message) => log(level, message),
})
speaker.register()

/** Settings › Skills: the SKILL.md library (Atlas uses the same folder). */
const skillLibrary = () => new SkillLibrary(join(runtimeEnv(devEnvFile).ASSISTANT_DATA_DIR!, 'skills'))
handle(SK.list, () => skillLibrary().list())
handle(SK.preview, async source => {
  requireOwner()
  if (typeof source !== 'string' || !source.trim() || source.length > 2000) throw new Error('Give a skill address or folder.')
  const { notes: _n, text: _t, ...p } = await skillLibrary().preview(source)
  return p
})
handle(SK.install, async source => {
  requireOwner()
  if (typeof source !== 'string' || !source.trim() || source.length > 2000) throw new Error('Give a skill address or folder.')
  await skillLibrary().install(source)
  const list = skillLibrary().list()
  toRenderer(SK.changed, list)
  return list
})
handle(SK.remove, slug => {
  requireOwner()
  if (typeof slug !== 'string') throw new Error('Which skill?')
  skillLibrary().remove(slug)
  const list = skillLibrary().list()
  toRenderer(SK.changed, list)
  return list
})

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
handle(CH.sendVoice, (audio, mime, pcm) => {
  const voice = parseVoice(audio, mime)
  if (!voice) throw new Error('Recording must be audio under 5 MB.')
  if (status.phase !== 'ready') throw new Error('The assistant is not ready yet.')
  if (!status.speech.available) throw new Error('No voice provider is configured; type instead.')
  requireOwner()
  // Voice ID: who said it (a hint for Atlas, never a lock).
  let who: SpeakerResult | undefined
  if (speaker.enabled && pcm instanceof Uint8Array && pcm.byteLength <= 16_000 * 4 * 60) {
    try {
      who = speaker.identify(bytesToSamples(pcm))
    } catch (e) {
      log('warn', `Voice ID: ${(e as Error).message}`)
    }
  }
  return { replyId: supervisor.sendVoice(voice.audio, voice.mime, who) }
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
const speakLimits = () => {
  const s = readSetup()
  return { perDay: s.speakBudget < 0 ? 0 : s.speakBudget || 5, gapMin: s.speakGapMin > 0 ? s.speakGapMin : 60 }
}
handle(CH.speakLimits, () => speakLimits())
handle(CH.setSpeakLimits, (perDay, gapMin) => {
  requireOwner()
  const d = Number(perDay)
  const g = Number(gapMin)
  if (!Number.isInteger(d) || d < 0 || d > 50 || !Number.isInteger(g) || g < 5 || g > 24 * 60) throw new Error('At most 0 to 50 a day, at least 5 minutes apart.')
  saveSpeakLimits(d === 0 ? -1 : d, g)
  restartWhenIdle()
  return speakLimits()
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
const learning = registerLearningIpc({ handle, post: msg => supervisor.data(msg), isReady: () => status.phase === 'ready', toRenderer, requireOwner: () => requireOwner(), memoryDir: () => join(runtimeEnv(devEnvFile).ASSISTANT_DATA_DIR!, 'memory-files') })

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
  hands?.stop()
  hub.stop()
  world.ships.stop()
  timers.stop()
  watches.stop()
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
  writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, url: web.url, control: CONTROL_TOKEN, version: app.getVersion(), started: new Date().toISOString(), server: SERVER }))
  if (SERVER) {
    // No desktop to show a code on: the log carries the first one (atlas pair makes another).
    const first = web.pairedCount === 0 ? `\n  Open it in your browser (this server's address, port ${new URL(web.url).port}) and enter the code ${web.newCode()} (valid 10 minutes; \`atlas pair\` makes a new one).` : ''
    console.log(`\n  ${assistantName} is running as a server: ${web.url}${web.publicUrl ? ` and ${web.publicUrl}` : ''}${first}\n  Connect a PC: Settings › Machines in the page, then \`atlas connect\` on that PC.\n`)
  } else {
    // A link that pairs whichever browser opens it in the next 10 minutes (for a browser Atlas did not open itself).
    console.log(`\n  ${assistantName} is running: ${web.url}\n  Pair a browser on this PC: ${web.pairingUrl(10 * 60_000)}\n`)
  }
  supervisor.setSpeech(readSetup().speakReplies)
  if (!SERVER) {
    tray.start()
    updateTray()
    controls.registerHotkey((accelerator, fn) => tray.register(accelerator, fn))
    // Ctrl+Alt+A opens Atlas, Ctrl+Alt+Space talks, and the rest of the board (shared/shortcuts.ts).
    registerShortcuts()
    // The installed Atlas starts with Windows (page open) unless the owner has chosen otherwise.
    ensureStartupDefault()
  }
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
  hands?.start()
  timers.start()
  watches.start()
  void telegram.start()
  // Started by Windows at login set to start quietly: stay in the tray. Otherwise the page opens.
  if (!SERVER && !startedHidden() && !process.argv.includes('--no-open')) setTimeout(() => void openUi().catch(() => undefined), 800)
}

void start()
