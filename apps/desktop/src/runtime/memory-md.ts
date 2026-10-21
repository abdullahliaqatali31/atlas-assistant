/**
 * Atlas's memory as Markdown the owner can read and edit: MEMORY.md (every
 * current memory, by kind) and memory/YYYY-MM-DD.md (what each day added).
 * SQLite stays the source of truth; edits in MEMORY.md flow back: a changed
 * line corrects that memory, a removed line forgets it, a new line under a
 * heading teaches it. The <!-- m:… --> marks tie lines to memories.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MemoryKind, MemoryRecord, MemoryStore } from '@assistant/memory'

const HEADINGS: [MemoryKind, string][] = [
  ['fact', 'Facts'],
  ['preference', 'Likes and preferences'],
  ['lesson', 'Lessons'],
  ['observation', 'Observations'],
  ['hypothesis', 'Hunches (not sure yet)'],
]
const KIND_OF = new Map(HEADINGS.map(([k, h]) => [h.toLowerCase(), k]))

export interface MdLine {
  kind: MemoryKind
  text: string
  /** The memory's short id, when the line came from one. */
  id: string | null
}

const short = (id: string) => id.slice(0, 8)
/** A statement on one line, without anything that would break the mark. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').replace(/<!--|-->/g, '').trim()

export const renderMemory = (memories: MemoryRecord[], owner: string): string => {
  const out = [
    `# What Atlas knows${owner ? ` about ${owner}` : ''}`,
    '',
    '> Edit freely: change a line to correct it, delete a line to forget it, add a line under a heading to teach it.',
    '> Keep the <!-- m:… --> marks at the ends of lines. Saved changes reach Atlas within a few seconds.',
    '',
  ]
  for (const [kind, heading] of HEADINGS) {
    out.push(`## ${heading}`, '')
    for (const m of memories.filter(x => x.kind === kind)) out.push(`- ${oneLine(m.statement)} <!-- m:${short(m.id)} -->`)
    out.push('')
  }
  return out.join('\n')
}

export const parseMemory = (text: string): MdLine[] => {
  const lines: MdLine[] = []
  let kind: MemoryKind | null = null
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(raw)
    if (h) {
      kind = KIND_OF.get(h[1]!.toLowerCase()) ?? null
      continue
    }
    const item = /^\s*[-*]\s+(.+?)\s*$/.exec(raw)
    if (!item || !kind) continue
    const mark = /\s*<!--\s*m:([0-9a-f]{8})\s*-->\s*$/i.exec(item[1]!)
    const text = oneLine(mark ? item[1]!.slice(0, mark.index) : item[1]!)
    if (text) lines.push({ kind, text, id: mark ? mark[1]!.toLowerCase() : null })
  }
  return lines
}

export type MemoryEdit = { op: 'correct'; id: string; text: string } | { op: 'forget'; id: string } | { op: 'add'; kind: MemoryKind; text: string }

/** What the owner changed in the file, against what was written last. */
export const diffMemory = (written: MdLine[], edited: MdLine[]): MemoryEdit[] => {
  const edits: MemoryEdit[] = []
  const now = new Map(edited.filter(l => l.id).map(l => [l.id!, l]))
  for (const w of written) {
    if (!w.id) continue
    const e = now.get(w.id)
    if (!e) edits.push({ op: 'forget', id: w.id })
    else if (e.text !== w.text) edits.push({ op: 'correct', id: w.id, text: e.text })
  }
  const known = new Set(written.map(w => w.id))
  for (const e of edited) if (!e.id || !known.has(e.id)) edits.push({ op: 'add', kind: e.kind, text: e.text.slice(0, 300) })
  return edits
}

const day = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class MemoryMirror {
  private written: MdLine[] = []
  private writtenAt = 0
  private signature = ''

  constructor(
    private readonly memory: MemoryStore,
    private readonly dir: string,
    private readonly opts: { owner: () => string; now: () => number; log: (level: 'info' | 'warn', message: string) => void; changed?: () => void },
  ) {
    mkdirSync(join(dir, 'memory'), { recursive: true })
  }

  get file() {
    return join(this.dir, 'MEMORY.md')
  }

  /** Brings both sides together: the owner's edits first, then the file from the database. */
  sync() {
    try {
      if (existsSync(this.file) && this.writtenAt && statSync(this.file).mtimeMs > this.writtenAt + 1) this.applyEdits()
      const all = this.memory.allMemories()
      const sig = `${all.length}:${all.map(m => short(m.id)).join('')}:${all.reduce((n, m) => n + m.statement.length, 0)}`
      if (sig !== this.signature || !existsSync(this.file)) this.write(all, sig)
      this.writeToday(all)
    } catch (e) {
      this.opts.log('warn', `Memory files: ${(e as Error).message}`)
    }
  }

  private write(all: MemoryRecord[], sig: string) {
    const text = renderMemory(all, this.opts.owner())
    writeFileSync(this.file, text)
    this.written = parseMemory(text)
    this.writtenAt = statSync(this.file).mtimeMs
    this.signature = sig
  }

  private applyEdits() {
    const edited = parseMemory(readFileSync(this.file, 'utf8'))
    const edits = diffMemory(this.written, edited)
    if (!edits.length) return
    const byShort = new Map(this.memory.allMemories().map(m => [short(m.id), m]))
    const source = { kind: 'owner' as const, origin: 'memory-file', retrievedAt: this.opts.now() }
    for (const e of edits) {
      if (e.op === 'add') this.memory.remember({ kind: e.kind, statement: e.text, source })
      else {
        const m = byShort.get(e.id)
        if (!m) continue
        if (e.op === 'forget') this.memory.forget(m.id)
        else this.memory.correct(m.id, e.text, source)
      }
    }
    this.opts.log('info', `Memory file: applied ${edits.length} change${edits.length === 1 ? '' : 's'} from MEMORY.md.`)
    this.opts.changed?.()
  }

  /** memory/YYYY-MM-DD.md: what today added, and what got done. */
  private writeToday(all: MemoryRecord[]) {
    const now = this.opts.now()
    const today = day(now)
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const added = all.filter(m => m.createdAt >= start.getTime())
    const done = this.memory.tasksCompletedSince(start.getTime())
    const lines = [`# ${today}`, '']
    lines.push('## Learned today', '', ...(added.length ? added.map(m => `- ${oneLine(m.statement)}`) : ['- (nothing new)']), '')
    lines.push('## Done today', '', ...(done.length ? done.map(t => `- ${oneLine(t.title)}${t.evidence ? ` (${oneLine(t.evidence)})` : ''}`) : ['- (nothing marked done)']), '')
    const file = join(this.dir, 'memory', `${today}.md`)
    const text = lines.join('\n')
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text)
  }
}
