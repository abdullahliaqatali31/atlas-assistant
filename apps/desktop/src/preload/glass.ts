/**
 * The glass panel's bridge: the view to show in, and close / back / open a
 * story / open a link out. Nothing else from Atlas is reachable from it.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { GlassAlign, GlassBridge, GlassView, GLS } from '../shared/glass.ts'

// Written out so this sandboxed preload stays one file; the type keeps them equal to GLS.
const CH: { readonly [K in keyof typeof GLS]: (typeof GLS)[K] } = {
  view: 'glass:view',
  close: 'glass:close',
  back: 'glass:back',
  story: 'glass:story',
  openLink: 'glass:open-link',
  openFile: 'glass:open-file',
  revealFile: 'glass:reveal-file',
  hit: 'glass:hit',
  world: 'glass:world',
}

const bridge: GlassBridge = {
  onView: cb => {
    const listener = (_e: IpcRendererEvent, p: { view: GlassView | null; align: GlassAlign }) => cb(p.view, p.align)
    ipcRenderer.on(CH.view, listener)
    return () => void ipcRenderer.removeListener(CH.view, listener)
  },
  close: () => ipcRenderer.invoke(CH.close),
  back: () => ipcRenderer.invoke(CH.back),
  story: n => ipcRenderer.invoke(CH.story, n),
  openLink: url => ipcRenderer.invoke(CH.openLink, url),
  openFile: path => ipcRenderer.invoke(CH.openFile, path),
  revealFile: path => ipcRenderer.invoke(CH.revealFile, path),
  hit: solid => ipcRenderer.send(CH.hit, solid === true),
  world: ((kind: string, box?: unknown) => ipcRenderer.invoke(CH.world, kind, box)) as GlassBridge['world'],
}

contextBridge.exposeInMainWorld('glass', bridge)
