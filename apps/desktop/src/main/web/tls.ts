/**
 * Atlas's own HTTPS certificate from Let's Encrypt (ACME, HTTP-01): an
 * account key made once, a certificate per domain, renewed by itself when
 * fewer than 30 days are left. The challenge is answered by Atlas's port-80
 * listener (main/web/server.ts) while an order is open. Keys stay in
 * <data>/tls, readable by this user only.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import acme from 'acme-client'

/** Renew when fewer days than this are left (Let's Encrypt certificates last 90). */
const RENEW_DAYS = 30

export interface Held {
  domain: string
  cert: string
  key: string
  expires: number
  issuer: string
}

export class Certificates {
  /** HTTP-01 answers while an order is open: token → key authorization. */
  private readonly challenges = new Map<string, string>()
  private held: Held | null = null
  private busy: Promise<Held> | null = null

  constructor(
    private readonly deps: {
      dir: string
      log: (level: 'info' | 'warn' | 'error', message: string) => void
      /** Let's Encrypt's staging service (tests, and ATLAS_ACME_STAGING=1). */
      staging?: boolean
    },
  ) {
    mkdirSync(deps.dir, { recursive: true })
  }

  private file(name: string) {
    return join(this.deps.dir, name)
  }

  private write(name: string, text: string) {
    writeFileSync(this.file(name), text, { mode: 0o600 })
    try {
      chmodSync(this.file(name), 0o600)
    } catch {
      // Windows: the user's own folder.
    }
  }

  /** The certificate for this domain, from disk if Atlas got one before. */
  load(domain: string): Held | null {
    if (this.held?.domain === domain) return this.held
    const crt = this.file(`${domain}.crt`)
    const key = this.file(`${domain}.key`)
    if (!existsSync(crt) || !existsSync(key)) return null
    try {
      const cert = readFileSync(crt, 'utf8')
      const info = acme.crypto.readCertificateInfo(cert)
      this.held = { domain, cert, key: readFileSync(key, 'utf8'), expires: info.notAfter.getTime(), issuer: info.issuer.commonName ?? "Let's Encrypt" }
      return this.held
    } catch (e) {
      this.deps.log('warn', `The saved certificate for ${domain} could not be read: ${(e as Error).message}`)
      return null
    }
  }

  get current() {
    return this.held
  }

  /** The port-80 listener asks: the answer for this token, while an order is open. */
  challenge(token: string) {
    return this.challenges.get(token)
  }

  get issuing() {
    return this.busy !== null
  }

  needsRenewal(domain: string) {
    const h = this.load(domain)
    return !h || h.expires - Date.now() < RENEW_DAYS * 86_400_000
  }

  /** Orders a certificate (one at a time); the port-80 listener must already be up. */
  issue(domain: string, email: string | null): Promise<Held> {
    if (this.busy) return this.busy
    this.busy = this.order(domain, email).finally(() => {
      this.busy = null
    })
    return this.busy
  }

  private async accountKey() {
    const f = this.file('account.key')
    if (existsSync(f)) return readFileSync(f)
    const key = await acme.crypto.createPrivateKey()
    this.write('account.key', key.toString())
    return key
  }

  private async order(domain: string, email: string | null): Promise<Held> {
    const staging = this.deps.staging ?? process.env.ATLAS_ACME_STAGING === '1'
    const client = new acme.Client({ directoryUrl: staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production, accountKey: await this.accountKey() })
    const [key, csr] = await acme.crypto.createCsr({ commonName: domain })
    this.deps.log('info', `Asking Let's Encrypt for a certificate for ${domain}${staging ? ' (staging)' : ''}…`)
    const cert = await client.auto({
      csr,
      ...(email ? { email } : {}),
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
        this.challenges.set(challenge.token, keyAuthorization)
      },
      challengeRemoveFn: async (_authz, challenge) => {
        this.challenges.delete(challenge.token)
      },
    })
    this.write(`${domain}.key`, key.toString())
    this.write(`${domain}.crt`, cert)
    this.held = null
    const held = this.load(domain)
    if (!held) throw new Error('The certificate arrived but could not be read.')
    this.deps.log('info', `HTTPS certificate for ${domain} until ${new Date(held.expires).toISOString().slice(0, 10)}.`)
    return held
  }
}

/** Why an order failed, in words for the owner. */
export const explainAcme = (e: unknown, domain: string): string => {
  const m = e instanceof Error ? e.message : String(e)
  if (/rateLimited|too many/i.test(m)) return `Let's Encrypt says too many certificates were asked for ${domain} lately; try again later.`
  if (/connection|timeout|Fetching http|unauthorized|Invalid response/i.test(m))
    return `Let's Encrypt could not reach ${domain} on port 80. Check that the domain's DNS (an A record) points at this server and that ports 80 and 443 are open in its firewall. (${m.slice(0, 160)})`
  if (/dns|NXDOMAIN|no valid A records/i.test(m)) return `${domain} does not point anywhere yet: add an A record for it at your DNS provider, wait a few minutes, then try again.`
  return `Let's Encrypt refused: ${m.slice(0, 220)}`
}
