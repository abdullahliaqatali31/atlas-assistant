import { Brain, FolderKanban, MessageSquare, PanelRightClose, PanelRightOpen, Settings2, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import type { ControlState } from '../../shared/control.ts'
import type { RuntimeStatus } from '../../shared/ipc.ts'
import logo from './assets/logo.svg'
import { Companion } from './Companion.tsx'
import { Controls, PausedBanner } from './Controls.tsx'
import type { IdentityView } from '../../shared/identity.ts'
import { JarvisPanel, type Presence } from './Jarvis.tsx'
import { Learning } from './Learning.tsx'
import { LockScreen } from './LockScreen.tsx'
import { ProjectsHome } from './ProjectsHome.tsx'
import { SetupSections } from './Personality.tsx'
import { Setup } from './Setup.tsx'

type View = 'assistant' | 'projects' | 'learning' | 'controls' | 'setup'

/** Wide enough for conversation and the panel side by side. */
const WIDE = '(min-width: 900px)'

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

const readPanelPref = () => {
  try {
    return localStorage.getItem('panel') !== 'hidden'
  } catch {
    return true
  }
}

export function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [controls, setControls] = useState<ControlState | null>(null)
  const [view, setView] = useState<View>('assistant')
  const [presence, setPresence] = useState<Presence>({ state: 'idle', level: 0 })
  const wide = useMedia(WIDE)
  const [panelOpen, setPanelOpen] = useState(readPanelPref)
  // In a narrow window the panel replaces the conversation, so it starts closed there.
  const [narrowPanel, setNarrowPanel] = useState(false)
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
    return () => {
      off()
      offControls()
      offIdentity()
      offLearning()
    }
  }, [])

  const togglePanel = () => {
    if (!wide) {
      setNarrowPanel(v => !v)
      setView('assistant')
      return
    }
    setPanelOpen(v => {
      try {
        localStorage.setItem('panel', v ? 'hidden' : 'shown')
      } catch {
        // Storage unavailable: the choice lasts for this window only.
      }
      return !v
    })
  }

  if (!status) return <div className="aurora" />

  // First run: setup fills the window until the connection works.
  if (status.phase === 'setup') {
    return (
      <Frame status={status}>
        <div className="glass mx-auto my-6 h-[calc(100%-3rem)] w-full max-w-xl overflow-hidden rounded-3xl">
          <Setup status={status} onSaved={setStatus} />
        </div>
      </Frame>
    )
  }

  const showPanel = wide ? panelOpen : narrowPanel && view === 'assistant'
  const panelShown = wide ? panelOpen : narrowPanel
  const setup = <Setup status={status} onSaved={s => setStatus(s)} onCancel={() => setView('assistant')} />

  const locked = identity?.locked === true
  return (
    <Frame
      status={status}
      locked={locked}
      overlay={identity && locked ? <LockScreen view={identity} ownerName={status.setup.ownerName} voice={status.speech.available} /> : null}
    >
      <nav className="glass mb-2 ml-2 flex w-14 shrink-0 flex-col items-center gap-1 rounded-2xl py-3" aria-label="Main">
        <RailButton label="Assistant" active={view === 'assistant'} onClick={() => setView('assistant')}>
          <MessageSquare className="size-[18px]" />
        </RailButton>
        <RailButton label="Projects" active={view === 'projects'} onClick={() => setView('projects')}>
          <FolderKanban className="size-[18px]" />
        </RailButton>
        <RailButton label={suggestions ? `Learning (${suggestions} waiting)` : 'Learning'} active={view === 'learning'} onClick={() => setView('learning')}>
          <span className="relative">
            <Brain className="size-[18px]" />
            {suggestions > 0 && <span className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-warm text-[9px] font-bold text-black">{suggestions}</span>}
          </span>
        </RailButton>
        <RailButton label="Connections, permissions and activity" active={view === 'controls'} onClick={() => setView('controls')}>
          <SlidersHorizontal className="size-[18px]" />
        </RailButton>
        <RailButton label="Setup and personality" active={view === 'setup'} onClick={() => setView('setup')}>
          <Settings2 className="size-[18px]" />
        </RailButton>
        <div className="flex-1" />
        <RailButton label={panelShown ? 'Hide the assistant panel' : 'Show the assistant panel'} active={panelShown} onClick={togglePanel}>
          {panelShown ? <PanelRightClose className="size-[18px]" /> : <PanelRightOpen className="size-[18px]" />}
        </RailButton>
      </nav>

      <div className={`flex min-w-0 flex-1 ${wide ? 'flex-row' : 'flex-col'}`}>
        <main className={`glass mx-2 mb-2 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl ${showPanel && !wide ? 'hidden' : 'flex-1'}`}>
          {controls && <PausedBanner state={controls} />}
          {view === 'controls' && controls && (
            <div className="min-h-0 flex-1">
              <Controls state={controls} onBack={() => setView('assistant')} />
            </div>
          )}
          {view === 'projects' && (
            <div className="min-h-0 flex-1">
              <ProjectsHome />
            </div>
          )}
          {view === 'learning' && (
            <div className="min-h-0 flex-1">
              <Learning onTalk={() => setView('assistant')} />
            </div>
          )}
          {view === 'setup' && (
            <div className="min-h-0 flex-1">{status.phase === 'ready' ? <SetupSections connection={setup} onClose={() => setView('assistant')} /> : setup}</div>
          )}
          {/* The companion stays mounted so the conversation survives a visit elsewhere. */}
          <div className={view === 'assistant' ? 'min-h-0 flex-1' : 'hidden'}>
            <Companion status={status} onOpenSetup={() => setView('setup')} onPresence={setPresence} />
          </div>
        </main>

        {showPanel && (
          <div className={`min-h-0 ${wide ? 'w-[340px] shrink-0 xl:w-[380px]' : 'flex-1'}`}>
            <JarvisPanel status={status} controls={controls} presence={presence} ownerName={status.setup.ownerName} />
          </div>
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
