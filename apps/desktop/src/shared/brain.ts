/**
 * The brain view on the Home page: Atlas's real memories (facts,
 * preferences, observations, hypotheses, lessons) and skills as a living
 * graph, the connections between them (made when a memory is saved,
 * strengthened when memories are used together), and which memories a turn
 * is using right now. Private: only the owner's own window may read it.
 */

export const BRAIN_KINDS = ['preference', 'fact', 'lesson', 'observation', 'hypothesis', 'skill'] as const
export type BrainKind = (typeof BRAIN_KINDS)[number]

export const BRAIN_KIND_LABEL: Record<BrainKind, string> = { preference: 'Likes & preferences', fact: 'Facts about you', lesson: 'Lessons', observation: 'Observations', hypothesis: 'Hunches', skill: 'Skills' }
export const BRAIN_KIND_COLOR: Record<BrainKind, string> = { preference: '#f472b6', fact: '#38bdf8', lesson: '#fbbf24', observation: '#34d399', hypothesis: '#a78bfa', skill: '#22d3ee' }

export interface BrainNode {
  id: string
  kind: BrainKind
  text: string
  /** Where it came from: conversation (you said it), learned (Atlas noticed), correction, a skill… */
  origin: string
  confidence: number
  createdAt: number
  uses: number
  lastUsed: number | null
  /** Links it has (for size and the card). */
  degree: number
}

export interface BrainLink {
  a: string
  b: string
  weight: number
  uses: number
}

export interface BrainView {
  owner: string
  nodes: BrainNode[]
  links: BrainLink[]
}

export type BrainOp = { kind: 'view' } | { kind: 'forget'; id: string } | { kind: 'find'; refresh?: boolean | undefined }

/** Today's find: one true thing from today's Wikipedia feed, picked for the owner and told in their style. */
export interface DailyFind {
  /** The owner's local date, YYYY-MM-DD. */
  date: string
  title: string
  fact: string
  why: string
  url: string | null
  image: string | null
  source: string
}

export type BrainHostRequest = { type: 'brain'; requestId: string; op: BrainOp }
export type BrainHostEvent = { type: 'brain'; requestId: string; view?: BrainView | undefined; find?: DailyFind | null | undefined; error?: string | undefined } | { type: 'memory-used'; ids: string[]; why: MemoryUseWhy }

export type MemoryUseWhy = 'context' | 'search' | 'saved'

export const BR = {
  view: 'brain:view',
  forget: 'brain:forget',
  used: 'brain:used',
  find: 'brain:find',
} as const

export interface BrainBridge {
  view(): Promise<BrainView | null>
  forget(id: string): Promise<BrainView | null>
  /** Today's find (made once a day; refresh makes a new one). */
  find(refresh?: boolean): Promise<DailyFind | null>
  /** Memories a turn is using (light them up), or one just saved (it is born). */
  onUsed(cb: (e: { ids: string[]; why: MemoryUseWhy }) => void): () => void
}

/** A memory's own short words for a label. */
export const brainLabel = (text: string, max = 42) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
