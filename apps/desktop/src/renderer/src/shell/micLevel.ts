/**
 * The microphone level while the conversation records (0–1, about 25 times a
 * second). Kept out of React state: only what draws it (the level bars, the
 * orbs, the desktop widget) hears about each change, never the transcript.
 */
import { useSyncExternalStore } from 'react'

let level = 0
const subs = new Set<() => void>()

export const setMicLevel = (v: number) => {
  if (v === level) return
  level = v
  for (const s of subs) s()
}

export const getMicLevel = () => level

export const subscribeMicLevel = (fn: () => void) => {
  subs.add(fn)
  return () => void subs.delete(fn)
}

export const useMicLevel = () => useSyncExternalStore(subscribeMicLevel, getMicLevel)
