import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Workspace packages ship TypeScript source, so main, preload and the runtime
// host are bundled whole; only Electron, Node built-ins and native addons stay external.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          runtime: resolve('src/runtime/host.ts'),
        },
        // Native addon: loaded from node_modules at run time, not bundled.
        external: ['@napi-rs/keyring'],
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts'), presence: resolve('src/preload/presence.ts'), glass: resolve('src/preload/glass.ts') },
        // Sandboxed preloads must be a single CommonJS file.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html'), presence: resolve('src/renderer/presence.html'), glass: resolve('src/renderer/glass.html') } } },
    plugins: [react(), tailwindcss()],
    // satellite.js ships an optional WebAssembly worker that uses top-level await: bundle workers as ES modules.
    worker: { format: 'es' },
  },
})
