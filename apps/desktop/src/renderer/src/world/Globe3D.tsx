/**
 * The 3D World view (CesiumJS, loaded only when opened). Three tiers, like
 * God's Eye View: no key = free satellite imagery (Esri) on keyless terrain
 * (Re:Earth); a Cesium ion token = world terrain and 3D buildings; a Google
 * key = photorealistic 3D cities. Live aircraft at their real altitude (3D
 * models near the camera, icons elsewhere), ships, satellites at their real
 * height. Pick a plane and "Fly with it": a chase or cockpit camera riding it,
 * a flight HUD, its route, and the next aircraft around it. Satellites by
 * group with orbit rings, follow and a look-down "satellite's eye"; the
 * world's submarine cables; the celestial ring (Sun, Moon, day and night);
 * public cameras, each picked one showing its view cone and its live frame
 * or stream on a screen in the scene.
 *
 * Light on the machine: Cesium draws a frame only when something changed
 * (the camera moved, tiles or data arrived), continuously only while riding
 * a plane or a satellite, and not at all while the window is hidden.
 */
import '@cesium/engine/Source/Widget/CesiumWidget.css'

// The engine alone: the full "cesium" package's widgets evaluate code from strings, which the page's security policy forbids.
import * as Cesium from '@cesium/engine'
import { Cartesian2, FixedFrameTransforms as Transforms } from '@cesium/core'
import { ArrowLeftRight, Box, Cable, ChevronLeft, ChevronRight, Crosshair, Eye, Orbit, Plane, Satellite, Ship as ShipIcon, Sparkles, Video, Cctv, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { kmBetween, type Flight, type FlightRoute, type Ship } from '../../../shared/world.ts'
import { aircraftName } from '../../../shared/aircraft.ts'
import { satGroup, SAT_GROUPS, type CableDetail, type SatGroupId } from '../../../shared/space.ts'
import { Cables3D } from './cables3d.ts'
import { Cameras3D, type CameraView } from './cams3d.ts'
import { CameraDetail } from './Inspector.tsx'
import { CelestialRing } from './CelestialRing.tsx'
import { deadReckon, flightLabel, planeIcon, shipIcon } from './geo.ts'
import { MODEL_HEADING_OFFSET, headingTape, heightForZoom, modelFor, type ModelId } from './models3d.ts'
import { Satellites3D } from './sats3d.ts'
import { latLonLabel } from './sky.ts'

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

type LayerKey = 'flights' | 'ships' | 'sats' | 'cameras' | 'cables' | 'celestial'
type Layers = Record<LayerKey, boolean> & { hiddenSats: SatGroupId[] }
const LAYERS_KEY = 'atlas.globe3d.layers'
const DEFAULT_LAYERS: Layers = { flights: true, ships: true, sats: true, cameras: true, cables: false, celestial: false, hiddenSats: [] }
const readLayers = (): Layers => {
  try {
    return { ...DEFAULT_LAYERS, ...(JSON.parse(localStorage.getItem(LAYERS_KEY) ?? '{}') as Partial<Layers>) }
  } catch {
    return DEFAULT_LAYERS
  }
}

type Counts = { flights: number; ships: number; sats: number; cables: number; cameras: number }
const RAIL: { k: LayerKey; label: string; icon: typeof Plane; count: (c: Counts) => string }[] = [
  { k: 'flights', label: 'Flights', icon: Plane, count: c => String(c.flights) },
  { k: 'ships', label: 'Ships', icon: ShipIcon, count: c => String(c.ships) },
  { k: 'sats', label: 'Satellites', icon: Satellite, count: c => String(c.sats) },
  { k: 'cameras', label: 'Cameras', icon: Cctv, count: c => (c.cameras ? String(c.cameras) : '') },
  { k: 'cables', label: 'Sea cables', icon: Cable, count: c => (c.cables ? String(c.cables) : '') },
  { k: 'celestial', label: 'Celestial', icon: Sparkles, count: () => '' },
]

interface SatRide {
  i: number
  mode: 'follow' | 'eye'
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
  const [counts, setCounts] = useState<Counts>({ flights: 0, ships: 0, sats: 0, cables: 0, cameras: 0 })
  followRef.current = follow
  const [layers, setLayers] = useState(readLayers)
  const layersRef = useRef(layers)
  layersRef.current = layers
  const [widget, setWidget] = useState<Cesium.CesiumWidget | null>(null)
  const parts = useRef<{ bills: Cesium.BillboardCollection; shipBills: Cesium.BillboardCollection; sats: Satellites3D; cables: Cables3D; cams: Cameras3D } | null>(null)
  const [camPick, setCamPick] = useState<number | null>(null)
  const camView = useRef<CameraView | null>(null)
  const [satPick, setSatPick] = useState<number | null>(null)
  const [satRide, setSatRide] = useState<SatRide | null>(null)
  const satRideRef = useRef<SatRide | null>(null)
  satRideRef.current = satRide
  const [satCounts, setSatCounts] = useState<Partial<Record<SatGroupId, number>>>({})
  const [cable, setCable] = useState<{ id: string; name: string; detail: CableDetail | null } | null>(null)
  const [landing, setLanding] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    const timers: ReturnType<typeof setInterval>[] = []
    const cleanups: (() => void)[] = []
    let viewer: Cesium.CesiumWidget | null = null
    void (async () => {
      const keys = await window.world.map3dKeys().catch(() => ({ google: null, ion: null }))
      if (disposed || !box.current) return
      if (keys.ion) Cesium.Ion.defaultAccessToken = keys.ion
      viewer = new Cesium.CesiumWidget(box.current, { baseLayer: false, creditContainer: credits.current ?? undefined, msaaSamples: 4, requestRenderMode: true, maximumRenderTimeChange: Infinity, showRenderLoopErrors: false })
      // Cesium stops drawing after an error: say so in Atlas's own words.
      viewer.scene.renderError.addEventListener((_scene: unknown, e: unknown) => setError(`The 3D view stopped drawing (${e instanceof Error ? e.message.slice(0, 80) : 'error'}). Go back to 2D and open 3D again.`))
      viewerRef.current = viewer
      // Nothing is drawn while the window is hidden or minimised.
      const onVisible = () => {
        if (viewer && !viewer.isDestroyed()) viewer.useDefaultRenderLoop = !document.hidden
      }
      document.addEventListener('visibilitychange', onVisible)
      cleanups.push(() => document.removeEventListener('visibilitychange', onVisible))
      // A handle for driving the view from the debugger, on the dev server only.
      if (location.protocol === 'http:') (window as unknown as { __globe3d?: unknown }).__globe3d = { viewer, Cesium, parts: () => parts.current }
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
      // A continent or the world: look straight down at it. A region: a tilted view, as from a plane.
      const wide = start.zoom < 5
      viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(start.lon, wide ? Cesium.Math.clamp(start.lat, -60, 60) : start.lat - Math.min(8, 30 / 2 ** start.zoom), Math.min(22_000_000, heightForZoom(start.zoom, start.lat))), orientation: { heading: 0, pitch: Cesium.Math.toRadians(wide ? -90 : -55), roll: 0 } })

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
        if (!layersRef.current.flights) {
          for (const m of models.values()) m.model.show = false
          return
        }
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
                scene.requestRender()
              },
              () => loading.delete(n.f.hex),
            )
          }
        }
        scene.requestRender()
      }

      // ── ships ──
      const shipBills = scene.primitives.add(new Cesium.BillboardCollection({ scene })) as Cesium.BillboardCollection
      const drawShips = (list: Ship[]) => {
        shipBills.removeAll()
        for (const s of list.slice(0, 3000))
          shipBills.add({ position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 0), image: shipImg, width: 14, height: 14, color: Cesium.Color.fromCssColorString('#34d399'), rotation: -Cesium.Math.toRadians(s.heading ?? s.course), alignedAxis: Cesium.Cartesian3.UNIT_Z, scaleByDistance: new Cesium.NearFarScalar(1e4, 1, 5e6, 0.4), heightReference: Cesium.HeightReference.CLAMP_TO_GROUND, id: { kind: 'ship', name: s.name } })
        setCounts(x => ({ ...x, ships: list.length }))
        scene.requestRender()
      }

      const poll = async () => {
        if (!viewer || viewer.isDestroyed() || document.hidden) return
        const rect = viewer.camera.computeViewRectangle()
        const c = viewer.camera.positionCartographic
        const lat = Cesium.Math.toDegrees(c.latitude)
        const lon = Cesium.Math.toDegrees(c.longitude)
        if (layersRef.current.flights)
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
        if (layersRef.current.ships)
          try {
          if (rect) {
            const r = await window.world.ships({ south: Math.max(-90, Cesium.Math.toDegrees(rect.south)), north: Math.min(90, Cesium.Math.toDegrees(rect.north)), west: Math.max(-180, Cesium.Math.toDegrees(rect.west)), east: Math.min(180, Cesium.Math.toDegrees(rect.east)) })
            drawShips(r.ships)
          }
        } catch {
          // No ships here.
        }
      }

      // ── satellites by group, and the cables (loaded when first shown) ──
      const sats = new Satellites3D(scene)
      const cables = new Cables3D(scene)
      const cams = new Cameras3D(scene)
      parts.current = { bills, shipBills, sats, cables, cams }
      setWidget(viewer)
      void window.world.satellites('all').then(
        list => {
          if (!viewer || viewer.isDestroyed()) return
          sats.load(list)
          for (const g of layersRef.current.hiddenSats) sats.setGroupHidden(g, true)
          sats.setVisible(layersRef.current.sats)
          setCounts(x => ({ ...x, sats: sats.list.length }))
          setSatCounts(sats.counts())
          scene.requestRender()
        },
        () => undefined,
      )
      const moveSats = () => {
        if (!layersRef.current.sats || document.hidden) return
        sats.move(new Date())
        scene.requestRender()
      }

      // ── fly with it: the camera rides the followed aircraft every frame ──
      const enu = new Cesium.Matrix4()
      const scratch = new Cesium.Cartesian3()
      scene.preRender.addEventListener(() => {
        // Riding a satellite: follow it (the camera keeps its offset, so it can still be turned), or look straight down from it.
        const ride = satRideRef.current
        const rs = ride ? sats.list[ride.i] : undefined
        if (ride && rs && viewer) {
          const w = sats.where(rs)
          if (!w) return
          const pos = Cesium.Cartesian3.fromDegrees(w.lon, w.lat, w.altM)
          rs.point.position = pos
          if (ride.mode === 'eye') viewer.camera.setView({ destination: pos, orientation: { heading: Cesium.Math.toRadians(w.heading), pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 } })
          else viewer.camera.lookAtTransform(Transforms.eastNorthUpToFixedFrame(pos, Cesium.Ellipsoid.WGS84, enu))
          return
        }
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
        const hit = scene.pick(click.position) as { id?: { kind?: string; hex?: string; i?: number; id?: string; name?: string } } | undefined
        const id = hit?.id
        const hex = id?.kind === 'flight' ? id.hex : undefined
        setPicked(hex ? (flights.current.byHex.get(hex) ?? null) : null)
        if (satRideRef.current) return
        setSatPick(id?.kind === 'sat' && typeof id.i === 'number' ? id.i : null)
        setCamPick(id?.kind === 'cam' && typeof id.i === 'number' ? id.i : null)
        setLanding(id?.kind === 'landing' ? (id.name ?? null) : null)
        const cableId = id?.kind === 'cable' ? id.id : undefined
        cables.highlight(cableId ?? null)
        scene.requestRender()
        if (!cableId) return setCable(null)
        setCable({ id: cableId, name: cables.names.get(cableId) ?? cableId, detail: null })
        void window.world.cable(cableId).then(
          detail => setCable(c => (c?.id === cableId ? { ...c, detail } : c)),
          () => undefined,
        )
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
      for (const c of cleanups) c()
      parts.current = null
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

  // Layers: remembered on this PC, and applied to the scene.
  useEffect(() => {
    try {
      localStorage.setItem(LAYERS_KEY, JSON.stringify(layers))
    } catch {
      // A private window: not remembered.
    }
    const pt = parts.current
    if (!widget || !pt || widget.isDestroyed()) return
    pt.bills.show = layers.flights
    pt.shipBills.show = layers.ships
    pt.sats.setVisible(layers.sats)
    for (const g of SAT_GROUPS) pt.sats.setGroupHidden(g.id, layers.hiddenSats.includes(g.id))
    pt.cams.setVisible(layers.cameras)
    if (layers.cameras && !pt.cams.loaded)
      void window.world.cameras().then(
        list => {
          if (widget.isDestroyed() || pt.cams.loaded) return
          pt.cams.load(list)
          pt.cams.setVisible(layersRef.current.cameras)
          setCounts(x => ({ ...x, cameras: list.length }))
          widget.scene.requestRender()
        },
        () => undefined,
      )
    pt.cables.setVisible(layers.cables)
    if (layers.cables && !pt.cables.loaded)
      void window.world.cables().then(
        data => {
          if (!data || widget.isDestroyed()) return
          pt.cables.load(data)
          pt.cables.setVisible(layersRef.current.cables)
          setCounts(x => ({ ...x, cables: data.cables.length }))
          widget.scene.requestRender()
        },
        () => undefined,
      )
    // Real day and night only with the celestial ring (otherwise a black night side reads as broken).
    widget.scene.globe.enableLighting = layers.celestial
    widget.scene.requestRender()
  }, [widget, layers])

  // Continuous frames only while the camera rides something.
  useEffect(() => {
    if (!widget || widget.isDestroyed()) return
    widget.scene.requestRenderMode = !(follow || satRide)
    widget.scene.requestRender()
  }, [widget, follow, satRide])

  // The picked satellite's orbit ring.
  useEffect(() => {
    const pt = parts.current
    if (!widget || !pt || widget.isDestroyed()) return
    pt.sats.showOrbit(satPick === null ? null : (pt.sats.list[satPick] ?? null))
    widget.scene.requestRender()
  }, [widget, satPick])

  // Start or stop riding a satellite.
  useEffect(() => {
    const pt = parts.current
    if (!widget || !pt || widget.isDestroyed()) return
    const cam = widget.camera
    cam.lookAtTransform(Cesium.Matrix4.IDENTITY)
    const sat = satRide ? pt.sats.list[satRide.i] : undefined
    const w = sat ? pt.sats.where(sat) : null
    if (satRide?.mode === 'follow' && w) cam.lookAt(Cesium.Cartesian3.fromDegrees(w.lon, w.lat, w.altM), new Cesium.HeadingPitchRange(0, -0.6, w.altM > 2_000_000 ? 4_000_000 : 900_000))
    widget.scene.requestRender()
  }, [widget, satRide])

  // The picked camera: fly to it, draw its view cone, and put its frame (or its live stream) on the screen at the cone's end.
  useEffect(() => {
    const pt = parts.current
    if (!widget || !pt || widget.isDestroyed()) return
    const cam = camPick !== null ? pt.cams.list[camPick] : undefined
    if (!cam) {
      pt.cams.clear()
      camView.current = null
      widget.scene.requestRender()
      return
    }
    let gone = false
    let playing = false
    let stopVideo = () => {}
    let frames: ReturnType<typeof setInterval> | null = null
    const draw = (frame: string | HTMLVideoElement | null) => {
      camView.current = pt.cams.show(cam, frame)
      widget.scene.requestRender()
    }
    const still = () =>
      window.world.cameraImage(cam.id).then(
        r => !gone && !playing && draw(r.dataUrl),
        () => !gone && !playing && draw(null),
      )
    draw(null)
    void still()
    const refresh = setInterval(() => void still(), 30_000)
    // Live HLS plays through MediaSource (a blob: source), so its frames can be drawn into the scene.
    if (cam.video?.kind === 'hls' && cam.heading !== undefined) {
      const v = document.createElement('video')
      v.muted = true
      v.playsInline = true
      void import('hls.js').then(
        ({ default: Hls }) => {
          if (gone || !Hls.isSupported()) return
          const hls = new Hls({ lowLatencyMode: true, maxBufferLength: 10 })
          stopVideo = () => {
            hls.destroy()
            v.removeAttribute('src')
          }
          hls.on(Hls.Events.MANIFEST_PARSED, () => void v.play().catch(() => undefined))
          hls.on(Hls.Events.ERROR, (_e, d) => d.fatal && stopVideo())
          hls.loadSource(cam.video!.url)
          hls.attachMedia(v)
          v.addEventListener(
            'playing',
            () => {
              if (gone) return
              playing = true
              draw(v)
              // A playing screen needs frames: about 15 a second, only while it plays.
              frames = setInterval(() => !document.hidden && widget.scene.requestRender(), 66)
            },
            { once: true },
          )
        },
        () => undefined,
      )
    }
    // Fly to it: behind and above, looking the way it looks.
    const ground = widget.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(cam.lon, cam.lat)) ?? 0
    const h = Cesium.Math.toRadians(cam.heading ?? 0)
    const back = cam.heading === undefined ? 0 : 260
    const eye = Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, ground), Cesium.Ellipsoid.WGS84)
    widget.camera.flyTo({ destination: Cesium.Matrix4.multiplyByPoint(eye, new Cesium.Cartesian3(-Math.sin(h) * back, -Math.cos(h) * back, cam.heading === undefined ? 700 : 160), new Cesium.Cartesian3()), orientation: { heading: h, pitch: Cesium.Math.toRadians(cam.heading === undefined ? -89 : -22), roll: 0 }, duration: 1.6 })
    return () => {
      gone = true
      clearInterval(refresh)
      if (frames) clearInterval(frames)
      stopVideo()
      pt.cams.clear()
      widget.scene.requestRender()
    }
  }, [widget, camPick])

  const viewFromCamera = () => {
    const v = camView.current
    if (!widget || !v || v.heading === undefined) return
    widget.camera.flyTo({ destination: v.eye, orientation: { heading: Cesium.Math.toRadians(v.heading), pitch: Cesium.Math.toRadians(-v.tiltDeg), roll: 0 }, duration: 1.4 })
  }

  // Escape steps back: stop riding, then close what is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (satRideRef.current) return setSatRide(null)
      if (followRef.current) return setFollow(null)
      setPicked(null)
      setSatPick(null)
      setCamPick(null)
      setCable(null)
      setLanding(null)
      parts.current?.cables.highlight(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggle = (k: LayerKey) => {
    const on = !layers[k]
    setLayers(l => ({ ...l, [k]: on }))
    // The ring needs the whole globe in view.
    if (k === 'celestial' && on && widget) {
      const c = widget.camera.positionCartographic
      widget.camera.flyTo({ destination: Cesium.Cartesian3.fromRadians(c.longitude, Cesium.Math.clamp(c.latitude, -0.5, 0.5), 22_000_000), duration: 2.4 })
    }
    if (k === 'sats' && !on) (setSatPick(null), setSatRide(null))
    if (k === 'cables' && !on) (setCable(null), setLanding(null))
    if (k === 'cameras' && !on) setCamPick(null)
  }

  const closeCable = () => {
    setCable(null)
    parts.current?.cables.highlight(null)
    widget?.scene.requestRender()
  }
  const flyOverCable = (id: string) => {
    const c = parts.current?.cables.centre(id)
    if (!c || !widget) return
    const g = Cesium.Cartographic.fromCartesian(c)
    widget.camera.flyTo({ destination: Cesium.Cartesian3.fromRadians(g.longitude, g.latitude, 4_500_000), duration: 1.8 })
  }

  const cam = camPick !== null ? parts.current?.cams.list[camPick] : undefined
  const sat = satPick !== null ? parts.current?.sats.list[satPick] : undefined
  const satNow = sat ? parts.current?.sats.facts(sat) : null

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
      {layers.celestial && widget && !follow && !satRide && <CelestialRing widget={widget} />}
      {/* Top bar: tier, counts, back to 2D. */}
      <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2">
        <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] ${panel}`}>
          <Box className="size-3.5 text-accent" aria-hidden /> 3D · {tier ? TIER_LABEL[tier] : 'loading…'}
        </span>
        <span className={`rounded-full px-3 py-1 text-[10px] text-accent/80 ${panel} ${mono}`}>
          FLT {counts.flights} · SHIP {counts.ships} · SAT {counts.sats}
          {layers.cables && counts.cables ? ` · CBL ${counts.cables}` : ''}
        </span>
        {tier === 'keyless' && <span className="rounded-full bg-black/60 px-2.5 py-1 text-[10px] text-white/60">Add a Cesium ion or Google key in Setup › Power up for 3D buildings and cities</span>}
      </div>
      <button type="button" onClick={onClose} className={`absolute right-3 top-3 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs hover:border-accent ${panel}`}>
        <ArrowLeftRight className="size-3.5" aria-hidden /> Back to 2D
      </button>
      {error && <p className="absolute left-3 top-12 max-w-md rounded-lg bg-black/70 px-2 py-1 text-[11px] text-warm">{error}</p>}

      {/* Data layers (God's Eye View's left rail): what the globe shows, with satellite groups. */}
      {!follow && !satRide && (
        <div className={`absolute left-3 top-14 w-48 space-y-0.5 p-2 ${panel}`}>
          <p className={`px-1 pb-0.5 text-[10px] text-accent/80 ${mono}`}>Data layers</p>
          {RAIL.map(r => (
            <button key={r.k} type="button" onClick={() => toggle(r.k)} aria-pressed={layers[r.k]} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs hover:bg-white/10 ${layers[r.k] ? 'text-white' : 'text-white/40'}`}>
              <r.icon className={`size-3.5 ${layers[r.k] ? 'text-accent' : ''}`} aria-hidden />
              <span className="flex-1">{r.label}</span>
              <span className="font-mono text-[10px] text-white/50">{layers[r.k] ? r.count(counts) : 'off'}</span>
            </button>
          ))}
          {layers.sats && (
            <div className="flex flex-wrap gap-1 px-1 pt-1">
              {SAT_GROUPS.map(g => {
                const off = layers.hiddenSats.includes(g.id)
                return (
                  <button
                    key={g.id}
                    type="button"
                    title={`${g.label}: ${satCounts[g.id] ?? 0}`}
                    aria-pressed={!off}
                    onClick={() => setLayers(l => ({ ...l, hiddenSats: off ? l.hiddenSats.filter(x => x !== g.id) : [...l.hiddenSats, g.id] }))}
                    className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] ${off ? 'border-white/10 text-white/35' : 'border-white/20 text-white/80'}`}
                  >
                    <span className="size-1.5 rounded-full" style={{ background: off ? 'transparent' : g.color, border: `1px solid ${g.color}` }} />
                    {g.label}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* A picked satellite: its orbit, and ride it. */}
      {sat && !follow && (
        <div className={`absolute bottom-24 left-3 w-72 max-w-[calc(100%-1.5rem)] space-y-2 p-3 ${panel}`}>
          <div className="flex items-start gap-2">
            <Satellite className="mt-0.5 size-4" style={{ color: satGroup(sat.group).color }} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{sat.name}</p>
              <p className="text-[11px] text-white/60">
                {satGroup(sat.group).label} · NORAD {sat.norad}
              </p>
            </div>
            <button type="button" onClick={() => (setSatRide(null), setSatPick(null))} className="text-white/60 hover:text-white" aria-label="Close">
              <X className="size-4" aria-hidden />
            </button>
          </div>
          {satNow && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
              <dt className="text-white/50">Altitude</dt>
              <dd className="font-mono">{Math.round(satNow.altKm).toLocaleString()} km</dd>
              <dt className="text-white/50">Speed</dt>
              <dd className="font-mono">{satNow.speedKms.toFixed(2)} km/s</dd>
              <dt className="text-white/50">Orbit</dt>
              <dd className="font-mono">
                {satNow.periodMin < 200 ? `${satNow.periodMin.toFixed(0)} min` : `${(satNow.periodMin / 60).toFixed(1)} h`} · {satNow.inclination.toFixed(1)}° tilt
              </dd>
              <dt className="text-white/50">Over</dt>
              <dd className="font-mono">{latLonLabel(satNow)}</dd>
            </dl>
          )}
          <div className="flex gap-1.5">
            <button type="button" onClick={() => setSatRide(r => (r?.mode === 'follow' ? null : { i: sat.i, mode: 'follow' }))} aria-pressed={satRide?.mode === 'follow'} className={`flex flex-1 items-center justify-center gap-1 rounded-full px-2 py-1.5 text-xs ${satRide?.mode === 'follow' ? 'bg-accent/90 text-accent-fg' : 'border border-accent/50 text-accent hover:bg-accent/10'}`}>
              <Crosshair className="size-3.5" aria-hidden /> {satRide?.mode === 'follow' ? 'Following' : 'Follow'}
            </button>
            <button type="button" onClick={() => setSatRide(r => (r?.mode === 'eye' ? null : { i: sat.i, mode: 'eye' }))} aria-pressed={satRide?.mode === 'eye'} className={`flex flex-1 items-center justify-center gap-1 rounded-full px-2 py-1.5 text-xs ${satRide?.mode === 'eye' ? 'bg-accent/90 text-accent-fg' : 'border border-accent/50 text-accent hover:bg-accent/10'}`}>
              <Eye className="size-3.5" aria-hidden /> Satellite’s eye
            </button>
          </div>
          <p className="flex items-center gap-1 text-[10px] text-white/45">
            <Orbit className="size-3" aria-hidden /> {satRide?.mode === 'eye' ? 'Looking straight down from it, as it flies. Esc to stop.' : 'The ring is its orbit: one full revolution.'}
          </p>
        </div>
      )}

      {/* A picked camera: its live view, and look through it. */}
      {cam && !follow && !sat && (
        <div className={`absolute bottom-24 left-3 w-80 max-w-[calc(100%-1.5rem)] space-y-2 p-3 ${panel}`}>
          <div className="flex items-start gap-2">
            <Cctv className="mt-0.5 size-4 text-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold" title={cam.name}>
                {cam.name}
              </p>
              <p className="text-[11px] text-white/60">
                {cam.country}
                {cam.heading !== undefined ? ` · looks ${['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(cam.heading / 45) % 8]}` : ''}
              </p>
            </div>
            <button type="button" onClick={() => setCamPick(null)} className="text-white/60 hover:text-white" aria-label="Close">
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <CameraDetail id={cam.id} source={cam.source} video={cam.video?.url} videoKind={cam.video?.kind} player={cam.player?.url} playerKind={cam.player?.kind} link={cam.link} />
          {cam.heading !== undefined ? (
            <button type="button" onClick={viewFromCamera} className="flex items-center gap-1 rounded-full border border-accent/50 px-3 py-1 text-xs text-accent hover:bg-accent/10">
              <Eye className="size-3.5" aria-hidden /> View from the camera
            </button>
          ) : (
            <p className="text-[10px] text-white/45">This agency does not publish which way the camera looks, so its frame floats above it.</p>
          )}
        </div>
      )}

      {/* A picked cable: what it links. */}
      {cable && !follow && !sat && !cam && (
        <div className={`absolute bottom-24 left-3 w-80 max-w-[calc(100%-1.5rem)] space-y-2 p-3 ${panel}`}>
          <div className="flex items-start gap-2">
            <Cable className="mt-0.5 size-4 text-accent" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{cable.name}</p>
              {cable.detail && (
                <p className="text-[11px] text-white/60">
                  {[cable.detail.length, cable.detail.rfs ? `${cable.detail.planned ? 'planned for' : 'in service since'} ${cable.detail.rfs}` : ''].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
            <button type="button" onClick={closeCable} className="text-white/60 hover:text-white" aria-label="Close">
              <X className="size-4" aria-hidden />
            </button>
          </div>
          {cable.detail ? (
            <>
              {cable.detail.owners && <p className="line-clamp-2 text-[11px] text-white/70">Owned by {cable.detail.owners}</p>}
              {cable.detail.landings.length > 0 && (
                <p className="text-[11px] text-white/70">
                  Lands at {cable.detail.landings.slice(0, 8).map(l => l.name).join(' · ')}
                  {cable.detail.landings.length > 8 ? ` · +${cable.detail.landings.length - 8} more` : ''}
                </p>
              )}
            </>
          ) : (
            <p className="text-[11px] text-white/45">Loading the cable’s card…</p>
          )}
          <button type="button" onClick={() => flyOverCable(cable.id)} className="rounded-full border border-accent/50 px-3 py-1 text-xs text-accent hover:bg-accent/10">
            Fly over it
          </button>
        </div>
      )}
      {landing && !cable && !sat && !follow && <p className={`absolute bottom-24 left-3 px-3 py-1.5 text-[11px] ${panel}`}>Cable landing · {landing}</p>}

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
        {tier === 'google' ? 'Google Map Tiles' : tier === 'ion' ? 'Cesium ion · Esri World Imagery' : 'Esri World Imagery · Re:Earth terrain'} · CesiumJS · aircraft models CC BY 4.0 (see credits){layers.sats ? ' · CelesTrak' : ''}
        {layers.cables ? ' · Submarine Cable Map © TeleGeography' : ''}
        {layers.cameras ? ' · cameras from each agency’s open data' : ''}
      </p>
    </div>
  )
}
