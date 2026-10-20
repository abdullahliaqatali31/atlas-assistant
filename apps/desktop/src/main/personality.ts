/**
 * IPC for onboarding and Setup › Personality. Main validates every payload,
 * forwards profile ops to the runtime host (which owns the database) and
 * writes exports through a save dialog; the renderer never touches a file.
 */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { app, dialog, type BrowserWindow } from 'electron'

import { parseVoice } from '../shared/ipc.ts'
import {
  parseProfilePatch,
  parseReason,
  PC,
  promptText,
  type PersonalityHostEvent,
  type PersonalityHostRequest,
  type PersonalityOp,
  type PersonalityView,
} from '../shared/personality.ts'

export interface PersonalityIpcDeps {
  /** Registers a handler that already checks the sender frame. */
  handle: <T>(channel: string, fn: (arg: unknown, arg2: unknown) => T | Promise<T>) => void
  /** False when the runtime host is not running. */
  post: (msg: PersonalityHostRequest) => boolean
  isReady: () => boolean
  speechAvailable: () => boolean
  toRenderer: (channel: string, payload: unknown) => void
  window: () => BrowserWindow | null
  /** Every profile seen (the assistant's name lives in it). */
  onView?: (view: PersonalityView) => void
}

const TIMEOUT_MS = 10_000

export const registerPersonalityIpc = (deps: PersonalityIpcDeps) => {
  const pending = new Map<string, (e: PersonalityHostEvent) => void>()

  const ask = (msg: { type: 'personality'; op: PersonalityOp } | { type: 'transcribe'; audio: Uint8Array; mime: string }, timeoutMs = TIMEOUT_MS) =>
    new Promise<PersonalityHostEvent>((resolve, reject) => {
      if (!deps.isReady()) return reject(new Error('The assistant is not ready yet.'))
      const requestId = randomUUID()
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('The runtime did not answer in time.'))
      }, timeoutMs)
      pending.set(requestId, e => {
        clearTimeout(timer)
        resolve(e)
      })
      if (!deps.post({ ...msg, requestId } as PersonalityHostRequest)) {
        clearTimeout(timer)
        pending.delete(requestId)
        reject(new Error('The runtime is not running.'))
      }
    })

  const op = async (o: PersonalityOp): Promise<PersonalityView> => {
    const e = await ask({ type: 'personality', op: o })
    if (e.type !== 'personality' || !e.view) throw new Error(e.error ?? 'The profile could not be changed.')
    // Every view the owner caused goes to the renderer, so Setup and the companion agree.
    deps.toRenderer(PC.changed, e.view)
    deps.onView?.(e.view)
    return e.view
  }

  deps.handle(PC.get, () => (deps.isReady() ? op({ kind: 'get' }) : null))
  deps.handle(PC.update, (patch, reason) => {
    const p = parseProfilePatch(patch)
    const r = parseReason(reason)
    if (!p || !r) throw new Error('Invalid personality values.')
    return op({ kind: 'update', patch: p, reason: r })
  })
  deps.handle(PC.undo, () => op({ kind: 'undo' }))
  deps.handle(PC.reset, () => op({ kind: 'reset' }))
  deps.handle(PC.setOnboarded, done => {
    if (typeof done !== 'boolean') throw new Error('Expected true or false.')
    return op({ kind: 'onboarded', done })
  })
  deps.handle(PC.exportFile, async () => {
    const e = await ask({ type: 'personality', op: { kind: 'export' } })
    if (e.type !== 'personality' || !e.exported) throw new Error(e.type === 'personality' ? (e.error ?? 'Export failed.') : 'Export failed.')
    const win = deps.window()
    const options = {
      title: 'Export personality',
      defaultPath: `${app.getPath('documents')}/assistant-personality.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return { saved: false }
    writeFileSync(filePath, e.exported)
    return { saved: true }
  })
  deps.handle(PC.speakPrompt, (step, language) => {
    const text = promptText(step, language)
    if (text === null) throw new Error('Unknown onboarding question.')
    if (!deps.isReady() || !deps.speechAvailable()) return null
    const replyId = randomUUID()
    return deps.post({ type: 'speak-prompt', replyId, text }) ? { replyId } : null
  })
  /** Speech-to-text only; the text comes back here and never reaches the model. */
  const transcribe = async (audio: unknown, mime: unknown) => {
    const voice = parseVoice(audio, mime)
    if (!voice) throw new Error('Recording must be audio under 5 MB.')
    if (!deps.speechAvailable()) throw new Error('No voice provider is configured; type instead.')
    const e = await ask({ type: 'transcribe', ...voice }, 30_000)
    if (e.type !== 'transcript' || e.text === undefined) throw new Error((e.type === 'transcript' && e.error) || 'Could not transcribe.')
    return e.text
  }
  deps.handle(PC.transcribe, transcribe)

  /** Speaks fixed text (onboarding questions, the identity challenge); null when speech is off. */
  const speakFixed = (text: string) => {
    if (!deps.isReady() || !deps.speechAvailable()) return null
    const replyId = randomUUID()
    return deps.post({ type: 'speak-prompt', replyId, text }) ? { replyId } : null
  }
  deps.handle(PC.welcome, () => {
    if (!deps.isReady()) throw new Error('The assistant is not ready yet.')
    const replyId = randomUUID()
    if (!deps.post({ type: 'welcome', replyId })) throw new Error('The runtime is not running.')
    return { replyId }
  })

  return {
    transcribe,
    speakFixed,
    /** Read the profile now (when the runtime has just become ready). */
    refresh: () => (deps.isReady() ? op({ kind: 'get' }).then(() => undefined, () => undefined) : Promise.resolve()),
    /** Host answers, routed by request id. */
    onHostEvent(e: PersonalityHostEvent) {
      pending.get(e.requestId)?.(e)
      pending.delete(e.requestId)
    },
  }
}
