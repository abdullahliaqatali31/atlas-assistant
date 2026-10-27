/**
 * Every keyboard shortcut Atlas has, in one place: the global ones main
 * registers with Windows (they work while Atlas is minimised or behind other
 * apps), and the ones inside its window. The shortcut board shows this list,
 * with a mark on any global one another app has taken.
 */

export type GlobalShortcutId = 'front' | 'talk' | 'stop' | 'pause' | 'quiet' | 'palette' | 'board'

export interface GlobalShortcut {
  id: GlobalShortcutId
  /** Electron accelerator. */
  accelerator: string
  label: string
  detail: string
}

export const GLOBAL_SHORTCUTS: readonly GlobalShortcut[] = [
  { id: 'talk', accelerator: 'CommandOrControl+Alt+Space', label: 'Talk to Atlas', detail: 'Starts listening right away, even while Atlas is minimised; the widget shows it is listening.' },
  { id: 'front', accelerator: 'CommandOrControl+Alt+A', label: 'Bring Atlas to the front', detail: 'Opens its window from anywhere (from the tray too).' },
  { id: 'stop', accelerator: 'CommandOrControl+Alt+S', label: 'Stop talking', detail: 'Stops what Atlas is saying or doing in the conversation.' },
  { id: 'quiet', accelerator: 'CommandOrControl+Alt+Q', label: 'Quiet mode on / off', detail: 'Quiet: replies stay on screen, nothing is spoken, only urgent things show.' },
  { id: 'palette', accelerator: 'CommandOrControl+Alt+K', label: 'Command palette', detail: 'Opens Atlas with the palette: jump anywhere, run any action.' },
  { id: 'board', accelerator: 'CommandOrControl+Alt+/', label: 'This shortcut board', detail: 'Shows every shortcut.' },
  { id: 'pause', accelerator: 'CommandOrControl+Alt+P', label: 'Pause or resume all automation', detail: 'The emergency stop: nothing runs until you resume.' },
]

export interface AppShortcut {
  keys: string[]
  label: string
}

/** Shortcuts inside Atlas's window, by where they work. */
export const APP_SHORTCUTS: readonly { group: string; items: readonly AppShortcut[] }[] = [
  {
    group: 'Anywhere in Atlas',
    items: [
      { keys: ['Mod', 'K'], label: 'Command palette' },
      { keys: ['?'], label: 'Shortcut board' },
      { keys: ['/'], label: 'Type a message to Atlas' },
      { keys: ['Esc'], label: 'Close the side panel (when not pinned), leave full views' },
      { keys: ['[', ']'], label: 'Previous / next side panel' },
      { keys: ['G', 'H'], label: 'Go to Brain (Home)' },
      { keys: ['G', 'W'], label: 'Go to World' },
      { keys: ['G', 'B'], label: 'Go to the browser' },
    ],
  },
  {
    group: 'Talking',
    items: [
      { keys: ['Ctrl', 'Space'], label: 'Talk (tap again to send what you said)' },
      { keys: ['Esc'], label: 'Cancel listening, or stop the reply' },
      { keys: ['Enter'], label: 'Send a typed message' },
    ],
  },
  {
    group: 'World map: layers',
    items: [
      { keys: ['F'], label: 'Flights' },
      { keys: ['B'], label: 'Ships' },
      { keys: ['S'], label: 'Satellites' },
      { keys: ['N'], label: 'News' },
      { keys: ['A'], label: 'Story' },
      { keys: ['P'], label: 'Places' },
      { keys: ['C'], label: 'Cameras' },
      { keys: ['Q'], label: 'Earthquakes' },
      { keys: ['E'], label: 'Events' },
      { keys: ['X'], label: 'Fires' },
      { keys: ['D'], label: 'Disasters' },
      { keys: ['L'], label: 'Launches' },
      { keys: ['R'], label: 'Radio' },
      { keys: ['O'], label: 'Rain' },
      { keys: ['M'], label: 'Pins' },
    ],
  },
  {
    group: 'World map: panels',
    items: [
      { keys: ['I'], label: 'Intelligence' },
      { keys: ['J'], label: 'Cameras' },
      { keys: ['K'], label: 'Markets' },
      { keys: ['V'], label: 'VIP people' },
      { keys: ['Z'], label: 'Geography' },
      { keys: ['U'], label: 'Launches' },
    ],
  },
]

/** The device showing the page is a Mac (or an iPad or iPhone): keys are named the Mac way. */
export const viewerIsMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

const MAC_KEYS: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }

/** A key as the viewer's keyboard names it: Mod is Ctrl, or ⌘ on a Mac. */
export const keyName = (k: string) => (viewerIsMac() ? (MAC_KEYS[k] ?? k) : k === 'Mod' ? 'Ctrl' : k)

/** "CommandOrControl+Alt+Space" → ["Ctrl", "Alt", "Space"] (["⌘", "⌥", "Space"] on a Mac). */
export const acceleratorKeys = (a: string): string[] => a.split('+').map(k => keyName(k === 'CommandOrControl' ? 'Mod' : k))

export interface ShortcutsView {
  global: (GlobalShortcut & { ok: boolean })[]
}

export const SCT = { list: 'shortcuts:list' } as const
