import { describe, expect, it } from 'vitest'

import { DEFAULT_LIVE_VOICE, LIVE_MODELS, parseLiveVoice, usageCost } from '../shared/livevoice.ts'
import { liveInstructions, LiveVoice } from './livevoice.ts'

const KEY = 'sk-proj-real-key-never-leaves-main'

const fake = (status = 200, body: unknown = { value: 'ek_ephemeral_123', expires_at: 1_900_000_000 }) => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe('Live voice', () => {
  it('prices each response from its usage, cached tokens at the cached rate', () => {
    const r = LIVE_MODELS.mini.rates
    // One spoken exchange: 600 audio tokens in, 600 out, 2,000 text tokens of instructions (half cached).
    const usd = usageCost({ input_token_details: { text_tokens: 2000, audio_tokens: 600, cached_tokens_details: { text_tokens: 1000, audio_tokens: 0 } }, output_token_details: { text_tokens: 40, audio_tokens: 600 } }, r)
    const expected = (1000 * 0.6 + 1000 * 0.06 + 600 * 10 + 40 * 2.4 + 600 * 20) / 1e6
    expect(usd).toBeCloseTo(expected, 8)
    // No breakdown: everything counts as audio, never under-reporting.
    expect(usageCost({ input_tokens: 1000, output_tokens: 1000 }, r)).toBeCloseTo((1000 * 10 + 1000 * 20) / 1e6, 8)
  })

  it('keeps settings sane', () => {
    expect(parseLiveVoice(undefined)).toEqual(DEFAULT_LIVE_VOICE)
    expect(parseLiveVoice({ enabled: true, tier: 'ultra', voice: 'robot', capUsd: 9999 })).toEqual({ enabled: true, tier: 'mini', voice: 'marin', capUsd: 50 })
  })

  it('mints a session with everything fixed in main, and hands back only the short-lived token', async () => {
    const { calls, fetchImpl } = fake()
    const lv = new LiveVoice({ key: () => KEY, settings: () => ({ ...DEFAULT_LIVE_VOICE, enabled: true, tier: 'standard', voice: 'cedar' }), names: () => ({ assistant: 'Zara', owner: 'Hamza' }), fetchImpl })
    const s = await lv.mint()
    expect(s).toEqual({ token: 'ek_ephemeral_123', expiresAt: 1_900_000_000, model: 'gpt-realtime-2', tier: 'standard', capUsd: 3 })
    expect(JSON.stringify(s)).not.toContain(KEY)
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/realtime/client_secrets')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(String(calls[0]!.init.body)).session
    expect(body).toMatchObject({ type: 'realtime', model: 'gpt-realtime-2', audio: { output: { voice: 'cedar' }, input: { turn_detection: { type: 'semantic_vad', interrupt_response: false } } }, tool_choice: 'auto' })
    expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['ask_atlas', 'end_conversation'])
    expect(body.instructions).toContain("You are Zara, Hamza's personal assistant")
  })

  it('refuses without a key, when off, too fast, and says why OpenAI said no', async () => {
    const off = new LiveVoice({ key: () => undefined, settings: () => ({ ...DEFAULT_LIVE_VOICE, enabled: true }), names: () => ({ assistant: 'A', owner: '' }) })
    await expect(off.mint()).rejects.toThrow(/needs an OpenAI key/)
    const disabled = new LiveVoice({ key: () => KEY, settings: () => DEFAULT_LIVE_VOICE, names: () => ({ assistant: 'A', owner: '' }) })
    await expect(disabled.mint()).rejects.toThrow(/Live voice is off/)
    const { fetchImpl } = fake(401, { error: { message: 'bad key' } })
    const refused = new LiveVoice({ key: () => KEY, settings: () => ({ ...DEFAULT_LIVE_VOICE, enabled: true }), names: () => ({ assistant: 'A', owner: '' }), fetchImpl })
    await expect(refused.mint()).rejects.toThrow(/refused the key/)
    await expect(refused.mint()).rejects.toThrow(/One moment/)
  })

  it('speaks as a voice for the mind, never claiming what the mind did not do', () => {
    const text = liveInstructions('Atlas', '')
    expect(text).toMatch(/only through the ask_atlas tool/)
    expect(text).toMatch(/Never say something was done unless ask_atlas said so/)
    expect(text).toMatch(/Roman Urdu/)
  })
})
