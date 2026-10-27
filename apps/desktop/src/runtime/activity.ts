/**
 * Runtime host side of opt-in window tracking: owns the tracker, starts the
 * platform sampler only while the owner has it on, pauses it while they are
 * away, and answers the Activity screen. No Electron imports.
 */
import type { MemoryStore } from '@assistant/memory'
import { ActivityTracker, activityEvidenceSource, summarizeActivity, type EvidenceSource, type WindowSample } from '@assistant/runtime'
import { HOUR, MINUTE, type Clock } from '@assistant/shared'

import type { ActivityHostEvent, ActivityHostRequest, ActivitySettings, ActivityView } from '../shared/activity.ts'
import type { SessionChange } from '../shared/ipc.ts'

/** Open spans are written at least this often, so a crash loses little. */
const FLUSH_MS = 5 * MINUTE

export interface ActivityDeps {
  memory: MemoryStore
  clock: Clock
  /** Starts the OS sampler; returns null when the platform has none. */
  startSampler: (onSample: (s: WindowSample) => void, onError: (message: string) => void) => { stop(): void } | null
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

export class HostActivity {
  readonly tracker: ActivityTracker
  private sampler: { stop(): void } | null = null
  private available = true
  private settings: ActivitySettings = { enabled: false, excludedApps: [] }
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: ActivityDeps) {
    this.tracker = new ActivityTracker(deps.memory, deps.clock)
  }

  configure(settings: ActivitySettings) {
    this.settings = settings
    this.tracker.configure(settings.enabled, settings.excludedApps)
    if (settings.enabled && !this.sampler && this.available) {
      this.sampler = this.deps.startSampler(
        s => this.tracker.sample(s),
        message => this.deps.log('warn', message),
      )
      if (!this.sampler) this.available = false
      else {
        this.flushTimer = setInterval(() => this.tracker.flush(), FLUSH_MS)
        this.flushTimer.unref?.()
      }
    } else if (!settings.enabled) {
      this.stopSampler()
    }
  }

  /** Locked, asleep or idle pauses recording; coming back resumes it. */
  session(change: SessionChange) {
    if (change.signal === 'lock' || change.signal === 'suspend' || change.signal === 'idle') this.tracker.pause()
    else this.tracker.resume()
  }

  /** The briefing cites window activity only while the owner has tracking on. */
  briefingSources(): EvidenceSource[] {
    return this.settings.enabled ? [activityEvidenceSource(this.deps.memory)] : []
  }

  summary(hours: number): ActivityView['summary'] {
    this.tracker.flush()
    const until = this.deps.clock.now()
    const s = summarizeActivity(this.deps.memory.windowActivity(until - hours * HOUR, until), until - hours * HOUR, until, { apps: 20, titles: 5 })
    const min = (ms: number) => Math.round(ms / MINUTE)
    return { hours, totalMinutes: min(s.totalMs), apps: s.apps.map(a => ({ app: a.app, minutes: min(a.ms), titles: a.titles.map(t => ({ title: t.title, minutes: min(t.ms) })) })) }
  }

  handle(req: Extract<ActivityHostRequest, { type: 'activity' }>): ActivityHostEvent {
    try {
      if (req.op.kind === 'clear') {
        this.tracker.flush()
        this.deps.memory.clearWindowActivity(req.op.app)
        return { type: 'activity', requestId: req.requestId, summary: this.summary(24), available: this.available }
      }
      return { type: 'activity', requestId: req.requestId, summary: this.summary(req.op.hours), available: this.available }
    } catch (error) {
      return { type: 'activity', requestId: req.requestId, error: error instanceof Error ? error.message : String(error) }
    }
  }

  stop() {
    this.tracker.flush()
    this.stopSampler()
  }

  private stopSampler() {
    this.sampler?.stop()
    this.sampler = null
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = null
  }
}
