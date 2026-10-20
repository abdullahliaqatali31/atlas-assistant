/**
 * Atlas's own browser in its window: one <webview> (its own logged-in
 * session) that never reloads when it moves. It is placed over a pane's
 * slot, as a mini view in the corner of the panes, or over the whole stage;
 * hidden, it stays alive out of sight. A glowing frame shows while Atlas is
 * using it. The owner can browse in it too: address bar, back, forward,
 * reload, and the three sizes.
 */
import { ArrowLeft, ArrowRight, Columns2, Loader2, Maximize2, Minimize2, PictureInPicture2, RotateCw, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'

import { BROWSER_HOME, BROWSER_PARTITION, toUrl, type BrowserMode } from '../../../shared/browser.ts'

/** The webview element's methods this page uses. */
interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  isLoading(): boolean
}

/** The pane the browser sits over (found in the page each frame, so it can move between panes). */
export function BrowserSlot() {
  return <div data-browser-slot="" className="h-full w-full" aria-hidden />
}

const MINI = { w: 460, h: 320 }

export function AtlasBrowser({ mode, driving, panes, onMode }: { mode: BrowserMode; driving: boolean; panes: RefObject<HTMLElement | null>; onMode: (m: BrowserMode) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const view = useRef<WebviewEl | null>(null)
  // Made the first time it shows, then kept.
  const [born, setBorn] = useState(mode !== 'hidden')
  const [page, setPage] = useState({ url: '', title: '', loading: false, back: false, forward: false })
  const [address, setAddress] = useState('')
  const editing = useRef(false)
  useEffect(() => {
    if (mode !== 'hidden') setBorn(true)
  }, [mode])

  // Follow the slot (pane) or the panes' corner (mini) every frame while shown: panes resize and move.
  useEffect(() => {
    const el = box.current
    if (!el) return
    if (mode === 'full') {
      Object.assign(el.style, { left: '0px', top: '0px', width: '100%', height: '100%' })
      return
    }
    if (mode === 'hidden') {
      Object.assign(el.style, { left: '-20000px', top: '0px' })
      return
    }
    let raf = 0
    let last = ''
    const place = () => {
      raf = requestAnimationFrame(place)
      const parent = el.offsetParent?.getBoundingClientRect()
      const anchor = mode === 'pane' ? document.querySelector('[data-browser-slot]')?.getBoundingClientRect() : panes.current?.getBoundingClientRect()
      if (!parent || !anchor) return
      let r: { x: number; y: number; w: number; h: number }
      if (mode === 'pane') r = { x: anchor.left - parent.left, y: anchor.top - parent.top, w: anchor.width, h: anchor.height }
      else {
        const w = Math.min(MINI.w, anchor.width * 0.62)
        const h = Math.min(MINI.h, anchor.height * 0.6)
        r = { x: anchor.right - parent.left - w - 14, y: anchor.bottom - parent.top - h - 14, w, h }
      }
      const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`
      if (key === last) return
      last = key
      Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
    }
    place()
    return () => cancelAnimationFrame(raf)
  }, [mode, panes, born])

  // The page's own events keep the toolbar current.
  useEffect(() => {
    const wv = view.current
    if (!wv || !born) return
    const sync = () => {
      try {
        setPage({ url: wv.getURL(), title: wv.getTitle(), loading: wv.isLoading(), back: wv.canGoBack(), forward: wv.canGoForward() })
        if (!editing.current) setAddress(wv.getURL())
      } catch {
        // Not attached yet.
      }
    }
    const events = ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'dom-ready']
    for (const e of events) wv.addEventListener(e, sync)
    return () => {
      for (const e of events) wv.removeEventListener(e, sync)
    }
  }, [born])

  // Esc leaves the full view.
  useEffect(() => {
    if (mode !== 'full') return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onMode('mini')
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [mode, onMode])

  if (!born) return null
  const mini = mode === 'mini'
  const go = () => {
    const url = toUrl(address)
    editing.current = false
    if (url) void view.current?.loadURL(url).catch(() => undefined)
  }
  return (
    <div
      ref={box}
      className={`absolute z-30 flex flex-col overflow-hidden rounded-2xl border bg-slate-950 shadow-2xl transition-[box-shadow,border-color] ${mode === 'hidden' ? 'pointer-events-none invisible' : ''} ${mode === 'full' ? 'z-40' : ''} ${driving ? 'atlas-driving border-sky-400/70' : 'border-white/10'}`}
      role="region"
      aria-label="Atlas's browser"
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 bg-slate-900/90 px-1.5 py-1 text-slate-200">
        <button type="button" className="icon-btn size-7" disabled={!page.back} onClick={() => view.current?.goBack()} aria-label="Back">
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        {!mini && (
          <button type="button" className="icon-btn size-7" disabled={!page.forward} onClick={() => view.current?.goForward()} aria-label="Forward">
            <ArrowRight className="size-4" aria-hidden />
          </button>
        )}
        <button type="button" className="icon-btn size-7" onClick={() => (page.loading ? view.current?.stop() : view.current?.reload())} aria-label={page.loading ? 'Stop' : 'Reload'}>
          {page.loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCw className="size-3.5" aria-hidden />}
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={e => {
            e.preventDefault()
            go()
          }}
        >
          <input
            value={address}
            onChange={e => setAddress(e.target.value)}
            onFocus={e => {
              editing.current = true
              e.currentTarget.select()
            }}
            onBlur={() => {
              editing.current = false
              setAddress(page.url)
            }}
            spellCheck={false}
            placeholder="Search Google or type an address"
            title={page.title}
            className="w-full rounded-full border border-white/10 bg-slate-950/70 px-3 py-1 text-xs text-slate-200 outline-none focus:border-sky-400/60"
          />
        </form>
        {driving && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-sky-400/15 px-2 py-0.5 text-[10px] text-sky-300">
            <Sparkles className="size-3 animate-pulse" aria-hidden /> {mini ? 'Atlas' : 'Atlas is using this'}
          </span>
        )}
        {mode !== 'pane' && (
          <button type="button" className="icon-btn size-7" onClick={() => onMode('pane')} aria-label="Side by side" title="Side by side">
            <Columns2 className="size-3.5" aria-hidden />
          </button>
        )}
        {mode !== 'mini' && (
          <button type="button" className="icon-btn size-7" onClick={() => onMode('mini')} aria-label="Mini view" title="Mini view">
            <PictureInPicture2 className="size-3.5" aria-hidden />
          </button>
        )}
        <button type="button" className="icon-btn size-7" onClick={() => onMode(mode === 'full' ? 'pane' : 'full')} aria-label={mode === 'full' ? 'Leave full view' : 'Full view'} title={mode === 'full' ? 'Leave full view (Esc)' : 'Full view'}>
          {mode === 'full' ? <Minimize2 className="size-3.5" aria-hidden /> : <Maximize2 className="size-3.5" aria-hidden />}
        </button>
        <button type="button" className="icon-btn size-7" onClick={() => onMode('hidden')} aria-label="Put the browser away" title="Put away (the page stays open)">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <webview ref={el => void (view.current = el as unknown as WebviewEl | null)} src={BROWSER_HOME} partition={BROWSER_PARTITION} className="flex min-h-0 w-full flex-1 bg-white" />
    </div>
  )
}
