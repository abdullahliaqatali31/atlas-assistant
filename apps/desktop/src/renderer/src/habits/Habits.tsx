/**
 * The Profiles tab: what each browser profile is for, when it is used, and
 * what does not belong where. A day ribbon puts every profile on one 24-hour
 * line; each profile gets a card (its role, time, categories, top sites and a
 * do / keep out / best time guide); a matrix shows who does what; insights
 * say what stands out. All of it comes from the browsers' own history files,
 * read on this PC (main/system/habits.ts), once the owner turns it on.
 */
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, EyeOff, Info, Loader2, Lock, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, MonitorPlay } from 'lucide-react'
import { useEffect, useMemo, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { BrandMark } from '../ui/BrandIcon.tsx'

import {
  bestWorkWindow,
  CATEGORY_LABEL,
  EMPTY_HABITS,
  fmtDuration,
  HABIT_CATEGORIES,
  LEISURE,
  localDay,
  RANGES,
  ROLE_LABEL,
  roleOf,
  WORKISH,
  type HabitCategory,
  type HabitsRange,
  type HabitsView,
  type Insight,
  type ProfileGuide,
  type ProfileHabits,
  type ProfileInfo,
  type ProfileRole,
  type RangeDays,
  type RibbonSegment,
  type WorkHours,
} from '../../../shared/habits.ts'
import { Select } from '../ui/Select.tsx'
import { nameOf, possessive } from '../ui/assistantName.ts'

const RANGE_LABEL: Record<RangeDays, string> = { 1: 'Today', 7: '7 days', 30: '30 days' }
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Category colours as CSS variables: one set per theme (dark by default, light for Daylight). */
const PALETTE = `
.habits-root {
  --cat-work: #3987e5; --cat-video: #d95926; --cat-learning: #199e70; --cat-shopping: #c98500;
  --cat-social: #d55181; --cat-chat: #008300; --cat-ai: #9085e9; --cat-news: #e66767; --cat-other: #5b6475;
  --heat-0: rgb(255 255 255 / 0.04); --heat-1: #104281; --heat-2: #1c5cab; --heat-3: #2a78d6; --heat-4: #5598e7; --heat-5: #9ec5f4;
  --band: rgb(255 255 255 / 0.035);
}
:root[data-theme='daylight'] .habits-root {
  --cat-work: #2a78d6; --cat-video: #eb6834; --cat-learning: #1baf7a; --cat-shopping: #eda100;
  --cat-social: #e87ba4; --cat-chat: #008300; --cat-ai: #6250d6; --cat-news: #e34948; --cat-other: #9aa3b2;
  --heat-0: rgb(0 0 0 / 0.04); --heat-1: #cde2fb; --heat-2: #9ec5f4; --heat-3: #5598e7; --heat-4: #256abf; --heat-5: #0d366b;
  --band: rgb(0 0 0 / 0.035);
}
@keyframes habits-grow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
.habits-grow { transform-origin: left; animation: habits-grow 0.6s cubic-bezier(.2,.8,.2,1) both }
`

const cat = (c: HabitCategory) => `var(--cat-${c})`

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const minLabel = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

// ── tooltip: one for the page, following the pointer ──

interface Tip {
  x: number
  y: number
  body: ReactNode
}
type TipFn = (e: RPointerEvent | null, body?: ReactNode) => void

function TipLayer({ tip }: { tip: Tip | null }) {
  if (!tip) return null
  const left = Math.min(tip.x + 14, window.innerWidth - 260)
  return (
    <div className="pointer-events-none fixed z-[60] max-w-[250px] rounded-lg border border-border bg-solid/95 px-2.5 py-1.5 text-xs text-text shadow-xl backdrop-blur" style={{ left, top: tip.y + 16 }} role="tooltip">
      {tip.body}
    </div>
  )
}

// ── small pieces ──

function Avatar({ p, size = 36 }: { p: Pick<ProfileInfo, 'name' | 'color' | 'picture'>; size?: number }) {
  const style: CSSProperties = { width: size, height: size, boxShadow: `0 0 0 2px ${p.color}, 0 0 14px ${p.color}55` }
  return p.picture ? (
    <img src={p.picture} alt="" className="shrink-0 rounded-full object-cover" style={style} />
  ) : (
    <span className="grid shrink-0 place-items-center rounded-full font-semibold text-white" style={{ ...style, background: p.color, fontSize: size * 0.42 }} aria-hidden>
      {p.name.charAt(0).toUpperCase()}
    </span>
  )
}

function RoleChip({ p }: { p: ProfileHabits }) {
  const role = roleOf(p)
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${p.role ? 'border-accent/50 bg-accent-soft text-accent' : 'border-border text-muted'}`}
      title={p.role ? 'You set this' : `${possessive(nameOf())} guess: ${p.inferred.why}`}
    >
      {!p.role && <Sparkles className="size-2.5" aria-hidden />}
      {p.role ? ROLE_LABEL[role] : `Looks ${ROLE_LABEL[role].toLowerCase()}`}
    </span>
  )
}

/** A stacked bar of categories (2px gaps between segments), with a hover per segment. */
function CategoryBar({ byCategory, total, tip, height = 10 }: { byCategory: Record<HabitCategory, number>; total: number; tip: TipFn; height?: number }) {
  const parts = HABIT_CATEGORIES.filter(c => byCategory[c] / Math.max(1, total) >= 0.01)
  return (
    <div className="habits-grow flex w-full gap-[2px] overflow-hidden rounded-full" style={{ height }} role="img" aria-label={parts.map(c => `${CATEGORY_LABEL[c]} ${Math.round((byCategory[c] / total) * 100)}%`).join(', ')}>
      {parts.map(c => (
        <span
          key={c}
          className="h-full first:rounded-l-full last:rounded-r-full"
          style={{ width: `${(byCategory[c] / total) * 100}%`, background: cat(c) }}
          onPointerMove={e =>
            tip(
              e,
              <>
                <b>{CATEGORY_LABEL[c]}</b> · {fmtDuration(byCategory[c])} ({Math.round((byCategory[c] / total) * 100)}%)
              </>,
            )
          }
          onPointerLeave={() => tip(null)}
        />
      ))}
    </div>
  )
}

function Legend({ cats }: { cats: HabitCategory[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
      {cats.map(c => (
        <li key={c} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: cat(c) }} aria-hidden />
          {CATEGORY_LABEL[c]}
        </li>
      ))}
    </ul>
  )
}

function Stat({ label, value, sub, icon }: { label: string; value: string; sub?: ReactNode; icon: ReactNode }) {
  return (
    <div className="tile flex min-w-0 flex-col gap-1 p-3">
      <span className="hud-label flex items-center gap-1.5 text-muted">
        {icon}
        {label}
      </span>
      <span className="truncate text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
      {sub && <span className="truncate text-xs text-muted">{sub}</span>}
    </div>
  )
}

// ── the day ribbon: every profile on one 24-hour line ──

function DayRibbon({ view, profiles, tip }: { view: HabitsView; profiles: ProfileInfo[]; tip: TipFn }) {
  const days = Object.keys(view.ribbons).sort().reverse()
  const [day, setDay] = useState(days[0] ?? localDay(Date.now()))
  const lanes = view.ribbons[day] ?? {}
  const shown = profiles.filter(p => lanes[p.key]?.length)
  const start = new Date(`${day}T00:00:00`).getTime()
  const isToday = day === localDay(Date.now())
  const pct = (t: number) => `${Math.max(0, Math.min(100, ((t - start) / 86_400_000) * 100))}%`
  const w = view.workHours
  const dayOfWeek = new Date(start).getDay()
  const usedCats = HABIT_CATEGORIES.filter(c => Object.values(lanes).some(segs => segs.some(s => s.cat === c)))
  return (
    <section className="tile space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex items-center gap-2 font-medium">
          <Clock className="size-4 text-accent" aria-hidden /> Your day across profiles
        </h3>
        <div className="ml-auto flex flex-wrap gap-1" role="tablist" aria-label="Day">
          {days.map(d => {
            const date = new Date(`${d}T12:00:00`)
            return (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={d === day}
                onClick={() => setDay(d)}
                className={`rounded-full px-2.5 py-0.5 text-[11px] ${d === day ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-strong hover:text-text'}`}
              >
                {d === localDay(Date.now()) ? 'Today' : `${DAY_NAMES[date.getDay()]} ${date.getDate()}`}
              </button>
            )
          })}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No browsing on this day.</p>
      ) : (
        <div className="relative">
          {/* Hour ticks */}
          <div className="ml-[132px] flex justify-between pb-1 text-[10px] tabular-nums text-muted" aria-hidden>
            {[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => (
              <span key={h} className="w-0 whitespace-nowrap" style={{ transform: 'translateX(-50%)' }}>
                {String(h % 24).padStart(2, '0')}
              </span>
            ))}
          </div>
          <div className="space-y-1.5">
            {shown.map(p => (
              <div key={p.key} className="flex items-center gap-2">
                <div className="flex w-[124px] shrink-0 items-center gap-2" title={`${p.name} · ${p.browser}`}>
                  <Avatar p={p} size={20} />
                  <span className="min-w-0 leading-tight"><span className="block truncate text-xs">{p.name}</span><span className="block truncate text-[9px] text-muted">{p.browser}</span></span>
                </div>
                <div className="relative h-6 flex-1 overflow-hidden rounded-md" style={{ background: 'var(--heat-0)' }}>
                  {w.days.includes(dayOfWeek) && (
                    <div className="absolute inset-y-0" style={{ left: `${(w.start / 1440) * 100}%`, width: `${(((w.end - w.start + 1440) % 1440) / 1440) * 100}%`, background: 'var(--band)', boxShadow: 'inset 1px 0 0 var(--border), inset -1px 0 0 var(--border)' }} aria-hidden />
                  )}
                  {(lanes[p.key] ?? []).map((s: RibbonSegment, i) => (
                    <span
                      key={i}
                      className="absolute inset-y-1 rounded-[3px]"
                      style={{ left: pct(s.start), width: `max(2px, calc(${pct(s.end)} - ${pct(s.start)} - 1px))`, background: cat(s.cat) }}
                      onPointerMove={e =>
                        tip(
                          e,
                          <>
                            <b>{p.name}</b> · {CATEGORY_LABEL[s.cat]}
                            <br />
                            {s.host} · {hhmm(s.start)}-{hhmm(s.end)} ({fmtDuration(s.end - s.start)})
                          </>,
                        )
                      }
                      onPointerLeave={() => tip(null)}
                    />
                  ))}
                  {isToday && <span className="absolute inset-y-0 w-px bg-accent shadow-[0_0_6px_var(--color-accent)]" style={{ left: pct(Date.now()) }} aria-label="Now" />}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <Legend cats={usedCats} />
            <span className="flex items-center gap-1.5 text-[11px] text-muted">
              <span className="h-2.5 w-5 rounded-sm border border-border" style={{ background: 'var(--band)' }} aria-hidden /> Working hours {minLabel(w.start)}-{minLabel(w.end)}
            </span>
          </div>
        </div>
      )}
    </section>
  )
}

// ── one profile ──

function Heat({ p, tip }: { p: ProfileHabits; tip: TipFn }) {
  const max = Math.max(1, ...p.week.flat())
  const step = (ms: number) => (ms <= 0 ? 0 : Math.min(5, 1 + Math.floor((ms / max) * 4.999)))
  return (
    <div>
      <p className="hud-label mb-1.5 text-muted">When it is used (hour by weekday)</p>
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: '28px repeat(24, minmax(0, 1fr))' }}>
        {[1, 2, 3, 4, 5, 6, 0].map(d => (
          <div key={d} className="contents">
            <span className="text-[10px] leading-[14px] text-muted">{DAY_NAMES[d]}</span>
            {p.week[d]!.map((ms, h) => (
              <span
                key={h}
                className="h-[14px] rounded-[3px]"
                style={{ background: `var(--heat-${step(ms)})` }}
                onPointerMove={e =>
                  tip(
                    e,
                    <>
                      {DAY_NAMES[d]} {String(h).padStart(2, '0')}:00 · {fmtDuration(ms)}
                    </>,
                  )
                }
                onPointerLeave={() => tip(null)}
              />
            ))}
          </div>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="text-center text-[9px] tabular-nums text-muted">
            {h % 6 === 0 ? String(h).padStart(2, '0') : ''}
          </span>
        ))}
      </div>
      <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted">
        less
        {[0, 1, 2, 3, 4, 5].map(s => (
          <span key={s} className="size-2.5 rounded-sm" style={{ background: `var(--heat-${s})` }} aria-hidden />
        ))}
        more
      </div>
    </div>
  )
}

function Trend({ p, days, tip }: { p: ProfileHabits; days: number; tip: TipFn }) {
  // Today: hours of the day; longer: one bar per day.
  const bars =
    days === 1
      ? Array.from({ length: 24 }, (_, h) => ({ label: `${String(h).padStart(2, '0')}:00`, ms: p.week.reduce((a, d) => a + d[h]!, 0) }))
      : p.daily.map(d => ({ label: new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric' }), ms: d.ms }))
  const max = Math.max(1, ...bars.map(b => b.ms))
  return (
    <div className="flex h-10 items-end gap-[2px]" role="img" aria-label={`${p.name} time per ${days === 1 ? 'hour' : 'day'}`}>
      {bars.map((b, i) => (
        <span
          key={i}
          className="flex-1 rounded-t-[3px]"
          style={{ height: `${Math.max(b.ms > 0 ? 8 : 3, (b.ms / max) * 100)}%`, background: b.ms > 0 ? 'var(--color-accent)' : 'var(--heat-0)', opacity: b.ms > 0 ? 0.75 : 1 }}
          onPointerMove={e =>
            tip(
              e,
              <>
                {b.label} · {fmtDuration(b.ms)}
              </>,
            )
          }
          onPointerLeave={() => tip(null)}
        />
      ))}
    </div>
  )
}

function ProfileCard({ p, guide, days, tip, onRole, onShare }: { p: ProfileHabits; guide: ProfileGuide | undefined; days: number; tip: TipFn; onRole: (r: ProfileRole | null) => void; onShare: (on: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const maxSite = Math.max(1, ...p.sites.map(s => s.ms))
  const workShare = p.totalMs ? Math.round((p.workHoursMs / p.totalMs) * 100) : 0
  return (
    <article className={`tile relative flex min-w-0 flex-col gap-3 overflow-hidden p-4 ${p.shared ? '' : 'opacity-80'}`}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-16 opacity-25" style={{ background: `linear-gradient(180deg, ${p.color}, transparent)` }} aria-hidden />
      <header className="relative flex items-start gap-3">
        <Avatar p={p} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="truncate font-semibold">{p.name}</h4>
            <RoleChip p={p} />
            {!p.shared && (
              <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted" title="Atlas does not see this profile">
                <EyeOff className="size-2.5" aria-hidden /> hidden from {nameOf()}
              </span>
            )}
          </div>
          <p className="truncate text-[11px] text-muted" title={p.account}>
            <BrandMark id={p.browser} size={11} /> {p.browser}
            {p.account ? ` · ${p.account}` : ''} · last used {ago(p.lastUsed)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xl font-semibold tabular-nums leading-none">{fmtDuration(p.totalMs)}</p>
          <p className="mt-1 text-[10px] text-muted">{workShare}% in work hours</p>
        </div>
      </header>

      <Trend p={p} days={days} tip={tip} />

      <div className="space-y-1.5">
        <CategoryBar byCategory={p.byCategory} total={p.totalMs} tip={tip} />
        <p className="text-[11px] text-muted">
          {HABIT_CATEGORIES.filter(c => p.byCategory[c] > 0)
            .sort((a, b) => p.byCategory[b] - p.byCategory[a])
            .slice(0, 3)
            .map(c => `${CATEGORY_LABEL[c]} ${Math.round((p.byCategory[c] / p.totalMs) * 100)}%`)
            .join(' · ')}
        </p>
      </div>

      <ul className="space-y-1">
        {p.sites.slice(0, 5).map(s => (
          <li key={s.host} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: cat(s.cat) }} aria-hidden />
              <span className="truncate">{s.host}</span>
            </span>
            <span className="tabular-nums text-muted">{fmtDuration(s.ms)}</span>
            <span className="col-span-2 h-1 overflow-hidden rounded-full" style={{ background: 'var(--heat-0)' }}>
              <span className="habits-grow block h-full rounded-full" style={{ width: `${(s.ms / maxSite) * 100}%`, background: cat(s.cat) }} />
            </span>
          </li>
        ))}
      </ul>

      {guide && (guide.doHere.length > 0 || guide.keepOut.length > 0 || guide.bestTime) && (
        <div className="grid gap-2 rounded-xl border border-border p-2.5 text-xs @min-[420px]:grid-cols-3">
          <div>
            <p className="hud-label mb-1 flex items-center gap-1 text-ok">
              <CheckCircle2 className="size-3" aria-hidden /> Do here
            </p>
            <p className="text-muted">{guide.doHere.join(', ') || '—'}</p>
          </div>
          <div>
            <p className="hud-label mb-1 flex items-center gap-1 text-warm">
              <AlertTriangle className="size-3" aria-hidden /> Keep out
            </p>
            <p className="text-muted">{guide.keepOut.join(', ') || 'Nothing stands out'}</p>
          </div>
          <div>
            <p className="hud-label mb-1 flex items-center gap-1 text-accent">
              <Clock className="size-3" aria-hidden /> Best time
            </p>
            <p className="text-muted">{guide.bestTime ?? 'Not enough yet'}</p>
          </div>
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
        <Select
          className="h-7 w-40 text-xs"
          label={`Role of ${p.name}`}
          value={p.role ?? 'auto'}
          onChange={v => onRole(v === 'auto' ? null : (v as ProfileRole))}
          items={[{ value: 'auto', label: `Auto (${ROLE_LABEL[p.inferred.role].toLowerCase()})` }, ...(Object.keys(ROLE_LABEL) as ProfileRole[]).map(r => ({ value: r, label: ROLE_LABEL[r] }))]}
        />
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={p.shared} onChange={e => onShare(e.target.checked)} /> {nameOf()} can see
        </label>
        <button type="button" className="ml-auto flex items-center gap-1 text-xs text-muted hover:text-text" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          Details <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        </button>
      </footer>

      {open && (
        <div className="space-y-4 border-t border-border pt-3">
          <Heat p={p} tip={tip} />
          {p.youtube.length > 0 && (
            <div>
              <p className="hud-label mb-1.5 flex items-center gap-1.5 text-muted">
                <MonitorPlay className="size-3" aria-hidden /> Watched on YouTube
              </p>
              <ul className="space-y-1 text-xs">
                {p.youtube.slice(0, 8).map(y => (
                  <li key={y.title} className="flex gap-2">
                    <span className="min-w-0 flex-1 truncate" title={y.title}>
                      {y.title}
                    </span>
                    <span className="shrink-0 text-muted">{y.count > 1 ? `${y.count}× · ` : ''}{ago(y.at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {p.searches.length > 0 && (
            <div>
              <p className="hud-label mb-1.5 flex items-center gap-1.5 text-muted">
                <Search className="size-3" aria-hidden /> Searched (last 30 days)
              </p>
              <div className="flex flex-wrap gap-1">
                {p.searches.slice(0, 12).map(s => (
                  <span key={s.term} className="max-w-full truncate rounded-full border border-border px-2 py-0.5 text-[11px]">
                    {s.term}
                    {s.count > 1 && <span className="text-muted"> ×{s.count}</span>}
                  </span>
                ))}
              </div>
            </div>
          )}
          <p className="text-[11px] text-muted">Why “{ROLE_LABEL[p.inferred.role].toLowerCase()}”: {p.inferred.why}</p>
        </div>
      )}
    </article>
  )
}

// ── who does what ──

function Matrix({ r, tip }: { r: HabitsRange; tip: TipFn }) {
  const profiles = r.profiles.slice(0, 7)
  const cats = HABIT_CATEGORIES.filter(c => profiles.some(p => p.byCategory[c] > 0))
  const max = Math.max(1, ...profiles.flatMap(p => cats.map(c => p.byCategory[c])))
  return (
    <section className="tile overflow-x-auto p-4">
      <h3 className="mb-3 font-medium">Who does what</h3>
      <table className="w-full border-separate border-spacing-y-1 text-xs">
        <thead>
          <tr>
            <th className="w-28 text-left font-normal text-muted">
              <span className="sr-only">Category</span>
            </th>
            {profiles.map(p => (
              <th key={p.key} className="px-1 pb-1 font-normal" title={`${p.name} · ${p.browser}`}>
                <div className="flex flex-col items-center gap-1">
                  <Avatar p={p} size={22} />
                  <span className="max-w-16 truncate text-[10px] text-muted">{p.name}</span>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cats.map(c => (
            <tr key={c}>
              <th scope="row" className="whitespace-nowrap pr-2 text-left font-normal">
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-sm" style={{ background: cat(c) }} aria-hidden />
                  {CATEGORY_LABEL[c]}
                </span>
              </th>
              {profiles.map(p => {
                const ms = p.byCategory[c]
                const size = ms > 0 ? 6 + Math.sqrt(ms / max) * 22 : 0
                return (
                  <td key={p.key} className="h-8 text-center">
                    {ms > 0 ? (
                      <span
                        className="inline-block rounded-full align-middle"
                        style={{ width: size, height: size, background: cat(c), boxShadow: '0 0 0 2px var(--color-solid)' }}
                        onPointerMove={e =>
                          tip(
                            e,
                            <>
                              <b>{p.name}</b> · {CATEGORY_LABEL[c]}: {fmtDuration(ms)}
                            </>,
                          )
                        }
                        onPointerLeave={() => tip(null)}
                        aria-label={`${p.name}, ${CATEGORY_LABEL[c]}: ${fmtDuration(ms)}`}
                        role="img"
                      />
                    ) : (
                      <span className="text-muted/40" aria-label="none">
                        ·
                      </span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

// ── insights ──

const TONE: Record<Insight['tone'], { icon: ReactNode; label: string; cls: string }> = {
  good: { icon: <CheckCircle2 className="size-4" aria-hidden />, label: 'Good', cls: 'text-ok' },
  warn: { icon: <AlertTriangle className="size-4" aria-hidden />, label: 'Watch', cls: 'text-warm' },
  info: { icon: <Info className="size-4" aria-hidden />, label: 'Note', cls: 'text-accent' },
}

function Insights({ r, profiles }: { r: HabitsRange; profiles: Map<string, ProfileHabits> }) {
  return (
    <section className="tile space-y-2 p-4">
      <h3 className="flex items-center gap-2 font-medium">
        <Sparkles className="size-4 text-accent" aria-hidden /> What stands out
      </h3>
      {r.insights.length === 0 && <p className="text-sm text-muted">Nothing yet: browse a little and it fills in.</p>}
      <ul className="space-y-2">
        {r.insights.map((i, n) => {
          const t = TONE[i.tone]
          const p = i.profile ? profiles.get(i.profile) : undefined
          return (
            <li key={n} className="flex gap-2.5 rounded-xl border border-border bg-surface p-2.5">
              <span className={`mt-0.5 shrink-0 ${t.cls}`} title={t.label}>
                {t.icon}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  <span className="sr-only">{t.label}: </span>
                  {i.title}
                </p>
                <p className="text-xs text-muted">{i.detail}</p>
                {p && (
                  <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted">
                    <Avatar p={p} size={12} /> {p.name}
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ── settings: working hours and which profiles Atlas sees ──

function Settings({ view, onWork }: { view: HabitsView; onWork: (w: WorkHours) => void }) {
  const w = view.workHours
  const times = Array.from({ length: 48 }, (_, i) => ({ value: String(i * 30), label: minLabel(i * 30) }))
  return (
    <section className="tile space-y-4 p-4">
      <div>
        <h3 className="mb-2 font-medium">Working hours</h3>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Select className="h-8 w-28" label="Start" value={String(w.start)} onChange={v => onWork({ ...w, start: Number(v) })} items={times} />
          <span className="text-muted">to</span>
          <Select className="h-8 w-28" label="End" value={String(w.end)} onChange={v => onWork({ ...w, end: Number(v) })} items={times} />
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5, 6, 0].map(d => {
              const on = w.days.includes(d)
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const days = on ? w.days.filter(x => x !== d) : [...w.days, d]
                    if (days.length) onWork({ ...w, days })
                  }}
                  className={`h-8 w-10 rounded-lg border text-xs ${on ? 'border-accent/60 bg-accent-soft text-accent' : 'border-border text-muted hover:text-text'}`}
                >
                  {DAY_NAMES[d]}
                </button>
              )
            })}
          </div>
        </div>
        <p className="mt-1.5 text-xs text-muted">Used to tell work time from your own time, and to spot the personal profile in working hours.</p>
      </div>
      <div>
        <h3 className="mb-2 font-medium">All profiles on this PC ({view.found.length})</h3>
        <ul className="grid gap-1.5 @min-[700px]:grid-cols-2">
          {view.found.map(p => (
            <li key={p.key} className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-xs">
              <Avatar p={p} size={22} />
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  {p.name} <span className="text-muted">· {p.browser}</span>
                </p>
                <p className="truncate text-[10px] text-muted">{p.lastUsed ? `last used ${ago(p.lastUsed)}` : 'not used lately'}</p>
              </div>
              <label className="flex shrink-0 items-center gap-1 text-muted" title="Atlas can see this profile's summary">
                <input type="checkbox" checked={p.shared} onChange={e => void window.habits.setProfile(p.key, { shared: e.target.checked })} /> Atlas
              </label>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

// ── off: what it does, and the switch ──

function Intro({ onOn, busy }: { onOn: () => void; busy: boolean }) {
  const points: [ReactNode, string, string][] = [
    [<Clock key="a" className="size-5" />, 'Every profile on one timeline', 'Personal, business and the rest: which one you use when, hour by hour.'],
    [<Sparkles key="b" className="size-5" />, 'What each profile is for', 'Atlas works out each profile’s role from where its time goes; you can set it yourself.'],
    [<AlertTriangle key="c" className="size-5" />, 'What does not belong where', 'YouTube in the business profile, the personal one in working hours, late nights: and your best work hours.'],
  ]
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-4 py-10 text-center">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-accent/30 blur-2xl" aria-hidden />
        <div className="relative flex -space-x-3">
          {['#38bdf8', '#f472b6', '#a3e635', '#fbbf24'].map((c, i) => (
            <span key={c} className="grid size-12 place-items-center rounded-full border-2 border-solid text-lg font-semibold text-white" style={{ background: c, zIndex: 4 - i }} aria-hidden>
              {['P', 'B', 'W', 'S'][i]}
            </span>
          ))}
        </div>
      </div>
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Your browser profiles, understood</h2>
        <p className="mt-2 text-sm text-muted">Atlas reads the history of your browser profiles (Chrome, Edge, Brave, Comet, Arc, Opera, Vivaldi, Firefox and more) and shows what each one is for, when you use it, and what is out of place.</p>
      </div>
      <div className="grid w-full gap-3 text-left @min-[640px]:grid-cols-3">
        {points.map(([icon, title, text]) => (
          <div key={title} className="tile space-y-1.5 p-3">
            <span className="text-accent">{icon}</span>
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs text-muted">{text}</p>
          </div>
        ))}
      </div>
      <div className="tile flex w-full items-start gap-3 p-3 text-left text-xs text-muted">
        <ShieldCheck className="size-5 shrink-0 text-ok" aria-hidden />
        <p>
          Read on this PC from each browser’s own history file, never uploaded. Incognito is never recorded by the browser, so it never shows here. Atlas only gets a summary, and you can hide any profile from it. Turning this off forgets everything read.
        </p>
      </div>
      <button type="button" className="btn btn-primary h-10 gap-2 px-5" onClick={onOn} disabled={busy}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />} Turn on
      </button>
    </div>
  )
}

export function HabitsPage() {
  const [view, setView] = useState<HabitsView>(EMPTY_HABITS)
  const [loaded, setLoaded] = useState(false)
  const [locked, setLocked] = useState(false)
  const [range, setRange] = useState<RangeDays>(7)
  const [settings, setSettings] = useState(false)
  const [busy, setBusy] = useState(false)
  /** Show only one browser's profiles (from the Browsers strip). */
  const [onlyBrowser, setOnlyBrowser] = useState<string | null>(null)
  const [tip, setTip] = useState<Tip | null>(null)

  useEffect(() => {
    let live = true
    window.habits.state().then(
      v => {
        if (!live) return
        setView(v)
        setLoaded(true)
      },
      () => live && setLocked(true),
    )
    const off = window.habits.onChanged(v => {
      setView(v)
      setLocked(false)
    })
    return () => {
      live = false
      off()
    }
  }, [])

  const showTip: TipFn = (e, body) => setTip(e && body ? { x: e.clientX, y: e.clientY, body } : null)
  // Pictures come once, with the list of every profile; each range's profiles get theirs back here.
  const raw = view.ranges[range]
  const r = useMemo(() => {
    if (!raw) return undefined
    const pics = new Map(view.found.map(f => [f.key, f.picture]))
    return { ...raw, profiles: raw.profiles.map(p => ({ ...p, picture: pics.get(p.key) ?? null })) }
  }, [raw, view.found])
  const byKey = useMemo(() => new Map((r?.profiles ?? []).map(p => [p.key, p])), [r])
  const guides = useMemo(() => new Map((r?.guides ?? []).map(g => [g.key, g])), [r])
  const ribbonProfiles = useMemo(() => {
    const keys = new Set(Object.values(view.ribbons).flatMap(d => Object.keys(d)))
    return view.found.filter(p => keys.has(p.key))
  }, [view])

  const act = async (fn: () => Promise<HabitsView>) => {
    setBusy(true)
    try {
      setView(await fn())
    } finally {
      setBusy(false)
    }
  }

  if (locked)
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-muted">
        <p className="flex items-center gap-2">
          <Lock className="size-4" aria-hidden /> Your browsing is shown to you only: unlock {nameOf()} first.
        </p>
      </div>
    )
  if (!loaded) return null

  return (
    <div className="habits-root h-full overflow-y-auto">
      <style>{PALETTE}</style>
      {!view.enabled ? (
        <Intro onOn={() => void act(() => window.habits.setEnabled(true))} busy={busy} />
      ) : (
        <div className="space-y-3 p-3 @min-[700px]:p-4">
          <header className="flex flex-wrap items-center gap-2">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight">Profiles</h2>
              <p className="text-xs text-muted">
                {view.reading ? (
                  <span className="thinking-dot text-accent">Reading your browsers…</span>
                ) : (
                  <>
                    {r?.profiles.length ?? 0} profile{r?.profiles.length === 1 ? '' : 's'} used {range === 1 ? 'today' : `in ${range} days`}
                    {view.readAt && ` · read ${ago(view.readAt)}`}
                  </>
                )}
                {view.error && <span className="text-danger"> · {view.error}</span>}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-1 rounded-full border border-border bg-surface p-0.5" role="tablist" aria-label="Period">
              {RANGES.map(d => (
                <button key={d} type="button" role="tab" aria-selected={range === d} onClick={() => setRange(d)} className={`rounded-full px-3 py-1 text-xs ${range === d ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'}`}>
                  {RANGE_LABEL[d]}
                </button>
              ))}
            </div>
            <button type="button" className="icon-btn size-8" onClick={() => void act(() => window.habits.refresh())} aria-label="Read again" title="Read again" disabled={busy || view.reading}>
              <RefreshCw className={`size-4 ${view.reading ? 'animate-spin' : ''}`} aria-hidden />
            </button>
            <button type="button" className={`icon-btn size-8 ${settings ? 'text-accent' : ''}`} onClick={() => setSettings(s => !s)} aria-label="Settings" aria-expanded={settings} title="Working hours and profiles">
              <Settings2 className="size-4" aria-hidden />
            </button>
          </header>

          {settings && (
            <>
              <Settings view={view} onWork={w => void act(() => window.habits.setWorkHours(w))} />
              <div className="flex justify-end">
                <button type="button" className="btn h-8 px-3 text-xs" onClick={() => void act(() => window.habits.setEnabled(false))}>
                  Turn off and forget what was read
                </button>
              </div>
            </>
          )}

          {r && <Summary r={r} />}
          {r && r.profiles.length > 0 && <Browsers r={r} only={onlyBrowser} onPick={setOnlyBrowser} />}
          <DayRibbon view={view} profiles={ribbonProfiles} tip={showTip} />

          {r && r.profiles.length > 0 && (
            <div className="grid gap-3 @min-[1000px]:grid-cols-[minmax(0,1fr)_340px]">
              <div className="grid content-start gap-3 @min-[700px]:grid-cols-2">
                {r.profiles.filter(p => !onlyBrowser || p.browser === onlyBrowser).map(p => (
                  <ProfileCard
                    key={p.key}
                    p={p}
                    guide={guides.get(p.key)}
                    days={range}
                    tip={showTip}
                    onRole={role => void act(() => window.habits.setProfile(p.key, { role }))}
                    onShare={shared => void act(() => window.habits.setProfile(p.key, { shared }))}
                  />
                ))}
              </div>
              <div className="space-y-3">
                <Insights r={r} profiles={byKey} />
                <Matrix r={r} tip={showTip} />
              </div>
            </div>
          )}
          {r && r.profiles.length === 0 && !view.reading && <p className="tile p-6 text-center text-sm text-muted">No browsing {range === 1 ? 'today' : `in the last ${range} days`} yet.</p>}
        </div>
      )}
      <TipLayer tip={tip} />
    </div>
  )
}

/** The headline numbers for the period. */
function Summary({ r }: { r: HabitsRange }) {
  const total = r.profiles.reduce((a, p) => a + p.totalMs, 0)
  const leisure = r.profiles.reduce((a, p) => a + [...LEISURE].reduce((b, c) => b + p.byCategory[c], 0), 0)
  const work = r.profiles.reduce((a, p) => a + [...WORKISH].reduce((b, c) => b + p.byCategory[c], 0), 0)
  const top = r.profiles[0]
  const best = bestWorkWindow(r.profiles.filter(p => roleOf(p) === 'work').length ? r.profiles.filter(p => roleOf(p) === 'work') : r.profiles)
  const perDay = r.days > 1 ? ` · ${fmtDuration(total / r.days)} a day` : ''
  return (
    <div className="grid grid-cols-2 gap-3 @min-[800px]:grid-cols-4">
      <Stat icon={<Clock className="size-3" aria-hidden />} label="Browsing" value={fmtDuration(total)} sub={`${r.profiles.length} profiles${perDay}`} />
      <Stat icon={<CheckCircle2 className="size-3" aria-hidden />} label="Purposeful" value={total ? `${Math.round((work / total) * 100)}%` : '—'} sub={`${fmtDuration(work)} work, AI, mail, learning`} />
      <Stat icon={<MonitorPlay className="size-3" aria-hidden />} label="Leisure" value={total ? `${Math.round((leisure / total) * 100)}%` : '—'} sub={`${fmtDuration(leisure)} video, social, shopping`} />
      <Stat
        icon={<Sparkles className="size-3" aria-hidden />}
        label="Best work hours"
        value={best ? `${String(best.from).padStart(2, '0')}-${String(best.to).padStart(2, '0')}` : '—'}
        sub={top ? `Most used: ${top.name}` : undefined}
      />
    </div>
  )
}

/** A browser's mark: its first letter in its own colour. */
const BROWSER_COLOR: Record<string, string> = {
  Chrome: '#4285f4',
  Edge: '#0c8ce9',
  Brave: '#fb542b',
  Comet: '#20808d',
  Arc: '#ff5f5f',
  Opera: '#ff1b2d',
  'Opera GX': '#fa1e4e',
  Vivaldi: '#ef3939',
  Firefox: '#ff7139',
  Zen: '#a78bfa',
  Yandex: '#fc3f1d',
}

/** Every browser used in the period, most used first: time, share and profiles; click one to see only its profiles. */
function Browsers({ r, only, onPick }: { r: HabitsRange; only: string | null; onPick: (b: string | null) => void }) {
  const total = r.profiles.reduce((a, p) => a + p.totalMs, 0)
  const byBrowser = new Map<string, { ms: number; profiles: ProfileHabits[] }>()
  for (const p of r.profiles) {
    const b = byBrowser.get(p.browser) ?? { ms: 0, profiles: [] }
    b.ms += p.totalMs
    b.profiles.push(p)
    byBrowser.set(p.browser, b)
  }
  const list = [...byBrowser].sort((a, b) => b[1].ms - a[1].ms)
  return (
    <section className="tile space-y-2 p-3" aria-label="Browsers">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Browsers</h3>
        <span className="text-xs text-muted">most used first · click one to see only its profiles</span>
        {only && (
          <button type="button" className="ml-auto text-xs text-accent hover:underline" onClick={() => onPick(null)}>
            Show all
          </button>
        )}
      </div>
      <div className="grid gap-2 @min-[700px]:grid-cols-3 @min-[1100px]:grid-cols-5">
        {list.map(([name, b], i) => {
          const share = total ? b.ms / total : 0
          const on = only === name
          return (
            <button
              key={name}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(on ? null : name)}
              className={`flex min-w-0 flex-col gap-1.5 rounded-xl border p-2.5 text-left transition-colors ${on ? 'border-accent bg-accent-soft' : 'border-border hover:border-edge hover:bg-surface-strong'} ${only && !on ? 'opacity-60' : ''}`}
            >
              <span className="flex items-center gap-2">
                <span className="grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white" style={{ background: BROWSER_COLOR[name] ?? '#64748b' }} aria-hidden>
                  {name.charAt(0)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                {i === 0 && <span className="rounded-full bg-accent/15 px-1.5 text-[10px] text-accent">most used</span>}
              </span>
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-lg font-semibold tabular-nums">{fmtDuration(b.ms)}</span>
                <span className="text-xs tabular-nums text-muted">{Math.round(share * 100)}%</span>
              </span>
              <span className="h-1 overflow-hidden rounded-full" style={{ background: 'var(--heat-0)' }}>
                <span className="habits-grow block h-full rounded-full bg-accent" style={{ width: `${Math.max(2, share * 100)}%` }} />
              </span>
              <span className="truncate text-[11px] text-muted">
                {b.profiles.length} profile{b.profiles.length === 1 ? '' : 's'} · {b.profiles.slice(0, 3).map(p => p.name).join(', ')}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
