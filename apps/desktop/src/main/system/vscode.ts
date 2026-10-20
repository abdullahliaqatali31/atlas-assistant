/**
 * Opening a folder in VS Code without closing what is open: VS Code's own
 * command with --new-window gives each project its own window (a project that
 * is already open is just brought forward). The vscode:// link reuses the
 * last window, replacing its project, so it is only the fallback when the
 * command cannot be found.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { shell } from 'electron'

import { vscodeLink } from '../../shared/pcactions.ts'

let found: string | null | undefined

/** Where VS Code's command is (user install, system install, Insiders), or null. */
const codeCommand = (): string | null => {
  if (found !== undefined) return found
  const local = process.env.LOCALAPPDATA ?? ''
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  const candidates = [
    join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    join(pf, 'Microsoft VS Code', 'bin', 'code.cmd'),
    join(local, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'),
  ]
  found = candidates.find(c => existsSync(c)) ?? null
  return found
}

/** Opens a folder or file in its own VS Code window; WSL folders through Remote - WSL. */
export const openInVsCode = async (path: string, wsl: string | null): Promise<void> => {
  const cmd = codeCommand()
  if (!cmd) return void (await shell.openExternal(vscodeLink(path, wsl)))
  const args = wsl ? ['--new-window', '--remote', `wsl+${wsl}`, path] : ['--new-window', path]
  // code.cmd is a batch file: run it through cmd, with Atlas's own Electron settings kept out of it.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise<void>((resolve, reject) => {
    // cmd /s drops the outermost quotes: the whole line is quoted once more, each part inside it too.
    const line = `""${cmd}" ${args.map(x => `"${x}"`).join(' ')}"`
    const child = execFile('cmd.exe', ['/d', '/s', '/c', line], { windowsHide: true, env, windowsVerbatimArguments: true }, err => (err ? reject(err) : resolve()))
    child.on('error', reject)
  }).catch(async () => {
    await shell.openExternal(vscodeLink(path, wsl))
  })
}
