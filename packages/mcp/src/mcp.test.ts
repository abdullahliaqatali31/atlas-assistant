import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Rule } from '@assistant/policy'
import { describe, expect, it } from 'vitest'

import { CONNECTORS, connectorServer, McpHost, resolveBriefingArgs, toHostedTool, type McpConfig, type ServerConfig } from './index.ts'

describe('toHostedTool', () => {
  const tool = { name: 'send_email', inputSchema: {}, annotations: { readOnlyHint: true } }

  it('ignores annotations from untrusted servers', () => {
    expect(toHostedTool('gmail', {}, tool).actionClass).toBe('external-send')
  })

  it('uses annotations from trusted servers and owner overrides win', () => {
    expect(toHostedTool('gmail', { trusted: true }, tool).actionClass).toBe('observe')
    expect(toHostedTool('gmail', { trusted: true, overrides: { send_email: 'external-send' } }, tool).actionClass).toBe('external-send')
  })

  it('qualifies names by server', () => {
    expect(toHostedTool('gmail', {}, tool).name).toBe('gmail__send_email')
  })
})

describe('McpHost', () => {
  it('skips disabled servers and reports unknown tools', async () => {
    const host = new McpHost({ servers: { fs: { enabled: false, transport: 'stdio', command: 'nope' } } }, () => [], () => 0)
    expect(await host.start()).toEqual([])
    expect(await host.call('fs__read', {})).toMatchObject({ status: 'error' })
  })
})

describe('read-only connectors', () => {
  const fixture = fileURLToPath(new URL('./fixtures/calendar-server.mjs', import.meta.url))
  const config = (extra: Partial<ServerConfig> = {}): McpConfig => ({
    servers: {
      cal: {
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        readOnly: true,
        overrides: { 'list-events': 'observe' },
        briefing: [{ kind: 'calendar', label: 'Google Calendar', tool: 'list-events', args: { timeMin: '{dayStart}' } }],
        ...extra,
      },
    },
  })
  const allowReads: Rule[] = [{ id: 'owner-cal', tool: 'cal__*', actionClass: 'observe', effect: 'allow' }]

  it('offers only observe tools and names the briefing reads', async () => {
    const host = new McpHost(config(), () => allowReads, () => 0)
    try {
      expect(await host.start()).toEqual([])
      expect(host.listTools().map(t => t.name)).toEqual(['cal__list-events'])
      expect(await host.call('cal__create-event', { title: 'x' })).toMatchObject({ status: 'error' })
      expect(host.briefingCalls().map(b => b.qualifiedName)).toEqual(['cal__list-events'])
      const out = await host.call('cal__list-events', resolveBriefingArgs({ timeMin: '{dayStart}' }, Date.UTC(2026, 9, 17, 3), 300))
      expect(out).toMatchObject({ status: 'ok', server: 'cal' })
      expect(out.status === 'ok' && out.untrustedText).toContain('"timeMin":"2026-10-17T00:00:00+05:00"')
    } finally {
      await host.stop()
    }
  }, 20_000)

  it('without readOnly the write tool is offered but stays external-send', async () => {
    const host = new McpHost(config({ readOnly: false }), () => [], () => 0)
    try {
      await host.start()
      expect(host.listTools().find(t => t.tool === 'create-event')?.actionClass).toBe('external-send')
      // No standing rule: even a read needs the owner's yes.
      expect(await host.call('cal__list-events', {})).toMatchObject({ status: 'needs-confirmation' })
    } finally {
      await host.stop()
    }
  }, 20_000)
})

describe('connector catalogue', () => {
  it('ships calendar and email connectors disabled, read-only, with briefing reads among their observe tools', () => {
    expect(CONNECTORS.map(c => c.id)).toEqual(['google-calendar', 'gmail', 'microsoft-365'])
    for (const c of CONNECTORS) {
      expect(c.server.enabled).toBe(false)
      expect(c.server.readOnly).toBe(true)
      for (const b of c.server.briefing ?? []) expect(c.server.overrides?.[b.tool]).toBe('observe')
      // No write tool is ever classified observe.
      expect(Object.keys(c.server.overrides ?? {}).some(t => /send|create|update|delete|modify|draft|label_|batch/.test(t))).toBe(false)
    }
    expect(connectorServer('gmail')).not.toBe(connectorServer('gmail'))
  })

  it('fills briefing placeholders for the owner day, west of UTC too', () => {
    const at = Date.UTC(2026, 9, 17, 2, 30)
    expect(resolveBriefingArgs({ a: '{dayStart}', b: '{dayEnd}', q: 'after:{today}', n: 5 }, at, 300)).toEqual({
      a: '2026-10-17T00:00:00+05:00',
      b: '2026-10-17T23:59:59+05:00',
      q: 'after:2026/10/17',
      n: 5,
    })
    expect(resolveBriefingArgs({ a: '{dayStart}' }, at, -240).a).toBe('2026-10-16T00:00:00-04:00')
  })

  it('example config matches the catalogue', () => {
    const example = JSON.parse(readFileSync(fileURLToPath(new URL('../../../mcp.servers.example.json', import.meta.url)), 'utf8')) as McpConfig
    for (const c of CONNECTORS) {
      const { env: _env, $comment: _note, ...rest } = example.servers[c.id] as ServerConfig & { $comment?: string }
      const { env: _catalogueEnv, ...catalogue } = c.server
      expect(rest).toEqual(catalogue)
    }
  })
})
