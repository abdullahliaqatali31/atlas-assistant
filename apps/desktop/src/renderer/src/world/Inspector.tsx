/** The Inspector: what was picked on the map, with what you can do about it. */
import { Crosshair, ExternalLink, LocateFixed, Sparkles, Trash2, Wind, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { PlaceStatus, WorldSnapshot } from '../../../shared/world.ts'
import { ago } from '../Jarvis.tsx'
import { ASK_EVENT } from '../shell/live.ts'
import { FlightDetail, moreLinks, SatelliteDetail, ShipDetail } from './Details.tsx'
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

/**
 * Live video from the camera's own agency: an HLS stream (Caltrans) through
 * hls.js, or the short clip TfL refreshes every few minutes, looped. Muted;
 * any failure falls back to the still frame.
 */
function LiveVideo({ url, kind, poster, onFail }: { url: string; kind: string; poster?: string | undefined; onFail: () => void }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    let destroy = () => {}
    if (kind === 'hls' && !v.canPlayType('application/vnd.apple.mpegurl')) {
      let stopped = false
      void import('hls.js').then(({ default: Hls }) => {
        if (stopped || !Hls.isSupported()) return stopped || onFail()
        const hls = new Hls({ lowLatencyMode: true, maxBufferLength: 10 })
        hls.on(Hls.Events.ERROR, (_e, d) => d.fatal && onFail())
        hls.loadSource(url)
        hls.attachMedia(v)
        destroy = () => hls.destroy()
      }, onFail)
      return () => {
        stopped = true
        destroy()
      }
    }
    v.src = url
    return () => {
      v.removeAttribute('src')
      v.load()
    }
  }, [url, kind])
  return <video ref={ref} className="h-full w-full object-cover" poster={poster} autoPlay muted playsInline loop={kind === 'clip'} onError={onFail} aria-label="Live camera video" />
}

/** A public camera: live video where the agency offers it, else its latest frame (fetched by Atlas, refreshed every 30 s). */
function CameraDetail({
  id,
  source,
  video,
  videoKind,
  player,
  playerKind,
  link,
}: {
  id: string
  source: string
  video?: string | undefined
  videoKind?: string | undefined
  /** Windy's embeddable player: its live stream or today's timelapse. */
  player?: string | undefined
  playerKind?: string | undefined
  link?: string | undefined
}) {
  const [frame, setFrame] = useState<{ src: string; at: number } | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const moving = video ?? player
  const [mode, setMode] = useState<'video' | 'still'>(moving ? 'video' : 'still')
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
    setMode(moving ? 'video' : 'still')
    load()
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [load, moving])
  return (
    <div className="space-y-1.5">
      <div className="relative grid aspect-video place-items-center overflow-hidden rounded-lg bg-surface">
        {mode === 'video' && video ? (
          <LiveVideo url={video} kind={videoKind ?? 'clip'} poster={frame?.src} onFail={() => setMode('still')} />
        ) : mode === 'video' && player ? (
          <iframe src={player} title="Webcam player" className="h-full w-full border-0" sandbox="allow-scripts allow-same-origin" allow="autoplay; fullscreen" referrerPolicy="no-referrer" />
        ) : frame ? (
          <img src={frame.src} alt="Latest camera frame" className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs text-muted">{state === 'error' ? 'Image unavailable right now' : 'Loading the latest frame…'}</span>
        )}
        {mode === 'video' && moving && (
          <span className="absolute left-2 top-2 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white">
            <span className="size-1.5 animate-pulse rounded-full bg-red-500" aria-hidden /> {video ? (videoKind === 'hls' ? 'LIVE' : 'RECENT CLIP') : playerKind === 'live' ? 'LIVE' : 'TODAY, TIMELAPSE'}
          </span>
        )}
      </div>
      <p className="flex items-center gap-2 text-[11px] text-muted">
        <span className="flex-1">
          {source}
          {mode === 'still' && frame ? ` · ${new Date(frame.at).toLocaleTimeString()}` : ''}
        </span>
        {link && (
          <a href={link} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            Windy
          </a>
        )}
        {moving && (
          <button type="button" className="text-accent hover:underline" onClick={() => setMode(m => (m === 'video' ? 'still' : 'video'))}>
            {mode === 'video' ? 'Still' : 'Video'}
          </button>
        )}
        {mode === 'still' && (
          <button type="button" className="text-accent hover:underline" onClick={load} disabled={state === 'loading'}>
            Refresh
          </button>
        )}
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
  following,
  onFollow,
  onClose,
  onCentre,
  onRemovePlace,
}: {
  sel: Selected
  world: WorldSnapshot
  now: number
  nearby: NearbyItem[]
  onPick: (item: NearbyItem) => void
  following: boolean
  onFollow: () => void
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
        ) : sel.kind === 'flights' ? (
          <FlightDetail p={p} />
        ) : sel.kind === 'ships' ? (
          <ShipDetail p={p} />
        ) : sel.kind === 'satellites' ? (
          <SatelliteDetail p={p} />
        ) : sel.kind === 'cameras' ? (
          <CameraDetail id={String(p.id)} source={String(p.source ?? '')} video={typeof p.video === 'string' ? p.video : undefined} videoKind={typeof p.videoKind === 'string' ? p.videoKind : undefined}
            player={typeof p.player === 'string' ? p.player : undefined}
            playerKind={typeof p.playerKind === 'string' ? p.playerKind : undefined}
            link={typeof p.link === 'string' ? p.link : undefined}
          />
        ) : (
          <>
            {typeof p.image === 'string' && p.image.startsWith('assistant-news://') && <img src={p.image} alt="" className="aspect-video w-full rounded-lg object-cover" />}
            {info.facts
              // A bare age line is shown below with the full date.
              .filter(f => !/^((Reported|Seen|Updated) )?(\d+ (min|h|d)|now) ago$/.test(f))
              .map(f => (
                <p key={f}>{f}</p>
              ))}
            {p.time && <p className="text-xs text-muted">{ago(Number(p.time), now)} · {new Date(Number(p.time)).toLocaleString()}</p>}
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
        {(sel.kind === 'flights' || sel.kind === 'ships' || sel.kind === 'satellites') && (
          <button type="button" className={`btn h-7 gap-1 px-2 text-xs ${following ? 'border-accent text-accent' : ''}`} onClick={onFollow} aria-pressed={following} title="Keep it in the middle of the map as it moves">
            <LocateFixed className="size-3.5" aria-hidden /> {following ? 'Following' : 'Follow'}
          </button>
        )}
        <button type="button" className="btn h-7 gap-1 border-accent/60 px-2 text-xs text-accent" onClick={ask}>
          <Sparkles className="size-3.5" aria-hidden /> Ask Atlas
        </button>
        {typeof p.url === 'string' && p.url.startsWith('https://') && (
          <a href={p.url} target="_blank" rel="noreferrer" className="btn h-7 gap-1 px-2 text-xs">
            <ExternalLink className="size-3.5" aria-hidden /> Source
          </a>
        )}
        {moreLinks(sel.kind, p).map(l => (
          <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className="btn h-7 gap-1 px-2 text-xs">
            <ExternalLink className="size-3.5" aria-hidden /> {l.label}
          </a>
        ))}
        {place && (
          <button type="button" className="btn ml-auto h-7 gap-1 px-2 text-xs" onClick={() => onRemovePlace(place.place.id)} title="Stop watching this place">
            <Trash2 className="size-3.5" aria-hidden /> Stop watching
          </button>
        )}
      </footer>
    </aside>
  )
}
