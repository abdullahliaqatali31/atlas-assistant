/**
 * The only bridge from the sandboxed renderer: a handful of named calls, no
 * raw ipcRenderer, no Node. Payloads are validated again in main. The bridges
 * themselves live in shared/bridges.ts, shared with the web interface.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import { buildBridges, type Transport } from '../shared/bridges.ts'

const ipc: Transport = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, payload) => ipcRenderer.send(channel, payload),
  on: <T>(channel: string, cb: (v: T) => void) => {
    const listener = (_e: IpcRendererEvent, v: T) => cb(v)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
}

for (const [name, bridge] of Object.entries(buildBridges(ipc))) contextBridge.exposeInMainWorld(name, bridge)
