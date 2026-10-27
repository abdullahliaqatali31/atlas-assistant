/**
 * Settings › Security › Address & HTTPS: how Atlas is reached from outside.
 * Its own domain with a free Let's Encrypt certificate that Atlas gets and
 * renews by itself (it answers on ports 80 and 443), or behind a proxy that
 * already does HTTPS (Caddy, Traefik, Cloudflare Tunnel, Dokploy), or neither
 * (this PC and the home network only, by IP and port).
 */

export const ACCESS_MODES = ['off', 'acme', 'proxy'] as const
export type AccessMode = (typeof ACCESS_MODES)[number]

export const ACCESS_MODE_LABEL: Record<AccessMode, string> = {
  off: 'No domain (IP and port)',
  acme: "My domain, HTTPS by Atlas (Let's Encrypt)",
  proxy: 'My domain, behind a proxy that does HTTPS',
}

export interface AccessSettings {
  mode: AccessMode
  /** atlas.example.com */
  domain: string | null
  /** For Let's Encrypt's expiry notices (optional). */
  email: string | null
}

export const DEFAULT_ACCESS: AccessSettings = { mode: 'off', domain: null, email: null }

export interface AccessView extends AccessSettings {
  /** The certificate Atlas holds for the domain. */
  certificate: { domain: string; expires: number; issuer: string } | null
  /** Getting or renewing one right now. */
  issuing: boolean
  /** Ports 80 and 443 are open here (Let's Encrypt mode). */
  listening: { http: boolean; https: boolean }
  /** The address to open Atlas at from anywhere, when there is one. */
  url: string | null
  /** What the domain's DNS points at, and this server's own public address, to compare. */
  dns: { addresses: string[]; publicIp: string | null } | null
  /** A panel on this server already does HTTPS (Dokploy's Traefik): Atlas writes its route there; its own certificate is not possible. */
  panel: string | null
  error: string | null
}

export const ACX = {
  state: 'access:state',
  changed: 'access:changed',
  set: 'access:set',
  issue: 'access:issue',
  checkDns: 'access:check-dns',
} as const

/** A domain name people type (no scheme, no port, no path), lower-cased; null when it is not one. */
export const parseDomain = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const d = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
  if (d.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return null
  return d
}

export const parseAccess = (raw: unknown): Partial<AccessSettings> | null => {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const out: Partial<AccessSettings> = {}
  if (o.mode !== undefined) {
    if (!(ACCESS_MODES as readonly unknown[]).includes(o.mode)) return null
    out.mode = o.mode as AccessMode
  }
  if (o.domain !== undefined) {
    if (o.domain === null || o.domain === '') out.domain = null
    else {
      const d = parseDomain(o.domain)
      if (!d) return null
      out.domain = d
    }
  }
  if (o.email !== undefined) {
    if (o.email === null || o.email === '') out.email = null
    else if (typeof o.email === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(o.email.trim())) out.email = o.email.trim()
    else return null
  }
  return out
}

/** Is this Host header Atlas's own domain (with or without a port)? */
export const isDomainHost = (host: string | undefined, domain: string | null): boolean => {
  if (!host || !domain) return false
  const h = host.toLowerCase()
  return h === domain || h.startsWith(`${domain}:`)
}

export interface AccessBridge {
  state(): Promise<AccessView>
  set(change: Partial<AccessSettings>): Promise<AccessView>
  issue(): Promise<AccessView>
  checkDns(): Promise<AccessView>
  onChanged(cb: (v: AccessView) => void): () => void
}
