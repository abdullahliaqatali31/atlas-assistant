import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { acceptUpgrade } from './socket.ts'

let server: Server | null = null
afterEach(() => {
  server?.close()
  server = null
})

/** An echo server on a free port; the client is Node's own WebSocket (the same protocol as a browser's). */
const echo = async () => {
  server = createServer()
  server.on('upgrade', (req, socket, head) => {
    const conn = acceptUpgrade(req, socket, head)
    conn?.onMessage(text => conn.send(`echo:${text}`))
  })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
  return `ws://127.0.0.1:${(server!.address() as AddressInfo).port}/`
}

const roundTrip = (url: string, message: string) =>
  new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.onopen = () => ws.send(message)
    ws.onmessage = e => {
      resolve(String(e.data))
      ws.close()
    }
    ws.onerror = () => reject(new Error('socket error'))
  })

describe('WebSocket server', () => {
  it('echoes short, medium and long messages', async () => {
    const url = await echo()
    expect(await roundTrip(url, 'hi')).toBe('echo:hi')
    const medium = 'x'.repeat(1000)
    expect(await roundTrip(url, medium)).toBe(`echo:${medium}`)
    const long = 'ب'.repeat(200_000)
    expect(await roundTrip(url, long)).toBe(`echo:${long}`)
  })

  it('refuses plain HTTP on the upgrade path', async () => {
    server = createServer()
    server.on('upgrade', (req, socket, head) => acceptUpgrade(req, socket, head))
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } }).catch(() => null)
    expect(res === null || res.status === 400).toBe(true)
  })
})
