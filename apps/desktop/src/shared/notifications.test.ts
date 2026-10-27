import { describe, expect, it } from 'vitest'

import { appName, isImportantSender, parseToast } from './notifications.ts'

describe('Windows notifications', () => {
  it('names apps from their Windows ids', () => {
    expect(appName('5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App')).toBe('WhatsApp')
    expect(appName('MSTeams_8wekyb3d8bbwe!MSTeams')).toBe('Teams')
    expect(appName('Cisco.Webex')).toBe('Webex')
    expect(appName('com.brightpixel.mailer')).toBe('mailer')
  })

  it('reads a toast: first line, the rest, entities decoded, attribution left out', () => {
    const xml = '<toast><visual><binding template="ToastGeneric"><text>Ali &amp; Co</text><text>Kal meeting 3 baje? &#x1F44D;</text><text placement="attribution">via WhatsApp</text></binding></visual></toast>'
    expect(parseToast(xml)).toEqual({ title: 'Ali & Co', body: 'Kal meeting 3 baje? 👍' })
    expect(parseToast('<toast/>')).toEqual({ title: '', body: '' })
  })

  it('knows a client or family member from what Atlas remembers', () => {
    expect(isImportantSender('Bilal', ['Bilal is a client from Lahore (logistics app).'])).toBe(true)
    expect(isImportantSender('Bilal', ['Bilal likes cricket.'])).toBe(false)
    expect(isImportantSender('Sara', ['Bilal is a client.'])).toBe(false)
  })
})
