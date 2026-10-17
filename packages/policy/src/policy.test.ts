import { describe, expect, it } from 'vitest'

import { classifyMcpTool, evaluate, type Rule } from './index.ts'

const NOW = 1_000_000

describe('evaluate', () => {
  const rules: Rule[] = [
    { id: 'files-read', tool: 'files', actionClass: 'observe', effect: 'allow', scopePrefix: 'C:/Work/' },
    { id: 'files-write', tool: 'files', actionClass: 'modify', effect: 'allow', scopePrefix: 'C:/Work/drafts/' },
    { id: 'no-mail', tool: 'gmail', actionClass: 'external-send', effect: 'deny' },
  ]

  it('allows a scoped read and normalizes Windows separators', () => {
    const d = evaluate({ tool: 'files', actionClass: 'observe', scope: 'C:\\Work\\quote.pdf' }, rules, NOW)
    expect(d).toMatchObject({ effect: 'allow', ruleId: 'files-read' })
  })

  it('asks when no rule covers the scope', () => {
    const d = evaluate({ tool: 'files', actionClass: 'modify', scope: 'C:/Work/final/quote.pdf' }, rules, NOW)
    expect(d.effect).toBe('ask')
  })

  it('denies when a deny rule matches', () => {
    const d = evaluate({ tool: 'gmail', actionClass: 'external-send', scope: 'client@x.com' }, rules, NOW)
    expect(d).toMatchObject({ effect: 'deny', ruleId: 'no-mail' })
  })

  it('always confirms destructive actions even with an allow rule', () => {
    const r: Rule[] = [{ id: 'yolo', tool: '*', actionClass: 'destructive', effect: 'allow' }]
    expect(evaluate({ tool: 'files', actionClass: 'destructive' }, r, NOW).effect).toBe('ask')
  })

  it('makes untrusted-origin requests ask, never auto-allow', () => {
    const d = evaluate(
      { tool: 'files', actionClass: 'modify', scope: 'C:/Work/drafts/a.md', fromUntrustedSource: true },
      rules,
      NOW,
    )
    expect(d.effect).toBe('ask')
  })

  it('ignores expired rules', () => {
    const r: Rule[] = [{ id: 'temp', tool: 'browser', actionClass: 'draft', effect: 'allow', expiresAt: NOW - 1 }]
    expect(evaluate({ tool: 'browser', actionClass: 'draft' }, r, NOW).effect).toBe('ask')
  })

  it('respects maxValue', () => {
    const r: Rule[] = [{ id: 'few', tool: 'browser', actionClass: 'draft', effect: 'allow', maxValue: 3 }]
    expect(evaluate({ tool: 'browser', actionClass: 'draft', value: 2 }, r, NOW).effect).toBe('allow')
    expect(evaluate({ tool: 'browser', actionClass: 'draft', value: 5 }, r, NOW).effect).toBe('ask')
  })
})

describe('classifyMcpTool', () => {
  it('treats unannotated or untrusted tools as external-send', () => {
    expect(classifyMcpTool(undefined, true)).toBe('external-send')
    expect(classifyMcpTool({ readOnlyHint: true }, false)).toBe('external-send')
  })

  it('maps trusted hints', () => {
    expect(classifyMcpTool({ readOnlyHint: true }, true)).toBe('observe')
    expect(classifyMcpTool({ destructiveHint: true }, true)).toBe('destructive')
    expect(classifyMcpTool({ openWorldHint: false }, true)).toBe('modify')
  })
})

describe('owner rule shapes', () => {
  it('matches every tool of one server with "<server>__*", but not other servers', () => {
    const r: Rule[] = [{ id: 'pw-observe', tool: 'playwright__*', actionClass: 'observe', effect: 'allow' }]
    expect(evaluate({ tool: 'playwright__browser_snapshot', actionClass: 'observe' }, r, NOW).effect).toBe('allow')
    expect(evaluate({ tool: 'playwrightx__browser_snapshot', actionClass: 'observe' }, r, NOW).effect).toBe('ask')
    expect(evaluate({ tool: 'playwright__browser_click', actionClass: 'external-send' }, r, NOW).effect).toBe('ask')
  })

  it('lets a rule for one tool beat a server-wide rule', () => {
    const r: Rule[] = [
      { id: 'fs-read', tool: 'filesystem__*', actionClass: 'observe', effect: 'allow' },
      { id: 'no-tree', tool: 'filesystem__directory_tree', actionClass: 'observe', effect: 'ask' },
    ]
    expect(evaluate({ tool: 'filesystem__directory_tree', actionClass: 'observe' }, r, NOW)).toMatchObject({ effect: 'ask', ruleId: 'no-tree' })
  })

  it('stops folder scopes at a path boundary', () => {
    const r: Rule[] = [{ id: 'work', tool: 'filesystem__*', actionClass: 'observe', effect: 'allow', scopePrefix: 'D:\\Work' }]
    expect(evaluate({ tool: 'filesystem__read_file', actionClass: 'observe', scope: 'D:/Work/notes.md' }, r, NOW).effect).toBe('allow')
    expect(evaluate({ tool: 'filesystem__read_file', actionClass: 'observe', scope: 'd:\\work' }, r, NOW).effect).toBe('allow')
    expect(evaluate({ tool: 'filesystem__read_file', actionClass: 'observe', scope: 'D:/Workshop/notes.md' }, r, NOW).effect).toBe('ask')
    expect(evaluate({ tool: 'filesystem__read_file', actionClass: 'observe' }, r, NOW).effect).toBe('ask')
  })
})
