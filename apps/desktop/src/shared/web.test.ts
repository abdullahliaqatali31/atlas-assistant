import { describe, expect, it } from 'vitest'

import { allowedHost, deviceName, PairGuard, parseWebChange, readCookie, sameOrigin, WEB_BLOCKED, WA } from './web.ts'
import { CH } from './ipc.ts'
import { UC } from './ui.ts'

describe('web access', () => {
  it('answers only to loopback, and the PC’s own addresses when allowed', () => {
    expect(allowedHost('127.0.0.1:47800', 47800, [])).toBe(true)
    expect(allowedHost('localhost:47800', 47800, [])).toBe(true)
    expect(allowedHost('localhost:47801', 47800, [])).toBe(false)
    expect(allowedHost('evil.example:47800', 47800, [])).toBe(false)
    expect(allowedHost('192.168.1.5:47800', 47800, [])).toBe(false)
    expect(allowedHost('192.168.1.5:47800', 47800, ['192.168.1.5'])).toBe(true)
    expect(allowedHost(undefined, 47800, [])).toBe(false)
  })

  it('needs the socket and the page to share an origin', () => {
    expect(sameOrigin('http://localhost:47800', 'localhost:47800')).toBe(true)
    expect(sameOrigin('http://evil.example', 'localhost:47800')).toBe(false)
    expect(sameOrigin(undefined, 'localhost:47800')).toBe(false)
  })

  it('reads the device cookie', () => {
    expect(readCookie('a=1; atlas_device=abc-_9; b=2', 'atlas_device')).toBe('abc-_9')
    expect(readCookie('a=1', 'atlas_device')).toBeNull()
    expect(readCookie(undefined, 'atlas_device')).toBeNull()
  })

  it('stops guessing after five wrong codes', () => {
    const g = new PairGuard(5, 60_000)
    for (let i = 0; i < 5; i++) {
      expect(g.allowed(i)).toBe(true)
      g.fail(i)
    }
    expect(g.allowed(10)).toBe(false)
    expect(g.allowed(70_000)).toBe(true)
  })

  it('names devices and keeps window-only calls away from browsers', () => {
    expect(deviceName('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36')).toBe('Chrome on Android')
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone')
    expect(WEB_BLOCKED.has(UC.solid)).toBe(true)
    expect(WEB_BLOCKED.has(UC.report)).toBe(false)
    expect(WEB_BLOCKED.has(WA.newCode)).toBe(false)
    expect(WEB_BLOCKED.has(CH.send)).toBe(false)
    expect(parseWebChange({ lan: 'yes' })).toBeNull()
    expect(parseWebChange({ lan: true })).toEqual({ lan: true })
  })
})
