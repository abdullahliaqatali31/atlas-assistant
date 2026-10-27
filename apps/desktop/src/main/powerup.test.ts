import { SECRET_NAMES } from '@assistant/runtime'
import { describe, expect, it, vi } from 'vitest'

import { keyProblem, POWER_PROVIDERS } from '../shared/powerup.ts'
import { PowerUp } from './powerup.ts'

const store = () => {
  const m = new Map<string, string>()
  return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v), delete: (k: string) => void m.delete(k), raw: m }
}

const setup = (env: Record<string, string> = {}) => {
  const secrets = store()
  const restarts: string[] = []
  const world: [string, string | null][] = []
  const pu = new PowerUp({
    secrets: secrets as never,
    env: () => env,
    inUse: () => ({ llm: 'anthropic', voice: 'azure' }),
    listModels: async (_p, key) => (key === 'sk-ant-good-key-123' ? ['claude-opus-5-5', 'claude-haiku-5-5'] : Promise.reject(new Error('401 invalid x-api-key'))),
    azureRegion: () => 'eastus',
    restart: async () => void restarts.push('restart'),
    changedWorldKey: (id, key) => void world.push([id, key]),
  })
  return { pu, secrets, restarts, world }
}

describe('Power up', () => {
  it('lists only keys the credential store can hold, each with a place to get it', () => {
    for (const p of POWER_PROVIDERS) {
      expect(SECRET_NAMES as readonly string[], p.id).toContain(p.secret)
      expect(p.getUrl, p.id).toMatch(/^https:\/\//)
      expect(p.unlocks.length, p.id).toBeGreaterThan(10)
    }
    expect(new Set(POWER_PROVIDERS.map(p => p.id)).size).toBe(POWER_PROVIDERS.length)
  })

  it('checks a pasted key looks like a key', () => {
    expect(keyProblem('short')).toMatch(/too short/)
    expect(keyProblem('sk ant with spaces')).toMatch(/no spaces/)
    expect(keyProblem('"sk-ant-quoted-key"')).toMatch(/no spaces, quotes/)
    expect(keyProblem('  sk-ant-api03-AbC_123-xyz  ')).toBeNull()
  })

  it('saves, tests for real, restarts only for the brain or voice in use, and never hands the value back', async () => {
    const { pu, secrets, restarts, world } = setup()
    let rows = await pu.save('anthropic', 'sk-ant-good-key-123')
    expect(secrets.raw.get('ANTHROPIC_API_KEY')).toBe('sk-ant-good-key-123')
    expect(restarts).toHaveLength(1)
    rows = await pu.test('anthropic')
    expect(rows.find(r => r.id === 'anthropic')).toMatchObject({ set: true, inUse: true, test: { ok: true, message: 'Works · 2 models available.' } })
    expect(JSON.stringify(rows)).not.toContain('sk-ant-good-key-123')
    // A brain not in use: saved, no restart.
    await pu.save('groq', 'gsk_bad_key_value_1')
    expect(restarts).toHaveLength(1)
    expect((await pu.test('groq')).find(r => r.id === 'groq')?.test).toMatchObject({ ok: false })
    // World keys reach their layer at once.
    await pu.save('windy', 'windy-key-1234567890')
    await pu.remove('windy')
    expect(world).toEqual([
      ['windy', 'windy-key-1234567890'],
      ['windy', null],
    ])
  })

  it('leaves keys set outside Atlas alone', async () => {
    const { pu } = setup({ ELEVENLABS_API_KEY: 'from-the-environment' })
    expect(pu.rows().find(r => r.id === 'elevenlabs')).toMatchObject({ set: true, external: true })
    await expect(pu.save('elevenlabs', 'another-key-12345')).rejects.toThrow(/outside Atlas/)
    await expect(pu.remove('elevenlabs')).rejects.toThrow(/outside Atlas/)
  })

  it('tests ElevenLabs and Azure with one cheap call each', async () => {
    const { pu } = setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => new Response('', { status: String(url).includes('elevenlabs') ? 401 : 200 }))
    await pu.save('elevenlabs', 'eleven-key-1234567890')
    await pu.save('azure-speech', 'azure-key-1234567890')
    const rows = await pu.test('elevenlabs').then(() => pu.test('azure-speech'))
    expect(rows.find(r => r.id === 'elevenlabs')?.test).toMatchObject({ ok: false, message: 'The service refused this key.' })
    expect(rows.find(r => r.id === 'azure-speech')?.test).toMatchObject({ ok: true, message: 'Works · region eastus.' })
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://eastus.api.cognitive.microsoft.com/sts/v1.0/issueToken')
    fetchMock.mockRestore()
  })
})
