/**
 * Learning › Your memory, in the page: MEMORY.md and the daily notes, read
 * here wherever Atlas runs (on a server there is no editor to open them in).
 * MEMORY.md can be edited and saved; Atlas reads the change back within a few
 * seconds. A file changed since it was opened is never overwritten blind.
 */
import { CalendarDays, Check, FileText, Pencil, RefreshCw, X } from 'lucide-react'
import { Fragment, useEffect, useState, type ReactNode } from 'react'

import type { MemoryFileEntry, MemoryFileText } from '../../shared/learning.ts'
import { nameOf } from './ui/assistantName.ts'

const clean = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.')

/** **bold** and `code` inside a line, as React (never as HTML). */
const inline = (text: string): ReactNode[] =>
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
      <code key={i} className="rounded bg-black/30 px-1 text-[0.92em]">
        {part.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  )

/** Enough Markdown for Atlas's own files: headings, bullets, paragraphs, comments hidden. */
function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = []
  let list: ReactNode[] = []
  const flush = () => {
    if (list.length) out.push(<ul key={`l${out.length}`} className="ml-4 list-disc space-y-0.5">{list}</ul>)
    list = []
  }
  text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
      if (bullet) return list.push(<li key={i}>{inline(bullet[1]!)}</li>)
      flush()
      const h = /^(#{1,3})\s+(.*)$/.exec(line)
      if (h) {
        const size = h[1]!.length === 1 ? 'text-base' : h[1]!.length === 2 ? 'text-sm' : 'text-[13px]'
        return out.push(
          <p key={i} className={`${size} mt-3 font-semibold text-accent first:mt-0`}>
            {inline(h[2]!)}
          </p>,
        )
      }
      if (line.trim()) out.push(<p key={i}>{inline(line)}</p>)
    })
  flush()
  return <div className="space-y-1 text-[13px] leading-relaxed">{out}</div>
}

const day = (path: string) => {
  const d = /(\d{4}-\d{2}-\d{2})/.exec(path)?.[1]
  return d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : path
}

export function MemoryViewer({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<MemoryFileEntry[]>([])
  const [open, setOpen] = useState<MemoryFileText | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const load = (path: string) => {
    setError('')
    setDraft(null)
    void window.learning.memoryRead(path).then(setOpen, e => setError(clean(e)))
  }
  useEffect(() => {
    void window.learning.memoryList().then(list => {
      setFiles(list)
      if (list[0]) load(list[0].path)
    }, e => setError(clean(e)))
  }, [])

  const save = () => {
    if (!open || draft === null) return
    setError('')
    void window.learning.memorySave(open.path, draft, open.modified).then(
      f => {
        setOpen(f)
        setDraft(null)
        setSaved(true)
        setTimeout(() => setSaved(false), 4000)
      },
      e => setError(clean(e)),
    )
  }

  return (
    <div className="space-y-2 rounded-lg border border-accent/40 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {files.map(f => (
          <button
            key={f.path}
            type="button"
            onClick={() => load(f.path)}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${open?.path === f.path ? 'border-accent text-accent' : 'border-border text-muted hover:text-text'}`}
          >
            {f.editable ? <FileText className="size-3" aria-hidden /> : <CalendarDays className="size-3" aria-hidden />}
            {f.editable ? 'MEMORY.md' : day(f.path)}
          </button>
        ))}
        <button type="button" onClick={onClose} className="ml-auto rounded-lg p-1 text-muted hover:text-text" aria-label="Close the memory files">
          <X className="size-4" />
        </button>
      </div>

      {open && (
        <>
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="font-mono">{open.path}</span>
            <span>· {new Date(open.modified).toLocaleString()}</span>
            {saved && <span className="text-ok">· saved; {nameOf()} reads it back in a few seconds</span>}
            <span className="ml-auto flex gap-1.5">
              <button type="button" className="btn" onClick={() => load(open.path)} title="Reload">
                <RefreshCw className="size-3.5" aria-hidden />
              </button>
              {open.editable && draft === null && (
                <button type="button" className="btn" onClick={() => setDraft(open.text)}>
                  <Pencil className="size-3.5" aria-hidden /> Edit
                </button>
              )}
              {draft !== null && (
                <>
                  <button type="button" className="btn" onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                  <button type="button" className="btn border-accent text-accent" onClick={save} disabled={draft === open.text}>
                    <Check className="size-3.5" aria-hidden /> Save
                  </button>
                </>
              )}
            </span>
          </div>
          {draft !== null ? (
            <>
              <textarea value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false} className="h-[50vh] w-full resize-y rounded-lg border border-border bg-black/30 p-2 font-mono text-xs leading-relaxed text-text focus:border-accent focus:outline-none" />
              <p className="text-[11px] text-muted">Change a line to correct it, delete one to make {nameOf()} forget it, add a line under a heading to teach it.</p>
            </>
          ) : (
            <div className="max-h-[50vh] overflow-y-auto rounded-lg bg-black/20 p-3">
              <Markdown text={open.text} />
            </div>
          )}
        </>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}
