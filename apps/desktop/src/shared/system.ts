import type { OpenWith, SheetSpec } from './pcactions.ts'
import type { MapKind } from './sysmap.ts'

/**
 * What Atlas knows about the PC itself: Wi-Fi, Bluetooth, battery, VPN.
 * Main reads it (a PowerShell probe, read-only) and the runtime turns it
 * into one context line, a tool, and change notices ("headphones connected").
 * Nothing here changes a setting.
 */

export type DeviceKind = 'headphones' | 'speaker' | 'mouse' | 'keyboard' | 'controller' | 'phone' | 'watch' | 'computer' | 'other'

export interface BtDevice {
  name: string
  kind: DeviceKind
  connected: boolean
}

export interface SystemSnapshot {
  at: number
  wifi: {
    /** The Wi-Fi radio is on. */
    on: boolean
    connected: boolean
    /** The network's name, as Windows shows it. */
    name: string | null
    internet: 'internet' | 'local' | 'none'
    /** Only when Windows location services allow Atlas to read it. */
    signal: number | null
    band: string | null
    /** Signal and band are hidden because location services are off. */
    locationBlocked: boolean
  }
  /** A wired network is up. */
  ethernet: { connected: boolean; name: string | null; internet: 'internet' | 'local' | 'none' }
  bluetooth: { on: boolean; devices: BtDevice[] }
  battery: { percent: number; charging: boolean } | null
  vpn: string | null
  /** Every radio is off. */
  airplane: boolean
}

export interface SystemChange {
  at: number
  kind: 'bluetooth' | 'wifi' | 'internet' | 'battery' | 'power' | 'vpn'
  text: string
}

/** Raw probe output (main/system/probe.ps1). */
interface RawProbe {
  radios?: { kind?: string; on?: boolean }[]
  bluetooth?: { name?: string; connected?: boolean; kind?: string; minor?: string; le?: boolean }[]
  network?: {
    profiles?: { name?: string; alias?: string; ipv4?: string; ipv6?: string }[]
    adapters?: { name?: string; description?: string; media?: string; physical?: boolean }[]
    wlan?: string
    wlanOk?: boolean
  }
  battery?: { percent?: number; status?: number } | null
}

const list = <T>(v: T[] | T | undefined | null): T[] => (Array.isArray(v) ? v : v ? [v] : [])

/** Classic Bluetooth major class, or a BLE appearance category number, as people say it. */
export const deviceKind = (kind: string, minor = '', name = ''): DeviceKind => {
  const n = name.toLowerCase()
  if (kind === 'AudioVideo') return /speaker|soundbar|boom|jbl flip|charge/.test(n) || /Loudspeaker/i.test(minor) ? 'speaker' : 'headphones'
  if (kind === 'Phone' || kind === '1') return 'phone'
  if (kind === 'Computer' || kind === '2') return 'computer'
  if (kind === 'Wearable' || kind === '3') return 'watch'
  if (kind === 'Peripheral' || kind === '15') return /keyboard|keys/.test(n) || /Keyboard/i.test(minor) ? 'keyboard' : /pad|controller|xbox|dualsense/.test(n) ? 'controller' : 'mouse'
  if (/buds|pods|headphone|headset|earbud|wh-|wf-/.test(n)) return 'headphones'
  return 'other'
}

const connectivity = (v: string | undefined): 'internet' | 'local' | 'none' => (v === 'Internet' ? 'internet' : v === 'LocalNetwork' || v === 'Subnet' ? 'local' : 'none')

/**
 * netsh's lines, read by the shape of their values rather than their
 * (translated) labels: the SSID label stays "SSID" in every language.
 */
export const parseWlan = (text: string): { ssid: string | null; signal: number | null; band: string | null } => {
  let ssid: string | null = null
  let signal: number | null = null
  let band: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^:]+?)\s+:\s(.*)$/.exec(line)
    if (!m) continue
    const [, key, value] = m as unknown as [string, string, string]
    const v = value.trim()
    if (/^SSID$/i.test(key.trim()) && ssid === null) ssid = v || null
    else if (/^\d{1,3}\s?%$/.test(v) && signal === null) signal = Number.parseInt(v, 10)
    else if (/^\d(\.\d)?\s?GHz$/i.test(v) && band === null) band = v.replace(/\s/g, ' ')
  }
  return { ssid, signal, band }
}

const VPN = /wireguard|wintun|tap-windows|\btun\b|openvpn|vpn|nordlynx|proton|cloudflare warp|tailscale|zerotier/i

export const interpretProbe = (raw: unknown, at: number): SystemSnapshot => {
  const r = (raw ?? {}) as RawProbe
  const radios = list(r.radios)
  const radio = (kind: string) => radios.find(x => x.kind === kind)
  const profiles = list(r.network?.profiles)
  const adapters = list(r.network?.adapters)
  const wifiProfile = profiles.find(p => /wi-?fi|wlan|wireless/i.test(p.alias ?? ''))
  const ethProfile = profiles.find(p => /ethernet|\blan\b/i.test(p.alias ?? ''))
  const wlan = r.network?.wlanOk && r.network.wlan ? parseWlan(r.network.wlan) : null
  const locationBlocked = Boolean(r.network?.wlan && !r.network.wlanOk && /privacy-location|location|error 5/i.test(r.network.wlan))
  const vpn = adapters.find(a => !a.physical && VPN.test(`${a.description} ${a.name}`))
  const devices = list(r.bluetooth)
    .filter(d => d.name)
    .map(d => ({ name: String(d.name).trim().slice(0, 60), kind: deviceKind(String(d.kind ?? ''), String(d.minor ?? ''), String(d.name)), connected: d.connected === true }))
  // A device paired both ways (classic and low energy) shows once, connected if either says so.
  const byName = new Map<string, BtDevice>()
  for (const d of devices) {
    const prev = byName.get(d.name)
    byName.set(d.name, prev ? { ...prev, connected: prev.connected || d.connected, kind: prev.kind === 'other' ? d.kind : prev.kind } : d)
  }
  const battery = r.battery && typeof r.battery.percent === 'number' ? { percent: Math.max(0, Math.min(100, r.battery.percent)), charging: r.battery.status !== 1 && r.battery.status !== 4 && r.battery.status !== 5 } : null
  return {
    at,
    wifi: {
      on: radio('WiFi')?.on ?? Boolean(wifiProfile),
      connected: Boolean(wifiProfile),
      name: wlan?.ssid ?? wifiProfile?.name ?? null,
      internet: connectivity(wifiProfile?.ipv4 === 'Internet' || wifiProfile?.ipv6 === 'Internet' ? 'Internet' : wifiProfile?.ipv4),
      signal: wlan?.signal ?? null,
      band: wlan?.band ?? null,
      locationBlocked,
    },
    ethernet: { connected: Boolean(ethProfile), name: ethProfile?.name ?? null, internet: connectivity(ethProfile?.ipv4) },
    bluetooth: { on: radio('Bluetooth')?.on ?? false, devices: [...byName.values()] },
    battery,
    vpn: vpn ? String(vpn.description ?? vpn.name ?? 'VPN').slice(0, 60) : null,
    airplane: radios.length > 0 && radios.every(x => !x.on),
  }
}

const KIND_LABEL: Record<DeviceKind, string> = { headphones: 'headphones', speaker: 'speaker', mouse: 'mouse', keyboard: 'keyboard', controller: 'controller', phone: 'phone', watch: 'watch', computer: 'computer', other: 'device' }

/** What changed between two readings, in the words Atlas would use. */
export const diffSnapshots = (prev: SystemSnapshot | null, next: SystemSnapshot): SystemChange[] => {
  if (!prev) return []
  const at = next.at
  const out: SystemChange[] = []
  const was = new Map(prev.bluetooth.devices.map(d => [d.name, d.connected]))
  for (const d of next.bluetooth.devices) {
    const before = was.get(d.name) ?? false
    if (d.connected && !before) out.push({ at, kind: 'bluetooth', text: `${d.name} (${KIND_LABEL[d.kind]}) connected` })
    if (!d.connected && before) out.push({ at, kind: 'bluetooth', text: `${d.name} (${KIND_LABEL[d.kind]}) disconnected` })
  }
  if (prev.bluetooth.on !== next.bluetooth.on) out.push({ at, kind: 'bluetooth', text: `Bluetooth turned ${next.bluetooth.on ? 'on' : 'off'}` })
  if (prev.wifi.connected && next.wifi.connected && prev.wifi.name !== next.wifi.name) out.push({ at, kind: 'wifi', text: `Wi-Fi switched to ${next.wifi.name ?? 'another network'}` })
  else if (!prev.wifi.connected && next.wifi.connected) out.push({ at, kind: 'wifi', text: `Wi-Fi connected to ${next.wifi.name ?? 'a network'}` })
  else if (prev.wifi.connected && !next.wifi.connected) out.push({ at, kind: 'wifi', text: `Wi-Fi disconnected${next.wifi.on ? '' : ' (Wi-Fi is off)'}` })
  const online = (s: SystemSnapshot) => s.wifi.internet === 'internet' || s.ethernet.internet === 'internet'
  if (online(prev) && !online(next)) out.push({ at, kind: 'internet', text: 'Internet lost' })
  if (!online(prev) && online(next)) out.push({ at, kind: 'internet', text: 'Internet is back' })
  if (prev.battery && next.battery) {
    if (prev.battery.charging !== next.battery.charging) out.push({ at, kind: 'power', text: next.battery.charging ? `Charger plugged in (${next.battery.percent}%)` : `On battery now (${next.battery.percent}%)` })
    for (const level of [20, 10]) if (!next.battery.charging && prev.battery.percent > level && next.battery.percent <= level) out.push({ at, kind: 'battery', text: `Battery at ${next.battery.percent}%` })
  }
  if (prev.vpn !== next.vpn) out.push({ at, kind: 'vpn', text: next.vpn ? `VPN on (${next.vpn})` : 'VPN off' })
  return out
}

/** One line for every turn: what the PC is connected to right now. */
export const describeSystem = (s: SystemSnapshot): string => {
  const parts: string[] = []
  if (s.airplane) parts.push('airplane mode (all radios off)')
  else if (s.wifi.connected) {
    const extra = [s.wifi.signal !== null ? `${s.wifi.signal}% signal` : '', s.wifi.band ?? ''].filter(Boolean).join(', ')
    parts.push(`Wi-Fi: ${s.wifi.name ?? 'connected'}${extra ? ` (${extra})` : ''}${s.wifi.internet === 'internet' ? '' : s.wifi.internet === 'local' ? ', no internet' : ', not connected yet'}`)
  } else parts.push(s.wifi.on ? 'Wi-Fi on, not connected' : 'Wi-Fi off')
  if (s.ethernet.connected) parts.push(`wired network${s.ethernet.internet === 'internet' ? '' : ' (no internet)'}`)
  if (s.vpn) parts.push(`VPN: ${s.vpn}`)
  const on = s.bluetooth.devices.filter(d => d.connected)
  parts.push(!s.bluetooth.on ? 'Bluetooth off' : on.length ? `Bluetooth: ${on.map(d => `${d.name} (${KIND_LABEL[d.kind]})`).join(', ')} connected` : 'Bluetooth on, nothing connected')
  if (s.battery) parts.push(`battery ${s.battery.percent}%${s.battery.charging ? ', charging' : ''}`)
  return parts.join(' · ')
}

/** Windows Settings pages Atlas may open for the owner. */
export const SETTINGS_PAGES = {
  bluetooth: 'ms-settings:bluetooth',
  wifi: 'ms-settings:network-wifi',
  network: 'ms-settings:network-status',
  location: 'ms-settings:privacy-location',
  sound: 'ms-settings:sound',
  display: 'ms-settings:display',
  battery: 'ms-settings:batterysaver',
  vpn: 'ms-settings:network-vpn',
  airplane: 'ms-settings:network-airplanemode',
} as const
export type SettingsPage = keyof typeof SETTINGS_PAGES

/** PC actions the runtime asks main for (grows with the system map and Full control). */
export type SystemOp =
  | { kind: 'status' }
  | { kind: 'settings'; page: SettingsPage }
  | { kind: 'find'; query: string; mapKind: MapKind | null }
  /** Open a map entry or a path: in its app, Explorer, VS Code, the Claude app, Claude Code or a terminal. */
  | { kind: 'open'; target: string; with: OpenWith; prompt: string }
  /** Start an app from the map (by id or name). */
  | { kind: 'launch'; target: string }
  /** The window in front, and the project it shows. */
  | { kind: 'foreground' }
  | { kind: 'folder'; where: string; name: string }
  | { kind: 'document'; where: string; name: string; markdown: string; open: boolean }
  | { kind: 'sheet'; where: string; name: string; sheets: SheetSpec[]; open: boolean }

/** The This PC tab: live status, the system map's state. */
export interface PcState {
  status: SystemSnapshot | null
  changes: SystemChange[]
  map: { enabled: boolean; building: boolean; builtAt: number | null; counts: { apps: number; projects: number; folders: number }; excluded: string[] }
}

export const PCC = {
  state: 'pc:state',
  changed: 'pc:changed',
  setMap: 'pc:set-map',
  rebuild: 'pc:rebuild',
  addExcluded: 'pc:add-excluded',
  removeExcluded: 'pc:remove-excluded',
} as const

export interface PcBridge {
  state(): Promise<PcState>
  onChanged(cb: (s: PcState) => void): () => void
  setMap(enabled: boolean): Promise<PcState>
  rebuild(): Promise<PcState>
  /** Pick a folder the map must never index. */
  addExcluded(): Promise<PcState>
  removeExcluded(path: string): Promise<PcState>
}
