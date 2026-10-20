import {
  Brain as BrainIcon,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  ExternalLink,
  Heart,
  Lightbulb,
  MapPin,
  Newspaper,
  RefreshCw,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { BRAIN_KIND_COLOR, BRAIN_KIND_LABEL, BRAIN_KINDS, type BrainKind, type BrainNode, type BrainView, type DailyFind } from '../../shared/brain.ts'
import type { ControlState } from '../../shared/control.ts'
import type { RuntimeStatus, TaskView } from '../../shared/ipc.ts'
import type { WorldSnapshot } from '../../shared/world.ts'
import { Brain, MemoryCard, type BrainMood } from './brain/Brain.tsx'
import { useBrain, type InMind } from './brain/useBrain.ts'
import { ActivityCard, ago, Empty, greetingFor, Panel, STATE_LABEL, TodayCard, useNow, type Presence } from './Jarvis.tsx'
import { useNews } from './News.tsx'
import { Orb, type OrbState } from './ui/Orb.tsx'
import { RemoteImg } from './world/RemoteImg.tsx'

export type HomeTarget = 'today' | 'projects' | 'world' | 'chat' | 'news' | 'learning'

/** What the header and the one-line summary need, kept current by the same events the drawers use. */
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
  return { tasks, world, setWorld }
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
    <div className="flex shrink-0 flex-col justify-center px-1">
      <p className="font-mono text-3xl font-extralight leading-none tracking-wider tabular-nums">
        {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        <span className="text-base text-muted">:{String(date.getSeconds()).padStart(2, '0')}</span>
      </p>
      <p className="mt-1.5 truncate text-[13px] text-muted">
        {date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · {greetingFor(date.getHours())}
        {ownerName ? `, ${ownerName}` : ''}
      </p>
    </div>
  )
}

/** WMO weather codes → an icon. */
const weatherIcon = (code: number): LucideIcon =>
  code === 0 ? Sun : code <= 2 ? CloudSun : code === 3 ? Cloud : code <= 48 ? CloudFog : code <= 57 ? CloudDrizzle : code <= 67 || (code >= 80 && code <= 82) ? CloudRain : code <= 77 || code === 85 || code === 86 ? CloudSnow : code >= 95 ? CloudLightning : Cloud

/** The weather where the owner is (their first watched place); asks for a city when there is none. */
function WeatherTile({ world, ready, onWorld }: { world: WorldSnapshot | null; ready: boolean; onWorld: (w: WorldSnapshot) => void }) {
  const [city, setCity] = useState('')
  const [busy, setBusy] = useState(false)
  const place = world?.places.find(p => p.weather)
  if (!place?.weather)
    return (
      <form
        className="tile flex w-56 shrink-0 flex-col justify-center gap-1.5 px-3 py-2"
        onSubmit={e => {
          e.preventDefault()
          if (!city.trim()) return
          setBusy(true)
          void window.world
            .add(city.trim())
            .then(onWorld)
            .finally(() => setBusy(false))
        }}
      >
        <span className="hud-label flex items-center gap-1">
          <Cloud className="size-3.5" aria-hidden /> Weather
        </span>
        <input value={city} onChange={e => setCity(e.target.value)} disabled={!ready || busy} placeholder={world && !world.places.length ? 'Your city, for the weather' : 'Loading…'} className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-accent" />
      </form>
    )
  const w = place.weather
  const Icon = weatherIcon(w.code)
  const today = w.days[0]
  const tomorrow = w.days[1]
  return (
    <div className="tile flex w-60 shrink-0 items-center gap-3 px-3 py-2" title={`${place.place.name}: ${w.summary}, feels ${Math.round(w.feels)}°, humidity ${w.humidity}%, wind ${Math.round(w.wind)} km/h`}>
      <Icon className="size-9 shrink-0 text-accent drop-shadow-[0_0_10px_var(--accent-soft)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5">
          <span className="font-mono text-2xl font-light leading-none">{Math.round(w.temp)}°</span>
          <span className="truncate text-xs">{w.summary}</span>
        </p>
        <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted">
          <MapPin className="size-3 shrink-0" aria-hidden />
          {place.place.name}
          {today ? ` · ${Math.round(today.max)}°/${Math.round(today.min)}°` : ''}
          {place.air ? ` · AQI ${place.air.aqi}` : ''}
        </p>
        {tomorrow && (
          <p className="truncate text-[10px] text-muted">
            Tomorrow {Math.round(tomorrow.max)}° · {tomorrow.summary.toLowerCase()}
          </p>
        )}
      </div>
    </div>
  )
}

/** Today's find: one true thing from today's world, picked for the owner and told their way. */
function FindTile({ ready }: { ready: boolean }) {
  const [find, setFind] = useState<DailyFind | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const load = (refresh = false) => {
    if (!ready) return
    setBusy(true)
    window.brain
      .find(refresh)
      .then(setFind, () => setFind(null))
      .finally(() => setBusy(false))
  }
  useEffect(() => load(), [ready])
  return (
    <div className="relative min-w-0 flex-1">
      <div className="tile flex h-full items-center gap-3 px-3 py-2">
        {find?.image && <RemoteImg src={find.image} className="size-12 shrink-0 rounded-lg object-cover" />}
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => find && setOpen(o => !o)} disabled={!find}>
          <span className="hud-label flex items-center gap-1 text-warm">
            <Lightbulb className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">Today's find{find ? ` · ${find.title}` : ''}</span>
          </span>
          <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug" dir="auto">
            {find ? find.fact : find === null ? 'Nothing found right now. Try again in a bit.' : 'Finding something for you…'}
          </span>
        </button>
        <button type="button" className="icon-btn size-7 shrink-0" onClick={() => load(true)} disabled={busy || !ready} aria-label="Find another" title="Find another">
          <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden />
        </button>
      </div>
      {open && find && (
        <div className="rise-in glass absolute inset-x-0 top-full z-30 mt-2 rounded-xl p-3 shadow-2xl">
          <p className="text-sm leading-relaxed" dir="auto">
            {find.fact}
          </p>
          {find.why && <p className="mt-2 text-xs text-muted">{find.why}</p>}
          <p className="mt-2 flex items-center gap-3 text-[11px] text-muted">
            <span className="flex-1">{find.source}</span>
            {find.url && (
              <a href={find.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-accent hover:underline">
                Read more <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
            <button type="button" className="text-accent hover:underline" onClick={() => setOpen(false)}>
              Close
            </button>
          </p>
        </div>
      )}
    </div>
  )
}

/** Atlas's face: the orb, its state, and one line on what matters now. */
function Face({ orbState, presence, line, ready }: { orbState: OrbState; presence: Presence; line: string[]; ready: boolean }) {
  return (
    <section className="glass rise-in flex shrink-0 flex-col items-center rounded-2xl px-3 pb-3 pt-2 text-center">
      <span className="hud-label self-start">Atlas</span>
      <Orb state={orbState} level={presence.level} size={112} />
      <p className={`text-sm ${orbState === 'paused' ? 'text-danger' : orbState === 'listening' ? 'text-warm' : 'text-accent'}`}>{STATE_LABEL[orbState]}</p>
      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{!ready ? 'Connect a provider in Settings to begin.' : line.length ? line.join(' · ') : 'All quiet. Nothing needs you right now.'}</p>
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
    <Panel title="In mind now" icon={<Sparkles className="size-3.5" />} aside={items.length ? String(items.length) : undefined} className="min-h-0 flex-1 overflow-y-auto">
      {items.length === 0 ? (
        <Empty>When I use a memory while we talk, it lights up in the brain and shows here.</Empty>
      ) : (
        items.map(r => (
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
      className="min-h-0 flex-1 overflow-y-auto"
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
      {news?.headlines.slice(0, 12).map(h => (
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

const ABOUT_TABS: { key: string; label: string; hint: string; icon: LucideIcon; kinds: BrainKind[] }[] = [
  { key: 'likes', label: 'Likes', hint: 'Tell me what you prefer, and I will do it that way.', icon: Heart, kinds: ['preference'] },
  { key: 'you', label: 'About you', hint: 'Your work, people, places and routines, as you told me.', icon: UserRound, kinds: ['fact'] },
  { key: 'better', label: 'Doing better', hint: 'Lessons from your corrections, and what I noticed.', icon: Lightbulb, kinds: ['lesson', 'observation', 'hypothesis'] },
]

/** Everything Atlas knows about its owner, over the brain: what they like, who they are, how to do better for them. */
function AboutYou({ view, onPick, forget, onClose, openLearning }: { view: BrainView | null; onPick: (n: BrainNode) => void; forget: (id: string) => Promise<void>; onClose: () => void; openLearning: () => void }) {
  const [tab, setTab] = useState(ABOUT_TABS[0]!.key)
  const t = ABOUT_TABS.find(x => x.key === tab)!
  const list = (view?.nodes ?? []).filter(n => t.kinds.includes(n.kind)).sort((a, b) => b.uses - a.uses || b.createdAt - a.createdAt)
  return (
    <div className="rise-in absolute inset-y-3 right-3 z-30 flex w-[min(380px,calc(100%-1.5rem))] flex-col rounded-xl border border-white/10 bg-slate-950/90 text-slate-200 shadow-2xl backdrop-blur">
      <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <UserRound className="size-4 text-sky-300" aria-hidden />
        <h2 className="flex-1 text-sm font-medium">What I know about you</h2>
        <button type="button" className="text-[11px] text-sky-300 hover:underline" onClick={openLearning}>
          Learning →
        </button>
        <button type="button" className="icon-btn size-6" onClick={onClose} aria-label="Close">
          <X className="size-3.5" aria-hidden />
        </button>
      </header>
      <div className="flex gap-1 px-2 pt-2" role="tablist">
        {ABOUT_TABS.map(x => {
          const count = (view?.nodes ?? []).filter(n => x.kinds.includes(n.kind)).length
          return (
            <button
              key={x.key}
              type="button"
              role="tab"
              aria-selected={tab === x.key}
              onClick={() => setTab(x.key)}
              className={`flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-[11px] ${tab === x.key ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              <x.icon className="size-3.5" aria-hidden /> {x.label} <span className="font-mono">{count}</span>
            </button>
          )
        })}
      </div>
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {list.length === 0 && <li className="px-1 text-xs text-slate-400">{t.hint}</li>}
        {list.map(n => (
          <li key={n.id} className="group flex items-start gap-2 rounded-lg px-1.5 py-1 hover:bg-white/5">
            <span className="mt-1.5 size-1.5 shrink-0 rounded-full" style={{ background: BRAIN_KIND_COLOR[n.kind] }} aria-hidden />
            <button type="button" className="min-w-0 flex-1 text-left text-xs leading-snug" onClick={() => onPick(n)} title="Show in the brain">
              {n.text}
              {n.uses > 0 && <span className="ml-1 font-mono text-[10px] text-slate-500">×{n.uses}</span>}
            </button>
            <button type="button" className="icon-btn size-6 opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => void forget(n.id)} aria-label="Forget this" title="Forget this">
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const PICK_EVENT = 'atlas:brain-pick'

/** The brain's stage: the living graph, its legend, the pinned memory and "About you". */
function BrainStage({ brain, mood, ready, openLearning }: { brain: ReturnType<typeof useBrain>; mood: BrainMood; ready: boolean; openLearning: () => void }) {
  const [focus, setFocus] = useState<BrainKind | null>(null)
  const [picked, setPicked] = useState<BrainNode | null>(null)
  const [about, setAbout] = useState(false)
  const [busy, setBusy] = useState(false)
  const view = brain.view
  const counts = useMemo(() => {
    const c = Object.fromEntries(BRAIN_KINDS.map(k => [k, 0])) as Record<BrainKind, number>
    for (const n of view?.nodes ?? []) c[n.kind]++
    return c
  }, [view])
  const memories = (view?.nodes ?? []).filter(n => n.kind !== 'skill').length
  const empty = ready && view !== null && view.nodes.length === 0
  // "In mind now" picks land here too.
  useEffect(() => {
    const on = (e: Event) => {
      setPicked((e as CustomEvent<BrainNode>).detail)
      setAbout(false)
    }
    window.addEventListener(PICK_EVENT, on)
    return () => window.removeEventListener(PICK_EVENT, on)
  }, [])
  return (
    <section className="brain-stage relative flex h-full min-h-[300px] min-w-0 flex-col overflow-hidden rounded-2xl border border-white/10 text-slate-200 shadow-[inset_0_0_80px_rgba(2,6,23,0.9)]">
      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-3">
        <div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-300/80">
            <BrainIcon className="size-3.5" aria-hidden /> Atlas's mind
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-slate-400">{view ? `${memories} memories · ${view.links.length} connections · ${counts.skill} skills` : ready ? 'Waking up…' : 'Offline'}</p>
        </div>
        <button type="button" onClick={() => setAbout(a => !a)} aria-pressed={about} className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/10 bg-slate-950/50 px-2.5 py-1 text-[11px] text-slate-300 hover:text-white">
          <UserRound className="size-3.5" aria-hidden /> About you
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

      {picked && !about && (
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

      {about && (
        <AboutYou
          view={view}
          onPick={n => {
            setPicked(n)
            setAbout(false)
          }}
          forget={brain.forget}
          onClose={() => setAbout(false)}
          openLearning={openLearning}
        />
      )}
    </section>
  )
}

/**
 * Home, one screen: the time, the weather and today's find on top; Atlas's
 * mind in the middle (its real memories as a living brain that fires while it
 * thinks); today's tasks and the news on the left; its face, what it has in
 * mind and what it did on the right. In a narrow pane, the brain alone.
 */
export function Home({ status, controls, presence, ownerName, open }: { status: RuntimeStatus; controls: ControlState | null; presence: Presence; ownerName: string; open: (t: HomeTarget) => void }) {
  const now = useNow(30_000)
  const ready = status.phase === 'ready'
  const { tasks, world, setWorld } = useHomeData(ready)
  const brain = useBrain(ready)
  const orbState: OrbState = controls?.paused ? 'paused' : !ready ? 'offline' : presence.state

  const overdue = (tasks ?? []).filter(t => t.dueAt !== null && t.dueAt < now)
  const next = (tasks ?? []).filter(t => t.dueAt !== null && t.dueAt >= now).sort((a, b) => a.dueAt! - b.dueAt!)[0]
  const alert = world?.places.flatMap(p => p.nearby.map(n => ({ ...n, place: p.place.name }))).sort((a, b) => b.time - a.time)[0]
  const ask = status.approvals[0]
  const line = [
    ask && 'a question is waiting for your yes or no',
    overdue.length ? `${overdue.length} overdue` : next?.dueAt ? `${next.title.split(/[(:—-]/)[0]!.trim()} at ${when(next.dueAt, now)}` : null,
    alert && `${alert.title.split(' · ')[0]} near ${alert.place}`,
  ].filter(Boolean) as string[]

  return (
    <div className="@container flex h-full min-h-0 flex-col gap-3 p-3">
      <header className="flex shrink-0 items-stretch gap-3">
        <Clock ownerName={ownerName} />
        <div className="hidden min-w-0 flex-1 items-stretch gap-3 @min-[720px]:flex">
          <WeatherTile world={world} ready={ready} onWorld={setWorld} />
          <FindTile ready={ready} />
        </div>
        {ask && (
          <button type="button" onClick={() => open('chat')} className="shrink-0 self-center rounded-full border border-warm/40 px-3 py-1 text-xs text-warm hover:bg-warm/10">
            A question is waiting →
          </button>
        )}
      </header>

      <div className="grid min-h-0 flex-1 gap-3 @min-[960px]:grid-cols-[minmax(220px,290px)_1fr_minmax(220px,290px)]">
        <div className="hidden min-h-0 flex-col gap-3 @min-[960px]:flex">
          <div className="max-h-[42%] shrink-0 overflow-y-auto rounded-2xl">
            <TodayCard status={status} />
          </div>
          <MiniNews onOpen={() => open('news')} />
        </div>
        <BrainStage brain={brain} mood={orbState} ready={ready} openLearning={() => open('learning')} />
        <div className="hidden min-h-0 flex-col gap-3 @min-[960px]:flex">
          <Face orbState={orbState} presence={presence} line={line} ready={ready} />
          <InMindCard recent={brain.recent} view={brain.view} onPick={n => window.dispatchEvent(new CustomEvent(PICK_EVENT, { detail: n }))} />
          <div className="max-h-[38%] shrink-0 overflow-y-auto rounded-2xl">
            <ActivityCard controls={controls} presence={presence} />
          </div>
        </div>
      </div>
    </div>
  )
}
