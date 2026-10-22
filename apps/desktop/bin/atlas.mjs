#!/usr/bin/env node
// atlas: start, open, stop and check the Atlas gateway on this PC.
//   atlas            start in the background (if needed) and open it in the browser
//   atlas run        run in this terminal (logs here; Ctrl+C stops)
//   atlas open       open the page in the default browser (paired at once)
//   atlas stop       stop Atlas
//   atlas status     is it running, where, which version
//   atlas logs       the last lines of the background log
//   atlas update     install the latest release if it is newer (--check: only say)
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'out', 'gateway', 'index.js')
const dataDir = process.env.ATLAS_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Personal Assistant')
const stateFile = join(dataDir, 'gateway.json')
const logFile = join(dataDir, 'logs', 'gateway.log')
const nodeArgs = ['--disable-warning=ExperimentalWarning', entry]
// Where releases are published (owner/repo on GitHub).
const REPO = process.env.ATLAS_REPO ?? 'OWNER/atlas'

const state = () => {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return null
  }
}

/** The running gateway's state, if it answers. */
const running = async () => {
  const s = state()
  if (!s?.url) return null
  try {
    const r = await fetch(`${s.url.replace('localhost', '127.0.0.1')}/api/me`, { signal: AbortSignal.timeout(2_000) })
    return r.ok ? s : null
  } catch {
    return null
  }
}

const control = async (s, action) => {
  const r = await fetch(`${s.url.replace('localhost', '127.0.0.1')}/api/control?action=${action}`, { method: 'POST', headers: { 'x-atlas-control': s.control }, signal: AbortSignal.timeout(5_000) })
  if (!r.ok) throw new Error(`Atlas refused (${r.status}).`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const start = async ({ open }) => {
  const s = await running()
  if (s) {
    if (open) await control(s, 'open')
    console.log(`Atlas is running: ${s.url}`)
    return
  }
  if (!existsSync(entry)) throw new Error(`Atlas is not built here (${entry} is missing).`)
  mkdirSync(dirname(logFile), { recursive: true })
  const out = openSync(logFile, 'a')
  // Flags for the gateway itself (--startup or --hidden from Windows' login entry) pass through.
  const passed = process.argv.slice(3).filter(a => a === '--startup' || a === '--hidden')
  const child = spawn(process.execPath, [...nodeArgs, ...passed, ...(open ? [] : ['--no-open'])], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env: { ...process.env, ATLAS_ROOT: root } })
  child.unref()
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const up = await running()
    if (up) return console.log(`Atlas is running: ${up.url}${open ? ' (opening in your browser)' : ''}`)
  }
  throw new Error(`Atlas did not start; see ${logFile}`)
}

/** Is version a newer than b? ("0.10.0" > "0.4.1": numeric, part by part.) */
const newer = (a, b) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

const update = async ({ check }) => {
  const installed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`Could not ask GitHub for the latest release of ${REPO} (${r.status}).`)
  const release = await r.json()
  const latest = String(release.tag_name ?? '').replace(/^v/, '')
  const asset = (release.assets ?? []).find(a => a.name === 'atlas-win-x64.zip')
  if (!latest || !asset) throw new Error('The latest release has no Atlas zip.')
  if (!newer(latest, installed)) return console.log(`Atlas ${installed} is up to date.`)
  if (check) return console.log(`Atlas ${latest} is available (you have ${installed}). Run: atlas update`)
  const installer = join(root, 'install.ps1')
  if (!existsSync(installer)) throw new Error('install.ps1 is missing here; download the release and run its install.ps1.')
  // The installer replaces this folder, so it runs from a copy.
  const copy = join(tmpdir(), `atlas-install-${process.pid}.ps1`)
  copyFileSync(installer, copy)
  console.log(`Updating Atlas ${installed} to ${latest}...`)
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', copy, '-From', asset.browser_download_url], { stdio: 'inherit' })
  const code = await new Promise(res => child.on('exit', res))
  if (code !== 0) throw new Error('The update did not finish. Run the release install.ps1 again to repair it.')
}

const [cmd = 'start'] = process.argv.slice(2)
try {
  switch (cmd) {
    case 'start':
      await start({ open: !process.argv.includes('--no-open') && !process.argv.includes('--hidden') })
      break
    case 'run': {
      const child = spawn(process.execPath, [...nodeArgs, ...process.argv.slice(3)], { stdio: 'inherit', env: { ...process.env, ATLAS_ROOT: root } })
      child.on('exit', code => process.exit(code ?? 0))
      break
    }
    case 'open': {
      const s = await running()
      if (s) await control(s, 'open')
      else await start({ open: true })
      break
    }
    case 'stop': {
      const s = await running()
      if (!s) {
        console.log('Atlas is not running.')
        break
      }
      await control(s, 'quit')
      for (let i = 0; i < 30 && (await running()); i++) await sleep(500)
      console.log('Atlas stopped.')
      break
    }
    case 'status': {
      const s = await running()
      console.log(s ? `Atlas ${s.version} is running at ${s.url} (pid ${s.pid}, since ${s.started}).` : 'Atlas is not running.')
      break
    }
    case 'update':
      await update({ check: process.argv.includes('--check') })
      break
    case 'logs':
      console.log(existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').slice(-60).join('\n') : 'No log yet.')
      break
    default:
      console.log('Usage: atlas [start|run|open|stop|status|logs|update]')
      process.exitCode = 1
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
}
