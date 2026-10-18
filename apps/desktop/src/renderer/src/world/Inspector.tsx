/** The Inspector: what was picked on the map, with what you can do about it. */
import { Crosshair, ExternalLink, Sparkles, Trash2, Wind, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import type { PlaceStatus, WorldSnapshot } from '../../../shared/world.ts'
import { ago } from '../Jarvis.tsx'
import { ASK_EVENT } from '../shell/live.ts'
import { hoverInfo, type NearbyItem } from './hover.ts'
import { layerDef, type LayerId } from './layers.ts'

/** Something picked on the map, shown in the Inspector. */
export interface Selected {
  kind: LayerId
  lngLat: [number, number]
  props: Record<string, string | number>
}

const aqiColor = (aqi: number) => (aqi <= 50 ? 'bg-ok/20 text-ok' : aqi <= 100 ? 'bg-yellow-400/20 text-yellow-300' : aqi <= 150 ? 'bg-orange-400/20 text-orange-300' : aqi <= 200 ? 'bg-red-500/20 text-red-300' : 'bg-fuchsia-500/25 text-fuchsia-300')

/** A watched place in detail: weather, air, what happened nearby and local news. */
function PlaceDetail({ s, now }: { s: PlaceStatus; now: number }) {
  const w = s.weather
  return (
    <div className="space-y-3">
      {w ? (
        <div className="flex items-end gap-3">
          <span className="font-mono text-4xl font-extralight">{Math.round(w.temp)}°</span>
          <div className="pb-1 text-xs text-muted">
            <p className="text-sm text-text">{w.summary}</p>
            <p>
              feels {Math.round(w.feels)}° · <Wind className="inline size-3" aria-hidden /> {Math.round(w.wind)} km/h · {w.humidity}%
            </p>
          </div>
          {s.air && (
            <span className={`ml-auto mb-1 rounded-full px-2 py-0.5 text-[11px] ${aqiColor(s.air.aqi)}`} title={`PM2.5 ${s.air.pm25} µg/m³ · PM10 ${s.air.pm10}`}>
              AQI {s.air.aqi >= 500 ? '500+' : s.air.aqi} · {s.air.level}
            </span>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted">Loading weather…</p>
      )}
      {w && (
        <div className="grid grid-cols-2 gap-2">
          {w.days.map((d, i) => (
            <div key={d.date} className="rounded-lg bg-surface px-2.5 py-1.5 text-xs">
              <p className="text-muted">{i === 0 ? 'Today' : 'Tomorrow'}</p>
              <p className="font-mono">
                {Math.round(d.min)}–{Math.round(d.max)}°{d.rain ? <span className="text-muted"> · {d.rain} mm</span> : null}
              </p>
            </div>
          ))}
        </div>
      )}
      {s.nearby.length > 0 && (
        <section>
          <p className="hud-label mb-1">Nearby</p>
          <ul className="space-y-0.5 text-xs">
            {s.nearby.slice(0, 4).map(n => (
              <li key={n.id} className="flex gap-2 text-warm">
                <span className="min-w-0 flex-1 truncate" title={n.title}>
                  {n.title}
                </span>
                <span className="shrink-0 font-mono text-[10px]">{n.km} km</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {s.news.length > 0 && (
        <section>
          <p className="hud-label mb-1">Local news</p>
          <ul className="space-y-1.5">
            {s.news.slice(0, 5).map(n => (
              <li key={n.url} className="text-xs">
                <a href={n.url} target="_blank" rel="noreferrer" className="line-clamp-2 hover:text-accent" dir="auto">
                  {n.title}
                </a>
                <span className="text-[10px] text-muted">
                  {n.domain}
                  {n.time ? ` · ${ago(n.time, now)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** A public camera's latest frame, fetched by Atlas (the page itself loads only map tiles). */
function CameraDetail({ id, source }: { id: string; source: string }) {
  const [frame, setFrame] = useState<{ src: string; at: number } | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const load = useCallback(() => {
    setState('loading')
    void window.world.cameraImage(id).then(
      r => {
        setFrame({ src: r.dataUrl, at: r.at })
        setState('ok')
      },
      () => setState('error'),
    )
  }, [id])
  useEffect(() => {
    setFrame(null)
    load()
  }, [load])
  return (
    <div className="space-y-1.5">
      <div className="grid aspect-video place-items-center overflow-hidden rounded-lg bg-surface">
        {frame ? <img src={frame.src} alt="Latest camera frame" className="h-full w-full object-cover" /> : <span className="text-xs text-muted">{state === 'error' ? 'Image unavailable right now' : 'Loading the latest frame…'}</span>}
      </div>
      <p className="flex items-center gap-2 text-[11px] text-muted">
        <span className="flex-1">
          {source}
          {frame ? ` · ${new Date(frame.at).toLocaleTimeString()}` : ''}
        </span>
        <button type="button" className="text-accent hover:underline" onClick={load} disabled={state === 'loading'}>
          Refresh
        </button>
      </p>
    </div>
  )
}

/** The Inspector: what was picked on the map, with what you can do about it. */
export function Inspector({
  sel,
  world,
  now,
  nearby,
  onPick,
  onClose,
  onCentre,
  onRemovePlace,
}: {
  sel: Selected
  world: WorldSnapshot
  now: number
  nearby: NearbyItem[]
  onPick: (item: NearbyItem) => void
  onClose: () => void
  onCentre: () => void
  onRemovePlace: (id: string) => void
}) {
  const p = sel.props
  const { kind: kindLabel } = layerDef(sel.kind)
  const info = hoverInfo(sel.kind, p, world, now)
  const dot = info.color
  const place = sel.kind === 'places' ? world.places.find(x => x.place.id === p.id) : undefined
  const title = place ? place.place.name : info.title
  const [lon, lat] = sel.lngLat
  const where = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`
  const ask = () => {
    const about = place
      ? `my watched place ${place.place.name}`
      : `this ${kindLabel.toLowerCase()} on the World map: ${title}${p.detail ? ` (${p.detail})` : ''} at ${where}`
    window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: `Tell me about ${about}.` }))
  }
  return (
    <aside aria-label={`${kindLabel}: ${title}`} className="ask-pop glass pointer-events-auto flex max-h-full min-h-0 flex-col overflow-hidden rounded-xl bg-solid/90 shadow-2xl">
      <header className="flex items-start gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
            <span className="size-1.5 rounded-full" style={{ background: dot }} aria-hidden />
            {info.kind.toLowerCase()}
          </p>
          <h3 className="truncate text-sm font-medium" title={title}>
            {title}
            {place?.place.country ? <span className="font-normal text-muted"> · {place.place.country}</span> : null}
          </h3>
        </div>
        <button type="button" className="icon-btn size-7" onClick={onClose} aria-label="Close the inspector" title="Close (Esc)">
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm">
        {place ? (
          <PlaceDetail s={place} now={now} />
        ) : sel.kind === 'cameras' ? (
          <CameraDetail id={String(p.id)} source={String(p.source ?? '')} />
        ) : (
          <>
            {info.facts
              .filter(f => !f.endsWith(' ago'))
              .map(f => (
                <p key={f}>{f}</p>
              ))}
            {p.time && <p className="text-xs text-muted">{ago(Number(p.time), now)} · {new Date(Number(p.time)).toLocaleString()}</p>}
            {(sel.kind === 'flights' || sel.kind === 'satellites' || sel.kind === 'ships') && <p className="text-[11px] text-muted">Position when you picked it; it keeps moving on the map.</p>}
          </>
        )}
        {nearby.length > 0 && (
          <section>
            <p className="hud-label mb-1">Around it on the map</p>
            <ul className="space-y-0.5">
              {nearby.map(n => (
                <li key={`${n.kind}:${n.title}:${n.lngLat.join(',')}`}>
                  <button type="button" className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left text-xs hover:bg-surface" onClick={() => onPick(n)}>
                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: layerDef(n.kind).dot }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate" title={n.title} dir="auto">
                      {n.title}
                    </span>
                    <span className="shrink-0 font-mono text-[10px] text-muted">{n.km < 1 ? '<1' : n.km} km</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="font-mono text-[10px] text-muted">{where}</p>
      </div>
      <footer className="flex flex-wrap gap-1.5 border-t border-border px-3 py-2">
        <button type="button" className="btn h-7 gap-1 px-2 text-xs" onClick={onCentre}>
          <Crosshair className="size-3.5" aria-hidden /> Centre
        </button>
        <button type="button" className="btn h-7 gap-1 border-accent/60 px-2 text-xs text-accent" onClick={ask}>
          <Sparkles className="size-3.5" aria-hidden /> Ask Atlas
        </button>
        {typeof p.url === 'string' && p.url.startsWith('https://') && (
          <a href={p.url} target="_blank" rel="noreferrer" className="btn h-7 gap-1 px-2 text-xs">
            <ExternalLink className="size-3.5" aria-hidden /> Source
          </a>
        )}
        {place && (
          <button type="button" className="btn ml-auto h-7 gap-1 px-2 text-xs" onClick={() => onRemovePlace(place.place.id)} title="Stop watching this place">
            <Trash2 className="size-3.5" aria-hidden /> Stop watching
          </button>
        )}
      </footer>
    </aside>
  )
}
