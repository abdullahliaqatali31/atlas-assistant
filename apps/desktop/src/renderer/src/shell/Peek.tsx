/**
 * Hover overviews for the rail: a small card with the few things worth
 * knowing about a module, so the owner rarely needs to open it. Data is read
 * only while a card is shown (and kept 30 s), so hovering costs nothing at rest.
 */
import { useEffect, useState, type ReactNode } from 'react'

import type { ControlState } from '../../../shared/control.ts'
import type { RuntimeStatus } from '../../../shared/ipc.ts'
import { useLive } from './live.ts'

export type PeekKind = 'home' | 'world' | 'chat' | 'today' | 'news' | 'projects' | 'files' | 'apps' | 'learning' | 'controls' | 'setup' | 'compact'

export interface PeekContext {
  status: RuntimeStatus
  controls: ControlState | null
}

interface Row {
  text: string
  meta?: string | undefined
  warn?: boolean | undefined
}

const cache = new Map<string, { at: number; rows: Row[] }>()
const TTL = 30_000

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`
}

/** Reads the few rows a module's card shows. Only called while the card is open. */
const load = async (kind: PeekKind): Promise<Row[]> => {
  switch (kind) {
    case 'today': {
      const tasks = await window.assistant.listTasks()
      const now = Date.now()
      return tasks
        .slice()
        .sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
        .slice(0, 4)
        .map(t => ({ text: t.title, meta: t.dueAt ? (t.dueAt < now ? 'overdue' : new Date(t.dueAt).toLocaleDateString([], { day: 'numeric', month: 'short' })) : undefined, warn: t.dueAt !== null && t.dueAt < now }))
    }
    case 'world':
    case 'home': {
      const w = await window.world.state()
      return w.places.slice(0, 3).map(p => ({
        text: `${p.place.name}${p.weather ? ` · ${Math.round(p.weather.temp)}° ${p.weather.summary}` : ''}`,
        meta: p.nearby.length ? `${p.nearby.length} nearby` : p.air ? `AQI ${p.air.aqi}` : undefined,
        warn: p.nearby.length > 0 || (p.air?.aqi ?? 0) > 150,
      }))
    }
    case 'news': {
      const r = await window.news.list(false)
      return r.headlines.slice(0, 3).map(h => ({ text: h.title, meta: h.source }))
    }
    case 'projects': {
      const s = await window.code.state()
      const running = s.running.filter(r => !r.endedAt).map(r => ({ text: `${r.projectName} · ${r.profile}`, meta: 'running' }))
      const recent = s.projects
        .slice()
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
        .slice(0, 3)
        .map(p => ({ text: p.name, meta: p.lastActivityAt ? ago(p.lastActivityAt) : undefined, warn: (p.git?.uncommitted ?? 0) > 0 }))
      return [...running, ...recent].slice(0, 4)
    }
    case 'files': {
      const f = await window.files.state()
      const changes = f.history.slice(0, 3).map(b => ({ text: b.summary, meta: b.undoneAt ? 'undone' : ago(b.at) }))
      return changes.length ? changes : f.folders.slice(0, 3).map(d => ({ text: d.name, meta: d.access }))
    }
    case 'apps': {
      const d = await window.desktop.state()
      return d.apps.slice(0, 4).map(a => ({ text: a.name, meta: a.access }))
    }
    case 'learning': {
      const l = await window.learning.get()
      const waiting = l.pending.slice(0, 3).map(p => ({ text: p.title, meta: p.kind, warn: true }))
      return waiting.length ? waiting : l.learned.slice(-3).reverse().map(x => ({ text: x.statement, meta: ago(x.at) }))
    }
    default:
      return []
  }
}

const useRows = (kind: PeekKind) => {
  const hit = cache.get(kind)
  const [rows, setRows] = useState<Row[] | null>(hit ? hit.rows : null)
  useEffect(() => {
    const c = cache.get(kind)
    if (c && Date.now() - c.at < TTL) return
    let live = true
    load(kind).then(
      r => {
        cache.set(kind, { at: Date.now(), rows: r })
        if (live) setRows(r)
      },
      () => live && setRows([]),
    )
    return () => {
      live = false
    }
  }, [kind])
  return rows
}

/** The card's body: rows from the module, plus what the shell already knows. */
export function Peek({ kind, ctx }: { kind: PeekKind; ctx: PeekContext }) {
  const rows = useRows(kind)
  const lastReply = useLive()?.text ?? ''
  let lead: ReactNode = null
  let fixed: Row[] = []
  switch (kind) {
    case 'chat': {
      const ask = ctx.status.approvals[0]
      if (ask) lead = <p className="text-warm">{ask.question ?? `May I use ${ask.tool}?`}</p>
      fixed = lastReply ? [{ text: lastReply }] : [{ text: 'Nothing said yet. Type in the Ask bar or press the mic.' }]
      break
    }
    case 'controls': {
      fixed = (ctx.controls?.servers ?? []).slice(0, 5).map(s => ({ text: s.label, meta: s.enabled ? s.state : 'off', warn: s.state === 'failed' }))
      break
    }
    case 'setup':
      fixed = [{ text: 'Theme, voice, personality, places and keys' }]
      break
    case 'compact':
      fixed = [{ text: 'A small chat-only window; keep it on top while you work' }]
      break
  }
  const list = fixed.length ? fixed : rows
  return (
    <div className="space-y-1.5">
      {lead}
      {list === null ? (
        <div className="space-y-1" aria-hidden>
          <div className="h-3 w-4/5 animate-pulse rounded bg-surface-strong" />
          <div className="h-3 w-3/5 animate-pulse rounded bg-surface-strong" />
        </div>
      ) : list.length === 0 ? (
        <p className="text-muted">Nothing here yet.</p>
      ) : (
        <ul className="space-y-1">
          {list.map((r, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className={`mt-1.5 size-1 shrink-0 rounded-full ${r.warn ? 'bg-warm' : 'bg-accent/70'}`} aria-hidden />
              <span className={`min-w-0 flex-1 ${kind === 'chat' ? 'line-clamp-4' : 'truncate'}`}>{r.text}</span>
              {r.meta && <span className={`shrink-0 font-mono text-[10px] ${r.warn ? 'text-warm' : 'text-muted'}`}>{r.meta}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
