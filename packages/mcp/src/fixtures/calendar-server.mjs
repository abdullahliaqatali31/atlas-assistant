// A tiny stdio MCP server standing in for a calendar connector in tests:
// one read tool, one write tool, no annotations (like most real servers).
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'fake-calendar', version: '0.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'list-events', description: 'List events', inputSchema: { type: 'object', properties: { timeMin: { type: 'string' } } } },
    { name: 'create-event', description: 'Create an event', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
  ],
}))
server.setRequestHandler(CallToolRequestSchema, async req => ({
  content: [{ type: 'text', text: `10:00 Client call (Revised quote) [args ${JSON.stringify(req.params.arguments)}]` }],
}))
await server.connect(new StdioServerTransport())
