import type { ItemStatus, Roadmap, RoadmapPhase } from '../types'

export const ROADMAP_PATH = 'docs/roadmap.json'

const STATUSES: readonly ItemStatus[] = ['todo', 'doing', 'done']

/** Parses and validates docs/roadmap.json; throws a readable message on bad shape. */
export const parseRoadmap = (text: string): Roadmap => {
  const raw = JSON.parse(text) as { phases?: unknown }
  if (!Array.isArray(raw.phases)) throw new Error('roadmap.json needs a "phases" array')
  const phases = raw.phases.map((p, i): RoadmapPhase => {
    const phase = p as Partial<RoadmapPhase>
    if (typeof phase.name !== 'string' || !Array.isArray(phase.items)) {
      throw new Error(`phase ${i} needs "name" and "items"`)
    }
    return {
      id: String(phase.id ?? i),
      name: phase.name,
      items: phase.items.map((it, j) => {
        if (typeof it?.title !== 'string' || !STATUSES.includes(it.status)) {
          throw new Error(`phase ${phase.name}, item ${j}: needs "title" and status todo|doing|done`)
        }
        return { title: it.title, status: it.status }
      }),
    }
  })
  return { phases }
}

export const countDone = (phase: RoadmapPhase) => phase.items.filter(i => i.status === 'done').length

/** The first phase that still has unfinished items, or the last one when all are done. */
export const currentPhase = (roadmap: Roadmap): RoadmapPhase | undefined =>
  roadmap.phases.find(p => countDone(p) < p.items.length) ?? roadmap.phases.at(-1)

export const bar = (done: number, total: number, width = 12) => {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

export const statusLine = (roadmap: Roadmap) => {
  const phase = currentPhase(roadmap)
  if (!phase) return undefined
  const all = roadmap.phases.flatMap(p => p.items)
  const doneAll = all.filter(i => i.status === 'done').length
  return `Phase ${phase.id} · ${phase.name} ${countDone(phase)}/${phase.items.length} · overall ${Math.round((doneAll / Math.max(1, all.length)) * 100)}%`
}

/** Titles newly marked done between two versions of the roadmap. */
export const newlyDone = (before: Roadmap | null, after: Roadmap): string[] => {
  const was = new Set(before?.phases.flatMap(p => p.items.filter(i => i.status === 'done').map(i => i.title)) ?? [])
  return after.phases.flatMap(p => p.items).filter(i => i.status === 'done' && !was.has(i.title)).map(i => i.title)
}

/** Provider keys that must never be written into the repository. */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'ElevenLabs API key', re: /\bsk_[a-f0-9]{40,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
]

/** `.env` and `.env.local` stay local (gitignored); `.env.example` must stay key-free. */
const isLocalEnvFile = (path: string) => /(^|[\\/])\.env(\.local)?$/.test(path)

export const findSecret = (path: string, text: string): string | undefined => {
  if (isLocalEnvFile(path)) return undefined
  return SECRET_PATTERNS.find(p => p.re.test(text))?.name
}
