// After `vite build`: a gzip copy beside each text-like file of the page
// (scripts, styles, wasm, JSON, SVG), served instead of the file when the
// browser takes gzip. Browsers offer brotli only over HTTPS, and Atlas is
// served over plain http on this PC or the home network, so gzip it is.
import { createReadStream, createWriteStream, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { constants, createGzip } from 'node:zlib'

const root = resolve(import.meta.dirname, '..', 'out', 'renderer')
const KINDS = /\.(js|mjs|css|html|json|wasm|svg|xml|txt)$/i
const MIN = 1024

const files = []
const walk = dir => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (KINDS.test(e.name) && statSync(p).size >= MIN) files.push(p)
  }
}
walk(root)

let before = 0
let after = 0
for (const f of files) {
  const gz = `${f}.gz`
  const src = statSync(f)
  let done = null
  try {
    done = statSync(gz)
  } catch {
    // Not yet.
  }
  if (!done || done.mtimeMs < src.mtimeMs) await pipeline(createReadStream(f), createGzip({ level: constants.Z_BEST_COMPRESSION }), createWriteStream(gz))
  before += src.size
  after += statSync(gz).size
}
console.log(`Compressed ${files.length} files: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB (gzip)`)
