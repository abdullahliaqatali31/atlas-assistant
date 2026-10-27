/**
 * A panel's Traefik in front of Atlas (Dokploy on the same server): when the
 * owner sets the domain in Settings › Address & HTTPS, Atlas writes its own
 * route file there, and Traefik serves the domain with the panel's Let's
 * Encrypt certificate. install.sh prepares it while it has root: one empty
 * route file Atlas may write (nothing else), where Traefik reaches Atlas,
 * and the resolver's name, in /etc/atlas.env:
 *
 *   ATLAS_TRAEFIK_FILE=/etc/dokploy/traefik/dynamic/atlas.yml
 *   ATLAS_TRAEFIK_UPSTREAM=http://172.17.0.1:47800
 *   ATLAS_TRAEFIK_RESOLVER=letsencrypt
 */
import { existsSync, writeFileSync } from 'node:fs'

export interface TraefikPanel {
  name: string
  file: string
  upstream: string
  resolver: string
}

/** The panel install.sh found, or null. */
export const traefikPanel = (env: NodeJS.ProcessEnv = process.env): TraefikPanel | null => {
  const file = env.ATLAS_TRAEFIK_FILE
  const upstream = env.ATLAS_TRAEFIK_UPSTREAM
  if (!file || !upstream || !/^https?:\/\/[\w.:[\]-]+$/.test(upstream)) return null
  return { name: file.includes('dokploy') ? 'Dokploy' : 'Traefik', file, upstream, resolver: /^[\w-]{1,40}$/.test(env.ATLAS_TRAEFIK_RESOLVER ?? '') ? env.ATLAS_TRAEFIK_RESOLVER! : 'letsencrypt' }
}

/** The route file's text: the domain to Atlas over https (http sent there), or nothing routed. */
export const traefikRoute = (panel: TraefikPanel, domain: string | null): string => {
  const head = '# Atlas: written by Atlas itself (Settings › Security › Address & HTTPS). Delete it to remove the route.\n'
  if (!domain) return `${head}# No domain set yet.\n`
  // Host() takes the domain between backticks; parseDomain only lets letters, digits, dots and dashes through.
  return `${head}http:
  routers:
    atlas:
      rule: Host(\`${domain}\`)
      entryPoints: [websecure]
      service: atlas
      tls:
        certResolver: ${panel.resolver}
    atlas-http:
      rule: Host(\`${domain}\`)
      entryPoints: [web]
      middlewares: [atlas-https]
      service: atlas
  middlewares:
    atlas-https:
      redirectScheme:
        scheme: https
        permanent: true
  services:
    atlas:
      loadBalancer:
        servers:
          - url: ${panel.upstream}
`
}

/** Writes the route (Traefik watches the folder and applies it within seconds). */
export const writeTraefikRoute = (panel: TraefikPanel, domain: string | null) => {
  if (!existsSync(panel.file)) throw new Error(`${panel.file} is gone: run the installer again to set ${panel.name} up for Atlas.`)
  writeFileSync(panel.file, traefikRoute(panel, domain))
}
