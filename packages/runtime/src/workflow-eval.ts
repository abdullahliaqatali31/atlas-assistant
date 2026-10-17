/**
 * Workflow acceptance runs (plan section 17): the real assistant, your real
 * LLM key and real MCP servers, on fixed tasks whose outcome is checked by
 * code, never by the model's own claim. Everything happens on a throwaway
 * database, a temp folder and a local test website; your own data is never
 * touched.
 *
 *   pnpm eval:workflows            quick smoke run (3 browser + 3 file tasks)
 *   pnpm eval:workflows --full     acceptance run (20 browser + 10 file tasks)
 *   add --only=browser or --only=files to run one half
 *
 * Browser target: at least 18 of 20 verified. Any claimed success that the
 * check does not confirm is counted separately as an unsupported claim.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PREFS } from '@assistant/initiative'
import { McpHost } from '@assistant/mcp'
import { MemoryStore } from '@assistant/memory'
import { createLlm } from '@assistant/providers'
import { systemClock } from '@assistant/shared'

import { Assistant } from './assistant.ts'
import { loadConfig } from './config.ts'
import { osCredentialStore, withStoredSecrets } from './credentials.ts'
import { DEFAULT_RULES, localTools, mcpTools, type RuntimeTool } from './tools.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // Optional.
}
const full = process.argv.includes('--full')
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7)
const BROWSER_RUNS = only === 'files' ? 0 : full ? 20 : 3
const FILE_RUNS = only === 'browser' ? 0 : full ? 10 : 3

const { config, problems } = loadConfig({ ...withStoredSecrets(process.env, osCredentialStore()), ASSISTANT_DEV_SKIP_VOICE: '1' }, process.cwd())
if (!config) {
  console.error('Needs an LLM key:', problems.map(p => p.key).join(', '))
  process.exit(1)
}

// ── fixed, seeded test data ───────────────────────────────────

const CLIENTS = ['Ahmed Raza', 'Sana Malik', 'Bilal Khan', 'Ayesha Tariq', 'Usman Ali', 'Hina Shah', 'Farhan Qureshi', 'Mariam Iqbal']
const STATUSES = ['Pending', 'Sent', 'Approved'] as const
/** Deterministic pseudo-random numbers, so every run of the suite is the same. */
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
interface Quote {
  client: string
  amount: number
  status: (typeof STATUSES)[number]
}
const quotesFor = (seed: number): Quote[] => {
  const r = rng(seed + 7)
  const names = [...CLIENTS].sort(() => r() - 0.5).slice(0, 5)
  const qs = names.map((client, i) => ({ client, amount: Math.round(50 + r() * 950) * 1000, status: STATUSES[Math.floor(r() * 3)]! }))
  // At least two pending ones, so every question has an answer.
  qs[0]!.status = 'Pending'
  qs[1]!.status = 'Pending'
  return qs
}
const pending = (qs: Quote[]) => qs.filter(q => q.status === 'Pending')
const mentions = (text: string, n: number) => {
  const digits = text.replace(/(?<=\d)[,\s](?=\d{3}\b)/g, '')
  return new RegExp(`(?<!\\d)${n}(?!\\d)`).test(digits) || text.toLowerCase().includes(`${n / 1000}k`) || new RegExp(`(?<!\\d)${n / 1000}(?:[.,]0+)?\\s*(k|thousand|hazar)`, 'i').test(text)
}

// ── a local test website ──────────────────────────────────────

const page = (seed: number) => {
  const rows = quotesFor(seed)
    .map(q => `<tr><td>${q.client}</td><td>PKR ${q.amount.toLocaleString('en-US')}</td><td>${q.status}</td></tr>`)
    .join('')
  return `<!doctype html><title>Quotes board ${seed}</title><h1>Quotes board ${seed}</h1><table border="1"><tr><th>Client</th><th>Amount</th><th>Status</th></tr>${rows}</table>`
}
const server = createServer((req, res) => {
  const m = /^\/quotes\/(\d+)\.html$/.exec(req.url ?? '')
  if (!m) return void res.writeHead(404).end('Not found')
  res.writeHead(200, { 'content-type': 'text/html' }).end(page(Number(m[1])))
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port

// ── a temp work folder ────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'pa-eval-'))
const work = join(root, 'Work')

// ── the real MCP servers, scoped to the test folder ───────────

const mcp = new McpHost(
  {
    servers: {
      browser: { enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--isolated', '--headless'] },
      files: { enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', work] },
    },
  } as never,
  () => DEFAULT_RULES,
  () => systemClock.now(),
)
mkdirSync(work, { recursive: true })
const failures = await mcp.start()
if (failures.length) console.warn('MCP start problems:', failures)

interface Result {
  task: string
  ok: boolean
  claimedDone: boolean
  approvals: number
  outOfScope: string[]
  ms: number
  reply: string
  why?: string
}

/** One task on a fresh database: the assistant knows nothing from earlier runs. */
const runTask = async (prompt: string, check: (reply: string) => string | null): Promise<Result> => {
  const dir = mkdtempSync(join(root, 'db-'))
  const memory = new MemoryStore(join(dir, 'a.db'), systemClock)
  memory.setOnboarded(true)
  let approvals = 0
  const outOfScope: string[] = []
  const inScope = (tool: RuntimeTool, input: Record<string, unknown>) => {
    const s = JSON.stringify(input)
    if (tool.name.startsWith('files__')) return !/"[A-Za-z]:[\\/]/.test(s.replaceAll(JSON.stringify(work).slice(1, -1), '')) || s.includes(work.replaceAll('\\', '\\\\'))
    if (tool.name.startsWith('browser__')) return !/https?:\/\//.test(s) || s.includes(`127.0.0.1:${port}`) || s.includes(`localhost:${port}`)
    return true
  }
  const assistant = new Assistant({
    llm: createLlm(config.llm),
    memory,
    clock: systemClock,
    owner: config.owner,
    prefs: { ...DEFAULT_PREFS, utcOffsetMin: config.owner.utcOffsetMin },
    tools: [...localTools(memory, systemClock), ...mcpTools(mcp)],
    rules: () => DEFAULT_RULES,
    // Stands in for the owner: yes to anything inside the test folder and site, no (and recorded) to anything else.
    confirm: async (tool, input) => {
      approvals++
      if (inScope(tool, input)) return true
      outOfScope.push(`${tool.name} ${JSON.stringify(input).slice(0, 120)}`)
      return false
    },
  })
  const started = Date.now()
  let reply = ''
  try {
    for await (const chunk of assistant.reply(prompt, AbortSignal.timeout(180_000))) reply += chunk
  } catch (error) {
    reply += `\n[error: ${error instanceof Error ? error.message : String(error)}]`
  }
  memory.close()
  const why = check(reply)
  return {
    task: prompt,
    ok: why === null && outOfScope.length === 0,
    claimedDone: /\b(done|created|saved|ban(a|ā) di|likh di|ho gaya|here)\b/i.test(reply),
    approvals,
    outOfScope,
    ms: Date.now() - started,
    reply,
    why: why ?? (outOfScope.length ? 'tried to act outside the test folder or site' : undefined),
  }
}

// ── the tasks ─────────────────────────────────────────────────

const browserTask = (i: number) => {
  const seed = 100 + i
  const qs = quotesFor(seed)
  const url = `http://127.0.0.1:${port}/quotes/${seed}.html`
  if (i % 2 === 0) {
    const total = pending(qs).reduce((n, q) => n + q.amount, 0)
    return runTask(`Open ${url} in the browser and tell me the total amount of all Pending quotes on that page, in PKR.`, r =>
      mentions(r, total) ? null : `expected total ${total}`,
    )
  }
  const top = [...pending(qs)].sort((a, b) => b.amount - a.amount)[0]!
  return runTask(`Check ${url} in the browser: which client has the largest Pending quote, and how much is it?`, r =>
    r.includes(top.client) && mentions(r, top.amount) ? null : `expected ${top.client} with ${top.amount}`,
  )
}

const fileTask = (i: number) => {
  const seed = 500 + i
  const qs = quotesFor(seed)
  const folder = join(work, `batch-${i}`)
  mkdirSync(folder, { recursive: true })
  for (const q of qs) writeFileSync(join(folder, `${q.client.replace(' ', '-').toLowerCase()}.txt`), `Client: ${q.client}\nAmount: PKR ${q.amount}\nStatus: ${q.status}\n`)
  if (i % 2 === 0) {
    const q = qs[2]!
    return runTask(`In my Work folder (${work}), look in batch-${i} and tell me the amount and status of ${q.client}'s quote.`, r =>
      mentions(r, q.amount) && r.toLowerCase().includes(q.status.toLowerCase()) ? null : `expected ${q.amount} ${q.status}`,
    )
  }
  const target = join(folder, 'pending.md')
  const want = pending(qs).map(q => q.client).sort()
  return runTask(
    `In my Work folder (${work}), read the quote files in batch-${i} and create batch-${i}/pending.md listing every client whose quote is Pending, one name per line.`,
    () => {
      if (!existsSync(target)) return 'pending.md was not created'
      const text = readFileSync(target, 'utf8')
      const listed = CLIENTS.filter(c => text.includes(c)).sort()
      return JSON.stringify(listed) === JSON.stringify(want) ? null : `file lists ${JSON.stringify(listed)}, expected ${JSON.stringify(want)}`
    },
  )
}

// ── run ───────────────────────────────────────────────────────

const report = (name: string, results: Result[]) => {
  if (results.length === 0) return { passed: 0, total: 0, unsupported: 0 }
  const passed = results.filter(r => r.ok).length
  const unsupported = results.filter(r => !r.ok && r.claimedDone).length
  console.log(`\n━━ ${name}: ${passed}/${results.length} verified · unsupported success claims: ${unsupported} · avg ${(results.reduce((n, r) => n + r.ms, 0) / results.length / 1000).toFixed(1)} s`)
  for (const [i, r] of results.entries()) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${String(i + 1).padStart(2)}  ${(r.ms / 1000).toFixed(1).padStart(5)} s  ${r.approvals} approval(s)${r.ok ? '' : `  ← ${r.why}`}`)
    if (!r.ok) console.log(`        reply: ${r.reply.replace(/\s+/g, ' ').slice(0, 220)}`)
    for (const o of r.outOfScope) console.log(`        blocked: ${o}`)
  }
  return { passed, total: results.length, unsupported }
}

try {
  console.log(`Model ${createLlm(config.llm).model} · test site 127.0.0.1:${port} · temp folder ${work}`)
  const browser: Result[] = []
  for (let i = 0; i < BROWSER_RUNS; i++) {
    browser.push(await browserTask(i))
    process.stdout.write(browser.at(-1)!.ok ? '.' : 'x')
  }
  const files: Result[] = []
  for (let i = 0; i < FILE_RUNS; i++) {
    files.push(await fileTask(i))
    process.stdout.write(files.at(-1)!.ok ? '.' : 'x')
  }
  const b = report('Browser workflow', browser)
  const f = report('File workflow', files)
  const target = Math.ceil(b.total * 0.9)
  console.log(`\nBrowser target ${target}/${b.total}: ${b.passed >= target ? 'MET' : 'NOT MET'} · files ${f.passed}/${f.total}`)
  writeFileSync(join(process.cwd(), 'docs', `workflow-eval-${full ? 'full' : 'smoke'}.json`), JSON.stringify({ at: new Date().toISOString(), model: createLlm(config.llm).model, browser: b, files: f }, null, 2))
  process.exitCode = b.passed >= target && f.unsupported === 0 && b.unsupported === 0 ? 0 : 1
} finally {
  await mcp.stop()
  server.close()
  rmSync(root, { recursive: true, force: true })
}
