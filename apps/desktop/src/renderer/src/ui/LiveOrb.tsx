import { useLiveLevel } from './liveLevel.ts'
import { Orb, type OrbState } from './Orb.tsx'

/** An orb that pulses with the live voice level (subscribes on its own, so its parents do not re-render). */
export function LiveOrb({ state, size }: { state: OrbState; size: number }) {
  const level = useLiveLevel()
  return <Orb state={state} level={state === 'listening' || state === 'speaking' ? level : 0} size={size} />
}
