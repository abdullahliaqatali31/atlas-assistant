/**
 * Contract for opt-in active-window tracking (plan 13.2): the owner's switch,
 * excluded apps and a view of what was observed. Main stores the settings;
 * the runtime host records spans in local memory and reads them back for the
 * daily briefing. No screenshots, no keystrokes, seven-day retention.
 */

export const RETENTION_DAYS = 7

export interface ActivitySettings {
  enabled: boolean
  /** Process names never recorded (e.g. "KeePassXC", "WhatsApp"); case-insensitive, ".exe" optional. */
  excludedApps: string[]
}

export interface ActivityAppView {
  app: string
  minutes: number
  /** Top window titles for this app, with minutes. */
  titles: { title: string; minutes: number }[]
}

export interface ActivityView extends ActivitySettings {
  /** Foreground sampling works on this OS (Windows). */
  available: boolean
  retentionDays: number
  /** Time per app over the requested window (default the last 24 hours); empty while off or not ready. */
  summary: { hours: number; totalMinutes: number; apps: ActivityAppView[] }
}

/** Channel names for `window.activity`. */
export const AC = {
  get: 'activity:get',
  setEnabled: 'activity:set-enabled',
  addExcluded: 'activity:add-excluded',
  removeExcluded: 'activity:remove-excluded',
  clear: 'activity:clear',
  changed: 'activity:changed',
} as const

export interface ActivityBridge {
  /** Settings plus what was observed in the last `hours` (1 to 168, default 24). */
  get(hours?: number): Promise<ActivityView>
  /** Off by default; turning it on starts recording the foreground app and window title. */
  setEnabled(enabled: boolean): Promise<ActivityView>
  addExcluded(app: string): Promise<ActivityView>
  removeExcluded(app: string): Promise<ActivityView>
  /** Deletes recorded activity: everything, or one app's records. */
  clear(app?: string): Promise<ActivityView>
  onChanged(cb: (v: ActivityView) => void): () => void
}

// ── validation (main process side) ──────────────────────────

const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+()-]{0,79}$/u

export const parseAppName = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const name = v.trim().replace(/\.exe$/i, '')
  return APP_NAME.test(name) ? name : null
}

export const parseHours = (v: unknown): number | null => {
  if (v === undefined) return 24
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= RETENTION_DAYS * 24 ? v : null
}

// ── main ⇄ runtime host messages ────────────────────────────

export type ActivityHostRequest =
  /** Sent on every (re)start and whenever the owner changes a setting. */
  | { type: 'set-activity'; settings: ActivitySettings }
  | { type: 'activity'; requestId: string; op: { kind: 'summary'; hours: number } | { kind: 'clear'; app?: string | undefined } }

export type ActivityHostEvent = {
  type: 'activity'
  requestId: string
  summary?: ActivityView['summary'] | undefined
  available?: boolean | undefined
  error?: string | undefined
}
