import { AlertTriangle, CheckCircle2, Clock3, Cloud, Code2, Play, ShieldQuestion, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { CodeState } from '../../shared/code.ts'
import type { ControlState } from '../../shared/control.ts'
import type { RuntimeStatus, TaskView } from '../../shared/ipc.ts'
import type { WorldSnapshot } from '../../shared/world.ts'
import { ago, greetingFor, STATE_LABEL, useNow, type Presence } from './Jarvis.tsx'
import { Orb, type OrbState } from './ui/Orb.tsx'

export type HomeTarget = 'today' | 'projects' | 'world' | 'chat'

interface NowItem {
  id: string
  icon: LucideIcon
  label: string
  title: string
  meta?: string | undefined
  tone?: 'warm' | 'ok' | undefined
  open: HomeTarget
}

/** Reads what Home needs, kept current by the same events the drawers use. */
const useHomeData = (ready: boolean) => {
  const [tasks, setTasks] = useState<TaskView[] | null>(null)
  const [code, setCode] = useState<CodeState | null>(null)
  const [world, setWorld] = useState<WorldSnapshot | null>(null)
  useEffect(() => {
    if (!ready) return
    const loadTasks = () => void window.assistant.listTasks().then(setTasks, () => undefined)
    loadTasks()
    const timer = setInterval(loadTasks, 60_000)
    void window.code.state().then(setCode, () => undefined)
    const offCode = window.code.onChanged(setCode)
    void window.world.state().then(setWorld, () => undefined)
    const offWorld = window.world.onChanged(setWorld)
    return () => {
      clearInterval(timer)
      offCode()
      offWorld()
    }
  }, [ready])
  return { tasks, code, world }
}

const when = (t: number, now: number) => {
  const d = new Date(t)
  const sameDay = d.toDateString() === new Date(now).toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

/** The time and greeting: the only part of Home that ticks every second. */
function Clock({ ownerName }: { ownerName: string }) {
  const date = new Date(useNow(1000))
  return (
    <>
      <p className="mt-1 font-mono text-4xl font-extralight tracking-wider tabular-nums @[480px]:text-5xl">
        {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        <span className="text-lg text-muted">:{String(date.getSeconds()).padStart(2, '0')}</span>
      </p>
      <p className="mt-1 text-sm text-muted">
        {date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · {greetingFor(date.getHours())}
        {ownerName ? `, ${ownerName}` : ''}
      </p>
    </>
  )
}

/**
 * Home, calm: the orb, the time, a greeting and one line on what matters now,
 * then at most three "now" cards (a question waiting, the next task, what is
 * running or a nearby alert). Everything else lives in the drawers.
 */
export function Home({ status, controls, presence, ownerName, open }: { status: RuntimeStatus; controls: ControlState | null; presence: Presence; ownerName: string; open: (t: HomeTarget) => void }) {
  const now = useNow(30_000)
  const ready = status.phase === 'ready'
  const { tasks, code, world } = useHomeData(ready)
  const orbState: OrbState = controls?.paused ? 'paused' : !ready ? 'offline' : presence.state

  const overdue = (tasks ?? []).filter(t => t.dueAt !== null && t.dueAt < now)
  const next = (tasks ?? []).filter(t => t.dueAt !== null && t.dueAt >= now).sort((a, b) => a.dueAt! - b.dueAt!)[0] ?? (tasks ?? []).find(t => t.dueAt === null)
  const running = (code?.running ?? []).filter(r => !r.endedAt)
  const alert = world?.places.flatMap(p => p.nearby.map(n => ({ ...n, place: p.place.name }))).sort((a, b) => b.time - a.time)[0]
  const worstAir = world?.places.filter(p => p.air && p.air.aqi > 100).sort((a, b) => b.air!.aqi - a.air!.aqi)[0]
  const firstPlace = world?.places.find(p => p.weather)
  const ask = status.approvals[0]

  // One line: the few things that matter, in order.
  const line = [
    ask && 'a question is waiting for your yes or no',
    overdue.length ? `${overdue.length} overdue` : next?.dueAt ? `${next.title.split(/[(:—-]/)[0]!.trim()} at ${when(next.dueAt, now)}` : null,
    worstAir && `${worstAir.place.name} AQI ${worstAir.air!.aqi}`,
    alert && `${alert.title.split(' · ')[0]} near ${alert.place}`,
    running.length ? `${running.length} server${running.length > 1 ? 's' : ''} running` : null,
  ].filter(Boolean) as string[]

  const cards: NowItem[] = []
  if (ask) cards.push({ id: 'ask', icon: ShieldQuestion, label: 'Waiting for you', title: ask.question ?? `May I use ${ask.tool}?`, tone: 'warm', open: 'chat' })
  if (overdue[0]) cards.push({ id: 'overdue', icon: Clock3, label: overdue.length > 1 ? `${overdue.length} overdue` : 'Overdue', title: overdue[0].title, meta: overdue[0].dueAt ? ago(overdue[0].dueAt, now) : undefined, tone: 'warm', open: 'today' })
  else if (next) cards.push({ id: 'next', icon: CheckCircle2, label: 'Next', title: next.title, meta: next.dueAt ? when(next.dueAt, now) : 'no time set', open: 'today' })
  if (alert) cards.push({ id: 'alert', icon: AlertTriangle, label: `Near ${alert.place}`, title: alert.title, meta: `${alert.km} km · ${ago(alert.time, now)}`, tone: 'warm', open: 'world' })
  if (running[0]) cards.push({ id: 'run', icon: Play, label: running.length > 1 ? `${running.length} running` : 'Running', title: `${running[0].projectName} · ${running[0].profile}`, meta: running[0].url?.replace(/^https?:\/\//, '') ?? undefined, tone: 'ok', open: 'projects' })
  else {
    const recent = code?.projects.slice().sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
    if (recent?.lastActivityAt) cards.push({ id: 'code', icon: Code2, label: 'Last worked on', title: recent.name, meta: ago(recent.lastActivityAt, now), open: 'projects' })
  }
  if (!alert && firstPlace?.weather) {
    const w = firstPlace.weather
    cards.push({ id: 'weather', icon: Cloud, label: firstPlace.place.name, title: `${Math.round(w.temp)}° ${w.summary}`, meta: firstPlace.air ? `AQI ${firstPlace.air.aqi}` : undefined, tone: (firstPlace.air?.aqi ?? 0) > 150 ? 'warm' : undefined, open: 'world' })
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto px-4 py-6">
      <div className="flex w-full max-w-2xl flex-col items-center text-center">
        <Orb state={orbState} level={presence.level} size={150} />
        <Clock ownerName={ownerName} />
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed">
          <span className={`mr-1.5 inline-block size-1.5 rounded-full align-middle ${orbState === 'listening' ? 'bg-warm' : orbState === 'paused' ? 'bg-danger' : 'bg-accent'}`} aria-hidden />
          <span className="text-muted">{STATE_LABEL[orbState]} · </span>
          {!ready ? 'Connect a provider in Settings to begin.' : line.length ? line.join(' · ') : 'All quiet. Nothing needs you right now.'}
        </p>

        {cards.length > 0 && (
          <ul className="mt-6 grid w-full gap-2 @[560px]:grid-cols-3">
            {cards.slice(0, 3).map(c => (
              <li key={c.id}>
                <button type="button" onClick={() => open(c.open)} className="tile group flex h-full w-full flex-col gap-1 p-3 text-left transition-colors hover:border-accent/50">
                  <span className={`flex items-center gap-1.5 text-[11px] ${c.tone === 'warm' ? 'text-warm' : c.tone === 'ok' ? 'text-ok' : 'text-muted'}`}>
                    <c.icon className="size-3.5" aria-hidden />
                    <span className="truncate">{c.label}</span>
                  </span>
                  <span className="line-clamp-2 text-sm">{c.title}</span>
                  {c.meta && <span className="mt-auto truncate font-mono text-[10px] text-muted">{c.meta}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-5 hidden text-[11px] text-muted @[480px]:block">
          Hover the icons on the right for a quick look · <kbd className="font-mono">Ctrl K</kbd> to go anywhere · <kbd className="font-mono">/</kbd> to ask
        </p>
      </div>
    </div>
  )
}
