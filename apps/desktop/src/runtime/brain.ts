/**
 * The brain view, runtime side: the live memories with their use and links,
 * plus the saved skills, shaped for the Home page.
 */
import type { MemoryStore } from '@assistant/memory'

import type { BrainKind, BrainView } from '../shared/brain.ts'

export const brainView = (memory: MemoryStore, owner: string): BrainView => {
  const { memories, links } = memory.brain(600)
  const degree = new Map<string, number>()
  for (const l of links) for (const id of [l.a, l.b]) degree.set(id, (degree.get(id) ?? 0) + 1)
  const nodes: BrainView['nodes'] = memories.map(m => ({
    id: m.id,
    kind: m.kind as BrainKind,
    text: m.statement,
    origin: m.source.origin ?? m.source.kind,
    confidence: m.confidence,
    createdAt: m.createdAt,
    uses: m.uses,
    lastUsed: m.lastUsed,
    degree: degree.get(m.id) ?? 0,
  }))
  for (const s of memory.skills().slice(0, 60))
    nodes.push({ id: `skill:${s.id}`, kind: 'skill', text: `${s.name}: ${s.goal}`, origin: 'skill', confidence: 1, createdAt: (s as { createdAt?: number }).createdAt ?? 0, uses: 0, lastUsed: null, degree: 0 })
  return { owner, nodes, links }
}
