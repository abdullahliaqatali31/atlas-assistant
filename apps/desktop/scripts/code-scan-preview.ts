/**
 * Read-only preview of what Atlas would see: the project folders it finds
 * (VS Code, Claude Code) and a scan of one of them. Changes nothing.
 *   npx tsx apps/desktop/scripts/code-scan-preview.ts [folder]
 */
import { basename } from 'node:path'

import { claudeSessions, discover } from '../src/main/code/discover.ts'
import { dayKey, scanProject } from '../src/main/code/scan.ts'

const sessions = claudeSessions()
const found = discover(sessions)
console.log(`Found ${found.length} project folders (newest first):`)
for (const s of found.slice(0, 15)) console.log(`  ${s.source === 'claude' ? 'Claude Code' : 'VS Code    '}  ${new Date(s.lastUsedAt).toISOString().slice(0, 10)}  ${s.path}`)

const target = process.argv[2] ?? found[0]?.path
if (target) {
  const started = Date.now()
  const { view, days } = await scanProject({ id: 'preview', path: target, name: basename(target), access: 'see', profiles: [] }, sessions)
  const today = days[dayKey(Date.now())]
  console.log(`\nScan of ${view.name} (${Date.now() - started} ms):`)
  console.log(`  stack: ${view.stack.join(', ') || '—'}`)
  console.log(`  git: ${view.git ? `${view.git.branch}, ${view.git.uncommitted} uncommitted, last commit "${view.git.lastCommit}"` : 'not a repo'}`)
  console.log(`  today: ${JSON.stringify(today)}`)
  console.log(`  last 14 days files: ${Object.values(days).map(d => d.files).join(' ')}`)
  console.log(`  Claude Code sessions: ${view.sessionTitles.join(' | ') || '—'}`)
  console.log(`  run commands found: ${view.suggestedProfiles.map(p => `${p.name}=${p.command}${p.cwd ? ` (${p.cwd})` : ''}`).join(', ') || '—'}`)
}
