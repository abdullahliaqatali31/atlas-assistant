/**
 * Learning › Your memory: what Atlas knows, as a Markdown file you can open
 * and edit (MEMORY.md; daily notes beside it), and recall by meaning, a
 * local model that finds memories by what they mean, in Urdu or English.
 */
import { BookOpen, BrainCircuit, FileText, FolderOpen } from 'lucide-react'
import { useState } from 'react'

import type { LearningView } from '../../shared/learning.ts'
import { MemoryViewer } from './MemoryViewer.tsx'
import { nameOf } from './ui/assistantName.ts'

const STATE: Record<LearningView['memory']['semantic']['state'], string> = {
  off: 'Off',
  loading: 'Getting the model ready…',
  indexing: 'Learning what each memory means…',
  ready: 'On',
  error: 'Stopped',
}

export function MemoryFiles({ view, run }: { view: LearningView; run: (fn: () => Promise<LearningView>) => Promise<void> }) {
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  // Opening the files in an editor works only where Atlas runs on this screen's computer.
  const here = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(window.location.origin)
  const m = view.memory
  const s = m.semantic
  const open = (what: 'file' | 'folder') => void window.learning.openMemory(what).catch(e => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not open it.'))
  return (
    <section className="tile space-y-3 p-3">
      <h2 className="hud-label flex items-center gap-1.5">
        <FileText className="size-3.5 text-accent" aria-hidden /> Your memory
      </h2>
      <p className="text-xs text-muted">
        Everything {nameOf()} remembers is also a file you can read and edit: change a line to correct it, delete one to make {nameOf()} forget it, add a line under a heading to teach it.
        A note for each day sits beside it.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" disabled={!m.file} onClick={() => setReading(r => !r)}>
          <BookOpen className="size-3.5" aria-hidden /> Read and edit here
        </button>
        {here && (
          <>
            <button type="button" className="btn" disabled={!m.file} onClick={() => open('file')}>
              <FileText className="size-3.5" aria-hidden /> Open MEMORY.md
            </button>
            <button type="button" className="btn" disabled={!m.folder} onClick={() => open('folder')}>
              <FolderOpen className="size-3.5" aria-hidden /> Open the folder
            </button>
          </>
        )}
      </div>
      {reading && <MemoryViewer onClose={() => setReading(false)} />}
      {m.file && <p className="truncate font-mono text-[11px] text-muted" title={m.file}>{m.file}</p>}

      <label className="flex items-start gap-2 rounded-lg border border-border p-2.5 text-sm">
        <input type="checkbox" className="mt-0.5" checked={s.on} onChange={e => void run(() => window.learning.semantic(e.target.checked))} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 font-medium">
            <BrainCircuit className="size-4 text-accent" aria-hidden /> Recall by meaning
          </span>
          <span className="block text-xs text-muted">
            Finds memories by what they mean, not only by the same words (“meri behan ki shadi kab hai” finds “your sister’s wedding is in December”). A 118 MB model, downloaded once, runs on this PC.
          </span>
          {s.on && (
            <span className="mt-1 block text-xs">
              {STATE[s.state]}
              {s.state === 'loading' && s.progress > 0 ? ` ${Math.round(s.progress * 100)}%` : ''}
              {(s.state === 'indexing' || s.state === 'ready') && s.total > 0 ? ` · ${s.indexed} of ${s.total} memories` : ''}
            </span>
          )}
          {s.error && <span className="mt-1 block text-xs text-danger">{s.error}</span>}
        </span>
      </label>
      {error && <p className="text-xs text-danger">{error}</p>}
      <SpeakUp view={view} run={run} />
    </section>
  )
}

const KIND: Record<string, string> = { 'welcome-back': 'Welcome back', project: 'Project nudges', message: 'New messages' }
const label = (context: string) => {
  const [kind = '', part = ''] = context.split('@')
  const what = KIND[kind] ?? (kind.startsWith('agenda:') ? `Reminders about ${kind.slice('agenda:'.length)}` : kind)
  return `${what}, ${part}`
}

/** What the owner's reactions taught about when speaking up is welcome. */
function SpeakUp({ view, run }: { view: LearningView; run: (fn: () => Promise<LearningView>) => Promise<void> }) {
  if (view.speakUp.length === 0) return null
  return (
    <div className="space-y-1.5 rounded-lg border border-border p-2.5">
      <p className="text-sm font-medium">When speaking up is welcome</p>
      <p className="text-xs text-muted">Learned from how you react. Where it is low, {nameOf()} shows it quietly instead of saying it.</p>
      <ul className="space-y-1 text-xs">
        {view.speakUp.map(r => (
          <li key={r.context} className="flex justify-between gap-2">
            <span>{label(r.context)}</span>
            <span className={r.chance < 0.35 ? 'text-muted' : ''}>
              {Math.round(r.chance * 100)}% · {r.reactions} {r.reactions === 1 ? 'reaction' : 'reactions'}
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="btn" onClick={() => void run(() => window.learning.welcomeReset())}>
        Forget this
      </button>
    </div>
  )
}
