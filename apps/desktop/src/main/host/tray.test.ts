import { describe, expect, it } from 'vitest'

import { GLOBAL_SHORTCUTS } from '../../shared/shortcuts.ts'
import { toHotkey } from './tray.ts'

describe('tray shortcuts', () => {
  it('turns accelerators into Windows modifier bits and virtual keys', () => {
    expect(toHotkey('CommandOrControl+Alt+Space')).toEqual({ mods: 3, vk: 0x20 })
    expect(toHotkey('CommandOrControl+Alt+A')).toEqual({ mods: 3, vk: 0x41 })
    expect(toHotkey('CommandOrControl+Alt+/')).toEqual({ mods: 3, vk: 0xbf })
    expect(toHotkey('Shift+F5')).toEqual({ mods: 4, vk: 0x74 })
  })

  it('refuses keys without a modifier or unknown names', () => {
    expect(toHotkey('A')).toBeNull()
    expect(toHotkey('Hyper+A')).toBeNull()
  })

  it('understands every global shortcut Atlas registers', () => {
    for (const s of GLOBAL_SHORTCUTS) expect(toHotkey(s.accelerator), s.accelerator).not.toBeNull()
  })
})
