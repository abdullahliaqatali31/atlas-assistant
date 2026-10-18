/**
 * One timeline of what needed (or may need) the owner in the last 24 hours:
 * world alerts near watched places, questions waiting for a yes or no,
 * failures (connections, dev servers, actions) and what Atlas raised or held
 * back. Built from data the shell already has; nothing new is stored.
 */
import { useEffect, useState } from 'react'

import type { CodeState } from '../../../shared/code.ts'
import type { ActivityEntry, ControlState } from '../../../shared/control.ts'
import type { ApprovalRequest, InitiativeItem, RuntimeStatus, TaskView } from '../../../shared/ipc.ts'
import type { WorldSnapshot } from '../../../shared/world.ts'

export type AlertKind = 'question' | 'world' | 'failure' | 'task' | 'notice'

export interface AlertItem {
  id: string
  kind: AlertKind
  at: number
  title: string
  detail?: string | undefined
  /** Still needs the owner (a waiting question, an overdue task, a failed connection). */
  open: boolean
  /** Where "Open" goes. */
  target: 'chat' | 'world' | 'today' | 'projects' | 'controls'
  approvalId?: string | undefined
}

export const DAY_MS = 24 * 60 * 60 * 1000

export interface AlertSources {
  now: number
  approvals: ApprovalRequest[]
  later: InitiativeItem[]
  world: WorldSnapshot | null
  activity: ActivityEntry[]
  code: CodeState | null
  controls: ControlState | null
  tasks: TaskView[] | null
}

/** A tool call's input in plain words: {"chat":"Raheel","count":10} → chat Raheel · count 10. */
export const readableInput = (summary: string): string => {
  try {
    const v = JSON.parse(summary) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const parts = Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== null && x !== undefined && x !== '' && !(typeof x === 'string' && /^[0-9a-f-]{32,}$/i.test(x)))
        .map(([k, x]) => `${k.replace(/_/g, ' ')} ${typeof x === 'string' ? x : JSON.stringify(x)}`.slice(0, 60))
      return parts.join(' · ').slice(0, 160)
    }
  } catch {
    // Not JSON: use it as it is.
  }
  return summary.length > 140 ? `${summary.slice(0, 140)}…` : summary
}

/** Merge every source, newest first; open items (still need you) lead. */
export const buildAlerts = (s: AlertSources): AlertItem[] => {
  const since = s.now - DAY_MS
  const out: AlertItem[] = []

  for (const a of s.approvals) out.push({ id: `ask:${a.id}`, kind: 'question', at: s.now, title: a.question ?? `May I use ${a.tool}?`, detail: a.reason || undefined, open: true, target: 'chat', approvalId: a.id })

  for (const p of s.world?.places ?? []) {
    for (const n of p.nearby) if (n.time >= since) out.push({ id: `near:${n.id}:${p.place.id}`, kind: 'world', at: n.time, title: n.title, detail: `${n.km} km from ${p.place.name}`, open: false, target: 'world' })
    if (p.air && p.air.aqi > 150) out.push({ id: `air:${p.place.id}`, kind: 'world', at: s.world?.updatedAt ?? s.now, title: `${p.place.name}: air is ${p.air.level.toLowerCase()} (AQI ${p.air.aqi})`, detail: 'Limit time outdoors; a mask helps.', open: true, target: 'world' })
  }

  for (const t of s.tasks ?? []) if (t.dueAt !== null && t.dueAt < s.now && t.dueAt >= since) out.push({ id: `task:${t.id}`, kind: 'task', at: t.dueAt, title: t.title, detail: 'Overdue', open: true, target: 'today' })

  for (const srv of s.controls?.servers ?? []) if (srv.enabled && srv.state === 'failed') out.push({ id: `srv:${srv.name}`, kind: 'failure', at: s.now, title: `${srv.label} is not connected`, detail: srv.error, open: true, target: 'controls' })

  for (const r of s.code?.running ?? []) if (r.state === 'crashed' && (r.endedAt ?? r.startedAt) >= since) out.push({ id: `run:${r.id}`, kind: 'failure', at: r.endedAt ?? r.startedAt, title: `${r.projectName} · ${r.profile} stopped with an error`, detail: r.lastError ?? undefined, open: false, target: 'projects' })

  for (const a of s.activity) if (a.at >= since && a.result === 'failed') out.push({ id: `act:${a.id}`, kind: 'failure', at: a.at, title: `${a.tool.replace(/_/g, ' ')} failed`, detail: readableInput(a.summary) || undefined, open: false, target: 'controls' })

  for (const i of s.later) if (i.at >= since) out.push({ id: `later:${i.id}`, kind: 'notice', at: i.at, title: i.title, detail: i.reason, open: false, target: 'chat' })

  // The same thing can arrive twice (an alert held back and the event itself): keep the first.
  const seen = new Set<string>()
  return out
    .filter(a => (seen.has(a.id) ? false : (seen.add(a.id), true)))
    .sort((a, b) => Number(b.open) - Number(a.open) || b.at - a.at)
}

/** Live alerts for the shell: event-driven where possible, a 60 s poll for the rest; nothing while locked. */
export const useAlerts = ({ status, controls, active }: { status: RuntimeStatus | null; controls: ControlState | null; active: boolean }) => {
  const [world, setWorld] = useState<WorldSnapshot | null>(null)
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [code, setCode] = useState<CodeState | null>(null)
  const [tasks, setTasks] = useState<TaskView[] | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const poll = () => {
      setNow(Date.now())
      void window.controls.activity().then(setActivity, () => undefined)
      void window.assistant.listTasks().then(setTasks, () => undefined)
    }
    poll()
    const timer = setInterval(poll, 60_000)
    void window.world.state().then(setWorld, () => undefined)
    const offWorld = window.world.onChanged(setWorld)
    void window.code.state().then(setCode, () => undefined)
    const offCode = window.code.onChanged(setCode)
    return () => {
      clearInterval(timer)
      offWorld()
      offCode()
    }
  }, [active, status?.later.length])
  if (!status) return []
  return buildAlerts({ now, approvals: status.approvals, later: status.later, world, activity, code, controls, tasks })
}
