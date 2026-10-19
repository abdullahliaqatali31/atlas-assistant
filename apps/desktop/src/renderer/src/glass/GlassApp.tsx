import { ArrowLeft, ArrowUpRight, File, FileText, Film, FolderOpen, Image as ImageIcon, MapPin, Music, Newspaper, Search, StickyNote, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'

import type { GlassAlign, GlassFile, GlassView } from '../../../shared/glass.ts'
import { CATEGORY_LABEL, type Headline } from '../../../shared/news.ts'
import { Markdown } from '../ui/Markdown.tsx'
import { BASE_URL } from '../world/styles.ts'

// The map library is big: loaded in the background soon after the panel starts, so the first map opens quickly.
const loadMap = () => import('./MiniMap.tsx')
const MiniMap = lazy(loadMap)

/**
 * Smoky card behind text: dense enough that whatever window is behind never
 * fights the words (Windows cannot blur behind a see-through window), light
 * enough that the desktop still glows through. Pictures and gaps stay clear.
 */
const SMOKE = 'neon-glass'

const ago = (t: number | null) => {
  if (!t) return ''
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

const ICON = { news: Newspaper, story: Newspaper, map: MapPin, note: StickyNote, files: Search }

/** Fades and lifts in, one after another. */
const Rise = ({ i, children, className = '' }: { i: number; children: ReactNode; className?: string }) => (
  <div className={`rise-in ${className}`} style={{ animationDelay: `${Math.min(i, 8) * 45}ms`, animationFillMode: 'both' }}>
    {children}
  </div>
)

/**
 * The glass panel's page. The window itself is invisible: only the floating
 * pieces are drawn, each marked data-solid; everywhere else the desktop shows
 * and clicks fall through to it. Content hugs the edge nearest the widget.
 */
export function GlassApp() {
  const [view, setView] = useState<GlassView | null>(null)
  const [align, setAlign] = useState<GlassAlign>('bottom')
  // Once made, the map stays (hidden while another view shows): the next map just flies there.
  const [lastMap, setLastMap] = useState<Extract<GlassView, { kind: 'map' }> | null>(null)
  useEffect(() => {
    if (view?.kind === 'map') setLastMap(view)
  }, [view])
  // Warm up while idle: the map code, and the map style in the HTTP cache.
  useEffect(() => {
    const t = setTimeout(() => {
      void loadMap().catch(() => undefined)
      void fetch(BASE_URL.dark).catch(() => undefined)
    }, 1_500)
    return () => clearTimeout(t)
  }, [])
  const solid = useRef(false)

  useEffect(
    () =>
      window.glass.onView((v, a) => {
        setView(v)
        setAlign(a)
      }),
    [],
  )
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && void window.glass.close()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  // Over a card the panel takes the click; over see-through space the desktop does.
  const track = (target: EventTarget | null) => {
    const over = target instanceof Element && Boolean(target.closest('[data-solid]'))
    if (over === solid.current) return
    solid.current = over
    window.glass.hit(over)
  }

  const title = !view ? '' : view.kind === 'story' ? (view.n && view.of ? `Story ${view.n} of ${view.of}` : 'Story') : view.kind === 'news' ? view.title : view.title || (view.kind === 'map' ? 'Map' : 'Note')
  const Icon = view ? ICON[view.kind] : Newspaper

  return (
    <div
      className={`flex h-full flex-col gap-2.5 p-4 text-white ${align === 'bottom' ? 'justify-end' : 'justify-start'}`}
      onMouseMove={e => track(e.target)}
      onMouseLeave={() => track(null)}
    >
      {view && (
        <>
          <Rise i={0} className="shrink-0">
            <header data-solid className={`flex h-10 items-center gap-2 rounded-full pl-2 pr-1.5 ${SMOKE}`}>
              {view.kind === 'story' && view.n ? (
                <button type="button" className="grid size-7 place-items-center rounded-full text-white/80 hover:bg-white/10 hover:text-white" onClick={() => void window.glass.back()} aria-label="Back to the list" title="Back to the list">
                  <ArrowLeft className="size-4" aria-hidden />
                </button>
              ) : (
                <span className="grid size-7 place-items-center rounded-full bg-accent/25 text-accent">
                  <Icon className="size-3.5" aria-hidden />
                </span>
              )}
              <h1 className="min-w-0 flex-1 truncate text-[13px] font-medium tracking-wide">{title}</h1>
              <button type="button" className="grid size-7 place-items-center rounded-full text-white/70 hover:bg-white/10 hover:text-white" onClick={() => void window.glass.close()} aria-label="Put away (Esc)" title="Put away (Esc)">
                <X className="size-4" aria-hidden />
              </button>
            </header>
          </Rise>
          {view.kind !== 'map' && (
          <main key={`${view.kind}:${view.kind === 'story' ? view.item.id : ''}`} className="glass-scroll -mx-3 -my-2 min-h-0 overflow-y-auto px-3 py-2">
            {view.kind === 'news' ? (
              <NewsList items={view.items} />
            ) : view.kind === 'story' ? (
              <Story item={view.item} />
            ) : view.kind === 'files' ? (
              <FileList items={view.items} />
            ) : (
              <Rise i={1}>
                <div data-solid className={`rounded-2xl p-4 text-sm leading-relaxed ${SMOKE}`}>
                  <Markdown text={view.text} />
                </div>
              </Rise>
            )}
          </main>
          )}
        </>
      )}
      {lastMap && (
        <div className={view?.kind === 'map' ? 'rise-in min-h-0 flex-1' : 'hidden'}>
          <div data-solid className="neon-glass frame h-full overflow-hidden rounded-2xl">
            <Suspense fallback={<div className={`grid h-full place-items-center text-xs text-white/70 ${SMOKE}`}>Loading the map…</div>}>
              <MiniMap lat={lastMap.lat} lon={lastMap.lon} zoom={lastMap.zoom} pins={lastMap.pins} visible={view?.kind === 'map'} />
            </Suspense>
          </div>
        </div>
      )}
    </div>
  )
}

function NewsList({ items }: { items: Headline[] }) {
  if (!items.length)
    return (
      <div data-solid className={`rounded-2xl p-4 text-sm text-white/80 ${SMOKE}`}>
        No headlines right now. The feeds may still be loading; ask again in a moment.
      </div>
    )
  return (
    <ol className="space-y-2.5 p-0.5">
      {items.map((h, i) => (
        <li key={h.id}>
          <Rise i={i + 1}>
            <button
              type="button"
              data-solid
              onClick={() => void window.glass.story(i + 1)}
              className={`lively group flex w-full items-center gap-3 rounded-2xl p-2 text-left hover:-translate-y-0.5 ${SMOKE}`}
            >
              <span className="relative shrink-0">
                {h.image ? (
                  <img src={h.image} alt="" className="h-[68px] w-[100px] rounded-xl object-cover" />
                ) : (
                  <span className="grid h-[68px] w-[100px] place-items-center rounded-xl bg-white/8 text-white/50">
                    <Newspaper className="size-5" aria-hidden />
                  </span>
                )}
                <span className="absolute left-1 top-1 grid size-5 place-items-center rounded-full bg-black/70 text-[10px] font-semibold text-white ring-1 ring-white/20">{i + 1}</span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-[13px] font-medium leading-snug text-white group-hover:text-accent" dir="auto">
                  {h.title}
                </span>
                <span className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-white/60">
                  <span className="truncate">{h.source}</span>
                  <span aria-hidden>·</span>
                  <span>{ago(h.publishedAt)}</span>
                </span>
              </span>
            </button>
          </Rise>
        </li>
      ))}
    </ol>
  )
}

function Story({ item }: { item: Headline }) {
  const meta = [item.source, CATEGORY_LABEL[item.category], ago(item.publishedAt)].filter(Boolean).join(' · ')
  return (
    <article className="space-y-2">
      <Rise i={1}>
        {item.image ? (
          // The picture carries the headline: title over a soft dark fade at its foot.
          <div data-solid className="neon-glass frame overflow-hidden rounded-2xl">
            <img src={item.image} alt="" className="aspect-[16/10] w-full object-cover" />
            <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/90 via-black/55 to-transparent px-4 pb-3 pt-16">
              <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/70">{meta}</p>
              <h2 className="mt-1 text-lg font-semibold leading-snug text-white" dir="auto">
                {item.title}
              </h2>
            </div>
          </div>
        ) : (
          <div data-solid className={`rounded-2xl px-4 py-3 ${SMOKE}`}>
            <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-white/60">{meta}</p>
            <h2 className="mt-1 text-lg font-semibold leading-snug" dir="auto">
              {item.title}
            </h2>
          </div>
        )}
      </Rise>
      <Rise i={2}>
        <div data-solid className={`rounded-2xl px-4 py-3 ${SMOKE}`}>
          {item.summary && (
            <p className="text-[13.5px] leading-relaxed text-white/90" dir="auto">
              {item.summary}
            </p>
          )}
          <button type="button" onClick={() => void window.glass.openLink(item.link)} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full bg-accent/90 px-3.5 text-xs font-medium text-accent-fg transition hover:bg-accent">
            Read the full article <ArrowUpRight className="size-3.5" aria-hidden />
          </button>
        </div>
      </Rise>
    </article>
  )
}

const KIND_ICON = (k: string) => (/picture/.test(k) ? ImageIcon : /video/.test(k) ? Film : /music/.test(k) ? Music : /folder/.test(k) ? FolderOpen : /document|text/.test(k) ? FileText : File)

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : b ? `${b} B` : '')

/** What the courier brought: Windows' own thumbnails, where it lives, one click to open or show in its folder. */
function FileList({ items }: { items: GlassFile[] }) {
  return (
    <ol className="space-y-2.5 p-0.5">
      {items.map((f, i) => {
        const Icon = KIND_ICON(f.kind)
        return (
          <li key={f.path}>
            <Rise i={i + 1}>
              <div data-solid className={`lively group flex items-center gap-3 rounded-2xl p-2 ${SMOKE}`}>
                <button type="button" onClick={() => void window.glass.openFile(f.path)} className="shrink-0" title="Open">
                  {f.thumb ? (
                    <img src={f.thumb} alt="" className="size-16 rounded-xl bg-black/30 object-cover" />
                  ) : (
                    <span className="grid size-16 place-items-center rounded-xl bg-white/8 text-accent">
                      <Icon className="size-6" aria-hidden />
                    </span>
                  )}
                </button>
                <button type="button" onClick={() => void window.glass.openFile(f.path)} className="min-w-0 flex-1 text-left" title={f.path}>
                  <span className="line-clamp-2 text-[13px] font-medium leading-snug text-white group-hover:text-accent" dir="auto">
                    {f.name}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-white/55">{f.folder}</span>
                  <span className="block text-[10px] text-white/45">{[f.modified ? new Date(f.modified).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '', size(f.size), f.kind].filter(Boolean).join(' · ')}</span>
                </button>
                <button type="button" onClick={() => void window.glass.revealFile(f.path)} className="grid size-8 shrink-0 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white" title="Show in its folder" aria-label="Show in its folder">
                  <FolderOpen className="size-4" aria-hidden />
                </button>
              </div>
            </Rise>
          </li>
        )
      })}
    </ol>
  )
}
