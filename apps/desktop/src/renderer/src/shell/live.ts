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

/** Stop Atlas from anywhere in the window (the presence pill): the conversation decides what stopping means now. */
export const STOP_EVENT = 'atlas:stop'

/**
 * "Open the News page on this tab, at this story" (the glass panel handing
 * over to the app). The page loads on demand, so the request waits here
 * until it is ready to take it.
 */
export const NEWS_FOCUS_EVENT = 'atlas:news-focus'
let pendingNews: { tab: string; focus: string | null } | null = null
export const requestNewsFocus = (r: { tab: string; focus: string | null }) => {
  pendingNews = r
  window.dispatchEvent(new Event(NEWS_FOCUS_EVENT))
}
export const takeNewsFocus = () => {
  const r = pendingNews
  pendingNews = null
  return r
}
