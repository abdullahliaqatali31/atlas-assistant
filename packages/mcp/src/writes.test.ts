import { evaluate } from '@assistant/policy'
import { describe, expect, it } from 'vitest'

import { connectorServer, withWrites } from './connectors.ts'

describe('calendar and email writes', () => {
  it('offer only the listed writes, as external sends, and switch the servers’ own read-only modes', () => {
    const gmail = withWrites('gmail', connectorServer('gmail'), true)
    expect(gmail.readOnly).toBe(false)
    expect(gmail.allowTools).toEqual(['search_emails', 'read_email', 'list_email_labels', 'send_email', 'draft_email'])
    expect(gmail.overrides?.send_email).toBe('external-send')

    const cal = withWrites('google-calendar', connectorServer('google-calendar'), true)
    expect(cal.env?.ENABLED_TOOLS).toContain('create-event')
    expect(cal.env?.ENABLED_TOOLS).not.toContain('delete-event')

    const ms = withWrites('microsoft-365', connectorServer('microsoft-365'), true)
    expect(ms.args).not.toContain('--read-only')
    expect(withWrites('microsoft-365', ms, false).args).toContain('--read-only')
  })

  it('turning writes off goes back to read-only', () => {
    const off = withWrites('gmail', withWrites('gmail', connectorServer('gmail'), true), false)
    expect(off.readOnly).toBe(true)
    expect(off.allowTools).toBeUndefined()
    expect(off.overrides?.send_email).toBeUndefined()
  })

  it('asks before every send (the standing rule), and always after untrusted content', () => {
    const rules = [{ id: 'owner-connector-write-gmail-send_email', tool: 'gmail__send_email', actionClass: 'external-send' as const, effect: 'ask' as const }]
    expect(evaluate({ tool: 'gmail__send_email', actionClass: 'external-send' }, rules, 0).effect).toBe('ask')
    expect(evaluate({ tool: 'gmail__send_email', actionClass: 'external-send', fromUntrustedSource: true, fullControl: true }, rules, 0).effect).toBe('ask')
  })
})
