import { evaluate } from '@assistant/policy'
import { DEFAULT_RULES } from '@assistant/runtime'
import { describe, expect, it } from 'vitest'

import { DESKTOP_RULES } from '../runtime/desktop.ts'
import { actionScope, appMatchesExe, blockedApp, blockedReason } from './desktop.ts'

const WA_EXE = 'C:\\Program Files\\WindowsApps\\5319275A.WhatsAppDesktop_2.2640.100.0_x64__cv1g1gvanyjgm\\WhatsApp.Root.exe'

describe('desktop safety', () => {
  it('never controls terminals, security, password managers, browsers or Atlas', () => {
    expect(blockedReason('C:\\Windows\\System32\\cmd.exe')).toBe('a terminal')
    expect(blockedReason('C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1\\WindowsTerminal.exe')).toBe('a terminal')
    expect(blockedReason('C:\\Windows\\System32\\SecHealthUI.exe')).toMatch(/security/)
    expect(blockedReason('C:\\Users\\a\\AppData\\Local\\1Password\\app\\8\\1Password.exe')).toBe('a password manager')
    expect(blockedReason('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toMatch(/browser/)
    expect(blockedReason(WA_EXE)).toBeNull()
    expect(blockedApp('Windows PowerShell', 'x')).toBe('a terminal')
    expect(blockedApp('Bitwarden', 'x')).toBe('a password manager')
    expect(blockedApp('WhatsApp', '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App')).toBeNull()
    expect(blockedApp('WhatsApp Web', 'Chrome._crx_x')).toBeNull()
    expect(blockedApp('Chromium Web Browser (Ubuntu)', 'x')).toMatch(/browser/)
    expect(blockedApp('Google Chrome', 'Chrome')).toMatch(/browser/)
    expect(blockedApp('Ubuntu', 'CanonicalGroupLimited.Ubuntu')).toBe('a terminal')
  })

  it('matches Store apps by package and publisher, desktop apps by program file', () => {
    expect(appMatchesExe({ appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App', exes: [] }, WA_EXE)).toBe(true)
    expect(appMatchesExe({ appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App', exes: [] }, 'C:\\Program Files\\WindowsApps\\Other_1_x64__cv1g1gvanyjgm\\x.exe')).toBe(false)
    expect(appMatchesExe({ appId: 'Telegram.TelegramDesktop', exes: ['C:\\Users\\a\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe'] }, 'c:\\users\\a\\appdata\\roaming\\telegram desktop\\telegram.exe')).toBe(true)
    expect(appMatchesExe({ appId: '{6D809377}\\Notepad++\\notepad++.exe', exes: [] }, 'C:\\Program Files\\Notepad++\\notepad++.exe')).toBe(true)
  })

  it('marks Send, Delete, Pay and Enter in chat apps as risky', () => {
    expect(actionScope({ kind: 'act', app: 'Outlook', label: 'Send', action: 'click' })).toBe('risky')
    expect(actionScope({ kind: 'act', app: 'WhatsApp', label: 'Delete chat', action: 'click' })).toBe('risky')
    expect(actionScope({ kind: 'act', app: 'WhatsApp', label: 'Video call', action: 'click' })).toBe('risky')
    expect(actionScope({ kind: 'act', app: 'WhatsApp', label: 'New chat', action: 'click' })).toBe('normal')
    expect(actionScope({ kind: 'act', app: 'Excel', label: 'Bold', action: 'click' })).toBe('normal')
    expect(actionScope({ kind: 'act', app: 'WhatsApp', label: 'Send', action: 'type' })).toBe('normal')
    expect(actionScope({ kind: 'keys', app: 'WhatsApp', keys: 'enter' })).toBe('risky')
    expect(actionScope({ kind: 'keys', app: 'Notepad', keys: 'enter' })).toBe('normal')
    expect(actionScope({ kind: 'keys', app: 'Notepad', keys: 'ctrl+a backspace' })).toBe('risky')
    expect(actionScope({ kind: 'keys', app: 'Notepad', keys: 'ctrl+a ctrl+c' })).toBe('normal')
    expect(actionScope({ kind: 'keys', app: 'Explorer', keys: 'shift+delete' })).toBe('risky')
    expect(actionScope({ kind: 'keys', app: 'Excel', keys: 'alt+f4' })).toBe('risky')
  })

  it('asks for risky actions and every WhatsApp message, allows ordinary ones', () => {
    const rules = [...DEFAULT_RULES, ...DESKTOP_RULES]
    const now = Date.now()
    expect(evaluate({ tool: 'desktop_act', actionClass: 'modify', scope: 'normal' }, rules, now).effect).toBe('allow')
    expect(evaluate({ tool: 'desktop_act', actionClass: 'modify', scope: 'risky' }, rules, now).effect).toBe('ask')
    expect(evaluate({ tool: 'desktop_keys', actionClass: 'modify', scope: 'risky' }, rules, now).effect).toBe('ask')
    expect(evaluate({ tool: 'desktop_read', actionClass: 'observe' }, rules, now).effect).toBe('allow')
    expect(evaluate({ tool: 'whatsapp_read', actionClass: 'observe' }, rules, now).effect).toBe('allow')
    expect(evaluate({ tool: 'whatsapp_send', actionClass: 'external-send', scope: 'whatsapp:ahmed' }, rules, now).effect).toBe('ask')
  })
})
