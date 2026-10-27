/**
 * Atlas's hands on a PC whose brain runs elsewhere (a server, another PC):
 * `atlas connect <address> <code>` pairs once, then this process keeps one
 * WebSocket open to the brain and does on this PC what Atlas asks (apps,
 * files, code, status, the widget), with a tray icon to open Atlas, see the
 * connection and disconnect. Nothing here listens on the network.
 *
 *   node machine.js --brain https://atlas.example.com --code ABCD-EFGH [--name "Work laptop"]
 *   node machine.js            (paired already: connect with the saved token)
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { CAPABILITIES, HANDS_OP, HANDS_PATH, HANDS_VERSION, platformOf, type BrainMessage, type Capability, type HandsMessage } from '../shared/hands.ts'
import { app, powerMonitor, shell } from '../main/host/index.ts'
import { Tray } from '../main/host/tray.ts'
import { atlasProfile, openInProfile } from '../main/web/opener.ts'
import { createHands } from './hands.ts'
import { exportBrainData } from '../main/hands/move.ts'
import { osCredentialStore } from '@assistant/runtime'

const userData = app.getPath('userData')
const CONFIG = join(userData, 'hands.json')
const PID_FILE = join(userData, 'hands.pid')
/** atlas disconnect leaves this: close on purpose (Windows has no gentle signal for another process). */
const STOP_FILE = join(userData, 'hands.stop')

interface Config {
  brain: string
  machineId: string
  token: string
  name: string
  capabilities: Capability[]
}

const log = (level: 'info' | 'warn' | 'error', message: string) => console[level](`[atlas hands] ${message}`)

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

const readConfig = (): Config | null => {
  try {
    const c = JSON.parse(readFileSync(CONFIG, 'utf8')) as Partial<Config>
    if (typeof c.brain !== 'string' || typeof c.token !== 'string' || typeof c.machineId !== 'string') return null
    return { brain: c.brain, token: c.token, machineId: c.machineId, name: typeof c.name === 'string' ? c.name : hostname(), capabilities: Array.isArray(c.capabilities) ? c.capabilities.filter((x): x is Capability => (CAPABILITIES as readonly string[]).includes(x)) : [...CAPABILITIES] }
  } catch {
    return null
  }
}

const saveConfig = (c: Config) => {
  writeFileSync(CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 })
  try {
    chmodSync(CONFIG, 0o600)
  } catch {
    // Windows: the user's own folder.
  }
}

/** "atlas.example.com", "192.168.1.5:47800" or a full address → the brain's base address. */
export const brainBase = (given: string): string => {
  const raw = /^https?:\/\//i.test(given.trim()) ? given.trim() : `https://${given.trim()}`
  const u = new URL(raw)
  // A bare IP or a :port is almost always plain http on a home network or a fresh server.
  if (!/^https?:\/\//i.test(given.trim()) && (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.port)) u.protocol = 'http:'
  return u.origin
}

/** Trades the code from Settings › Machines for this PC's own token. */
const pair = async (brain: string, code: string, name: string): Promise<Config> => {
  const r = await fetch(`${brain}/api/hands/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, platform: platformOf() }), signal: AbortSignal.timeout(15_000) })
  const body = (await r.json().catch(() => ({}))) as { machineId?: string; token?: string; error?: string }
  if (!r.ok || !body.token || !body.machineId) throw new Error(body.error ?? `The brain at ${brain} refused (${r.status}).`)
  return { brain, machineId: body.machineId, token: body.token, name, capabilities: [...CAPABILITIES] }
}

const main = async () => {
  const brainArg = arg('brain')
  const code = arg('code')
  let config = readConfig()
  if (brainArg && code) {
    const brain = brainBase(brainArg)
    log('info', `Pairing this PC with ${brain}…`)
    config = await pair(brain, code, arg('name') ?? hostname())
    saveConfig(config)
    log('info', `Paired as "${config.name}".`)
  }
  if (!config) {
    console.error('This PC is not paired with an Atlas yet. In Atlas: Settings › Machines › Add a machine, then run the command it shows (atlas connect <address> <code>).')
    process.exit(2)
  }
  if (process.argv.includes('--pair-only')) process.exit(0)
  run(config)
}

const run = (config: Config) => {
  writeFileSync(PID_FILE, String(process.pid))
  let ws: WebSocket | null = null
  let connected = false
  let active = false
  let ownerLocked = false
  let stopped = false
  let backoff = 1_000
  let askId = 1
  const asks = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  const send = (m: HandsMessage) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  }
  /** Asks the brain (a pairing ticket for the widget or the page). */
  const ask = (path: string) =>
    new Promise<string>((resolve, reject) => {
      if (!connected) return reject(new Error('Not connected to Atlas.'))
      const id = askId++
      const timer = setTimeout(() => {
        asks.delete(id)
        reject(new Error('Atlas did not answer.'))
      }, 15_000)
      asks.set(id, {
        resolve: v => {
          clearTimeout(timer)
          resolve(String(v))
        },
        reject: e => {
          clearTimeout(timer)
          reject(e)
        },
      })
      send({ t: 'ask', id, what: 'ticket', path })
    })

  /** The full page from the brain, paired at once by a one-time ticket, in the browser profile used for Atlas. */
  const showAtlas = () =>
    void ask('/')
      .then(ticket => {
        const url = `${config.brain}/#pair=${ticket}`
        if (!openInProfile(url, atlasProfile(config.brain, join(userData, 'cache')))) void shell.openExternal(url)
      })
      .catch(e => log('warn', `Could not open Atlas: ${(e as Error).message}`))

  const hands = createHands({
    dataDir: userData,
    appPath: app.getAppPath(),
    toRenderer: (ch, v) => send({ t: 'ev', ch, v }),
    note: note => send({ t: 'rt', note }),
    requireOwner: () => {
      if (ownerLocked) throw new Error('Please confirm it is you first.')
    },
    widgetUrl: async () => `${config.brain}/widget.html#pair=${await ask('/widget.html')}`,
    showAtlas,
    openExternal: url => void shell.openExternal(url),
    capabilities: config.capabilities,
    log,
  })

  const tray = new Tray({
    icon: join(app.getAppPath(), 'resources', 'tray.png'),
    onClick: id => {
      if (id === 'open') showAtlas()
      else if (id === 'reconnect') reconnectNow()
      else if (id === 'quit') quit()
    },
    onBalloonClick: showAtlas,
    // Lock, unlock and idle on this PC: the brain's owner check and briefings follow them.
    onSession: line => {
      powerMonitor.feed(line)
      send({ t: 'session', line })
    },
    log: (level, message) => log(level, message),
  })
  const host = new URL(config.brain).host
  const updateTray = () =>
    tray.setMenu(`Atlas: ${connected ? `connected to ${host}` : 'connecting…'}`, [
      { id: 'open', label: 'Open Atlas' },
      { label: connected ? `Connected to ${host}${active ? ' · Atlas works on this PC' : ''}` : `Connecting to ${host}…`, enabled: false },
      { separator: true },
      { id: 'reconnect', label: 'Reconnect now' },
      { id: 'quit', label: "Disconnect and quit Atlas's hands" },
    ])

  // What the brain asks of this PC besides the tools: show the page, a notice, an alarm.
  hands.handle(HANDS_OP.show, () => showAtlas())
  hands.handle(HANDS_OP.notify, (title, text) => tray.balloon(String(title ?? 'Atlas'), String(text ?? '')))
  hands.handle(HANDS_OP.alarm, () => tray.alarm())
  // The owner, in the brain's page, brings this PC's own Atlas data there (memory, settings; keys only when ticked).
  hands.handle(HANDS_OP.export, opts => {
    const keys = (opts as { keys?: unknown } | null)?.keys === true
    const bundle = exportBrainData(userData, config.name, keys ? osCredentialStore() : null)
    tray.balloon('Atlas data copied', `This PC's Atlas data${keys ? ' and API keys' : ''} went to ${host}.`)
    log('info', `Atlas data copied to ${config.brain} (${bundle.files.length} files${keys ? ', with keys' : ''}).`)
    return bundle
  })

  const onMessage = async (m: BrainMessage) => {
    switch (m.t) {
      case 'welcome':
        connected = true
        active = m.active
        backoff = 1_000
        log('info', `Connected to ${config.brain}${active ? ' (Atlas works on this PC)' : ''}.`)
        updateTray()
        return
      case 'active':
        active = m.on
        updateTray()
        return
      case 'owner':
        ownerLocked = m.locked
        return
      case 'ret': {
        const a = asks.get(m.id)
        if (!a) return
        asks.delete(m.id)
        if (m.ok) a.resolve(m.value)
        else a.reject(new Error(m.error ?? 'Refused.'))
        return
      }
      case 'call': {
        const fn = hands.handlers.get(m.ch)
        try {
          if (!fn) throw new Error('This PC cannot do that.')
          const [a, b, c, d] = m.args
          const value = await fn(a, b, c, d)
          if (m.id) send({ t: 'ret', id: m.id, ok: true, value: value === undefined ? null : value })
        } catch (e) {
          if (m.id) send({ t: 'ret', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) })
        }
        return
      }
    }
  }

  let retryTimer: NodeJS.Timeout | null = null
  const connect = () => {
    if (stopped) return
    const url = `${config.brain.replace(/^http/, 'ws')}${HANDS_PATH}`
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${config.token}` } } as unknown as string[])
    ws = socket
    socket.onopen = () => {
      send({ t: 'hello', v: HANDS_VERSION, name: config.name, platform: platformOf(), version: app.getVersion(), capabilities: config.capabilities, channels: [...hands.handlers.keys()] })
    }
    socket.onmessage = e => {
      try {
        void onMessage(JSON.parse(String(e.data)) as BrainMessage)
      } catch {
        // Not for us.
      }
    }
    socket.onclose = e => {
      if (ws !== socket) return
      ws = null
      const was = connected
      connected = false
      for (const a of asks.values()) a.reject(new Error('Disconnected from Atlas.'))
      asks.clear()
      updateTray()
      if (e.code === 4001) {
        log('error', 'Atlas removed this PC (Settings › Machines). Pair it again to reconnect.')
        rmSync(CONFIG, { force: true })
        return quit()
      }
      if (e.code === 4004) log('error', 'The brain runs another version of Atlas: update both to the same version.')
      if (was) log('warn', `Disconnected from ${config.brain}; trying again.`)
      retryTimer = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 30_000)
    }
    socket.onerror = () => undefined
  }
  const reconnectNow = () => {
    if (retryTimer) clearTimeout(retryTimer)
    backoff = 1_000
    if (ws) ws.close()
    else connect()
  }

  const quit = () => {
    if (stopped) return
    stopped = true
    // Closed on purpose: the brain knows this PC is still on, only without Atlas's hands.
    send({ t: 'session', line: 'quit' })
    hands.stop()
    tray.stop()
    ws?.close(1000)
    rmSync(PID_FILE, { force: true })
    setTimeout(() => process.exit(0), 300)
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, quit)
  process.on('message', m => {
    if ((m as { type?: unknown } | null)?.type === 'quit') quit()
  })
  process.on('unhandledRejection', e => log('error', `Unhandled: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`))

  setInterval(() => {
    if (!existsSync(STOP_FILE)) return
    rmSync(STOP_FILE, { force: true })
    quit()
  }, 1_000)

  tray.start()
  updateTray()
  hands.start()
  connect()
}

void main().catch(e => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
