/**
 * Barge-in on the main side (plan sections 12.1 and 17: interrupt to
 * playback stop under 250 ms). When the owner talks over a reply, main tells
 * the renderer to stop playback at once and, from then on, drops every audio
 * event of that reply that was still in flight from the runtime host, so
 * queued sentences can never start playing after the interruption. The host
 * aborts the reply's cancellation token in parallel. No Electron imports.
 */
import type { ReplyEvent } from '../shared/ipc.ts'

const KEEP = 20

export class AudioGate {
  /** Replies the owner cut off, oldest first; bounded. */
  private readonly cut: string[] = []
  private lastCutAt: number | null = null

  constructor(private readonly now: () => number = Date.now) {}

  /** Stop forwarding audio for this reply. Returns false when there was nothing to cut. */
  interrupt(replyId: string | null): boolean {
    if (!replyId) return false
    this.lastCutAt = this.now()
    if (!this.cut.includes(replyId)) {
      this.cut.push(replyId)
      if (this.cut.length > KEEP) this.cut.shift()
    }
    return true
  }

  /** False for spoken audio of an interrupted reply; text and 'done' still pass so the transcript stays whole. */
  allows(e: ReplyEvent): boolean {
    return !(e.type === 'audio' && this.cut.includes(e.replyId))
  }

  /** When the owner last interrupted, for diagnostics. */
  get lastInterruptAt() {
    return this.lastCutAt
  }
}
