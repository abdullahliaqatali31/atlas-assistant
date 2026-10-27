// Packs a built Atlas (`pnpm build` first) into release/atlas-<version>-win-x64.zip:
// the gateway and its page, the tray icon, the atlas command, the installer,
// and a package.json naming the few modules installed on the PC (native or large).
// The same folder is the npm package (npm install -g atlas-ai-assistant).
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const name = `atlas-${version}-win-x64`
const out = join(root, 'release', name)
const zip = join(root, 'release', `${name}.zip`)

for (const need of ['out/gateway/index.js', 'out/gateway/runtime.js', 'out/renderer/index.html']) {
  if (!existsSync(join(root, need))) throw new Error(`${need} is missing: run pnpm build first.`)
}
rmSync(out, { recursive: true, force: true })
rmSync(zip, { force: true })
mkdirSync(out, { recursive: true })

// No source maps in a release.
cpSync(join(root, 'out'), join(out, 'out'), { recursive: true, filter: f => !f.endsWith('.map') })
mkdirSync(join(out, 'resources'))
for (const f of ['tray.png', 'tray@2x.png', 'icon.png']) cpSync(join(root, 'resources', f), join(out, 'resources', f))
// The desktop widget's window on Windows (Microsoft's WebView2 SDK, with its licence).
cpSync(join(root, 'resources', 'webview2'), join(out, 'resources', 'webview2'), { recursive: true })
cpSync(join(root, 'bin'), join(out, 'bin'), { recursive: true })
cpSync(join(root, '..', '..', 'install.ps1'), join(out, 'install.ps1'))
if (existsSync(join(root, '..', '..', 'install.sh'))) cpSync(join(root, '..', '..', 'install.sh'), join(out, 'install.sh'))
for (const f of ['LICENSE', 'NOTICE']) if (existsSync(join(root, '..', '..', f))) cpSync(join(root, '..', '..', f), join(out, f))

// The README for npmjs.com: its pictures and links point at GitHub (relative ones do not resolve there).
const REPO = 'abdullahliaqatali31/atlas-assistant'
const readme = readFileSync(join(root, '..', '..', 'README.md'), 'utf8')
  .replace(/(src="|\]\()docs\/images\//g, `$1https://raw.githubusercontent.com/${REPO}/main/docs/images/`)
  .replace(/\]\((?!https?:|#)([^)]+)\)/g, `](https://github.com/${REPO}/blob/main/$1)`)
writeFileSync(join(out, 'README.md'), readme)

// Only what the gateway loads from node_modules at run time; everything else is inside the bundle.
const exact = dep => JSON.parse(readFileSync(join(root, 'node_modules', dep, 'package.json'), 'utf8')).version
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'atlas-ai-assistant',
      version,
      type: 'module',
      description: 'A personal AI assistant that remembers your work, speaks up when it matters, and acts only with your yes. Runs on your PC or on a server (Linux, Docker); your PCs connect to it as its hands. Opens in your browser.',
      license: pkg.license,
      homepage: `https://github.com/${REPO}#readme`,
      repository: { type: 'git', url: `git+https://github.com/${REPO}.git` },
      bugs: { url: `https://github.com/${REPO}/issues` },
      keywords: ['assistant', 'ai', 'voice', 'memory', 'windows', 'macos', 'linux', 'self-hosted', 'server', 'agent', 'llm', 'claude', 'openai', 'urdu', 'mcp'],
      // Two names for the one command: `atlas`, and a longer one if another tool already owns `atlas`.
      bin: { atlas: 'bin/atlas.mjs', 'atlas-ai-assistant': 'bin/atlas.mjs' },
      os: ['win32', 'darwin', 'linux'],
      engines: { node: '>=22.13' },
      dependencies: { '@napi-rs/keyring': exact('@napi-rs/keyring'), 'playwright-core': exact('playwright-core'), 'sherpa-onnx-node': exact('sherpa-onnx-node'), '@huggingface/transformers': exact('@huggingface/transformers') },
    },
    null,
    2,
  )}\n`,
)

if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`], { stdio: 'inherit' })
else execFileSync('zip', ['-qr', zip, '.'], { cwd: out, stdio: 'inherit' })
console.log(`Packed ${zip}`)
