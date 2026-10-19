/**
 * The PC itself, runtime side: one context line in every turn (Wi-Fi,
 * Bluetooth devices, battery, VPN), what changed in the last minutes, and
 * tools to look closer or open the right Windows Settings page. Main does the
 * reading; nothing here changes a setting.
 */
import type { Rule } from '@assistant/policy'
import type { RuntimeTool } from '@assistant/runtime'

import { OPEN_WITH, parseSheets, type OpenWith } from '../shared/pcactions.ts'
import { describeSystem, SETTINGS_PAGES, type SettingsPage, type SystemChange, type SystemOp, type SystemSnapshot } from '../shared/system.ts'

/** Changes stay in Atlas's context this long. */
const RECENT_MS = 20 * 60_000

export const SYSTEM_RULES: Rule[] = [
  { id: 'default-system_status', tool: 'system_status', actionClass: 'observe', effect: 'allow' },
  { id: 'default-system_find', tool: 'system_find', actionClass: 'observe', effect: 'allow' },
  { id: 'default-system_foreground', tool: 'system_foreground', actionClass: 'observe', effect: 'allow' },
  // Opening, starting and making things on the PC: the owner says yes each time, unless Full control is on.
  ...['open_item', 'launch_app', 'make_folder', 'make_document', 'make_sheet'].map((tool): Rule => ({ id: `default-${tool}`, tool, actionClass: 'modify', effect: 'ask' })),
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
        name: 'system_foreground',
        description: 'What is in front on the PC right now: the program and its window title, and the system-map project it shows. Use it when the owner says "this project", "this folder", "is wali file".',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        actionClass: 'observe',
        isUntrusted: true,
        run: (_i, signal) => this.deps.request({ kind: 'foreground' }, signal),
      },
      {
        name: 'open_item',
        description:
          'Open something on the PC. target: an id from system_find, a name, or a full path (a WSL folder as \\\\wsl.localhost\\<distro>\\path). with: default (its own app), explorer (File Explorer), vscode (VS Code; WSL projects open through Remote-WSL), claude (the Claude desktop app Code section, a folder), claude-code (Claude Code in a terminal), terminal (Windows Terminal there). prompt: a first message for Claude when the owner gave one.',
        inputSchema: { type: 'object', properties: { target: { type: 'string' }, with: { type: 'string', enum: [...OPEN_WITH] }, prompt: { type: 'string' } }, required: ['target'], additionalProperties: false },
        actionClass: 'modify',
        isUntrusted: false,
        run: (input, signal) => {
          const target = typeof input.target === 'string' ? input.target.trim().slice(0, 400) : ''
          if (!target) return Promise.reject(new Error('Say what to open.'))
          const w = OPEN_WITH.includes(input.with as OpenWith) ? (input.with as OpenWith) : 'default'
          return this.deps.request({ kind: 'open', target, with: w, prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 2000) : '' }, signal)
        },
      },
      {
        name: 'launch_app',
        description: 'Start an app on the PC by name or system_find id ("WhatsApp", "Spotify", "Excel"). Starting only; desktop_* tools act inside apps.',
        inputSchema: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'], additionalProperties: false },
        actionClass: 'modify',
        isUntrusted: false,
        run: (input, signal) => (typeof input.app === 'string' && input.app.trim() ? this.deps.request({ kind: 'launch', target: input.app.trim().slice(0, 120) }, signal) : Promise.reject(new Error('Which app?'))),
      },
      {
        name: 'make_folder',
        description: 'Make a folder. where: Desktop, Documents, Downloads, Pictures, OneDrive, a folder or project id from system_find, or a full path. name may be nested ("Clients/2026").',
        inputSchema: { type: 'object', properties: { where: { type: 'string' }, name: { type: 'string' } }, required: ['where', 'name'], additionalProperties: false },
        actionClass: 'modify',
        isUntrusted: false,
        run: (input, signal) => this.deps.request({ kind: 'folder', where: String(input.where ?? ''), name: String(input.name ?? '') }, signal),
      },
      {
        name: 'make_document',
        description: 'Write a Word document (.docx) for the owner. where: as make_folder. content: Markdown (# headings, paragraphs, **bold**, - bullets, 1. numbered, | tables |). Never overwrites: a name in use gets (2). open: open it when done.',
        inputSchema: { type: 'object', properties: { where: { type: 'string' }, name: { type: 'string' }, content: { type: 'string' }, open: { type: 'boolean' } }, required: ['where', 'name', 'content'], additionalProperties: false },
        actionClass: 'modify',
        isUntrusted: false,
        run: (input, signal) => {
          const markdown = typeof input.content === 'string' ? input.content.slice(0, 200_000) : ''
          if (!markdown.trim()) return Promise.reject(new Error('Write the content.'))
          return this.deps.request({ kind: 'document', where: String(input.where ?? ''), name: String(input.name ?? ''), markdown, open: input.open === true }, signal)
        },
      },
      {
        name: 'make_sheet',
        description: 'Make an Excel sheet (.xlsx). where: as make_folder. sheets: [{name, columns: [..], rows: [[..], ..], totals: true to add a total row}]. Numbers as numbers. Never overwrites. open: open it when done.',
        inputSchema: {
          type: 'object',
          properties: {
            where: { type: 'string' },
            name: { type: 'string' },
            sheets: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, columns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array' } }, totals: { type: 'boolean' } }, required: ['columns', 'rows'] } },
            open: { type: 'boolean' },
          },
          required: ['where', 'name', 'sheets'],
          additionalProperties: false,
        },
        actionClass: 'modify',
        isUntrusted: false,
        run: (input, signal) => {
          const sheets = parseSheets(input.sheets)
          if (typeof sheets === 'string') return Promise.reject(new Error(sheets))
          return this.deps.request({ kind: 'sheet', where: String(input.where ?? ''), name: String(input.name ?? ''), sheets, open: input.open === true }, signal)
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
