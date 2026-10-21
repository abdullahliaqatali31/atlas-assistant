/**
 * Learning › Skill library: skills in the shared SKILL.md format (the same
 * files Claude, OpenClaw and others use). Paste a GitHub link or a folder,
 * see what the check found, then install; remove any time. Atlas can also
 * write the tasks you teach it into this library to share them.
 */
import { AlertTriangle, BookOpen, Download, Link2, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import type { SkillEntry, SkillPreview } from '../../shared/skillmd.ts'
import { nameOf } from './ui/assistantName.ts'

const clean = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.')

export function SkillLibrary() {
  const [list, setList] = useState<SkillEntry[]>([])
  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<SkillPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.skillsMd.list().then(setList, () => undefined)
    return window.skillsMd.onChanged(setList)
  }, [])

  const check = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    setPreview(null)
    try {
      setPreview(await window.skillsMd.preview(source))
    } catch (err) {
      setError(clean(err))
    } finally {
      setBusy(false)
    }
  }

  const install = async () => {
    setBusy(true)
    try {
      setList(await window.skillsMd.install(source))
      setPreview(null)
      setSource('')
    } catch (err) {
      setError(clean(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <BookOpen className="size-3.5 text-accent" aria-hidden />
        <h2 className="hud-label flex-1">Skill library (SKILL.md)</h2>
      </div>
      <p className="px-1 text-xs text-muted">
        Ready-made skills in the shared SKILL.md format: {nameOf()} reads each one’s description and follows its instructions when a task fits. Scripts inside a skill are never run, and
        what an installed skill says never overrules your rules.
      </p>

      <form onSubmit={e => void check(e)} className="flex gap-2">
        <input value={source} onChange={e => setSource(e.target.value)} placeholder="GitHub link to a skill, or a folder on this PC" className="field" aria-label="Skill address or folder" />
        <button type="submit" className="btn shrink-0" disabled={busy || !source.trim()}>
          <Link2 className="size-3.5" aria-hidden /> Check
        </button>
      </form>

      {preview && (
        <article className="tile space-y-2 p-3">
          <p className="text-sm font-medium">{preview.skill.name}</p>
          <p className="text-xs text-muted">{preview.skill.description}</p>
          {preview.warnings.length ? (
            <ul className="space-y-1 rounded-lg border border-warm/50 bg-warm/10 p-2 text-xs text-warm">
              {preview.warnings.map(w => (
                <li key={w} className="flex gap-1.5">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden /> {w}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ok">The check found nothing worrying.</p>
          )}
          {preview.ignored.length > 0 && <p className="text-[11px] text-muted">Left out (never run): {preview.ignored.join(', ')}</p>}
          <details className="text-xs">
            <summary className="cursor-pointer text-muted">Read its instructions</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-strong p-2 font-sans">{preview.skill.body}</pre>
          </details>
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void install()}>
              <Download className="size-3.5" aria-hidden /> Install
            </button>
            <button type="button" className="btn" onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </article>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}

      {list.map(s => (
        <article key={s.slug} className="tile flex items-start gap-2 p-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              {s.name}
              {s.warnings.length > 0 && <AlertTriangle className="size-3 text-warm" aria-label={s.warnings.join(' ')} />}
            </p>
            <p className="text-xs text-muted">{s.description}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted">{s.source === 'atlas' ? `Written by ${nameOf()}` : s.source}</p>
          </div>
          <button type="button" className="icon-btn size-7 hover:text-danger" title="Remove" aria-label={`Remove ${s.name}`} onClick={() => void window.skillsMd.remove(s.slug).then(setList)}>
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        </article>
      ))}
    </section>
  )
}
