import { evaluate } from '@assistant/policy'
import { describe, expect, it } from 'vitest'

import type { SystemOp } from '../shared/system.ts'
import { HostSystem, SYSTEM_RULES } from './system.ts'

const setup = (fc = { on: false, mode: null as string | null, until: null as number | null }) => {
  const asked: SystemOp[] = []
  const sys = new HostSystem({ request: async op => (asked.push(op), 'ok'), now: () => 0, fullControl: () => fc })
  const tool = (name: string) => sys.tools().find(t => t.name === name)!
  return { sys, asked, tool }
}

describe('Full control, runtime side', () => {
  it('turning it on is the owner’s yes every time; turning it off never waits', () => {
    const { tool } = setup()
    const fc = tool('full_control')
    const decide = (on: boolean, extra = {}) => evaluate({ tool: 'full_control', actionClass: 'modify', scope: fc.scope?.({ on }), ...extra }, SYSTEM_RULES, 0).effect
    expect(decide(true)).toBe('ask')
    expect(decide(false)).toBe('allow')
    // After reading outside content, an "on" request still waits for the owner.
    expect(decide(true, { fromUntrustedSource: true })).toBe('ask')
  })

  it('passes the mode on, and tells Atlas the limits while it is on', async () => {
    const { asked, tool } = setup()
    await tool('full_control').run({ on: true, for: 'hour' })
    await tool('full_control').run({ on: false })
    expect(asked).toEqual([
      { kind: 'full-control', on: true, mode: 'hour' },
      { kind: 'full-control', on: false, mode: 'session' },
    ])
    expect(setup().sys.contextLines()).toEqual([])
    const line = setup({ on: true, mode: 'session', until: null }).sys.contextLines()[0]
    expect(line).toMatch(/Full control is ON until the owner locks the PC or leaves/)
    expect(line).toMatch(/Deleting for good, passwords and payments still need their yes/)
  })

  it('opening and making things ask in Normal mode, and run in Full control', () => {
    for (const t of ['open_item', 'launch_app', 'make_folder', 'make_document', 'make_sheet']) {
      expect(evaluate({ tool: t, actionClass: 'modify' }, SYSTEM_RULES, 0).effect, t).toBe('ask')
      expect(evaluate({ tool: t, actionClass: 'modify', fullControl: true }, SYSTEM_RULES, 0).effect, t).toBe('allow')
    }
  })
})
