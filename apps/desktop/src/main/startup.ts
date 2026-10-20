/**
 * Start with Windows: the installed app registers itself to run at login.
 * By default it opens its window right away (--startup), so Atlas is the
 * first thing on screen; the owner can choose to start quietly in the tray
 * instead (--hidden: briefings, reminders, wake word and scheduled skills
 * keep working without a window). The installed app turns starting with
 * Windows on once, the first time it runs; after that the owner's choice
 * stands. Development builds cannot register: the login entry would start
 * bare Electron.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

import { CH, type StartupView } from '../shared/ipc.ts'

const HIDDEN = '--hidden'
const SHOW = '--startup'

/** Started by Windows at login set to start quietly: stay in the tray. */
export const startedHidden = () => process.argv.includes(HIDDEN)

const at = (args: string[]) => app.getLoginItemSettings({ args }).openAtLogin

export const startupView = (): StartupView => {
  if (!app.isPackaged) return { available: false, enabled: false, show: true }
  const show = at([SHOW])
  return { available: true, enabled: show || at([HIDDEN]), show: show || !at([HIDDEN]) }
}

const register = (on: boolean, show: boolean) => {
  // One entry at a time: clear both, then add the chosen one.
  app.setLoginItemSettings({ openAtLogin: false, args: [HIDDEN] })
  app.setLoginItemSettings({ openAtLogin: false, args: [SHOW] })
  if (on) app.setLoginItemSettings({ openAtLogin: true, args: [show ? SHOW : HIDDEN] })
}

/** The installed app's first run: start with Windows, window open. Later runs leave the owner's choice alone. */
export const ensureStartupDefault = () => {
  if (!app.isPackaged) return
  const marker = join(app.getPath('userData'), 'startup-chosen')
  if (existsSync(marker)) return
  register(true, true)
  try {
    writeFileSync(marker, new Date().toISOString())
  } catch {
    // Not fatal: it is set again next start, which is the same choice.
  }
}

export const registerStartupIpc = (handle: <T>(channel: string, fn: (a: unknown, b: unknown) => T | Promise<T>) => void) => {
  handle(CH.startup, () => startupView())
  handle(CH.setStartup, (on, show) => {
    if (typeof on !== 'boolean') throw new Error('Expected on or off.')
    if (!app.isPackaged) throw new Error('Install Atlas first; the development build cannot start with Windows.')
    register(on, show === undefined ? startupView().show : show === true)
    return startupView()
  })
}
