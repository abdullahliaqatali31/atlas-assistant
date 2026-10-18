import { describe, expect, it } from 'vitest'

import { HostUi } from '../runtime/ui.ts'
import { describeUi, layoutFor, parseUiChange, type UiState } from './ui.ts'

const base: UiState = { view: 'home', chatOpen: true, compact: false, width: 1180, height: 760, layout: 'wide', maximized: false, minimized: false, visible: true, focused: true, pinned: false }

describe('Atlas’s own window', () => {
  it('picks a layout from the width', () => {
    expect(layoutFor(360)).toBe('phone')
    expect(layoutFor(639)).toBe('phone')
    expect(layoutFor(640)).toBe('narrow')
    expect(layoutFor(1099)).toBe('narrow')
    expect(layoutFor(1100)).toBe('wide')
    expect(layoutFor(1600)).toBe('ultrawide')
  })

  it('accepts only known changes', () => {
    expect(parseUiChange({ view: 'news', chat: false, size: 'compact', pinned: true })).toEqual({ view: 'news', chat: false, size: 'compact', pinned: true })
    expect(parseUiChange({})).toEqual({})
    expect(parseUiChange({ view: 'settings' })).toBeNull()
    expect(parseUiChange({ size: 'huge' })).toBeNull()
    expect(parseUiChange({ chat: 'yes' })).toBeNull()
    expect(parseUiChange(null)).toBeNull()
  })

  it('describes the window in plain words', () => {
    expect(describeUi(base)).toBe('Showing Home; conversation open; 1180×760 (wide layout); in front.')
    expect(describeUi({ ...base, compact: true, pinned: true, focused: false })).toBe('Compact mode: a small chat-only window; 1180×760 (wide layout); kept on top of other windows; behind other windows.')
    expect(describeUi({ ...base, visible: false })).toMatch(/window is closed/)
    expect(describeUi({ ...base, view: 'news', chatOpen: false, maximized: true })).toBe('Showing News; conversation hidden; maximized; in front.')
  })

  it('gives the assistant one context line and sends changes to main', async () => {
    const posted: unknown[] = []
    const ui = new HostUi({ post: e => posted.push(e) })
    expect(ui.contextLines()).toEqual([])
    ui.setSnapshot(base)
    expect(ui.contextLines()[0]).toContain('Showing Home')
    const control = ui.tools().find(t => t.name === 'ui_control')!
    await expect(control.run({})).rejects.toThrow(/Say what to change/)
    const done = control.run({ size: 'compact' })
    const req = posted[0] as { requestId: string; op: unknown }
    expect(req.op).toEqual({ kind: 'set', change: { view: undefined, chat: undefined, size: 'compact', pinned: undefined } })
    ui.onResult(req.requestId, 'Done.')
    await expect(done).resolves.toBe('Done.')
  })
})
