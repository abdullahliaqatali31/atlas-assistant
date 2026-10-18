import * as Label from '@radix-ui/react-label'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { useEffect, useState, type ReactNode } from 'react'

import { parseName, type PersonalityProfile } from '@assistant/shared'

import type { PersonalityView } from '../../shared/personality.ts'
import { AppearanceSettings } from './Appearance.tsx'
import { SecuritySettings } from './Security.tsx'

const cleanError = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback

const LANGUAGES: { value: PersonalityProfile['language']; label: string }[] = [
  { value: 'auto', label: 'Follow me' },
  { value: 'ur-Latn', label: 'Roman Urdu' },
  { value: 'ur-Arab', label: 'اردو' },
  { value: 'en', label: 'English' },
  { value: 'mix', label: 'Mix' },
]

/** Setup with Connection (keys, voice) and Personality side by side as sections. */
export function SetupSections({ connection, onClose }: { connection: ReactNode; onClose: () => void }) {
  const [section, setSection] = useState<'appearance' | 'connection' | 'personality' | 'security'>('appearance')
  const [assistantName, setAssistantName] = useState('')
  useEffect(() => {
    void window.personality.get().then(v => setAssistantName(v?.profile.assistantName ?? ''), () => undefined)
    return window.personality.onChanged(v => setAssistantName(v.profile.assistantName))
  }, [])
  return (
    <div className="flex h-full flex-col">
      <nav className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ToggleGroup.Root
          type="single"
          value={section}
          onValueChange={v => v && setSection(v as typeof section)}
          aria-label="Setup section"
          className="flex rounded-xl border border-border bg-bg p-0.5"
        >
          {(['appearance', 'connection', 'personality', 'security'] as const).map(s => (
            <ToggleGroup.Item key={s} value={s} className="rounded-md px-2 py-0.5 text-xs capitalize text-muted transition-colors hover:text-text data-[state=on]:bg-accent-soft data-[state=on]:text-accent">
              {s === 'security' ? 'Security & backups' : s}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
        <button type="button" onClick={onClose} className="ml-auto text-xs text-muted hover:text-text">
          Close
        </button>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">{section === 'appearance' ? <AppearanceSettings /> : section === 'connection' ? connection : section === 'personality' ? <PersonalitySettings onRunIntro={onClose} /> : <SecuritySettings assistantName={assistantName} />}</div>
    </div>
  )
}

const changedKeys =(a: PersonalityProfile, b: PersonalityProfile) => (Object.keys(a) as (keyof PersonalityProfile)[]).filter(k => a[k] !== b[k])

/**
 * Setup › Personality: names, language and tone, with undo, reset and
 * export. Every save is a new version in the local database.
 */
export function PersonalitySettings({ onRunIntro }: { onRunIntro: () => void }) {
  const [view, setView] = useState<PersonalityView | null>(null)
  const [form, setForm] = useState<PersonalityProfile | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    const apply = (v: PersonalityView) => {
      setView(v)
      setForm(v.profile)
    }
    void window.personality.get().then(v => (v ? apply(v) : setError('The assistant is not ready yet; finish the connection setup first.')), err => setError(cleanError(err, 'Could not load.')))
    return window.personality.onChanged(apply)
  }, [])

  if (!view || !form) return <div className="mx-auto max-w-md p-6 text-sm text-muted">{error || 'Loading…'}</div>

  const dirty = changedKeys(form, view.profile)
  const badName = parseName(form.ownerNickname) === null || parseName(form.assistantName) === null

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      await action()
      setNote(done)
    } catch (err) {
      setError(cleanError(err, 'That did not work.'))
    } finally {
      setBusy(false)
    }
  }

  const save = () => run(() => window.personality.update(Object.fromEntries(dirty.map(k => [k, form[k]])), 'setup'), 'Saved. The next reply uses it.')
  const set = <K extends keyof PersonalityProfile>(k: K, v: PersonalityProfile[K]) => setForm(f => (f ? { ...f, [k]: v } : f))

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5 p-6">
      <header>
        <h1 className="text-xl font-semibold">Personality</h1>
        <p className="mt-1 text-sm text-muted">
          How the assistant talks to you. This changes tone only: honesty, safety rules, approvals and your limits stay the same.
        </p>
      </header>

      <TextField id="nick" label="What it calls you" value={form.ownerNickname} placeholder="Your name, or e.g. Boss" onChange={v => set('ownerNickname', v)} />
      <TextField id="aname" label="Assistant’s name" value={form.assistantName} placeholder="No name" onChange={v => set('assistantName', v)} />
      {badName && <p className="-mt-3 text-xs text-danger">Names may use letters, numbers, spaces, dots, apostrophes and hyphens (up to 40).</p>}

      <Choice label="Language" value={form.language} options={LANGUAGES} onChange={v => set('language', v)} />
      <Choice
        label="Humour"
        value={form.humour ? 'on' : 'off'}
        options={[
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
        onChange={v => set('humour', v === 'on')}
      />
      <Choice
        label="Replies"
        value={form.verbosity}
        options={[
          { value: 'short', label: 'Short' },
          { value: 'detailed', label: 'Detailed' },
        ]}
        onChange={v => set('verbosity', v)}
      />
      <Choice
        label="When it disagrees"
        value={form.disagreement}
        options={[
          { value: 'gentle', label: 'Gently' },
          { value: 'direct', label: 'Directly' },
          { value: 'firm', label: 'Firmly' },
        ]}
        onChange={v => set('disagreement', v)}
      />

      {error && <p className="text-sm text-danger">{error}</p>}
      {note && <p className="text-sm text-muted" role="status">{note}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || dirty.length === 0 || badName}
          onClick={() => void save()}
          className="btn btn-primary h-9 flex-1"
        >
          Save
        </button>
        {dirty.length > 0 && (
          <button type="button" disabled={busy} onClick={() => setForm(view.profile)} className="btn h-9">
            Discard
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2 text-sm">
        <button type="button" disabled={busy || !view.canUndo} onClick={() => void run(() => window.personality.undo(), 'Undone.')} className="btn h-9">
          Undo last change
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => window.personality.reset(), 'Back to defaults. Undo brings your settings back.')}
          className="btn h-9"
        >
          Reset to defaults
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(async () => {
            const { saved } = await window.personality.exportFile()
            if (!saved) throw new Error('Export cancelled.')
          }, 'Exported.')}
          className="btn h-9"
        >
          Export…
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(async () => {
            await window.personality.setOnboarded(false)
            onRunIntro()
          }, '')}
          className="btn h-9"
        >
          Run the intro again
        </button>
      </div>

      <section aria-label="History" className="text-xs text-muted">
        <p className="font-medium text-text">History</p>
        {view.history.length === 0 ? (
          <p className="mt-1">No changes yet; using the defaults.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {view.history.map(h => (
              <li key={h.version}>
                v{h.version} · {h.reason} · {new Date(h.at).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function TextField({ id, label, value, placeholder, onChange }: { id: string; label: string; value: string; placeholder: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label.Root htmlFor={id} className="text-sm font-medium">
        {label}
      </Label.Root>
      <input
        id={id}
        value={value}
        maxLength={40}
        spellCheck={false}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className="field"
      />
    </div>
  )
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <ToggleGroup.Root type="single" value={value} onValueChange={v => v && onChange(v as T)} aria-label={label} className="flex flex-wrap gap-1 rounded-xl border border-border bg-bg p-0.5">
        {options.map(o => (
          <ToggleGroup.Item
            key={o.value}
            value={o.value}
            className="flex-1 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:text-text data-[state=on]:bg-accent-soft data-[state=on]:text-accent"
          >
            {o.label}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
    </div>
  )
}
