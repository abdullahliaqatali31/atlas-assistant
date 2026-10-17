/**
 * Tries the real assistant on any LLM provider, on a throwaway database:
 * a plain reply, then a request that needs a tool call, checked by code.
 *   pnpm trial:provider                         the configured provider
 *   pnpm trial:provider ollama gemma4:e2b       a provider and model
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PREFS } from '@assistant/initiative'
import { MemoryStore } from '@assistant/memory'
import { createLlm, isLlmProvider, LLM_PROVIDERS, type LlmConfig } from '@assistant/providers'
import { systemClock } from '@assistant/shared'

import { Assistant } from './assistant.ts'
import { loadConfig } from './config.ts'
import { osCredentialStore, withStoredSecrets } from './credentials.ts'
import { DEFAULT_RULES, localTools } from './tools.ts'
import { meterLlm, usageSummary } from './usage.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // Optional.
}
const [provider, model] = process.argv.slice(2)
const env = withStoredSecrets({ ...process.env, ASSISTANT_DEV_SKIP_VOICE: '1' }, osCredentialStore())
let llmConfig: LlmConfig
if (provider) {
  if (!isLlmProvider(provider)) throw new Error(`Unknown provider ${provider}`)
  const keyName = LLM_PROVIDERS[provider].keyName
  llmConfig = { provider, apiKey: keyName ? (env[keyName] ?? '') : '', model }
} else {
  const { config, problems } = loadConfig(env, process.cwd())
  if (!config) throw new Error(problems.map(p => p.message).join(' '))
  llmConfig = config.llm
}

const dir = mkdtempSync(join(tmpdir(), 'pa-provider-'))
const memory = new MemoryStore(join(dir, 'a.db'), systemClock)
memory.setOnboarded(true)
const llm = createLlm(llmConfig)
const assistant = new Assistant({
  llm: meterLlm(llm, { purpose: 'chat', memory, clock: systemClock, utcOffsetMin: 300 }),
  memory,
  clock: systemClock,
  owner: { name: 'Abdullah' },
  prefs: { ...DEFAULT_PREFS, utcOffsetMin: 300 },
  tools: localTools(memory, systemClock),
  rules: () => DEFAULT_RULES,
  onAction: n => n.status !== 'running' && console.log(`    · ${n.tool}: ${n.status}`),
})
const say = async (text: string) => {
  const t = Date.now()
  let out = ''
  for await (const c of assistant.reply(text)) out += c
  console.log(`  You: ${text}\n  Atlas (${((Date.now() - t) / 1000).toFixed(1)} s): ${out.replace(/\s+/g, ' ').trim().slice(0, 300)}`)
  return out
}

let failed = 0
try {
  console.log(`Provider ${llmConfig.provider} · model ${llm.model}`)
  const hello = await say('Salam! Ek line mein batao tum kaun ho.')
  if (!hello.trim()) failed++
  await say('Kal subah 10 baje ke liye ek task add karo: "Send revised quote to Ahmed".')
  const added = memory.openTasks().find(t => /revised quote/i.test(t.title))
  console.log(`  ${added ? '✓' : '✗'} tool call worked: ${added ? `task "${added.title}" saved` : 'no task saved'}`)
  if (!added) failed++
  const u = usageSummary(memory, Date.now(), 300)
  console.log(`  usage: ${u.today.calls} calls, ${u.today.tokens} tokens${u.unpriced.length ? ' (no price set for this model)' : `, $${u.today.usd.toFixed(4)}`}`)
  console.log(failed ? `${failed} check(s) failed.` : 'All checks passed.')
  process.exitCode = failed ? 1 : 0
} finally {
  memory.close()
  rmSync(dir, { recursive: true, force: true })
}
