/**
 * Open tasks, fetched once for every part of the window that shows them (the
 * rail, alerts, Home, the Today card): one 60 s poll while anything is
 * watching, paused while the window is hidden, fetched again when it shows.
 */
import { useEffect, useSyncExternalStore } from 'react'

import type { TaskView } from '../../../shared/ipc.ts'

let tasks: TaskView[] | null = null
const subs = new Set<() => void>()
let inflight: Promise<void> | null = null
let users = 0
let timer = 0

const set = (next: TaskView[]) => {
  tasks = next
  for (const s of subs) s()
}

/** Fetch now; callers asking at the same moment share one request. */
export const refreshTasks = (): Promise<void> => {
  inflight ??= window.assistant
    .listTasks()
    .then(set, () => undefined)
    .finally(() => (inflight = null))
  return inflight
}

const startTimer = () => {
  clearInterval(timer)
  timer = window.setInterval(() => void refreshTasks(), 60_000)
}

const onVisible = () => {
  if (document.hidden) return clearInterval(timer)
  void refreshTasks()
  startTimer()
}

const watch = () => {
  if (users++ > 0) return
  if (!document.hidden) startTimer()
  document.addEventListener('visibilitychange', onVisible)
}

const unwatch = () => {
  if (--users > 0) return
  clearInterval(timer)
  document.removeEventListener('visibilitychange', onVisible)
}

const subscribe = (fn: () => void) => {
  subs.add(fn)
  return () => void subs.delete(fn)
}

/**
 * The shared task list (null until first fetched). While `active`, it is kept
 * current; `key` changing (say, something held back for later) fetches again.
 */
export const useTasks = (active: boolean, key?: unknown): TaskView[] | null => {
  useEffect(() => {
    if (!active) return
    watch()
    return unwatch
  }, [active])
  useEffect(() => {
    if (active) void refreshTasks()
  }, [active, key])
  return useSyncExternalStore(subscribe, () => tasks)
}
