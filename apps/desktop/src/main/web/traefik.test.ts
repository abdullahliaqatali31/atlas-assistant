import { describe, expect, it } from 'vitest'

import { traefikPanel, traefikRoute } from './traefik.ts'

describe('the route through a panel\'s Traefik', () => {
  it('is there only when install.sh prepared it', () => {
    expect(traefikPanel({})).toBeNull()
    expect(traefikPanel({ ATLAS_TRAEFIK_FILE: '/etc/dokploy/traefik/dynamic/atlas.yml', ATLAS_TRAEFIK_UPSTREAM: 'http://172.17.0.1:47800' })).toEqual({ name: 'Dokploy', file: '/etc/dokploy/traefik/dynamic/atlas.yml', upstream: 'http://172.17.0.1:47800', resolver: 'letsencrypt' })
    // Nothing odd reaches the file from the environment.
    expect(traefikPanel({ ATLAS_TRAEFIK_FILE: '/x.yml', ATLAS_TRAEFIK_UPSTREAM: 'http://a\n  evil: 1' })).toBeNull()
    expect(traefikPanel({ ATLAS_TRAEFIK_FILE: '/x.yml', ATLAS_TRAEFIK_UPSTREAM: 'http://a:1', ATLAS_TRAEFIK_RESOLVER: 'bad resolver' })?.resolver).toBe('letsencrypt')
  })

  it('sends the domain to Atlas over https, and routes nothing without one', () => {
    const panel = { name: 'Dokploy', file: '/x.yml', upstream: 'http://172.17.0.1:47800', resolver: 'letsencrypt' }
    const yml = traefikRoute(panel, 'atlas.example.com')
    expect(yml).toContain('rule: Host(`atlas.example.com`)')
    expect(yml).toContain('certResolver: letsencrypt')
    expect(yml).toContain('- url: http://172.17.0.1:47800')
    expect(yml).toContain('scheme: https')
    expect(traefikRoute(panel, null)).not.toContain('routers')
  })
})
