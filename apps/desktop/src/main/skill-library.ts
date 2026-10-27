/**
 * The SKILL.md library on disk (<data>/skills/<slug>/SKILL.md, with a small
 * .atlas.json beside it saying where it came from and what the check found).
 * Used by the runtime (Atlas's skill tools, the list in its context) and by
 * the gateway (Settings › Skills). Only Markdown is kept: a skill's scripts
 * are never copied or run.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

import { MAX_SKILL_BYTES, parseSkillMd, rawSkillUrl, screenSkill, skillSlug, type SkillEntry, type SkillMd, type SkillPreview } from '../shared/skillmd.ts'

interface Meta {
  source: string
  installed: number
  warnings: string[]
}

const META = '.atlas.json'
/** Reference notes that may come with a skill (Markdown only, a few, small). */
const MAX_NOTES = 10

export class SkillLibrary {
  constructor(private readonly dir: string) {}

  list(): SkillEntry[] {
    if (!existsSync(this.dir)) return []
    const out: SkillEntry[] = []
    for (const slug of readdirSync(this.dir)) {
      const file = join(this.dir, slug, 'SKILL.md')
      if (!existsSync(file)) continue
      const s = parseSkillMd(readFileSync(file, 'utf8'))
      if (typeof s === 'string') continue
      const meta = this.meta(slug)
      out.push({ slug, name: s.name, description: s.description, source: meta.source, installed: meta.installed, warnings: meta.warnings })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  private meta(slug: string): Meta {
    try {
      return JSON.parse(readFileSync(join(this.dir, slug, META), 'utf8')) as Meta
    } catch {
      return { source: 'folder', installed: 0, warnings: [] }
    }
  }

  /** A skill by its name or folder name: its instructions and the notes beside it. */
  read(name: string): { skill: SkillMd; entry: SkillEntry; notes: string[] } | null {
    const want = name.trim().toLowerCase()
    const entry = this.list().find(s => s.slug === want || s.name.toLowerCase() === want || s.slug === skillSlug(want))
    if (!entry) return null
    const folder = join(this.dir, entry.slug)
    const skill = parseSkillMd(readFileSync(join(folder, 'SKILL.md'), 'utf8')) as SkillMd
    const notes = readdirSync(folder).filter(f => f !== 'SKILL.md' && extname(f).toLowerCase() === '.md')
    return { skill, entry, notes }
  }

  /** One of a skill's own notes (the files its instructions point to). */
  note(slug: string, file: string): string | null {
    const safe = basename(file)
    const path = join(this.dir, slug, safe)
    return extname(safe).toLowerCase() === '.md' && existsSync(path) ? readFileSync(path, 'utf8') : null
  }

  /** Fetches and checks a skill without keeping it: a web address (GitHub pages too) or a folder or SKILL.md on this PC. */
  async preview(source: string): Promise<SkillPreview & { notes: Record<string, string>; text: string }> {
    const src = source.trim()
    let text: string
    const notes: Record<string, string> = {}
    const ignored: string[] = []
    if (/^https:\/\//i.test(src)) {
      const url = rawSkillUrl(src)
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' })
      if (!res.ok) throw new Error(`That address answered ${res.status}.`)
      text = await res.text()
    } else if (/^http:\/\//i.test(src)) {
      throw new Error('Only https addresses, or a folder on this PC.')
    } else {
      const path = resolve(src)
      if (!existsSync(path)) throw new Error('No such folder or file on this PC.')
      const folder = statSync(path).isDirectory() ? path : resolve(path, '..')
      const file = statSync(path).isDirectory() ? join(path, 'SKILL.md') : path
      if (!existsSync(file)) throw new Error('That folder has no SKILL.md.')
      text = readFileSync(file, 'utf8')
      for (const f of readdirSync(folder)) {
        const full = join(folder, f)
        if (full === file || statSync(full).isDirectory()) continue
        if (extname(f).toLowerCase() === '.md' && Object.keys(notes).length < MAX_NOTES && statSync(full).size <= MAX_SKILL_BYTES) notes[f] = readFileSync(full, 'utf8')
        else ignored.push(f)
      }
    }
    if (text.length > MAX_SKILL_BYTES) throw new Error('That SKILL.md is too large (over 100 KB).')
    const skill = parseSkillMd(text)
    if (typeof skill === 'string') throw new Error(skill)
    const warnings = [...screenSkill(skill), ...Object.entries(notes).flatMap(([f, t]) => {
      const n = parseSkillMd(`---\nname: n\ndescription: d\n---\n${t}`)
      return typeof n === 'string' ? [] : screenSkill(n).map(w => `${f}: ${w}`)
    })]
    return { skill, source: src, warnings, ignored, notes, text }
  }

  async install(source: string): Promise<SkillEntry> {
    const p = await this.preview(source)
    const slug = skillSlug(p.skill.name)
    if (!slug) throw new Error('The skill needs a name made of letters or digits.')
    const folder = join(this.dir, slug)
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { recursive: true })
    // Exactly the text that was checked.
    writeFileSync(join(folder, 'SKILL.md'), p.text)
    for (const [f, t] of Object.entries(p.notes)) writeFileSync(join(folder, basename(f)), t)
    const meta: Meta = { source: p.source, installed: Date.now(), warnings: p.warnings }
    writeFileSync(join(folder, META), JSON.stringify(meta, null, 2))
    return { slug, name: p.skill.name, description: p.skill.description, ...meta }
  }

  /** A skill Atlas wrote (from what the owner taught it), in the shared format so it can be shared. */
  writeOwn(skill: { name: string; description: string; body: string }): SkillEntry {
    const slug = skillSlug(skill.name)
    const folder = join(this.dir, slug)
    mkdirSync(folder, { recursive: true })
    const yaml = (v: string) => JSON.stringify(v.replace(/\s+/g, ' ').trim())
    writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${yaml(skill.name)}\ndescription: ${yaml(skill.description)}\n---\n\n${skill.body.trim()}\n`)
    const meta: Meta = { source: 'atlas', installed: Date.now(), warnings: [] }
    writeFileSync(join(folder, META), JSON.stringify(meta, null, 2))
    return { slug, name: skill.name, description: skill.description, ...meta }
  }

  remove(slug: string): boolean {
    const folder = join(this.dir, basename(slug))
    if (!existsSync(join(folder, 'SKILL.md'))) return false
    rmSync(folder, { recursive: true, force: true })
    return true
  }
}
