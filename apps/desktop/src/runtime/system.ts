/**
 * The PC itself, runtime side: one context line in every turn (Wi-Fi,
 * Bluetooth devices, battery, VPN), what changed in the last minutes, and
 * tools to look closer or open the right Windows Settings page. Main does the
 * reading; nothing here changes a setting.
 */
import type { Rule } from '@assistant/policy'
import type { RuntimeTool } from '@assistant/runtime'

import { describeSystem, SETTINGS_PAGES, type SettingsPage, type SystemChange, type SystemOp, type SystemSnapshot } from '../shared/system.ts'

/** Changes stay in Atlas's context this long. */
const RECENT_MS = 20 * 60_000

export const SYSTEM_RULES: Rule[] = [
  { id: 'default-system_status', tool: 'system_status', actionClass: 'observe', effect: 'allow' },
  { id: 'default-system_find', tool: 'system_find', actionClass: 'observe', effect: 'allow' },
  // Opening a Settings page changes nothing by itself.
  { id: 'default-system_settings', tool: 'system_settings', actionClass: 'modify', effect: 'allow' },
]

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 1 ? 'just now' : `${m} min ago`
}

export class HostSystem {
  private snapshot: SystemSnapshot | null = null
  private changes: SystemChange[] = []

  constructor(private readonly deps: { request: (op: SystemOp, signal?: AbortSignal) => Promise<string>; now: () => number }) {}

  setSnapshot(s: SystemSnapshot, changes: SystemChange[]) {
    this.snapshot = s
    this.changes = [...this.changes, ...changes].filter(c => this.deps.now() - c.at < RECENT_MS).slice(-12)
  }

  contextLines(): string[] {
    if (!this.snapshot) return []
    const now = this.deps.now()
    const recent = this.changes.filter(c => now - c.at < RECENT_MS)
    return [
      `This PC: ${describeSystem(this.snapshot)}.${this.snapshot.wifi.locationBlocked ? ' (Wi-Fi signal is hidden: Windows location services are off; system_settings page location turns them on.)' : ''}`,
      ...(recent.length ? [`PC changes: ${recent.map(c => `${c.text} (${ago(now - c.at)})`).join('; ')}.`] : []),
    ]
  }

  tools(): RuntimeTool[] {
    return [
      {
        name: 'system_status',
        description:
          'Read the PC right now: Wi-Fi (network, internet, signal when allowed), wired network, VPN, Bluetooth (on or off, every paired device and which are connected: headphones, mouse, phone…), battery and charging, airplane mode. Use it when the owner asks what is connected, which Wi-Fi, whether the headphones are on, how much battery is left.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        actionClass: 'observe',
        isUntrusted: false,
        run: async (_i, signal) => {
          await this.deps.request({ kind: 'status' }, signal)
          const s = this.snapshot
          if (!s) return 'The PC status is not available right now.'
          const paired = s.bluetooth.devices.filter(d => !d.connected).map(d => `${d.name} (${d.kind})`)
          return [
            describeSystem(s),
            paired.length ? `Paired but not connected: ${paired.slice(0, 15).join(', ')}${paired.length > 15 ? '…' : ''}.` : '',
            s.wifi.locationBlocked ? 'Wi-Fi signal strength needs Windows location services on (Settings › Privacy › Location).' : '',
          ]
            .filter(Boolean)
            .join('\n')
        },
      },
      {
        name: 'system_find',
        description:
          'Find where something is on this PC in the system map: apps (Start menu), code projects (Windows and WSL, from VS Code, Cursor, Claude Code and git folders), and the owner’s folders. Say it as the owner did ("WSL project atlas", "WhatsApp", "invoices folder"); kind narrows it. Returns ids to open with open_item. Names and paths only.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string', enum: ['app', 'project', 'folder'] } }, required: ['query'], additionalProperties: false },
        actionClass: 'observe',
        isUntrusted: false,
        run: (input, signal) => {
          const query = typeof input.query === 'string' ? input.query.trim().slice(0, 120) : ''
          if (!query) return Promise.reject(new Error('Say what to find.'))
          const kind = input.kind === 'app' || input.kind === 'project' || input.kind === 'folder' ? input.kind : null
          return this.deps.request({ kind: 'find', query, mapKind: kind }, signal)
        },
      },
      {
        name: 'system_settings',
        description: 'Open a Windows Settings page for the owner when they want to change something themselves: bluetooth (pair or connect a device), wifi, network, location, sound, display, battery, vpn, airplane.',
        inputSchema: { type: 'object', properties: { page: { type: 'string', enum: Object.keys(SETTINGS_PAGES) } }, required: ['page'], additionalProperties: false },
        actionClass: 'modify',
        isUntrusted: false,
        run: (input, signal) => {
          if (typeof input.page !== 'string' || !(input.page in SETTINGS_PAGES)) return Promise.reject(new Error(`page must be one of ${Object.keys(SETTINGS_PAGES).join(', ')}.`))
          return this.deps.request({ kind: 'settings', page: input.page as SettingsPage }, signal)
        },
      },
    ]
  }
}
