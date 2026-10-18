/**
 * Atlas's own window, runtime side: one line in every turn's context saying
 * what the window shows, and two tools to look at and change it (page,
 * conversation, size, compact mode, keep on top). Changing its own window is
 * harmless, so it runs without asking, but only when the owner wants it.
 */
import { randomUUID } from 'node:crypto'

import type { Rule } from '@assistant/policy'
import type { RuntimeTool } from '@assistant/runtime'

import { describeUi, VIEWS, WINDOW_SIZES, type UiChange, type UiOp, type UiState } from '../shared/ui.ts'

const REQUEST_TIMEOUT_MS = 30_000

export const UI_RULES: Rule[] = [
  { id: 'default-ui_state', tool: 'ui_state', actionClass: 'observe', effect: 'allow' },
  { id: 'default-ui_control', tool: 'ui_control', actionClass: 'modify', effect: 'allow' },
]

export class HostUi {
  private snapshot: UiState | null = null
  private readonly pending = new Map<string, (r: { result?: string | undefined; error?: string | undefined }) => void>()

  constructor(private readonly deps: { post: (e: { type: 'ui'; requestId: string; op: UiOp }) => void }) {}

  setSnapshot(s: UiState) {
    this.snapshot = s
  }

  contextLines(): string[] {
    return this.snapshot ? [`Your own window (the Atlas app): ${describeUi(this.snapshot)} You can change it with ui_control when the owner asks.`] : []
  }

  onResult(requestId: string, result?: string, error?: string) {
    this.pending.get(requestId)?.({ result, error })
    this.pending.delete(requestId)
  }

  private request(op: UiOp, signal?: AbortSignal): Promise<string> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The window did not answer in time.'))
      }, REQUEST_TIMEOUT_MS)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new Error('Stopped.'))
      }, { once: true })
      this.pending.set(requestId, r => {
        clearTimeout(timer)
        if (r.error) reject(new Error(r.error))
        else resolve(r.result ?? '')
      })
      this.deps.post({ type: 'ui', requestId, op })
    })
  }

  tools(): RuntimeTool[] {
    return [
      {
        name: 'ui_state',
        description: 'What your own Atlas window shows right now: page, conversation open or hidden, compact mode, size and layout, kept on top or not.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        actionClass: 'observe',
        isUntrusted: false,
        run: (_i, signal) => this.request({ kind: 'state' }, signal),
      },
      {
        name: 'ui_control',
        description:
          'Change your own Atlas window when the owner asks ("compact ho jao", "news dikhao", "chat band karo", "bari window kar do", "upar rakho"), or after offering it and hearing yes. Do not rearrange it on your own. view: which page; chat: show or hide the conversation; size: compact (small chat-only window in the corner), normal, large, maximized or minimized; pinned: keep above other windows. Opening a page leaves compact mode.',
        inputSchema: {
          type: 'object',
          properties: {
            view: { type: 'string', enum: [...VIEWS] },
            chat: { type: 'boolean' },
            size: { type: 'string', enum: [...WINDOW_SIZES] },
            pinned: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        actionClass: 'modify',
        isUntrusted: false,
        run: (input, signal) => {
          const change: UiChange = {
            view: typeof input.view === 'string' ? (input.view as UiChange['view']) : undefined,
            chat: typeof input.chat === 'boolean' ? input.chat : undefined,
            size: typeof input.size === 'string' ? (input.size as UiChange['size']) : undefined,
            pinned: typeof input.pinned === 'boolean' ? input.pinned : undefined,
          }
          if (Object.values(change).every(v => v === undefined)) return Promise.reject(new Error('Say what to change: view, chat, size or pinned.'))
          return this.request({ kind: 'set', change }, signal)
        },
      },
    ]
  }
}
