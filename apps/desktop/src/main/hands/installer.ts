/**
 * The brain installs its own hands: Settings › Machines shows one line for a
 * PC, filled in with this brain's address and the pairing code, and that line
 * fetches its script from here. The script brings Node.js if it is missing,
 * installs Atlas's hands from this brain (the same version as the brain, so
 * the two always speak the same protocol), connects, and makes the hands
 * start with the PC. No GitHub release and no npm registry are needed.
 *
 *   Windows:      irm "https://atlas.example.com/hands/install.ps1?code=ABCD-EFGH" | iex
 *   macOS, Linux: curl -fsSL "https://atlas.example.com/hands/install.sh?code=ABCD-EFGH" | sh
 *
 * The package holds only the hands: the atlas command, machine.js and its
 * chunks, the tray icon and the widget's WebView2 files. No data and no keys.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { gzipSync } from 'node:zlib'

/** A tar archive (ustar), enough for npm: files only, every one under package/. */
export const tar = (files: { name: string; data: Buffer; mode?: number }[]): Buffer => {
  const blocks: Buffer[] = []
  const octal = (n: number, len: number) => `${n.toString(8).padStart(len - 1, '0')}\0`
  for (const f of files) {
    let name = `package/${f.name}`
    let prefix = ''
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf('/', 154)
      prefix = name.slice(0, cut)
      name = name.slice(cut + 1)
      if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`Path too long for the package: ${f.name}`)
    }
    const h = Buffer.alloc(512)
    h.write(name, 0, 100)
    h.write(octal(f.mode ?? 0o644, 8), 100, 8)
    h.write(octal(0, 8), 108, 8)
    h.write(octal(0, 8), 116, 8)
    h.write(octal(f.data.length, 12), 124, 12)
    h.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12)
    h.write('        ', 148, 8)
    h.write('0', 156, 1)
    h.write('ustar\0', 257, 6)
    h.write('00', 263, 2)
    h.write(prefix, 345, 155)
    let sum = 0
    for (const b of h) sum += b
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
    blocks.push(h, f.data)
    const pad = (512 - (f.data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

const walk = (dir: string, out: string[]) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
}

let cached: { root: string; data: Buffer } | null = null

/** The hands package (npm tarball) from this brain's own installed files. */
export const handsPackage = (root: string): Buffer => {
  if (cached?.root === root) return cached.data
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  const machine = join(root, 'out', 'gateway', 'machine.js')
  if (!existsSync(machine)) throw new Error('This Atlas has no hands to hand out (out/gateway/machine.js is missing).')
  const files: { name: string; data: Buffer; mode?: number }[] = []
  const add = (abs: string, mode?: number) => files.push({ name: relative(root, abs).split(sep).join('/'), data: readFileSync(abs), mode })
  add(machine)
  for (const f of readdirSync(join(root, 'out', 'gateway', 'assets'))) if (f.endsWith('.js')) add(join(root, 'out', 'gateway', 'assets', f))
  add(join(root, 'bin', 'atlas.mjs'), 0o755)
  if (existsSync(join(root, 'bin', 'atlas-start.vbs'))) add(join(root, 'bin', 'atlas-start.vbs'))
  for (const f of ['tray.png', 'tray@2x.png', 'icon.png']) if (existsSync(join(root, 'resources', f))) add(join(root, 'resources', f))
  // The desktop widget's window on Windows (Microsoft's WebView2 SDK, with its licence).
  const wv2 = join(root, 'resources', 'webview2')
  if (existsSync(wv2)) {
    const all: string[] = []
    walk(wv2, all)
    for (const p of all) add(p)
  }
  for (const f of ['LICENSE', 'NOTICE']) for (const at of [join(root, f), join(root, '..', '..', f)]) if (existsSync(at)) {
    files.push({ name: f, data: readFileSync(at) })
    break
  }
  const keyring = pkg.dependencies?.['@napi-rs/keyring'] ?? pkg.devDependencies?.['@napi-rs/keyring'] ?? '^2.1.1'
  const manifest = {
    name: 'atlas-ai-assistant',
    version: pkg.version,
    type: 'module',
    description: "Atlas's hands: this PC working for an Atlas that runs elsewhere (atlas connect).",
    license: 'Apache-2.0',
    bin: { atlas: 'bin/atlas.mjs', 'atlas-ai-assistant': 'bin/atlas.mjs' },
    engines: { node: '>=22.13' },
    dependencies: { '@napi-rs/keyring': keyring },
  }
  files.unshift({ name: 'package.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) })
  cached = { root, data: gzipSync(tar(files), { level: 9 }) }
  return cached.data
}

/** A pairing code as the page shows it: letters, digits and a dash only (it goes inside a script). */
export const cleanCode = (code: string | null) => (code && /^[A-Za-z0-9-]{4,20}$/.test(code) ? code.toUpperCase() : null)

/** The one-line installer for a PC, with this brain's address and the code filled in. */
export const installScript = (kind: 'ps1' | 'sh', brain: string, code: string): string => {
  if (!/^https?:\/\/[\w.:[\]-]+$/.test(brain)) throw new Error('Unusual address.')
  if (kind === 'ps1')
    return `# Atlas's hands on this PC, for the Atlas at ${brain}.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Brain = '${brain}'
$Code = '${code}'
function Say($t) { Write-Host "  $t" -ForegroundColor Cyan }
function NodeOk { try { $v = (& node --version) 2>$null; if ($v -match '^v(\\d+)\\.(\\d+)') { return ([int]$Matches[1] -gt 22) -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -ge 13) } } catch {}; return $false }
if (-not (NodeOk)) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'Atlas needs Node.js 22.13 or newer: install it from https://nodejs.org, then run this line again.' }
  Say 'Installing Node.js (LTS)...'
  winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements | Out-Null
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (NodeOk)) { throw 'Node.js did not install: install it from https://nodejs.org, then run this line again.' }
}
Say "Installing Atlas's hands from $Brain..."
& npm install -g "$Brain/hands/atlas-hands.tgz" --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { throw 'npm could not install Atlas from that address.' }
$cli = Join-Path (& npm root -g) 'atlas-ai-assistant\\bin\\atlas.mjs'
& node $cli connect $Brain $Code
if ($LASTEXITCODE -ne 0) { throw 'Not connected: make a new code in Settings > Machines and run the new line.' }
Write-Host ''
Write-Host "  Done: this PC is Atlas's hands. It starts with Windows; 'atlas disconnect' stops it." -ForegroundColor Green
`
  return `#!/bin/sh
# Atlas's hands on this machine, for the Atlas at ${brain}.
set -eu
BRAIN='${brain}'
CODE='${code}'
say() { printf '  \\033[36m%s\\033[0m\\n' "$1"; }
fail() { printf '  \\033[31m%s\\033[0m\\n' "$1" >&2; exit 1; }
node_ok() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
if ! node_ok; then
  if [ "$(uname -s)" = "Darwin" ]; then
    command -v brew >/dev/null 2>&1 || fail "Atlas needs Node.js 22.13 or newer: install it from https://nodejs.org (or Homebrew), then run this line again."
    say "Installing Node.js with Homebrew..."; brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    say "Installing Node.js 22..."; curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E sh - >/dev/null; $SUDO apt-get install -y nodejs >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    say "Installing Node.js 22..."; curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO sh - >/dev/null; $SUDO dnf install -y nodejs >/dev/null
  else
    fail "Atlas needs Node.js 22.13 or newer: install it from https://nodejs.org, then run this line again."
  fi
  node_ok || fail "Node.js did not install."
fi
# In your own folder: no administrator password needed.
PREFIX="$HOME/.atlas"
say "Installing Atlas's hands from $BRAIN..."
npm install -g --prefix "$PREFIX" "$BRAIN/hands/atlas-hands.tgz" --no-audit --no-fund --loglevel=error
node "$PREFIX/lib/node_modules/atlas-ai-assistant/bin/atlas.mjs" connect "$BRAIN" "$CODE"
printf '\\n  \\033[32mDone: this machine is Atlas'"'"'s hands. It starts with it; %s disconnect stops it.\\033[0m\\n' "$PREFIX/bin/atlas"
`
}
