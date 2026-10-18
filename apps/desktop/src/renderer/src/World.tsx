import { Info, MapPin, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

import { ATTRIBUTION, EMPTY_WORLD, type PlaceStatus, type WorldSnapshot } from '../../shared/world.ts'
import { ago, useNow } from './Jarvis.tsx'
import { cleanError } from './world/geo.ts'
import type { NearbyItem } from './world/hover.ts'
import { Inspector, type Selected } from './world/Inspector.tsx'
import { MapView, type MapPrefs } from './world/MapView.tsx'
import { readMapPrefs, saveMapPrefs, styleCredit } from './world/styles.ts'

/**
 * World: the map fills the stage. A floating toolbar adds places and switches
 * layers; your places sit as chips; picking anything opens the Inspector
 * (left, or a bottom sheet on narrow windows). Atlas speaks up on its own
 * when something serious happens near one of your places.
 */
export function WorldPage() {
  const now = useNow(60_000)
  const [world, setWorld] = useState<WorldSnapshot>(EMPTY_WORLD)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Selected | null>(null)
  const [nearby, setNearby] = useState<NearbyItem[]>([])
  const [focus, setFocus] = useState<{ lngLat: [number, number]; zoom?: number; n: number } | null>(null)
  const [info, setInfo] = useState(false)
  const [prefs, setPrefs] = useState<MapPrefs>(readMapPrefs)
  const changePrefs = (p: MapPrefs) => {
    setPrefs(p)
    saveMapPrefs(p)
  }

  useEffect(() => {
    void window.world.state().then(setWorld, err => setError(cleanError(err)))
    return window.world.onChanged(setWorld)
  }, [])

  // Esc closes the Inspector first.
  useEffect(() => {
    if (!selected) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      e.stopImmediatePropagation()
      setSelected(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selected])

  const run = async (fn: () => Promise<WorldSnapshot>) => {
    setBusy(true)
    setError('')
    try {
      setWorld(await fn())
      return true
    } catch (err) {
      setError(cleanError(err))
      return false
    } finally {
      setBusy(false)
    }
  }
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    void run(() => window.world.add(name.trim())).then(ok => ok && setName(''))
  }
  const pickPlace = (s: PlaceStatus) => {
    const lngLat: [number, number] = [s.place.lon, s.place.lat]
    setSelected({ kind: 'places', lngLat, props: { id: s.place.id, title: s.place.name } })
    setFocus({ lngLat, zoom: 7, n: Date.now() })
  }

  const toolbar = (mapControls: ReactNode) => (
    <div className="pointer-events-none absolute left-2 right-12 top-2 z-10 flex flex-wrap items-center gap-1.5">
      <form onSubmit={add} className="map-chip pointer-events-auto w-[min(15rem,100%)] pr-1 focus-within:border-accent/60">
        <MapPin className="size-3.5 shrink-0 text-accent" aria-hidden />
        <input className="bare-input min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted" placeholder="Watch a city…" value={name} onChange={e => setName(e.target.value)} aria-label="Add a place to watch" />
        {name.trim() && (
          <button type="submit" className="grid size-6 place-items-center rounded-full bg-accent text-black" disabled={busy} aria-label="Watch this place">
            {busy ? <RefreshCw className="size-3 animate-spin" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
          </button>
        )}
      </form>
      <span className="pointer-events-auto flex gap-1.5">{mapControls}</span>
      <div className="no-scrollbar pointer-events-auto flex min-w-0 max-w-full gap-1.5 overflow-x-auto @max-[520px]:order-last @max-[520px]:basis-full">
        {world.places.map(s => (
          <button
            key={s.place.id}
            type="button"
            onClick={() => pickPlace(s)}
            className={`map-chip shrink-0 ${selected?.kind === 'places' && selected.props.id === s.place.id ? 'border-accent text-accent' : ''}`}
            title={s.weather ? `${s.place.name}: ${s.weather.summary}` : s.place.name}
          >
            <span className={`size-1.5 rounded-full ${s.nearby.length || (s.air?.aqi ?? 0) > 150 ? 'bg-warm' : 'bg-accent'}`} aria-hidden />
            {s.place.name}
            {s.weather && <span className="font-mono text-[10px] text-muted">{Math.round(s.weather.temp)}°</span>}
          </button>
        ))}
      </div>
      <span className="pointer-events-auto ml-auto flex gap-1.5">
        <button type="button" className="map-chip px-2" onClick={() => void run(() => window.world.refresh())} disabled={busy} aria-label="Refresh world data" title="Refresh">
          <RefreshCw className={`size-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden />
        </button>
        <button type="button" className={`map-chip px-2 ${info ? 'border-accent text-accent' : ''}`} onClick={() => setInfo(i => !i)} aria-expanded={info} aria-label="Sources and status" title="Sources and status">
          <Info className="size-3.5" aria-hidden />
        </button>
      </span>
    </div>
  )

  return (
    <div className="@container relative h-full min-h-0">
      <MapView world={world} selected={selected} onSelect={setSelected} focus={focus} prefs={prefs} onPrefs={changePrefs} toolbar={toolbar} now={now} onNearby={setNearby} />

      {error && (
        <p role="alert" className="ask-pop glass absolute left-1/2 top-14 z-20 max-w-[90%] -translate-x-1/2 rounded-lg bg-solid/90 px-3 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}

      {world.places.length === 0 && !selected && (
        <p className="glass pointer-events-none absolute left-2 top-14 z-10 w-[min(300px,calc(100%-1rem))] rounded-xl bg-solid/85 px-3 py-2 text-xs text-muted">
          Watch the places you care about (your city, family, clients, a trip): type one above. I’ll tell you about dangerous air, extreme weather, earthquakes or fires near them.
        </p>
      )}

      {info && (
        <div className="ask-pop glass absolute right-12 top-12 z-20 w-[min(320px,calc(100%-4rem))] space-y-1.5 rounded-xl bg-solid/90 p-3 text-[11px] text-muted shadow-2xl">
          <p className="text-text">
            {world.updatedAt ? `Updated ${ago(world.updatedAt, now)}` : 'Not updated yet'} · {world.quakes.length} earthquakes (M4+, 2 days) · {world.events.length} open natural events
          </p>
          {world.problems.length > 0 && <p className="text-warm">Unavailable: {world.problems.join('; ')}</p>}
          <p className="leading-snug">{styleCredit(prefs.style)}</p>
          <p className="leading-snug">{ATTRIBUTION}</p>
        </div>
      )}

      {selected && (
        <div className="pointer-events-none absolute inset-x-2 bottom-16 z-10 flex max-h-[55%] flex-col @[640px]:bottom-16 @[640px]:right-auto @[640px]:top-14 @[640px]:max-h-none @[640px]:w-[340px]">
          <Inspector
            sel={selected}
            world={world}
            now={now}
            onClose={() => setSelected(null)}
            nearby={nearby}
            onPick={n => {
              setSelected({ kind: n.kind, lngLat: n.lngLat, props: n.props })
              setFocus({ lngLat: n.lngLat, zoom: 8, n: Date.now() })
            }}
            onCentre={() => setFocus({ lngLat: selected.lngLat, zoom: selected.kind === 'places' ? 7 : 8, n: Date.now() })}
            onRemovePlace={id => {
              setSelected(null)
              void run(() => window.world.remove(id))
            }}
          />
        </div>
      )}
    </div>
  )
}
