// Packs a built Atlas (`pnpm build` first) into release/atlas-<version>-win-x64.zip:
// the gateway and its page, the tray icon, the atlas command, the installer,
// and a package.json naming the few modules installed on the PC (native or large).
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
cpSync(join(root, 'bin'), join(out, 'bin'), { recursive: true })
cpSync(join(root, '..', '..', 'install.ps1'), join(out, 'install.ps1'))
for (const f of ['LICENSE', 'NOTICE']) if (existsSync(join(root, '..', '..', f))) cpSync(join(root, '..', '..', f), join(out, f))

// Only what the gateway loads from node_modules at run time; everything else is inside the bundle.
const exact = dep => JSON.parse(readFileSync(join(root, 'node_modules', dep, 'package.json'), 'utf8')).version
writeFileSync(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'atlas-assistant',
      version,
      private: true,
      type: 'module',
      description: 'Atlas, a personal assistant on your PC with a web interface.',
      license: pkg.license,
      bin: { atlas: 'bin/atlas.mjs' },
      engines: { node: '>=22.13' },
      dependencies: { '@napi-rs/keyring': exact('@napi-rs/keyring'), 'playwright-core': exact('playwright-core') },
    },
    null,
    2,
  )}\n`,
)

execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`], { stdio: 'inherit' })
console.log(`Packed ${zip}`)
