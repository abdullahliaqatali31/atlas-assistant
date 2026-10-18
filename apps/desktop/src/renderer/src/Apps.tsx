import { AppWindow, Circle, GraduationCap, Plus, Search, ShieldAlert, Square, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { AppAccess, DesktopState, InstalledApp, RecordedStep } from '../../shared/desktop.ts'
import { Select } from './ui/Select.tsx'

const cleanError = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'

const ACCESS_LABEL: Record<AppAccess, string> = {
  open: 'Open only',
  read: 'Open and read the screen',
  control: 'Control: click, type, keys',
}

const describe = (s: RecordedStep) =>
  s.kind === 'click'
    ? `In ${s.app}, click ${s.role ?? 'item'} “${s.name}”`
    : s.kind === 'type'
      ? `In ${s.app}, type “${s.text}”`
      : s.kind === 'key'
        ? `In ${s.app}, press ${s.keys}`
        : `In ${s.app}, a password was typed (not recorded; ask the owner)`

/**
 * Apps: which desktop apps Atlas may open, read or control, and "watch me"
 * to teach a task by doing it once. Terminals, security, password managers
 * and browsers are never controllable.
 */
export function AppsPage({ onTalk }: { onTalk: () => void }) {
  const [state, setState] = useState<DesktopState | null>(null)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)
  const [installed, setInstalled] = useState<InstalledApp[] | null>(null)
  const [filter, setFilter] = useState('')
  const [steps, setSteps] = useState<RecordedStep[] | null>(null)
  const [taskName, setTaskName] = useState('')
  const [goal, setGoal] = useState('')

  useEffect(() => {
    void window.desktop.state().then(setState, err => setError(cleanError(err)))
    return window.desktop.onChanged(setState)
  }, [])

  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError('')
    try {
      return await fn()
    } catch (err) {
      setError(cleanError(err))
      return undefined
    }
  }

  const openPicker = async () => {
    setPicking(true)
    if (!installed) setInstalled((await run(() => window.desktop.installed())) ?? [])
  }

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const chosen = new Set(state?.apps.map(a => a.appId))
    return (installed ?? []).filter(a => !chosen.has(a.appId) && (!f || a.name.toLowerCase().includes(f))).slice(0, 60)
  }, [installed, filter, state])

  const stopRecording = async () => {
    const s = await run(() => window.desktop.recordStop())
    if (s) setSteps(s)
  }

  const teach = () => {
    if (!steps?.length || !taskName.trim()) return
    const lines = steps.map((s, i) => `${i + 1}. ${describe(s)}`).join('\n')
    const text = `I just showed you a task on my computer. Please save it as a task named "${taskName.trim()}"${goal.trim() ? `. What it is for: ${goal.trim()}` : ''}.\nWhat I did:\n${lines}\nTurn this into clear steps using the desktop tools (read the app first, then act; check each step worked). Keep anything that changes each time (names, messages, amounts) as something I tell you when I ask for the task. Ask me if a step is unclear.`
    void run(() => window.assistant.send(text)).then(() => {
      setSteps(null)
      setTaskName('')
      setGoal('')
      onTalk()
    })
  }

  if (!state) return <div className="p-6 text-sm text-muted">{error || 'Loading…'}</div>

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4">
      <div className="mx-auto grid max-w-5xl gap-4 xl:grid-cols-[1fr_380px]">
        <section className="glass rise-in space-y-3 rounded-2xl p-4">
          <header className="flex items-center gap-2">
            <AppWindow className="size-4 text-accent" aria-hidden />
            <h2 className="flex-1 font-semibold">Apps Atlas may use</h2>
            <button type="button" className="btn btn-primary" onClick={() => void openPicker()}>
              <Plus className="size-4" aria-hidden /> Add apps
            </button>
          </header>
          <p className="text-xs text-muted">
            Atlas works through Windows’ own accessibility, like a screen reader: it reads buttons and boxes by name and clicks or types only in apps you set to Control. Send, Delete,
            Pay, Call and similar always ask you first, and every WhatsApp message shows you the recipient and text before it goes. Terminals, Windows security, password
            managers and browsers are never controllable.
          </p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {state.error && <p className="text-xs text-warm">Desktop control is unavailable: {state.error}</p>}

          {picking && (
            <div className="tile space-y-2 p-3">
              <div className="flex items-center gap-2">
                <Search className="size-4 text-muted" aria-hidden />
                <input className="field flex-1" placeholder="Find an app (WhatsApp, Outlook, Excel…)" value={filter} onChange={e => setFilter(e.target.value)} autoFocus aria-label="Find an app" />
                <button type="button" className="icon-btn" onClick={() => setPicking(false)} aria-label="Close the app list">
                  <X className="size-4" aria-hidden />
                </button>
              </div>
              {!installed && <p className="text-xs text-muted">Reading the Start menu…</p>}
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {shown.map(a => (
                  <div key={a.appId} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-surface-strong">
                    <span className={`min-w-0 flex-1 truncate ${a.blocked ? 'text-muted' : ''}`}>{a.name}</span>
                    {a.blocked ? (
                      <span className="flex items-center gap-1 text-[11px] text-muted" title={`Atlas never controls ${a.blocked}`}>
                        <ShieldAlert className="size-3.5" aria-hidden /> {a.blocked}
                      </span>
                    ) : (
                      <button type="button" className="btn h-7 px-2 text-xs" onClick={() => void run(async () => setState(await window.desktop.add({ name: a.name, appId: a.appId })))}>
                        Add
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {state.apps.length === 0 && !picking && (
            <p className="tile px-3 py-4 text-center text-sm text-muted">No apps yet. Add WhatsApp and set it to Control so Atlas can check and send messages for you.</p>
          )}
          {state.apps.map(a => (
            <div key={a.id} className="tile flex flex-wrap items-center gap-3 px-3 py-2.5">
              <p className="min-w-0 flex-1 truncate font-medium">{a.name}</p>
              <div className="w-60">
                <Select
                  label={`What Atlas may do in ${a.name}`}
                  value={a.access}
                  onChange={v => void run(async () => setState(await window.desktop.setAccess(a.id, v as AppAccess)))}
                  items={(Object.keys(ACCESS_LABEL) as AppAccess[]).map(k => ({ value: k, label: ACCESS_LABEL[k] }))}
                  className="py-1 text-xs"
                />
              </div>
              <button type="button" className="icon-btn" onClick={() => void run(async () => setState(await window.desktop.remove(a.id)))} aria-label={`Remove ${a.name}`} title="Remove">
                <Trash2 className="size-4" aria-hidden />
              </button>
            </div>
          ))}
        </section>

        <section className="glass rise-in space-y-3 rounded-2xl p-4">
          <header className="flex items-center gap-2">
            <GraduationCap className="size-4 text-accent" aria-hidden />
            <h2 className="flex-1 font-semibold">Teach by showing</h2>
          </header>
          <p className="text-xs text-muted">
            Press Watch me, do the task once in your chosen apps, then Stop. Atlas sees which buttons you clicked and what you typed (never password fields), and turns it into a task
            it can repeat. You can also just tell it the steps in the chat.
          </p>
          {state.recording ? (
            <button type="button" className="btn btn-danger w-full" onClick={() => void stopRecording()}>
              <Square className="size-4" aria-hidden /> Stop watching
            </button>
          ) : (
            <button type="button" className="btn w-full" onClick={() => void run(async () => setState(await window.desktop.recordStart()))} disabled={!state.apps.length}>
              <Circle className="size-4 text-danger" aria-hidden /> Watch me
            </button>
          )}
          {state.recording && <p className="thinking-dot text-center text-xs text-warm">Watching your clicks and typing in the chosen apps…</p>}

          {steps && (
            <div className="space-y-2">
              {steps.length === 0 ? (
                <p className="text-xs text-muted">Nothing was recorded in the chosen apps.</p>
              ) : (
                <ol className="tile max-h-64 list-decimal space-y-1 overflow-y-auto py-2 pl-8 pr-3 text-xs">
                  {steps.map((s, i) => (
                    <li key={i} dir="auto">
                      {describe(s)}
                    </li>
                  ))}
                </ol>
              )}
              {steps.length > 0 && (
                <>
                  <input className="field" placeholder="Task name, e.g. “send daily report”" value={taskName} onChange={e => setTaskName(e.target.value)} aria-label="Task name" />
                  <input className="field" placeholder="What it is for (optional)" value={goal} onChange={e => setGoal(e.target.value)} aria-label="What the task is for" />
                  <div className="flex gap-2">
                    <button type="button" className="btn btn-primary flex-1" onClick={teach} disabled={!taskName.trim()}>
                      Teach Atlas this task
                    </button>
                    <button type="button" className="btn" onClick={() => setSteps(null)}>
                      Discard
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
