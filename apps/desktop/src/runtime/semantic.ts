/**
 * Recall by meaning, on this PC: a small multilingual model (multilingual-e5
 * small, 118 MB, downloaded once when the owner turns it on) gives every
 * memory a vector, so "meri behan ki shadi kab hai" finds "Hamza's sister
 * is getting married in December". It never replaces keyword search: the two
 * lists are blended, recently and often used memories weigh a little more,
 * and the brain's strongest neighbours of the best hits come along.
 * Loaded on first use, unloaded after a quiet while.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MemoryRecord, MemoryStore } from '@assistant/memory'

export const EMBED_MODEL = 'Xenova/multilingual-e5-small'
const IDLE_UNLOAD_MS = 15 * 60_000
const BATCH = 16

export interface SemanticStatus {
  on: boolean
  state: 'off' | 'loading' | 'indexing' | 'ready' | 'error'
  /** 0..1 while the model downloads. */
  progress: number
  indexed: number
  total: number
  error: string | null
}

type Embedder = (texts: string[], opts: { pooling: 'mean'; normalize: true }) => Promise<{ tolist(): number[][] }>

const DAY = 86_400_000

/**
 * The blend: reciprocal-rank fusion of the keyword and meaning lists, a small
 * lift for memories used lately or often, then the best hits' strongest
 * neighbours. Returns ids, best first.
 */
export const fuse = (
  keyword: readonly string[],
  meaning: readonly { id: string; score: number }[],
  info: (id: string) => { uses: number; lastUsed: number | null } | null,
  neighbours: (id: string) => { id: string; weight: number }[],
  now: number,
  limit: number,
): string[] => {
  const score = new Map<string, number>()
  const add = (id: string, s: number) => score.set(id, (score.get(id) ?? 0) + s)
  keyword.forEach((id, i) => add(id, 1 / (60 + i)))
  // Meaning matches far below the best one are noise for this model; keep the close ones.
  const best = meaning[0]?.score ?? 0
  meaning.filter(m => m.score >= best - 0.05).forEach((m, i) => add(m.id, 1 / (60 + i)))
  for (const id of score.keys()) {
    const u = info(id)
    if (!u) continue
    const recent = u.lastUsed !== null && now - u.lastUsed < 7 * DAY ? 0.002 : 0
    add(id, recent + 0.0008 * Math.log1p(u.uses))
  }
  const top = [...score.entries()].sort((a, b) => b[1] - a[1])
  for (const [id, s] of top.slice(0, 2))
    for (const n of neighbours(id)) if (!score.has(n.id) && n.weight >= 2) score.set(n.id, s * 0.5)
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id)
}

const dot = (a: Float32Array, b: number[]) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

export class SemanticMemory {
  private embedder: Embedder | null = null
  private loading: Promise<Embedder> | null = null
  private unloadTimer: ReturnType<typeof setTimeout> | null = null
  private indexTimer: ReturnType<typeof setInterval> | null = null
  private status: SemanticStatus = { on: false, state: 'off', progress: 0, indexed: 0, total: 0, error: null }

  constructor(
    private readonly memory: MemoryStore,
    private readonly deps: {
      /** Where the model is kept (<data>/models). */
      cacheDir: string
      /** The on/off choice is remembered here. */
      settingsFile: string
      log: (level: 'info' | 'warn', message: string) => void
      changed: () => void
      /** Indexing waits while the owner is in a conversation turn. */
      busy: () => boolean
    },
  ) {
    try {
      this.status.on = existsSync(deps.settingsFile) && (JSON.parse(readFileSync(deps.settingsFile, 'utf8')) as { on?: boolean }).on === true
    } catch {
      this.status.on = false
    }
    if (this.status.on) this.start()
  }

  view(): SemanticStatus {
    return { ...this.status }
  }

  private set(patch: Partial<SemanticStatus>) {
    this.status = { ...this.status, ...patch }
    this.deps.changed()
  }

  setOn(on: boolean) {
    writeFileSync(this.deps.settingsFile, JSON.stringify({ on }))
    this.set({ on, state: on ? this.status.state : 'off', error: null })
    if (on) this.start()
    else this.stop()
  }

  private start() {
    if (this.indexTimer) return
    this.indexTimer = setInterval(() => void this.indexSome(), 4_000)
    this.indexTimer.unref?.()
    void this.indexSome()
  }

  stop() {
    if (this.indexTimer) clearInterval(this.indexTimer)
    this.indexTimer = null
    void this.unload()
  }

  private async model(): Promise<Embedder> {
    if (this.unloadTimer) clearTimeout(this.unloadTimer)
    this.unloadTimer = setTimeout(() => void this.unload(), IDLE_UNLOAD_MS)
    this.unloadTimer.unref?.()
    if (this.embedder) return this.embedder
    this.loading ??= (async () => {
      this.set({ state: 'loading', progress: 0 })
      const t = await import('@huggingface/transformers')
      t.env.cacheDir = this.deps.cacheDir
      t.env.allowLocalModels = false
      const files = new Map<string, number>()
      const pipe = await t.pipeline('feature-extraction', EMBED_MODEL, {
        dtype: 'q8',
        progress_callback: (p: { status?: string; file?: string; progress?: number }) => {
          if (p.status !== 'progress' || !p.file) return
          files.set(p.file, (p.progress ?? 0) / 100)
          const avg = [...files.values()].reduce((a, b) => a + b, 0) / files.size
          if (Math.abs(avg - this.status.progress) > 0.02) this.set({ progress: avg })
        },
      })
      this.embedder = pipe as unknown as Embedder
      this.set({ state: 'ready', progress: 1, error: null })
      return this.embedder
    })()
      .catch(e => {
        this.set({ state: 'error', error: `The memory model could not load: ${(e as Error).message}` })
        throw e
      })
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }

  private async unload() {
    const e = this.embedder as unknown as { dispose?: () => Promise<void> } | null
    this.embedder = null
    await e?.dispose?.().catch(() => undefined)
    if (this.status.on && this.status.state === 'ready') this.set({ state: 'ready' })
  }

  /** A few memories at a time get their vectors, while nothing else is going on. */
  private async indexSome() {
    if (!this.status.on || this.deps.busy() || this.loading) return
    const todo = this.memory.unindexed(EMBED_MODEL, BATCH)
    const total = this.memory.allMemories().length
    if (!todo.length) {
      if (this.status.indexed !== total || this.status.total !== total) this.set({ indexed: total, total })
      return
    }
    try {
      const embed = await this.model()
      if (this.status.state !== 'error') this.set({ state: 'indexing', total })
      const vecs = (await embed(todo.map(m => `passage: ${m.statement}`), { pooling: 'mean', normalize: true })).tolist()
      todo.forEach((m, i) => this.memory.setVector(m.id, EMBED_MODEL, Float32Array.from(vecs[i]!)))
      const left = this.memory.unindexed(EMBED_MODEL, 1).length
      this.set({ state: left ? 'indexing' : 'ready', indexed: total - this.memory.unindexed(EMBED_MODEL, 10_000).length, total })
    } catch (e) {
      this.deps.log('warn', `Memory index: ${(e as Error).message}`)
    }
  }

  /** Keyword and meaning together; just keywords while the model is off or not ready. */
  async recall(query: string, limit: number): Promise<MemoryRecord[]> {
    const keyword = this.memory.recall(query, 12)
    if (!this.status.on || this.status.state === 'error' || !query.trim()) return keyword.slice(0, limit)
    let meaning: { id: string; score: number }[] = []
    try {
      const embed = await this.model()
      const q = (await embed([`query: ${query.slice(0, 500)}`], { pooling: 'mean', normalize: true })).tolist()[0]!
      meaning = this.memory
        .vectors(EMBED_MODEL)
        .map(v => ({ id: v.id, score: dot(v.vec, q) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
    } catch {
      return keyword.slice(0, limit)
    }
    const ids = fuse(
      keyword.map(m => m.id),
      meaning,
      id => this.memory.memoryUse(id),
      id => this.memory.neighbours(id, 3),
      Date.now(),
      limit,
    )
    return this.memory.memoriesByIds(ids)
  }
}

export const semanticSettingsFile = (dataDir: string) => join(dataDir, 'semantic-memory.json')
