import { describe, expect, it } from 'vitest'

import { isDomainHost, parseAccess, parseDomain } from './access.ts'

describe('access settings', () => {
  it('takes a domain as people type it', () => {
    expect(parseDomain('https://Atlas.Example.com/settings')).toBe('atlas.example.com')
    expect(parseDomain('atlas.example.com.')).toBe('atlas.example.com')
    expect(parseDomain('localhost')).toBeNull()
    expect(parseDomain('1.2.3.4')).toBeNull()
    expect(parseDomain('not a domain')).toBeNull()
    expect(parseDomain('-bad.example.com')).toBeNull()
  })

  it('checks every field and refuses the rest', () => {
    expect(parseAccess({ mode: 'acme', domain: 'atlas.example.com', email: 'me@example.com' })).toEqual({ mode: 'acme', domain: 'atlas.example.com', email: 'me@example.com' })
    expect(parseAccess({ mode: 'off', domain: '' })).toEqual({ mode: 'off', domain: null })
    expect(parseAccess({ mode: 'root' })).toBeNull()
    expect(parseAccess({ email: 'not-an-email' })).toBeNull()
  })

  it('knows its own host name, with or without a port', () => {
    expect(isDomainHost('atlas.example.com', 'atlas.example.com')).toBe(true)
    expect(isDomainHost('Atlas.Example.com:8443', 'atlas.example.com')).toBe(true)
    expect(isDomainHost('evil.atlas.example.com', 'atlas.example.com')).toBe(false)
    expect(isDomainHost('atlas.example.com.evil.net', 'atlas.example.com')).toBe(false)
    expect(isDomainHost('atlas.example.com', null)).toBe(false)
  })
})
