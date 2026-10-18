import { describe, expect, it } from 'vitest'

import { mainWebPreferences } from './window-prefs.ts'

describe('mainWebPreferences', () => {
  it('turns developer tools off in the installed app', () => {
    expect(mainWebPreferences('p.cjs', false).devTools).toBe(false)
    expect(mainWebPreferences('p.cjs', true).devTools).toBe(true)
  })

  it('keeps the renderer isolated in every build', () => {
    for (const dev of [true, false]) {
      expect(mainWebPreferences('p.cjs', dev)).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true })
    }
  })
})
