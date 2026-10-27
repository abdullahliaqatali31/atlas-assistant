#!/usr/bin/env node
// atlas: start, open, stop and check the Atlas gateway on this PC.
//   atlas            start in the background (if needed) and open it in the browser
//   atlas run        run in this terminal (logs here; Ctrl+C stops)
//   atlas server     start as a server: the brain alone, reached from other machines (Linux, Docker)
//   atlas pair       a new code to pair a browser (on a server, where no app shows one)
//   atlas connect <address> <code> [--name "Work laptop"]
//                    this PC becomes Atlas's hands for a brain elsewhere (code from Settings › Machines)
//   atlas disconnect stop being Atlas's hands here (atlas connect again resumes)
//   atlas open       open the page in the default browser (paired at once)
//   atlas stop       stop Atlas
//   atlas status     is it running, where, which version
//   atlas logs       the last lines of the background log
//   atlas update     install the latest release if it is newer (--check: only say)
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'out', 'gateway', 'index.js')
const machineEntry = join(root, 'out', 'gateway', 'machine.js')
const dataDir =
  process.env.ATLAS_DATA_DIR ??
  (process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Personal Assistant')
    : process.platform === 'linux'
      ? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'atlas')
      : join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Personal Assistant'))
const handsLog = join(dataDir, 'logs', 'hands.log')
const handsPid = join(dataDir, 'hands.pid')
const stateFile = join(dataDir, 'gateway.json')
const logFile = join(dataDir, 'logs', 'gateway.log')
const nodeArgs = ['--disable-warning=ExperimentalWarning', entry]
// Where releases are published (owner/repo on GitHub).
const REPO = process.env.ATLAS_REPO ?? 'abdullahliaqatali31/atlas-assistant'

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

const start = async ({ open, server = false }) => {
  const s = await running()
  if (s) {
    if (open) await control(s, 'open')
    console.log(`Atlas is running: ${s.url}`)
    return
  }
  if (server) open = false
  if (!existsSync(entry)) throw new Error(existsSync(machineEntry) ? "Only Atlas's hands are installed here: atlas connect <address> <code> (from Settings › Machines). For the whole Atlas: npm install -g atlas-ai-assistant" : `Atlas is not built here (${entry} is missing).`)
  mkdirSync(dirname(logFile), { recursive: true })
  const out = openSync(logFile, 'a')
  // Flags for the gateway itself (--startup or --hidden from Windows' login entry) pass through.
  const passed = process.argv.slice(3).filter(a => a === '--startup' || a === '--hidden')
  const child = spawn(process.execPath, [...nodeArgs, ...passed, ...(open ? [] : ['--no-open']), ...(server ? ['--server'] : [])], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env: { ...process.env, ATLAS_ROOT: root } })
  child.unref()
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const up = await running()
    if (up) {
      console.log(`Atlas is running${server ? ' as a server' : ''}: ${up.url}${open ? ' (opening in your browser)' : ''}`)
      if (server) await pairCode(up)
      return
    }
  }
  throw new Error(`Atlas did not start; see ${logFile}`)
}

/** A new code for the next browser, printed (a server has no app to show one). */
const pairCode = async s => {
  const r = await fetch(`${s.url.replace('localhost', '127.0.0.1')}/api/control?action=code`, { method: 'POST', headers: { 'x-atlas-control': s.control }, signal: AbortSignal.timeout(5_000) })
  if (!r.ok) throw new Error(`Atlas refused (${r.status}).`)
  const { code } = await r.json()
  console.log(`Pair a browser: open this server's address (port ${new URL(s.url).port}) and enter ${code} (valid 10 minutes).`)
}

// ── this PC as Atlas's hands for a brain elsewhere ──────────

const handsStop = join(dataDir, 'hands.stop')

/**
 * Atlas's hands start with the PC once connected: a Run value on Windows (through the launcher, no
 * console window), a LaunchAgent on a Mac, an autostart entry on a Linux desktop. Disconnecting removes it.
 */
const handsAtLogin = on => {
  const node = process.execPath
  const cli = fileURLToPath(import.meta.url)
  try {
    if (process.platform === 'win32') {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      const vbs = join(root, 'bin', 'atlas-start.vbs')
      const cmd = existsSync(vbs) ? `wscript.exe "${vbs}" connect` : `"${node}" "${cli}" connect`
      if (on) spawnSync('reg.exe', ['add', key, '/v', 'Atlas hands', '/t', 'REG_SZ', '/d', cmd, '/f'], { windowsHide: true })
      else spawnSync('reg.exe', ['delete', key, '/v', 'Atlas hands', '/f'], { windowsHide: true, stdio: 'ignore' })
    } else if (process.platform === 'darwin') {
      const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.github.atlas-assistant.hands.plist')
      if (!on) return rmSync(plist, { force: true })
      mkdirSync(dirname(plist), { recursive: true })
      const x = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.github.atlas-assistant.hands</string>
  <key>ProgramArguments</key><array><string>${x(node)}</string><string>${x(cli)}</string><string>connect</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`)
    } else {
      const desktop = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', 'atlas-hands.desktop')
      if (!on) return rmSync(desktop, { force: true })
      mkdirSync(dirname(desktop), { recursive: true })
      writeFileSync(desktop, `[Desktop Entry]\nType=Application\nName=Atlas hands\nExec="${node}" "${cli}" connect\nX-GNOME-Autostart-enabled=true\n`)
    }
  } catch (e) {
    console.warn(`Could not ${on ? 'set' : 'remove'} the start at login: ${e instanceof Error ? e.message : e}`)
  }
}

/** Asks the running hands to close on purpose (the brain then knows this PC is still on), else ends them. */
const stopHands = async () => {
  const pid = handsRunning()
  if (!pid) return false
  writeFileSync(handsStop, String(Date.now()))
  for (let i = 0; i < 12 && handsRunning(); i++) await sleep(500)
  if (handsRunning()) process.kill(pid)
  rmSync(handsStop, { force: true })
  return true
}

const handsRunning = () => {
  try {
    const pid = Number(readFileSync(handsPid, 'utf8'))
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

const connect = async args => {
  if (!existsSync(machineEntry)) throw new Error(`Atlas is not built here (${machineEntry} is missing).`)
  const [address, code] = args.filter(a => !a.startsWith('--'))
  const nameAt = args.indexOf('--name')
  const name = nameAt >= 0 ? args[nameAt + 1] : undefined
  await stopHands()
  rmSync(handsStop, { force: true })
  mkdirSync(dirname(handsLog), { recursive: true })
  if (address && code) {
    // Pair in this terminal first, so a wrong code says so here.
    const pairArgs = ['--disable-warning=ExperimentalWarning', machineEntry, '--brain', address, '--code', code, '--pair-only', ...(name ? ['--name', name] : [])]
    const paired = spawn(process.execPath, pairArgs, { stdio: 'inherit', env: { ...process.env, ATLAS_ROOT: root } })
    const exit = await new Promise(res => paired.on('exit', res))
    if (exit !== 0) throw new Error('Not paired.')
  } else if (address || code) throw new Error('Usage: atlas connect <address> <code>   (both from Settings › Machines › Add a machine)')
  const out = openSync(handsLog, 'a')
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', machineEntry], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env: { ...process.env, ATLAS_ROOT: root } })
  child.unref()
  await sleep(2_500)
  const tail = existsSync(handsLog) ? readFileSync(handsLog, 'utf8').trim().split('\n').slice(-3).join('\n') : ''
  if (!handsRunning()) throw new Error(`Atlas's hands stopped:\n${tail}`)
  handsAtLogin(true)
  console.log(`This PC is now Atlas's hands: it reconnects by itself and starts with the PC. Log: ${handsLog}`)
}

const disconnect = async () => {
  handsAtLogin(false)
  if (!(await stopHands())) return console.log("Atlas's hands are not running on this PC (and no longer start with it).")
  console.log("Disconnected: Atlas's hands stopped on this PC and no longer start with it (atlas connect resumes).")
}

/** Is version a newer than b? ("0.10.0" > "0.4.1": numeric, part by part.) */
const newer = (a, b) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

/** Installed with npm (npm install -g atlas-ai-assistant): updated by npm, from the npm registry. */
const updateWithNpm = async ({ check, installed, name }) => {
  const r = await fetch(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(15_000) })
  if (!r.ok) throw new Error(`Could not ask npm for the latest ${name} (${r.status}).`)
  const latest = String((await r.json()).version ?? '')
  if (!latest || !newer(latest, installed)) return console.log(`Atlas ${installed} is up to date.`)
  if (check) return console.log(`Atlas ${latest} is available (you have ${installed}). Run: atlas update`)
  // npm replaces the files Atlas runs from: stop it first, start it again after.
  const s = await running()
  if (s) {
    await control(s, 'quit')
    for (let i = 0; i < 30 && (await running()); i++) await sleep(500)
  }
  console.log(`Updating Atlas ${installed} to ${latest}...`)
  const child = spawn('npm', ['install', '-g', `${name}@${latest}`], { stdio: 'inherit', shell: true })
  const code = await new Promise(res => child.on('exit', res))
  if (code !== 0) throw new Error(`npm could not update Atlas. Try: npm install -g ${name}@latest`)
  if (s) spawn(process.execPath, [fileURLToPath(import.meta.url), 'start', '--no-open'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

const update = async ({ check }) => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const installed = pkg.version
  if (root.split(/[\\/]/).includes('node_modules')) return updateWithNpm({ check, installed, name: pkg.name })
  if (process.platform === 'darwin') throw new Error('On a Mac, Atlas installs and updates with npm: npm install -g atlas-ai-assistant')
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
      await start({ open: !process.argv.includes('--no-open') && !process.argv.includes('--hidden'), server: process.argv.includes('--server') })
      break
    case 'server':
      await start({ open: false, server: true })
      break
    case 'pair': {
      const s = await running()
      if (!s) throw new Error('Atlas is not running (atlas server starts it).')
      await pairCode(s)
      break
    }
    case 'connect':
      await connect(process.argv.slice(3))
      break
    case 'disconnect':
      await disconnect()
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
      console.log(s ? `Atlas ${s.version} is running${s.server ? ' as a server' : ''} at ${s.url} (pid ${s.pid}, since ${s.started}).` : 'Atlas is not running.')
      if (handsRunning()) console.log(`This PC is Atlas's hands for a brain elsewhere (log: ${handsLog}).`)
      break
    }
    case 'update':
      await update({ check: process.argv.includes('--check') })
      break
    case 'logs':
      console.log(existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').slice(-60).join('\n') : 'No log yet.')
      break
    default:
      console.log('Usage: atlas [start|run|open|stop|status|logs|update|server|pair|connect|disconnect]')
      process.exitCode = 1
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
}
