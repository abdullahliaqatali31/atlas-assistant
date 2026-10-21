/**
 * Runs the learning service inside the runtime host: an idle pass when the
 * owner steps away (lock, sleep, idle) and at most every 30 minutes while
 * the app is quiet, plus on request from the Learning screen.
 */
import type { MemoryStore } from '@assistant/memory'
import type { LlmProvider } from '@assistant/providers'
import { describeSchedule, Learner, skillContextLines, type IdleReport, type LearningSnapshot } from '@assistant/runtime'
import type { InitiativeEvent } from '@assistant/shared'
import type { Clock } from '@assistant/shared'

import type { SessionChange } from '../shared/ipc.ts'
import type { LearningHostEvent, LearningHostRequest, LearningView } from '../shared/learning.ts'
import type { Improvements } from './improvements.ts'

const PERIOD_MS = 30 * 60_000

const summarize = (r: IdleReport): string => {
  const m = r.memory
  if (!m.ran && r.workflowsProposed.length === 0) return m.reason === 'not enough new conversation' ? 'Nothing new to learn yet.' : 'Up to date.'
  const parts = [
    m.saved.length ? `learned ${m.saved.length} ${m.saved.length === 1 ? 'fact' : 'facts'}` : '',
    m.updated.length ? `updated ${m.updated.length}` : '',
    m.proposed.length + r.workflowsProposed.length ? `${m.proposed.length + r.workflowsProposed.length} suggestion(s) for you` : '',
    m.followups.length ? `${m.followups.length} thing(s) to ask you about later` : '',
    m.merged ? `merged ${m.merged} duplicate(s)` : '',
  ].filter(Boolean)
  return parts.length ? `${parts.join(', ')}.`.replace(/^./, c => c.toUpperCase()) : 'Nothing new worth remembering.'
}

export class HostLearning {
  readonly learner: Learner
  private running: Promise<IdleReport> | null = null
  private lastResult: string | null = null
  private timer: ReturnType<typeof setInterval>

  constructor(
    private readonly deps: {
      memory: MemoryStore
      llm: LlmProvider
      clock: Clock
      /** Owner's UTC offset: "kal" in a follow-up means their tomorrow. */
      utcOffsetMin?: number
      /** Starts a turn in the conversation on the owner's request (Teach, Run now). */
      speak?: (event: Extract<InitiativeEvent, { type: 'agenda' }>) => void
      post: (e: LearningHostEvent) => void
      /** True while a reply is streaming: learning waits. */
      busy: () => boolean
      improvements?: Improvements | undefined
      /** Followed coding projects, for choosing where briefs go. */
      projects?: () => string[]
      /** Memory as files, and recall by meaning (its switch). */
      memoryView?: () => LearningView['memory']
      setSemantic?: (on: boolean) => void
      log: (level: 'info' | 'warn', message: string) => void
    },
  ) {
    this.learner = new Learner({ memory: deps.memory, llm: deps.llm, clock: deps.clock, utcOffsetMin: deps.utcOffsetMin })
    this.timer = setInterval(() => void this.runIdle(), PERIOD_MS)
    this.timer.unref?.()
  }

  stop() {
    clearInterval(this.timer)
  }

  view(): LearningView {
    const s: LearningSnapshot = this.learner.snapshot()
    return {
      pending: s.pending.map(p => ({ id: p.id, kind: p.kind, title: p.title, evidence: p.evidence, createdAt: p.createdAt })),
      learned: s.learned,
      workflows: s.workflows,
      skills: this.deps.memory.skills().map(k => {
        const last = this.deps.memory.skillRuns(k.id, 1)[0]
        return {
          id: k.id,
          name: k.name,
          goal: k.goal,
          steps: k.steps,
          inputs: k.inputs,
          check: k.check,
          approve: k.approve,
          runs: describeSchedule(k.schedule, this.deps.utcOffsetMin ?? 0),
          when: k.when,
          auto: k.auto,
          status: k.status,
          lastRun: last ? { at: last.startedAt, ok: last.ok, summary: last.summary } : null,
        }
      }),
      // Upcoming and just-passed ones: what it will ask about.
      followups: this.deps.memory
        .followups(50)
        .filter(f => f.status === 'open' && f.dueAt > this.deps.clock.now() - 2 * 24 * 60 * 60_000)
        .map(f => ({ id: f.id, about: f.about, quote: f.quote, dueAt: f.dueAt }))
        .reverse(),
      personalityChanges: s.personalityChanges,
      lastRunAt: s.lastRunAt,
      running: this.running !== null,
      lastResult: this.lastResult,
      improvements: this.deps.improvements?.list() ?? [],
      improvementProject: this.deps.improvements?.project ?? null,
      projects: this.deps.projects?.() ?? [],
      memory: this.deps.memoryView?.() ?? { file: '', folder: '', semantic: { on: false, state: 'off', progress: 0, indexed: 0, total: 0, error: null } },
    }
  }

  /** The memory files or the meaning model changed. */
  memoryChanged() {
    this.publish()
  }

  private publish() {
    this.deps.post({ type: 'learning-changed', view: this.view() })
  }

  /** Called for every owner message by the Assistant (via its `learning` dep). */
  observeOwner(text: string) {
    const out = this.learner.observeOwner(text)
    if (out.length) {
      this.deps.log('info', `learning: ${out.map(o => `${o.kind} ${o.description}`).join('; ')}`)
      this.publish()
    }
    return out
  }

  /** Approved lessons and routines, plus the skills it was taught and how to learn new ones. */
  contextLines() {
    return [...this.learner.contextLines(), ...skillContextLines(this.deps.memory, this.deps.utcOffsetMin ?? 0)]
  }

  /** Stepping away is the natural moment to tidy memory. */
  session(change: SessionChange) {
    if (change.signal === 'idle' || change.signal === 'lock' || change.signal === 'suspend') void this.runIdle()
  }

  async runIdle(force = false): Promise<void> {
    if (this.running || (!force && this.deps.busy())) return
    this.running = this.learner.runIdle({ force })
    this.publish()
    try {
      const r = await this.running
      this.lastResult = summarize(r)
      if (r.memory.ran || r.workflowsProposed.length) this.deps.log('info', `learning: ${this.lastResult}`)
    } catch (error) {
      this.lastResult = `Learning failed: ${error instanceof Error ? error.message : String(error)}`
      this.deps.log('warn', this.lastResult)
    } finally {
      this.running = null
      this.publish()
    }
  }

  async handle(req: LearningHostRequest): Promise<LearningHostEvent> {
    const ok = (): LearningHostEvent => ({ type: 'learning', requestId: req.requestId, view: this.view() })
    try {
      switch (req.op.kind) {
        case 'get':
          return ok()
        case 'decide':
          this.learner.decide(req.op.id, req.op.accept)
          return ok()
        case 'forget':
          this.learner.forget(req.op.id)
          return ok()
        case 'remove-workflow':
          this.learner.removeWorkflow(req.op.id)
          return ok()
        case 'drop-followup':
          this.deps.memory.closeFollowup(req.op.id)
          return ok()
        case 'skill-update':
          this.deps.memory.updateSkill(req.op.id, { status: req.op.status, auto: req.op.auto })
          return ok()
        case 'skill-delete':
          this.deps.memory.deleteSkill(req.op.id)
          return ok()
        case 'skill-run': {
          const skill = this.deps.memory.skill(req.op.id)
          if (!skill) throw new Error('That skill no longer exists.')
          if (!this.deps.speak) throw new Error('The assistant is not ready yet.')
          const now = this.deps.clock.now()
          this.deps.speak({
            type: 'agenda',
            at: now,
            key: `skill-now:${skill.id}:${now}`,
            kind: 'task',
            title: `Doing: ${skill.name}`,
            instruction: `The owner pressed Run now for the skill "${skill.name}". Call skill_run with name "${skill.name}" and trigger "owner", do it, then report the result.`,
            evidence: 'You pressed Run now.',
            expectsAnswer: false,
          })
          return ok()
        }
        case 'teach': {
          if (!this.deps.speak) throw new Error('The assistant is not ready yet.')
          const now = this.deps.clock.now()
          this.deps.speak({
            type: 'agenda',
            at: now,
            key: `teach:${now}`,
            kind: 'question',
            title: 'Teach me a new task',
            instruction: 'The owner pressed "Teach a new task". Ask, warmly and in one or two sentences, which task they want to teach you, and say they can explain it in their own words or do it together with you once.',
            evidence: 'You pressed Teach a new task.',
            expectsAnswer: true,
          })
          return ok()
        }
        case 'run':
          await this.runIdle(true)
          return ok()
        case 'improvement-done':
          this.deps.improvements?.markDone(req.op.id)
          return ok()
        case 'improvement-remove':
          this.deps.improvements?.remove(req.op.id)
          return ok()
        case 'improvement-project':
          if (req.op.name !== null && !(this.deps.projects?.() ?? []).includes(req.op.name)) throw new Error('Choose one of your followed coding projects.')
          this.deps.improvements?.setProject(req.op.name)
          return ok()
        case 'semantic':
          this.deps.setSemantic?.(req.op.on)
          return ok()
      }
    } catch (error) {
      return { type: 'learning', requestId: req.requestId, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
