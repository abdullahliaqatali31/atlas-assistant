/**
 * Renders resources/icon.svg into the app's raster icons.
 *   pnpm --filter @assistant/desktop icons
 * Outputs: resources/icon.png (512), resources/tray.png (32) + tray@2x.png (64),
 * build/icon.ico (16–256, for the Windows installer and taskbar).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'resources/icon.svg'))

const render = size => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng())

mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'resources/icon.png'), render(512))
writeFileSync(join(root, 'resources/tray.png'), render(32))
writeFileSync(join(root, 'resources/tray@2x.png'), render(64))
const ico = await pngToIco([16, 24, 32, 48, 64, 128, 256].map(render))
writeFileSync(join(root, 'build/icon.ico'), ico)
console.log('icons written: resources/icon.png, resources/tray.png, resources/tray@2x.png, build/icon.ico')
