import { Activity, AlertTriangle, CheckCircle2, Clock3, Cpu, ListTodo, PauseCircle, ShieldCheck, Sparkles, Zap } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { ActivityEntry, ControlState } from '../../shared/control.ts'
import type { RuntimeStatus, TaskView } from '../../shared/ipc.ts'
import { BrandIcon } from './ui/BrandIcon.tsx'
import { Orb, type OrbState } from './ui/Orb.tsx'

/**
 * The assistant's own canvas, as cards: what it is doing right now, what
 * matters today, what it did and what it is connected to. Everything reads
 * from the runtime; nothing is invented for decoration.
 */

export interface Presence {
  state: OrbState
  /** Microphone level 0–1 while listening. */
  level: number
}

export const STATE_LABEL: Record<OrbState, string> = {
  offline: 'Offline',
  paused: 'Automation stopped',
  idle: 'Standing by',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
}

export const greetingFor = (hour: number) => (hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : hour < 21 ? 'Good evening' : 'Good night')

export const ago = (t: number, now: number) => {
  const m = Math.round((now - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

/** The time, ticking every `ms`; paused while the window is hidden and caught up when it shows again. */
export const useNow = (ms: number) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = () => !document.hidden && setNow(Date.now())
    const t = setInterval(tick, ms)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [ms])
  return now
}

/** The orb, the time, the greeting and three live numbers. */
export function PresenceCard({ status, controls, presence, ownerName, size = 200 }: { status: RuntimeStatus; controls: ControlState | null; presence: Presence; ownerName: string; size?: number }) {
  const now = useNow(1000)
  const orbState: OrbState = controls?.paused ? 'paused' : status.phase !== 'ready' ? 'offline' : presence.state
  const servers = controls?.servers ?? []
  const date = new Date(now)
  return (
    <section className="glass relative flex flex-col items-center overflow-hidden rounded-2xl px-4 pb-4 pt-3">
      <div className="flex w-full items-center justify-between">
        <span className="hud-label">Presence</span>
        <span className="font-mono text-xs text-muted">{date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
      </div>
      <Orb state={orbState} level={presence.level} size={size} />
      <p className="font-mono text-3xl font-light tracking-wider tabular-nums">
        {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        <span className="text-base text-muted">:{String(date.getSeconds()).padStart(2, '0')}</span>
      </p>
      <p className="mt-1 text-sm text-muted">
        {greetingFor(date.getHours())}
        {ownerName ? `, ${ownerName}` : ''} ·{' '}
        <span className={orbState === 'paused' ? 'text-danger' : orbState === 'listening' ? 'text-warm' : 'text-accent'}>{STATE_LABEL[orbState]}</span>
      </p>
      <div className="mt-3 grid w-full grid-cols-3 gap-2">
        <Stat icon={<Cpu className="size-3.5" />} label="Mode" value={status.mode} />
        <Stat icon={<Zap className="size-3.5" />} label="Links" value={`${servers.filter(s => s.state === 'running').length}/${servers.length}`} />
        <Stat
          icon={status.approvals.length ? <AlertTriangle className="size-3.5 text-warm" /> : <ShieldCheck className="size-3.5" />}
          label="Approvals"
          value={String(status.approvals.length)}
          tone={status.approvals.length ? 'warm' : undefined}
        />
      </div>
    </section>
  )
}

/** Today's open tasks, overdue first; refreshed every minute. */
export function TodayCard({ status }: { status: RuntimeStatus }) {
  const now = useNow(30_000)
  const ready = status.phase === 'ready'
  const [tasks, setTasks] = useState<TaskView[] | null>(null)
  const load = useCallback(() => {
    if (ready) void window.assistant.listTasks().then(setTasks, () => undefined)
  }, [ready])
  useEffect(() => {
    load()
    const t = setInterval(load, 60_000)
    return () => clearInterval(t)
  }, [load, status.later.length])
  const overdue = useMemo(() => (tasks ?? []).filter(t => t.dueAt !== null && t.dueAt < now), [tasks, now])
  const upcoming = useMemo(() => (tasks ?? []).filter(t => !overdue.includes(t)).slice(0, 6), [tasks, overdue])
  return (
    <Panel title="Today" icon={<ListTodo className="size-3.5" />} aside={tasks ? `${tasks.length} open` : undefined}>
      {!ready && <Empty>Connect your providers in Setup to see tasks.</Empty>}
      {ready && tasks?.length === 0 && <Empty>Nothing open. Tell me what you need to get done.</Empty>}
      {overdue.map(t => (
        <Row key={t.id} icon={<Clock3 className="size-4 text-warm" />} title={t.title} meta={`Overdue · ${t.dueAt ? ago(t.dueAt, now) : ''}`} tone="warm" />
      ))}
      {upcoming.map(t => (
        <Row
          key={t.id}
          icon={<CheckCircle2 className="size-4 text-muted" />}
          title={t.title}
          meta={t.dueAt ? new Date(t.dueAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : t.status}
        />
      ))}
    </Panel>
  )
}

/** Tools running now, automation stopped, and what was held back for later. */
export function NowCard({ status, controls }: { status: RuntimeStatus; controls: ControlState | null }) {
  const now = useNow(10_000)
  const working = controls && (controls.running.length > 0 || controls.paused)
  if (!working && status.later.length === 0) return null
  return (
    <Panel title={working ? 'Working on' : 'Held for later'} icon={working ? <Activity className="size-3.5" /> : <Sparkles className="size-3.5" />} aside={working ? undefined : String(status.later.length)}>
      {controls?.paused && <Row icon={<PauseCircle className="size-4 text-danger" />} title="Automation stopped" meta="Resume from Controls or the tray" />}
      {controls?.running.map(r => (
        <div key={r.tool + r.since} className="tile scanline px-3 py-2">
          <p className="truncate font-mono text-xs text-accent">{r.tool}</p>
          <p className="truncate text-xs text-muted">{r.detail ?? `running ${ago(r.since, now)}`}</p>
        </div>
      ))}
      {status.later
        .slice(-4)
        .reverse()
        .map(i => (
          <Row key={i.id + i.at} title={i.title} meta={`${i.kind} · held ${ago(i.at, now)}`} />
        ))}
    </Panel>
  )
}

export function ConnectionsCard({ controls }: { controls: ControlState | null }) {
  const servers = controls?.servers ?? []
  return (
    <Panel title="Connections" icon={<Zap className="size-3.5" />}>
      {servers.length === 0 ? (
        <Empty>No connections yet. Add them in Controls.</Empty>
      ) : (
        <div className="flex flex-wrap gap-2">
          {servers.map(s => (
            <span key={s.name} className="relative" title={`${s.label}: ${s.state}`}>
              <BrandIcon id={s.catalog ?? s.name} size={38} title={s.label} />
              <span
                className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-[var(--tint)] ${
                  s.state === 'running' ? 'bg-ok' : s.state === 'failed' ? 'bg-danger' : s.state === 'starting' ? 'thinking-dot bg-warm' : 'bg-muted'
                }`}
                aria-hidden
              />
            </span>
          ))}
        </div>
      )}
    </Panel>
  )
}

/** The last actions with their result; refreshed when tools start or finish. */
export function ActivityCard({ controls, presence }: { controls: ControlState | null; presence: Presence }) {
  const now = useNow(30_000)
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const runningKey = controls?.running.map(r => r.tool + r.since).join('|') ?? ''
  useEffect(() => {
    void window.controls.activity().then(a => setActivity(a.slice(0, 7)), () => undefined)
  }, [runningKey, presence.state])
  return (
    <Panel title="Recent actions" icon={<Activity className="size-3.5" />}>
      {activity.length === 0 ? (
        <Empty>Nothing yet. Actions I take appear here with their result.</Empty>
      ) : (
        activity.map(a => (
          <div key={a.id} className="flex items-center gap-2 text-xs">
            <span className={`size-1.5 shrink-0 rounded-full ${a.result === 'done' ? 'bg-ok' : a.result === 'failed' || a.result === 'denied' ? 'bg-danger' : 'bg-muted'}`} aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono">{a.tool}</span>
            <span className="text-muted">{a.result ?? a.decision}</span>
            <span className="w-14 text-right text-muted">{ago(a.at, now)}</span>
          </div>
        ))
      )}
    </Panel>
  )
}

export function Panel({ title, icon, aside, children, className = '' }: { title: string; icon: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`glass rise-in min-w-0 rounded-2xl p-3 ${className}`}>
      <header className="mb-2 flex items-center gap-1.5 text-muted">
        {icon}
        <h2 className="hud-label flex-1">{title}</h2>
        {typeof aside === 'string' ? <span className="font-mono text-[11px]">{aside}</span> : aside}
      </header>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

function Row({ icon, title, meta, tone }: { icon?: ReactNode; title: string; meta?: string; tone?: 'warm' }) {
  return (
    <div className={`flex items-start gap-2 rounded-lg px-1 py-1 ${tone === 'warm' ? 'text-warm' : ''}`}>
      {icon && <span className="mt-0.5">{icon}</span>}
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm ${tone === 'warm' ? '' : 'text-text'}`}>{title}</p>
        {meta && <p className="truncate text-[11px] text-muted">{meta}</p>}
      </div>
    </div>
  )
}

function Stat({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone?: 'warm' }) {
  return (
    <div className="tile flex flex-col items-center gap-0.5 px-2 py-1.5">
      <span className="flex items-center gap-1 text-muted">
        {icon}
        <span className="hud-label !tracking-[0.08em]">{label}</span>
      </span>
      <span className={`font-mono text-sm capitalize ${tone === 'warm' ? 'text-warm' : ''}`}>{value}</span>
    </div>
  )
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="px-1 text-xs text-muted">{children}</p>
