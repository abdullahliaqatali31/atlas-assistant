import { useEffect, useState } from 'react'

import type { PlaceStatus } from '../../../shared/world.ts'
import { STATE_LABEL, useNow, type Presence } from '../Jarvis.tsx'
import { Orb, type OrbState } from '../ui/Orb.tsx'

/**
 * The corner widget (bottom left of the World stage): a small orb, the time,
 * and the weather and air at the first watched place. Click: back to Home.
 */
export function CornerWidget({ state, presence, onHome }: { state: OrbState; presence: Presence; onHome: () => void }) {
  const now = useNow(15_000)
  const [place, setPlace] = useState<PlaceStatus | null>(null)
  useEffect(() => {
    const pick = (w: { places: PlaceStatus[] }) => setPlace(w.places[0] ?? null)
    void window.world.state().then(pick, () => undefined)
    return window.world.onChanged(pick)
  }, [])
  const w = place?.weather
  const aqi = place?.air?.aqi
  return (
    <button
      type="button"
      onClick={onHome}
      title={`${STATE_LABEL[state]} · back to Home`}
      aria-label={`Atlas is ${STATE_LABEL[state].toLowerCase()}. Back to Home`}
      className="map-chip pointer-events-auto h-11 gap-2 rounded-2xl pl-1 pr-3 shadow-xl"
    >
      <Orb state={state} level={presence.level} size={36} />
      <span className="flex flex-col items-start leading-tight">
        <span className="font-mono text-sm tabular-nums">{new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        {place && (
          <span className="text-[10px] text-muted">
            {place.place.name}
            {w ? ` · ${Math.round(w.temp)}°` : ''}
            {aqi !== undefined && <span className={aqi > 150 ? 'text-danger' : aqi > 100 ? 'text-warm' : ''}> · AQI {aqi}</span>}
          </span>
        )}
      </span>
    </button>
  )
}
