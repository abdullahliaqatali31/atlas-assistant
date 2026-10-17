/**
 * Developer text console for the runtime, ahead of the desktop app.
 *   pnpm chat
 * Slash commands: /task <title> [@YYYY-MM-DDTHH:mm], /done <n> <evidence>,
 * /tasks, /promise <what> to <whom> [@due], /remember <fact>,
 * /mode <companion|work|focus|quiet>, /exit
 */
import { mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

import { DEFAULT_PREFS } from '@assistant/initiative'
import { McpHost, loadMcpConfig } from '@assistant/mcp'
import { MemoryStore } from '@assistant/memory'
import { AnthropicProvider } from '@assistant/providers'
import { systemClock, type ConversationMode } from '@assistant/shared'

import { Assistant } from './assistant.ts'
import { createVoice, loadConfig } from './config.ts'
import { mcpEvidenceSources } from './evidence.ts'
import { osCredentialStore, withStoredSecrets } from './credentials.ts'
import { DEFAULT_RULES, localTools, mcpTools } from './tools.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // No .env file: rely on the real environment and the credential store.
}

const { config, problems, warnings } = loadConfig(withStoredSecrets(process.env, osCredentialStore()), process.cwd())
for (const w of warnings) console.warn(`! ${w}`)
if (!config) {
  console.error('Setup is incomplete. Store keys with `pnpm keys set <NAME>` or add them to .env:')
  for (const p of problems) console.error(`  - ${p.key}: ${p.message}`)
  process.exit(1)
}

const llm = new AnthropicProvider(config.llm.apiKey, config.llm.model)
const checks = await Promise.all([
  llm.healthCheck(),
  config.voice ? createVoice(config.voice, config.owner.languages).healthCheck() : Promise.resolve({ ok: true as const }),
])
for (const [i, c] of checks.entries()) {
  if (!c.ok) {
    console.error(`${i === 0 ? 'LLM' : 'Voice'} provider check failed: ${c.error} (run \`pnpm doctor\` for details)`)
    process.exit(1)
  }
}

mkdirSync(config.dataDir, { recursive: true })
const memory = new MemoryStore(`${config.dataDir}/assistant.db`, systemClock)
for (const t of memory.recoverInterrupted()) console.warn(`! "${t.title}" was interrupted last time; it is waiting for you to verify.`)

const rules = () => DEFAULT_RULES
const mcp = new McpHost(loadMcpConfig(config.mcpConfigPath), rules, () => systemClock.now())
for (const f of await mcp.start()) console.warn(`! MCP server ${f.server} failed to start: ${f.error}`)

const rl = createInterface({ input: process.stdin, output: process.stdout })

const assistant = new Assistant({
  llm,
  memory,
  clock: systemClock,
  briefingSources: () => mcpEvidenceSources(mcp),
  owner: config.owner,
  prefs: { ...DEFAULT_PREFS, utcOffsetMin: config.owner.utcOffsetMin },
  tools: [...localTools(memory, systemClock), ...mcpTools(mcp)],
  rules,
  confirm: async (tool, input, decision) => {
    process.stdout.write('\n')
    const answer = await rl.question(`  ? Allow ${tool.name} ${JSON.stringify(input).slice(0, 160)}\n    (${decision.reason}) [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  },
  onAction: n => {
    if (n.status !== 'running') console.log(`\n  · ${n.tool}: ${n.status}${n.detail && n.status !== 'done' ? ` (${n.detail})` : ''}`)
  },
})

const print = async (chunks: AsyncIterable<string>) => {
  let any = false
  for await (const c of chunks) {
    if (!any) process.stdout.write('\nassistant › ')
    any = true
    process.stdout.write(c)
  }
  if (any) process.stdout.write('\n\n')
}

await print(assistant.onEvent({ type: 'session.first-of-day', at: systemClock.now() }))
for (const c of memory.dueCommitments()) {
  await print(assistant.onEvent({ type: 'commitment.due', at: systemClock.now(), commitmentId: c.id, title: `${c.what} (to ${c.toWhom})` }))
}

const MODES: ConversationMode[] = ['companion', 'work', 'focus', 'quiet']
const parseDue = (s: string | undefined) => {
  const t = s ? Date.parse(s) : Number.NaN
  return Number.isNaN(t) ? undefined : t
}

while (true) {
  const line = (await rl.question('you › ')).trim()
  if (!line) continue
  if (line === '/exit') break

  const [cmd, ...rest] = line.split(' ')
  const arg = rest.join(' ').trim()

  if (cmd === '/task') {
    const m = /^(.*?)\s*(?:@(\S+))?$/.exec(arg)
    memory.addTask(m?.[1] || arg, { dueAt: parseDue(m?.[2]) })
    console.log('  saved.')
  } else if (cmd === '/tasks') {
    const open = memory.openTasks()
    if (open.length === 0) console.log('  no open tasks.')
    open.forEach((t, i) => console.log(`  ${i + 1}. ${t.title} [${t.status}]${t.dueAt ? ` due ${new Date(t.dueAt).toLocaleString()}` : ''}`))
    for (const c of memory.openCommitments()) console.log(`  ↪ promised ${c.toWhom}: ${c.what}${c.dueAt ? ` by ${new Date(c.dueAt).toLocaleString()}` : ''}`)
  } else if (cmd === '/done') {
    const [n, ...ev] = rest
    const task = memory.openTasks()[Number(n) - 1]
    try {
      if (!task) throw new Error('No such task number.')
      memory.transition(task.id, 'completed', { evidence: ev.join(' ') })
      console.log(`  completed: ${task.title}`)
    } catch (error) {
      console.log(`  ${(error as Error).message}`)
    }
  } else if (cmd === '/promise') {
    const m = /^(.*?)\s+to\s+(.+?)\s*(?:@(\S+))?$/.exec(arg)
    if (!m) {
      console.log('  usage: /promise <what> to <whom> [@due]')
    } else {
      memory.addCommitment({
        who: 'owner',
        what: m[1]!,
        toWhom: m[2]!,
        dueAt: parseDue(m[3]),
        source: { kind: 'owner', origin: 'cli', retrievedAt: systemClock.now() },
      })
      console.log('  commitment saved.')
    }
  } else if (cmd === '/remember') {
    memory.remember({ kind: 'fact', statement: arg, source: { kind: 'owner', origin: 'cli', retrievedAt: systemClock.now() } })
    console.log('  remembered.')
  } else if (cmd === '/mode' && MODES.includes(arg as ConversationMode)) {
    assistant.setMode(arg as ConversationMode)
    console.log(`  mode: ${arg}`)
  } else {
    await print(assistant.reply(line))
  }
}

rl.close()
await mcp.stop()
memory.close()
