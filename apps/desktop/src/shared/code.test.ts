import { describe, expect, it } from 'vitest'

import {
  AGENT_BLOCK_START,
  commandProblem,
  detectStack,
  findLocalUrl,
  looksLikeError,
  parseGitLog,
  parseProfile,
  parseStatus,
  setStatusSection,
  statusTemplate,
  suggestProfiles,
  withAgentBlock,
} from './code.ts'

describe('run profiles', () => {
  it('suggests dev commands with the project’s own package manager', () => {
    const pkg = { scripts: { dev: 'vite', build: 'vite build', start: 'node server.js' } }
    expect(suggestProfiles('', ['package.json', 'pnpm-lock.yaml'], pkg)).toEqual([
      { name: 'dev', command: 'pnpm run dev', cwd: '' },
      { name: 'start', command: 'pnpm run start', cwd: '' },
    ])
    expect(suggestProfiles('apps/api', ['package.json'], { scripts: { start: 'node .' } })).toEqual([{ name: 'api start', command: 'npm start', cwd: 'apps/api' }])
    expect(suggestProfiles('', ['manage.py', 'docker-compose.yml'], null).map(p => p.command)).toEqual(['python manage.py runserver', 'docker compose up'])
  })

  it('accepts one plain command, never a chain or a destructive one', () => {
    expect(commandProblem('npm run dev -- --port 3001')).toBeNull()
    for (const bad of ['npm run dev && del /q *', 'npm run dev | tee x', 'echo > x', 'rmdir /s x', 'powershell -c x', 'npm run %EVIL%', 'a\nb']) expect(commandProblem(bad), bad).not.toBeNull()
    expect(parseProfile({ name: 'web', command: 'npm run dev', cwd: './client/' })).toEqual({ name: 'web', command: 'npm run dev', cwd: 'client' })
    expect(parseProfile({ name: 'web', command: 'npm run dev', cwd: '../other' })).toMatch(/inside the project/)
    expect(parseProfile({ name: 'web', command: 'npm run dev', cwd: 'C:/Windows' })).toMatch(/inside the project/)
  })

  it('names the stack from dependencies and files', () => {
    expect(detectStack(['package.json', 'docker-compose.yml'], { dependencies: { next: '1', react: '1', '@prisma/client': '1' }, devDependencies: { typescript: '5', tailwindcss: '4' } })).toEqual([
      'Next.js',
      'Tailwind',
      'Prisma',
      'TypeScript',
      'Docker',
    ])
    expect(detectStack(['manage.py', 'requirements.txt'], null)).toEqual(['Django'])
  })
})

describe('dev server output', () => {
  it('finds the local address and error lines, through colour codes', () => {
    expect(findLocalUrl('  \u001b[32m➜\u001b[39m  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m')).toBe('http://localhost:5173/')
    expect(findLocalUrl('Server listening on http://0.0.0.0:8000.')).toBe('http://localhost:8000')
    expect(findLocalUrl('see https://nextjs.org/docs')).toBeNull()
    expect(looksLikeError('Error: listen EADDRINUSE: address already in use :::3000')).toBe(true)
    expect(looksLikeError('ready in 300 ms')).toBe(false)
  })
})

describe('git log', () => {
  it('counts commits and changed lines, binary files as zero', () => {
    const out = ['@1760000000', '10\t2\tsrc/a.ts', '-\t-\tlogo.png', '', '@1760003600', '5\t0\tREADME.md'].join('\n')
    expect(parseGitLog(out)).toEqual({ commits: 2, added: 15, removed: 2, times: [1760000000000, 1760003600000] })
    expect(parseGitLog('')).toEqual({ commits: 0, added: 0, removed: 0, times: [] })
  })
})

describe('STATUS.md', () => {
  it('round-trips sections and updates one without touching the others', () => {
    const md = statusTemplate('CSi', 'pnpm run dev')
    expect(parseStatus(md, 1)).toEqual({ now: '', next: '', recent: '', run: 'pnpm run dev', issues: '', updatedAt: 1 })
    const next = setStatusSection(md, 'next', '- Fix login redirect\n- Add invoices page')
    const doc = parseStatus(next, 2)
    expect(doc.next).toBe('- Fix login redirect\n- Add invoices page')
    expect(doc.run).toBe('pnpm run dev')
    expect(setStatusSection('# x\n', 'issues', 'Slow build')).toContain('## Known issues\n\nSlow build')
  })
})

describe('coding agent instructions', () => {
  it('adds one marked block, replaces it on repeat, and removes only it', () => {
    const mine = '# My rules\nUse pnpm.\n'
    const on = withAgentBlock(mine, true)
    expect(on.startsWith('# My rules\nUse pnpm.\n\n<!-- atlas:status:start -->')).toBe(true)
    expect(withAgentBlock(on, true).split(AGENT_BLOCK_START)).toHaveLength(2)
    expect(withAgentBlock(on, false)).toBe(mine)
    expect(withAgentBlock(withAgentBlock('', true), false)).toBe('')
  })
})
