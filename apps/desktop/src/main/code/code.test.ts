import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RunView } from '../../shared/code.ts'
import { Runner } from './runner.ts'
import { dayKey, scanProject } from './scan.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-code-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, dependencies: { react: '19' }, devDependencies: { vite: '8', typescript: '5' } }))
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 1\nexport const b = 2\n')
  git('add', '.')
  git('commit', '-q', '-m', 'Start the app')
  return { dir, git }
}

describe('scanProject', () => {
  it('measures a git project: commits and lines today, uncommitted work, stack and run commands', async () => {
    const { dir } = repo()
    writeFileSync(join(dir, 'src', 'new.ts'), 'export {}\n')
    // Dependencies and build output never count as the owner's work.
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), '')
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.env\n')
    const sessions = [
      { cwd: dir, title: 'Add login page', lastAt: Date.now() - 60_000 },
      { cwd: join(dir, 'src'), title: 'Fix types', lastAt: Date.now() },
      { cwd: `${dir}-other`, title: 'Not this project', lastAt: Date.now() },
    ]
    const { view, days } = await scanProject({ id: 'p1', path: dir, name: 'demo', access: 'see', profiles: [] }, sessions)
    const today = days[dayKey(Date.now())]!
    // package.json (1 line) + src/app.ts (2 lines); the empty lockfile adds none.
    expect(today).toMatchObject({ commits: 1, added: 3, removed: 0, sessions: 2 })
    // package.json, lockfile, src/app.ts, src/new.ts; .env and node_modules never count.
    expect(today.files).toBe(5) // with .gitignore
    // The new file and the new .gitignore; ignored files are not uncommitted work.
    expect(view.git).toMatchObject({ branch: 'main', lastCommit: 'Start the app', uncommitted: 2 })
    expect(view.stack).toEqual(['React', 'Vite', 'TypeScript'])
    expect(view.suggestedProfiles).toEqual([{ name: 'dev', command: 'pnpm run dev', cwd: '' }])
    expect(view.sessionTitles).toEqual(['Fix types', 'Add login page'])
    expect(view.status).toBeNull()
  })

  it('reads .atlas/STATUS.md and hides approved commands from suggestions', async () => {
    const { dir } = repo()
    mkdirSync(join(dir, '.atlas'))
    writeFileSync(join(dir, '.atlas', 'STATUS.md'), '# demo\n\n## Next\n\n- Fix login redirect\n')
    const { view } = await scanProject({ id: 'p1', path: dir, name: 'demo', access: 'status', profiles: [{ id: 'x1', name: 'web', command: 'pnpm run dev', cwd: '' }] }, [])
    expect(view.status?.next).toBe('- Fix login redirect')
    expect(view.suggestedProfiles).toEqual([])
  })

  it('works without git, and counts older edits on their own day', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-code-nogit-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'notes.md'), 'x')
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60_000) / 1000
    utimesSync(join(dir, 'notes.md'), twoDaysAgo, twoDaysAgo)
    const { view, days } = await scanProject({ id: 'p2', path: dir, name: 'notes', access: 'see', profiles: [] }, [])
    expect(view.git).toBeNull()
    expect(days[dayKey(Date.now() - 2 * 24 * 60 * 60_000)]!.files).toBe(1)
    expect(days[dayKey(Date.now())]!.files).toBe(0)
  })

  it('reports a missing folder instead of failing', async () => {
    const { view } = await scanProject({ id: 'p3', path: join(tmpdir(), 'pa-does-not-exist-xyz'), name: 'gone', access: 'see', profiles: [] }, [])
    expect(view.exists).toBe(false)
  })
})

describe('Runner', () => {
  const until = async (check: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise(r => setTimeout(r, 100))
    }
  }

  it('starts an approved command in the project, finds its address, and stops the whole tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-run-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'server.js'), "console.log('  Local:   http://localhost:4321/'); setInterval(() => {}, 1000)")
    const runner = new Runner({ onChange: () => undefined, onCrash: () => undefined })
    const run = runner.start({ id: 'p', name: 'demo', path: dir }, { id: 'r', name: 'web', command: 'node server.js', cwd: '' })
    await until(() => runner.list()[0]!.url !== null)
    expect(runner.list()[0]).toMatchObject({ state: 'running', url: 'http://localhost:4321/' })
    // Starting it again while it runs gives the same run, not a second server.
    expect(runner.start({ id: 'p', name: 'demo', path: dir }, { id: 'r', name: 'web', command: 'node server.js', cwd: '' }).id).toBe(run.id)
    await runner.stop(run.id)
    await until(() => runner.list()[0]!.endedAt !== null)
    expect(runner.list()[0]!.state).toBe('exited')
    expect(runner.logs(run.id).join('\n')).toContain('Local:')
  })

  it('reports a crash with its error line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-run-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'bad.js'), "console.error('Error: listen EADDRINUSE: address already in use :::3000'); process.exit(3)")
    const crashes: RunView[] = []
    const runner = new Runner({ onChange: () => undefined, onCrash: r => crashes.push(r) })
    runner.start({ id: 'p', name: 'demo', path: dir }, { id: 'r', name: 'api', command: 'node bad.js', cwd: '' })
    await until(() => crashes.length === 1)
    expect(crashes[0]).toMatchObject({ state: 'crashed', exitCode: 3, lastError: 'Error: listen EADDRINUSE: address already in use :::3000' })
  })

  it('refuses chained or dangerous commands even if they reached it', () => {
    const runner = new Runner({ onChange: () => undefined, onCrash: () => undefined })
    expect(() => runner.start({ id: 'p', name: 'x', path: tmpdir() }, { id: 'r', name: 'evil', command: 'npm run dev & del /q *', cwd: '' })).toThrow(/One command only/)
  })
})
