import { cpSync, createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * CesiumJS (the 3D World view) loads its workers, assets and widget styles
 * at run time from CESIUM_BASE_URL. Served from node_modules in development
 * and copied next to the page in a build, under ./cesium/.
 */
const CESIUM_DIR = resolve('node_modules/cesium/Build/Cesium')
const MIME: Record<string, string> = { '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2' }

const cesiumStatic = (): Plugin => {
  let outDir = ''
  return {
    name: 'atlas-cesium-static',
    configResolved: config => {
      outDir = resolve(config.root, config.build.outDir)
    },
    configureServer: server => {
      server.middlewares.use('/cesium', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]!)
        const file = join(CESIUM_DIR, rel)
        if (!file.startsWith(CESIUM_DIR) || !existsSync(file) || statSync(file).isDirectory()) return next()
        res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
    closeBundle: () => {
      for (const dir of ['Workers', 'ThirdParty', 'Assets', 'Widgets']) cpSync(join(CESIUM_DIR, dir), join(outDir, 'cesium', dir), { recursive: true })
    },
  }
}

/** The page Atlas serves to the owner's browser (the gateway's build is vite.gateway.config.ts). */
export default defineConfig({
  root: resolve('src/renderer'),
  base: '/',
  build: { outDir: resolve('out/renderer'), emptyOutDir: true, chunkSizeWarningLimit: 16_000 },
  plugins: [react(), tailwindcss(), cesiumStatic()],
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  // Lazy pages (3D view, on-device speech) import these late: bundle them up front in dev, or the late re-bundle leaves two copies of React.
  optimizeDeps: { include: ['@cesium/engine', '@cesium/core', '@huggingface/transformers'] },
  // satellite.js ships an optional WebAssembly worker that uses top-level await: bundle workers as ES modules.
  worker: { format: 'es' },
})
