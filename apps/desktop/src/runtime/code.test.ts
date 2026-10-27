import { describe, expect, it } from 'vitest'

import { EMPTY_DAY, type CodeProjectView, type RunView } from '../shared/code.ts'
import { describeProject, HostCode } from './code.ts'

const DAY = 24 * 60 * 60_000
const NOW = Date.UTC(2026, 9, 18, 9)

const project = (over: Partial<CodeProjectView> = {}): CodeProjectView => ({
  id: 'p1',
  name: 'CSi-centralized-system',
  path: 'C:/code/CSi',
  access: 'run',
  exists: true,
  stack: ['Next.js', 'Prisma'],
  git: { branch: 'main', lastCommitAt: NOW - 2 * 60 * 60_000, lastCommit: 'Add invoices page', uncommitted: 3 },
  today: { ...EMPTY_DAY, commits: 2, added: 120, removed: 30, files: 9, sessions: 1 },
  week: { ...EMPTY_DAY, commits: 11, added: 900, removed: 200, files: 40, sessions: 5, minutes: 300 },
  trend: [],
  lastActivityAt: NOW - 30 * 60_000,
  sessionTitles: ['Fix login redirect'],
  status: { now: 'Billing module', next: '- Fix login redirect\n- Deploy to staging', recent: '', run: '', issues: 'Slow build', updatedAt: NOW },
  profiles: [{ id: 'r1', name: 'web', command: 'pnpm run dev', cwd: '' }],
  suggestedProfiles: [],
  ...over,
})

const run = (over: Partial<RunView> = {}): RunView => ({
  id: 'run1',
  projectId: 'p1',
  projectName: 'CSi-centralized-system',
  profile: 'web',
  command: 'pnpm run dev',
  state: 'running',
  startedAt: NOW - 60_000,
  endedAt: null,
  exitCode: null,
  url: 'http://localhost:3000',
  lastError: null,
  ...over,
})

describe('what the model sees', () => {
  it('gives measured numbers first, then the status file’s next steps, then what is running', () => {
    const text = describeProject(project(), [run()], NOW)
    expect(text).toContain('Today: 2 commit(s) +120/-30 lines, 9 file(s) edited, 1 Claude Code session(s).')
    expect(text).toContain('Last 7 days: 11 commit(s) +900/-200 lines, 40 file(s) edited, 5 Claude Code session(s), 300 min in VS Code.')
    expect(text).toContain('3 uncommitted change(s), last commit 2 h ago: "Add invoices page"')
    expect(text).toContain('Running: web at http://localhost:3000.')
    expect(text).toContain('Next (from .atlas/STATUS.md): - Fix login redirect - Deploy to staging')
    expect(describeProject(project(), [], NOW, true)).toContain('Run commands: web (pnpm run dev).')
  })
})

describe('code questions', () => {
  const host = (projects: CodeProjectView[], running: RunView[] = []) => {
    const h = new HostCode({ post: () => undefined, now: () => NOW })
    h.setSnapshot({ projects, running })
    return h
  }

  it('raises a crashed server once, soon after it stopped', () => {
    const crashed = run({ state: 'crashed', endedAt: NOW - 60_000, exitCode: 1, lastError: 'Error: EADDRINUSE :::3000' })
    const [item] = host([project()], [crashed]).agenda(NOW)
    expect(item).toMatchObject({ key: 'crash:run1', kind: 'nudge', title: 'CSi-centralized-system stopped', expectsAnswer: true })
    expect(item!.instruction).toContain('untrusted output')
    expect(host([project()], [{ ...crashed, endedAt: NOW - 2 * 60 * 60_000 }]).agenda(NOW)).toEqual([])
  })

  it('asks about a project that went quiet for days, not one in use or long abandoned', () => {
    const quiet = host([project({ lastActivityAt: NOW - 6 * DAY })]).agenda(NOW)
    expect(quiet).toHaveLength(1)
    expect(quiet[0]!.instruction).toContain('no commits, edits or Claude Code sessions for 6 days')
    expect(host([project()]).agenda(NOW)).toEqual([])
    expect(host([project({ lastActivityAt: NOW - 60 * DAY })]).agenda(NOW)).toEqual([])
  })

  it('says how to add projects when none are approved', async () => {
    const tool = host([]).tools().find(t => t.name === 'code_projects')!
    expect(await tool.run({})).toMatch(/Projects › Code/)
  })
})
