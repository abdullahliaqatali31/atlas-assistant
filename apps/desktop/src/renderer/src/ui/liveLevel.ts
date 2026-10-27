/**
 * The microphone or voice level, for the orbs that pulse with it. It changes
 * many times a second while Atlas listens, so it lives here and not in the
 * app's state: only the orbs re-render with it, never the pages around them.
 */
import { useSyncExternalStore } from 'react'

let level = 0
const subs = new Set<() => void>()

export const setLiveLevel = (v: number) => {
  // Steps of 0.04: finer than the eye sees on an orb, and it skips most no-change updates.
  const next = Math.round(Math.max(0, Math.min(1, v)) * 25) / 25
  if (next === level) return
  level = next
  for (const s of subs) s()
}

export const useLiveLevel = () =>
  useSyncExternalStore(
    cb => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => level,
  )
