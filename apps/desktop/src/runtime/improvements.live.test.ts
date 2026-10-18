/**
 * Live check (opt-in: ATLAS_LIVE=1): the real model suggests an improvement
 * to itself when it cannot do something, asks first, and adds it only on yes.
 * Throwaway memory; briefs go to a stand-in.
 *   ATLAS_LIVE=1 pnpm vitest run apps/desktop/src/runtime/improvements.live.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PREFS } from '@assistant/initiative'
import { MemoryStore } from '@assistant/memory'
import { createLlm } from '@assistant/providers'
import { Assistant, DEFAULT_RULES, loadConfig, localTools, osCredentialStore, withStoredSecrets } from '@assistant/runtime'
import { fixedClock } from '@assistant/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { IMPROVEMENT_RULES, Improvements } from './improvements.ts'

vi.setConfig({ testTimeout: 240_000 })
const dir = mkdtempSync(join(tmpdir(), 'atlas-improve-live-'))
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // The database may still be open after a failed step.
  }
})

describe.skipIf(!process.env.ATLAS_LIVE)('improvements, live', () => {
  it('suggests, asks, and adds only on yes', async () => {
    try {
      process.loadEnvFile('.env')
    } catch {
      // Optional.
    }
    const { config } = loadConfig({ ...withStoredSecrets(process.env, osCredentialStore()), ASSISTANT_DEV_SKIP_VOICE: '1' }, process.cwd())
    if (!config) throw new Error('Needs an LLM key.')
    const clock = fixedClock(Date.now())
    const memory = new MemoryStore(join(dir, 'a.db'), clock)
    memory.setOnboarded(true)
    const imp = new Improvements({ memory, clock, writeBrief: async (p, f) => `${p}/.atlas/improvements/${f}` })
    let answer = false
    const asked: string[] = []
    const newAssistant = () =>
      new Assistant({
        llm: createLlm(config.llm),
        memory,
        clock,
        owner: config.owner,
        prefs: { ...DEFAULT_PREFS, utcOffsetMin: 300 },
        tools: [...localTools(memory, clock), ...imp.tools()],
        rules: () => [...DEFAULT_RULES, ...IMPROVEMENT_RULES],
        learning: { observeOwner: () => [], contextLines: () => [] },
        confirm: async tool => {
          asked.push(tool.name)
          return answer
        },
      })
    const say = async (a: Assistant, text: string) => {
      let out = ''
      for await (const c of a.reply(text)) out += c
      console.log(`  You: ${text}\n  Atlas: ${out.replace(/\s+/g, ' ').trim()}`)
      return out
    }

    const first = newAssistant()
    await say(first, 'Tum WhatsApp pe aayi hui pictures nahi dekh sakte na? Ye cheez tumhein seekhni chahiye. Isko apni improvement list mein daal do.')
    expect(asked).toContain('improvement_propose')
    expect(imp.list()).toHaveLength(0) // the owner said no

    answer = true
    asked.length = 0
    await say(first, 'Achha theek hai, haan daal do')
    expect(asked).toContain('improvement_propose')
    expect(imp.list()).toHaveLength(1)
    expect(memory.openTasks().some(t => t.title.startsWith('Atlas improvement:'))).toBe(true)
    memory.close()
  })
})
