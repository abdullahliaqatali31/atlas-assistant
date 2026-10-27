/**
 * Atlas's hands: the part on a machine that does things there (apps, files,
 * code projects, Windows status, the widget, the tray). The brain (the model,
 * memory, reminders, the web page) may run on the same PC or on a server;
 * each machine's hands connect to it over one WebSocket that the machine
 * opens itself, so nothing on the PC has to be reachable from outside.
 *
 * Calls go both ways by id. The brain calls a channel: a page channel the
 * hands registered (Settings for files, apps, code…) or one of the op
 * channels below for Atlas's own tools. The hands send page events, what the
 * runtime should know (status, notifications, habits, code), and lock /
 * unlock from the PC.
 */

/** Where hands connect on the brain. */
export const HANDS_PATH = '/hands'
/** The protocol's version: a brain refuses hands that speak another. */
export const HANDS_VERSION = 1

/** Atlas's own tools on a machine, as channels the brain calls. */
export const HANDS_OP = {
  system: 'hands:op:system',
  desktop: 'hands:op:desktop',
  files: 'hands:op:files',
  code: 'hands:op:code',
  widget: 'hands:op:widget',
  /** Show Atlas on that machine (the page in its browser). */
  show: 'hands:op:show',
  /** A notice on that machine (tray balloon). */
  notify: 'hands:op:notify',
  /** A timer rings there. */
  alarm: 'hands:op:alarm',
  /** Read the PC often (a watch is set) or as usual. */
  pace: 'hands:op:pace',
  /** This PC's own Atlas data, to move to the brain (main/hands/move.ts). */
  export: 'hands:op:export',
} as const

/** What a machine can do; the owner may switch any of these off on the machine itself. */
export const CAPABILITIES = ['system', 'apps', 'files', 'code', 'widget', 'notices'] as const
export type Capability = (typeof CAPABILITIES)[number]

export const CAPABILITY_LABEL: Record<Capability, string> = {
  system: 'PC status, search and opening things',
  apps: 'Desktop apps (UI Automation, WhatsApp, watch me)',
  files: 'Files in the folders you chose',
  code: 'Code projects and dev servers',
  widget: 'The desktop widget',
  notices: 'Notices, alarms and lock / unlock',
}

/** Which capability an op channel needs. */
export const OP_CAPABILITY: Partial<Record<string, Capability>> = {
  [HANDS_OP.system]: 'system',
  [HANDS_OP.desktop]: 'apps',
  [HANDS_OP.files]: 'files',
  [HANDS_OP.code]: 'code',
  [HANDS_OP.widget]: 'widget',
  [HANDS_OP.notify]: 'notices',
  [HANDS_OP.alarm]: 'notices',
}

/** The page's channels for a machine's own settings (This PC, profiles, the widget, code, files, apps): they go to the machine Atlas works on. */
export const HANDS_CHANNEL = /^(pc|habits|widget|code|files|desktop):/

export type HandsPlatform = 'windows' | 'mac' | 'linux'

export const platformOf = (p: NodeJS.Platform = process.platform): HandsPlatform => (p === 'win32' ? 'windows' : p === 'darwin' ? 'mac' : 'linux')

/** What the runtime should know from the machine Atlas works on. */
export type RuntimeNote =
  | { kind: 'system'; snapshot: unknown; changes: unknown }
  | { kind: 'notifications'; items: unknown; fresh: boolean }
  | { kind: 'habits'; data: unknown }
  | { kind: 'code'; snapshot: unknown }

/** Machine → brain. */
export type HandsMessage =
  | { t: 'hello'; v: number; name: string; platform: HandsPlatform; version: string; capabilities: Capability[]; channels: string[] }
  | { t: 'ret'; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: 'ev'; ch: string; v: unknown }
  | { t: 'rt'; note: RuntimeNote }
  /** lock, unlock, suspend, resume, shutdown, idle <s> (as the tray helper says them), and quit (Atlas's hands closing on purpose). */
  | { t: 'session'; line: string }
  /** The machine asks the brain for something (a pairing ticket for its widget). */
  | { t: 'ask'; id: number; what: 'ticket'; path: string }

/** Brain → machine. */
export type BrainMessage =
  | { t: 'welcome'; machineId: string; brain: string; active: boolean }
  | { t: 'call'; id: number; ch: string; args: unknown[] }
  | { t: 'ret'; id: number; ok: boolean; value?: unknown; error?: string }
  /** The owner check on the brain: while locked, the machine refuses owner-only work too. */
  | { t: 'owner'; locked: boolean }
  /** This machine is (or is no longer) the one Atlas works on. */
  | { t: 'active'; on: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A machine's message, checked; null when it is not one. */
export const parseHandsMessage = (raw: unknown): HandsMessage | null => {
  if (!isObj(raw) || typeof raw.t !== 'string') return null
  switch (raw.t) {
    case 'hello':
      if (typeof raw.name !== 'string' || typeof raw.v !== 'number' || !Array.isArray(raw.channels) || !Array.isArray(raw.capabilities)) return null
      return {
        t: 'hello',
        v: raw.v,
        name: raw.name.slice(0, 60),
        platform: raw.platform === 'mac' || raw.platform === 'linux' ? raw.platform : 'windows',
        version: typeof raw.version === 'string' ? raw.version.slice(0, 30) : '',
        capabilities: raw.capabilities.filter((c): c is Capability => (CAPABILITIES as readonly unknown[]).includes(c)),
        channels: raw.channels.filter((c): c is string => typeof c === 'string' && c.length < 100).slice(0, 500),
      }
    case 'ret':
      return typeof raw.id === 'number' && typeof raw.ok === 'boolean' ? { t: 'ret', id: raw.id, ok: raw.ok, value: raw.value, error: typeof raw.error === 'string' ? raw.error : undefined } : null
    case 'ev':
      return typeof raw.ch === 'string' ? { t: 'ev', ch: raw.ch, v: raw.v } : null
    case 'rt': {
      const n = raw.note
      if (!isObj(n)) return null
      if (n.kind === 'system') return { t: 'rt', note: { kind: 'system', snapshot: n.snapshot, changes: n.changes } }
      if (n.kind === 'notifications') return { t: 'rt', note: { kind: 'notifications', items: n.items, fresh: n.fresh === true } }
      if (n.kind === 'habits') return { t: 'rt', note: { kind: 'habits', data: n.data } }
      if (n.kind === 'code') return { t: 'rt', note: { kind: 'code', snapshot: n.snapshot } }
      return null
    }
    case 'session':
      return typeof raw.line === 'string' && /^(lock|unlock|suspend|resume|shutdown|quit|idle \d{1,7})$/.test(raw.line) ? { t: 'session', line: raw.line } : null
    case 'ask':
      return typeof raw.id === 'number' && raw.what === 'ticket' && typeof raw.path === 'string' && /^\/[\w./-]{0,60}$/.test(raw.path) ? { t: 'ask', id: raw.id, what: 'ticket', path: raw.path } : null
  }
  return null
}

/** One pairing code for a machine: letters and digits people can read out (no 0/O, 1/I/L). */
export const MACHINE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const MACHINE_CODE_TTL_MS = 15 * 60_000
export const normalizeMachineCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * How a machine is, as far as the brain can tell: awake and used, idle (no
 * input for a while), locked, asleep, shut down, Atlas's hands closed on
 * purpose, or gone quiet with no word (lost network, crashed, power cut).
 */
export type PresenceState = 'awake' | 'idle' | 'locked' | 'asleep' | 'off' | 'closed' | 'lost'

export interface Presence {
  state: PresenceState
  since: number
}

export interface PresenceEvent {
  at: number
  state: PresenceState
}

/** No input for this long: idle. */
export const IDLE_AFTER_S = 5 * 60

export const PRESENCE_TEXT: Record<PresenceState, string> = {
  awake: 'on and in use',
  idle: 'on, nobody at it',
  locked: 'locked',
  asleep: 'asleep',
  off: 'shut down',
  closed: "on, but Atlas's hands were closed there",
  lost: 'out of reach (no word: network down, crashed or power cut)',
}

/** The next state from what the machine said (null: no change). */
export const nextPresence = (now: PresenceState, line: string): PresenceState | null => {
  if (line === 'suspend') return 'asleep'
  if (line === 'shutdown') return 'off'
  if (line === 'quit') return 'closed'
  if (line === 'lock') return 'locked'
  if (line === 'unlock' || line === 'resume') return 'awake'
  if (line.startsWith('idle ')) {
    if (now === 'locked') return null
    const s = Number(line.slice(5))
    if (s >= IDLE_AFTER_S) return now === 'idle' ? null : 'idle'
    return now === 'awake' ? null : 'awake'
  }
  return null
}

const span = (ms: number) => {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min`
  if (m < 48 * 60) return `${Math.floor(m / 60)} h ${m % 60} min`
  return `${Math.round(m / 1440)} days`
}
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** One line for Atlas about every machine: how each is, since when, and which one it works on. */
export const describeMachines = (machines: MachineView[], now: number): string =>
  machines
    .map(m => {
      const p = m.presence
      const how = p ? `${PRESENCE_TEXT[p.state]}${p.state === 'awake' ? '' : ` since ${clock(p.since)} (${span(now - p.since)})`}` : m.online ? 'connected' : 'not connected'
      return `${m.name}${m.local ? ' (where you run)' : ''}${m.active ? ' [you work on this one]' : ''}: ${how}`
    })
    .join('; ')

/** Settings › Machines. */
export interface MachineView {
  id: string
  name: string
  platform: HandsPlatform
  /** This PC, where the brain itself runs (no pairing needed). */
  local: boolean
  online: boolean
  /** The machine Atlas works on now. */
  active: boolean
  capabilities: Capability[]
  version: string
  created: number
  lastSeen: number
  presence: Presence | null
  /** The last changes, newest first. */
  history: PresenceEvent[]
}

export interface MachinesView {
  machines: MachineView[]
  /** A code to pair a new machine, while one is open. */
  code: string | null
  codeExpiresAt: number | null
  /** The address machines should use to reach this brain (as the page sees it). */
  brainUrl: string | null
}

export const MCH = {
  state: 'machines:state',
  changed: 'machines:changed',
  newCode: 'machines:new-code',
  setActive: 'machines:set-active',
  rename: 'machines:rename',
  revoke: 'machines:revoke',
  /** Bring a connected PC's Atlas data (memory, settings, optionally keys) to this brain. */
  importFrom: 'machines:import',
} as const

export interface MachinesBridge {
  state(): Promise<MachinesView>
  newCode(): Promise<MachinesView>
  setActive(id: string): Promise<MachinesView>
  rename(id: string, name: string): Promise<MachinesView>
  revoke(id: string): Promise<MachinesView>
  /** Copies that PC's Atlas data here (keys only when asked); Atlas restarts with it. */
  importFrom(id: string, keys: boolean): Promise<{ from: string; files: number; keys: number }>
  onChanged(cb: (v: MachinesView) => void): () => void
}
