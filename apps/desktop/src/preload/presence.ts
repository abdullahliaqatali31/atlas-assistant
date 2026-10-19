/**
 * The desktop widget's bridge: its state in, and a handful of commands out.
 * Nothing else from Atlas is reachable from this page.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { PresenceBridge, PresenceState, PRS } from '../shared/presence.ts'

// The channel names, written out: a sandboxed preload must be one file, and
// sharing the PRS object with the main window's preload would split it into
// a chunk. The type keeps every name equal to CH.
type Used = 'state' | 'stop' | 'talk' | 'open' | 'menu' | 'resize' | 'approval' | 'initiative' | 'dragStart' | 'dragEnd'
const CH: { readonly [K in Used]: (typeof PRS)[K] } = {
  state: 'presence:state',
  stop: 'presence:stop',
  talk: 'presence:talk',
  open: 'presence:open',
  menu: 'presence:menu',
  resize: 'presence:resize',
  approval: 'presence:approval',
  initiative: 'presence:initiative',
  dragStart: 'presence:drag-start',
  dragEnd: 'presence:drag-end',
}

const bridge: PresenceBridge = {
  onState: cb => {
    const listener = (_e: IpcRendererEvent, s: PresenceState) => cb(s)
    ipcRenderer.on(CH.state, listener)
    return () => void ipcRenderer.removeListener(CH.state, listener)
  },
  stop: () => ipcRenderer.invoke(CH.stop),
  talk: () => ipcRenderer.invoke(CH.talk),
  open: () => ipcRenderer.invoke(CH.open),
  menu: () => ipcRenderer.invoke(CH.menu),
  resize: (width, height) => ipcRenderer.invoke(CH.resize, width, height),
  approval: (id, approved) => ipcRenderer.invoke(CH.approval, id, approved),
  initiative: (id, action) => ipcRenderer.invoke(CH.initiative, id, action),
  dragStart: () => ipcRenderer.invoke(CH.dragStart),
  dragEnd: () => ipcRenderer.invoke(CH.dragEnd),
}

contextBridge.exposeInMainWorld('presence', bridge)
