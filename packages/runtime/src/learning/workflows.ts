/**
 * Workflow learning (plan section 8): notices the same successful sequence
 * of tool steps repeated on different days and proposes it as a named
 * routine. A routine is declarative (tool names in order); it never becomes
 * code and never gets more permission than its steps already have.
 */
import { DAY } from '@assistant/shared'

export interface ActionStep {
  tool: string
  result: string | null
  at: number
}

export interface MinedWorkflow {
  steps: string[]
  /** How many times it was done, and on how many different days. */
  count: number
  days: number
  lastAt: number
}

/** A pause this long between actions starts a new run of work. */
const SESSION_GAP = 10 * 60_000
const MIN_COUNT = 3
const MIN_DAYS = 2

/** Built-in bookkeeping tools are not worth a routine on their own. */
const NOISE = new Set(['tasks_list', 'memory_search'])

/**
 * Finds step sequences (2 to 5 tools, all succeeded) repeated at least three
 * times on at least two days. Longer sequences win over their own parts.
 */
export const mineWorkflows = (actions: readonly ActionStep[]): MinedWorkflow[] => {
  const ok = [...actions].filter(a => a.result === 'done' && !NOISE.has(a.tool)).sort((a, b) => a.at - b.at)
  // Split into runs of work, collapsing immediate repeats of one tool.
  const runs: ActionStep[][] = []
  for (const a of ok) {
    const run = runs.at(-1)
    const prev = run?.at(-1)
    if (!run || !prev || a.at - prev.at > SESSION_GAP) runs.push([a])
    else if (prev.tool !== a.tool) run.push(a)
  }

  const found = new Map<string, MinedWorkflow & { seenIn: Set<number> }>()
  runs.forEach((run, r) => {
    for (let len = 2; len <= 5; len++) {
      for (let i = 0; i + len <= run.length; i++) {
        const steps = run.slice(i, i + len)
        const key = steps.map(s => s.tool).join(' > ')
        const f = found.get(key) ?? { steps: steps.map(s => s.tool), count: 0, days: 0, lastAt: 0, seenIn: new Set<number>() }
        // Count each run of work once per sequence.
        if (!f.seenIn.has(r)) {
          f.seenIn.add(r)
          f.count++
        }
        f.lastAt = Math.max(f.lastAt, steps.at(-1)!.at)
        found.set(key, f)
      }
    }
  })

  const dayOf = (t: number) => Math.floor(t / DAY)
  const result = [...found.values()]
    .map(f => {
      const days = new Set([...f.seenIn].map(r => dayOf(runs[r]![0]!.at)))
      return { steps: f.steps, count: f.count, days: days.size, lastAt: f.lastAt }
    })
    .filter(f => f.count >= MIN_COUNT && f.days >= MIN_DAYS)
  // Keep only the longest version of overlapping sequences.
  return result
    .filter(f => !result.some(g => g !== f && g.steps.length > f.steps.length && g.count >= f.count && g.steps.join(' > ').includes(f.steps.join(' > '))))
    .sort((a, b) => b.count - a.count)
}

/** "playwright__browser_navigate" → "browser navigate". */
export const stepLabel = (tool: string) => tool.replace(/^[^_]+__/, '').replace(/_/g, ' ')

export const workflowName = (steps: readonly string[]) => steps.map(stepLabel).join(' → ')
