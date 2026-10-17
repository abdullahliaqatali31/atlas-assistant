import { Code2, Play } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { CodeState } from '../../shared/code.ts'
import type { ControlState } from '../../shared/control.ts'
import type { RuntimeStatus } from '../../shared/ipc.ts'
import { ActivityCard, ago, ConnectionsCard, Empty, NowCard, Panel, PresenceCard, TodayCard, useNow, type Presence } from './Jarvis.tsx'
import { HomeNews } from './News.tsx'

/** Coding projects: what is running and what you touched most recently. */
function CodeCard({ onOpen }: { onOpen: () => void }) {
  const now = useNow(60_000)
  const [code, setCode] = useState<CodeState | null>(null)
  useEffect(() => {
    void window.code.state().then(setCode, () => undefined)
    return window.code.onChanged(setCode)
  }, [])
  if (!code) return null
  const running = code.running.filter(r => !r.endedAt)
  const recent = code.projects.slice(0, 4)
  return (
    <Panel
      title="Code"
      icon={<Code2 className="size-3.5" />}
      aside={
        <button type="button" className="text-[11px] text-accent hover:underline" onClick={onOpen}>
          Projects →
        </button>
      }
    >
      {code.projects.length === 0 && <Empty>Follow your project folders in Projects › Code to see what you worked on.</Empty>}
      {running.map(r => (
        <div key={r.id} className="flex items-center gap-2 text-sm">
          <Play className="size-3.5 text-ok" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            {r.projectName} · {r.profile}
          </span>
          {r.url && (
            <button type="button" className="font-mono text-[11px] text-accent hover:underline" onClick={() => void window.code.openUrl(r.id)}>
              {r.url.replace(/^https?:\/\//, '')}
            </button>
          )}
        </div>
      ))}
      {recent.map(p => (
        <div key={p.id} className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-sm">{p.name}</span>
          <span className="text-muted">
            {p.today.commits ? `${p.today.commits} commits · ` : ''}
            {p.today.files ? `${p.today.files} files · ` : ''}
            {p.lastActivityAt ? ago(p.lastActivityAt, now) : 'quiet'}
          </span>
        </div>
      ))}
    </Panel>
  )
}

/**
 * Home: the broad canvas. Presence on the left, then today, the news with
 * pictures, your code, connections and recent actions. The conversation
 * lives in the side panel.
 */
export function Home({
  status,
  controls,
  presence,
  ownerName,
  go,
}: {
  status: RuntimeStatus
  controls: ControlState | null
  presence: Presence
  ownerName: string
  go: (view: 'news' | 'projects') => void
}) {
  return (
    <div className="h-full min-h-0 overflow-y-auto p-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(260px,320px)_1fr] xl:grid-cols-[minmax(280px,340px)_1fr_1fr]">
        <div className="space-y-3 lg:row-span-3">
          <PresenceCard status={status} controls={controls} presence={presence} ownerName={ownerName} size={190} />
          <NowCard status={status} controls={controls} />
          <ConnectionsCard controls={controls} />
        </div>
        <TodayCard status={status} />
        <CodeCard onOpen={() => go('projects')} />
        <div className="lg:col-span-1 xl:col-span-2">
          <HomeNews onOpen={() => go('news')} />
        </div>
        <div className="lg:col-span-1 xl:col-span-2">
          <ActivityCard controls={controls} presence={presence} />
        </div>
      </div>
    </div>
  )
}
