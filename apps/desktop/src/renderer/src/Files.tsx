import { FolderOpen, FolderPlus, History, MessageSquare, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { FileAccess, FileBatchView, FilesState } from '../../shared/files.ts'
import { ago, useNow } from './Jarvis.tsx'
import { Select } from './ui/Select.tsx'
import { nameOf } from './ui/assistantName.ts'

const cleanError = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'

const ACCESS_LABEL: Record<FileAccess, string> = {
  read: 'Read only',
  organise: 'Organise (move, rename, Recycle Bin)',
}

const EXAMPLES = [
  'Downloads mein kya naya hai?',
  'Downloads ko type ke hisab se organise kar do',
  'Find the invoice PDFs from last week',
  'Rename report-final.docx to Ahmed quote October.docx',
  'Teach: every Friday tidy my Downloads and tell me what moved',
]

/**
 * Files: the folders Atlas may look after, what it may do in each, and every
 * change it made with undo. Nothing is deleted outright; removing goes to the
 * Recycle Bin and always asks first.
 */
export function FilesPage({ onTalk }: { onTalk: () => void }) {
  const now = useNow(60_000)
  const [state, setState] = useState<FilesState | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.files.state().then(setState, err => setError(cleanError(err)))
    return window.files.onChanged(setState)
  }, [])

  const run = async (fn: () => Promise<FilesState | void>) => {
    setError('')
    try {
      const s = await fn()
      if (s) setState(s)
    } catch (err) {
      setError(cleanError(err))
    }
  }

  if (!state) return <div className="p-6 text-sm text-muted">{error || 'Loading…'}</div>

  return (
    <div className="d-page">
      <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="d-section">
          <header className="d-head">
            <h2 className="d-title">
              <FolderOpen aria-hidden /> Folders · {state.folders.length}
            </h2>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void run(() => window.files.pick())}>
              <FolderPlus className="size-3.5" aria-hidden /> Add
            </button>
          </header>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          {state.folders.length === 0 && <p className="d-note rounded-lg border border-dashed border-border px-3 py-4 text-center">No folders yet. Downloads, Documents and Desktop are good first choices.</p>}
          {state.folders.map(f => (
            <div key={f.id} className="d-row">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{f.name}</p>
                <p className="truncate font-mono text-[10px] text-muted" title={f.path}>
                  {f.path}
                </p>
              </div>
              <div className="flex w-full items-center gap-1 @md:w-auto">
              <div className="min-w-0 flex-1 @md:w-52 @md:flex-none">
                <Select
                  label={`What ${nameOf()} may do in ${f.name}`}
                  value={f.access}
                  onChange={v => void run(() => window.files.setAccess(f.id, v as FileAccess))}
                  items={(Object.keys(ACCESS_LABEL) as FileAccess[]).map(k => ({ value: k, label: ACCESS_LABEL[k] }))}
                  className="py-1 text-xs"
                />
              </div>
              <span className="flex">
                <button type="button" className="icon-btn size-7" onClick={() => void run(() => window.files.reveal(f.path))} aria-label={`Open ${f.name} in Explorer`} title="Open in Explorer">
                  <FolderOpen className="size-3.5" aria-hidden />
                </button>
                <button type="button" className="icon-btn size-7" onClick={() => void run(() => window.files.remove(f.id))} aria-label={`Stop looking after ${f.name}`} title="Remove (the folder itself is not touched)">
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </span>
              </div>
            </div>
          ))}
          <details className="d-how">
            <summary>How this works · things to ask</summary>
            <div className="mt-2 space-y-2 pl-3">
              <p className="d-note">
                Atlas only sees the folders you add here. Start with read only; allow organising where you want it to move, rename and tidy. Every change can be undone, and removing always
                goes to the Recycle Bin after asking you.
              </p>
              <ul className="space-y-1">
                {EXAMPLES.map(e => (
                  <li key={e} className="text-xs text-muted" dir="auto">
                    “{e}”
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-sm" onClick={onTalk}>
                <MessageSquare className="size-3.5" aria-hidden /> Talk to {nameOf()}
              </button>
            </div>
          </details>
        </section>

        <section className="d-section">
          <header className="d-head">
            <h2 className="d-title">
              <History aria-hidden /> What {nameOf()} changed
            </h2>
          </header>
          {state.history.length === 0 && <p className="d-note">Nothing yet. Moves, renames, new folders and Recycle Bin items appear here, with undo.</p>}
          {state.history.map(b => (
            <Change key={b.id} b={b} now={now} onUndo={() => void run(() => window.files.undo(b.id))} />
          ))}
        </section>
      </div>
    </div>
  )
}

function Change({ b, now, onUndo }: { b: FileBatchView; now: number; onUndo: () => void }) {
  const trashOnly = b.changes.every(c => c.kind === 'trash')
  return (
    <div className={`d-row block py-2 pr-2 ${b.undoneAt ? 'opacity-60' : ''}`}>
      <p className="text-sm" dir="auto">
        {b.summary}
      </p>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
        <span>
          {ago(b.at, now)} · {b.by} · {b.changes.length} change{b.changes.length === 1 ? '' : 's'}
        </span>
        <span className="flex-1" />
        {b.undoneAt ? (
          <span>Undone</span>
        ) : trashOnly ? (
          <span title="Restore from the Recycle Bin">In the Recycle Bin</span>
        ) : (
          <button type="button" className="btn btn-sm" onClick={onUndo}>
            <Undo2 className="size-3.5" aria-hidden /> Undo
          </button>
        )}
      </div>
    </div>
  )
}
