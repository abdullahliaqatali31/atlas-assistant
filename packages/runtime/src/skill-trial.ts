/**
 * Live trial of teaching: with your real LLM key and a real browser, on a
 * throwaway database and a local test page. Teach a task in conversation,
 * then (in a new conversation) ask for it, then let it run on its schedule;
 * each result is checked against the page by code.
 *   pnpm trial:skills
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PREFS } from '@assistant/initiative'
import { McpHost } from '@assistant/mcp'
import { MemoryStore } from '@assistant/memory'
import { AnthropicProvider } from '@assistant/providers'
import { fixedClock, type InitiativeEvent } from '@assistant/shared'

import { Assistant } from './assistant.ts'
import { loadConfig } from './config.ts'
import { osCredentialStore, withStoredSecrets } from './credentials.ts'
import { skillAgenda, skillContextLines, skillTools } from './skills.ts'
import { DEFAULT_RULES, localTools, mcpTools } from './tools.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // Optional.
}
const { config, problems } = loadConfig({ ...withStoredSecrets(process.env, osCredentialStore()), ASSISTANT_DEV_SKIP_VOICE: '1' }, process.cwd())
if (!config) {
  console.error('Needs an LLM key:', problems.map(p => p.key).join(', '))
  process.exit(1)
}
const OFFSET = 300

// A quotes board whose numbers change between runs, so the assistant must really read it.
let board: [string, number, string][] = [
  ['Ahmed Raza', 120_000, 'Pending'],
  ['Sana Malik', 75_000, 'Sent'],
  ['Bilal Khan', 40_000, 'Pending'],
]
const pendingTotal = () => board.filter(r => r[2] === 'Pending').reduce((n, r) => n + r[1], 0)
const server = createServer((req, res) => {
  if (req.url !== '/quotes/today.html') return void res.writeHead(404).end()
  const rows = board.map(([c, a, s]) => `<tr><td>${c}</td><td>PKR ${a.toLocaleString('en-US')}</td><td>${s}</td></tr>`).join('')
  res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>Quotes today</title><table border="1"><tr><th>Client</th><th>Amount</th><th>Status</th></tr>${rows}</table>`)
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/quotes/today.html`

const dir = mkdtempSync(join(tmpdir(), 'pa-skill-trial-'))
const clock = fixedClock(Date.parse('2026-10-19T08:30:00+05:00'))
const memory = new MemoryStore(join(dir, 'a.db'), clock)
memory.setOnboarded(true)
const mcp = new McpHost(
  { servers: { browser: { enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--isolated', '--headless'] } } } as never,
  () => DEFAULT_RULES,
  () => clock.now(),
)
await mcp.start()

const mentions = (text: string, n: number) => text.replace(/(?<=\d),(?=\d{3}\b)/g, '').includes(String(n)) || new RegExp(`\\b${n / 1000}\\s*(k|thousand|hazar)`, 'i').test(text)
const line = (s = '') => console.log(s)
const llm = new AnthropicProvider(config.llm.apiKey, config.llm.model)
/** A fresh conversation on the same memory, as on a later day. */
const newAssistant = () =>
  new Assistant({
    llm,
    memory,
    clock,
    owner: config.owner,
    prefs: { ...DEFAULT_PREFS, utcOffsetMin: OFFSET },
    tools: [...localTools(memory, clock), ...skillTools(memory, clock, OFFSET), ...mcpTools(mcp)],
    rules: () => DEFAULT_RULES,
    learning: { observeOwner: () => [], contextLines: () => skillContextLines(memory, OFFSET) },
    // Stands in for the owner: yes to the local test page only.
    confirm: async (_tool, input) => JSON.stringify(input).includes('127.0.0.1') || !/https?:/.test(JSON.stringify(input)),
    onAction: n => n.status !== 'running' && line(`      · ${n.tool}: ${n.status}`),
  })
const say = async (a: Assistant, text: string) => {
  line(`  You: ${text}`)
  let out = ''
  for await (const c of a.reply(text)) out += c
  line(`  Atlas: ${out.replace(/\s+/g, ' ').trim()}`)
  return out
}

let failed = 0
const check = (ok: boolean, what: string) => {
  line(`  ${ok ? '✓' : '✗'} ${what}`)
  if (!ok) failed++
}

try {
  line('━━ 1. Teaching (in conversation) ━━')
  const teacher = newAssistant()
  await say(
    teacher,
    `Atlas, ek naya task seekho. Naam "quotes check". Jab main kahoon quotes check karo, to browser mein ${url} kholo, jitne Pending quotes hain unka total PKR mein nikaalo aur mujhe batao. Har weekday subah 9 baje bhi ye karna.`,
  )
  for (let i = 0; i < 3 && memory.skills().length === 0; i++) await say(teacher, 'Haan bilkul theek hai, isi tarah save kar lo. Abhi saath karne ki zaroorat nahi.')
  const skill = memory.skills()[0]
  check(Boolean(skill), `skill saved${skill ? `: "${skill.name}", ${skill.steps.length} steps, schedule ${JSON.stringify(skill.schedule)}` : ''}`)
  check(skill?.schedule?.kind === 'daily' && skill.schedule.minute === 540, 'runs weekdays at 09:00')

  line('\n━━ 2. Later, in a new conversation: "quotes check karo" (the page changed) ━━')
  board = [
    ['Usman Ali', 210_000, 'Pending'],
    ['Hina Shah', 55_000, 'Pending'],
    ['Ahmed Raza', 120_000, 'Approved'],
  ]
  const reply = await say(newAssistant(), 'quotes check karo')
  const run1 = skill ? memory.skillRuns(skill.id)[0] : undefined
  check(mentions(reply, pendingTotal()), `reported the real total ${pendingTotal()}`)
  check(run1?.ok === true, `run recorded as checked: ${run1?.summary ?? 'none'}`)

  line('\n━━ 3. 09:00 Tuesday, allowed to run by itself ━━')
  if (skill) memory.updateSkill(skill.id, { auto: true })
  board = [
    ['Farhan Qureshi', 90_000, 'Pending'],
    ['Mariam Iqbal', 30_000, 'Sent'],
  ]
  clock.set(Date.parse('2026-10-20T09:00:00+05:00'))
  const [due] = skillAgenda(memory, clock.now(), { utcOffsetMin: OFFSET })
  check(due?.kind === 'task', `due on schedule: ${due?.title ?? 'nothing'}`)
  if (due) {
    let out = ''
    for await (const c of newAssistant().speakUp(due as InitiativeEvent)) out += c
    line(`  Atlas: ${out.replace(/\s+/g, ' ').trim()}`)
    const run2 = memory.skillRuns(skill!.id)[0]
    check(mentions(out, pendingTotal()), `reported the real total ${pendingTotal()}`)
    check(run2?.trigger === 'schedule' && run2.ok === true, `scheduled run recorded: ${run2?.summary ?? 'none'}`)
  }
  line(`\n${failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`}`)
  process.exitCode = failed ? 1 : 0
} finally {
  await mcp.stop()
  server.close()
  memory.close()
  rmSync(dir, { recursive: true, force: true })
}
