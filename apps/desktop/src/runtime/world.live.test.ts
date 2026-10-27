/**
 * Live check (opt-in: ATLAS_LIVE=1): the real open sources, and the real model
 * using the world tools. Throwaway memory.
 *   ATLAS_LIVE=1 pnpm vitest run apps/desktop/src/runtime/world.live.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PREFS } from '@assistant/initiative'
import { MemoryStore } from '@assistant/memory'
import { createLlm } from '@assistant/providers'
import { Assistant, DEFAULT_RULES, loadConfig, localTools, osCredentialStore, withStoredSecrets } from '@assistant/runtime'
import { systemClock } from '@assistant/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { WORLD_RULES, WorldWatch } from './world.ts'

vi.setConfig({ testTimeout: 240_000 })
const dir = mkdtempSync(join(tmpdir(), 'atlas-world-live-'))
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // The database may still be open after a failed step.
  }
})

describe.skipIf(!process.env.ATLAS_LIVE)('world, live', () => {
  it('fetches the real sources and the model answers from them', async () => {
    const memory = new MemoryStore(join(dir, 'a.db'), systemClock)
    memory.setOnboarded(true)
    const watch = new WorldWatch({ memory, now: () => Date.now() })
    await watch.addPlace('Lahore')
    await watch.addPlace('Riyadh')
    await watch.refresh(true)
    const s = watch.snapshot()
    for (const p of s.places) console.log(watch.describe(p, false))
    console.log(`  quakes M4+: ${s.quakes.length}, open events: ${s.events.length}, news: ${s.places.map(p => `${p.place.name} ${p.news.length}`).join(', ')}, problems: ${s.problems.join('; ') || 'none'}`)
    expect(s.places).toHaveLength(2)
    expect(s.places.every(p => p.weather && p.air)).toBe(true)

    try {
      process.loadEnvFile('.env')
    } catch {
      // Optional.
    }
    const { config } = loadConfig({ ...withStoredSecrets(process.env, osCredentialStore()), ASSISTANT_DEV_SKIP_VOICE: '1' }, process.cwd())
    if (!config) throw new Error('Needs an LLM key.')
    const a = new Assistant({
      llm: createLlm(config.llm),
      memory,
      clock: systemClock,
      owner: config.owner,
      prefs: { ...DEFAULT_PREFS, utcOffsetMin: 300 },
      tools: [...localTools(memory, systemClock), ...watch.tools()],
      rules: () => [...DEFAULT_RULES, ...WORLD_RULES],
      learning: { observeOwner: () => [], contextLines: () => [] },
      confirm: async () => false,
    })
    let out = ''
    for await (const c of a.reply('Lahore aur Riyadh mein aaj mausam aur hawa kaisi hai? Koi khatre wali baat?')) out += c
    console.log(`  Atlas: ${out.replace(/\s+/g, ' ').trim()}`)
    const lahore = s.places.find(p => p.place.name === 'Lahore')!
    expect(out).toMatch(new RegExp(String(Math.round(lahore.weather!.temp))))
    memory.close()
  })
})
