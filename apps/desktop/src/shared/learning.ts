/**
 * Contract for the Learning screen (plan section 8): what the assistant
 * proposes to learn, what it learned, and the owner's yes/no. The runtime
 * host owns the data; main validates ids and relays.
 */

export interface ProposalView {
  id: string
  kind: 'personality' | 'memory' | 'lesson' | 'workflow'
  title: string
  evidence: string
  createdAt: number
}

export interface LearnedView {
  id: string
  kind: string
  statement: string
  evidence: string
  at: number
}

export interface SkillView {
  id: string
  name: string
  goal: string
  steps: string[]
  inputs: string[]
  check: string
  approve: string
  /** "every day at 09:00", "Mon, Thu at 10:00", "when you ask". */
  runs: string
  when: string | null
  auto: boolean
  status: 'active' | 'paused'
  lastRun: { at: number; ok: boolean | null; summary: string | null } | null
}

export interface LearningView {
  /** Tasks the owner taught. */
  skills: SkillView[]
  pending: ProposalView[]
  learned: LearnedView[]
  workflows: { id: string; name: string; steps: string[]; createdAt: number }[]
  /** Things the owner mentioned that the assistant will ask about once they have happened. */
  followups: { id: string; about: string; quote: string; dueAt: number }[]
  personalityChanges: { version: number; reason: string; at: number }[]
  lastRunAt: number | null
  running: boolean
  /** Plain summary of the last pass ("Learned 2 facts, 1 suggestion"). */
  lastResult: string | null
}

export const LC = {
  get: 'learning:get',
  decide: 'learning:decide',
  forget: 'learning:forget',
  removeWorkflow: 'learning:remove-workflow',
  dropFollowup: 'learning:drop-followup',
  skillUpdate: 'learning:skill-update',
  skillDelete: 'learning:skill-delete',
  skillRun: 'learning:skill-run',
  teach: 'learning:teach',
  runNow: 'learning:run-now',
  changed: 'learning:changed',
} as const

export interface LearningBridge {
  get(): Promise<LearningView>
  decide(id: string, accept: boolean): Promise<LearningView>
  forget(memoryId: string): Promise<LearningView>
  removeWorkflow(id: string): Promise<LearningView>
  /** Don't ask about this one. */
  dropFollowup(id: string): Promise<LearningView>
  /** Pause or resume a skill, or let it run by itself on its schedule. */
  updateSkill(id: string, patch: { status?: 'active' | 'paused'; auto?: boolean }): Promise<LearningView>
  deleteSkill(id: string): Promise<LearningView>
  /** Atlas starts the skill now, in the conversation. */
  runSkill(id: string): Promise<LearningView>
  /** Atlas asks, in the conversation, what task to learn. */
  teach(): Promise<LearningView>
  /** Learn from today's conversation now instead of waiting for idle time. */
  runNow(): Promise<LearningView>
  onChanged(cb: (v: LearningView) => void): () => void
}

export type LearningOp =
  | { kind: 'get' }
  | { kind: 'decide'; id: string; accept: boolean }
  | { kind: 'forget'; id: string }
  | { kind: 'remove-workflow'; id: string }
  | { kind: 'drop-followup'; id: string }
  | { kind: 'skill-update'; id: string; status?: 'active' | 'paused'; auto?: boolean }
  | { kind: 'skill-delete'; id: string }
  | { kind: 'skill-run'; id: string }
  | { kind: 'teach' }
  | { kind: 'run' }

export const isLearningId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{8,64}$/i.test(v)

export type LearningHostRequest = { type: 'learning'; requestId: string; op: LearningOp }
export type LearningHostEvent =
  | { type: 'learning'; requestId: string; view?: LearningView | undefined; error?: string | undefined }
  /** Pushed when something new was learned or proposed (idle pass, style change). */
  | { type: 'learning-changed'; view: LearningView }
