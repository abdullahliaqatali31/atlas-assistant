/**
 * OpenSky Network with the owner's free API client (Power up): a short-lived
 * access token from OpenSky's sign-in server (OAuth2 client credentials),
 * kept until a minute before it expires. Without a client Atlas calls
 * OpenSky anonymously, which allows about 400 credits a day; with one,
 * about 4,000. The client is stored as "clientId:clientSecret".
 */
const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'

export const parseOpenSkyClient = (v: string | null | undefined): { id: string; secret: string } | null => {
  const s = (v ?? '').trim()
  const at = s.indexOf(':')
  if (at < 1 || at === s.length - 1) return null
  return { id: s.slice(0, at), secret: s.slice(at + 1) }
}

export class OpenSkyAuth {
  private token: { value: string; until: number; client: string } | null = null

  constructor(
    private readonly deps: {
      client: () => string | null
      fetch?: typeof fetch
    },
  ) {}

  /** True when the owner has set a client. */
  get signedIn() {
    return parseOpenSkyClient(this.deps.client()) !== null
  }

  /** An Authorization header, or none when there is no client (anonymous). Throws when the client is refused. */
  async headers(): Promise<Record<string, string>> {
    const raw = this.deps.client()
    const c = parseOpenSkyClient(raw)
    if (!c) return {}
    if (this.token && this.token.client === raw && Date.now() < this.token.until) return { Authorization: `Bearer ${this.token.value}` }
    const res = await (this.deps.fetch ?? fetch)(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.id, client_secret: c.secret }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(res.status === 400 || res.status === 401 ? 'OpenSky refused this API client.' : `OpenSky sign-in answered ${res.status}.`)
    const j = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!j.access_token) throw new Error('OpenSky sent no token.')
    this.token = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 1800) - 60) * 1000, client: raw! }
    return { Authorization: `Bearer ${j.access_token}` }
  }
}
