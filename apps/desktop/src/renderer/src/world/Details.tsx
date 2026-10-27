import { useEffect, useRef, useState } from 'react'
/**
 * The Inspector's rich cards for moving things: an aircraft (type,
 * registration, squawk, height, speed, climb, track), a ship (MMSI,
 * type, speed, course, destination, length) and a satellite (NORAD
 * number, height, speed, inclination, period, next pass over you). Live:
 * MapView refreshes the values while the card is open.
 */
import { Plane, Satellite, Ship } from 'lucide-react'
import type { ReactNode } from 'react'

import type { AircraftInfo, FlightTrack, WikiThing } from '../../../shared/world.ts'
import { RemoteImg } from './RemoteImg.tsx'

type Props = Record<string, string | number>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const fmt = (n: number, digits = 0) => n.toLocaleString(undefined, { maximumFractionDigits: digits })
const compass = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8]

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : ''}>
      <p className="font-mono text-[9.5px] uppercase tracking-wider text-muted">{label}</p>
      <p className="truncate text-[13px]">{children}</p>
    </div>
  )
}

function Hero({ icon, color, badge, badgeTone }: { icon: ReactNode; color: string; badge: string; badgeTone: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-12 shrink-0 place-items-center rounded-xl" style={{ background: `${color}22`, color }}>
        {icon}
      </span>
      <span className={`rounded-md border px-2 py-0.5 font-mono text-[10px] tracking-wider ${badgeTone}`}>{badge}</span>
    </div>
  )
}

export function FlightDetail({ p }: { p: Props }) {
  const alt = num(p.altitude)
  const ground = p.onGround === 1
  const vr = num(p.verticalRate) ?? 0
  const emergency = str(p.emergency)
  const military = p.military === 1
  return (
    <div className="space-y-3">
      <Hero
        icon={<Plane className="size-6" style={{ transform: `rotate(${(num(p.track) ?? 0) - 45}deg)` }} aria-hidden />}
        color={String(p.color ?? '#fbbf24')}
        badge={emergency ? `EMERGENCY · ${emergency.toUpperCase()}` : military ? 'MILITARY' : 'CIVILIAN'}
        badgeTone={emergency ? 'border-danger text-danger' : military ? 'border-red-400/60 text-red-300' : 'border-accent/50 text-accent'}
      />
      {str(p.hex) && <Airframe hex={str(p.hex)!} />}
      {str(p.routeFrom) && str(p.routeTo) && (
        <div className="rounded-lg bg-surface px-3 py-2">
          <div className="flex items-baseline justify-between gap-2 font-mono">
            <span className="text-lg" title={str(p.routeFromName) ?? undefined}>{str(p.routeFrom)}</span>
            <Plane className="size-3.5 shrink-0 text-warm" aria-hidden />
            <span className="text-lg" title={str(p.routeToName) ?? undefined}>{str(p.routeTo)}</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-border" aria-label="Progress along the route">
            <div className="h-full rounded-full bg-warm" style={{ width: `${Math.round((num(p.routeProgress) ?? 0) * 100)}%` }} />
          </div>
          <div className="mt-1 flex justify-between gap-2 text-[11px] text-muted">
            <span className="truncate">{str(p.routeFromCity)}</span>
            <span className="truncate text-right">{str(p.routeToCity)}</span>
          </div>
          {(str(p.airline) || num(p.routeKmLeft) !== null) && (
            <p className="mt-1 text-[11px] text-muted">
              {[str(p.airline), num(p.routeKmLeft) !== null ? `${fmt(num(p.routeKmLeft)!)} km to go` : null].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      )}
      {str(p.hex) && !ground && <Profile hex={str(p.hex)!} />}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Field label="Type" wide>
          {str(p.typeName) ?? str(p.type) ?? 'Unknown'}
          {str(p.typeName) && <span className="text-muted"> · {String(p.type)}</span>}
        </Field>
        <Field label="Callsign">{str(p.callsign) ?? '—'}</Field>
        <Field label="Registration">{str(p.registration) ?? '—'}</Field>
        <Field label="Altitude">{ground ? 'On the ground' : alt !== null ? `${fmt(alt)} ft · ${fmt(alt * 0.3048)} m` : '—'}</Field>
        <Field label="Speed">{num(p.speed) !== null ? `${fmt(num(p.speed)!)} kt · ${fmt(num(p.speed)! * 1.852)} km/h` : '—'}</Field>
        <Field label="Heading">{num(p.track) !== null ? `${fmt(num(p.track)!)}° ${compass(num(p.track)!)}` : '—'}</Field>
        <Field label="Vertical">{ground ? '—' : Math.abs(vr) < 100 ? 'Level' : `${vr > 0 ? 'Climbing' : 'Descending'} ${fmt(Math.abs(vr))} ft/min`}</Field>
        <Field label="Squawk">{str(p.squawk) ?? '—'}</Field>
        <Field label="ICAO hex">{str(p.hex)?.toUpperCase() ?? '—'}</Field>
      </div>
      <p className="text-[10px] text-muted">Live from ADS-B (adsb.lol){str(p.routeFrom) ? '; route from adsbdb.com by callsign (the planned route, not a live flight plan)' : '; the path shows where it flew while the map was open'}.</p>
    </div>
  )
}

export function ShipDetail({ p }: { p: Props }) {
  const speed = num(p.speed)
  return (
    <div className="space-y-3">
      <Hero icon={<Ship className="size-6" aria-hidden />} color={String(p.color ?? '#34d399')} badge={String(p.category ?? 'VESSEL').toUpperCase()} badgeTone="border-emerald-400/50 text-emerald-300" />
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Field label="Name" wide>
          {str(p.name) ?? '—'}
        </Field>
        <Field label="MMSI">{num(p.mmsi) ?? '—'}</Field>
        <Field label="Type">{str(p.category) ?? '—'}</Field>
        <Field label="Speed">{speed !== null ? `${fmt(speed, 1)} kn${speed < 0.5 ? ' · stopped' : ''}` : '—'}</Field>
        <Field label="Course">{num(p.course) !== null ? `${fmt(num(p.course)!)}° ${compass(num(p.course)!)}` : '—'}</Field>
        <Field label="Destination" wide>
          {str(p.destination) ?? 'Not declared'}
        </Field>
        <Field label="Length">{num(p.length) !== null ? `${fmt(num(p.length)!)} m` : '—'}</Field>
      </div>
      <p className="text-[10px] text-muted">Live from AIS (AISStream); the path shows where it sailed while the map was open.</p>
    </div>
  )
}

export function SatelliteDetail({ p }: { p: Props }) {
  const pass = num(p.nextPass)
  return (
    <div className="space-y-3">
      <Hero icon={<Satellite className="size-6" aria-hidden />} color="#c084fc" badge={`NORAD ${String(p.norad ?? '—')}`} badgeTone="border-purple-400/50 text-purple-300" />
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <Field label="Altitude">{num(p.altKm) !== null ? `${fmt(num(p.altKm)!)} km` : '—'}</Field>
        <Field label="Speed">{num(p.speedKms) !== null ? `${fmt(num(p.speedKms)!, 2)} km/s · ${fmt(num(p.speedKms)! * 3600)} km/h` : '—'}</Field>
        <Field label="Inclination">{num(p.inclination) !== null ? `${num(p.inclination)}°` : '—'}</Field>
        <Field label="One orbit">{num(p.periodMin) !== null ? `${fmt(num(p.periodMin)!, 1)} min` : '—'}</Field>
        <Field label={`Next pass over ${String(p.passPlace ?? 'your place')}`} wide>
          {pass ? `${new Date(pass).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · ${String(p.nextPassMin)} min · up to ${String(p.nextPassMax)}°` : p.passPlace ? 'None above 10° in the next two days' : 'Watch a place to see passes'}
        </Field>
      </div>
      <p className="text-[10px] text-muted">Computed from CelesTrak orbit elements. The dashed line is its next orbit; the ring is what it can see from up there.</p>
    </div>
  )
}

/** Outside pages with more about the item (each opens in the browser). */
export const moreLinks = (kind: string, p: Props): { label: string; href: string }[] => {
  const hex = str(p.hex)
  const mmsi = num(p.mmsi)
  const norad = str(p.norad)
  if (kind === 'flights' && hex)
    return [
      { label: 'Track', href: `https://globe.adsb.lol/?icao=${encodeURIComponent(hex)}` },
      { label: 'Photos', href: `https://www.planespotters.net/hex/${encodeURIComponent(hex.toUpperCase())}` },
    ]
  if (kind === 'ships' && mmsi) return [{ label: 'Vessel', href: `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${mmsi}` }]
  if (kind === 'satellites' && norad) return [{ label: 'Orbit data', href: `https://celestrak.org/satcat/table-satcat.php?CATNR=${encodeURIComponent(norad)}` }]
  return []
}

/** A radio station: play it live, straight from the broadcaster. */
export function RadioDetail({ p }: { p: Props }) {
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState('')
  const audio = useRef<HTMLAudioElement | null>(null)
  const url = str(p.url)
  useEffect(() => () => audio.current?.pause(), [])
  const toggle = () => {
    if (!url) return
    if (!audio.current) {
      audio.current = new Audio(url)
      audio.current.addEventListener('error', () => {
        setError('This station is not answering right now.')
        setPlaying(false)
      })
    }
    if (playing) {
      audio.current.pause()
      setPlaying(false)
    } else {
      setError('')
      void audio.current.play().then(
        () => setPlaying(true),
        () => setError('This station could not be played.'),
      )
    }
  }
  return (
    <div className="space-y-3">
      <button type="button" onClick={toggle} className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${playing ? 'border-fuchsia-400/70 bg-fuchsia-500/10' : 'border-border hover:border-fuchsia-400/60'}`}>
        <span className={`grid size-9 place-items-center rounded-full ${playing ? 'bg-fuchsia-500 text-white' : 'bg-surface text-fuchsia-300'}`}>{playing ? '❚❚' : '▶'}</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{playing ? 'Playing live' : 'Listen live'}</span>
          <span className="block truncate text-[11px] text-muted">{[str(p.country), str(p.tags)].filter(Boolean).join(' · ')}</span>
        </span>
        {playing && (
          <span className="ml-auto flex h-4 items-end gap-0.5" aria-hidden>
            {[0, 1, 2, 3].map(i => (
              <span key={i} className="w-1 animate-pulse rounded-sm bg-fuchsia-400" style={{ height: `${40 + ((i * 23) % 60)}%`, animationDelay: `${i * 120}ms` }} />
            ))}
          </span>
        )}
      </button>
      {error && <p className="text-xs text-warm">{error}</p>}
      <p className="text-[10px] text-muted">
        {[str(p.codec), num(p.bitrate) ? `${num(p.bitrate)} kbps` : null].filter(Boolean).join(' · ')} · streamed from the station itself; directory by Radio Browser.
      </p>
    </div>
  )
}

/** This very airframe: its photo, who flies it and where it is registered (adsbdb; photos from airport-data.com). */
function Airframe({ hex }: { hex: string }) {
  const [info, setInfo] = useState<AircraftInfo | null>(null)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    let gone = false
    setInfo(null)
    setBroken(false)
    void window.world.aircraft(hex).then(
      i => !gone && setInfo(i),
      () => undefined,
    )
    return () => {
      gone = true
    }
  }, [hex])
  if (!info || (!info.photo && !info.owner)) return null
  return (
    <figure className="space-y-1">
      {info.photo && !broken && <RemoteImg src={info.photo} alt={[info.manufacturer, info.type, info.registration].filter(Boolean).join(' ')} className="aspect-[3/2] w-full rounded-lg object-cover" onMissing={() => setBroken(true)} />}
      <figcaption className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
        <span className="truncate">{[info.owner, info.country].filter(Boolean).join(' · ')}</span>
        {info.photo && !broken && <span className="shrink-0 text-[10px]">Photo: airport-data.com</span>}
      </figcaption>
    </figure>
  )
}

/** This flight so far: its altitude over time (OpenSky), refreshed each minute while the card is open. */
function Profile({ hex }: { hex: string }) {
  const [track, setTrack] = useState<FlightTrack | null>(null)
  useEffect(() => {
    let gone = false
    setTrack(null)
    const load = () =>
      void window.world.track(hex).then(
        t => !gone && setTrack(t),
        () => undefined,
      )
    load()
    const timer = setInterval(load, 60_000)
    return () => {
      gone = true
      clearInterval(timer)
    }
  }, [hex])
  const pts = track?.points.filter(x => x.altM !== null) ?? []
  if (!track || pts.length < 2) return null
  const W = 300
  const H = 56
  const t0 = pts[0]!.t
  const t1 = Math.max(pts[pts.length - 1]!.t, t0 + 60_000)
  const peak = Math.max(...pts.map(x => x.altM!), 1000)
  const xy = pts.map(x => [((x.t - t0) / (t1 - t0)) * W, H - 4 - (x.altM! / peak) * (H - 10)] as const)
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const last = xy[xy.length - 1]!
  const mins = Math.round((Date.now() - track.start) / 60_000)
  const since = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`
  return (
    <div className="rounded-lg bg-surface px-3 py-2">
      <p className="mb-1 flex justify-between text-[10px] uppercase tracking-wider text-muted">
        <span>This flight · altitude</span>
        <span>peak FL{String(Math.round((peak / 0.3048) / 100)).padStart(3, '0')}</span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" preserveAspectRatio="none" aria-label="Altitude over the flight so far">
        <defs>
          <linearGradient id="alt-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--color-accent, #22d3ee)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--color-accent, #22d3ee)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L${last[0].toFixed(1)},${H} L0,${H} Z`} fill="url(#alt-fill)" />
        <path d={line} fill="none" stroke="var(--color-accent, #22d3ee)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        <circle cx={last[0]} cy={last[1]} r="3" fill="var(--color-accent, #22d3ee)" />
      </svg>
      <p className="mt-0.5 text-[10px] text-muted">
        Departed {new Date(track.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {since} ago · path from OpenSky Network
      </p>
    </div>
  )
}

/** One number in a compact card. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-surface px-2 py-1">
      <p className="text-[9px] uppercase tracking-wider text-muted">{label}</p>
      <p className="truncate font-mono text-xs">{value}</p>
    </div>
  )
}

/**
 * The compact card for things that move: what it is, where it is going and
 * three numbers, with a small photo for an aircraft. "More" opens the full card.
 */
export function MiniDetail({ kind, p }: { kind: string; p: Props }) {
  if (kind === 'flights') {
    const alt = num(p.altitude)
    const vr = num(p.verticalRate) ?? 0
    const ground = p.onGround === 1
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          {str(p.hex) && <MiniPhoto hex={str(p.hex)!} />}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs">{str(p.typeName) ?? str(p.type) ?? 'Aircraft'}</p>
            {str(p.routeFrom) && str(p.routeTo) ? (
              <>
                <p className="truncate font-mono text-xs">
                  {str(p.routeFrom)} → {str(p.routeTo)}
                  {num(p.routeKmLeft) !== null && <span className="text-muted"> · {fmt(num(p.routeKmLeft)!)} km to go</span>}
                </p>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-border">
                  <div className="h-full rounded-full bg-warm" style={{ width: `${Math.round((num(p.routeProgress) ?? 0) * 100)}%` }} />
                </div>
              </>
            ) : (
              <p className="truncate text-[11px] text-muted">{[str(p.registration), str(p.callsign)].filter(Boolean).join(' · ')}</p>
            )}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-1">
          <Stat label="Alt" value={ground ? 'Ground' : alt !== null ? (alt >= 18_000 ? `FL${String(Math.round(alt / 100)).padStart(3, '0')}` : `${fmt(alt)} ft`) : '—'} />
          <Stat label="Speed" value={num(p.speed) !== null ? `${fmt(num(p.speed)!)} kt` : '—'} />
          <Stat label={Math.abs(vr) < 100 ? 'Level' : vr > 0 ? 'Climb' : 'Descent'} value={Math.abs(vr) < 100 ? (num(p.track) !== null ? `${fmt(num(p.track)!)}° ${compass(num(p.track)!)}` : '—') : `${fmt(Math.abs(vr))} fpm`} />
        </div>
      </div>
    )
  }
  if (kind === 'ships')
    return (
      <div className="space-y-1.5">
        {str(p.mmsi) || num(p.mmsi) !== null ? <WikiFacts kind="ship" id={String(p.mmsi)} mini /> : null}
        <p className="truncate text-xs">
          {str(p.category) ?? 'Vessel'}
          {str(p.destination) && <span className="text-muted"> · to {str(p.destination)}</span>}
        </p>
        <div className="grid grid-cols-3 gap-1">
          <Stat label="Speed" value={num(p.speed) !== null ? `${fmt(num(p.speed)!, 1)} kn` : '—'} />
          <Stat label="Course" value={num(p.course) !== null ? `${fmt(num(p.course)!)}° ${compass(num(p.course)!)}` : '—'} />
          <Stat label="Length" value={num(p.length) !== null ? `${fmt(num(p.length)!)} m` : '—'} />
        </div>
      </div>
    )
  // Satellites.
  const period = num(p.periodMin)
  return (
    <div className="space-y-1.5">
      {str(p.norad) && <WikiFacts kind="satellite" id={str(p.norad)!} mini />}
      {num(p.nextPass) !== null && (
        <p className="truncate text-[11px] text-muted">
          Next over {str(p.passPlace) ?? 'you'}: {new Date(num(p.nextPass)!).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
        </p>
      )}
      <div className="grid grid-cols-3 gap-1">
        <Stat label="Alt" value={num(p.altKm) !== null ? `${fmt(num(p.altKm)!)} km` : '—'} />
        <Stat label="Speed" value={num(p.speedKms) !== null ? `${fmt(num(p.speedKms)!, 2)} km/s` : '—'} />
        <Stat label="Orbit" value={period !== null ? (period < 200 ? `${fmt(period)} min` : `${fmt(period / 60, 1)} h`) : '—'} />
      </div>
    </div>
  )
}

/** The aircraft's own photo, thumbnail size, for the compact card. */
function MiniPhoto({ hex }: { hex: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let gone = false
    setSrc(null)
    void window.world.aircraft(hex).then(
      i => !gone && setSrc(i?.photoThumb ?? i?.photo ?? null),
      () => undefined,
    )
    return () => {
      gone = true
    }
  }, [hex])
  if (!src) return null
  return <RemoteImg src={src} className="h-11 w-16 shrink-0 rounded-md object-cover" onMissing={() => setSrc(null)} />
}

/** Wikidata on a notable ship or satellite: its picture (Wikimedia Commons, credited) and who runs it. Most have none. */
export function WikiFacts({ kind, id, mini = false }: { kind: 'ship' | 'satellite'; id: string; mini?: boolean }) {
  const [thing, setThing] = useState<WikiThing | null>(null)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    let gone = false
    setThing(null)
    setBroken(false)
    void window.world.wiki(kind, id).then(
      t => !gone && setThing(t),
      () => undefined,
    )
    return () => {
      gone = true
    }
  }, [kind, id])
  if (!thing) return null
  const facts = [thing.operator, thing.country, thing.since ? `since ${thing.since.slice(0, 4)}` : ''].filter(Boolean).join(' · ')
  if (mini)
    return (
      <div className="flex items-center gap-2">
        {thing.image && !broken && <RemoteImg src={thing.image} className="h-11 w-16 shrink-0 rounded-md object-cover" onMissing={() => setBroken(true)} />}
        <div className="min-w-0">
          <p className="truncate text-xs">{thing.label}</p>
          <p className="truncate text-[11px] text-muted">{thing.description || facts}</p>
        </div>
      </div>
    )
  return (
    <figure className="space-y-1">
      {thing.image && !broken && <RemoteImg src={thing.image} alt={thing.label} className="aspect-[3/2] w-full rounded-lg object-cover" onMissing={() => setBroken(true)} />}
      <figcaption className="space-y-0.5 text-[11px] text-muted">
        <p className="text-text">
          {thing.label}
          {thing.description && <span className="text-muted"> · {thing.description}</span>}
        </p>
        {facts && <p>{facts}</p>}
        <p className="flex gap-2 text-[10px]">
          {thing.imagePage && !broken && (
            <a href={thing.imagePage} target="_blank" rel="noreferrer" className="hover:text-accent">
              Photo: Wikimedia Commons
            </a>
          )}
          {thing.wikidata && (
            <a href={thing.wikidata} target="_blank" rel="noreferrer" className="hover:text-accent">
              Wikidata
            </a>
          )}
        </p>
      </figcaption>
    </figure>
  )
}
