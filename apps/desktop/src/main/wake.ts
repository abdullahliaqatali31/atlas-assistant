/**
 * Wake word, main side: the owner's settings, the one-time model download
 * (on request only, with progress) and a private scheme that serves the
 * downloaded model files to the companion window. The renderer itself has
 * no network access.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'

import { app, net } from './host/index.ts'

import { DEFAULT_WAKE, LEGACY_MODEL_IDS, MODEL_BYTES, MODEL_FILES, MODEL_ID, MODEL_REPO, parseWakePatch, WC, type ModelState, type WakeSettings, type WakeView } from '../shared/wake.ts'

/** Lets fetch() in the renderer read assistant-model:// URLs; registered with the other schemes before app 'ready'. */

export interface WakeDeps {
  handle: <T>(channel: string, fn: (arg: unknown, arg2: unknown) => T | Promise<T>) => void
  toRenderer: (channel: string, payload: unknown) => void
}

export class WakeService {
  private readonly settingsFile = join(app.getPath('userData'), 'wake.json')
  private readonly modelDir = join(app.getPath('userData'), 'models', MODEL_ID)
  private settings: WakeSettings
  private model: ModelState
  private downloading: Promise<void> | null = null

  constructor(private readonly deps: WakeDeps) {
    this.settings = this.load()
    for (const old of LEGACY_MODEL_IDS) rmSync(join(app.getPath('userData'), 'models', old), { recursive: true, force: true })
    this.model = this.modelOnDisk()
  }

  private load(): WakeSettings {
    try {
      const raw = parseWakePatch(JSON.parse(readFileSync(this.settingsFile, 'utf8')))
      return { ...DEFAULT_WAKE, ...raw }
    } catch {
      return { ...DEFAULT_WAKE }
    }
  }

  private save() {
    mkdirSync(dirname(this.settingsFile), { recursive: true })
    writeFileSync(this.settingsFile, JSON.stringify(this.settings))
  }

  private modelOnDisk(): ModelState {
    let bytes = 0
    for (const f of MODEL_FILES) {
      const p = join(this.modelDir, f.path)
      if (!existsSync(p)) return { status: 'missing' }
      bytes += statSync(p).size
    }
    return { status: 'ready', bytes }
  }

  view(): WakeView {
    return { ...this.settings, model: this.model, modelBytes: MODEL_BYTES }
  }

  private publish() {
    this.deps.toRenderer(WC.changed, this.view())
  }

  /** Serves files from the model folder only (assistant-model://models/…); anything else is 404. */
  serve(url: URL): Response {
    // assistant-model://models/moonshine-tiny/onnx/encoder_model_quantized.onnx
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const base = join(app.getPath('userData'), 'models')
    const file = normalize(join(base, url.hostname === 'models' ? rel : '__none__'))
    if (!file.startsWith(base + sep) || !existsSync(file)) return new Response('Not found', { status: 404 })
    return new Response(readFileSync(file), { headers: { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream' } })
  }

  register() {
    this.deps.handle(WC.get, () => this.view())
    this.deps.handle(WC.update, patch => {
      const p = parseWakePatch(patch)
      if (!p) throw new Error('Invalid wake word settings.')
      if (p.enabled && this.model.status !== 'ready') throw new Error('Download the speech model first.')
      this.settings = { ...this.settings, ...p }
      this.save()
      this.publish()
      return this.view()
    })
    this.deps.handle(WC.downloadModel, async () => {
      await this.download()
      return this.view()
    })
    this.deps.handle(WC.deleteModel, () => {
      rmSync(this.modelDir, { recursive: true, force: true })
      this.settings = { ...this.settings, enabled: false }
      this.save()
      this.model = { status: 'missing' }
      this.publish()
      return this.view()
    })
  }

  private download() {
    if (this.model.status === 'ready') return Promise.resolve()
    this.downloading ??= this.fetchAll().finally(() => (this.downloading = null))
    return this.downloading
  }

  private async fetchAll() {
    let received = 0
    const report = () => {
      this.model = { status: 'downloading', received, total: MODEL_BYTES }
      this.publish()
    }
    report()
    try {
      for (const f of MODEL_FILES) {
        const target = join(this.modelDir, f.path)
        if (existsSync(target) && statSync(target).size === f.bytes) {
          received += f.bytes
          report()
          continue
        }
        mkdirSync(dirname(target), { recursive: true })
        const res = await net.fetch(`https://huggingface.co/${MODEL_REPO}/resolve/main/${f.path}`)
        if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${f.path}`)
        const tmp = `${target}.part`
        const out = createWriteStream(tmp)
        const reader = res.body.getReader()
        let last = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!out.write(value)) await new Promise<void>(r => out.once('drain', () => r()))
          received += value.length
          if (received - last > 512 * 1024) {
            last = received
            report()
          }
        }
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
        renameSync(tmp, target)
      }
      this.model = this.modelOnDisk()
    } catch (error) {
      this.model = { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    this.publish()
  }
}
