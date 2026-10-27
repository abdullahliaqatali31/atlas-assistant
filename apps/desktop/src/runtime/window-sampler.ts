/**
 * Windows foreground-window sampler for opt-in activity tracking. One
 * long-lived, hidden PowerShell process polls GetForegroundWindow every two
 * seconds and prints a JSON line only when the app or title changes, so the
 * idle cost is a sleeping process rather than a spawn per sample. It reads
 * the window title and process name only: no screenshots, no input hooks.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

import type { WindowSample } from '@assistant/runtime'

const POLL_SECONDS = 2

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class PaForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$last = ''
while ($true) {
  $h = [PaForeground]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][PaForeground]::GetWindowText($h, $sb, 512)
  $owner = [uint32]0
  [void][PaForeground]::GetWindowThreadProcessId($h, [ref]$owner)
  $name = ''
  if ($owner -ne 0) { $name = (Get-Process -Id $owner).ProcessName }
  $line = @{ app = [string]$name; title = $sb.ToString() } | ConvertTo-Json -Compress
  if ($line -ne $last) { [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $last = $line }
  Start-Sleep -Seconds ${POLL_SECONDS}
}
`

/** Parses one sampler line; anything malformed is dropped. */
export const parseSampleLine = (line: string): WindowSample | null => {
  try {
    const v = JSON.parse(line) as unknown
    if (typeof v !== 'object' || v === null) return null
    const { app, title } = v as Record<string, unknown>
    return typeof app === 'string' && typeof title === 'string' ? { app, title } : null
  } catch {
    return null
  }
}

export interface Sampler {
  stop(): void
}

/** Starts sampling; null where foreground sampling is not supported (non-Windows). */
export const startWindowSampler = (onSample: (s: WindowSample) => void, onError: (message: string) => void): Sampler | null => {
  if (process.platform !== 'win32') return null
  let stopped = false
  let child: ChildProcess | null = null
  let restarts = 0

  const run = () => {
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    child = proc
    createInterface({ input: proc.stdout! }).on('line', line => {
      const s = parseSampleLine(line)
      if (s) onSample(s)
    })
    proc.on('error', error => onError(`Window sampler failed: ${error.message}`))
    proc.on('exit', code => {
      if (stopped) return
      // A crash restarts a few times, then gives up rather than spinning.
      if (restarts++ < 3) setTimeout(run, 5_000).unref()
      else onError(`Window sampler stopped (exit ${code}); activity tracking is paused until the app restarts.`)
    })
  }
  run()

  return {
    stop() {
      stopped = true
      child?.kill()
    },
  }
}
