/**
 * The learning service: one place that observes, proposes, and applies only
 * what the owner allows (plan section 8: observe → candidate → evidence →
 * confirm → save → apply). Nothing here edits code, permissions or safety.
 */
import type { MemoryStore, Proposal } from '@assistant/memory'
import type { LlmProvider } from '@assistant/providers'
import type { Clock } from '@assistant/shared'

import { MemoryManager, type ManagerReport } from './memory-manager.ts'
import { PersonalityAdapter, type StyleField, type StyleOutcome } from './style.ts'
import { mineWorkflows, workflowName } from './workflows.ts'

export interface LearnedItem {
  id: string
  kind: string
  statement: string
  evidence: string
  at: number
}

export interface LearningSnapshot {
  /** Waiting for the owner's yes or no, newest first. */
  pending: Proposal[]
  /** Facts and preferences learned from conversation, and accepted lessons. */
  learned: LearnedItem[]
  workflows: { id: string; name: string; steps: string[]; createdAt: number }[]
  /** Profile versions the adapter wrote, newest first. */
  personalityChanges: { version: number; reason: string; at: number }[]
  lastRunAt: number | null
}

export interface IdleReport {
  memory: ManagerReport
  workflowsProposed: string[]
}

export class Learner {
  readonly personality: PersonalityAdapter
  readonly manager: MemoryManager

  constructor(private readonly deps: { memory: MemoryStore; llm: LlmProvider; clock: Clock; utcOffsetMin?: number }) {
    this.personality = new PersonalityAdapter(deps.memory, deps.clock)
    this.manager = new MemoryManager(deps)
  }

  /** Every owner message: style feedback is handled at once. */
  observeOwner(text: string): StyleOutcome[] {
    return this.personality.observe(text)
  }

  /** When the owner is idle: memory pass, then routine mining. */
  async runIdle(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<IdleReport> {
    const memory = await this.manager.run(opts)
    const workflowsProposed: string[] = []
    const actions = this.deps.memory.recentActions(1000).map(a => ({ tool: a.tool, result: a.result, at: a.at }))
    const existing = new Set(this.deps.memory.workflows().map(w => w.steps.join(' > ')))
    for (const w of mineWorkflows(actions)) {
      const key = w.steps.join(' > ')
      if (existing.has(key)) continue
      const id = this.deps.memory.addProposal({
        kind: 'workflow',
        title: `Save “${workflowName(w.steps)}” as a routine?`,
        detail: { steps: w.steps },
        evidence: `You did these ${w.steps.length} steps together ${w.count} times on ${w.days} different days.`,
        dedupKey: `workflow:${key}`,
      })
      if (id) workflowsProposed.push(workflowName(w.steps))
    }
    return { memory, workflowsProposed }
  }

  /** Applies or dismisses one proposal. Returns the updated snapshot. */
  decide(id: string, accept: boolean): LearningSnapshot {
    const { memory, clock } = this.deps
    const p = memory.proposal(id)
    if (!p || p.status !== 'pending') throw new Error('That suggestion was already handled.')
    if (accept) {
      const detail = p.detail as Record<string, unknown>
      const source = { kind: 'owner' as const, origin: 'learned', locator: p.evidence.slice(0, 200), retrievedAt: clock.now() }
      switch (p.kind) {
        case 'personality':
          this.personality.apply(detail.field as StyleField, detail.value)
          break
        case 'lesson':
          memory.remember({ kind: 'lesson', statement: String(detail.statement), source, confidence: 1 })
          break
        case 'memory':
          // Confirmed by the owner, so it is a fact now, not a guess.
          memory.remember({ kind: 'fact', statement: String(detail.statement), source, confidence: 1 })
          break
        case 'workflow':
          memory.addWorkflow(workflowName(detail.steps as string[]), detail.steps as string[])
          break
      }
    }
    memory.decideProposal(id, accept ? 'accepted' : 'rejected')
    return this.snapshot()
  }

  /** Forget something learned (it and its index entry are deleted). */
  forget(memoryId: string): LearningSnapshot {
    this.deps.memory.forget(memoryId)
    return this.snapshot()
  }

  removeWorkflow(id: string): LearningSnapshot {
    this.deps.memory.removeWorkflow(id)
    return this.snapshot()
  }

  snapshot(): LearningSnapshot {
    const { memory } = this.deps
    const learned = memory
      .memories(['fact', 'preference', 'lesson'], 200)
      .filter(m => m.kind === 'lesson' || m.source.origin === 'learned')
      .slice(0, 50)
      .map(m => ({ id: m.id, kind: m.kind, statement: m.statement, evidence: m.source.locator ?? '', at: m.createdAt }))
    const last = memory.getSetting('learning.lastExtractAt')
    return {
      pending: memory.proposals('pending', 50),
      learned,
      workflows: memory.workflows().map(({ id, name, steps, createdAt }) => ({ id, name, steps, createdAt })),
      personalityChanges: memory
        .personalityHistory(50)
        .filter(v => v.reason.startsWith('learned'))
        .map(v => ({ version: v.version, reason: v.reason, at: v.at })),
      lastRunAt: last ? Number(last) : null,
    }
  }

  /** What the assistant should keep in mind every turn: accepted lessons and routines. */
  contextLines(): string[] {
    const lessons = this.deps.memory.memories(['lesson'], 8).map(l => `- ${l.statement}`)
    const routines = this.deps.memory.workflows().slice(0, 5).map(w => `- ${w.name}`)
    return [
      lessons.length ? `Lessons the owner approved (follow them):\n${lessons.join('\n')}` : '',
      routines.length ? `Routines the owner approved (offer them when they fit; each step still goes through approval):\n${routines.join('\n')}` : '',
    ].filter(Boolean)
  }
}
