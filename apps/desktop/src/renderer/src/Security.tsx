import { Archive, Download, Ear, Fingerprint, KeyRound, Mic, Plus, Square, Trash2, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'

import type { AskWhen, IdentityView } from '../../shared/identity.ts'
import { learnAlias, SENSITIVITIES, type Sensitivity, type WakeMatch, type WakeView } from '../../shared/wake.ts'
import { Select } from './ui/Select.tsx'
import { WakeListener } from './wake/listener.ts'
import { nameOf } from './ui/assistantName.ts'

const cleanError = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'

const ASK_LABEL: Record<AskWhen, string> = {
  daily: 'Once a day, the first time',
  wake: 'After every sleep or lock, and daily',
  away: 'Daily, and after 30+ minutes away',
  off: 'Never ask',
}

const SENS_LABEL: Record<Sensitivity, string> = {
  strict: 'Strict: fewer false starts, may miss',
  normal: 'Normal (recommended)',
  relaxed: 'Relaxed: catches more, may trigger by mistake',
}

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(0)} MB`

/** Setup › Security, wake word & backups. */
export function SecuritySettings({ assistantName }: { assistantName: string }) {
  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <CodeCard />
      <WakeCard assistantName={assistantName} />
      <BackupCard />
    </div>
  )
}

// ── security code ───────────────────────────────────────────

function CodeCard() {
  const [view, setView] = useState<IdentityView | null>(null)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    void window.identity.get().then(setView, () => undefined)
    return window.identity.onChanged(setView)
  }, [])

  const run = async (fn: () => Promise<IdentityView>, done: string) => {
    setError('')
    setNote('')
    try {
      setView(await fn())
      setCurrent('')
      setNext('')
      setNote(done)
    } catch (err) {
      setError(cleanError(err))
    }
  }

  if (!view) return null
  const save = (e: FormEvent) => {
    e.preventDefault()
    void run(() => window.identity.setCode(next, view.configured ? current : undefined), view.configured ? 'Code changed.' : 'Code set.')
  }

  return (
    <Card icon={<KeyRound className="size-[18px]" />} title="Security code">
      <p className="text-xs text-muted">
        When the assistant isn’t sure it’s you, it asks you to type this word or sentence before sharing anything private (it no longer asks aloud). It’s
        stored only as a scrambled hash on this computer and is never sent to the AI.
      </p>

      <label className={`flex items-start gap-2 rounded-xl border border-border p-2.5 text-sm ${view.helloAvailable ? '' : 'opacity-60'}`}>
        <input
          type="checkbox"
          className="mt-0.5"
          checked={view.hello}
          disabled={!view.configured || !view.helloAvailable}
          onChange={e => void run(() => window.identity.setHello(e.target.checked), e.target.checked ? 'Windows Hello is on.' : 'Windows Hello is off.')}
        />
        <span>
          <span className="flex items-center gap-1.5 font-medium">
            <Fingerprint className="size-4 text-accent" aria-hidden /> Windows Hello: face, fingerprint or PIN
          </span>
          <span className="block text-xs text-muted">
            {!view.helloAvailable
              ? 'Not set up on this PC: Windows Settings › Accounts › Sign-in options.'
              : !view.configured
                ? 'Set a typed code first: it stays the fallback.'
                : `Windows’ own dialog appears by itself when ${nameOf()} checks it’s you; the typed code still works. ${nameOf()} never sees your face or finger, only Windows’ yes or no.`}
          </span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <span className="text-sm">Ask</span>
        <div className="w-72">
          <Select
            label="When to ask for the code"
            value={view.askWhen}
            onChange={v => void run(() => window.identity.setAskWhen(v as AskWhen), 'Saved.')}
            items={(Object.keys(ASK_LABEL) as AskWhen[]).map(k => ({ value: k, label: ASK_LABEL[k] }))}
            className="py-1 text-xs"
          />
        </div>
      </div>

      <form onSubmit={save} className="space-y-2">
        {view.configured && (
          <input type="password" value={current} onChange={e => setCurrent(e.target.value)} placeholder="Current code" autoComplete="off" className="field" aria-label="Current code" />
        )}
        <div className="flex gap-2">
          <input
            type="password"
            value={next}
            onChange={e => setNext(e.target.value)}
            placeholder={view.configured ? 'New code' : 'Choose a word or sentence (4+ letters)'}
            autoComplete="new-password"
            className="field"
            aria-label="New code"
          />
          <button type="submit" className="btn btn-primary shrink-0" disabled={next.trim().length < 4 || (view.configured && !current)}>
            {view.configured ? 'Change' : 'Set code'}
          </button>
        </div>
      </form>
      {view.configured && (
        <button type="button" className="btn text-danger" disabled={!current} onClick={() => void run(() => window.identity.removeCode(current), 'Code removed.')}>
          <Trash2 className="size-3.5" aria-hidden /> Remove code
        </button>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      {note && <p className="text-xs text-ok">{note}</p>}
    </Card>
  )
}

// ── encrypted backups ───────────────────────────────────────

function BackupCard() {
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState<'create' | 'restore' | null>(null)
  const [confirmRestore, setConfirmRestore] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const act = async (kind: 'create' | 'restore') => {
    setError('')
    setNote('')
    setBusy(kind)
    try {
      if (kind === 'create') {
        const r = await window.backup.create(pass)
        if (r) {
          setNote(`Saved ${mb(r.bytes) === '0 MB' ? `${Math.ceil(r.bytes / 1024)} KB` : mb(r.bytes)} to ${r.path}. Keep the passphrase somewhere safe: without it the backup cannot be opened.`)
          setPass('')
          setAgain('')
        }
      } else {
        const r = await window.backup.restore(pass)
        if (r) setNote(`Restored the backup from ${new Date(r.createdAt).toLocaleString()}. Restarting…`)
      }
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(null)
      setConfirmRestore(false)
    }
  }
  const long = pass.length >= 8

  return (
    <Card icon={<Archive className="size-[18px]" />} title="Backups">
      <p className="text-xs text-muted">
        One encrypted file with your memory, tasks, projects, conversations of the last 30 days and settings. It is locked with a passphrase you choose
        (AES-256), so it is safe on a USB drive or cloud folder. API keys are not included; you enter them again after restoring on a new PC. A backup keeps
        whatever was in memory when it was made, even things you forget later.
      </p>
      <div className="flex gap-2">
        <input type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="Backup passphrase (8+ characters)" autoComplete="new-password" className="field" aria-label="Backup passphrase" />
        <input type="password" value={again} onChange={e => setAgain(e.target.value)} placeholder="Repeat it (for a new backup)" autoComplete="new-password" className="field" aria-label="Repeat passphrase" />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={!long || pass !== again || busy !== null} onClick={() => void act('create')}>
          <Download className="size-3.5" aria-hidden /> {busy === 'create' ? 'Saving…' : 'Create backup…'}
        </button>
        {confirmRestore ? (
          <>
            <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => void act('restore')}>
              {busy === 'restore' ? 'Restoring…' : 'Yes, replace my data'}
            </button>
            <button type="button" className="btn" onClick={() => setConfirmRestore(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="btn" disabled={!long || busy !== null} onClick={() => setConfirmRestore(true)}>
            <Upload className="size-3.5" aria-hidden /> Restore…
          </button>
        )}
      </div>
      {confirmRestore && <p className="text-xs text-warm">Restoring replaces everything here with the backup. A safety copy of your current data is kept first, and the app restarts.</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
      {note && <p className="text-xs text-ok">{note}</p>}
    </Card>
  )
}

// ── wake word ───────────────────────────────────────────────

type Heard = { text: string; match: WakeMatch | null; ms: number }

function WakeCard({ assistantName }: { assistantName: string }) {
  const [view, setView] = useState<WakeView | null>(null)
  const [error, setError] = useState('')
  const [alias, setAlias] = useState('')
  const [mode, setMode] = useState<'idle' | 'train' | 'test'>('idle')
  const [heard, setHeard] = useState<Heard[]>([])
  const [level, setLevel] = useState(0)
  const listener = useRef<WakeListener | null>(null)
  const viewRef = useRef<WakeView | null>(null)
  viewRef.current = view

  useEffect(() => {
    void window.wake.get().then(setView, () => undefined)
    const off = window.wake.onChanged(setView)
    return () => {
      off()
      listener.current?.stop()
    }
  }, [])

  // The assistant's name is always a wake word.
  useEffect(() => {
    if (!view || !assistantName || view.aliases.some(a => a.toLowerCase() === assistantName.toLowerCase())) return
    void window.wake.update({ aliases: [assistantName, ...view.aliases].slice(0, 20) }).then(setView, () => undefined)
  }, [view, assistantName])

  const run = async (fn: () => Promise<WakeView>) => {
    setError('')
    try {
      setView(await fn())
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const stopSession = () => {
    listener.current?.stop()
    listener.current = null
    setMode('idle')
    setLevel(0)
  }

  /**
   * Train: say the name a few times; every way the model spells it becomes
   * an alias. Test: shows what it hears and whether it would wake.
   */
  const startSession = async (m: 'train' | 'test') => {
    stopSession()
    setHeard([])
    setError('')
    const l = new WakeListener({
      settings: () => ({
        aliases: viewRef.current?.aliases ?? [],
        sensitivity: viewRef.current?.sensitivity ?? 'normal',
        // Training needs the name model; the test also tries the sound triggers that are on.
        name: viewRef.current?.model.status === 'ready',
        clap: m === 'test' && Boolean(viewRef.current?.clap),
        whistle: m === 'test' && Boolean(viewRef.current?.whistle),
      }),
      onWake: t => {
        if (t.kind !== 'name') setHeard(h => [{ text: t.kind === 'clap' ? '👏👏 double clap' : '🎵 whistle', match: { alias: t.kind, heard: '', rest: '' }, ms: 0 }, ...h].slice(0, 8))
      },
      onLevel: setLevel,
      onError: setError,
      onHeard: (text, match, ms) => {
        setHeard(h => [{ text, match, ms }, ...h].slice(0, 8))
        if (m !== 'train' || !text) return
        const word = learnAlias(text, assistantName || viewRef.current?.aliases[0] || '')
        const v = viewRef.current
        if (!word || !v || v.aliases.some(a => a.toLowerCase() === word.toLowerCase())) return
        void window.wake.update({ aliases: [...v.aliases, word].slice(0, 20) }).then(setView, () => undefined)
      },
    })
    listener.current = l
    setMode(m)
    try {
      await l.start()
    } catch (err) {
      setError(cleanError(err))
      stopSession()
    }
  }

  if (!view) return null
  const ready = view.model.status === 'ready'
  const downloading = view.model.status === 'downloading'

  return (
    <Card icon={<Ear className="size-[18px]" />} title="Wake word">
      <p className="text-xs text-muted">
        Say {assistantName ? <strong className="text-text">“{assistantName}”</strong> : 'the assistant’s name'} and it starts listening, no button needed. Detection runs
        on this computer with a small speech model; nothing is sent anywhere until the name is heard. Paused while it speaks, in Quiet mode and while
        locked.
      </p>

      <div className="space-y-2 rounded-lg border border-border bg-bg p-3">
        <p className="hud-label">Also wake on</p>
        <Toggle
          on={view.clap}
          onChange={on => void run(() => window.wake.update({ clap: on }))}
          label="Double clap 👏👏"
          hint="Two quick claps. Instant, no model needed."
        />
        <Toggle
          on={view.whistle}
          onChange={on => void run(() => window.wake.update({ whistle: on }))}
          label="Whistle (seeti) 🎵"
          hint="One steady whistle, about half a second. Instant, no model needed."
        />
        {(view.clap || view.whistle) && !ready && (
          <button type="button" className="btn" onClick={() => void startSession('test')} disabled={mode !== 'idle'}>
            Test claps and whistle
          </button>
        )}
      </div>

      {!ready ? (
        <div className="rounded-lg border border-border bg-bg p-3 text-xs">
          <p>
            Needs a one-time download of the Moonshine tiny speech model ({mb(view.modelBytes)}) from Hugging Face. It is stored in this app’s data folder
            and works offline afterwards.
          </p>
          {downloading && view.model.status === 'downloading' && (
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-strong" aria-label="Download progress">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(view.model.received / view.model.total) * 100}%` }} />
            </div>
          )}
          {view.model.status === 'error' && <p className="mt-2 text-danger">{view.model.message}</p>}
          <button type="button" className="btn btn-primary mt-2" disabled={downloading} onClick={() => void run(() => window.wake.downloadModel())}>
            <Download className="size-3.5" aria-hidden />
            {downloading && view.model.status === 'downloading'
              ? `Downloading… ${mb(view.model.received)} / ${mb(view.model.total)}`
              : `Download model (${mb(view.modelBytes)})`}
          </button>
        </div>
      ) : (
        <>
          <label className="flex items-center gap-3 text-sm">
            <button
              type="button"
              role="switch"
              aria-checked={view.enabled}
              onClick={() => void run(() => window.wake.update({ enabled: !view.enabled }))}
              disabled={view.aliases.length === 0}
              className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${
                view.enabled ? 'border-transparent bg-accent shadow-[0_0_12px_rgba(34,211,238,0.45)]' : 'border-border bg-surface-strong'
              }`}
            >
              <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${view.enabled ? 'left-4' : 'left-0.5'}`} />
            </button>
            Listen for the name
          </label>

          <div className="flex items-center gap-3">
            <span className="text-sm">Sensitivity</span>
            <div className="w-80">
              <Select
                label="Sensitivity"
                value={view.sensitivity}
                onChange={v => void run(() => window.wake.update({ sensitivity: v as Sensitivity }))}
                items={SENSITIVITIES.map(s => ({ value: s, label: SENS_LABEL[s] }))}
                className="py-1 text-xs"
              />
            </div>
          </div>

          <div>
            <p className="hud-label mb-1.5">Accepted spellings</p>
            <div className="flex flex-wrap gap-1.5">
              {view.aliases.map(a => (
                <span key={a} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs">
                  {a}
                  <button type="button" aria-label={`Remove ${a}`} className="text-muted hover:text-text" onClick={() => void run(() => window.wake.update({ aliases: view.aliases.filter(x => x !== a) }))}>
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
              {view.aliases.length === 0 && <span className="text-xs text-muted">Give the assistant a name in Personality, or add one here.</span>}
            </div>
            <form
              className="mt-2 flex gap-2"
              onSubmit={e => {
                e.preventDefault()
                const a = alias.trim()
                if (!a) return
                void run(() => window.wake.update({ aliases: [...view.aliases, a] })).then(() => setAlias(''))
              }}
            >
              <input value={alias} onChange={e => setAlias(e.target.value)} maxLength={40} placeholder="Add a spelling, e.g. Zaara" className="field py-1 text-xs" aria-label="Add a spelling" />
              <button type="submit" className="btn shrink-0" disabled={!alias.trim()}>
                <Plus className="size-3.5" aria-hidden /> Add
              </button>
            </form>
          </div>

          <div className="rounded-lg border border-border bg-bg p-3">
            <div className="flex flex-wrap items-center gap-2">
              {mode === 'idle' ? (
                <>
                  <button type="button" className="btn btn-primary" onClick={() => void startSession('train')}>
                    <Mic className="size-3.5" aria-hidden /> Train: say the name 3 times
                  </button>
                  <button type="button" className="btn" onClick={() => void startSession('test')}>
                    Test
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-danger" onClick={stopSession}>
                  <Square className="size-3.5" aria-hidden /> Stop {mode === 'train' ? 'training' : 'test'}
                </button>
              )}
              {mode !== 'idle' && (
                <span className="flex h-4 flex-1 items-end gap-0.5" aria-hidden>
                  {Array.from({ length: 16 }, (_, i) => (
                    <span key={i} className="w-1 rounded-sm bg-accent/70" style={{ height: `${Math.max(12, Math.min(100, level * 100 * (0.5 + ((i * 7) % 5) / 5)))}%` }} />
                  ))}
                </span>
              )}
            </div>
            {mode === 'train' && (
              <p className="mt-2 text-xs text-muted">Say “{assistantName || 'the name'}” clearly, pause, and repeat. Each spelling the model hears is added above.</p>
            )}
            {heard.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs">
                {heard.map((h, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className={`size-1.5 rounded-full ${h.match ? 'bg-ok' : 'bg-muted'}`} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">“{h.text || '…'}”</span>
                    <span className={h.match ? 'text-ok' : 'text-muted'}>{h.match ? 'would wake' : 'no match'}</span>
                    <span className="w-14 text-right font-mono text-muted">{h.ms} ms</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button type="button" className="btn text-muted" onClick={() => void run(() => window.wake.deleteModel())}>
            <Trash2 className="size-3.5" aria-hidden /> Delete speech model
          </button>
        </>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </Card>
  )
}

function Toggle({ on, onChange, label, hint, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${
          on ? 'border-transparent bg-accent shadow-[0_0_12px_rgba(34,211,238,0.45)]' : 'border-border bg-surface-strong'
        }`}
      >
        <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${on ? 'left-4' : 'left-0.5'}`} />
      </button>
      <span className="text-sm">
        {label}
        {hint && <span className="block text-[11px] text-muted">{hint}</span>}
      </span>
    </div>
  )
}

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="tile space-y-3 p-4">
      <header className="flex items-center gap-2.5">
        <span className="inline-flex size-9 items-center justify-center rounded-xl border border-border bg-surface-strong text-accent">{icon}</span>
        <h2 className="font-medium">{title}</h2>
      </header>
      {children}
    </section>
  )
}
