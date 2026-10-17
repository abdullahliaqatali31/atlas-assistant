import { describe, expect, it } from 'vitest'

import { browserArgs, CATALOGUE, isCatalogueId, isStoredRule, parseBrowserSetting, parseExtensionToken, parseRuleInput } from './control.ts'

describe('parseRuleInput', () => {
  it('accepts narrow rules for one tool or one connection', () => {
    expect(parseRuleInput({ tool: 'playwright__*', actionClass: 'observe', effect: 'allow' })).toMatchObject({ tool: 'playwright__*' })
    expect(parseRuleInput({ tool: 'filesystem__read_file', actionClass: 'observe', effect: 'allow', scopePrefix: 'D:\\Work', expiresInHours: 24 })).toMatchObject({
      scopePrefix: 'D:\\Work',
      expiresInHours: 24,
    })
  })

  it('refuses wide or misleading rules', () => {
    expect(parseRuleInput({ tool: '*', actionClass: 'observe', effect: 'allow' })).toBeTypeOf('string')
    expect(parseRuleInput({ tool: 'x__*__*', actionClass: 'observe', effect: 'allow' })).toBeTypeOf('string')
    expect(parseRuleInput({ tool: 'open_application', actionClass: 'modify', effect: 'allow' })).toMatch(/always needs your approval/)
    expect(parseRuleInput({ tool: 'filesystem__*', actionClass: 'destructive', effect: 'allow' })).toMatch(/always ask/)
    expect(parseRuleInput({ tool: 'tasks_list', actionClass: 'observe', effect: 'allow', expiresInHours: 0 })).toBeTypeOf('string')
  })

  it('still allows asking or denying for approval-only tools', () => {
    expect(parseRuleInput({ tool: 'open_application', actionClass: 'modify', effect: 'deny' })).toMatchObject({ effect: 'deny' })
  })
})

describe('isStoredRule', () => {
  it('drops hand-edited rules the UI would refuse', () => {
    expect(isStoredRule({ id: 'owner-1', tool: 'playwright__*', actionClass: 'observe', effect: 'allow' })).toBe(true)
    expect(isStoredRule({ id: 'default-x', tool: 'playwright__*', actionClass: 'observe', effect: 'allow' })).toBe(false)
    expect(isStoredRule({ id: 'owner-2', tool: '*', actionClass: 'external-send', effect: 'allow' })).toBe(false)
  })
})

describe('connector catalogue', () => {
  it('offers calendar and email connectors as read-only briefing sources', () => {
    const ids = CATALOGUE.filter(c => c.readOnly).map(c => c.id)
    expect(ids).toEqual(['google-calendar', 'gmail', 'microsoft-365'])
    expect(CATALOGUE.every(c => c.available)).toBe(true)
    expect(isCatalogueId('gmail')).toBe(true)
    expect(isCatalogueId('my-server')).toBe(false)
  })

  it('the standing read rule a connector adds is a valid owner rule', () => {
    expect(isStoredRule({ id: 'owner-connector-gmail', tool: 'gmail__*', actionClass: 'observe', effect: 'allow' })).toBe(true)
  })
})

describe('browser setting', () => {
  it('maps to Playwright arguments: separate profile, or your own Chrome/Edge through the extension', () => {
    expect(browserArgs({ kind: 'separate' })).toEqual(['--isolated'])
    expect(browserArgs({ kind: 'mine', browser: 'chrome', profile: '' })).toEqual(['--extension', '--browser', 'chrome'])
    expect(browserArgs({ kind: 'mine', browser: 'msedge', profile: 'Profile 1' })).toEqual(['--extension', '--browser', 'msedge', '--profile-dir-name', 'Profile 1'])
  })

  it('starts Comet and Brave by their program file, as Chromium', () => {
    expect(browserArgs({ kind: 'mine', browser: 'comet', profile: '' }, 'C:/Users/me/AppData/Local/Perplexity/Comet/Application/comet.exe')).toEqual([
      '--extension',
      '--browser',
      'chrome',
      '--executable-path',
      'C:/Users/me/AppData/Local/Perplexity/Comet/Application/comet.exe',
    ])
  })

  it('takes the extension token as shown on its page, with or without the variable name', () => {
    const t = 'Abc123_def-456ghi789jkl'
    expect(parseExtensionToken(t)).toBe(t)
    expect(parseExtensionToken('PLAYWRIGHT_MCP_EXTENSION_TOKEN=' + t + ' ')).toBe(t)
    expect(parseExtensionToken('')).toBe('')
    expect(parseExtensionToken('short')).toBeNull()
    expect(parseExtensionToken('abc def ghi jkl mno pqr')).toBeNull()
  })

  it('accepts only known browsers and plain profile names', () => {
    expect(parseBrowserSetting({ kind: 'mine', browser: 'chrome', profile: ' Default ' })).toEqual({ kind: 'mine', browser: 'chrome', profile: 'Default' })
    expect(parseBrowserSetting({ kind: 'mine', browser: 'firefox' })).toMatch(/Chrome, Edge, Comet or Brave/)
    for (const bad of ['--isolated', 'Profile 1 --cdp-endpoint x', 'C:/Users/x', 'a/b']) expect(parseBrowserSetting({ kind: 'mine', browser: 'chrome', profile: bad })).toMatch(/Profile names/)
    expect(parseBrowserSetting({ kind: 'other' })).toMatch(/Unknown/)
  })
})
