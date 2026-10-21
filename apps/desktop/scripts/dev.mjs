// Development: the page from Vite's dev server (instant updates), the gateway
// rebuilt on every change and restarted. `pnpm dev` from the repo root.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

import { build, createServer } from 'vite'

const root = resolve(import.meta.dirname, '..')
const page = await createServer({ configFile: resolve(root, 'vite.config.ts') })
await page.listen()
const pageUrl = `http://127.0.0.1:${page.config.server.port}`
console.log(`[dev] page from ${pageUrl}`)

let child = null
let started = false
/** Asks the gateway to quit (Windows has no gentle signals: a message over its IPC channel), then waits. */
const stopChild = () =>
  new Promise(r => {
    const old = child
    child = null
    if (!old || old.exitCode !== null) return r()
    old.once('exit', r)
    if (old.connected) old.send({ type: 'quit' })
    setTimeout(() => old.kill(), 8_000)
  })

const start = () => {
  // Only the first start opens the browser; restarts after a rebuild reconnect the page already open.
  const args = started ? [...process.argv.slice(2), '--no-open'] : process.argv.slice(2)
  started = true
  child = spawn(process.execPath, ['--enable-source-maps', '--disable-warning=ExperimentalWarning', resolve(root, 'out/gateway/index.js'), ...args], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, ATLAS_DEV: '1', ATLAS_RENDERER_URL: pageUrl, ATLAS_ROOT: root },
  })
}

// A burst of rebuilds restarts once, a moment after the last.
let timer = null
let chain = Promise.resolve()
const restart = () => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    chain = chain.then(async () => {
      await stopChild()
      console.log('[dev] gateway built; starting')
      start()
    })
  }, 400)
}

// Old chunks stay on disk, so a gateway still running can finish what it was loading.
const watcher = await build({ configFile: resolve(root, 'vite.gateway.config.ts'), mode: 'development', logLevel: 'warn', build: { watch: {}, emptyOutDir: false } })
// A build that failed keeps the gateway that is running (no restart onto old files).
let failed = false
watcher.on('event', e => {
  if (e.code === 'START') failed = false
  else if (e.code === 'ERROR') {
    failed = true
    console.error('[dev] build failed:', e.error?.message)
  } else if (e.code === 'END' && !failed) restart()
})

const quit = async () => {
  clearTimeout(timer)
  await watcher.close()
  await stopChild()
  await page.close()
  process.exit(0)
}
process.on('SIGINT', quit)
process.on('SIGTERM', quit)
