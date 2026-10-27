/**
 * Atlas's hands on one machine: the PC services (Windows status, the system
 * map, notifications, opening and making things, code projects, files,
 * desktop apps, browser habits, the desktop widget), with their Settings
 * channels and the op channels Atlas's tools call (shared/hands.ts).
 *
 * The same module runs inside the gateway when the brain is on this PC, and
 * inside `atlas hands` when the brain runs elsewhere: the host decides where
 * page events, runtime notes and calls go.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { HB, parseWorkHours, ROLE_LABEL, forAtlas, type ProfileRole } from '../shared/habits.ts'
import { CAPABILITIES, HANDS_OP, type Capability, type RuntimeNote } from '../shared/hands.ts'
import { PCC, searchWords, type PcState, type SystemOp } from '../shared/system.ts'
import { describeEntry, isProtectedPath, searchMap } from '../shared/sysmap.ts'
import type { WidgetOp } from '../shared/widget.ts'
import { CodeService } from '../main/code/service.ts'
import { DesktopService } from '../main/desktop/service.ts'
import { FileService } from '../main/files/service.ts'
import { dialog } from '../main/host/index.ts'
import { PcActions } from '../main/system/actions.ts'
import { HabitsService } from '../main/system/habits.ts'
import { NotificationWatcher } from '../main/system/notifications.ts'
import { SystemService } from '../main/system/service.ts'
import { SystemMapService } from '../main/system/sysmap.ts'
import { WidgetService } from '../main/widget/service.ts'

export type Handler = (arg: unknown, arg2: unknown, arg3?: unknown, arg4?: unknown) => unknown

export interface HandsHost {
  /** Where this machine keeps its settings for the services. */
  dataDir: string
  /** The installed copy (resources/ for the widget). */
  appPath: string
  /** The page's events for this machine's Settings (files, apps, code…). */
  toRenderer: (channel: string, payload: unknown) => void
  /** What the runtime should know from this machine. */
  note: (n: RuntimeNote) => void
  /** Throws unless the owner is confirmed (the brain's owner check). */
  requireOwner: () => void
  /** The widget page's address with a one-time pairing ticket. */
  widgetUrl: () => string | Promise<string>
  /** The full Atlas page in this machine's browser. */
  showAtlas: () => void
  openExternal: (url: string) => void
  /** What the owner allowed on this machine (all of it when Atlas runs here). */
  capabilities?: readonly Capability[]
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface Hands {
  /** Every channel these hands answer: Settings channels and op channels. */
  readonly handlers: ReadonlyMap<string, Handler>
  /** Adds a channel (the host's own: notices, alarms, showing Atlas). */
  handle: (channel: string, fn: Handler) => void
  readonly capabilities: readonly Capability[]
  /** A page shows Atlas: read the PC more often. */
  setWatched: (on: boolean) => void
  /** A watch is set: read the PC often whether a page shows Atlas or not. */
  setPace: (often: boolean) => void
  /** The runtime started again: what it should know from here at once. */
  resend: () => void
  start: () => void
  stop: () => void
}

/** Refused because the owner switched it off on this machine. */
const off = (what: string) => {
  throw new Error(`The owner switched off ${what} on this machine (its Atlas hands settings).`)
}

export const createHands = (host: HandsHost): Hands => {
  const handlers = new Map<string, Handler>()
  const handle = <T>(channel: string, fn: (a: unknown, b: unknown, c?: unknown, d?: unknown) => T | Promise<T>) => {
    handlers.set(channel, fn)
  }
  const capabilities = host.capabilities ?? CAPABILITIES
  const allowed = (c: Capability) => capabilities.includes(c)
  const { toRenderer, requireOwner, log } = host
  const dataDir = host.dataDir

  /** The PC itself: Wi-Fi, Bluetooth, battery, VPN, read often while Atlas is on screen, rarely otherwise. */
  const pcSystem = new SystemService({
    dir: join(dataDir, 'system'),
    log: (level, message) => log(level, message),
    onSnapshot: (snapshot, changes) => {
      host.note({ kind: 'system', snapshot, changes })
      publishPc()
    },
  })
  /** Where things are on the PC (apps, projects, folders), once the owner turns it on. */
  const sysmap = new SystemMapService({
    file: join(dataDir, 'sysmap.json'),
    apps: () => pcSystem.apps(),
    codeProjects: () => code.state().projects.map(p => ({ name: p.name, path: p.path })),
    log: (level, message) => log(level, message),
    onChange: () => publishPc(),
  })
  /** Windows notifications, once the owner turns them on: read here, passed to Atlas. */
  const pcNotifications = new NotificationWatcher({
    file: join(dataDir, 'notifications.json'),
    cacheDir: join(dataDir, 'notifications-cache'),
    onNew: (items, fresh) => host.note({ kind: 'notifications', items, fresh }),
    onChange: () => publishPc(),
    log: (level, message) => log(level, message),
  })
  const pcState = (): PcState => ({ status: pcSystem.current, changes: pcSystem.changes, map: sysmap.view(), notifications: pcNotifications.view() })
  const publishPc = () => toRenderer(PCC.changed, pcState())
  const pcActions = new PcActions({ map: () => sysmap.map, foreground: () => pcSystem.foreground() })

  /** Atlas's PC requests: status, Settings pages, finding, opening and making things (Full control stays with the brain). */
  const pcOp = async (op: SystemOp): Promise<string> => {
    if (!allowed('system')) return off('PC status, search and opening things')
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
          const why = e instanceof Error ? e.message : String(e)
          throw new Error(process.platform === 'darwin' ? `Spotlight did not answer (${why}).` : process.platform === 'linux' ? `File search is not available on this Linux machine yet (${why}).` : `Windows search did not answer (${why}). Is the Windows Search service on?`)
        }
        const excluded = sysmap.view().excluded.map(x => x.toLowerCase())
        const found = rows
          .filter(r => r.path && !isProtectedPath(r.path, homedir()) && !excluded.some(x => r.path.toLowerCase().startsWith(x)) && !/[\\/](node_modules|\.git|\$recycle\.bin|\.trash)[\\/]/i.test(r.path))
          // Names that say it come before files that only mention it inside; newest first within each.
          .map(r => ({ r, named: words.filter(w => r.name.toLowerCase().includes(w)).length }))
          .sort((a, b) => b.named - a.named || (b.r.modified > a.r.modified ? 1 : b.r.modified < a.r.modified ? -1 : 0))
          .map(x => x.r)
          .slice(0, 20)
        if (!found.length) return `Nothing on this PC matches "${op.query}"${op.fileKind ? ` (${op.fileKind})` : ''}${op.days ? ` from the last ${op.days} days` : ''}.`
        return ['Found on this PC:', ...found.map((r, i) => `${i + 1}. ${r.name} — ${dirname(r.path)}${r.modified ? ` — ${r.modified.slice(0, 10)}` : ''}${r.kind ? ` — ${r.kind}` : ''}`), 'Open one with open_item and its full path.'].join('\n')
      }
      case 'full-control':
        throw new Error('Full control is switched on the brain, not on a machine.')
      case 'status':
      case 'settings':
        return pcSystem.handle(op)
    }
    if (!sysmap.enabled) return 'The system map is off. The owner can turn it on in Controls › This PC; until then only the folders, apps and projects they picked are known.'
    if (sysmap.view().building && !sysmap.map.builtAt) return 'The system map is still being built; try again in a minute.'
    const found = searchMap(sysmap.map.entries, op.query, op.mapKind)
    return found.length ? ['Found on this PC:', ...found.map(describeEntry)].join('\n') : `Nothing on this PC matches "${op.query}".`
  }

  /** Code projects: approved folders, activity scans, dev servers, status files. */
  const code = new CodeService({
    handle,
    toRenderer,
    toRuntime: snapshot => host.note({ kind: 'code', snapshot }),
    window: () => null,
    requireOwner,
    log: (level, message) => log(level, message),
  })
  /** Files: chosen folders, organising with undo, Recycle Bin instead of delete. */
  const files = new FileService({ handle, toRenderer, window: () => null, requireOwner, log: (level, message) => log(level, message) })
  /** Desktop apps: the owner's chosen apps, UI Automation through a PowerShell worker, WhatsApp, "watch me". */
  const desktop = new DesktopService({ handle, toRenderer, requireOwner, log: (level, message) => log(level, message) })
  /** The desktop widget: Atlas in a small glass window outside the browser (main/widget/service.ts). */
  const widget = new WidgetService({
    dataDir,
    lib: join(host.appPath, 'resources', 'webview2'),
    url: () => host.widgetUrl(),
    handle,
    toRenderer,
    openExternal: url => host.openExternal(url),
    showAtlas: () => host.showAtlas(),
    log: (level, message) => log(level, message),
  })
  /** The Profiles tab: browser profiles and habits, read on this PC once the owner turns it on. */
  const habits = new HabitsService({
    file: join(dataDir, 'habits.json'),
    cacheDir: join(dataDir, 'habits-cache'),
    onChange: v => {
      toRenderer(HB.changed, v)
      host.note({ kind: 'habits', data: forAtlas(v) })
    },
    log: (level, message) => log(level, message),
  })

  if (allowed('code')) code.register()
  if (allowed('files')) files.register()
  if (allowed('apps')) desktop.register()
  if (allowed('widget')) widget.register()

  // Atlas's tools.
  handle(HANDS_OP.system, op => pcOp(op as SystemOp))
  handle(HANDS_OP.desktop, op => (allowed('apps') ? desktop.handleOp(op as Parameters<DesktopService['handleOp']>[0]) : off('desktop apps')))
  handle(HANDS_OP.files, op => (allowed('files') ? files.handleOp(op as Parameters<FileService['handleOp']>[0]) : off('files')))
  handle(HANDS_OP.code, (op, minutes) => {
    if (!allowed('code')) return off('code projects')
    if (minutes === 'minutes') {
      code.setMinutes(op as Record<string, number>)
      return ''
    }
    return code.handleOp(op as Parameters<CodeService['handleOp']>[0])
  })
  handle(HANDS_OP.widget, op => (allowed('widget') ? widget.handle(op as WidgetOp) : off('the desktop widget')))

  // This PC in Settings.
  handle(PCC.state, () => pcState())
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
  handle(HB.state, () => habits.state())
  handle(HB.setEnabled, on => {
    if (typeof on !== 'boolean') throw new Error('On or off.')
    return habits.setEnabled(on)
  })
  handle(HB.setProfile, (key, change) => {
    if (typeof key !== 'string' || key.length > 200) throw new Error('Which profile?')
    const c = (change ?? {}) as { role?: unknown; shared?: unknown }
    const role = c.role === null ? null : typeof c.role === 'string' && c.role in ROLE_LABEL ? (c.role as ProfileRole) : undefined
    return habits.setProfile(key, { role, shared: typeof c.shared === 'boolean' ? c.shared : undefined })
  })
  handle(HB.setWorkHours, w => {
    const hours = parseWorkHours(w)
    if (!hours) throw new Error('Working hours need a start, an end and at least one day.')
    return habits.setWorkHours(hours)
  })
  handle(HB.refresh, () => habits.refresh())

  // Read often while a page shows Atlas or a watch needs fresh readings.
  let watched = false
  let paced = false
  const pace = () => pcSystem.setActive(watched || paced)
  handle(HANDS_OP.pace, often => {
    paced = often === true
    pace()
    return ''
  })

  return {
    handlers,
    handle,
    capabilities,
    setWatched: on => {
      watched = on
      pace()
    },
    setPace: often => {
      paced = often
      pace()
    },
    resend: () => {
      const s = code.snapshotMessage()
      host.note({ kind: 'code', snapshot: { projects: s.projects, running: s.running } })
    },
    start: () => {
      if (allowed('code')) code.start()
      if (allowed('system')) {
        pcSystem.start()
        pace()
        sysmap.start()
      }
      if (allowed('widget')) widget.start()
    },
    stop: () => {
      desktop.stop()
      pcSystem.stop()
      sysmap.stop()
      widget.stop()
    },
  }
}
