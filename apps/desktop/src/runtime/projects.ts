/**
 * Runtime side of the Projects IPC: applies one validated op to the memory
 * store and returns a plain view. No Electron imports, so it is tested
 * against a real SQLite store.
 */
import type { MemoryStore, ProjectDetail } from '@assistant/memory'
import type { Clock } from '@assistant/shared'

import type { ProjectDetailView, ProjectOp, ProjectSummary } from '../shared/projects.ts'

const view = (d: ProjectDetail): ProjectDetailView => ({
  id: d.id,
  name: d.name,
  goals: d.goals,
  state: d.state,
  status: d.status,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  tasks: d.tasks.map(t => ({ id: t.id, title: t.title, status: t.status, dueAt: t.dueAt, evidence: t.evidence })),
  commitments: d.commitments.map(c => ({
    id: c.id,
    who: c.who,
    what: c.what,
    toWhom: c.toWhom,
    dueAt: c.dueAt,
    source: c.source.kind === 'owner' ? 'owner' : c.source.origin,
    resolvedAt: c.resolvedAt,
    resolution: c.resolution,
  })),
})

export interface ProjectsResult {
  result: ProjectSummary[] | ProjectDetailView | null
  /** The project whose view changed, for `projects:changed`. */
  changed?: string | undefined
}

export const runProjectsOp = (memory: MemoryStore, clock: Clock, owner: string, op: ProjectOp): ProjectsResult => {
  const detail = (id: string | null) => {
    if (!id) return null
    const d = memory.projectDetail(id)
    return d ? view(d) : null
  }
  const must = (id: string) => {
    const d = detail(id)
    if (!d) throw new Error('No such project.')
    return d
  }
  switch (op.kind) {
    case 'list':
      return { result: memory.listProjects({ includeArchived: op.includeArchived }) }
    case 'get':
      return { result: detail(op.id) }
    case 'create': {
      const p = memory.createProject(op.input)
      return { result: must(p.id), changed: p.id }
    }
    case 'update':
      memory.updateProject(op.id, op.patch)
      return { result: must(op.id), changed: op.id }
    case 'add-task': {
      must(op.projectId)
      memory.addTask(op.input.title, { projectId: op.projectId, dueAt: op.input.dueAt ?? undefined })
      return { result: must(op.projectId), changed: op.projectId }
    }
    case 'assign-task': {
      const before = memory.getTask(op.taskId)?.projectId ?? null
      memory.setTaskProject(op.taskId, op.projectId)
      return { result: detail(op.projectId), changed: op.projectId ?? before ?? undefined }
    }
    case 'set-task-status': {
      const task = memory.getTask(op.taskId)
      if (!task) throw new Error('No such task.')
      // The state machine decides; completion without evidence is refused there.
      memory.transition(op.taskId, op.status, { evidence: op.evidence, note: 'changed in Projects' })
      return { result: detail(task.projectId), changed: task.projectId ?? undefined }
    }
    case 'add-commitment': {
      must(op.projectId)
      memory.addCommitment({
        who: op.input.who || owner || 'owner',
        what: op.input.what,
        toWhom: op.input.toWhom,
        dueAt: op.input.dueAt ?? undefined,
        source: { kind: 'owner', origin: 'projects', retrievedAt: clock.now() },
        projectId: op.projectId,
      })
      return { result: must(op.projectId), changed: op.projectId }
    }
    case 'assign-commitment': {
      const before = memory.getCommitment(op.commitmentId)
      if (!before) throw new Error('No such commitment.')
      memory.setCommitmentProject(op.commitmentId, op.projectId)
      return { result: detail(op.projectId), changed: op.projectId ?? before.projectId ?? undefined }
    }
    case 'resolve-commitment': {
      const c = memory.getCommitment(op.commitmentId)
      if (!c) throw new Error('No such commitment.')
      if (c.resolvedAt !== null) throw new Error('That commitment is already resolved.')
      memory.resolveCommitment(op.commitmentId, op.resolution)
      return { result: detail(c.projectId), changed: c.projectId ?? undefined }
    }
  }
}
