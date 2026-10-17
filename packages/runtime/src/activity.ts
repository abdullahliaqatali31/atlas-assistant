/**
 * Opt-in active-window tracking (plan 13.2, ActivityWatch-style). A
 * platform sampler reports the foreground application and window title when
 * they change; this tracker turns that into time spans in local memory.
 *
 * Privacy rules enforced here, not in the sampler: off until the owner opts
 * in; excluded applications and private-browsing windows are never stored
 * (not even their title); recording pauses while the owner is away or the PC
 * is locked; raw spans are kept seven days. No screenshots, no keystrokes.
 */
import { WINDOW_RETENTION_MS, type MemoryStore, type WindowSpan } from '@assistant/memory'
import { HOUR, MINUTE, type Clock } from '@assistant/shared'

import type { EvidenceSource } from './evidence.ts'

export interface WindowSample {
  /** Process or application name, e.g. "EXCEL", "chrome". */
  app: string
  title: string
}

export { DEFAULT_EXCLUDED_APPS } from './activity-defaults.ts'

/** Private and incognito windows are skipped whatever the app. */
const PRIVATE_TITLE = /\b(InPrivate|Incognito|Private Browsing|Private Window)\b/i
const MAX_TITLE_CHARS = 200
/** Spans shorter than this are noise (alt-tab flicks) and are not stored. */
export const MIN_SPAN_MS = 3_000
const PURGE_EVERY_MS = HOUR

export const normalizeApp = (app: string) => app.trim().replace(/\.exe$/i, '')

export class ActivityTracker {
  private enabled = false
  private excluded = new Set<string>()
  private away = false
  private current: { sample: WindowSample; since: number } | null = null
  /** The latest foreground window, even while paused, so resuming picks up where the owner is. */
  private latest: WindowSample | null = null
  private lastPurge = 0

  constructor(
    private readonly memory: Pick<MemoryStore, 'recordWindowSpan' | 'purgeWindowActivity'>,
    private readonly clock: Clock,
  ) {}

  get isEnabled() {
    return this.enabled
  }

  /** Owner settings from main. Turning it off closes the open span; nothing is recorded afterwards. */
  configure(enabled: boolean, excludedApps: readonly string[]) {
    this.excluded = new Set(excludedApps.map(a => normalizeApp(a).toLowerCase()))
    if (!enabled) this.close()
    this.enabled = enabled
    if (enabled) {
      this.purge(true)
      // An app that just became excluded stops counting now.
      if (this.current && this.isExcluded(this.current.sample)) this.close()
      if (!this.current && this.latest) this.open(this.latest)
    }
  }

  isExcluded(s: WindowSample) {
    return this.excluded.has(normalizeApp(s.app).toLowerCase()) || PRIVATE_TITLE.test(s.title)
  }

  /** The foreground window changed. */
  sample(s: WindowSample) {
    const clean = { app: normalizeApp(s.app) || 'unknown', title: s.title.trim().slice(0, MAX_TITLE_CHARS) }
    this.latest = clean
    if (!this.enabled || this.away) return
    if (this.current && this.current.sample.app === clean.app && this.current.sample.title === clean.title) return
    this.close()
    this.open(clean)
    this.purge()
  }

  /** Locked, asleep or idle: stop counting at once. */
  pause() {
    this.close()
    this.away = true
  }

  resume() {
    this.away = false
    if (this.enabled && this.latest) this.open(this.latest)
  }

  /** Persist the open span (on shutdown, or periodically); it continues afterwards. */
  flush() {
    if (!this.current) return
    const sample = this.current.sample
    this.close()
    this.open(sample)
  }

  private open(sample: WindowSample) {
    this.current = this.isExcluded(sample) ? null : { sample, since: this.clock.now() }
  }

  private close() {
    const c = this.current
    this.current = null
    if (!c) return
    const endedAt = this.clock.now()
    if (endedAt - c.since < MIN_SPAN_MS) return
    this.memory.recordWindowSpan({ app: c.sample.app, title: c.sample.title, startedAt: c.since, endedAt })
  }

  private purge(force = false) {
    const now = this.clock.now()
    if (!force && now - this.lastPurge < PURGE_EVERY_MS) return
    this.lastPurge = now
    this.memory.purgeWindowActivity(WINDOW_RETENTION_MS)
  }
}

export interface ActivitySummary {
  since: number
  until: number
  totalMs: number
  apps: { app: string; ms: number; titles: { title: string; ms: number }[] }[]
}

/** Time per app and per window title in [since, until), biggest first. */
export const summarizeActivity = (spans: readonly WindowSpan[], since: number, until: number, opts: { apps?: number; titles?: number } = {}): ActivitySummary => {
  const byApp = new Map<string, { ms: number; titles: Map<string, number> }>()
  let totalMs = 0
  for (const s of spans) {
    const ms = Math.min(s.endedAt, until) - Math.max(s.startedAt, since)
    if (ms <= 0) continue
    totalMs += ms
    const entry = byApp.get(s.app) ?? { ms: 0, titles: new Map<string, number>() }
    entry.ms += ms
    entry.titles.set(s.title, (entry.titles.get(s.title) ?? 0) + ms)
    byApp.set(s.app, entry)
  }
  const apps = [...byApp.entries()]
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, opts.apps ?? 8)
    .map(([app, e]) => ({
      app,
      ms: e.ms,
      titles: [...e.titles.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, opts.titles ?? 3)
        .map(([title, ms]) => ({ title, ms })),
    }))
  return { since, until, totalMs, apps }
}

export const formatDuration = (ms: number) => {
  const min = Math.round(ms / MINUTE)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
}

/** Briefing evidence: what the owner worked on in the last day, as observed (not interpreted). */
export const activityEvidenceSource = (memory: Pick<MemoryStore, 'windowActivity'>, windowMs = 24 * HOUR): EvidenceSource => ({
  id: 'window-activity',
  label: 'Window activity',
  kind: 'window-activity',
  // Window titles come from other apps (mail subjects, web pages), so they are data, not instructions.
  untrusted: true,
  collect: async ({ now }) => {
    const since = now - windowMs
    const s = summarizeActivity(memory.windowActivity(since, now), since, now)
    if (!s.apps.length) return 'No foreground-window activity recorded in the last 24 hours.'
    const lines = s.apps
      .filter(a => a.ms >= MINUTE)
      .map(a => `- ${a.app}: ${formatDuration(a.ms)}${a.titles.length ? ` (${a.titles.map(t => `"${t.title || 'untitled'}" ${formatDuration(t.ms)}`).join('; ')})` : ''}`)
    return [
      `Foreground windows in the last 24 hours (${formatDuration(s.totalMs)} observed). This shows which windows were in front, not what was finished.`,
      ...lines,
    ].join('\n')
  },
})
