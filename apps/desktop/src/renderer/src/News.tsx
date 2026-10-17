import { Bookmark, BookmarkCheck, ExternalLink, Newspaper, RefreshCw, Settings2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { CATEGORIES, CATEGORY_LABEL, type Category, type Headline, type NewsResult, type NewsSource, type SavedHeadline } from '../../shared/news.ts'
import { ago, Empty, Panel, useNow } from './Jarvis.tsx'

/** News, loaded once and shared by the home canvas and the News page. */
export const useNews = () => {
  const [news, setNews] = useState<NewsResult | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async (refresh = false) => {
    setBusy(true)
    try {
      setNews(await window.news.list(refresh))
    } catch {
      // Offline: keep whatever is shown.
    } finally {
      setBusy(false)
    }
  }, [])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30 * 60_000)
    const off = window.news.onChanged(setNews)
    return () => {
      clearInterval(t)
      off()
    }
  }, [load])
  return { news, busy, refresh: () => load(true) }
}

const useSaved = () => {
  const [saved, setSaved] = useState<SavedHeadline[]>([])
  useEffect(() => {
    void window.news.saved().then(setSaved, () => undefined)
  }, [])
  const toggle = async (h: Headline) => setSaved(await (saved.some(s => s.id === h.id) ? window.news.unsave(h.id) : window.news.save(h.id)))
  return { saved, toggle, isSaved: (id: string) => saved.some(s => s.id === id) }
}

/** One story: picture, title, summary, source and time, and save. */
export function NewsCard({ h, saved, onToggle, compact = false }: { h: Headline; saved: boolean; onToggle: () => void; compact?: boolean }) {
  const now = useNow(60_000)
  const [broken, setBroken] = useState(false)
  return (
    <article className="tile rise-in group flex min-w-0 flex-col overflow-hidden">
      <a href={h.link} target="_blank" rel="noreferrer" className="block" title="Open the article">
        {h.image && !broken ? (
          <img src={h.image} alt="" loading="lazy" onError={() => setBroken(true)} className={`w-full object-cover ${compact ? 'h-28' : 'h-40'} transition-transform duration-300 group-hover:scale-[1.02]`} />
        ) : (
          <div className={`flex w-full items-center justify-center bg-surface-strong text-muted ${compact ? 'h-16' : 'h-24'}`}>
            <Newspaper className="size-6" aria-hidden />
          </div>
        )}
      </a>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <a href={h.link} target="_blank" rel="noreferrer" className={`font-medium leading-snug hover:text-accent ${compact ? 'line-clamp-2 text-sm' : 'line-clamp-3'}`} dir="auto">
          {h.title}
        </a>
        {!compact && h.summary && (
          <p className="line-clamp-3 text-xs text-muted" dir="auto">
            {h.summary}
          </p>
        )}
        <div className="mt-auto flex items-center gap-2 pt-1 text-[11px] text-muted">
          <span className="truncate">
            {h.source}
            {h.publishedAt ? ` · ${ago(h.publishedAt, now)}` : ''}
          </span>
          <span className="flex-1" />
          <button type="button" className="icon-btn size-7" onClick={onToggle} aria-pressed={saved} aria-label={saved ? 'Remove from saved' : 'Save for later'} title={saved ? 'Saved' : 'Save for later'}>
            {saved ? <BookmarkCheck className="size-4 text-accent" aria-hidden /> : <Bookmark className="size-4" aria-hidden />}
          </button>
        </div>
      </div>
    </article>
  )
}

/** The home canvas strip: the newest stories with pictures. */
export function HomeNews({ onOpen }: { onOpen: () => void }) {
  const { news, busy, refresh } = useNews()
  const { toggle, isSaved } = useSaved()
  const top = (news?.headlines ?? []).filter(h => h.image).slice(0, 4)
  const list = top.length >= 2 ? top : (news?.headlines ?? []).slice(0, 4)
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
            All news →
          </button>
        </span>
      }
    >
      {!news && <Empty>Loading the news…</Empty>}
      {news && news.headlines.length === 0 && <Empty>The news is unavailable offline.</Empty>}
      <div className="grid grid-cols-2 gap-2 2xl:grid-cols-4">
        {list.map(h => (
          <NewsCard key={h.id} h={h} compact saved={isSaved(h.id)} onToggle={() => void toggle(h)} />
        ))}
      </div>
    </Panel>
  )
}

type Tab = 'all' | Category | 'saved'

/** The News page: categories, saved stories and which sources to follow. */
export function NewsPage() {
  const { news, busy, refresh } = useNews()
  const { saved, toggle, isSaved } = useSaved()
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem('news.tab') as Tab | null) ?? 'all'
    } catch {
      return 'all'
    }
  })
  const [sources, setSources] = useState<NewsSource[] | null>(null)
  const [showSources, setShowSources] = useState(false)
  useEffect(() => {
    void window.news.sources().then(setSources, () => undefined)
  }, [])
  const choose = (t: Tab) => {
    setTab(t)
    try {
      localStorage.setItem('news.tab', t)
    } catch {
      // Remembering the tab is a convenience only.
    }
  }
  const list: Headline[] = tab === 'saved' ? saved : (news?.headlines ?? []).filter(h => tab === 'all' || h.category === tab)
  const toggleSource = async (id: string) => {
    if (!sources) return
    const next = sources.map(s => (s.id === id ? { ...s, enabled: !s.enabled } : s))
    setSources(await window.news.setSources(next.filter(s => s.enabled).map(s => s.id)))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="flex flex-wrap rounded-xl border border-border bg-bg p-0.5" role="tablist" aria-label="News categories">
          {(['all', ...CATEGORIES, 'saved'] as Tab[]).map(t => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => choose(t)}
              className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${tab === t ? 'bg-accent-soft text-accent' : 'text-muted hover:text-text'}`}
            >
              {t === 'all' ? 'All' : t === 'saved' ? `Saved (${saved.length})` : CATEGORY_LABEL[t]}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-muted">{news?.fetchedAt ? `Updated ${ago(news.fetchedAt, Date.now())}` : ''}</span>
        <button type="button" className="btn" onClick={() => void refresh()} disabled={busy}>
          <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden /> Refresh
        </button>
        <button type="button" className="btn" aria-expanded={showSources} onClick={() => setShowSources(v => !v)}>
          <Settings2 className="size-3.5" aria-hidden /> Sources
        </button>
      </header>
      {showSources && sources && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 border-b border-border px-4 py-3 text-sm">
          {CATEGORIES.map(c => (
            <div key={c} className="space-y-1">
              <p className="hud-label">{CATEGORY_LABEL[c]}</p>
              {sources
                .filter(s => s.category === c)
                .map(s => (
                  <label key={s.id} className="flex items-center gap-2">
                    <input type="checkbox" checked={s.enabled} onChange={() => void toggleSource(s.id)} />
                    {s.name}
                  </label>
                ))}
            </div>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {!news && tab !== 'saved' && <p className="text-sm text-muted">Loading the news…</p>}
        {list.length === 0 && (news || tab === 'saved') && (
          <p className="pt-10 text-center text-sm text-muted">{tab === 'saved' ? 'Nothing saved yet. Tap the bookmark on a story to keep it here.' : 'No stories here right now.'}</p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {list.map(h => (
            <NewsCard key={h.id} h={h} saved={isSaved(h.id)} onToggle={() => void toggle(h)} />
          ))}
        </div>
        {news && news.failed.length > 0 && tab !== 'saved' && <p className="mt-3 text-[11px] text-muted">Unavailable right now: {news.failed.join(', ')}</p>}
        <p className="mt-4 flex items-center gap-1 text-[11px] text-muted">
          <ExternalLink className="size-3" aria-hidden /> Stories open in your browser. Ask me “aaj ki khabrein?” and I’ll tell you the news.
        </p>
      </div>
    </div>
  )
}
