/**
 * The News canvas: a floating panel on the World map with the story Atlas
 * put there, numbered like the markers. Hover an item to light its marker,
 * click it to fly there and open its card, Play for a tour that visits each
 * one in turn. Folds into a chip; closing it takes the story off the map.
 */
import { ChevronDown, ChevronUp, ExternalLink, Newspaper, Pause, Play, X } from 'lucide-react'
import { useState } from 'react'

import type { Story } from '../../../shared/map.ts'
import { severityColor } from './mapops.ts'

export function NewsCanvas({
  story,
  active,
  playing,
  onFocus,
  onHover,
  onPlay,
  onStop,
  onClose,
}: {
  story: Story
  /** 0-based item the map is on, if any. */
  active: number | null
  playing: boolean
  onFocus: (i: number) => void
  onHover: (i: number | null) => void
  onPlay: () => void
  onStop: () => void
  onClose: () => void
}) {
  const [folded, setFolded] = useState(false)
  if (folded) {
    return (
      <button type="button" className="map-chip pointer-events-auto absolute right-12 top-12 z-10" onClick={() => setFolded(false)} title="Open the News canvas">
        <Newspaper className="size-3.5 text-[#fbbf24]" aria-hidden />
        <span className="max-w-40 truncate">{story.title}</span>
        <span className="font-mono text-[10px] text-muted">{story.items.length}</span>
      </button>
    )
  }
  return (
    <section aria-label={`News canvas: ${story.title}`} className="ask-pop glass pointer-events-auto absolute right-12 top-12 z-10 flex max-h-[calc(100%-8.5rem)] w-[min(320px,calc(100%-4rem))] flex-col overflow-hidden rounded-xl bg-solid/90 shadow-2xl">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Newspaper className="size-4 shrink-0 text-[#fbbf24]" aria-hidden />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={story.title}>
          {story.title}
        </h3>
        <button type="button" className="icon-btn size-7" onClick={playing ? onStop : onPlay} aria-label={playing ? 'Stop the tour' : 'Play a tour of the story'} title={playing ? 'Stop the tour' : 'Tour: visit each item'}>
          {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
        </button>
        <button type="button" className="icon-btn size-7" onClick={() => setFolded(true)} aria-label="Fold the News canvas" title="Fold">
          <ChevronUp className="size-4" aria-hidden />
        </button>
        <button type="button" className="icon-btn size-7" onClick={onClose} aria-label="Close the story" title="Take the story off the map">
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <ol className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
        {story.items.map((it, i) => (
          <li key={`${i}-${it.label}`}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onFocus(i)}
              onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onFocus(i))}
              onMouseEnter={() => onHover(i)}
              onMouseLeave={() => onHover(null)}
              className={`flex cursor-pointer gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface ${active === i ? 'bg-surface ring-1 ring-[#fbbf24]/50' : ''}`}
            >
              <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10px] font-semibold text-[#0b1020]" style={{ background: severityColor(it.severity) }}>
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-xs font-medium leading-snug" dir="auto">
                  {it.label}
                </span>
                {(it.place || it.source) && <span className="block truncate text-[10px] text-muted">{[it.place, it.source].filter(Boolean).join(' · ')}</span>}
                {active === i && it.summary && (
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted" dir="auto">
                    {it.summary}
                  </span>
                )}
              </span>
              {it.url && (
                <a href={it.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="mt-0.5 shrink-0 text-muted hover:text-accent" aria-label={`Open the source of ${it.label}`} title="Source">
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
      {story.links.length > 0 && (
        <footer className="border-t border-border px-3 py-1.5 text-[10px] text-muted">
          <details>
            <summary className="flex cursor-pointer list-none items-center gap-1">
              <ChevronDown className="size-3" aria-hidden /> {story.links.length} connection{story.links.length === 1 ? '' : 's'}
            </summary>
            <ul className="mt-1 space-y-0.5">
              {story.links.map(l => (
                <li key={`${l.from}-${l.to}`}>
                  {l.from} ↔ {l.to}
                  {l.reason ? `: ${l.reason}` : ''}
                </li>
              ))}
            </ul>
          </details>
        </footer>
      )}
    </section>
  )
}
