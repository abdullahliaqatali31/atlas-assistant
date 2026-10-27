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

  it('compresses when the client offers it, and keeps messages in order', async () => {
    const url = await echo()
    const ws = new WebSocket(url)
    const got: string[] = []
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        // Small and large messages interleaved: the large ones are compressed and must not be overtaken.
        for (let i = 0; i < 6; i++) ws.send(i % 2 ? `{"n":${i}}` : JSON.stringify({ n: i, list: Array.from({ length: 3000 }, (_, k) => ({ lat: k / 7, lon: -k / 3, name: `plane ${k}` })) }))
      }
      ws.onmessage = e => {
        got.push(String(e.data))
        if (got.length === 6) resolve()
      }
      ws.onerror = () => reject(new Error('socket error'))
    })
    expect(ws.extensions).toContain('permessage-deflate')
    ws.close()
    expect(got.map(t => (JSON.parse(t.slice('echo:'.length)) as { n: number }).n)).toEqual([0, 1, 2, 3, 4, 5])
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
