import { Activity, AlertTriangle, CheckCircle2, Clock3, Cpu, ListTodo, Newspaper, PauseCircle, RefreshCw, ShieldCheck, Sparkles, Zap } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { ActivityEntry, ControlState } from '../../shared/control.ts'
import type { RuntimeStatus, TaskView } from '../../shared/ipc.ts'
import type { NewsResult } from '../../shared/news.ts'
import { BrandIcon } from './ui/BrandIcon.tsx'
import { Orb, type OrbState } from './ui/Orb.tsx'

export interface Presence {
  state: OrbState
  /** Microphone level 0–1 while listening. */
  level: number
}

const STATE_LABEL: Record<OrbState, string> = {
  offline: 'Offline',
  paused: 'Automation stopped',
  idle: 'Standing by',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
}

const greetingFor = (hour: number) => (hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : hour < 21 ? 'Good evening' : 'Good night')

const ago = (t: number, now: number) => {
  const m = Math.round((now - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

const useNow = (ms: number) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/**
 * The assistant's own canvas: what it is doing right now, what matters
 * today, what it did, what it is connected to, and the news. Everything here
 * reads from the runtime; nothing is invented for decoration.
 */
export function JarvisPanel({ status, controls, presence, ownerName }: { status: RuntimeStatus; controls: ControlState | null; presence: Presence; ownerName: string }) {
  const now = useNow(1000)
  const ready = status.phase === 'ready'
  const orbState: OrbState = controls?.paused ? 'paused' : !ready ? 'offline' : presence.state

  // Today's tasks: on start, when the runtime changes state, and every minute.
  const [tasks, setTasks] = useState<TaskView[] | null>(null)
  const loadTasks = useCallback(() => {
    if (ready) void window.assistant.listTasks().then(setTasks, () => undefined)
  }, [ready])
  useEffect(() => {
    loadTasks()
    const t = setInterval(loadTasks, 60_000)
    return () => clearInterval(t)
  }, [loadTasks, status.later.length])

  // Activity: refresh when tools start or finish.
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const runningKey = controls?.running.map(r => r.tool + r.since).join('|') ?? ''
  useEffect(() => {
    void window.controls.activity().then(a => setActivity(a.slice(0, 6)), () => undefined)
  }, [runningKey, presence.state])

  // News: cached in main for 30 minutes.
  const [news, setNews] = useState<NewsResult | null>(null)
  const [newsBusy, setNewsBusy] = useState(false)
  const loadNews = useCallback(async (refresh = false) => {
    setNewsBusy(true)
    try {
      setNews(await window.news.list(refresh))
    } catch {
      // Offline: keep whatever is shown.
    } finally {
      setNewsBusy(false)
    }
  }, [])
  useEffect(() => {
    void loadNews()
    const t = setInterval(() => void loadNews(), 30 * 60_000)
    return () => clearInterval(t)
  }, [loadNews])

  const overdue = useMemo(() => (tasks ?? []).filter(t => t.dueAt !== null && t.dueAt < now), [tasks, now])
  const upcoming = useMemo(() => (tasks ?? []).filter(t => !overdue.includes(t)).slice(0, 5), [tasks, overdue])
  const servers = controls?.servers ?? []
  const runningServers = servers.filter(s => s.state === 'running').length
  const date = new Date(now)

  return (
    <aside className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-3 pb-3" aria-label="Assistant panel">
      {/* Presence */}
      <section className="glass relative flex shrink-0 flex-col items-center overflow-hidden rounded-2xl px-4 pb-4 pt-3">
        <div className="flex w-full items-center justify-between">
          <span className="hud-label">Presence</span>
          <span className="font-mono text-xs text-muted">{date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
        </div>
        <Orb state={orbState} level={presence.level} size={200} />
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
          <Stat icon={<Zap className="size-3.5" />} label="Links" value={`${runningServers}/${servers.length}`} />
          <Stat
            icon={status.approvals.length ? <AlertTriangle className="size-3.5 text-warm" /> : <ShieldCheck className="size-3.5" />}
            label="Approvals"
            value={String(status.approvals.length)}
            tone={status.approvals.length ? 'warm' : undefined}
          />
        </div>
      </section>

      {/* Right now */}
      {controls && (controls.running.length > 0 || controls.paused) && (
        <Panel title="Working on" icon={<Activity className="size-3.5" />}>
          {controls.paused && (
            <Row icon={<PauseCircle className="size-4 text-danger" />} title="Automation stopped" meta="Resume from Controls or the tray" />
          )}
          {controls.running.map(r => (
            <div key={r.tool + r.since} className="tile scanline px-3 py-2">
              <p className="truncate font-mono text-xs text-accent">{r.tool}</p>
              <p className="truncate text-xs text-muted">{r.detail ?? `running ${ago(r.since, now)}`}</p>
            </div>
          ))}
        </Panel>
      )}

      {/* Today */}
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

      {/* Held back */}
      {status.later.length > 0 && (
        <Panel title="Held for later" icon={<Sparkles className="size-3.5" />} aside={String(status.later.length)}>
          {status.later
            .slice(-4)
            .reverse()
            .map(i => (
              <Row key={i.id + i.at} title={i.title} meta={`${i.kind} · ${ago(i.at, now)}`} />
            ))}
        </Panel>
      )}

      {/* Connections */}
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

      {/* Activity */}
      <Panel title="Recent actions" icon={<Activity className="size-3.5" />}>
        {activity.length === 0 ? (
          <Empty>Nothing yet. Actions I take appear here with their result.</Empty>
        ) : (
          activity.map(a => (
            <div key={a.id} className="flex items-center gap-2 text-xs">
              <span
                className={`size-1.5 shrink-0 rounded-full ${a.result === 'done' ? 'bg-ok' : a.result === 'failed' || a.result === 'denied' ? 'bg-danger' : 'bg-muted'}`}
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate font-mono">{a.tool}</span>
              <span className="text-muted">{a.result ?? a.decision}</span>
              <span className="w-14 text-right text-muted">{ago(a.at, now)}</span>
            </div>
          ))
        )}
      </Panel>

      {/* News */}
      <Panel
        title="Headlines"
        icon={<Newspaper className="size-3.5" />}
        aside={
          <button type="button" className="icon-btn size-6" onClick={() => void loadNews(true)} aria-label="Refresh headlines" title="Refresh headlines" disabled={newsBusy}>
            <RefreshCw className={`size-3.5 ${newsBusy ? 'animate-spin' : ''}`} aria-hidden />
          </button>
        }
      >
        {!news && <Empty>Loading headlines…</Empty>}
        {news && news.headlines.length === 0 && <Empty>Headlines are unavailable offline.</Empty>}
        {news?.headlines.slice(0, 7).map(h => (
          <a
            key={h.link}
            href={h.link}
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-strong"
          >
            <p className="line-clamp-2 text-sm leading-snug">{h.title}</p>
            <p className="mt-0.5 text-[11px] text-muted">
              {h.source}
              {h.publishedAt ? ` · ${ago(h.publishedAt, now)}` : ''}
            </p>
          </a>
        ))}
        {news && news.failed.length > 0 && <p className="text-[11px] text-muted">Unavailable: {news.failed.join(', ')}</p>}
      </Panel>
    </aside>
  )
}

function Panel({ title, icon, aside, children }: { title: string; icon: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass rise-in shrink-0 rounded-2xl p-3">
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

const Empty = ({ children }: { children: ReactNode }) => <p className="px-1 text-xs text-muted">{children}</p>
