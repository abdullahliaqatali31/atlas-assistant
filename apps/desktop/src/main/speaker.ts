/**
 * Voice ID on this PC: a speaker model (ERes2Net, 3D-Speaker, Apache-2.0,
 * downloaded once and checked by its hash) turns a few seconds of speech into
 * a voice print. The owner's and family's prints are kept encrypted
 * (AES-256-GCM, the key in Windows Credential Manager); recordings are never
 * kept. Results tell Atlas who spoke; they never unlock anything.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { averagePrint, bytesToSamples, consistent, ENROL_PHRASES, judge, MIN_SECONDS, SPK, SPK_RATE, type SpeakerPerson, type SpeakerResult, type SpeakerView } from '../shared/speaker.ts'

const MODEL = {
  file: '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
  sha256: '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b',
  bytes: 39_593_761,
}
const KEY_NAME = 'SPEAKER_PROFILE_KEY'

interface Person extends SpeakerPerson {
  print: number[]
}

interface Options {
  enabled: boolean
  wakeOnlyOwner: boolean
}

interface Secrets {
  get(name: string): string | undefined
  set(name: string, value: string): void
}

type Extractor = { createStream(): { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void }; compute(s: unknown): Float32Array }

export class SpeakerService {
  private extractor: Extractor | null = null
  private download: { progress: number; error: string | null } | null = null
  private people: Person[]
  private options: Options

  constructor(
    private readonly deps: {
      dir: string
      secrets: Secrets
      handle: <T>(channel: string, fn: (a: unknown, b: unknown) => T | Promise<T>) => void
      toRenderer: (channel: string, payload: unknown) => void
      requireOwner: () => void
      log: (level: 'info' | 'warn', message: string) => void
      /** Tests only: a stand-in for the voice model. */
      createExtractor?: () => Extractor
    },
  ) {
    mkdirSync(deps.dir, { recursive: true })
    this.people = this.loadPeople()
    this.options = this.loadOptions()
  }

  private get modelPath() {
    return join(this.deps.dir, MODEL.file)
  }

  private modelReady() {
    if (this.deps.createExtractor) return true
    return existsSync(this.modelPath) && statSync(this.modelPath).size === MODEL.bytes
  }

  // ── storage (encrypted) ────────────────────────────────

  private key(): Buffer {
    let k = this.deps.secrets.get(KEY_NAME)
    if (!k) {
      k = randomBytes(32).toString('base64')
      this.deps.secrets.set(KEY_NAME, k)
    }
    return Buffer.from(k, 'base64')
  }

  private loadPeople(): Person[] {
    const file = join(this.deps.dir, 'voices.enc')
    if (!existsSync(file)) return []
    try {
      const raw = readFileSync(file)
      const iv = raw.subarray(0, 12)
      const tag = raw.subarray(12, 28)
      const d = createDecipheriv('aes-256-gcm', this.key(), iv)
      d.setAuthTag(tag)
      return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')) as Person[]
    } catch (e) {
      this.deps.log('warn', `Voice prints could not be read (${(e as Error).message}); enrol again.`)
      return []
    }
  }

  private savePeople() {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key(), iv)
    const body = Buffer.concat([c.update(JSON.stringify(this.people), 'utf8'), c.final()])
    writeFileSync(join(this.deps.dir, 'voices.enc'), Buffer.concat([iv, c.getAuthTag(), body]))
  }

  private loadOptions(): Options {
    try {
      const o = JSON.parse(readFileSync(join(this.deps.dir, 'options.json'), 'utf8')) as Partial<Options>
      return { enabled: o.enabled !== false, wakeOnlyOwner: o.wakeOnlyOwner === true }
    } catch {
      return { enabled: true, wakeOnlyOwner: false }
    }
  }

  view(): SpeakerView {
    return {
      model: {
        status: this.download ? (this.download.error ? 'error' : 'downloading') : this.modelReady() ? 'ready' : 'missing',
        progress: this.download?.progress ?? (this.modelReady() ? 1 : 0),
        error: this.download?.error ?? null,
        bytes: MODEL.bytes,
      },
      people: this.people.map(({ print: _p, ...p }) => p),
      enabled: this.options.enabled,
      wakeOnlyOwner: this.options.wakeOnlyOwner,
    }
  }

  private publish() {
    this.deps.toRenderer(SPK.changed, this.view())
  }

  // ── the model ──────────────────────────────────────────

  private async fetchModel() {
    if (this.modelReady() || this.download) return
    this.download = { progress: 0, error: null }
    this.publish()
    const part = `${this.modelPath}.part`
    try {
      const res = await fetch(MODEL.url, { signal: AbortSignal.timeout(10 * 60_000) })
      if (!res.ok || !res.body) throw new Error(`the download answered ${res.status}`)
      const hash = createHash('sha256')
      let got = 0
      let told = 0
      const counted = Readable.fromWeb(res.body as never).on('data', (c: Buffer) => {
        hash.update(c)
        got += c.length
        if (got - told > MODEL.bytes / 50) {
          told = got
          this.download = { progress: got / MODEL.bytes, error: null }
          this.publish()
        }
      })
      await pipeline(counted, createWriteStream(part))
      if (hash.digest('hex') !== MODEL.sha256) throw new Error('the file did not match its published checksum')
      renameSync(part, this.modelPath)
      this.download = null
    } catch (e) {
      rmSync(part, { force: true })
      this.download = { progress: 0, error: `Could not download the voice model: ${(e as Error).message}.` }
    }
    this.publish()
  }

  private engine(): Extractor {
    if (this.extractor) return this.extractor
    if (this.deps.createExtractor) return (this.extractor = this.deps.createExtractor())
    if (!this.modelReady()) throw new Error('Download the voice model first (Settings › Security › Voice ID).')
    const sherpa = createRequire(import.meta.url)('sherpa-onnx-node') as { SpeakerEmbeddingExtractor: new (c: { model: string; numThreads: number; debug?: boolean }) => Extractor }
    this.extractor = new sherpa.SpeakerEmbeddingExtractor({ model: this.modelPath, numThreads: 2, debug: false })
    return this.extractor
  }

  /** A voice print from 16 kHz mono samples (with enough speech in them). */
  print(samples: Float32Array): number[] {
    if (samples.length < SPK_RATE * MIN_SECONDS) throw new Error('That was too short; say a full sentence.')
    const ex = this.engine()
    const st = ex.createStream()
    st.acceptWaveform({ sampleRate: SPK_RATE, samples })
    st.inputFinished()
    return Array.from(ex.compute(st))
  }

  /** Who said this, among the enrolled people. Unknown when nobody is enrolled or the model is missing. */
  identify(samples: Float32Array): SpeakerResult {
    if (!this.people.length || !this.modelReady()) return { name: null, verdict: 'unsure', score: 0 }
    return judge(this.print(samples), this.people)
  }

  get enabled() {
    return this.options.enabled && this.people.some(p => p.owner) && this.modelReady()
  }

  get wakeOnlyOwner() {
    return this.enabled && this.options.wakeOnlyOwner
  }

  enrol(name: string, owner: boolean, phrases: Float32Array[]) {
    if (phrases.length < ENROL_PHRASES - 2) throw new Error(`Say at least ${ENROL_PHRASES - 2} phrases.`)
    const prints = phrases.map(p => this.print(p))
    if (!consistent(prints)) throw new Error('The phrases did not sound like one voice (noise, or someone else talking). Try again somewhere quieter.')
    const person: Person = { name, owner, phrases: prints.length, created: Date.now(), print: averagePrint(prints) }
    // One owner; a name enrolled again replaces its print.
    this.people = [...this.people.filter(p => p.name.toLowerCase() !== name.toLowerCase() && !(owner && p.owner)), person]
    this.savePeople()
  }

  register() {
    const { handle, requireOwner } = this.deps
    handle(SPK.state, () => this.view())
    handle(SPK.download, () => {
      requireOwner()
      void this.fetchModel()
      return this.view()
    })
    handle(SPK.enrol, (name, raw) => {
      requireOwner()
      const r = (raw ?? {}) as { owner?: unknown; phrases?: unknown }
      const n = typeof name === 'string' ? name.trim().slice(0, 40) : ''
      if (!n) throw new Error('Whose voice is it? Give a name.')
      if (!Array.isArray(r.phrases) || r.phrases.length > 10 || !r.phrases.every(p => p instanceof Uint8Array && p.byteLength <= SPK_RATE * 4 * 20)) throw new Error('Record the phrases again.')
      this.enrol(n, r.owner === true, r.phrases.map(p => bytesToSamples(p as Uint8Array)))
      this.publish()
      return this.view()
    })
    handle(SPK.identify, raw => {
      if (!(raw instanceof Uint8Array) || raw.byteLength > SPK_RATE * 4 * 30) throw new Error('Say a sentence to check.')
      return this.identify(bytesToSamples(raw))
    })
    handle(SPK.forget, name => {
      requireOwner()
      this.people = typeof name === 'string' ? this.people.filter(p => p.name !== name) : []
      this.savePeople()
      this.publish()
      return this.view()
    })
    handle(SPK.setOptions, raw => {
      requireOwner()
      const o = (raw ?? {}) as { enabled?: unknown; wakeOnlyOwner?: unknown }
      if (typeof o.enabled === 'boolean') this.options.enabled = o.enabled
      if (typeof o.wakeOnlyOwner === 'boolean') this.options.wakeOnlyOwner = o.wakeOnlyOwner
      writeFileSync(join(this.deps.dir, 'options.json'), JSON.stringify(this.options))
      this.publish()
      return this.view()
    })
  }
}

/** Where the model and prints live: <data>/voice-id. */
export const speakerDir = (userData: string) => join(userData, 'voice-id')
