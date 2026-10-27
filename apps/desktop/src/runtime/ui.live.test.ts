/**
 * Live check (opt-in: ATLAS_LIVE=1) that the real model uses its window
 * tools when asked, and leaves the window alone otherwise. Throwaway memory;
 * the window itself is a stand-in that records the changes.
 *   ATLAS_LIVE=1 pnpm vitest run apps/desktop/src/runtime/ui.live.test.ts
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

import { describeUi, type UiChange, type UiState } from '../shared/ui.ts'
import { HostUi, UI_RULES } from './ui.ts'

vi.setConfig({ testTimeout: 180_000 })
const dir = mkdtempSync(join(tmpdir(), 'atlas-ui-live-'))
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // The database may still be open after a failed step.
  }
})

describe.skipIf(!process.env.ATLAS_LIVE)('window tools, live', () => {
  it('changes its window when asked, and only then', async () => {
    try {
      process.loadEnvFile('.env')
    } catch {
      // Optional.
    }
    const { config } = loadConfig({ ...withStoredSecrets(process.env, osCredentialStore()), ASSISTANT_DEV_SKIP_VOICE: '1' }, process.cwd())
    if (!config) throw new Error('Needs an LLM key.')
    let state: UiState = { view: 'home', chatOpen: true, compact: false, width: 1180, height: 760, layout: 'wide', maximized: false, minimized: false, visible: true, focused: true, pinned: false }
    const changes: UiChange[] = []
    const ui: HostUi = new HostUi({
      post: e => {
        if (e.op.kind === 'set') {
          const c = e.op.change
          changes.push(c)
          state = { ...state, view: c.view ?? state.view, chatOpen: c.chat ?? state.chatOpen, compact: c.size ? c.size === 'compact' : c.view ? false : state.compact, pinned: c.pinned ?? state.pinned }
          ui.setSnapshot(state)
        }
        queueMicrotask(() => ui.onResult(e.requestId, describeUi(state)))
      },
    })
    ui.setSnapshot(state)
    const clock = fixedClock(Date.now())
    const memory = new MemoryStore(join(dir, 'a.db'), clock)
    memory.setOnboarded(true)
    const a = new Assistant({
      llm: createLlm(config.llm),
      memory,
      clock,
      owner: config.owner,
      prefs: { ...DEFAULT_PREFS, utcOffsetMin: 300 },
      tools: [...localTools(memory, clock), ...ui.tools()],
      rules: () => [...DEFAULT_RULES, ...UI_RULES],
      learning: { observeOwner: () => [], contextLines: () => ui.contextLines() },
      confirm: async () => false,
    })
    const say = async (text: string) => {
      let out = ''
      for await (const c of a.reply(text)) out += c
      console.log(`  You: ${text}\n  Atlas: ${out.replace(/\s+/g, ' ').trim()}`)
      return out
    }

    await say('Aaj Pakistan mein kitne baje maghrib hoti hai, andaza se bata do')
    expect(changes).toHaveLength(0)

    await say('Compact ho jao aur upar rakho')
    expect(state.compact).toBe(true)
    expect(state.pinned).toBe(true)

    await say('Ab news wala page dikhao')
    expect(state.view).toBe('news')
    expect(state.compact).toBe(false)

    await say('Chat band kar do')
    expect(state.chatOpen).toBe(false)
    memory.close()
  })
})
