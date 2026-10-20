/**
 * Power up, main side: saves, removes and tests the keys in POWER_PROVIDERS,
 * all in the Windows credential store. A test is one cheap real call (list
 * models, a token check, one AIS handshake, one webcam) so a green light
 * means the key works, not just that it looks like one. Values never leave
 * main; the page gets set / external / in use / last test only.
 */
import type { CredentialStore } from '@assistant/runtime'

import { keyProblem, powerProvider, POWER_PROVIDERS, type PowerProvider, type PowerRow } from '../shared/powerup.ts'
import { OpenSkyAuth } from './opensky.ts'
import type { LlmProviderId } from '@assistant/providers/llm-presets'

const TIMEOUT_MS = 15_000

const fetchStatus = async (url: string, init: RequestInit) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  return res.status
}

export class PowerUp {
  private tests = new Map<string, { ok: boolean; message: string; at: number }>()

  constructor(
    private readonly deps: {
      secrets: CredentialStore
      /** Keys set outside Atlas (environment, the dev .env). */
      env: () => Record<string, string | undefined>
      /** The brain and voice in use, to restart the runtime when their key changes. */
      inUse: () => { llm: string; voice: string }
      listModels: (provider: LlmProviderId, key: string) => Promise<string[]>
      azureRegion: () => string
      /** A brain or voice key in use changed: the runtime reloads with it. */
      restart: () => Promise<void>
      /** Ships and webcams read their key fresh; tell them it changed. */
      changedWorldKey: (id: 'aisstream' | 'windy', key: string | null) => void
    },
  ) {}

  private samples = new Map<string, Uint8Array>()

  /** A short sample in a voice, with the owner's own key (cached for the session). */
  async previewVoice(provider: unknown, voice: unknown, owner: string): Promise<Uint8Array | null> {
    if ((provider !== 'openai' && provider !== 'elevenlabs') || typeof voice !== 'string' || !/^[\w-]{2,64}$/.test(voice)) throw new Error('Unknown voice.')
    const id = `${provider}:${voice}`
    const hit = this.samples.get(id)
    if (hit) return hit
    const name = owner.trim().split(/\s+/)[0] ?? ''
    const text = `Hi${name ? ` ${name}` : ''}, main Atlas hoon. Is awaaz mein aap se baat karoon?`
    const env = this.deps.env()
    let res: Response
    if (provider === 'openai') {
      const key = this.deps.secrets.get('OPENAI_API_KEY' as never) ?? env.OPENAI_API_KEY
      if (!key) return null
      res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'mp3', instructions: 'Warm, natural and friendly.' }),
        signal: AbortSignal.timeout(20_000),
      })
    } else {
      const key = this.deps.secrets.get('ELEVENLABS_API_KEY' as never) ?? env.ELEVENLABS_API_KEY
      if (!key) return null
      res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
        signal: AbortSignal.timeout(20_000),
      })
    }
    if (!res.ok) throw new Error(res.status === 401 || res.status === 402 ? 'That voice service refused (key or credits).' : `The voice service answered ${res.status}.`)
    const audio = new Uint8Array(await res.arrayBuffer())
    this.samples.set(id, audio)
    return audio
  }

  private stored(p: PowerProvider) {
    return this.deps.secrets.get(p.secret as never)
  }

  rows(): PowerRow[] {
    const env = this.deps.env()
    const use = this.deps.inUse()
    return POWER_PROVIDERS.map(p => {
      const stored = Boolean(this.stored(p))
      const external = !stored && Boolean(env[p.secret])
      return { id: p.id, set: stored || external, external, inUse: p.id === use.llm || p.id === use.voice || (p.id === 'azure-speech' && use.voice === 'azure'), test: this.tests.get(p.id) ?? null }
    })
  }

  private need(id: unknown): PowerProvider {
    const p = typeof id === 'string' ? powerProvider(id) : undefined
    if (!p) throw new Error('Unknown service.')
    return p
  }

  private async afterChange(p: PowerProvider, key: string | null) {
    this.tests.delete(p.id)
    if (p.id === 'aisstream' || p.id === 'windy') this.deps.changedWorldKey(p.id, key)
    const use = this.deps.inUse()
    if (p.id === use.llm || p.id === use.voice || (p.id === 'azure-speech' && use.voice === 'azure')) await this.deps.restart()
  }

  async save(id: unknown, key: unknown): Promise<PowerRow[]> {
    const p = this.need(id)
    if (typeof key !== 'string') throw new Error('Paste the key.')
    const problem = keyProblem(key)
    if (problem) throw new Error(problem)
    if (!this.stored(p) && this.deps.env()[p.secret]) throw new Error('This key is set outside Atlas (in the environment); change it there.')
    this.deps.secrets.set(p.secret as never, key.trim())
    await this.afterChange(p, key.trim())
    return this.rows()
  }

  async remove(id: unknown): Promise<PowerRow[]> {
    const p = this.need(id)
    if (!this.stored(p)) throw new Error(this.deps.env()[p.secret] ? 'This key is set outside Atlas; remove it there.' : 'No key is saved for this.')
    this.deps.secrets.delete(p.secret as never)
    await this.afterChange(p, null)
    return this.rows()
  }

  async test(id: unknown): Promise<PowerRow[]> {
    const p = this.need(id)
    const key = this.stored(p) ?? this.deps.env()[p.secret]
    let result: { ok: boolean; message: string }
    if (!key) result = { ok: false, message: 'No key saved yet.' }
    else
      try {
        result = await this.check(p, key)
      } catch (e) {
        result = { ok: false, message: e instanceof Error && /timeout|abort/i.test(e.message) ? 'No answer in time; check the internet.' : `Could not check: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown error'}` }
      }
    this.tests.set(p.id, { ...result, at: Date.now() })
    return this.rows()
  }

  /** One cheap real call per service. */
  private async check(p: PowerProvider, key: string): Promise<{ ok: boolean; message: string }> {
    const bad = (status: number) => (status === 401 || status === 403 ? 'The service refused this key.' : `The service answered ${status}.`)
    if (p.llm) {
      const models = await this.deps.listModels(p.llm, key)
      return { ok: true, message: models.length ? `Works · ${models.length} models available.` : 'Works.' }
    }
    switch (p.id) {
      case 'elevenlabs': {
        const s = await fetchStatus('https://api.elevenlabs.io/v1/models', { headers: { 'xi-api-key': key } })
        return s === 200 ? { ok: true, message: 'Works.' } : { ok: false, message: bad(s) }
      }
      case 'azure-speech': {
        const region = this.deps.azureRegion()
        if (!region) return { ok: false, message: 'Set the Azure region in Setup › Connection first.' }
        const s = await fetchStatus(`https://${encodeURIComponent(region)}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Length': '0' } })
        return s === 200 ? { ok: true, message: `Works · region ${region}.` } : { ok: false, message: s === 401 ? 'Azure refused this key (or it belongs to another region).' : bad(s) }
      }
      case 'windy': {
        const s = await fetchStatus('https://api.windy.com/webcams/api/v3/webcams?limit=1', { headers: { 'x-windy-api-key': key } })
        return s === 200 ? { ok: true, message: 'Works.' } : { ok: false, message: bad(s) }
      }
      case 'aisstream':
        return this.checkAis(key)
      case 'cesium-ion': {
        const s = await fetchStatus('https://api.cesium.com/v1/me', { headers: { Authorization: `Bearer ${key}` } })
        return s === 200 ? { ok: true, message: 'Works.' } : { ok: false, message: bad(s) }
      }
      case 'tomtom': {
        const s = await fetchStatus(`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/1/0/0.png?key=${encodeURIComponent(key)}`, {})
        return s === 200 ? { ok: true, message: 'Works · live traffic on.' } : { ok: false, message: bad(s) }
      }
      case 'opensky': {
        try {
          await new OpenSkyAuth({ client: () => key }).headers()
          return { ok: true, message: 'Works · more flight data on.' }
        } catch (e) {
          return { ok: false, message: e instanceof Error ? e.message : String(e) }
        }
      }
      case 'google-maps': {
        const s = await fetchStatus(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(key)}`, {})
        return s === 200 ? { ok: true, message: 'Works · photorealistic 3D tiles on.' } : { ok: false, message: s === 403 ? 'Google refused it: enable the Map Tiles API for this key and project.' : bad(s) }
      }
    }
    return { ok: false, message: 'No test for this service.' }
  }

  /** AISStream answers a bad key with an error message; a good one starts sending positions. */
  private checkAis(key: string): Promise<{ ok: boolean; message: string }> {
    return new Promise(resolve => {
      const ws = new WebSocket('wss://stream.aisstream.io/v0/stream')
      let opened = false
      const done = (r: { ok: boolean; message: string }) => {
        clearTimeout(timer)
        try {
          ws.close()
        } catch {
          // Already closed.
        }
        resolve(r)
      }
      const timer = setTimeout(() => done(opened ? { ok: true, message: 'Accepted (no ships reported in the test area yet).' } : { ok: false, message: 'Could not reach AISStream.' }), 10_000)
      ws.addEventListener('open', () => {
        opened = true
        // The English Channel: always busy.
        ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [[[49.5, -2], [51.5, 2]]], FilterMessageTypes: ['PositionReport'] }))
      })
      ws.addEventListener('message', async ev => {
        const text = typeof ev.data === 'string' ? ev.data : ev.data instanceof Blob ? await ev.data.text() : String(ev.data)
        done(/"error"/i.test(text) ? { ok: false, message: /api ?key/i.test(text) ? 'AISStream refused this key.' : 'AISStream reported an error.' } : { ok: true, message: 'Works · ships are coming in.' })
      })
      ws.addEventListener('error', () => !opened && done({ ok: false, message: 'Could not reach AISStream.' }))
    })
  }
}
