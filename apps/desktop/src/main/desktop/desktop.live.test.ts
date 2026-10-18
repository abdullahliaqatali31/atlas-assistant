/**
 * Live check of desktop control on this PC (opt-in: ATLAS_LIVE=1). Notepad
 * only ever on a fresh blank tab the test opens and verifies first; WhatsApp
 * read-only (counts, no chat content printed, a made-up search, nothing sent).
 * Part B uses your real LLM key.
 *   ATLAS_LIVE=1 pnpm vitest run apps/desktop/src/main/desktop/desktop.live.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

const dir = mkdtempSync(join(tmpdir(), 'atlas-desktop-live-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

const live = !!process.env.ATLAS_LIVE
vi.setConfig({ testTimeout: 300_000 })

const { DesktopService } = await import('./service.ts')
const svc = new DesktopService({ handle: () => {}, toRenderer: () => {}, requireOwner: () => {}, log: () => {} })
// Stand-in for the owner's choices in Apps.
;(svc as unknown as { apps: unknown[] }).apps = [
  { id: 'np', name: 'Notepad', appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', access: 'control', exes: [], addedAt: 0 },
  { id: 'wa', name: 'WhatsApp', appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App', access: 'read', exes: [], addedAt: 0 },
]
const w = svc.worker
type Win = { hwnd: number; title: string; exe: string }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const notepad = async () => (await w.request<Win[]>('windows')).find(x => /notepad\.exe$/i.test(x.exe))!
const doc = async () => (await w.request<{ ref: string; value: string }[]>('query', { hwnd: (await notepad()).hwnd, role: 'document', limit: 1 }))[0]!

/** A new blank tab, checked, so nothing of the owner's is ever touched. */
const freshTab = async () => {
  await svc.handleOp({ kind: 'open', app: 'Notepad' })
  await w.request('keys', { hwnd: (await notepad()).hwnd, keys: 'ctrl+n' })
  await sleep(600)
  const win = await notepad()
  const d = await doc()
  if (!/^untitled/i.test(win.title) || d.value !== '') throw new Error(`Not a blank new tab ("${win.title}"); stopping.`)
}
/** Closes the test tab only after checking it holds just the test text (an unsaved tab is titled by its first line). */
const closeTab = async (expected: RegExp) => {
  const d = await doc()
  const win = await notepad()
  if (!win.title.startsWith('*') || !expected.test(d.value)) throw new Error(`Unexpected tab "${win.title}"; left it alone.`)
  // Keys go to whatever has focus inside the window: the text area first.
  await w.request('act', { hwnd: win.hwnd, ref: d.ref, action: 'focus' })
  await w.request('keys', { hwnd: win.hwnd, keys: 'ctrl+a backspace' })
  await sleep(200)
  if ((await doc()).value !== '') throw new Error('The test tab did not clear; left it open.')
  await w.request('act', { hwnd: win.hwnd, ref: (await doc()).ref, action: 'focus' })
  await w.request('keys', { hwnd: win.hwnd, keys: 'ctrl+w' })
}

afterAll(() => {
  svc.stop()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A database still open after a failed step; the temp folder is cleaned by Windows later.
  }
})

describe.skipIf(!live)('desktop control, live', () => {
  it('A. reads, types with a label check, and refuses a changed element', async () => {
    await freshTab()
    const outline = await svc.handleOp({ kind: 'read', app: 'Notepad', maxNodes: 60 })
    expect(outline).toContain('document "Text editor"')
    const d = await doc()
    await expect(svc.handleOp({ kind: 'act', app: 'Notepad', ref: d.ref, label: 'Save button', action: 'type', text: 'x' })).rejects.toThrow(/now says/)
    await svc.handleOp({ kind: 'act', app: 'Notepad', ref: d.ref, label: 'Text editor', action: 'type', text: 'Atlas live test' })
    await sleep(200)
    expect((await doc()).value).toBe('Atlas live test')
    await expect(svc.handleOp({ kind: 'act', app: 'Notepad', ref: d.ref, label: 'Text editor', action: 'replace', text: 'gone' })).rejects.toThrow(/whole document/)
    await closeTab(/^Atlas live test$/)
  })

  it('B. the model writes in Notepad, and a select-all wipe asks first', async () => {
    const { DEFAULT_PREFS } = await import('@assistant/initiative')
    const { MemoryStore } = await import('@assistant/memory')
    const { createLlm } = await import('@assistant/providers')
    const { Assistant, DEFAULT_RULES, loadConfig, localTools, osCredentialStore, withStoredSecrets } = await import('@assistant/runtime')
    const { fixedClock } = await import('@assistant/shared')
    const { DESKTOP_RULES, HostDesktop } = await import('../../runtime/desktop.ts')
    try {
      process.loadEnvFile('.env')
    } catch {
      // Optional.
    }
    const { config } = loadConfig({ ...withStoredSecrets(process.env, osCredentialStore()), ASSISTANT_DEV_SKIP_VOICE: '1' }, process.cwd())
    if (!config) throw new Error('Needs an LLM key.')
    const desktop = new HostDesktop({ post: e => void svc.handleOp(e.op).then(r => desktop.onResult(e.requestId, r), err => desktop.onResult(e.requestId, undefined, String(err?.message ?? err))) })
    const clock = fixedClock(Date.now())
    const memory = new MemoryStore(join(dir, 'a.db'), clock)
    memory.setOnboarded(true)
    const asked: string[] = []
    const a = new Assistant({
      llm: createLlm(config.llm),
      memory,
      clock,
      owner: config.owner,
      prefs: { ...DEFAULT_PREFS, utcOffsetMin: 300 },
      tools: [...localTools(memory, clock), ...desktop.tools()],
      rules: () => [...DEFAULT_RULES, ...DESKTOP_RULES],
      learning: { observeOwner: () => [], contextLines: () => [] },
      // The owner says no to everything that asks, and we note what asked.
      confirm: async tool => {
        asked.push(tool.name)
        return false
      },
      onAction: n => n.status !== 'running' && console.log(`      · ${n.tool}: ${n.status}`),
    })
    const say = async (text: string) => {
      let out = ''
      for await (const c of a.reply(text)) out += c
      console.log(`  You: ${text}\n  Atlas: ${out.replace(/\s+/g, ' ').trim()}`)
      return out
    }
    await freshTab()
    await say('Notepad mein abhi jo khali naya tab khula hai, usmein likho: Atlas ne ye likha')
    expect((await doc()).value).toMatch(/Atlas ne ye likha/)
    await say('Ab Notepad mein ctrl+a daba ke backspace daba do')
    expect(asked).toContain('desktop_keys')
    expect((await doc()).value).toMatch(/Atlas ne ye likha/)
    memory.close()
    await closeTab(/Atlas ne ye likha/)
  })

  it('C. WhatsApp, read-only: finds the chat list and refuses an unknown chat', async () => {
    const chats = await svc.handleOp({ kind: 'wa-chats', filter: 'all' })
    const rows = chats.split('\n').filter(l => l.startsWith('- ')).length
    console.log(`  WhatsApp chat rows found: ${rows} (content not printed)`)
    expect(rows).toBeGreaterThan(0)
    await expect(svc.handleOp({ kind: 'wa-read', chat: 'zzqx no such chat 4821' })).rejects.toThrow(/No WhatsApp chat matches/)
    await expect(svc.handleOp({ kind: 'wa-send', chat: 'zzqx no such chat 4821', text: 'x' })).rejects.toThrow(/control/)
  })
})
