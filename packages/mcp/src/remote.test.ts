import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { McpHost } from './index.ts'

let server: Server | null = null
afterEach(() => {
  server?.close()
  server = null
})

/** A real MCP server over streamable HTTP that wants a bearer token, on a free local port. */
const remote = async (token: string) => {
  server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    const mcp = new McpServer({ name: 'remote-test', version: '1.0.0' })
    mcp.tool('echo', 'Says it back.', { text: z.string() }, { readOnlyHint: true }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => void transport.close())
    await mcp.connect(transport)
    await transport.handleRequest(req, res)
  })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/mcp`
}

describe('remote connectors', () => {
  it('connect over HTTP with the token from the credential store, and call tools through the policy', async () => {
    const url = await remote('s3cret')
    const host = new McpHost(
      { servers: { notes: { enabled: true, transport: 'http', url, authSecret: 'MCP_REMOTE_NOTES', trusted: true } } },
      () => [{ id: 'allow-notes', tool: 'notes__*', actionClass: 'observe', effect: 'allow' }],
      () => 0,
      name => (name === 'MCP_REMOTE_NOTES' ? 's3cret' : undefined),
    )
    expect(await host.start()).toEqual([])
    expect(host.listTools().map(t => [t.name, t.actionClass])).toEqual([['notes__echo', 'observe']])
    expect(await host.call('notes__echo', { text: 'hi' })).toMatchObject({ status: 'ok', untrustedText: expect.stringContaining('echo: hi') })
    await host.stop()
  })

  it('reports a wrong token or a missing one instead of crashing', async () => {
    const url = await remote('s3cret')
    const wrong = new McpHost({ servers: { notes: { enabled: true, transport: 'http', url, authSecret: 'MCP_REMOTE_NOTES' } } }, () => [], () => 0, () => 'nope')
    expect((await wrong.start())[0]?.server).toBe('notes')
    const missing = new McpHost({ servers: { notes: { enabled: true, transport: 'http', url, authSecret: 'MCP_REMOTE_NOTES' } } }, () => [], () => 0)
    expect((await missing.start())[0]?.error).toMatch(/token is missing/)
  })
})
