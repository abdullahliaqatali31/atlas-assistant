/**
 * The brain's data: the view from the runtime, which memories a turn is
 * using right now (they flare) and which were just saved (they are born).
 * Refetched when a memory is saved or forgotten, and every few minutes.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { BrainView, MemoryUseWhy } from '../../../shared/brain.ts'

export interface InMind {
  id: string
  why: MemoryUseWhy
  at: number
}

export const useBrain = (ready: boolean) => {
  const [view, setView] = useState<BrainView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [used, setUsed] = useState<ReadonlyMap<string, number>>(new Map())
  const [born, setBorn] = useState<ReadonlyMap<string, number>>(new Map())
  const [recent, setRecent] = useState<InMind[]>([])
  const known = useRef(new Set<string>())

  const apply = useCallback((v: BrainView | null) => {
    if (!v) return
    // Anything new since the last look is born now (but not on the first load).
    if (known.current.size) {
      const fresh = v.nodes.filter(n => !known.current.has(n.id)).map(n => n.id)
      if (fresh.length) setBorn(prev => new Map([...prev, ...fresh.map(id => [id, Date.now()] as const)]))
    }
    known.current = new Set(v.nodes.map(n => n.id))
    setView(v)
    setError(null)
  }, [])

  const load = useCallback(() => {
    if (!ready) return
    window.brain.view().then(apply, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [ready, apply])

  useEffect(() => {
    load()
    const t = setInterval(() => !document.hidden && load(), 180_000)
    const off = window.brain.onUsed(({ ids, why }) => {
      const at = Date.now()
      setUsed(prev => new Map([...prev, ...ids.map(id => [id, at] as const)]))
      setRecent(prev => [...ids.map(id => ({ id, why, at })), ...prev.filter(r => !ids.includes(r.id))].slice(0, 12))
      // A saved memory (or one the brain has not seen yet) means the graph changed.
      if (why === 'saved' || ids.some(id => !known.current.has(id))) setTimeout(load, 400)
    })
    return () => {
      clearInterval(t)
      off()
    }
  }, [load])

  const forget = useCallback(
    async (id: string) => {
      const v = await window.brain.forget(id)
      apply(v)
      setRecent(prev => prev.filter(r => r.id !== id))
    },
    [apply],
  )

  return { view, error, used, born, recent, forget, reload: load }
}
