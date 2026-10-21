import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '@assistant/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { diffMemory, MemoryMirror, parseMemory, renderMemory } from './memory-md.ts'

let dir = ''
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'atlas-md-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const src = { kind: 'owner' as const, origin: 'test', retrievedAt: 0 }

describe('memory as Markdown', () => {
  it('renders by kind with marks, and reads its own output back', () => {
    const md = renderMemory([{ id: 'aaaaaaaa-1', kind: 'fact', statement: 'Works on Atlas', source: src, confidence: 1, projectId: null, createdAt: 0 }], 'Abdullah')
    expect(md).toContain('## Facts\n\n- Works on Atlas <!-- m:aaaaaaaa -->')
    expect(parseMemory(md)).toEqual([{ kind: 'fact', text: 'Works on Atlas', id: 'aaaaaaaa' }])
  })

  it('turns the owner’s edits into corrections, forgetting and new memories', () => {
    const written = parseMemory('## Facts\n- A <!-- m:11111111 -->\n- B <!-- m:22222222 -->\n## Lessons\n')
    const edited = parseMemory('## Facts\n- A changed <!-- m:11111111 -->\n## Lessons\n- Never call after 10pm\n')
    expect(diffMemory(written, edited)).toEqual([
      { op: 'correct', id: '11111111', text: 'A changed' },
      { op: 'forget', id: '22222222' },
      { op: 'add', kind: 'lesson', text: 'Never call after 10pm' },
    ])
  })

  it('syncs both ways with the real store', async () => {
    let now = Date.now()
    const store = new MemoryStore(join(dir, 'db.sqlite'), { now: () => now })
    const keep = store.remember({ kind: 'fact', statement: 'Lives in Gujranwala', source: src })
    store.remember({ kind: 'preference', statement: 'Likes green tea', source: src })
    const mirror = new MemoryMirror(store, join(dir, 'md'), { owner: () => 'Abdullah', now: () => now, log: () => undefined })
    mirror.sync()
    const text = readFileSync(mirror.file, 'utf8')
    expect(text).toContain('Likes green tea')
    // The owner edits the file a moment later.
    await new Promise(r => setTimeout(r, 30))
    writeFileSync(mirror.file, text.replace('Lives in Gujranwala', 'Lives in Lahore').replace(/- Likes green tea.*\n/, '').replace('## Lessons\n', '## Lessons\n- Prefers voice notes to calls\n'))
    now += 1000
    mirror.sync()
    const after = store.allMemories().map(m => [m.kind, m.statement])
    expect(after).toEqual([
      ['fact', 'Lives in Lahore'],
      ['lesson', 'Prefers voice notes to calls'],
    ])
    expect(store.allMemories().some(m => m.id === keep)).toBe(false)
    expect(readFileSync(mirror.file, 'utf8')).toContain('Lives in Lahore <!-- m:')
    store.close()
  })
})
