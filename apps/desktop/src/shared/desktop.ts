/**
 * Desktop apps: which apps Atlas may open, read or control, the apps it never
 * touches, which on-screen actions need the owner's yes, and the "watch me"
 * recorder for teaching tasks by showing them.
 */

/** "open": launch only. "read": also read what is on screen. "control": also click, type and press keys. */
export const APP_ACCESS = ['open', 'read', 'control'] as const
export type AppAccess = (typeof APP_ACCESS)[number]

export interface DesktopAppView {
  id: string
  name: string
  /** Start menu id Windows launches it with (shell:AppsFolder\<appId>). */
  appId: string
  access: AppAccess
  /** Program files seen running for this app, learned when Atlas opens it or the owner adds a running window. */
  exes: string[]
  addedAt: number
}

export interface InstalledApp {
  name: string
  appId: string
  /** Never controllable: security, terminals, password managers, browsers (the browser connector handles those). */
  blocked: string | null
}

export interface RecordedStep {
  kind: 'click' | 'type' | 'key' | 'password'
  /** App name (from the chosen apps) or program file name. */
  app: string
  role?: string | undefined
  name?: string | undefined
  text?: string | undefined
  keys?: string | undefined
}

export interface DesktopState {
  apps: DesktopAppView[]
  /** The worker that talks to Windows is up. */
  ready: boolean
  error: string | null
  recording: boolean
}

/** Requests from the model's tools; main checks every one against the chosen apps. */
export type DesktopOp =
  | { kind: 'apps' }
  | { kind: 'open'; app: string }
  | { kind: 'read'; app: string; maxNodes?: number | undefined }
  | { kind: 'find'; app: string; name?: string | undefined; role?: string | undefined }
  | { kind: 'act'; app: string; ref: string; label: string; action: ActAction; text?: string | undefined }
  | { kind: 'keys'; app: string; keys: string }
  | { kind: 'wa-chats'; filter: 'all' | 'unread' }
  | { kind: 'wa-read'; chat: string; count?: number | undefined }
  | { kind: 'wa-send'; chat: string; text: string }

export const ACT_ACTIONS = ['click', 'type', 'replace', 'select', 'toggle', 'expand', 'collapse', 'focus'] as const
export type ActAction = (typeof ACT_ACTIONS)[number]

export const DC = {
  state: 'desktop:state',
  installed: 'desktop:installed',
  add: 'desktop:add',
  remove: 'desktop:remove',
  setAccess: 'desktop:set-access',
  recordStart: 'desktop:record-start',
  recordStop: 'desktop:record-stop',
  changed: 'desktop:changed',
} as const

export interface DesktopBridge {
  state(): Promise<DesktopState>
  installed(): Promise<InstalledApp[]>
  add(app: { name: string; appId: string }): Promise<DesktopState>
  remove(id: string): Promise<DesktopState>
  setAccess(id: string, access: AppAccess): Promise<DesktopState>
  /** Starts watching clicks and typing in the chosen apps. */
  recordStart(): Promise<DesktopState>
  /** Stops and returns the steps, ready to teach as a task. */
  recordStop(): Promise<RecordedStep[]>
  onChanged(cb: (s: DesktopState) => void): () => void
}

export const isAppAccess = (v: unknown): v is AppAccess => (APP_ACCESS as readonly unknown[]).includes(v)
export const isActAction = (v: unknown): v is ActAction => (ACT_ACTIONS as readonly unknown[]).includes(v)

/**
 * Programs Atlas never reads or controls, whatever the owner's list says:
 * Atlas itself, terminals and system tools (arbitrary commands), Windows
 * security and sign-in, password managers, and browsers (the browser
 * connector does web work with its own permissions).
 */
const BLOCKED: [RegExp, string][] = [
  [/\\(cmd|powershell|pwsh|windowsterminal|wt|conhost|openconsole|bash|wsl|mintty)\.exe$/i, 'a terminal'],
  [/\\(regedit|mmc|taskmgr|systemsettings|control|msconfig|gpedit|secpol|eventvwr|diskmgmt|compmgmt|perfmon|resmon)\.exe$/i, 'a system tool'],
  [/\\(sechealthui|securityhealthsystray|consent|credentialuibroker|logonui|lockapp|useraccountcontrolsettings)\.exe$/i, 'Windows security or sign-in'],
  [/\\(1password|bitwarden|keepass|keepassxc|lastpass|dashlane|nordpass|roboform|enpass|proton ?pass)[^\\]*\.exe$/i, 'a password manager'],
  [/\\(chrome|msedge|firefox|brave|opera|vivaldi|comet|arc|iexplore|thorium|librewolf|waterfox)\.exe$/i, 'a browser (use the browser connector)'],
  [/\\(personal assistant|electron)\.exe$/i, 'Atlas itself'],
]

export const blockedReason = (exePath: string): string | null => {
  for (const [re, why] of BLOCKED) if (re.test(exePath)) return why
  return null
}

/** Start-menu entries that map to blocked programs, by name, so they are greyed out in the picker. */
export const blockedApp = (name: string, appId: string): string | null => {
  const n = `${name} ${appId}`.toLowerCase()
  if (/\b(chrome|chromium|edge|firefox|brave|opera|vivaldi|comet|arc|thorium|librewolf|waterfox)\b/.test(name.toLowerCase()) && !/\bweb\b(?! browser)/.test(name.toLowerCase())) return 'a browser (use the browser connector)'
  if (/command prompt|powershell|windows terminal|\bterminal\b|\bwsl\b|ubuntu|git bash/.test(n)) return 'a terminal'
  if (/registry editor|task manager|\bsettings\b|control panel|system configuration|computer management|event viewer|group policy/.test(n)) return 'a system tool'
  if (/windows security|defender/.test(n)) return 'Windows security'
  if (/1password|bitwarden|keepass|lastpass|dashlane|nordpass|roboform|enpass|proton pass/.test(n)) return 'a password manager'
  if (/\b(chrome|edge|firefox|brave|opera|vivaldi|comet|arc|thorium|librewolf|waterfox)\b/.test(n) && !/\bweb\b/.test(n)) return 'a browser (use the browser connector)'
  if (/personal assistant|atlas/.test(n)) return 'Atlas itself'
  return null
}

/** Buttons and menu items whose effect leaves the computer or cannot be taken back: the owner says yes each time. */
const RISKY = /\b(send|delete|remove|discard|erase|clear (all|chat|history)|pay|buy|purchase|order|checkout|transfer|withdraw|submit|confirm|approve|accept|post|publish|share|forward|reply all|uninstall|format|reset|sign out|log ?out|block|report|exit group|leave|call|video call|voice call|empty)\b/i

/** Apps where Enter sends a message. */
const MESSAGING = /whatsapp|telegram|signal|teams|slack|discord|messenger|skype|outlook|mail|thunderbird|viber|line\b|wechat|zoom/i

export const isRiskyLabel = (label: string) => RISKY.test(label)
export const isMessagingApp = (app: string) => MESSAGING.test(app)

/**
 * The policy scope of an on-screen action: "risky" makes the owner confirm it
 * (a Send or Delete button, Enter in a chat app, typing that submits).
 */
export const actionScope = (op: { kind: 'act' | 'keys'; app: string; label?: string; action?: string; keys?: string }): 'risky' | 'normal' => {
  if (op.kind === 'act') return op.action === 'click' || op.action === 'select' || op.action === 'toggle' ? (isRiskyLabel(op.label ?? '') ? 'risky' : 'normal') : 'normal'
  const keys = (op.keys ?? '').toLowerCase()
  if (/\b(delete|del)\b/.test(keys) && /shift/.test(keys)) return 'risky'
  // Select-all followed by delete, backspace or more keys can wipe a document the app reopened.
  if (/ctrl\+a\b/.test(keys) && (/\b(delete|del|backspace)\b/.test(keys) || /ctrl\+a\s+(?!ctrl\+c\b)\S/.test(keys))) return 'risky'
  if (/\b(enter|return)\b/.test(keys) && isMessagingApp(op.app)) return 'risky'
  if (/\balt\+f4\b/.test(keys)) return 'risky'
  return 'normal'
}

/** Store app ids look like "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App": the package name and publisher hash appear in the running program's path. */
export const appMatchesExe = (app: Pick<DesktopAppView, 'appId' | 'exes'>, exePath: string): boolean => {
  const exe = exePath.toLowerCase()
  if (!exe) return false
  if (app.exes.some(e => e.toLowerCase() === exe)) return true
  const store = /^([^_!\\]+)_([a-z0-9]{13})!/i.exec(app.appId)
  if (store) return exe.includes(`\\windowsapps\\${store[1]!.toLowerCase()}_`) && exe.includes(`__${store[2]!.toLowerCase()}\\`)
  if (/\.exe$/i.test(app.appId)) {
    const base = app.appId.split(/[\\/]/).pop()!.toLowerCase()
    return exe.endsWith(`\\${base}`)
  }
  return false
}
