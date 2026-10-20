/**
 * The assistant's name as the owner chose it (Settings › Personality, or
 * onboarding), "Atlas" until one is set. Everything on screen that names
 * the assistant reads it here: the app's root subscribes (useAssistantName),
 * so pages re-render when it changes and can read it with nameOf().
 */
import { useSyncExternalStore } from 'react'

export const DEFAULT_NAME = 'Atlas'

let name = DEFAULT_NAME
const subs = new Set<() => void>()

const set = (n: string | undefined | null) => {
  const next = n?.trim() || DEFAULT_NAME
  if (next === name) return
  name = next
  for (const s of subs) s()
}

let started = false
/** Read the name once and follow changes (safe to call more than once). */
const start = () => {
  if (started || typeof window === 'undefined' || !window.personality) return
  started = true
  // Null until the runtime is ready: ask again a little later.
  const read = (left: number) =>
    void window.personality.get().then(
      v => (v ? set(v.profile.assistantName) : left > 0 && setTimeout(() => read(left - 1), 3000)),
      () => left > 0 && setTimeout(() => read(left - 1), 3000),
    )
  read(40)
  window.personality.onChanged(v => set(v.profile.assistantName))
}

/** The name now (for text inside components that re-render with the app). */
export const nameOf = () => {
  start()
  return name
}

/** The name, re-rendering when the owner changes it. */
export const useAssistantName = () => {
  start()
  return useSyncExternalStore(
    cb => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => name,
  )
}

/** "Atlas's" or "Lala's". */
export const possessive = (n: string) => (/s$/i.test(n) ? `${n}’` : `${n}’s`)
