/**
 * Shows the learning service working with your real LLM key on a throwaway
 * database (your own memory is never touched).
 *   pnpm learning:demo
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '@assistant/memory'
import { AnthropicProvider } from '@assistant/providers'
import { DAY, fixedClock, HOUR, MINUTE } from '@assistant/shared'

import { loadConfig } from './config.ts'
import { osCredentialStore, withStoredSecrets } from './credentials.ts'
import { buildAgenda } from './agenda.ts'
import { Learner } from './learning/learner.ts'

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

const dir = mkdtempSync(join(tmpdir(), 'pa-learning-demo-'))
const clock = fixedClock(Date.UTC(2026, 9, 17, 9))
const memory = new MemoryStore(join(dir, 'demo.db'), clock)
memory.updatePersonality({ verbosity: 'detailed', language: 'mix' }, 'demo start')
const learner = new Learner({ memory, llm: new AnthropicProvider(config.llm.apiKey, config.llm.model), clock })
const line = (s = '') => console.log(s)

try {
  line('━━ 1. Personality adapter ━━')
  for (const text of ['yar itna lamba jawab kyun', 'Atlas, aaj se hamesha English mein jawab dena']) {
    const out = learner.observeOwner(text)
    line(`  You: "${text}"`)
    line(`    → ${out.length ? out.map(o => (o.kind === 'applied' ? `APPLIED now: ${o.description}` : `ASKS you: ${o.description}?`)).join('; ') : 'noted as a hint (no change yet)'}`)
  }
  for (const text of ['phir se bohat lamba', 'bak bak kam karo please']) {
    clock.advance(DAY)
    const out = learner.observeOwner(text)
    line(`  Next day: "${text}" → ${out.length ? out.map(o => `${o.kind.toUpperCase()}: ${o.description}`).join('; ') : 'hint counted'}`)
  }
  line(`  Profile now: language=${memory.personality().profile.language}, verbosity=${memory.personality().profile.verbosity}`)

  line('\n━━ 2. Memory manager (one real model call) ━━')
  const talk: [who: 'owner' | 'assistant', text: string][] = [
    ['owner', 'Atlas, mera client Ahmed Raza hai, Block C tower ka quote usay Friday tak bhejna hai.'],
    ['assistant', 'Theek hai, Friday tak Ahmed Raza ko Block C ka quote.'],
    ['owner', 'Aur ek baat yaad rakhna, quotes hamesha PDF mein bhejta hoon, Word file nahi.'],
    ['assistant', 'Samajh gaya.'],
    ['owner', 'Nahi yar, tumne phir Word attach kiya tha. Agli dafa sirf PDF.'],
    ['owner', 'Mera accountant Bilal hai, invoices wohi dekhta hai.'],
    ['owner', 'Aaj subah se AutoCAD mein Block C ki drawings check kar raha hoon.'],
  ]
  for (const [who, text] of talk) {
    memory.addMessage('demo', who, text)
    clock.advance(MINUTE)
  }
  const { memory: r } = await learner.runIdle({ force: true })
  line(`  Saved right away (you stated them):`)
  for (const s of r.saved) line(`    + ${s}`)
  line(`  Waiting for your yes (lessons and guesses):`)
  for (const s of r.proposed) line(`    ? ${s}`)
  line(`  Dropped because the model could not quote you: ${r.droppedUnquoted}`)

  line('\n  A day later you change a deadline…')
  clock.advance(DAY)
  memory.addMessage('demo', 'owner', 'Ahmed Raza ka quote ab Monday tak chahiye, Friday nahi.')
  memory.addMessage('demo', 'owner', 'Bilal ko bhi copy kar dena invoices mein.')
  memory.addMessage('demo', 'owner', 'Theek hai, baqi kal.')
  const { memory: r2 } = await learner.runIdle({ force: true })
  for (const u of r2.updated) line(`    ↻ updated: ${u}`)
  for (const s of r2.saved) line(`    + ${s}`)

  line('\n━━ 3. Learning service: routines ━━')
  for (const day of [0, 0, 1]) {
    clock.set(Date.UTC(2026, 9, 20 + day, day === 0 && memory.recentActions(10).length ? 15 : 9))
    for (const tool of ['gmail__search_emails', 'filesystem__read_file', 'task_add']) {
      memory.logAction({ tool, summary: '{}', decision: 'allow', result: 'done' })
      clock.advance(MINUTE)
    }
  }
  clock.advance(HOUR)
  const r3 = await learner.runIdle()
  for (const w of r3.workflowsProposed) line(`    ? routine: ${w}`)

  line('\n━━ 4. Curiosity: follow-ups, opinions, getting to know you (one real model call) ━━')
  const pkt = { utcOffsetMin: 300 }
  const curious = new Learner({ memory, llm: new AnthropicProvider(config.llm.apiKey, config.llm.model), clock, ...pkt })
  clock.set(Date.UTC(2026, 9, 21, 7)) // Wed 12:00 in Karachi
  for (const text of ['Kal 3 baje Ahmed Raza ke saath site visit hai Block C pe.', 'Aur Friday ko bank ka loan interview bhi hai, thori tension hai.', 'Theek hai abhi drawings dekhta hoon.']) {
    memory.addMessage('demo', 'owner', text)
    clock.advance(MINUTE)
  }
  const r4 = await curious.runIdle({ force: true })
  line('  Noted to ask about later:')
  for (const f of r4.memory.followups) line(`    ⏰ ${f}`)
  memory.addTask('Send revised quote to Ahmed', { dueAt: clock.now() - 3 * DAY })
  const agendaAt = (label: string, t: number) => {
    clock.set(t)
    const items = buildAgenda(memory, t, pkt).filter(i => /^(followup|stuck|know):/.test(i.key))
    line(`  ${label}:`)
    for (const i of items) line(`    → [${i.key.split(':')[0]}] ${i.title}\n        why: ${i.evidence}`)
    if (!items.length) line('    (nothing to ask yet)')
  }
  agendaAt('Wed 12:00, right now', clock.now())
  agendaAt('Thu 19:00, after the site visit', Date.UTC(2026, 9, 22, 14))

  line('\n━━ What the Learning screen shows ━━')
  const snap = learner.snapshot()
  for (const p of snap.pending) line(`  [${p.kind}] ${p.title}\n      ${p.evidence}`)
  const lesson = snap.pending.find(p => p.kind === 'lesson')
  if (lesson) {
    learner.decide(lesson.id, true)
    line(`\n  You press "Remember this" on the lesson. From now on every reply sees:`)
    for (const l of learner.contextLines()) line(`  ${l.replace(/\n/g, '\n  ')}`)
  }
} finally {
  memory.close()
  rmSync(dir, { recursive: true, force: true })
}
