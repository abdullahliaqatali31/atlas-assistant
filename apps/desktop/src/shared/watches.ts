/**
 * Watches: standing rules Atlas sets up for itself when the owner asks
 * ("jab battery low ho aur charger na laga ho, har 2 minute yaad dilate
 * raho"). Each is a few conditions on what the PC reports (battery, charging,
 * internet, Wi-Fi, VPN, a Bluetooth device) and a message. While all the
 * conditions hold, the message goes out at once and again every N minutes,
 * as a notice wherever the owner is (the PC's notifications, the page, the
 * widget, Telegram), whatever the mode: it is what the owner asked for. When
 * a condition stops holding (the charger goes in), it stops by itself.
 */
import type { SystemSnapshot } from './system.ts'

export const WATCH_SIGNALS = ['battery', 'charging', 'internet', 'wifi', 'vpn', 'bluetooth'] as const
export type WatchSignal = (typeof WATCH_SIGNALS)[number]

export type WatchCondition =
  | { signal: 'battery'; below?: number | undefined; above?: number | undefined }
  | { signal: 'charging' | 'internet' | 'wifi' | 'vpn'; is: boolean }
  | { signal: 'bluetooth'; device: string; connected: boolean }

export interface Watch {
  id: string
  label: string
  when: WatchCondition[]
  /** What the notice says; {battery} becomes the battery level. */
  message: string
  /** Again every N minutes while it holds; 0: once each time it starts holding. */
  everyMin: number
  on: boolean
  created: number
}

/** A watch's moment: holding since, last notice, and a pause the owner asked for. */
export interface WatchState {
  since: number | null
  lastSent: number | null
  sent: number
  quietUntil: number | null
}

export interface WatchView extends Watch {
  state: WatchState
}

export interface WatchesView {
  watches: WatchView[]
  /** When the PC last reported (a watch needs fresh readings). */
  readingAt: number | null
}

/** A notice that went out (the page shows it as a card). */
export interface WatchNotice {
  watchId: string
  label: string
  text: string
  at: number
  /** How many times in a row (1 = the first). */
  count: number
}

export type WatchOp =
  | { kind: 'set'; label: string; when: WatchCondition[]; message: string; everyMin: number }
  | { kind: 'list' }
  | { kind: 'remove'; n?: number | undefined; all?: boolean | undefined }
  | { kind: 'pause'; n: number; minutes: number }
  /** A notice to the owner right now, wherever they are (quiet mode too). */
  | { kind: 'notify'; title: string; text: string }

export const WCH = {
  state: 'watches:state',
  changed: 'watches:changed',
  /** A notice went out. */
  fired: 'watches:fired',
  toggle: 'watches:toggle',
  remove: 'watches:remove',
  /** "Quiet for 15 min" on the card. */
  quiet: 'watches:quiet',
} as const

export interface WatchesBridge {
  state(): Promise<WatchesView>
  toggle(id: string, on: boolean): Promise<WatchesView>
  remove(id: string): Promise<WatchesView>
  quiet(id: string, minutes: number): Promise<WatchesView>
  onChanged(cb: (v: WatchesView) => void): () => void
  onFired(cb: (n: WatchNotice) => void): () => void
}

export const MAX_WATCHES = 20
const MINUTE = 60_000

/** Does this condition hold in this reading? A reading without the thing (no battery on a desktop) does not hold. */
export const holds = (c: WatchCondition, s: SystemSnapshot): boolean => {
  switch (c.signal) {
    case 'battery':
      if (!s.battery) return false
      return (c.below === undefined || s.battery.percent < c.below) && (c.above === undefined || s.battery.percent > c.above)
    case 'charging':
      return s.battery !== null && s.battery.charging === c.is
    case 'internet':
      return (s.wifi.internet === 'internet' || s.ethernet.internet === 'internet') === c.is
    case 'wifi':
      return s.wifi.connected === c.is
    case 'vpn':
      return (s.vpn !== null) === c.is
    case 'bluetooth': {
      const want = c.device.toLowerCase()
      const d = s.bluetooth.devices.find(x => x.name.toLowerCase().includes(want))
      return (d?.connected ?? false) === c.connected
    }
  }
}

export const allHold = (w: Watch, s: SystemSnapshot) => w.when.length > 0 && w.when.every(c => holds(c, s))

/** The notice's text: {battery} filled in. */
export const noticeText = (w: Watch, s: SystemSnapshot | null) => w.message.replace(/\{battery\}/g, s?.battery ? `${s.battery.percent}%` : '?').slice(0, 300)

/**
 * What to do now: send a notice (and the state after), or nothing. A reading
 * older than `staleMs` decides nothing: the PC may be asleep or away.
 */
export const step = (w: Watch, st: WatchState, s: SystemSnapshot | null, now: number, staleMs = 10 * MINUTE): { state: WatchState; send: boolean } => {
  if (!w.on || !s || now - s.at > staleMs) return { state: st, send: false }
  if (!allHold(w, s)) return { state: { ...st, since: null, sent: 0, quietUntil: null }, send: false }
  const since = st.since ?? now
  if (st.quietUntil && now < st.quietUntil) return { state: { ...st, since }, send: false }
  const due = st.lastSent === null || st.since === null || (w.everyMin > 0 && now - st.lastSent >= w.everyMin * MINUTE)
  if (!due) return { state: { ...st, since }, send: false }
  return { state: { since, lastSent: now, sent: st.since === null ? 1 : st.sent + 1, quietUntil: null }, send: true }
}

export const EMPTY_STATE: WatchState = { since: null, lastSent: null, sent: 0, quietUntil: null }

const condition = (raw: unknown): WatchCondition | string => {
  if (!raw || typeof raw !== 'object') return 'Each condition is an object with a signal.'
  const o = raw as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v) : undefined)
  switch (o.signal) {
    case 'battery': {
      const below = num(o.below)
      const above = num(o.above)
      return below === undefined && above === undefined ? 'battery needs below or above (a percent).' : { signal: 'battery', below, above }
    }
    case 'charging':
    case 'internet':
    case 'wifi':
    case 'vpn':
      return typeof o.is === 'boolean' ? { signal: o.signal, is: o.is } : `${o.signal} needs is: true or false.`
    case 'bluetooth':
      return typeof o.device === 'string' && o.device.trim() && typeof o.connected === 'boolean' ? { signal: 'bluetooth', device: o.device.trim().slice(0, 60), connected: o.connected } : 'bluetooth needs device (a name) and connected: true or false.'
  }
  return `Unknown signal: ${String(o.signal)}. Use one of ${WATCH_SIGNALS.join(', ')}.`
}

/** The watch tools' input, checked; a string is why it cannot be done. */
export const watchOpFromTool = (name: string, input: Record<string, unknown>): WatchOp | string => {
  if (name === 'watches_list') return { kind: 'list' }
  if (name === 'notify_me') {
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, 400) : ''
    if (!text) return 'Say what the notice says (text).'
    return { kind: 'notify', title: typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 80) : '', text }
  }
  if (name === 'watch_remove') {
    if (input.all === true) return { kind: 'remove', all: true }
    const n = input.number
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? { kind: 'remove', n } : 'Which watch? Its number from watches_list, or all.'
  }
  if (name === 'watch_pause') {
    const n = input.number
    const minutes = typeof input.minutes === 'number' && input.minutes > 0 && input.minutes <= 24 * 60 ? Math.round(input.minutes) : 30
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? { kind: 'pause', n, minutes } : 'Which watch? Its number from watches_list.'
  }
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 80) : ''
  if (!label) return 'Give the watch a short label ("Battery low").'
  if (!Array.isArray(input.when) || !input.when.length || input.when.length > 4) return 'when: one to four conditions.'
  const when: WatchCondition[] = []
  for (const raw of input.when) {
    const c = condition(raw)
    if (typeof c === 'string') return c
    when.push(c)
  }
  const message = typeof input.message === 'string' && input.message.trim() ? input.message.trim().slice(0, 300) : label
  const every = input.every_minutes === undefined ? 0 : input.every_minutes
  if (typeof every !== 'number' || !Number.isFinite(every) || every < 0 || every > 24 * 60) return 'every_minutes runs from 1 to 1440 (0 or left out: once each time).'
  // Below a minute would only be noise: the PC is read about every 45 seconds while a watch runs.
  const everyMin = every === 0 ? 0 : Math.max(1, Math.round(every))
  return { kind: 'set', label, when, message, everyMin }
}

const conditionText = (c: WatchCondition): string => {
  switch (c.signal) {
    case 'battery':
      return [c.below !== undefined ? `battery under ${c.below}%` : '', c.above !== undefined ? `battery over ${c.above}%` : ''].filter(Boolean).join(' and ')
    case 'charging':
      return c.is ? 'charging' : 'not charging'
    case 'internet':
      return c.is ? 'internet up' : 'no internet'
    case 'wifi':
      return c.is ? 'Wi-Fi connected' : 'Wi-Fi not connected'
    case 'vpn':
      return c.is ? 'VPN on' : 'VPN off'
    case 'bluetooth':
      return `${c.device} ${c.connected ? 'connected' : 'not connected'}`
  }
}

export const whenText = (w: Watch) => w.when.map(conditionText).join(' and ')

/** The list as Atlas reads it, numbered for watch_remove and watch_pause. */
export const describeWatches = (watches: WatchView[]): string => {
  if (!watches.length) return 'No watches are set.'
  return watches
    .map((w, i) => `${i + 1}. ${w.label}${w.on ? '' : ' (off)'}: when ${whenText(w)}, "${w.message}"${w.everyMin ? `, every ${w.everyMin} min while it holds` : ', once each time'}${w.state.since ? ' — holding now' : ''}`)
    .join('\n')
}
