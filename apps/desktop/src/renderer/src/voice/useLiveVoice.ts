import { useCallback, useEffect, useRef, useState } from 'react'

import type { ApprovalRequest, ReplyEvent } from '../../../shared/ipc.ts'
import { setMicLevel } from '../shell/micLevel.ts'
import { LiveCall, type LivePhase } from './live.ts'

/** The final text of one reply, collected from its chunks. */
const finalText = (replyId: string) =>
  new Promise<string>(resolve => {
    let acc = ''
    const off = window.assistant.onReply((e: ReplyEvent) => {
      if (e.replyId !== replyId) return
      if (e.type === 'chunk') acc += e.text
      if (e.type === 'done') {
        off()
        resolve(e.error ? `It did not work: ${e.error}` : e.stopped ? 'The owner stopped it.' : acc.trim() || 'Done.')
      }
    })
  })

/** Resolves with the first approval Atlas raises that was not already waiting. */
const nextApproval = (known: Set<string>) => {
  let off = () => {}
  const p = new Promise<ApprovalRequest>(resolve => {
    off = window.assistant.onStatus(s => {
      const fresh = s.approvals.find(a => !known.has(a.id))
      if (fresh) resolve(fresh)
    })
  })
  return { p, off: () => off() }
}

/**
 * Live voice in the conversation: start and stop a call, what it is doing,
 * what was heard and said, what it has cost. ask_atlas runs the request as an
 * ordinary message (so it shows in the chat and passes the permission gate);
 * if Atlas stops to ask for a yes, the question goes back to the voice at
 * once, and the owner's spoken answer finishes the waiting reply.
 */
export function useLiveVoice(opts: { assistantName: string; show: (replyId: string, text: string) => void; approvals: () => ApprovalRequest[] }) {
  const [active, setActive] = useState(false)
  const [phase, setPhase] = useState<LivePhase>('connecting')
  // The level goes to the mic store (shell/micLevel.ts), not React state: it changes many times a second.
  const [heard, setHeard] = useState('')
  const [said, setSaid] = useState('')
  const [cost, setCost] = useState(0)
  const [error, setError] = useState('')
  const call = useRef<LiveCall | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts
  /** A reply that paused for the owner's yes: its answer is still to come. */
  const waiting = useRef<Promise<string> | null>(null)

  const ask = useCallback(async (request: string): Promise<string> => {
    const known = new Set(optsRef.current.approvals().map(a => a.id))
    const { replyId } = await window.assistant.send(request)
    optsRef.current.show(replyId, request)
    const own = finalText(replyId)
    const approval = nextApproval(known)
    const first = await Promise.race([own.then(text => ({ kind: 'done' as const, text })), approval.p.then(a => ({ kind: 'ask' as const, a }))])
    approval.off()
    if (first.kind === 'ask') {
      waiting.current = own
      return `Atlas needs the owner's yes first: ${first.a.question ?? `may it use ${first.a.tool}?`} Ask them plainly, then call ask_atlas with their answer.`
    }
    const earlier = waiting.current
    if (earlier) {
      // That was the yes or no for a waiting reply: its answer is what to say.
      waiting.current = null
      return `${first.text} ${await earlier}`.trim()
    }
    return first.text
  }, [])

  const start = useCallback(async () => {
    if (call.current) return
    setError('')
    setHeard('')
    setSaid('')
    setCost(0)
    setPhase('connecting')
    setActive(true)
    try {
      const session = await window.assistant.liveSession(optsRef.current.assistantName)
      const c = new LiveCall(session, {
        onPhase: setPhase,
        onHeard: t => {
          setHeard(t)
          setSaid('')
        },
        onSaid: t => setSaid(t),
        onLevel: setMicLevel,
        onCost: setCost,
        onAsk: ask,
        onEnd: reason => {
          call.current = null
          waiting.current = null
          setActive(false)
          setMicLevel(0)
          if (reason) setError(reason)
        },
      })
      call.current = c
      await c.start()
    } catch (e) {
      call.current?.stop(null)
      call.current = null
      setActive(false)
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Live voice could not start.')
    }
  }, [ask])

  const stop = useCallback(() => call.current?.stop(null), [])
  const cancel = useCallback(() => call.current?.cancel(), [])
  useEffect(() => () => call.current?.stop(null), [])

  return { active, phase, heard, said, cost, error, start, stop, cancel, clearError: () => setError('') }
}
