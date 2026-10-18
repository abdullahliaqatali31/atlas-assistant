/**
 * The Inspector's rich cards for moving things: an aircraft (type,
 * registration, squawk, height, speed, climb, track), a ship (MMSI,
 * type, speed, course, destination, length) and a satellite (NORAD
 * number, height, speed, inclination, period, next pass over you). Live:
 * MapView refreshes the values while the card is open.
 */
import { Plane, Satellite, Ship } from 'lucide-react'
import type { ReactNode } from 'react'

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
      <p className="text-[10px] text-muted">Live from ADS-B (adsb.lol); the path shows where it flew while the map was open.</p>
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
