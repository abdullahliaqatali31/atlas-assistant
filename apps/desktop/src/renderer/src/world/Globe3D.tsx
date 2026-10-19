/**
 * The 3D World view (CesiumJS, loaded only when opened). Three tiers, like
 * God's Eye View: no key = free satellite imagery (Esri) on keyless terrain
 * (Re:Earth); a Cesium ion token = world terrain and 3D buildings; a Google
 * key = photorealistic 3D cities. Live aircraft at their real altitude (3D
 * models near the camera, icons elsewhere), ships, satellites at their real
 * height. Pick a plane and "Fly with it": a chase or cockpit camera riding it,
 * a flight HUD, its route, and the next aircraft around it.
 */
import '@cesium/engine/Source/Widget/CesiumWidget.css'

// The engine alone: the full "cesium" package's widgets evaluate code from strings, which the page's security policy forbids.
import * as Cesium from '@cesium/engine'
import { Cartesian2, FixedFrameTransforms as Transforms } from '@cesium/core'
import * as satellite from 'satellite.js'
import { ArrowLeftRight, Box, ChevronLeft, ChevronRight, Eye, Plane, Video, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { kmBetween, type Flight, type FlightRoute, type Ship } from '../../../shared/world.ts'
import { aircraftName } from '../../../shared/aircraft.ts'
import { deadReckon, flightLabel, planeIcon, shipIcon } from './geo.ts'
import { MODEL_HEADING_OFFSET, headingTape, heightForZoom, modelFor, type ModelId } from './models3d.ts'
import { orbitFacts } from './passes.ts'

;(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = './cesium/'

type Tier = 'keyless' | 'ion' | 'google'
const TIER_LABEL: Record<Tier, string> = { keyless: 'Satellite imagery · free terrain', ion: 'World terrain · 3D buildings (Cesium ion)', google: 'Photorealistic 3D (Google)' }

const MODEL_RADIUS_M = 150_000
const MAX_MODELS = 40
const POLL_MS = 8_000

const iconCanvas = (data: ImageData) => {
  const c = document.createElement('canvas')
  c.width = data.width
  c.height = data.height
  c.getContext('2d')!.putImageData(data, 0, 0)
  return c
}

const colorOf = (f: Flight) => (f.emergency !== 'none' || /^(7500|7600|7700)$/.test(f.squawk) ? '#ef4444' : f.military ? '#fbbf24' : '#7dd3fc')
const altM = (f: Flight) => (f.altitude === null ? 0 : Math.max(0, f.altitude * 0.3048))

interface Follow {
  hex: string
  mode: 'chase' | 'cockpit'
}

export default function Globe3D({ start, onClose }: { start: { lat: number; lon: number; zoom: number }; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const credits = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.CesiumWidget | null>(null)
  const flights = useRef<{ list: Flight[]; at: number; byHex: Map<string, Flight> }>({ list: [], at: 0, byHex: new Map() })
  const followRef = useRef<Follow | null>(null)
  const [tier, setTier] = useState<Tier | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Flight | null>(null)
  const [follow, setFollow] = useState<Follow | null>(null)
  const [route, setRoute] = useState<FlightRoute | null>(null)
  const [, tick] = useState(0)
  const [counts, setCounts] = useState({ flights: 0, ships: 0, sats: 0 })
  followRef.current = follow

  useEffect(() => {
    let disposed = false
    const timers: ReturnType<typeof setInterval>[] = []
    let viewer: Cesium.CesiumWidget | null = null
    void (async () => {
      const keys = await window.world.map3dKeys().catch(() => ({ google: null, ion: null }))
      if (disposed || !box.current) return
      if (keys.ion) Cesium.Ion.defaultAccessToken = keys.ion
      viewer = new Cesium.CesiumWidget(box.current, { baseLayer: false, creditContainer: credits.current ?? undefined, msaaSamples: 4 })
      viewerRef.current = viewer
      // A handle for driving the view from the debugger, on the dev server only.
      if (location.protocol === 'http:') (window as unknown as { __globe3d?: unknown }).__globe3d = { viewer, Cesium }
      const scene = viewer.scene
      // No night side: the user looks at their own night too, and a black globe reads as broken.
      scene.globe.enableLighting = false
      scene.fog.enabled = true
      try {
        if (keys.google) {
          const tiles = await Cesium.createGooglePhotorealistic3DTileset({ key: keys.google, onlyUsingWithGoogleGeocoder: true })
          scene.primitives.add(tiles)
          scene.globe.show = false
          setTier('google')
        } else {
          viewer.imageryLayers.add(Cesium.ImageryLayer.fromProviderAsync(Cesium.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'), {}))
          if (keys.ion) {
            scene.setTerrain(Cesium.Terrain.fromWorldTerrain())
            scene.primitives.add(await Cesium.createOsmBuildingsAsync())
            setTier('ion')
          } else {
            scene.setTerrain(new Cesium.Terrain(Cesium.CesiumTerrainProvider.fromUrl('https://terrain.reearth.land/cesium-mesh/ellipsoid')))
            setTier('keyless')
          }
        }
      } catch (e) {
        setError(`The 3D map could not load fully (${e instanceof Error ? e.message.slice(0, 80) : 'error'}); showing what it can.`)
        setTier(t => t ?? 'keyless')
      }
      if (disposed || viewer.isDestroyed()) return
      viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(start.lon, start.lat - Math.min(8, 30 / 2 ** start.zoom), heightForZoom(start.zoom, start.lat)), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 } })

      // ── aircraft: icons everywhere, models near the camera ──
      const planeImg = iconCanvas(planeIcon())
      const shipImg = iconCanvas(shipIcon())
      const bills = scene.primitives.add(new Cesium.BillboardCollection({ scene })) as Cesium.BillboardCollection
      const byHex = new Map<string, Cesium.Billboard>()
      const models = new Map<string, { model: Cesium.Model; id: ModelId }>()
      const loading = new Set<string>()
      const hpr = new Cesium.HeadingPitchRoll()

      const placeAll = () => {
        if (!viewer || viewer.isDestroyed()) return
        const { list, at } = flights.current
        const dt = (Date.now() - at) / 1000
        const cam = viewer.camera.positionCartographic
        const camLat = Cesium.Math.toDegrees(cam.latitude)
        const camLon = Cesium.Math.toDegrees(cam.longitude)
        const seen = new Set<string>()
        const near: { f: Flight; km: number }[] = []
        for (const raw of list) {
          const f = deadReckon(raw, raw.seen + dt)
          seen.add(f.hex)
          const pos = Cesium.Cartesian3.fromDegrees(f.lon, f.lat, altM(f))
          const hidden = followRef.current?.mode === 'cockpit' && followRef.current.hex === f.hex
          let b = byHex.get(f.hex)
          if (!b) {
            b = bills.add({ position: pos, image: planeImg, color: Cesium.Color.fromCssColorString(colorOf(f)), alignedAxis: Cesium.Cartesian3.UNIT_Z, scaleByDistance: new Cesium.NearFarScalar(2e4, 0.9, 8e6, 0.3), id: { kind: 'flight', hex: f.hex } })
            byHex.set(f.hex, b)
          }
          b.position = pos
          b.rotation = -Cesium.Math.toRadians(f.track)
          const km = cam.height < 800_000 ? kmBetween({ lat: camLat, lon: camLon }, f) : Infinity
          if (km * 1000 < MODEL_RADIUS_M) near.push({ f, km })
          b.show = !hidden && !models.has(f.hex)
        }
        for (const [hex, b] of byHex) if (!seen.has(hex)) (bills.remove(b), byHex.delete(hex))
        // The nearest few get a real 3D model.
        const want = new Set(
          near
            .sort((a, b) => a.km - b.km)
            .slice(0, MAX_MODELS)
            .map(n => n.f.hex),
        )
        for (const [hex, m] of models) if (!want.has(hex)) (scene.primitives.remove(m.model), models.delete(hex))
        for (const n of near) {
          if (!want.has(n.f.hex)) continue
          const pos = Cesium.Cartesian3.fromDegrees(n.f.lon, n.f.lat, altM(n.f))
          hpr.heading = Cesium.Math.toRadians(n.f.track + MODEL_HEADING_OFFSET)
          const matrix = Transforms.headingPitchRollToFixedFrame(pos, hpr)
          const have = models.get(n.f.hex)
          const hidden = followRef.current?.mode === 'cockpit' && followRef.current.hex === n.f.hex
          if (have) {
            have.model.modelMatrix = matrix
            have.model.show = !hidden
          } else if (!loading.has(n.f.hex)) {
            loading.add(n.f.hex)
            const id = modelFor(n.f.type, n.f.military)
            void Cesium.Model.fromGltfAsync({ url: `./models/${id}.glb`, modelMatrix: matrix, minimumPixelSize: 36, maximumScale: 4000, id: { kind: 'flight', hex: n.f.hex } }).then(
              model => {
                loading.delete(n.f.hex)
                if (!viewer || viewer.isDestroyed() || !want.has(n.f.hex)) return model.destroy()
                scene.primitives.add(model)
                models.set(n.f.hex, { model, id })
              },
              () => loading.delete(n.f.hex),
            )
          }
        }
      }

      // ── ships ──
      const shipBills = scene.primitives.add(new Cesium.BillboardCollection({ scene })) as Cesium.BillboardCollection
      const drawShips = (list: Ship[]) => {
        shipBills.removeAll()
        for (const s of list.slice(0, 3000))
          shipBills.add({ position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 0), image: shipImg, width: 14, height: 14, color: Cesium.Color.fromCssColorString('#34d399'), rotation: -Cesium.Math.toRadians(s.heading ?? s.course), alignedAxis: Cesium.Cartesian3.UNIT_Z, scaleByDistance: new Cesium.NearFarScalar(1e4, 1, 5e6, 0.4), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, id: { kind: 'ship', name: s.name } })
        setCounts(x => ({ ...x, ships: list.length }))
      }

      const poll = async () => {
        if (!viewer || viewer.isDestroyed() || document.hidden) return
        const rect = viewer.camera.computeViewRectangle()
        const c = viewer.camera.positionCartographic
        const lat = Cesium.Math.toDegrees(c.latitude)
        const lon = Cesium.Math.toDegrees(c.longitude)
        try {
          let list: Flight[]
          if (rect && Cesium.Math.toDegrees(rect.north - rect.south) > 18) {
            const r = await window.world.flightsArea({ south: Cesium.Math.toDegrees(rect.south), north: Cesium.Math.toDegrees(rect.north), west: Cesium.Math.toDegrees(rect.west), east: Cesium.Math.toDegrees(rect.east) })
            list = r.flights
          } else list = await window.world.flights(lat, lon, Math.min(1000, Math.max(80, c.height / 1852)), false)
          const f = followRef.current
          // Keep the followed aircraft even if the view moved off it.
          if (f && !list.some(x => x.hex === f.hex)) {
            const prev = flights.current.byHex.get(f.hex)
            if (prev) list = [...list, prev]
          }
          flights.current = { list, at: Date.now(), byHex: new Map(list.map(x => [x.hex, x])) }
          setCounts(x => ({ ...x, flights: list.length }))
        } catch {
          // Next poll.
        }
        try {
          if (rect) {
            const r = await window.world.ships({ south: Math.max(-90, Cesium.Math.toDegrees(rect.south)), north: Math.min(90, Cesium.Math.toDegrees(rect.north)), west: Math.max(-180, Cesium.Math.toDegrees(rect.west)), east: Math.min(180, Cesium.Math.toDegrees(rect.east)) })
            drawShips(r.ships)
          }
        } catch {
          // No ships here.
        }
      }

      // ── satellites at their real height ──
      const satPoints = scene.primitives.add(new Cesium.PointPrimitiveCollection()) as Cesium.PointPrimitiveCollection
      let sats: { name: string; rec: satellite.SatRec; point: Cesium.PointPrimitive }[] = []
      void window.world.satellites().then(
        listSats => {
          if (!viewer || viewer.isDestroyed()) return
          sats = listSats.flatMap(s => {
            try {
              const rec = satellite.json2satrec(s as unknown as satellite.OMMJsonObject)
              const name = String(s.OBJECT_NAME ?? '')
              return [{ name, rec, point: satPoints.add({ pixelSize: /ISS \(ZARYA\)/.test(name) ? 9 : 4, color: Cesium.Color.fromCssColorString(/ISS/.test(name) ? '#f0abfc' : '#c084fc'), id: { kind: 'sat', name } }) }]
            } catch {
              return []
            }
          })
          setCounts(x => ({ ...x, sats: sats.length }))
        },
        () => undefined,
      )
      const moveSats = () => {
        const now = new Date()
        for (const s of sats) {
          const f = orbitFacts(s.rec, now)
          if (f) s.point.position = Cesium.Cartesian3.fromDegrees(f.lon, f.lat, f.altKm * 1000)
        }
      }

      // ── fly with it: the camera rides the followed aircraft every frame ──
      const enu = new Cesium.Matrix4()
      const scratch = new Cesium.Cartesian3()
      scene.preRender.addEventListener(() => {
        const fol = followRef.current
        if (!fol || !viewer) return
        const raw = flights.current.byHex.get(fol.hex)
        if (!raw) return
        const f = deadReckon(raw, raw.seen + (Date.now() - flights.current.at) / 1000)
        const h = Cesium.Math.toRadians(f.track)
        const pos = Cesium.Cartesian3.fromDegrees(f.lon, f.lat, altM(f) + (fol.mode === 'cockpit' ? 4 : 0))
        Transforms.eastNorthUpToFixedFrame(pos, Cesium.Ellipsoid.WGS84, enu)
        const back = fol.mode === 'chase' ? 350 : -25
        const up = fol.mode === 'chase' ? 80 : 0
        const cam = Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(-Math.sin(h) * back, -Math.cos(h) * back, up), scratch)
        const climb = f.verticalRate ? Math.atan2(f.verticalRate * 0.00508, Math.max(30, f.speed * 0.514)) : 0
        viewer.camera.setView({ destination: Cesium.Cartesian3.clone(cam), orientation: { heading: h, pitch: fol.mode === 'chase' ? Cesium.Math.toRadians(-11) : climb - Cesium.Math.toRadians(3), roll: 0 } })
      })

      // ── picking ──
      const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas)
      handler.setInputAction((click: { position: Cartesian2 }) => {
        const hit = scene.pick(click.position) as { id?: { kind?: string; hex?: string } } | undefined
        const hex = hit?.id?.kind === 'flight' ? hit.id.hex : undefined
        setPicked(hex ? (flights.current.byHex.get(hex) ?? null) : null)
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

      void poll()
      timers.push(setInterval(() => void poll(), POLL_MS))
      timers.push(setInterval(placeAll, 400))
      timers.push(setInterval(moveSats, 2_000))
      timers.push(setInterval(() => tick(n => n + 1), 500))
      viewer.camera.moveEnd.addEventListener(() => void poll())
    })()
    return () => {
      disposed = true
      for (const t of timers) clearInterval(t)
      if (viewer && !viewer.isDestroyed()) viewer.destroy()
      viewerRef.current = null
    }
    // The view is made once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The route of the picked or followed aircraft, for the flight card.
  const routeHex = follow?.hex ?? picked?.hex ?? null
  useEffect(() => {
    setRoute(null)
    const f = routeHex ? flights.current.byHex.get(routeHex) : null
    if (!f?.callsign) return
    let gone = false
    void window.world.flightRoute(f.callsign).then(
      r => !gone && setRoute(r),
      () => undefined,
    )
    return () => {
      gone = true
    }
  }, [routeHex])

  const startFollow = (hex: string, mode: Follow['mode']) => {
    setFollow({ hex, mode })
    setPicked(null)
  }
  const stopFollow = () => {
    setFollow(null)
    const v = viewerRef.current
    const f = follow ? flights.current.byHex.get(follow.hex) : null
    if (v && f) v.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(f.lon, f.lat - 0.25, altM(f) + 25_000), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 }, duration: 1.2 })
  }

  // The followed aircraft now, its neighbours, and the next / previous one to jump to.
  const live = follow ? flights.current.byHex.get(follow.hex) : null
  const now = live ? deadReckon(live, live.seen + (Date.now() - flights.current.at) / 1000) : null
  const neighbours = now
    ? flights.current.list
        .filter(f => f.hex !== now.hex)
        .map(f => ({ f, km: kmBetween(now, f) }))
        .sort((a, b) => a.km - b.km)
        .slice(0, 6)
    : []
  const jump = (dir: 1 | -1) => {
    if (!now) return
    const order = flights.current.list
      .filter(f => f.altitude !== null)
      .map(f => ({ f, km: kmBetween(now, f) }))
      .sort((a, b) => a.km - b.km)
    const i = order.findIndex(o => o.f.hex === now.hex)
    const next = order[(i + dir + order.length) % order.length]
    if (next) setFollow(fo => (fo ? { ...fo, hex: next.f.hex } : fo))
  }
  const progress = route && now ? kmBetween(route.origin, now) / Math.max(1, kmBetween(route.origin, now) + kmBetween(now, route.destination)) : null

  const panel = 'rounded-2xl border border-accent/30 bg-[rgba(4,10,20,0.78)] text-white shadow-[0_0_18px_rgba(34,211,238,0.18)]'
  const mono = 'font-mono uppercase tracking-[0.12em]'

  return (
    <div className="absolute inset-0 z-30 bg-black">
      <div ref={box} className="absolute inset-0" />
      <div ref={credits} className="hidden" />
      {/* Top bar: tier, counts, back to 2D. */}
      <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2">
        <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] ${panel}`}>
          <Box className="size-3.5 text-accent" aria-hidden /> 3D · {tier ? TIER_LABEL[tier] : 'loading…'}
        </span>
        <span className={`rounded-full px-3 py-1 text-[10px] text-accent/80 ${panel} ${mono}`}>
          FLT {counts.flights} · SHIP {counts.ships} · SAT {counts.sats}
        </span>
        {tier === 'keyless' && <span className="rounded-full bg-black/60 px-2.5 py-1 text-[10px] text-white/60">Add a Cesium ion or Google key in Setup › Power up for 3D buildings and cities</span>}
      </div>
      <button type="button" onClick={onClose} className={`absolute right-3 top-3 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs hover:border-accent ${panel}`}>
        <ArrowLeftRight className="size-3.5" aria-hidden /> Back to 2D
      </button>
      {error && <p className="absolute left-3 top-12 max-w-md rounded-lg bg-black/70 px-2 py-1 text-[11px] text-warm">{error}</p>}

      {/* A picked aircraft: what it is, and fly with it. */}
      {picked && !follow && (
        <div className={`absolute bottom-24 left-3 w-72 max-w-[calc(100%-1.5rem)] space-y-2 p-3 ${panel}`}>
          <div className="flex items-start gap-2">
            <Plane className="mt-0.5 size-4 text-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{flightLabel(picked)}</p>
              <p className="truncate text-[11px] text-white/60">{[aircraftName(picked.type) || picked.type, picked.registration].filter(Boolean).join(' · ')}</p>
              {route && (
                <p className="mt-1 text-[11px] text-white/80">
                  {route.origin.iata || route.origin.icao} → {route.destination.iata || route.destination.icao} · {route.airline}
                </p>
              )}
            </div>
            <button type="button" onClick={() => setPicked(null)} className="text-white/60 hover:text-white" aria-label="Close">
              <X className="size-4" aria-hidden />
            </button>
          </div>
          {picked.altitude !== null ? (
            <div className="flex gap-1.5">
              <button type="button" onClick={() => startFollow(picked.hex, 'chase')} className="flex flex-1 items-center justify-center gap-1 rounded-full bg-accent/90 px-2 py-1.5 text-xs font-medium text-accent-fg hover:bg-accent">
                <Video className="size-3.5" aria-hidden /> Fly with it
              </button>
              <button type="button" onClick={() => startFollow(picked.hex, 'cockpit')} className="flex flex-1 items-center justify-center gap-1 rounded-full border border-accent/50 px-2 py-1.5 text-xs text-accent hover:bg-accent/10">
                <Eye className="size-3.5" aria-hidden /> Cockpit
              </button>
            </div>
          ) : (
            <p className="text-[11px] text-white/50">On the ground.</p>
          )}
        </div>
      )}

      {/* Flying with an aircraft: the HUD. */}
      {follow && now && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center">
            <div className="relative h-8 w-80 overflow-hidden rounded-full border border-accent/30 bg-black/40">
              {headingTape(now.track).map(t => (
                <span key={`${t.deg}-${t.offset}`} className={`absolute top-1.5 -translate-x-1/2 text-[11px] ${mono} ${/[NESW]/.test(t.label) ? 'text-accent' : 'text-white/70'}`} style={{ left: `${(t.offset + 0.5) * 100}%` }}>
                  {t.label}
                </span>
              ))}
              <span className="absolute left-1/2 top-0 h-2 w-px bg-accent" />
            </div>
          </div>
          <div className={`pointer-events-none absolute bottom-40 left-1/2 flex -translate-x-1/2 items-end gap-10 ${mono}`}>
            <div className="text-center">
              <p className="text-[10px] text-accent/70">Ground speed · kt</p>
              <p className="text-4xl font-light text-white [text-shadow:0_0_12px_rgba(0,0,0,0.9)]">{Math.round(now.speed)}</p>
            </div>
            <div className="text-center">
              <p className="text-[10px] text-accent/70">{now.verticalRate && Math.abs(now.verticalRate) > 200 ? (now.verticalRate > 0 ? 'Climbing' : 'Descending') : 'Level'}</p>
              <p className="text-2xl font-light text-white/80">{now.verticalRate ? `${now.verticalRate > 0 ? '+' : ''}${Math.round(now.verticalRate)}` : '0'}</p>
            </div>
            <div className="text-center">
              <p className="text-[10px] text-accent/70">Altitude · ft</p>
              <p className="text-4xl font-light text-white [text-shadow:0_0_12px_rgba(0,0,0,0.9)]">{now.altitude === null ? 'GND' : Math.round(now.altitude).toLocaleString()}</p>
            </div>
          </div>
          <div className={`absolute left-3 top-14 w-64 space-y-2 p-3 ${panel}`}>
            <p className="text-sm font-semibold">{flightLabel(now)}</p>
            <p className="text-[11px] text-white/60">{[aircraftName(now.type) || now.type, now.registration, now.military ? 'military' : ''].filter(Boolean).join(' · ')}</p>
            {route ? (
              <div className="space-y-1">
                <div className={`flex items-center justify-between text-base ${mono}`}>
                  <span title={route.origin.name}>{route.origin.iata || route.origin.icao}</span>
                  <Plane className="size-3.5 text-accent" aria-hidden />
                  <span title={route.destination.name}>{route.destination.iata || route.destination.icao}</span>
                </div>
                {progress !== null && (
                  <div className="h-1 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(progress * 100)}%` }} />
                  </div>
                )}
                <p className="text-[10px] text-white/55">
                  {route.origin.city} → {route.destination.city} · {Math.round(kmBetween(now, route.destination)).toLocaleString()} km to go
                </p>
              </div>
            ) : (
              <p className="text-[10px] text-white/45">No published route for this callsign.</p>
            )}
          </div>
          <div className={`absolute right-3 top-14 w-60 p-3 ${panel}`}>
            <p className={`mb-1.5 text-[10px] text-accent/80 ${mono}`}>Live signals · around it</p>
            <ul className="space-y-1">
              {neighbours.map(n => (
                <li key={n.f.hex}>
                  <button type="button" onClick={() => setFollow(fo => (fo ? { ...fo, hex: n.f.hex } : fo))} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] hover:bg-white/10">
                    <span className="size-1.5 rounded-full" style={{ background: colorOf(n.f) }} />
                    <span className="min-w-0 flex-1 truncate">{n.f.callsign || n.f.hex}</span>
                    <span className="text-white/50">{Math.round(n.km)} km</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="absolute bottom-24 left-1/2 flex -translate-x-1/2 items-center gap-1.5">
            <button type="button" onClick={() => jump(-1)} className={`grid size-9 place-items-center rounded-full ${panel}`} title="Previous aircraft" aria-label="Previous aircraft">
              <ChevronLeft className="size-4" aria-hidden />
            </button>
            <button type="button" onClick={() => setFollow(fo => (fo ? { ...fo, mode: fo.mode === 'chase' ? 'cockpit' : 'chase' } : fo))} className={`rounded-full px-3 py-2 text-xs ${panel}`}>
              {follow.mode === 'chase' ? 'Cockpit view' : 'Chase view'}
            </button>
            <button type="button" onClick={stopFollow} className={`rounded-full px-3 py-2 text-xs text-warm ${panel}`}>
              Stop flying
            </button>
            <button type="button" onClick={() => jump(1)} className={`grid size-9 place-items-center rounded-full ${panel}`} title="Next aircraft" aria-label="Next aircraft">
              <ChevronRight className="size-4" aria-hidden />
            </button>
          </div>
        </>
      )}
      <p className="pointer-events-none absolute bottom-1 right-2 text-[9px] text-white/40">
        {tier === 'google' ? 'Google Map Tiles' : tier === 'ion' ? 'Cesium ion · Esri World Imagery' : 'Esri World Imagery · Re:Earth terrain'} · CesiumJS · aircraft models CC BY 4.0 (see credits)
      </p>
    </div>
  )
}
