import { AppWindow, Brain, FolderKanban, FolderOpen, LayoutDashboard, Maximize2, MessageSquare, Minimize2, Newspaper, Pin, PinOff, Settings2, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import type { ControlState } from '../../shared/control.ts'
import type { IdentityView } from '../../shared/identity.ts'
import type { RuntimeStatus } from '../../shared/ipc.ts'
import { isView, type UiChange, type View } from '../../shared/ui.ts'
import logo from './assets/logo.svg'
import { Companion } from './Companion.tsx'
import { Controls, PausedBanner } from './Controls.tsx'
import { AppsPage } from './Apps.tsx'
import { FilesPage } from './Files.tsx'
import { Home } from './Home.tsx'
import type { Presence } from './Jarvis.tsx'
import { Learning } from './Learning.tsx'
import { LockScreen } from './LockScreen.tsx'
import { NewsPage } from './News.tsx'
import { ProjectsHome } from './ProjectsHome.tsx'
import { SetupSections } from './Personality.tsx'
import { Setup } from './Setup.tsx'

/** Wide enough for the canvas and the chat side by side; narrower, the chat slides over the canvas. */
const WIDE = '(min-width: 1100px)'
/** Phone-width windows put the rail at the bottom. */
const PHONE = '(max-width: 639px)'

const useMedia = (query: string) => {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setMatch(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [query])
  return match
}

const stored = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: the choice lasts for this window only.
  }
}

/**
 * Layout, by width: wide windows have the rail, the conversation as a side
 * panel and the canvas; narrower ones slide the conversation over the canvas;
 * phone-width ones move the rail to a bottom bar. Compact mode is a small
 * chat-only window. The conversation stays mounted through all of these, so
 * nothing is lost; it opens by itself when Atlas speaks up. The page tells
 * main what it shows, and Atlas can change it (views, chat, size).
 */
export function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [controls, setControls] = useState<ControlState | null>(null)
  const [view, setView] = useState<View>(() => {
    const v = stored('view', 'home')
    return isView(v) ? v : 'home'
  })
  const [presence, setPresence] = useState<Presence>({ state: 'idle', level: 0 })
  const wide = useMedia(WIDE)
  const phone = useMedia(PHONE)
  const [chatOpen, setChatOpen] = useState(() => stored('chat', 'open') === 'open')
  const [compact, setCompact] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [identity, setIdentity] = useState<IdentityView | null>(null)
  const [suggestions, setSuggestions] = useState(0)

  useEffect(() => {
    void window.assistant.status().then(setStatus)
    const off = window.assistant.onStatus(setStatus)
    void window.controls.state().then(setControls)
    const offControls = window.controls.onState(setControls)
    void window.identity.get().then(setIdentity, () => undefined)
    const offIdentity = window.identity.onChanged(setIdentity)
    void window.learning.get().then(v => setSuggestions(v.pending.length), () => undefined)
    const offLearning = window.learning.onChanged(v => setSuggestions(v.pending.length))
    void window.ui.state().then(s => setPinned(s.pinned), () => undefined)
    // Atlas speaks up on its own: show the conversation.
    const offReply = window.assistant.onReply(e => {
      if (e.type === 'initiative') openChat(true)
    })
    // Atlas (through main) changes the page, the conversation or compact mode.
    const offCommand = window.ui.onCommand(c => {
      if (c.compact !== undefined) setCompact(c.compact)
      if (c.view) {
        setView(c.view)
        store('view', c.view)
      }
      if (c.chat !== undefined) openChat(c.chat)
    })
    return () => {
      off()
      offControls()
      offIdentity()
      offLearning()
      offReply()
      offCommand()
    }
  }, [])

  // Main (and so Atlas) always knows what the window shows.
  useEffect(() => {
    window.ui.report({ view, chatOpen, compact })
  }, [view, chatOpen, compact])

  const go = (v: View) => {
    setView(v)
    store('view', v)
    // In a narrow window the chat covers the canvas: picking a page hides it.
    if (!wide) setChatOpen(false)
  }
  const openChat = (open: boolean) => {
    setChatOpen(open)
    store('chat', open ? 'open' : 'closed')
  }
  const setWindow = async (change: UiChange) => {
    const s = await window.ui.set(change).catch(() => null)
    if (s) setPinned(s.pinned)
  }

  if (!status) return <div className="aurora" />

  // First run: setup fills the window until the connection works.
  if (status.phase === 'setup') {
    return (
      <Frame status={status}>
        <div className="glass mx-auto my-3 h-[calc(100%-1.5rem)] w-full max-w-xl overflow-hidden rounded-3xl sm:my-6 sm:h-[calc(100%-3rem)]">
          <Setup status={status} onSaved={setStatus} />
        </div>
      </Frame>
    )
  }

  const setup = <Setup status={status} onSaved={s => setStatus(s)} onCancel={() => go('home')} />
  const locked = identity?.locked === true
  const nav: [View, string, ReactNode][] = [
    ['home', 'Home', <LayoutDashboard key="h" className="size-[18px]" />],
    ['news', 'News', <Newspaper key="n" className="size-[18px]" />],
    ['projects', 'Projects', <FolderKanban key="p" className="size-[18px]" />],
    ['files', 'Files', <FolderOpen key="f" className="size-[18px]" />],
    ['apps', 'Apps', <AppWindow key="a" className="size-[18px]" />],
    [
      'learning',
      suggestions ? `Learning (${suggestions} waiting)` : 'Learning',
      <span key="l" className="relative">
        <Brain className="size-[18px]" />
        {suggestions > 0 && <span className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-warm text-[9px] font-bold text-black">{suggestions}</span>}
      </span>,
    ],
    ['controls', 'Connections, permissions and activity', <SlidersHorizontal key="c" className="size-[18px]" />],
    ['setup', 'Setup and personality', <Settings2 key="s" className="size-[18px]" />],
  ]
  const navButtons = nav.map(([id, label, icon]) => (
    <RailButton key={id} label={label} active={view === id} onClick={() => go(id)}>
      {icon}
    </RailButton>
  ))
  const chatButton = (
    <RailButton label={chatOpen ? 'Hide the conversation' : 'Talk to Atlas'} active={chatOpen} onClick={() => openChat(!chatOpen)}>
      <span className="relative">
        <MessageSquare className="size-[18px]" />
        {presence.state !== 'idle' && <span className="thinking-dot absolute -right-1 -top-1 size-2 rounded-full bg-accent" aria-hidden />}
      </span>
    </RailButton>
  )
  const compactButton = (
    <RailButton label="Compact mode: a small chat window" active={false} onClick={() => void setWindow({ size: 'compact' })}>
      <Minimize2 className="size-[18px]" />
    </RailButton>
  )

  const asideClass = compact
    ? 'mx-2 mb-2 flex-1'
    : phone
      ? `absolute inset-x-0 top-0 bottom-0 z-30 mx-2 mb-2 bg-bg/95 shadow-2xl backdrop-blur-xl ${chatOpen ? '' : 'hidden'}`
      : wide
        ? `mb-2 ml-2 w-[380px] shrink-0 xl:w-[420px] 2xl:w-[460px] ${chatOpen ? '' : 'hidden'}`
        : `absolute inset-y-0 left-0 z-30 mb-2 ml-2 w-[min(440px,calc(100%-1rem))] bg-bg/95 shadow-2xl backdrop-blur-xl ${chatOpen ? '' : 'hidden'}`

  return (
    <Frame
      status={status}
      locked={locked}
      overlay={identity && locked ? <LockScreen view={identity} ownerName={status.setup.ownerName} voice={status.speech.available} /> : null}
    >
      {!compact && !phone && (
        <nav className="glass mb-2 ml-2 flex w-14 shrink-0 flex-col items-center gap-1 overflow-y-auto rounded-2xl py-3" aria-label="Main">
          {navButtons}
          <div className="flex-1" />
          {compactButton}
          {chatButton}
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative flex min-h-0 min-w-0 flex-1">
          {/* Over the canvas (narrow windows): a dimmed backdrop; clicking it puts the conversation away. */}
          {!compact && !wide && chatOpen && <button type="button" aria-label="Close the conversation" className="absolute inset-0 z-20 rounded-2xl bg-black/30" onClick={() => openChat(false)} />}
          {/* The conversation: side panel, drawer, full width on phones, or the whole compact window. Always mounted. */}
          <aside aria-label="Conversation" className={`glass flex min-h-0 flex-col overflow-hidden rounded-2xl ${asideClass}`}>
            {compact && (
              <div className="flex items-center gap-1 border-b border-border px-2 py-1">
                <span className="hud-label flex-1 pl-1">Compact</span>
                <button type="button" className="icon-btn size-8" onClick={() => void setWindow({ pinned: !pinned })} aria-pressed={pinned} aria-label={pinned ? 'Stop keeping on top' : 'Keep on top of other windows'} title={pinned ? 'Stop keeping on top' : 'Keep on top'}>
                  {pinned ? <PinOff className="size-4" aria-hidden /> : <Pin className="size-4" aria-hidden />}
                </button>
                <button type="button" className="icon-btn size-8" onClick={() => void setWindow({ size: 'normal' })} aria-label="Back to the full window" title="Full window">
                  <Maximize2 className="size-4" aria-hidden />
                </button>
              </div>
            )}
            <Companion status={status} onOpenSetup={() => go('setup')} onOpenControls={() => go('controls')} onPresence={setPresence} />
          </aside>

          {!compact && (
            <main className={`glass mx-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl ${phone ? 'mb-1' : 'mb-2'}`}>
              {controls && <PausedBanner state={controls} />}
              <div className="min-h-0 flex-1">
                {view === 'home' && <Home status={status} controls={controls} presence={presence} ownerName={status.setup.ownerName} go={go} />}
                {view === 'news' && <NewsPage />}
                {view === 'projects' && <ProjectsHome />}
                {view === 'files' && <FilesPage onTalk={() => openChat(true)} />}
                {view === 'apps' && <AppsPage onTalk={() => openChat(true)} />}
                {view === 'learning' && <Learning onTalk={() => openChat(true)} />}
                {view === 'controls' && controls && <Controls state={controls} onBack={() => go('home')} />}
                {view === 'setup' && (status.phase === 'ready' ? <SetupSections connection={setup} onClose={() => go('home')} /> : setup)}
              </div>
            </main>
          )}
        </div>

        {!compact && phone && (
          <nav className="glass mx-2 mb-2 flex h-12 shrink-0 items-center gap-0.5 overflow-x-auto rounded-2xl px-1" aria-label="Main">
            {chatButton}
            {navButtons}
          </nav>
        )}
      </div>
    </Frame>
  )
}

/**
 * Window frame. While the owner check waits, the app stays mounted (the
 * conversation survives) but is hidden and inert behind the lock screen.
 */
function Frame({ children, status, locked = false, overlay }: { children: ReactNode; status?: RuntimeStatus | null; locked?: boolean; overlay?: ReactNode }) {
  return (
    <div className="relative flex h-full flex-col">
      <div className="aurora" aria-hidden />
      <TitleBar status={status ?? null} />
      <div className={`flex min-h-0 flex-1 ${locked ? 'invisible' : ''}`} inert={locked} aria-hidden={locked || undefined}>
        {children}
      </div>
      {overlay && <div className="absolute inset-x-0 bottom-0 top-10 z-40 flex">{overlay}</div>}
    </div>
  )
}

const PHASE: Record<RuntimePhaseName, string> = {
  starting: 'Starting',
  setup: 'Setup needed',
  checking: 'Checking providers',
  ready: 'Online',
  restarting: 'Restarting',
  stopped: 'Stopped',
}
type RuntimePhaseName = RuntimeStatus['phase']

/**
 * The window's own title bar: a drag region with the logo and live status.
 * Windows draws its real caption buttons over the right edge (titleBarOverlay);
 * the env() insets keep our content clear of them.
 */
function TitleBar({ status }: { status: RuntimeStatus | null }) {
  const phase = status?.phase ?? 'starting'
  return (
    <header className="titlebar flex h-10 shrink-0 items-center gap-2.5 pl-4 select-none">
      <img src={logo} alt="" className="size-5 drop-shadow-[0_0_8px_rgba(34,211,238,0.6)]" />
      <span className="text-[13px] font-semibold tracking-wide">Assistant</span>
      <span className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted">
        <span
          className={`size-1.5 rounded-full ${phase === 'ready' ? 'bg-ok' : phase === 'setup' || phase === 'stopped' ? 'bg-danger' : 'thinking-dot bg-warm'}`}
          aria-hidden
        />
        {PHASE[phase]}
        {status?.mode && phase === 'ready' ? <span className="capitalize"> · {status.mode}</span> : null}
      </span>
    </header>
  )
}

function RailButton({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} aria-current={active ? 'page' : undefined} className="icon-btn size-10">
      {children}
    </button>
  )
}
