import { Brain as BrainIcon, ChevronDown, Heart, Lightbulb, Newspaper, RefreshCw, Sparkles, Trash2, UserRound, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { BRAIN_KIND_COLOR, BRAIN_KIND_LABEL, BRAIN_KINDS, type BrainKind, type BrainNode, type BrainView } from '../../shared/brain.ts'
import type { ControlState } from '../../shared/control.ts'
import type { RuntimeStatus, TaskView } from '../../shared/ipc.ts'
import type { WorldSnapshot } from '../../shared/world.ts'
import { Brain, MemoryCard, type BrainMood } from './brain/Brain.tsx'
import { useBrain, type InMind } from './brain/useBrain.ts'
import { ActivityCard, ago, Empty, greetingFor, Panel, STATE_LABEL, TodayCard, useNow, type Presence } from './Jarvis.tsx'
import { useNews } from './News.tsx'
import { Orb, type OrbState } from './ui/Orb.tsx'

export type HomeTarget = 'today' | 'projects' | 'world' | 'chat' | 'news' | 'learning'

/** What the one-line summary needs, kept current by the same events the drawers use. */
const useHomeData = (ready: boolean) => {
  const [tasks, setTasks] = useState<TaskView[] | null>(null)
  const [world, setWorld] = useState<WorldSnapshot | null>(null)
  useEffect(() => {
    if (!ready) return
    const loadTasks = () => void window.assistant.listTasks().then(setTasks, () => undefined)
    loadTasks()
    const timer = setInterval(loadTasks, 60_000)
    void window.world.state().then(setWorld, () => undefined)
    const offWorld = window.world.onChanged(setWorld)
    return () => {
      clearInterval(timer)
      offWorld()
    }
  }, [ready])
  return { tasks, world }
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
    <div className="min-w-0">
      <p className="font-mono text-3xl font-extralight tracking-wider tabular-nums">
        {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        <span className="text-base text-muted">:{String(date.getSeconds()).padStart(2, '0')}</span>
      </p>
      <p className="truncate text-sm text-muted">
        {date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · {greetingFor(date.getHours())}
        {ownerName ? `, ${ownerName}` : ''}
      </p>
    </div>
  )
}

/** Atlas's face: the orb, its state, and one line on what matters now. */
function Face({ orbState, presence, line, ready }: { orbState: OrbState; presence: Presence; line: string[]; ready: boolean }) {
  return (
    <section className="glass rise-in flex flex-col items-center rounded-2xl px-3 pb-3 pt-2 text-center">
      <span className="hud-label self-start">Atlas</span>
      <Orb state={orbState} level={presence.level} size={132} />
      <p className={`text-sm ${orbState === 'paused' ? 'text-danger' : orbState === 'listening' ? 'text-warm' : 'text-accent'}`}>{STATE_LABEL[orbState]}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">{!ready ? 'Connect a provider in Settings to begin.' : line.length ? line.join(' · ') : 'All quiet. Nothing needs you right now.'}</p>
    </section>
  )
}

const WHY: Record<InMind['why'], string> = { context: 'recalled', search: 'looked up', saved: 'just learned' }

/** What Atlas has in mind right now: the memories the last turns used. */
function InMindCard({ recent, view, onPick }: { recent: InMind[]; view: BrainView | null; onPick: (n: BrainNode) => void }) {
  const now = useNow(15_000)
  const byId = useMemo(() => new Map((view?.nodes ?? []).map(n => [n.id, n])), [view])
  const items = recent.map(r => ({ ...r, node: byId.get(r.id) })).filter((r): r is InMind & { node: BrainNode } => !!r.node)
  return (
    <Panel title="In mind now" icon={<Sparkles className="size-3.5" />} aside={items.length ? String(items.length) : undefined}>
      {items.length === 0 ? (
        <Empty>When I use a memory while we talk, it lights up in the brain and shows here.</Empty>
      ) : (
        items.slice(0, 6).map(r => (
          <button key={r.id + r.at} type="button" onClick={() => onPick(r.node)} className="flex w-full items-start gap-2 rounded-lg px-1 py-1 text-left hover:bg-surface-strong">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full" style={{ background: BRAIN_KIND_COLOR[r.node.kind], boxShadow: now - r.at < 12_000 ? `0 0 8px ${BRAIN_KIND_COLOR[r.node.kind]}` : undefined }} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-xs">{r.node.text}</span>
              <span className="text-[10px] text-muted">
                {WHY[r.why]} · {ago(r.at, now)}
              </span>
            </span>
          </button>
        ))
      )}
    </Panel>
  )
}

/** The newest headlines as a quiet list. */
function MiniNews({ onOpen }: { onOpen: () => void }) {
  const { news, busy, refresh } = useNews()
  const now = useNow(60_000)
  return (
    <Panel
      title="News"
      icon={<Newspaper className="size-3.5" />}
      aside={
        <span className="flex items-center gap-1">
          <button type="button" className="icon-btn size-6" onClick={() => void refresh()} aria-label="Refresh news" disabled={busy}>
            <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden />
          </button>
          <button type="button" className="text-[11px] text-accent hover:underline" onClick={onOpen}>
            All →
          </button>
        </span>
      }
    >
      {!news && <Empty>Loading the news…</Empty>}
      {news && news.headlines.length === 0 && <Empty>The news is unavailable offline.</Empty>}
      {news?.headlines.slice(0, 6).map(h => (
        <a key={h.id} href={h.link} target="_blank" rel="noreferrer" className="group flex gap-2 rounded-lg px-1 py-1 hover:bg-surface-strong">
          {h.image && <img src={h.image} alt="" loading="lazy" className="size-10 shrink-0 rounded-md object-cover" onError={e => (e.currentTarget.style.display = 'none')} />}
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-xs group-hover:text-accent" dir="auto">
              {h.title}
            </span>
            <span className="block truncate text-[10px] text-muted">
              {h.source}
              {h.publishedAt ? ` · ${ago(h.publishedAt, now)}` : ''}
            </span>
          </span>
        </a>
      ))}
    </Panel>
  )
}

/** The brain's stage: the living graph, its legend and the pinned memory. */
function BrainStage({ brain, mood, ready, picked, setPicked, toAbout }: { brain: ReturnType<typeof useBrain>; mood: BrainMood; ready: boolean; picked: BrainNode | null; setPicked: (n: BrainNode | null) => void; toAbout: () => void }) {
  const [focus, setFocus] = useState<BrainKind | null>(null)
  const [busy, setBusy] = useState(false)
  const view = brain.view
  const counts = useMemo(() => {
    const c = Object.fromEntries(BRAIN_KINDS.map(k => [k, 0])) as Record<BrainKind, number>
    for (const n of view?.nodes ?? []) c[n.kind]++
    return c
  }, [view])
  const memories = (view?.nodes ?? []).filter(n => n.kind !== 'skill').length
  const empty = ready && view !== null && view.nodes.length === 0
  return (
    <section className="brain-stage relative flex h-full min-h-[420px] min-w-0 flex-col overflow-hidden rounded-2xl border border-white/10 text-slate-200 shadow-[inset_0_0_80px_rgba(2,6,23,0.9)]">
      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-3">
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-300/80">
            <BrainIcon className="size-3.5" aria-hidden /> Atlas's mind
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-slate-400">
            {view ? `${memories} memories · ${view.links.length} connections · ${counts.skill} skills` : ready ? 'Waking up…' : 'Offline'}
          </p>
        </div>
        <button type="button" onClick={toAbout} className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/10 bg-slate-950/50 px-2.5 py-1 text-[11px] text-slate-300 hover:text-white">
          <UserRound className="size-3.5" aria-hidden /> About you <ChevronDown className="size-3" aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1">
        <Brain view={view} used={brain.used} born={brain.born} mood={mood} focus={focus} picked={picked?.id ?? null} onPick={setPicked} />
      </div>

      {(empty || brain.error) && (
        <p className="pointer-events-none absolute inset-x-0 bottom-16 mx-auto max-w-sm px-4 text-center text-xs text-slate-400">
          {brain.error ? `I couldn't read my memory: ${brain.error}` : 'My memory is still empty. Tell me about yourself (what you like, how you work) and watch it grow.'}
        </p>
      )}

      {/* The legend: each kind's colour and count; click one to see it alone. */}
      <footer className="absolute inset-x-0 bottom-0 z-10 flex flex-wrap justify-center gap-1.5 p-2.5">
        {BRAIN_KINDS.map(k => (
          <button
            key={k}
            type="button"
            onClick={() => setFocus(f => (f === k ? null : k))}
            aria-pressed={focus === k}
            className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] backdrop-blur transition-colors ${focus === k ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 bg-slate-950/50 text-slate-300 hover:text-white'} ${focus && focus !== k ? 'opacity-50' : ''}`}
          >
            <span className="size-2 rounded-full" style={{ background: BRAIN_KIND_COLOR[k], boxShadow: `0 0 6px ${BRAIN_KIND_COLOR[k]}` }} aria-hidden />
            {BRAIN_KIND_LABEL[k]}
            <span className="font-mono">{counts[k]}</span>
          </button>
        ))}
      </footer>

      {picked && (
        <div className="rise-in absolute right-3 top-14 z-20 w-72 rounded-xl border border-white/10 bg-slate-950/90 p-3 shadow-2xl backdrop-blur">
          <button type="button" className="icon-btn absolute right-1.5 top-1.5 size-6" onClick={() => setPicked(null)} aria-label="Close">
            <X className="size-3.5" aria-hidden />
          </button>
          <MemoryCard node={picked} />
          {picked.kind !== 'skill' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                void brain
                  .forget(picked.id)
                  .then(() => setPicked(null))
                  .finally(() => setBusy(false))
              }}
              className="mt-2.5 flex items-center gap-1 text-[11px] text-danger hover:underline disabled:opacity-50"
            >
              <Trash2 className="size-3.5" aria-hidden /> Forget this
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/** Everything Atlas knows about its owner, grouped: what they like, who they are, how to do better for them. */
function AboutYou({ view, ownerName, onPick, forget, openLearning }: { view: BrainView | null; ownerName: string; onPick: (n: BrainNode) => void; forget: (id: string) => Promise<void>; openLearning: () => void }) {
  const nodes = view?.nodes ?? []
  const groups: { key: string; title: string; hint: string; icon: typeof Heart; kinds: BrainKind[] }[] = [
    { key: 'likes', title: 'What you like', hint: 'Tell me what you prefer, and I will do it that way.', icon: Heart, kinds: ['preference'] },
    { key: 'you', title: ownerName ? `About ${ownerName}` : 'About you', hint: 'Your work, people, places and routines, as you told me.', icon: UserRound, kinds: ['fact'] },
    { key: 'better', title: 'How I can do better for you', hint: 'Lessons from your corrections, and what I noticed.', icon: Lightbulb, kinds: ['lesson', 'observation', 'hypothesis'] },
  ]
  return (
    <section id="about-you" className="mt-3 scroll-mt-3">
      <header className="mb-2 flex items-center gap-2 px-1">
        <h2 className="hud-label flex-1">About you · what I have learned</h2>
        <button type="button" className="text-[11px] text-accent hover:underline" onClick={openLearning}>
          Learning →
        </button>
      </header>
      <div className="grid gap-3 @min-[900px]:grid-cols-3">
        {groups.map(g => {
          const list = nodes.filter(n => g.kinds.includes(n.kind)).sort((a, b) => b.uses - a.uses || b.createdAt - a.createdAt)
          return (
            <Panel key={g.key} title={g.title} icon={<g.icon className="size-3.5" />} aside={String(list.length)}>
              {list.length === 0 && <Empty>{g.hint}</Empty>}
              <ul className="max-h-72 space-y-1 overflow-y-auto pr-1">
                {list.slice(0, 40).map(n => (
                  <li key={n.id} className="group flex items-start gap-2 rounded-lg px-1 py-1 hover:bg-surface-strong">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full" style={{ background: BRAIN_KIND_COLOR[n.kind] }} aria-hidden />
                    <button type="button" className="min-w-0 flex-1 text-left text-xs leading-snug" onClick={() => onPick(n)} title="Show in the brain">
                      {n.text}
                      {n.uses > 0 && <span className="ml-1 font-mono text-[10px] text-muted">×{n.uses}</span>}
                    </button>
                    <button type="button" className="icon-btn size-6 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => void forget(n.id)} aria-label="Forget this" title="Forget this">
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Home: Atlas's mind in the middle (its real memories as a living brain that
 * lights up while it thinks), today's tasks and the news on the left, its
 * face, what it has in mind and what it did on the right, and below, all it
 * has learned about its owner.
 */
export function Home({ status, controls, presence, ownerName, open }: { status: RuntimeStatus; controls: ControlState | null; presence: Presence; ownerName: string; open: (t: HomeTarget) => void }) {
  const now = useNow(30_000)
  const ready = status.phase === 'ready'
  const { tasks, world } = useHomeData(ready)
  const brain = useBrain(ready)
  const [picked, setPicked] = useState<BrainNode | null>(null)
  const orbState: OrbState = controls?.paused ? 'paused' : !ready ? 'offline' : presence.state

  const overdue = (tasks ?? []).filter(t => t.dueAt !== null && t.dueAt < now)
  const next = (tasks ?? []).filter(t => t.dueAt !== null && t.dueAt >= now).sort((a, b) => a.dueAt! - b.dueAt!)[0]
  const alert = world?.places.flatMap(p => p.nearby.map(n => ({ ...n, place: p.place.name }))).sort((a, b) => b.time - a.time)[0]
  const worstAir = world?.places.filter(p => p.air && p.air.aqi > 100).sort((a, b) => b.air!.aqi - a.air!.aqi)[0]
  const ask = status.approvals[0]
  const line = [
    ask && 'a question is waiting for your yes or no',
    overdue.length ? `${overdue.length} overdue` : next?.dueAt ? `${next.title.split(/[(:—-]/)[0]!.trim()} at ${when(next.dueAt, now)}` : null,
    worstAir && `${worstAir.place.name} AQI ${worstAir.air!.aqi}`,
    alert && `${alert.title.split(' · ')[0]} near ${alert.place}`,
  ].filter(Boolean) as string[]

  const toAbout = () => document.getElementById('about-you')?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="@container h-full min-h-0 overflow-y-auto px-3 pt-3">
      <div className="mx-auto max-w-[1600px]">
        <div className="mb-3 flex items-end justify-between gap-3 px-1">
          <Clock ownerName={ownerName} />
          {ask && (
            <button type="button" onClick={() => open('chat')} className="rounded-full border border-warm/40 px-3 py-1 text-xs text-warm hover:bg-warm/10">
              A question is waiting →
            </button>
          )}
        </div>

        {/* Three columns when there is room; the brain first when there is not. */}
        <div className="grid gap-3 @min-[960px]:h-[calc(100vh-13rem)] @min-[960px]:min-h-[560px] @min-[960px]:grid-cols-[minmax(220px,300px)_1fr_minmax(220px,300px)]">
          <div className="order-2 flex min-h-0 flex-col gap-3 @min-[960px]:order-1 @min-[960px]:overflow-y-auto">
            <TodayCard status={status} />
            <MiniNews onOpen={() => open('news')} />
          </div>
          <div className="order-1 flex min-h-0 flex-col @min-[960px]:order-2 @min-[960px]:min-h-0">
            <div className="h-[60vh] min-h-[420px] @min-[960px]:h-full">
              <BrainStage brain={brain} mood={orbState} ready={ready} picked={picked} setPicked={setPicked} toAbout={toAbout} />
            </div>
          </div>
          <div className="order-3 flex min-h-0 flex-col gap-3 @min-[960px]:overflow-y-auto">
            <Face orbState={orbState} presence={presence} line={line} ready={ready} />
            <InMindCard recent={brain.recent} view={brain.view} onPick={setPicked} />
            <ActivityCard controls={controls} presence={presence} />
          </div>
        </div>

        <AboutYou
          view={brain.view}
          ownerName={ownerName}
          onPick={n => {
            setPicked(n)
            document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' })
            document.getElementById('about-you')?.parentElement?.parentElement?.scrollTo({ top: 0, behavior: 'smooth' })
          }}
          forget={brain.forget}
          openLearning={() => open('learning')}
        />
        <div className="h-4" />
      </div>
    </div>
  )
}
