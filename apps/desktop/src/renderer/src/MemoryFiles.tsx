/**
 * Learning › Your memory: what Atlas knows, as a Markdown file you can open
 * and edit (MEMORY.md; daily notes beside it), and recall by meaning, a
 * local model that finds memories by what they mean, in Urdu or English.
 */
import { BrainCircuit, FileText, FolderOpen } from 'lucide-react'
import { useState } from 'react'

import type { LearningView } from '../../shared/learning.ts'
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
        <button type="button" className="btn" disabled={!m.file} onClick={() => open('file')}>
          <FileText className="size-3.5" aria-hidden /> Open MEMORY.md
        </button>
        <button type="button" className="btn" disabled={!m.folder} onClick={() => open('folder')}>
          <FolderOpen className="size-3.5" aria-hidden /> Open the folder
        </button>
      </div>
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
    </section>
  )
}
