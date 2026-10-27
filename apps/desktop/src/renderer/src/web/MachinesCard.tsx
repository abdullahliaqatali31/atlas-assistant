/**
 * Settings › Security › Machines: the PCs Atlas works on. This PC when the
 * brain runs here; others pair with a code and `atlas connect`, and then
 * reach Atlas by themselves (nothing on them has to be open to the network).
 * One machine is the one Atlas works on: its apps, files, status and widget.
 */
import { Check, Copy, Download, Laptop, Monitor, MonitorSmartphone, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import { CAPABILITY_LABEL, type MachinesView, type MachineView, type PresenceState } from '../../../shared/hands.ts'
import { nameOf } from '../ui/assistantName.ts'

const clean = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.')

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

/** How each state reads in the list, and its dot. */
const STATE: Record<PresenceState, { text: string; dot: string }> = {
  awake: { text: 'on', dot: 'bg-ok' },
  idle: { text: 'idle', dot: 'bg-ok/60' },
  locked: { text: 'locked', dot: 'bg-amber-400' },
  asleep: { text: 'asleep', dot: 'bg-sky-400' },
  off: { text: 'shut down', dot: 'bg-muted' },
  closed: { text: 'Atlas closed there', dot: 'bg-muted' },
  lost: { text: 'out of reach', dot: 'bg-danger' },
}

const PLATFORM = { windows: { icon: Monitor, label: 'Windows' }, mac: { icon: Laptop, label: 'Mac' }, linux: { icon: Server, label: 'Linux' } } as const

/** The address other machines use: the one this browser reached Atlas at (a domain or the server's IP), unless that is this PC's own name. */
const reachable = () => {
  const o = window.location.origin
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(o) ? null : o
}

function Row({ m, onChange }: { m: MachineView; onChange: (v: MachinesView) => void }) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(m.name)
  const [error, setError] = useState('')
  const P = PLATFORM[m.platform].icon
  const run = (fn: () => Promise<MachinesView>) => {
    setError('')
    void fn().then(onChange, e => setError(clean(e)))
  }
  return (
    <li className={`rounded-xl border p-2.5 ${m.active ? 'border-accent/60 bg-accent/5' : 'border-border'}`}>
      <div className="flex items-center gap-2.5">
        <span className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-strong text-accent">
          <P className="size-[18px]" aria-hidden />
          <span className={`absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-surface ${m.presence ? STATE[m.presence.state].dot : m.online ? 'bg-ok' : 'bg-muted'}`} title={m.presence ? STATE[m.presence.state].text : m.online ? 'Connected' : 'Offline'} />
        </span>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex gap-1.5"
              onSubmit={e => {
                e.preventDefault()
                setRenaming(false)
                if (name.trim() && name !== m.name) run(() => window.machines.rename(m.id, name.trim()))
              }}
            >
              <input autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={60} className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 py-0.5 text-sm" />
              <button type="submit" className="rounded-lg border border-border px-2 text-xs" aria-label="Save the name">
                <Check className="size-3.5" />
              </button>
            </form>
          ) : (
            <p className="truncate text-sm font-medium">{m.name}</p>
          )}
          <p className="text-xs text-muted">
            {PLATFORM[m.platform].label}
            {m.local ? ` · where ${nameOf()} itself runs` : ''}
            {m.presence ? ` · ${STATE[m.presence.state].text}${m.presence.state === 'awake' ? '' : ` ${ago(m.presence.since)}`}` : m.online ? ' · connected' : ` · offline, last seen ${ago(m.lastSeen)}`}
            {m.version ? ` · ${m.version}` : ''}
          </p>
        </div>
        {m.active ? (
          <span className="rounded-full border border-accent/60 px-2 py-0.5 text-[11px] text-accent">{nameOf()} works here</span>
        ) : (
          <button type="button" onClick={() => run(() => window.machines.setActive(m.id))} className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted hover:text-text">
            Work on this one
          </button>
        )}
        {!m.local && (
          <>
            <button type="button" onClick={() => setRenaming(r => !r)} className="rounded-lg p-1 text-muted hover:text-text" aria-label={`Rename ${m.name}`} title="Rename">
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Remove ${m.name}? It disconnects at once and needs a new code to come back.`)) run(() => window.machines.revoke(m.id))
              }}
              className="rounded-lg p-1 text-muted hover:text-danger"
              aria-label={`Remove ${m.name}`}
              title="Remove"
            >
              <Trash2 className="size-3.5" />
            </button>
          </>
        )}
      </div>
      {!m.local && m.online && m.capabilities.length < Object.keys(CAPABILITY_LABEL).length && (
        <p className="mt-1.5 pl-11 text-[11px] text-muted">Allowed there: {m.capabilities.map(c => CAPABILITY_LABEL[c].toLowerCase()).join('; ') || 'nothing'}.</p>
      )}
      {!m.local && m.online && <BringData m={m} />}
      {error && <p className="mt-1 pl-11 text-xs text-danger">{error}</p>}
    </li>
  )
}

/** Moving that PC's own Atlas (memory, settings, optionally keys) to this brain. */
function BringData({ m }: { m: MachineView }) {
  const [open, setOpen] = useState(false)
  const [keys, setKeys] = useState(false)
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [note, setNote] = useState('')
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="ml-11 mt-1.5 inline-flex items-center gap-1 text-xs text-muted hover:text-accent">
        <Download className="size-3.5" aria-hidden /> Bring its {nameOf()} data here
      </button>
    )
  const bring = () => {
    setState('busy')
    setNote('')
    void window.machines.importFrom(m.id, keys).then(
      r => {
        setState('done')
        setNote(`Brought ${r.files} files${r.keys ? ` and ${r.keys} keys` : ''} from ${r.from}. ${nameOf()} restarts with them now: this page reconnects in a few seconds.`)
      },
      e => {
        setState('idle')
        setNote(clean(e))
      },
    )
  }
  return (
    <div className="ml-11 mt-2 space-y-1.5 rounded-lg border border-border p-2.5 text-xs">
      <p>
        If {nameOf()} used to run on {m.name}, its memory comes here: what it knows about you, MEMORY.md and the daily notes, skills, your name and voice choice, rules and connections, the security code, timers and watches. What is
        here now is kept in a safety copy first. Folders, apps and connectors on that PC stay there.
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={keys} onChange={e => setKeys(e.target.checked)} /> Bring the API keys too (sent over this connection, stored sealed here)
      </label>
      <p className="text-muted">Afterwards, run only <code>atlas connect</code> on {m.name} (stop its own {nameOf()} with <code>atlas stop</code>), so two never answer you.</p>
      <div className="flex gap-2">
        <button type="button" className="btn border-accent text-accent" disabled={state !== 'idle'} onClick={bring}>
          {state === 'busy' ? 'Bringing…' : state === 'done' ? 'Done' : 'Bring it here'}
        </button>
        {state === 'idle' && (
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
        )}
      </div>
      {note && <p className={state === 'done' ? 'text-ok' : 'text-danger'}>{note}</p>}
    </div>
  )
}

export function MachinesCard() {
  const [view, setView] = useState<MachinesView | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  /** This PC's other addresses (the home network, a domain), when the page itself is at localhost. */
  const [elsewhere, setElsewhere] = useState<string | null>(null)

  useEffect(() => {
    void window.machines.state().then(setView, e => setError(clean(e)))
    if (!reachable())
      void window.webAccess.state().then(
        w => setElsewhere(w.urls.find(u => !/\/\/(localhost|127\.0\.0\.1)(:|$)/.test(u)) ?? null),
        () => undefined,
      )
    return window.machines.onChanged(setView)
  }, [])
  useEffect(() => {
    if (!view?.codeExpiresAt) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [view?.codeExpiresAt])

  if (!view) return error ? <p className="text-xs text-danger">{error}</p> : null
  const left = view.codeExpiresAt ? Math.max(0, Math.round((view.codeExpiresAt - now) / 1000)) : 0
  const address = reachable() ?? elsewhere
  const local = view.machines.some(m => m.local)

  return (
    <section className="tile space-y-3 p-4">
      <header className="flex items-center gap-2.5">
        <span className="inline-flex size-9 items-center justify-center rounded-xl border border-border bg-surface-strong text-accent">
          <MonitorSmartphone className="size-[18px]" />
        </span>
        <h2 className="font-medium">Machines</h2>
      </header>
      <p className="text-xs text-muted">
        {local
          ? `${nameOf()} works on this PC. Other PCs can be its hands too: they connect to ${nameOf()} here and do what you ask on them (apps, files, code, the widget).`
          : `${nameOf()} runs on a server here. Connect your PCs and it works on them: apps, files, code, notices and the widget, from wherever you talk to it.`}{' '}
        Each machine connects out by itself; nothing on it is opened to the network, and removing it here cuts it off at once.
      </p>

      {view.machines.length ? (
        <ul className="space-y-2">
          {view.machines.map(m => (
            <Row key={m.id} m={m} onChange={setView} />
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-border p-3 text-sm text-muted">No PC is connected yet: add one, and {nameOf()} can work on it.</p>
      )}

      {view.code && left > 0 ? (
        <AddMachine address={address} code={view.code} left={left} />
      ) : (
        <button type="button" onClick={() => void window.machines.newCode().then(setView, e => setError(clean(e)))} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm hover:border-accent hover:text-accent">
          <Plus className="size-4" /> Add a machine
        </button>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  )
}

type Os = 'windows' | 'unix' | 'installed'

/** One line for the PC to add: it brings Node.js and Atlas's hands from this Atlas, connects, and starts with the PC. */
function AddMachine({ address, code, left }: { address: string | null; code: string; left: number }) {
  const [os, setOs] = useState<Os>(() => (/Mac|Linux|X11/.test(navigator.userAgent) && !/Windows/.test(navigator.userAgent) ? 'unix' : 'windows'))
  const [copied, setCopied] = useState(false)
  const at = address ?? '<this Atlas address>'
  const line = os === 'windows' ? `irm "${at}/hands/install.ps1?code=${code}" | iex` : os === 'unix' ? `curl -fsSL "${at}/hands/install.sh?code=${code}" | sh` : `atlas connect ${at} ${code}`
  const where = os === 'windows' ? 'In PowerShell on the PC to add, paste:' : os === 'unix' ? 'In a terminal on the Mac or Linux machine, paste:' : 'Atlas is installed there already? Then:'
  return (
    <div className="space-y-2 rounded-xl border border-accent/50 bg-accent/5 p-3">
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            ['windows', 'Windows'],
            ['unix', 'Mac / Linux'],
            ['installed', 'Atlas already installed'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setOs(k)} className={`rounded-full border px-2.5 py-0.5 text-xs ${os === k ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}`}>
            {label}
          </button>
        ))}
      </div>
      <p className="text-sm">{where}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg bg-black/30 px-2 py-1.5 text-xs">{line}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(line).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
          className="rounded-lg border border-border p-1.5 text-muted hover:text-text"
          aria-label="Copy the line"
        >
          {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <p className="text-xs text-muted">
        {os !== 'installed' && `It installs Node.js if needed and ${nameOf()}'s hands from here (the same version), connects, and starts with the PC; nothing else to download. `}
        The code works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} more.
        {!address && ' Use the address other machines reach this one at: its home-network address (turn on "Also from my home network" above) or its domain.'}
      </p>
    </div>
  )
}

