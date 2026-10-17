import { describe, expect, it } from 'vitest'

import { AzureSpeechVoice, azureLocale, azureSsml } from './azure.ts'

type Call = { url: string; init: RequestInit }

const fakeFetch = (respond: (call: Call) => Response) => {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  return { calls, impl }
}

const streamOf = (...parts: number[][]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(Uint8Array.from(p))
      c.close()
    },
  })

describe('AzureSpeechVoice', () => {
  it('streams MP3 TTS for an Urdu voice with escaped SSML', async () => {
    const f = fakeFetch(() => new Response(streamOf([1, 2], [3]), { status: 200 }))
    const voice = new AzureSpeechVoice('k3y-value', 'centralindia', 'ur-PK-AsadNeural', undefined, f.impl)
    const chunks: Uint8Array[] = []
    for await (const c of voice.tts.synthesize('Quote <pending> & "ready"')) chunks.push(c)
    expect(chunks.map(c => [...c])).toEqual([[1, 2], [3]])
    const [call] = f.calls
    expect(call!.url).toBe('https://centralindia.tts.speech.microsoft.com/cognitiveservices/v1')
    const headers = call!.init.headers as Record<string, string>
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('k3y-value')
    expect(headers['X-Microsoft-OutputFormat']).toMatch(/mp3/)
    expect(call!.init.body).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ur-PK"><voice name="ur-PK-AsadNeural">Quote &lt;pending&gt; &amp; &quot;ready&quot;</voice></speak>',
    )
  })

  it('transcribes WebM with the hinted locale through fast transcription', async () => {
    const f = fakeFetch(() => Response.json({ combinedPhrases: [{ text: 'آج دو کام ہیں' }], phrases: [{ locale: 'ur-PK' }] }))
    const voice = new AzureSpeechVoice('key-12345', 'eastus', undefined, undefined, f.impl)
    const heard = await voice.stt.transcribe(new Blob([Uint8Array.from([1])], { type: 'audio/webm' }), { languageHint: 'ur-Latn' })
    expect(heard).toEqual({ text: 'آج دو کام ہیں', languageCode: 'ur-PK' })
    const [call] = f.calls
    expect(call!.url).toMatch(/^https:\/\/eastus\.api\.cognitive\.microsoft\.com\/speechtotext\/transcriptions:transcribe\?api-version=/)
    const form = call!.init.body as FormData
    expect(JSON.parse(String(form.get('definition'))).locales).toEqual(['ur-PK'])
  })

  it('uses Urdu and English identification without a hint', async () => {
    const f = fakeFetch(() => Response.json({ combinedPhrases: [{ text: 'hello' }] }))
    const voice = new AzureSpeechVoice('key-12345', 'eastus', undefined, undefined, f.impl)
    expect((await voice.stt.transcribe(new Blob([]))).text).toBe('hello')
    expect(JSON.parse(String((f.calls[0]!.init.body as FormData).get('definition'))).locales).toEqual(['ur-PK', 'en-US'])
  })

  it('reports a rejected key, a missing voice and success', async () => {
    const rejected = new AzureSpeechVoice('bad-key-1', 'eastus', undefined, undefined, fakeFetch(() => new Response('', { status: 401 })).impl)
    expect(await rejected.healthCheck()).toEqual({ ok: false, error: 'The Azure Speech key was rejected for region eastus.' })
    const list = fakeFetch(() => Response.json([{ ShortName: 'ur-PK-UzmaNeural' }]))
    expect(await new AzureSpeechVoice('key-12345', 'eastus', 'ur-PK-UzmaNeural', undefined, list.impl).healthCheck()).toEqual({ ok: true })
    const missing = await new AzureSpeechVoice('key-12345', 'eastus', 'ur-PK-AsadNeural', undefined, list.impl).healthCheck()
    expect(missing.ok).toBe(false)
  })

  it('refuses a malformed region before any request', () => {
    expect(() => new AzureSpeechVoice('key', 'https://evil.example')).toThrow(/region/)
  })

  it('aborts synthesis when the signal fires', async () => {
    const f = fakeFetch(call => {
      if (call.init.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return new Response(streamOf([1]))
    })
    const voice = new AzureSpeechVoice('key-12345', 'eastus', undefined, undefined, f.impl)
    const abort = new AbortController()
    abort.abort()
    await expect(async () => {
      for await (const _ of voice.tts.synthesize('x', { signal: abort.signal })) void _
    }).rejects.toThrow(/aborted/)
  })
})

describe('azure helpers', () => {
  it('maps owner languages to recognition locales', () => {
    expect(azureLocale('ur-Latn')).toBe('ur-PK')
    expect(azureLocale('ur')).toBe('ur-PK')
    expect(azureLocale('en')).toBe('en-US')
    expect(azureLocale('en-gb')).toBe('en-GB')
    expect(azureLocale(undefined)).toBeUndefined()
  })

  it('derives xml:lang from the voice', () => {
    expect(azureSsml('hi', 'en-US-AvaNeural')).toContain('xml:lang="en-US"')
  })
})
