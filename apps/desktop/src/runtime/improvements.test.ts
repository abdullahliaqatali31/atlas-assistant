import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '@assistant/memory'
import { evaluate } from '@assistant/policy'
import { DEFAULT_RULES } from '@assistant/runtime'
import { DAY, fixedClock } from '@assistant/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { approvalQuestion } from '../shared/consent.ts'
import { briefOf, IMPROVEMENT_RULES, Improvements } from './improvements.ts'

const dirs: string[] = []
const stores: MemoryStore[] = []
afterEach(() => {
  for (const m of stores.splice(0)) m.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-improve-'))
  dirs.push(dir)
  const clock = fixedClock(Date.parse('2026-10-18T12:00:00+05:00'))
  const memory = new MemoryStore(join(dir, 'a.db'), clock)
  stores.push(memory)
  const written: { project: string; file: string; text: string }[] = []
  const imp = new Improvements({
    memory,
    clock,
    writeBrief: async (project, file, text) => {
      written.push({ project, file, text })
      return `${project}/.atlas/improvements/${file}`
    },
  })
  return { memory, clock, imp, written }
}

describe('Improvements', () => {
  it('on the owner’s yes: a task, a brief in the app, and a brief file in the chosen project', async () => {
    const { memory, imp, written } = setup()
    expect(await imp.approve({ title: 'See WhatsApp pictures', problem: 'I cannot look at images people send.' })).toMatch(/Saved in Learning/)
    expect(written).toHaveLength(0)
    imp.setProject('New Voice Assistent')
    const msg = await imp.approve({ title: 'Listen to voice notes', problem: 'I cannot hear WhatsApp voice notes.', done: 'A voice note is summarised in the chat.', area: 'whatsapp_read' })
    expect(msg).toContain('New Voice Assistent/.atlas/improvements/2026-10-18-listen-to-voice-notes.md')
    expect(written[0]!.text).toContain('## Done when\nA voice note is summarised in the chat.')
    expect(memory.openTasks().map(t => t.title)).toEqual(expect.arrayContaining(['Atlas improvement: See WhatsApp pictures', 'Atlas improvement: Listen to voice notes']))
    expect(imp.list()).toHaveLength(2)
    expect(await imp.approve({ title: 'listen to voice notes', problem: 'again' })).toMatch(/already on the improvement list/)
  })

  it('writes a brief with the ground rules that keep permissions as they are', () => {
    const text = briefOf({ id: 'x', title: 'T', problem: 'P', example: 'E', done: null, area: null, status: 'open', createdAt: 0, doneAt: null, taskId: null, briefFile: null })
    expect(text).toContain('# Atlas improvement: T')
    expect(text).toContain('## What happened\nE')
    expect(text).toMatch(/Keep the existing permission rules/)
    expect(text).toMatch(/owner reviews the change before it is merged/)
  })

  it('marks done and removes', async () => {
    const { imp } = setup()
    await imp.approve({ title: 'Read scanned PDFs', problem: 'Scanned PDFs have no text.' })
    const id = imp.list()[0]!.id
    expect(imp.markDone('read scanned pdfs')?.status).toBe('done')
    imp.remove(id)
    expect(imp.list()).toHaveLength(0)
  })

  it('raises a struggle once after repeated failures, and not again for a month', () => {
    const { memory, clock, imp } = setup()
    for (let i = 0; i < 3; i++) memory.logAction({ tool: 'whatsapp_read', summary: '{}', decision: 'allow', result: 'failed', evidence: 'Could not find WhatsApp’s search box.' })
    memory.logAction({ tool: 'files_list', summary: '{}', decision: 'allow', result: 'failed', evidence: 'x' })
    const [item, ...rest] = imp.agenda(clock.now())
    expect(rest).toHaveLength(0)
    expect(item!.title).toBe('I keep having trouble with whatsapp_read')
    expect(item!.instruction).toMatch(/Only if they say yes, call improvement_propose/)
    expect(imp.agenda(clock.now() + DAY)).toHaveLength(0)
  })

  it('always asks before adding one, in plain words', () => {
    const rules = [...DEFAULT_RULES, ...IMPROVEMENT_RULES]
    expect(evaluate({ tool: 'improvement_propose', actionClass: 'modify' }, rules, Date.now()).effect).toBe('ask')
    expect(evaluate({ tool: 'improvement_list', actionClass: 'observe' }, rules, Date.now()).effect).toBe('allow')
    expect(approvalQuestion('improvement_propose', { title: 'Listen to voice notes' }, 'Hamza', true)).toBe('Hamza, kya main “Listen to voice notes” ko apni improvement list mein daal kar task aur brief bana doon?')
  })
})
