import { FolderOpen, FolderPlus, History, ShieldCheck, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { FileAccess, FileBatchView, FilesState } from '../../shared/files.ts'
import { ago, useNow } from './Jarvis.tsx'
import { Select } from './ui/Select.tsx'

const cleanError = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'

const ACCESS_LABEL: Record<FileAccess, string> = {
  read: 'Read only: list, search, read',
  organise: 'Organise: move, rename, copy, Recycle Bin',
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
    <div className="h-full min-h-0 overflow-y-auto p-4">
      <div className="mx-auto grid max-w-5xl gap-4 xl:grid-cols-[1fr_380px]">
        <section className="glass rise-in space-y-3 rounded-2xl p-4">
          <header className="flex items-center gap-2">
            <FolderOpen className="size-4 text-accent" aria-hidden />
            <h2 className="flex-1 font-semibold">Folders Atlas looks after</h2>
            <button type="button" className="btn btn-primary" onClick={() => void run(() => window.files.pick())}>
              <FolderPlus className="size-4" aria-hidden /> Add folders
            </button>
          </header>
          <p className="text-xs text-muted">
            Atlas only sees the folders you add here. Start with read only; allow organising where you want it to move, rename and tidy. Every change can be undone, and
            removing always goes to the Recycle Bin after asking you.
          </p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {state.folders.length === 0 && <p className="tile px-3 py-4 text-center text-sm text-muted">No folders yet. Downloads, Documents and Desktop are good first choices.</p>}
          {state.folders.map(f => (
            <div key={f.id} className="tile flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{f.name}</p>
                <p className="truncate font-mono text-[11px] text-muted" title={f.path}>
                  {f.path}
                </p>
              </div>
              <div className="w-64">
                <Select
                  label={`What Atlas may do in ${f.name}`}
                  value={f.access}
                  onChange={v => void run(() => window.files.setAccess(f.id, v as FileAccess))}
                  items={(Object.keys(ACCESS_LABEL) as FileAccess[]).map(k => ({ value: k, label: ACCESS_LABEL[k] }))}
                  className="py-1 text-xs"
                />
              </div>
              <button type="button" className="icon-btn" onClick={() => void run(() => window.files.reveal(f.path))} aria-label={`Open ${f.name} in Explorer`} title="Open in Explorer">
                <FolderOpen className="size-4" aria-hidden />
              </button>
              <button type="button" className="icon-btn" onClick={() => void run(() => window.files.remove(f.id))} aria-label={`Stop looking after ${f.name}`} title="Remove (the folder itself is not touched)">
                <Trash2 className="size-4" aria-hidden />
              </button>
            </div>
          ))}

          <div className="tile space-y-1.5 px-3 py-3">
            <p className="hud-label flex items-center gap-1.5">
              <ShieldCheck className="size-3.5" aria-hidden /> Ask Atlas, for example
            </p>
            {EXAMPLES.map(e => (
              <p key={e} className="text-sm text-muted">
                “{e}”
              </p>
            ))}
            <button type="button" className="btn mt-1" onClick={onTalk}>
              Talk to Atlas
            </button>
          </div>
        </section>

        <section className="glass rise-in space-y-2 rounded-2xl p-4">
          <header className="flex items-center gap-2">
            <History className="size-4 text-accent" aria-hidden />
            <h2 className="flex-1 font-semibold">What Atlas changed</h2>
          </header>
          {state.history.length === 0 && <p className="text-xs text-muted">Nothing yet. Moves, renames, new folders and Recycle Bin items appear here, with undo.</p>}
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
    <div className={`tile px-3 py-2 ${b.undoneAt ? 'opacity-60' : ''}`}>
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
          <button type="button" className="btn h-7 px-2 text-xs" onClick={onUndo}>
            <Undo2 className="size-3.5" aria-hidden /> Undo
          </button>
        )}
      </div>
    </div>
  )
}
