/**
 * Start with Windows: the installed app registers itself to run at login
 * with --hidden, so it starts in the tray (briefings, reminders, wake word
 * and scheduled skills keep working) without opening a window. Development
 * builds cannot register: the login entry would start bare Electron.
 */
import { app } from 'electron'

import { CH, type StartupView } from '../shared/ipc.ts'

const HIDDEN = '--hidden'

/** Started by Windows at login (or asked to start hidden): stay in the tray. */
export const startedHidden = () => process.argv.includes(HIDDEN)

export const startupView = (): StartupView => ({
  available: app.isPackaged,
  enabled: app.isPackaged && app.getLoginItemSettings({ args: [HIDDEN] }).openAtLogin,
})

export const registerStartupIpc = (handle: <T>(channel: string, fn: (a: unknown) => T | Promise<T>) => void) => {
  handle(CH.startup, () => startupView())
  handle(CH.setStartup, on => {
    if (typeof on !== 'boolean') throw new Error('Expected on or off.')
    if (!app.isPackaged) throw new Error('Install Atlas first; the development build cannot start with Windows.')
    app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN] })
    return startupView()
  })
}
