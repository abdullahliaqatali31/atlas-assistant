/**
 * Live numbers for the rail: one small number per module, kept current from
 * the same bridges the pages use. Cheap: event-driven where possible, a slow
 * poll (60 s, shared with the whole window) only for tasks; nothing is fetched while Atlas is locked.
 */
import { useEffect, useMemo, useState } from 'react'

import type { ControlState } from '../../../shared/control.ts'
import type { RuntimeStatus } from '../../../shared/ipc.ts'
import { useTasks } from './tasksStore.ts'

export interface Count {
  /** What the rail shows under the icon; null shows nothing. */
  value: string | null
  /** The same in words, for the tooltip and screen readers. */
  hint: string
  /** Needs the owner (overdue, waiting, failed): drawn in amber. */
  attention?: boolean
}

export type CountKey = 'chat' | 'today' | 'world' | 'news' | 'projects' | 'files' | 'apps' | 'learning' | 'controls'

const safe = <T,>(p: Promise<T>, set: (v: T) => void) => void p.then(set, () => undefined)

export const useCounts = ({ status, controls, locked, suggestions, unread }: { status: RuntimeStatus; controls: ControlState | null; locked: boolean; suggestions: number; unread: number }): Record<CountKey, Count> => {
  const ready = status.phase === 'ready' && !locked
  const list = useTasks(ready, status.later.length)
  const tasks = useMemo(() => {
    if (!list) return null
    const now = Date.now()
    return { open: list.length, overdue: list.filter(t => t.dueAt !== null && t.dueAt < now).length }
  }, [list])
  const [running, setRunning] = useState<number | null>(null)
  const [projects, setProjects] = useState<number | null>(null)
  const [nearby, setNearby] = useState<{ places: number; alerts: number } | null>(null)
  const [changes, setChanges] = useState<number | null>(null)
  const [apps, setApps] = useState<number | null>(null)
  const [news, setNews] = useState<number | null>(null)

  useEffect(() => {
    if (!ready) return
    const onCode = (s: { running: { endedAt?: number | null }[]; projects: unknown[] }) => {
      setRunning(s.running.filter(r => !r.endedAt).length)
      setProjects(s.projects.length)
    }
    safe(window.code.state(), onCode)
    const offCode = window.code.onChanged(onCode)
    const onWorld = (w: { places: { nearby: unknown[] }[] }) => setNearby({ places: w.places.length, alerts: w.places.reduce((n, p) => n + p.nearby.length, 0) })
    safe(window.world.state(), onWorld)
    const offWorld = window.world.onChanged(onWorld)
    const today = new Date().toDateString()
    const onFiles = (f: { history: { at: number }[] }) => setChanges(f.history.filter(b => new Date(b.at).toDateString() === today).length)
    safe(window.files.state(), onFiles)
    const offFiles = window.files.onChanged(onFiles)
    const onApps = (d: { apps: unknown[] }) => setApps(d.apps.length)
    safe(window.desktop.state(), onApps)
    const offApps = window.desktop.onChanged(onApps)
    safe(window.news.list(false), r => setNews(r.headlines.length))
    const offNews = window.news.onChanged(r => setNews(r.headlines.length))
    return () => {
      offCode()
      offWorld()
      offFiles()
      offApps()
      offNews()
    }
  }, [ready, status.later.length])

  const servers = controls?.servers ?? []
  const up = servers.filter(s => s.state === 'running').length
  const failed = servers.some(s => s.state === 'failed')
  const approvals = status.approvals.length
  return {
    chat: { value: approvals ? String(approvals) : unread ? String(unread) : null, hint: approvals ? `${approvals} question(s) waiting for your yes or no` : unread ? `${unread} new repl${unread === 1 ? 'y' : 'ies'}` : 'Conversation', attention: approvals > 0 },
    today: {
      value: tasks ? String(tasks.open) : null,
      hint: tasks ? `${tasks.open} open task(s)${tasks.overdue ? `, ${tasks.overdue} overdue` : ''}` : 'Today',
      attention: (tasks?.overdue ?? 0) > 0,
    },
    world: { value: nearby ? String(nearby.places) : null, hint: nearby ? `${nearby.places} watched place(s), ${nearby.alerts} event(s) nearby` : 'World', attention: (nearby?.alerts ?? 0) > 0 },
    news: { value: news !== null ? String(news) : null, hint: news !== null ? `${news} headlines` : 'News' },
    projects: { value: running ? String(running) : projects !== null ? String(projects) : null, hint: running ? `${running} server(s) running` : `${projects ?? 0} coding project(s)` },
    files: { value: changes ? String(changes) : null, hint: changes ? `${changes} file change(s) today` : 'Files' },
    apps: { value: apps ? String(apps) : null, hint: apps ? `${apps} app(s) Atlas may use` : 'Apps' },
    learning: { value: suggestions ? String(suggestions) : null, hint: suggestions ? `${suggestions} suggestion(s) waiting` : 'Learning', attention: suggestions > 0 },
    controls: { value: servers.length ? `${up}/${servers.length}` : null, hint: servers.length ? `${up} of ${servers.length} connections running` : 'Connections and permissions', attention: failed },
  }
}
