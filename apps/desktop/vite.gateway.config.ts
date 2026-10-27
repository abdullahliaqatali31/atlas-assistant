import { resolve } from 'node:path'

import { defineConfig } from 'vite'

/**
 * The gateway: one Node bundle (and the runtime it supervises) with the
 * workspace packages inside. Native addons and Playwright load from
 * node_modules at run time.
 */
export default defineConfig({
  build: {
    ssr: true,
    outDir: resolve('out/gateway'),
    emptyOutDir: true,
    target: 'node22',
    sourcemap: true,
    rollupOptions: {
      input: { index: resolve('src/gateway/index.ts'), runtime: resolve('src/runtime/host.ts'), machine: resolve('src/gateway/machine.ts') },
      output: { format: 'es', entryFileNames: '[name].js' },
      external: ['@napi-rs/keyring', 'sherpa-onnx-node', 'playwright-core', '@huggingface/transformers'],
    },
  },
  ssr: { noExternal: true, external: ['@napi-rs/keyring', 'sherpa-onnx-node', 'playwright-core', '@huggingface/transformers'] },
})
