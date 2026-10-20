/**
 * Atlas's own browser in its window, with tabs. Main keeps the tab list
 * (pinned tabs, colour groups, which one shows); this page draws one
 * <webview> per awake tab (its own logged-in session) and tells main which
 * page is which tab. Tabs not used lately sleep and load again when opened.
 * The browser sits over a pane's slot, as a mini view in the corner of the
 * panes, or over the whole stage; hidden, it stays alive out of sight. A
 * glowing frame shows while Atlas is using it. The owner browses in it too:
 * tab strip (right-click a tab to pin or group it), address bar, back,
 * forward, reload, and the three sizes.
 */
import { ArrowLeft, ArrowRight, Columns2, Loader2, Maximize2, Minimize2, PictureInPicture2, Pin, Plus, RotateCw, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'

import { AWAKE_TABS, BROWSER_PARTITION, EMPTY_TABS, orderTabs, toUrl, type BrowserMode, type BrowserTab, type BrowserTabsState, type TabAction } from '../../../shared/browser.ts'
import { nameOf } from '../ui/assistantName.ts'

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
  getWebContentsId(): number
}

/** The pane the browser sits over (found in the page each frame, so it can move between panes). */
export function BrowserSlot() {
  return <div data-browser-slot="" className="h-full w-full" aria-hidden />
}

const MINI = { w: 460, h: 320 }

const act = (a: TabAction) => void window.atlasTabs.act(a).catch(() => undefined)

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** One tab's page. Its address is set once (later navigation is the page's own); it reports in to main. */
function TabPage({ tab, shown, onEl }: { tab: BrowserTab; shown: boolean; onEl: (id: string, el: WebviewEl | null) => void }) {
  const ref = useRef<WebviewEl | null>(null)
  const [src] = useState(tab.url)
  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    let told = false
    const ready = () => {
      try {
        if (!told) window.atlasTabs.report({ id: tab.id, wcId: wv.getWebContentsId() })
        told = true
      } catch {
        // Not attached yet.
      }
    }
    const page = () => {
      try {
        window.atlasTabs.report({ id: tab.id, url: wv.getURL(), title: wv.getTitle() })
      } catch {
        // Not attached yet.
      }
    }
    const events = ['did-navigate', 'did-navigate-in-page', 'page-title-updated']
    wv.addEventListener('dom-ready', ready)
    for (const e of events) wv.addEventListener(e, page)
    return () => {
      wv.removeEventListener('dom-ready', ready)
      for (const e of events) wv.removeEventListener(e, page)
    }
  }, [tab.id])
  // A steady ref: a new one each render would detach and attach the page over and over.
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      ref.current = el as unknown as WebviewEl | null
      onEl(tab.id, ref.current)
    },
    [tab.id, onEl],
  )
  return (
    <webview
      ref={setRef}
      src={src}
      partition={BROWSER_PARTITION}
      className={`absolute inset-0 flex bg-white ${shown ? '' : 'pointer-events-none invisible'}`}
    />
  )
}

/** The site's own name's first letter (wikipedia, not "en"). */
const siteLetter = (url: string) => {
  const parts = hostOf(url).split('.')
  return (parts.length > 1 ? parts[parts.length - 2]! : parts[0]!).charAt(0)
}

interface Menu {
  x: number
  y: number
  tab: BrowserTab
}

/** The strip of tabs: pinned first, then each colour group (click its name to fold it), then the rest. */
function TabStrip({ state }: { state: BrowserTabsState }) {
  const [menu, setMenu] = useState<Menu | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [wantRename, setWantRename] = useState<string | null>(null)
  const order = orderTabs(state)
  const groups = new Map(state.groups.map(g => [g.id, g]))

  // A group just made from the menu opens for naming once it arrives.
  useEffect(() => {
    if (!wantRename) return
    const g = state.groups.find(x => x.name === wantRename)
    if (g) {
      setRenaming(g.id)
      setWantRename(null)
    }
  }, [state.groups, wantRename])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const items: ReactNode[] = []
  let lastGroup: string | null = null
  for (const t of order) {
    const g = t.group ? groups.get(t.group) : undefined
    if (g && g.id !== lastGroup) {
      items.push(
        renaming === g.id ? (
          <input
            key={`g-${g.id}`}
            autoFocus
            defaultValue={g.name}
            onBlur={e => {
              const name = e.currentTarget.value.trim()
              if (name && name !== g.name) act({ kind: 'group-rename', group: g.id, name })
              setRenaming(null)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setRenaming(null)
            }}
            className="w-24 shrink-0 rounded-md border bg-slate-950 px-1.5 py-0.5 text-[11px] text-slate-100 outline-none"
            style={{ borderColor: g.color }}
          />
        ) : (
          <button
            key={`g-${g.id}`}
            type="button"
            onClick={() => act({ kind: 'group-collapse', group: g.id, collapsed: !g.collapsed })}
            onDoubleClick={() => setRenaming(g.id)}
            title={`${g.name}: click to ${g.collapsed ? 'open' : 'fold'}, double-click to rename`}
            className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold text-slate-950"
            style={{ background: g.color }}
          >
            {g.name}
            {g.collapsed && <span className="ml-1 opacity-70">{state.tabs.filter(x => x.group === g.id).length}</span>}
          </button>
        ),
      )
    }
    lastGroup = g?.id ?? null
    if (g?.collapsed) continue
    const active = t.id === state.active
    const label = t.title || hostOf(t.url)
    items.push(
      <div
        key={t.id}
        role="tab"
        aria-selected={active}
        tabIndex={0}
        title={`${label}\n${t.url}${t.byAtlas ? '\nOpened by Atlas' : ''}`}
        onClick={() => act({ kind: 'activate', id: t.id })}
        onAuxClick={e => e.button === 1 && act({ kind: 'close', ids: [t.id] })}
        onKeyDown={e => e.key === 'Enter' && act({ kind: 'activate', id: t.id })}
        onContextMenu={e => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, tab: t })
        }}
        className={`group/tab relative flex shrink-0 cursor-default items-center gap-1.5 rounded-t-lg px-2 py-1 text-[11px] ${t.pinned ? '' : 'w-36'} ${active ? 'bg-slate-950 text-slate-100' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`}
        style={g ? { boxShadow: `inset 0 -2px 0 ${g.color}` } : undefined}
      >
        <span className="grid size-4 shrink-0 place-items-center rounded bg-white/10 text-[9px] font-bold uppercase">{siteLetter(t.url)}</span>
        {!t.pinned && <span className="min-w-0 flex-1 truncate">{label}</span>}
        {t.byAtlas && !t.pinned && <Sparkles className="size-2.5 shrink-0 text-sky-300/80" aria-label="Opened by Atlas" />}
        {!t.pinned && (
          <button
            type="button"
            className={`grid size-4 shrink-0 place-items-center rounded hover:bg-white/15 ${active ? '' : 'invisible group-hover/tab:visible'}`}
            onClick={e => {
              e.stopPropagation()
              act({ kind: 'close', ids: [t.id] })
            }}
            aria-label={`Close ${label}`}
          >
            <X className="size-3" aria-hidden />
          </button>
        )}
      </div>,
    )
  }

  const m = menu
  const entry = (text: string, run: () => void) => (
    <button
      type="button"
      className="block w-full rounded px-2.5 py-1 text-left text-xs text-slate-200 hover:bg-white/10"
      onPointerDown={e => e.stopPropagation()}
      onClick={() => {
        run()
        setMenu(null)
      }}
    >
      {text}
    </button>
  )
  return (
    <div className="flex shrink-0 items-end gap-0.5 overflow-x-auto bg-slate-900/95 px-1.5 pt-1 [scrollbar-width:none]" role="tablist" aria-label="Browser tabs">
      {items}
      <button type="button" className="icon-btn mb-0.5 size-6 shrink-0" onClick={() => act({ kind: 'new' })} aria-label="New tab" title="New tab">
        <Plus className="size-3.5" aria-hidden />
      </button>
      {m && (
        <div className="fixed z-50 min-w-44 rounded-lg border border-white/10 bg-slate-900 p-1 shadow-2xl" style={{ left: m.x, top: m.y }} onPointerDown={e => e.stopPropagation()} role="menu">
          {entry(m.tab.pinned ? 'Unpin' : 'Pin', () => act({ kind: 'pin', id: m.tab.id, pinned: !m.tab.pinned }))}
          {entry('Add to a new group', () => {
            const name = `Group ${state.groups.length + 1}`
            act({ kind: 'group', ids: [m.tab.id], group: null, name })
            setWantRename(name)
          })}
          {state.groups
            .filter(g => g.id !== m.tab.group)
            .map(g => (
              <div key={g.id}>{entry(`Move to "${g.name}"`, () => act({ kind: 'group', ids: [m.tab.id], group: g.id }))}</div>
            ))}
          {m.tab.group && entry('Remove from group', () => act({ kind: 'group', ids: [m.tab.id], group: null }))}
          <div className="my-1 h-px bg-white/10" />
          {entry('Close', () => act({ kind: 'close', ids: [m.tab.id] }))}
          {entry('Close other tabs (keeps pinned)', () => act({ kind: 'close-others', id: m.tab.id }))}
        </div>
      )}
    </div>
  )
}

export function AtlasBrowser({ mode, driving, panes, onMode }: { mode: BrowserMode; driving: boolean; panes: RefObject<HTMLElement | null>; onMode: (m: BrowserMode) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const views = useRef(new Map<string, WebviewEl>())
  const [viewsVersion, setViewsVersion] = useState(0)
  // Made the first time it shows, then kept.
  const [born, setBorn] = useState(mode !== 'hidden')
  const [tabs, setTabs] = useState<BrowserTabsState | null>(null)
  // Tabs with a live page, most recently shown first.
  const [awake, setAwake] = useState<string[]>([])
  const [page, setPage] = useState({ url: '', title: '', loading: false, back: false, forward: false })
  const [address, setAddress] = useState('')
  const editing = useRef(false)
  useEffect(() => {
    if (mode !== 'hidden') setBorn(true)
  }, [mode])

  useEffect(() => {
    let live = true
    void window.atlasTabs.get().then(s => live && setTabs(s))
    const off = window.atlasTabs.onState(setTabs)
    return () => {
      live = false
      off()
    }
  }, [])

  const state = tabs ?? EMPTY_TABS
  // Shown with no tabs at all: start one.
  const asked = useRef(false)
  useEffect(() => {
    if (!born || !tabs || tabs.tabs.length || mode === 'hidden' || asked.current) return
    asked.current = true
    act({ kind: 'new' })
  }, [born, tabs, mode])
  useEffect(() => {
    if (tabs?.tabs.length) asked.current = false
  }, [tabs])

  // The tab shown wakes; the longest-unshown sleep past the limit; closed tabs go.
  useEffect(() => {
    if (!born) return
    setAwake(prev => {
      const ids = new Set(state.tabs.map(t => t.id))
      const next = [...(state.active ? [state.active] : []), ...prev.filter(id => id !== state.active && ids.has(id))].slice(0, AWAKE_TABS)
      return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next
    })
  }, [born, state.active, state.tabs])

  const onEl = useMemo(
    () => (id: string, el: WebviewEl | null) => {
      const had = views.current.get(id)
      if (el) views.current.set(id, el)
      else views.current.delete(id)
      if (had !== (el ?? undefined)) setViewsVersion(v => v + 1)
    },
    [],
  )

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

  // The shown tab's own events keep the toolbar current.
  const activeView = state.active ? views.current.get(state.active) : undefined
  useEffect(() => {
    const wv = activeView
    const tab = state.tabs.find(t => t.id === state.active)
    if (!wv) {
      setPage({ url: tab?.url ?? '', title: tab?.title ?? '', loading: false, back: false, forward: false })
      if (!editing.current) setAddress(tab?.url ?? '')
      return
    }
    const sync = () => {
      try {
        setPage({ url: wv.getURL(), title: wv.getTitle(), loading: wv.isLoading(), back: wv.canGoBack(), forward: wv.canGoForward() })
        if (!editing.current) setAddress(wv.getURL())
      } catch {
        // Not attached yet.
      }
    }
    sync()
    const events = ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'dom-ready']
    for (const e of events) wv.addEventListener(e, sync)
    return () => {
      for (const e of events) wv.removeEventListener(e, sync)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the tab's saved address only matters when it has no page yet
  }, [activeView, viewsVersion, state.active])

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
    if (!url) return
    if (activeView) void activeView.loadURL(url).catch(() => undefined)
    else act({ kind: 'new', url })
  }
  const shownTab = state.tabs.find(t => t.id === state.active)
  return (
    <div
      ref={box}
      className={`absolute z-30 flex flex-col overflow-hidden rounded-2xl border bg-slate-950 shadow-2xl transition-[box-shadow,border-color] ${mode === 'hidden' ? 'pointer-events-none invisible' : ''} ${mode === 'full' ? 'z-40' : ''} ${driving ? 'atlas-driving border-sky-400/70' : 'border-white/10'}`}
      role="region"
      aria-label="Atlas's browser"
    >
      {!mini && <TabStrip state={state} />}
      <div className="flex shrink-0 items-center gap-1 border-b border-white/10 bg-slate-950 px-1.5 py-1 text-slate-200">
        <button type="button" className="icon-btn size-7" disabled={!page.back} onClick={() => activeView?.goBack()} aria-label="Back">
          <ArrowLeft className="size-4" aria-hidden />
        </button>
        {!mini && (
          <button type="button" className="icon-btn size-7" disabled={!page.forward} onClick={() => activeView?.goForward()} aria-label="Forward">
            <ArrowRight className="size-4" aria-hidden />
          </button>
        )}
        <button type="button" className="icon-btn size-7" onClick={() => (page.loading ? activeView?.stop() : activeView?.reload())} aria-label={page.loading ? 'Stop' : 'Reload'}>
          {page.loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCw className="size-3.5" aria-hidden />}
        </button>
        {mini && state.tabs.length > 1 && (
          <span className="shrink-0 rounded-md border border-white/15 px-1.5 text-[10px] text-slate-400" title={`${state.tabs.length} tabs`}>
            {state.tabs.length}
          </span>
        )}
        {shownTab?.pinned && <Pin className="size-3 shrink-0 text-slate-500" aria-label="Pinned tab" />}
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
            className="w-full rounded-full border border-white/10 bg-slate-900/70 px-3 py-1 text-xs text-slate-200 outline-none focus:border-sky-400/60"
          />
        </form>
        {driving && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-sky-400/15 px-2 py-0.5 text-[10px] text-sky-300">
            <Sparkles className="size-3 animate-pulse" aria-hidden /> {mini ? nameOf() : `${nameOf()} is using this`}
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
        <button type="button" className="icon-btn size-7" onClick={() => onMode('hidden')} aria-label="Put the browser away" title="Put away (the pages stay open)">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <div className="relative min-h-0 flex-1 bg-white">
        {state.tabs
          .filter(t => awake.includes(t.id))
          .map(t => (
            <TabPage key={t.id} tab={t} shown={t.id === state.active} onEl={onEl} />
          ))}
      </div>
    </div>
  )
}
