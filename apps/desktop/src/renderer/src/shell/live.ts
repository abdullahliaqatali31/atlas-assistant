/**
 * The conversation's live state (newest reply, voice), shared with the Ask
 * bar and the rail's hover card through a tiny store, so a moving mic level
 * re-renders only the bar and never the whole shell.
 */
import { useSyncExternalStore } from 'react'

/** Window events the floating Ask bar uses to talk through the conversation. */
export const ASK_EVENT = 'atlas:ask'
export const MIC_EVENT = 'atlas:mic'
/** Focus the Ask bar from anywhere (the "/" shortcut and the command palette). */
export const FOCUS_ASK_EVENT = 'atlas:focus-ask'

export interface LiveState {
  replyId: string | null
  text: string
  replying: boolean
  listening: boolean
  transcribing: boolean
  speaking: boolean
  level: number
  error: string
}

let current: LiveState | null = null
const subs = new Set<() => void>()

export const publishLive = (next: LiveState) => {
  current = next
  for (const s of subs) s()
}

const subscribe = (fn: () => void) => {
  subs.add(fn)
  return () => void subs.delete(fn)
}

export const useLive = () => useSyncExternalStore(subscribe, () => current)
