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
import { ArrowLeftRight, Box, Cable, ChevronLeft, ChevronRight, Crosshair, Eye, Orbit, Plane, Satellite, Ship as ShipIcon, Sparkles, Video, Cctv, Newspaper, Radio, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { kmBetween, type FireSpot, type Flight, type FlightRoute, type RadioStation, type Ship } from '../../../shared/world.ts'
import type { Map3dOp } from '../../../shared/map.ts'
import { aircraftName } from '../../../shared/aircraft.ts'
import { satGroup, SAT_GROUPS, type CableDetail, type SatGroupId } from '../../../shared/space.ts'
import { Cables3D } from './cables3d.ts'
import { Cameras3D, type CameraView } from './cams3d.ts'
import type { Selected } from './Inspector.tsx'
import { Points3D } from './points3d.ts'
import { newsFeatures } from './newsmap.ts'
import type { FC } from './geo.ts'
import { CelestialRing } from './CelestialRing.tsx'
import { cameraFeatures, deadReckon, fireFeatures, flightFeatures, flightLabel, planeIcon, radioFeatures, satelliteFeatures, shipFeatures, shipIcon } from './geo.ts'
import { DisplayFx, TacticalHud, type HudSource } from './Display.tsx'
import { HoverOverlay } from './HoverCard.tsx'
import { hoverInfo } from './hover.ts'
import { MODE_FILTER, type DisplayPrefs } from './hud.ts'
import type { WorldSnapshot } from '../../../shared/world.ts'
import { CATEGORY_COLOR, type IntelEvent } from '../../../shared/intel.ts'
import { MODEL_HEADING_OFFSET, headingTape, heightForZoom, modelFor, type ModelId } from './models3d.ts'
import { Satellites3D } from './sats3d.ts'
import { Traffic3D } from './traffic3d.ts'
import { IncidentCard, TrafficPill, type TrafficStatus } from './TrafficLayer2D.tsx'
import type { TrafficIncident } from '../../../shared/traffic.ts'
import { AtlasLoader, Atmos } from './Atmos.tsx'
import { MAP_VIEW_EVENT } from '../../../shared/map.ts'
import { latLonLabel } from './sky.ts'

;(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = './cesium/'

type Tier = 'keyless' | 'ion' | 'google'
const TIER_LABEL: Record<Tier, string> = { keyless: 'Satellite imagery · free terrain', ion: 'World terrain · 3D buildings (Cesium ion)', google: 'Photorealistic 3D (Google)' }

const MODEL_RADIUS_M = 150_000
const MAX_MODELS = 40
const POLL_MS = 8_000
/** Below this camera height planes move every frame (and the view draws continuously); above it, once every two seconds. */
const NEAR_HEIGHT_M = 600_000
/** At most this many planes are moved every frame: the nearest in view. */
const MAX_LIVE = 600

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

type LayerKey = 'flights' | 'ships' | 'sats' | 'cameras' | 'news' | 'radio' | 'cables' | 'celestial'
type Layers = Record<LayerKey, boolean> & { hiddenSats: SatGroupId[] }
const LAYERS_KEY = 'atlas.globe3d.layers'
const DEFAULT_LAYERS: Layers = { flights: true, ships: true, sats: true, cameras: true, news: true, radio: false, cables: false, celestial: false, hiddenSats: [] }
const readLayers = (): Layers => {
  try {
    return { ...DEFAULT_LAYERS, ...(JSON.parse(localStorage.getItem(LAYERS_KEY) ?? '{}') as Partial<Layers>) }
  } catch {
    return DEFAULT_LAYERS
  }
}

type Counts = { flights: number; ships: number; sats: number; cables: number; cameras: number; news: number; radio: number }
type NewsItem = FC['features'][number]
const RAIL: { k: LayerKey; label: string; icon: typeof Plane; count: (c: Counts) => string }[] = [
  { k: 'flights', label: 'Flights', icon: Plane, count: c => String(c.flights) },
  { k: 'ships', label: 'Ships', icon: ShipIcon, count: c => String(c.ships) },
  { k: 'sats', label: 'Satellites', icon: Satellite, count: c => String(c.sats) },
  { k: 'cameras', label: 'Cameras', icon: Cctv, count: c => (c.cameras ? String(c.cameras) : '') },
  { k: 'news', label: 'News', icon: Newspaper, count: c => (c.news ? String(c.news) : '') },
  { k: 'radio', label: 'Radio', icon: Radio, count: c => (c.radio ? String(c.radio) : '') },
  { k: 'cables', label: 'Sea cables', icon: Cable, count: c => (c.cables ? String(c.cables) : '') },
  { k: 'celestial', label: 'Celestial', icon: Sparkles, count: () => '' },
]

/** What the World page (and through it, Atlas) can ask of the 3D view. */
export interface Globe3DControl {
  run(op: Map3dOp): Promise<string>
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!

interface SatRide {
  i: number
  mode: 'follow' | 'eye'
}

export default function Globe3D({
  start,
  onClose,
  controlRef,
  onSelect,
  selectedId,
  world,
  now: clock,
  display,
  displayButton,
  intel,
  traffic,
  onTrafficStatus,
  fires,
}: {
  start: { lat: number; lon: number; zoom: number }
  onClose: () => void
  controlRef?: { current: Globe3DControl | null }
  /** The World page's card: the same full card as the flat map shows. */
  onSelect?: (s: Selected | null) => void
  selectedId?: string | null
  /** The flat map's world snapshot and clock, for the hover cards. */
  world?: WorldSnapshot
  now?: number
  /** The flat map's visual mode (night vision, thermal, CRT…), HUD and scope: the same in 3D. */
  display?: DisplayPrefs
  /** The flat map's Display button, shown in the 3D top bar. */
  displayButton?: ReactNode
  /** Conflict events (the Intelligence panel), as points. */
  intel?: IntelEvent[] | undefined
  /** Live traffic tiles (TomTom, the owner's key), when the Traffic chip is on. */
  traffic?: string | null
  /** What moving traffic shows (cars, incidents, simulated or live). */
  onTrafficStatus?: (s: TrafficStatus | null) => void
  /** Fires from space (NASA FIRMS), when the layer is on. */
  fires?: FireSpot[] | undefined
}) {
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const box = useRef<HTMLDivElement>(null)
  const credits = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.CesiumWidget | null>(null)
  const flights = useRef<{ list: Flight[]; at: number; byHex: Map<string, Flight> }>({ list: [], at: 0, byHex: new Map() })
  const followRef = useRef<Follow | null>(null)
  const [tier, setTier] = useState<Tier | null>(null)
  const [load3d, setLoad3d] = useState(0.3)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Flight | null>(null)
  const [follow, setFollow] = useState<Follow | null>(null)
  const [route, setRoute] = useState<FlightRoute | null>(null)
  const [, tick] = useState(0)
  const [counts, setCounts] = useState<Counts>({ flights: 0, ships: 0, sats: 0, cables: 0, cameras: 0, news: 0, radio: 0 })
  followRef.current = follow
  const [layers, setLayers] = useState(readLayers)
  const layersRef = useRef(layers)
  layersRef.current = layers
  const [widget, setWidget] = useState<Cesium.CesiumWidget | null>(null)
  const parts = useRef<{ bills: Cesium.BillboardCollection; shipBills: Cesium.BillboardCollection; sats: Satellites3D; cables: Cables3D; cams: Cameras3D; radio: Points3D<RadioStation>; news: Points3D<NewsItem>; intel: Points3D<IntelEvent>; fires: Points3D<FireSpot> } | null>(null)
  const [radioPick, setRadioPick] = useState<number | null>(null)
  const [newsPick, setNewsPick] = useState<number | null>(null)
  const [camPick, setCamPick] = useState<number | null>(null)
  const camView = useRef<CameraView | null>(null)
  const [satPick, setSatPick] = useState<number | null>(null)
  const satPickRef = useRef<number | null>(null)
  satPickRef.current = satPick
  const [satRide, setSatRide] = useState<SatRide | null>(null)
  const satRideRef = useRef<SatRide | null>(null)
  satRideRef.current = satRide
  const [satCounts, setSatCounts] = useState<Partial<Record<SatGroupId, number>>>({})
  const [cable, setCable] = useState<{ id: string; name: string; detail: CableDetail | null } | null>(null)
  const [landing, setLanding] = useState<string | null>(null)
  const [hover, setHover] = useState<{ key: string; sel: Selected; x: number; y: number } | null>(null)
  const nightLights = useRef<ReturnType<typeof Cesium.ImageryLayer.fromProviderAsync> | null>(null)
  /** Planes close enough to watch move: the view draws continuously while true. */
  const nearHold = useRef(false)
  /** Cars moving on the roads: the view draws continuously while true. */
  const trafficLive = useRef(false)
  const traffic3d = useRef<Traffic3D | null>(null)
  const [trafficStatus, setTrafficStatus] = useState<TrafficStatus | null>(null)
  const [incHover, setIncHover] = useState<{ i: TrafficIncident; x: number; y: number } | null>(null)
  const onTrafficStatusRef = useRef(onTrafficStatus)
  onTrafficStatusRef.current = onTrafficStatus
  /** The render governor: frames on demand, continuously only while something on screen moves by itself. */
  const applyRender = () => {
    const w = viewerRef.current
    if (!w || w.isDestroyed()) return
    w.scene.requestRenderMode = !(nearHold.current || trafficLive.current || followRef.current || satRideRef.current || orbitRef.current)
    w.scene.requestRender()
  }
  /** Orbit: circling a point on the ground, or spinning the whole globe. */
  const [orbit, setOrbit] = useState(false)
  const orbitRef = useRef<ReturnType<typeof Cesium.Cartesian3.fromDegrees> | 'globe' | null>(null)

  useEffect(() => {
    let disposed = false
    const timers: ReturnType<typeof setInterval>[] = []
    const cleanups: (() => void)[] = []
    let viewer: Cesium.CesiumWidget | null = null
    void (async () => {
      const keys = await window.world.map3dKeys().catch(() => ({ google: null, ion: null, tomtom: null }))
      if (disposed || !box.current) return
      if (keys.ion) Cesium.Ion.defaultAccessToken = keys.ion
      viewer = new Cesium.CesiumWidget(box.current, { baseLayer: false, creditContainer: credits.current ?? undefined, msaaSamples: 2, requestRenderMode: true, maximumRenderTimeChange: Infinity, showRenderLoopErrors: false })
      // Cesium stops drawing after an error: say so in Atlas's own words.
      viewer.scene.renderError.addEventListener((_scene: unknown, e: unknown) => setError(`The 3D view stopped drawing (${e instanceof Error ? e.message.slice(0, 80) : 'error'}). Go back to 2D and open 3D again.`))
      viewerRef.current = viewer
      setLoad3d(0.45)
      // The loader follows the ground's tiles until the first view is in.
      {
        let most = 0
        const offTiles = viewer.scene.globe.tileLoadProgressEvent.addEventListener((queued: number) => {
          most = Math.max(most, queued)
          if (most > 0) setLoad3d(queued === 0 ? 1 : 0.45 + 0.55 * (1 - queued / most))
        })
        cleanups.push(offTiles)
        const safety = setTimeout(() => setLoad3d(1), 15_000)
        cleanups.push(() => clearTimeout(safety))
        // Where the camera looks, for the mini globe in the corner widget.
        const cam = viewer.camera
        let last = 0
        const tell = () => {
          if (Date.now() - last < 150) return
          last = Date.now()
          const c = cam.positionCartographic
          window.dispatchEvent(new CustomEvent(MAP_VIEW_EVENT, { detail: { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude), zoom: Math.log2(40_075_016 / Math.max(50, c.height)) } }))
        }
        cam.percentageChanged = 0.01
        cleanups.push(cam.changed.addEventListener(tell))
        tell()
      }
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
      // Loading: slightly coarser tiles (barely visible) and a larger cache, so moving around reloads less.
      scene.globe.maximumScreenSpaceError = 2.5
      scene.globe.tileCacheSize = 300
      try {
        if (keys.google) {
          const tiles = await Cesium.createGooglePhotorealistic3DTileset({ key: keys.google, onlyUsingWithGoogleGeocoder: true })
          scene.primitives.add(tiles)
          scene.globe.show = false
          setTier('google')
        } else {
          viewer.imageryLayers.add(Cesium.ImageryLayer.fromProviderAsync(Cesium.ArcGisMapServerImageryProvider.fromUrl('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'), {}))
          if (keys.ion) {
            // World terrain, falling back to the free terrain if ion refuses; buildings are a bonus on top.
            const ionTerrain = new Cesium.Terrain(Cesium.CesiumTerrainProvider.fromIonAssetId(1))
            ionTerrain.errorEvent.addEventListener((e: unknown) => {
              console.warn('Cesium ion terrain failed; using the free terrain', e)
              if (!scene.isDestroyed()) scene.setTerrain(new Cesium.Terrain(Cesium.CesiumTerrainProvider.fromUrl('https://terrain.reearth.land/cesium-mesh/ellipsoid')))
            })
            scene.setTerrain(ionTerrain)
            setTier('ion')
            void Cesium.createOsmBuildingsAsync().then(
              b => !scene.isDestroyed() && (scene.primitives.add(b), scene.requestRender()),
              e => console.warn('Cesium OSM buildings failed', e),
            )
          } else {
            scene.setTerrain(new Cesium.Terrain(Cesium.CesiumTerrainProvider.fromUrl('https://terrain.reearth.land/cesium-mesh/ellipsoid')))
            setTier('keyless')
          }
        }
      } catch (e) {
        console.warn('3D base layers failed', e)
        const why = e instanceof Error ? e.message : typeof e === 'object' && e && 'statusCode' in e ? `HTTP ${String((e as { statusCode: unknown }).statusCode)}` : String(e)
        setError(`The 3D map could not load fully (${why.slice(0, 80)}); showing what it can.`)
        setTier(t => t ?? 'keyless')
      }
      if (disposed || viewer.isDestroyed()) return
      // A continent or the world: look straight down at it. A region: a tilted view, as from a plane.
      const wide = start.zoom < 5
      viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(start.lon, wide ? Cesium.Math.clamp(start.lat, -60, 60) : start.lat - Math.min(8, 30 / 2 ** start.zoom), Math.min(22_000_000, heightForZoom(start.zoom, start.lat))), orientation: { heading: 0, pitch: Cesium.Math.toRadians(wide ? -90 : -55), roll: 0 } })

      // ── aircraft: icons everywhere, models near the camera ──
      // Icons as data URLs: Cesium keys its texture atlas by URL, so thousands of billboards share one image
      // (a canvas would be packed again for every billboard).
      const planeImg = iconCanvas(planeIcon()).toDataURL()
      const shipImg = iconCanvas(shipIcon()).toDataURL()

      // Quality that follows the machine, as games do: when frames get slow, drop anti-aliasing, then
      // resolution in steps (to 60%); when there is room again, raise it back.
      let frames = 0
      let spent = 0
      let frameAt = 0
      scene.preRender.addEventListener(() => {
        frameAt = performance.now()
      })
      scene.postRender.addEventListener(() => {
        frames++
        spent += performance.now() - frameAt
      })
      timers.push(
        setInterval(() => {
          if (!viewer || viewer.isDestroyed() || frames < 15) return void ((frames = 0), (spent = 0))
          const avg = spent / frames
          frames = 0
          spent = 0
          if (avg > 28) {
            if (scene.msaaSamples > 1) scene.msaaSamples = 1
            else if (viewer.resolutionScale > 0.6) viewer.resolutionScale = Math.round((viewer.resolutionScale - 0.1) * 10) / 10
          } else if (avg < 12 && viewer.resolutionScale < 1) viewer.resolutionScale = Math.round((viewer.resolutionScale + 0.1) * 10) / 10
        }, 2000),
      )
      const bills = scene.primitives.add(new Cesium.BillboardCollection({ scene })) as Cesium.BillboardCollection
      const byHex = new Map<string, Cesium.Billboard>()
      const models = new Map<string, { model: Cesium.Model; id: ModelId }>()
      const loading = new Set<string>()
      const hpr = new Cesium.HeadingPitchRoll()

      // Two passes. The slow one (each second near the ground, every two from high up) adds and removes
      // planes, hides those behind the Earth and picks the nearest in view; the fast one moves those
      // every frame, so close planes glide instead of stepping.
      const colors = new Map<string, ReturnType<typeof Cesium.Color.fromCssColorString>>()
      const colorFor = (css: string) => colors.get(css) ?? (colors.set(css, Cesium.Color.fromCssColorString(css)), colors.get(css)!)
      const scratch = new Cesium.Cartesian3()
      let live: { hex: string; b: Cesium.Billboard }[] = []
      let slowAt = 0
      const toUnit = (lat: number, lon: number) => {
        const la = Cesium.Math.toRadians(lat)
        const lo = Cesium.Math.toRadians(lon)
        return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)] as const
      }
      const placeModel = (hex: string, f: Flight) => {
        const m = models.get(hex)
        if (!m) return
        hpr.heading = Cesium.Math.toRadians(f.track + MODEL_HEADING_OFFSET)
        Cesium.Cartesian3.fromDegrees(f.lon, f.lat, altM(f), Cesium.Ellipsoid.WGS84, scratch)
        m.model.modelMatrix = Transforms.headingPitchRollToFixedFrame(scratch, hpr, Cesium.Ellipsoid.WGS84, undefined, m.model.modelMatrix)
      }
      const slowPass = () => {
        if (!viewer || viewer.isDestroyed()) return
        const cam = viewer.camera.positionCartographic
        const near = cam.height < NEAR_HEIGHT_M
        if (!near && Date.now() - slowAt < 1900) return
        slowAt = Date.now()
        if (!layersRef.current.flights) {
          for (const m of models.values()) m.model.show = false
          live = []
          nearHold.current = false
          applyRender()
          return
        }
        const { list, at } = flights.current
        const dt = (Date.now() - at) / 1000
        const camLat = Cesium.Math.toDegrees(cam.latitude)
        const camLon = Cesium.Math.toDegrees(cam.longitude)
        const c = viewer.camera.positionWC
        const dist = Cesium.Cartesian3.magnitude(c)
        const cu = [c.x / dist, c.y / dist, c.z / dist] as const
        // A point on the ground is over the horizon when it faces away from the camera by more than this.
        const horizon = Cesium.Ellipsoid.WGS84.maximumRadius / dist - 0.02
        const seen = new Set<string>()
        const nearList: { f: Flight; km: number; b: Cesium.Billboard }[] = []
        const followed = followRef.current?.hex
        for (const raw of list) {
          seen.add(raw.hex)
          const u = toUnit(raw.lat, raw.lon)
          const facing = u[0] * cu[0] + u[1] * cu[1] + u[2] * cu[2] > horizon || raw.hex === followed
          let b = byHex.get(raw.hex)
          if (!facing) {
            if (b) b.show = false
            continue
          }
          const f = deadReckon(raw, raw.seen + dt)
          Cesium.Cartesian3.fromDegrees(f.lon, f.lat, altM(f), Cesium.Ellipsoid.WGS84, scratch)
          if (!b) {
            b = bills.add({ position: scratch, image: planeImg, color: colorFor(colorOf(f)), alignedAxis: Cesium.Cartesian3.UNIT_Z, scaleByDistance: new Cesium.NearFarScalar(3e4, 0.8, 1.2e7, 0.14), id: { kind: 'flight', hex: f.hex } })
            byHex.set(f.hex, b)
          } else b.position = scratch
          b.rotation = -Cesium.Math.toRadians(f.track)
          b.show = !(followRef.current?.mode === 'cockpit' && followed === f.hex) && !models.has(f.hex)
          if (near) nearList.push({ f, km: kmBetween({ lat: camLat, lon: camLon }, f), b })
        }
        for (const [hex, b] of byHex) if (!seen.has(hex)) (bills.remove(b), byHex.delete(hex))
        nearList.sort((a, b) => a.km - b.km)
        live = nearList.slice(0, MAX_LIVE).map(n => ({ hex: n.f.hex, b: n.b }))
        if (followed && !live.some(l => l.hex === followed)) {
          const b = byHex.get(followed)
          if (b) live.push({ hex: followed, b })
        }
        // The nearest few get a real 3D model.
        const want = new Set(nearList.filter(n => n.km * 1000 < MODEL_RADIUS_M).slice(0, MAX_MODELS).map(n => n.f.hex))
        for (const [hex, m] of models) if (!want.has(hex)) (scene.primitives.remove(m.model), models.delete(hex))
        for (const n of nearList) {
          if (!want.has(n.f.hex)) continue
          const have = models.get(n.f.hex)
          if (have) {
            placeModel(n.f.hex, n.f)
            have.model.show = !(followRef.current?.mode === 'cockpit' && followed === n.f.hex)
          } else if (!loading.has(n.f.hex)) {
            loading.add(n.f.hex)
            const id = modelFor(n.f.type, n.f.military)
            hpr.heading = Cesium.Math.toRadians(n.f.track + MODEL_HEADING_OFFSET)
            const matrix = Transforms.headingPitchRollToFixedFrame(Cesium.Cartesian3.fromDegrees(n.f.lon, n.f.lat, altM(n.f)), hpr)
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
        // City lights are coarse (NASA Black Marble): full from space, fading as the ground comes close.
        if (nightLights.current) nightLights.current.nightAlpha = Math.min(1, Math.max(0.2, cam.height / 1_500_000))
        // Satellites near the camera become 3D models.
        const pts = parts.current
        pts?.sats.pickModels(viewer.camera.positionWC, satRideRef.current?.i ?? satPickRef.current)
        // Draw continuously only while there are planes (or modelled satellites) close enough to see move.
        const hold = ((near && live.length > 0) || (pts?.sats.modelCount ?? 0) > 0) && !document.hidden
        if (hold !== nearHold.current) {
          nearHold.current = hold
          applyRender()
        }
        scene.requestRender()
      }
      const fastPass = () => {
        parts.current?.sats.frame()
        if (!live.length || !layersRef.current.flights) return
        const { at, byHex: data } = flights.current
        const dt = (Date.now() - at) / 1000
        for (const l of live) {
          const raw = data.get(l.hex)
          if (!raw) continue
          const f = deadReckon(raw, raw.seen + dt)
          Cesium.Cartesian3.fromDegrees(f.lon, f.lat, altM(f), Cesium.Ellipsoid.WGS84, scratch)
          l.b.position = scratch
          placeModel(l.hex, f)
        }
      }

      // ── ships: updated in place (no rebuild each poll), at sea level (no terrain lookups) ──
      const shipBills = scene.primitives.add(new Cesium.BillboardCollection({ scene })) as Cesium.BillboardCollection
      const shipById = new Map<number, Cesium.Billboard>()
      const shipData = new Map<number, Ship>()
      const shipColor = Cesium.Color.fromCssColorString('#34d399')
      const drawShips = (list: Ship[]) => {
        const keep = new Set<number>()
        shipData.clear()
        for (const s of list.slice(0, 4000)) {
          keep.add(s.mmsi)
          shipData.set(s.mmsi, s)
          Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 0, Cesium.Ellipsoid.WGS84, scratch)
          const rotation = -Cesium.Math.toRadians(s.heading ?? s.course)
          const b = shipById.get(s.mmsi)
          if (b) (b.position = scratch), (b.rotation = rotation)
          else shipById.set(s.mmsi, shipBills.add({ position: scratch, image: shipImg, width: 14, height: 14, color: shipColor, rotation, alignedAxis: Cesium.Cartesian3.UNIT_Z, scaleByDistance: new Cesium.NearFarScalar(1e4, 1, 8e6, 0.3), id: { kind: 'ship', mmsi: s.mmsi, name: s.name } }))
        }
        for (const [id, b] of shipById) if (!keep.has(id)) (shipBills.remove(b), shipById.delete(id))
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
      const radio = new Points3D<RadioStation>(scene, 'radio')
      const news = new Points3D<NewsItem>(scene, 'news')
      const intelPoints = new Points3D<IntelEvent>(scene, 'intel')
      const firePoints = new Points3D<FireSpot>(scene, 'fire')
      parts.current = { bills, shipBills, sats, cables, cams, radio, news, intel: intelPoints, fires: firePoints }
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
      const camScratch = new Cesium.Cartesian3()
      scene.preRender.addEventListener(() => {
        fastPass()
        const ot = orbitRef.current
        if (ot && viewer && !followRef.current && !satRideRef.current) {
          if (ot === 'globe') viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -0.0012)
          else {
            viewer.camera.lookAtTransform(Transforms.eastNorthUpToFixedFrame(ot, Cesium.Ellipsoid.WGS84, enu))
            viewer.camera.rotateRight(0.0022)
            viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
          }
          return
        }
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
        const cam = Cesium.Matrix4.multiplyByPoint(enu, new Cesium.Cartesian3(-Math.sin(h) * back, -Math.cos(h) * back, up), camScratch)
        const climb = f.verticalRate ? Math.atan2(f.verticalRate * 0.00508, Math.max(30, f.speed * 0.514)) : 0
        viewer.camera.setView({ destination: Cesium.Cartesian3.clone(cam), orientation: { heading: h, pitch: fol.mode === 'chase' ? Cesium.Math.toRadians(-11) : climb - Cesium.Math.toRadians(3), roll: 0 } })
      })

      // ── picking ──
      const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas)
      const takeBack = () => {
        if (!orbitRef.current) return
        orbitRef.current = null
        setOrbit(false)
      }
      handler.setInputAction(() => (takeBack(), setHover(null)), Cesium.ScreenSpaceEventType.LEFT_DOWN)
      handler.setInputAction(takeBack, Cesium.ScreenSpaceEventType.RIGHT_DOWN)
      handler.setInputAction(takeBack, Cesium.ScreenSpaceEventType.WHEEL)
      type PickId = { kind?: string; hex?: string; i?: number; id?: string; name?: string; mmsi?: number }
      /** What a picked point is, as the flat map's card sees it (satellites too, for the hover card). */
      const selectionFor = (id: PickId | undefined, withSats = false): Selected | null => {
        const pts = parts.current
        const card = (kind: Selected['kind'], f: { geometry: { coordinates: unknown }; properties: Record<string, string | number> } | undefined): Selected | null => (f ? { kind, lngLat: f.geometry.coordinates as [number, number], props: f.properties } : null)
        const flight = id?.kind === 'flight' && id.hex ? flights.current.byHex.get(id.hex) : undefined
        const ship = id?.kind === 'ship' && typeof id.mmsi === 'number' ? shipData.get(id.mmsi) : undefined
        const sat = withSats && id?.kind === 'sat' && typeof id.i === 'number' ? pts?.sats.list[id.i] : undefined
        return flight ? card('flights', flightFeatures([flight]).features[0])
          : ship ? card('ships', shipFeatures([ship]).features[0])
          : sat ? card('satellites', satelliteFeatures([sat], new Date()).features[0])
          : id?.kind === 'cam' && typeof id.i === 'number' && pts?.cams.list[id.i] ? card('cameras', cameraFeatures([pts.cams.list[id.i]!]).features[0])
          : id?.kind === 'radio' && typeof id.i === 'number' && pts?.radio.items[id.i] ? card('radio', radioFeatures([pts.radio.items[id.i]!]).features[0])
          : id?.kind === 'news' && typeof id.i === 'number' && pts?.news.items[id.i] ? card('news', pts.news.items[id.i] as never)
          : id?.kind === 'fire' && typeof id.i === 'number' && pts?.fires.items[id.i] ? card('fires', fireFeatures([pts.fires.items[id.i]!]).features[0])
          : null
      }

      // ── hover: rest the pointer on a point for the same animated card as the flat map ──
      let hoverKey: string | null = null
      let hoverFrame = 0
      let lastPick = 0
      let showT: ReturnType<typeof setTimeout> | undefined
      let hideT: ReturnType<typeof setTimeout> | undefined
      const hideHover = () => {
        clearTimeout(showT)
        hoverKey = null
        setHover(null)
      }
      handler.setInputAction((m: { endPosition: Cartesian2 }) => {
        const at = Cesium.Cartesian2.clone(m.endPosition)
        cancelAnimationFrame(hoverFrame)
        hoverFrame = requestAnimationFrame(() => {
          // Picking draws a frame of its own: a dozen times a second is plenty.
          if (!viewer || viewer.isDestroyed() || performance.now() - lastPick < 80) return
          lastPick = performance.now()
          const hit = scene.pick(at) as { id?: PickId } | undefined
          // A traffic incident: its own small card.
          const inc = hit?.id?.kind === 'incident' && hit.id.id ? traffic3d.current?.incident(hit.id.id) : undefined
          setIncHover(inc ? { i: inc, x: at.x, y: at.y } : null)
          const sel = hit?.id ? selectionFor(hit.id, true) : null
          if (sel) {
            clearTimeout(hideT)
            const key = `${sel.kind}:${String(sel.props.id ?? sel.props.title)}`
            if (key === hoverKey) return
            clearTimeout(showT)
            const show = () => {
              hoverKey = key
              setHover({ key, sel, x: at.x, y: at.y })
            }
            if (hoverKey) show()
            else showT = setTimeout(show, 120)
          } else if (hoverKey) {
            clearTimeout(hideT)
            hideT = setTimeout(hideHover, 200)
          } else clearTimeout(showT)
        })
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
      cleanups.push(() => (cancelAnimationFrame(hoverFrame), clearTimeout(showT), clearTimeout(hideT)))

      handler.setInputAction((click: { position: Cartesian2 }) => {
        hideHover()
        const hit = scene.pick(click.position) as { id?: PickId } | undefined
        const id = hit?.id
        const flight = id?.kind === 'flight' && id.hex ? flights.current.byHex.get(id.hex) : undefined
        setPicked(flight ?? null)
        if (satRideRef.current) return
        // Flights, ships, cameras, radio and news open the same card as on the flat map.
        onSelectRef.current?.(selectionFor(id))
        setSatPick(id?.kind === 'sat' && typeof id.i === 'number' ? id.i : null)
        setCamPick(id?.kind === 'cam' && typeof id.i === 'number' ? id.i : null)
        setRadioPick(id?.kind === 'radio' && typeof id.i === 'number' ? id.i : null)
        setNewsPick(id?.kind === 'news' && typeof id.i === 'number' ? id.i : null)
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
      timers.push(setInterval(slowPass, 1000))
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

  const hudSource = useMemo((): HudSource | null => {
    if (!widget) return null
    const fns = new Set<() => void>()
    widget.camera.percentageChanged = 0.002
    widget.camera.changed.addEventListener(() => fns.forEach(f => f()))
    return {
      getCenter() {
        const c = widget.scene.canvas
        const hit = widget.camera.pickEllipsoid(new Cesium.Cartesian2(c.clientWidth / 2, c.clientHeight / 2))
        const g = hit ? Cesium.Cartographic.fromCartesian(hit) : widget.camera.positionCartographic
        return { lat: Cesium.Math.toDegrees(g.latitude), lng: Cesium.Math.toDegrees(g.longitude) }
      },
      getZoom() {
        const h = Math.max(300, widget.camera.positionCartographic.height)
        return Math.max(0, Math.min(22, Math.log2((40_075_016.686 * 1.6) / h)))
      },
      on: (_t, fn) => fns.add(fn),
      off: (_t, fn) => fns.delete(fn),
    }
  }, [widget])

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
    pt.radio.setVisible(layers.radio)
    if (layers.radio && !pt.radio.loaded)
      void window.world.radio().then(
        list => {
          if (widget.isDestroyed() || pt.radio.loaded) return
          pt.radio.load(list, s => ({ lat: s.lat, lon: s.lon, color: '#e879f9', size: 5 }))
          pt.radio.setVisible(layersRef.current.radio)
          setCounts(x => ({ ...x, radio: list.length }))
          widget.scene.requestRender()
        },
        () => undefined,
      )
    pt.news.setVisible(layers.news)
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
    // Real day and night only with the celestial ring (otherwise a black night side reads as broken);
    // the night side then shows the cities' lights (NASA Black Marble, keyless).
    widget.scene.globe.enableLighting = layers.celestial
    if (layers.celestial && !nightLights.current) {
      nightLights.current = Cesium.ImageryLayer.fromProviderAsync(
        Promise.resolve(new Cesium.UrlTemplateImageryProvider({ url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png', maximumLevel: 8, credit: 'NASA Black Marble' })),
        { dayAlpha: 0, nightAlpha: 1 },
      )
      widget.imageryLayers.add(nightLights.current)
    }
    if (nightLights.current) nightLights.current.show = layers.celestial
    widget.scene.requestRender()
  }, [widget, layers])

  // News where it happens (the same placement as the flat map), kept fresh.
  useEffect(() => {
    const pt = parts.current
    if (!widget || !pt) return
    const show = (r: { headlines: Parameters<typeof newsFeatures>[0] }) => {
      if (widget.isDestroyed()) return
      const items = newsFeatures(r.headlines).features
      pt.news.load(items, f => {
        const [lon, lat] = f.geometry.coordinates as [number, number]
        const sev = Number(f.properties.severity ?? 0)
        return { lat, lon, color: String(f.properties.color ?? '#44adff'), size: 5 + Math.min(6, sev / 1.6) }
      })
      pt.news.setVisible(layersRef.current.news)
      setCounts(x => ({ ...x, news: items.length }))
      widget.scene.requestRender()
    }
    void window.news.list().then(show, () => undefined)
    return window.news.onChanged(show)
  }, [widget])

  // The card closed (or moved to something else): drop the 3D picks that belonged to it.
  useEffect(() => {
    if (selectedId) return
    setPicked(null)
    setCamPick(null)
    setRadioPick(null)
    setNewsPick(null)
  }, [selectedId])

  // Live traffic: TomTom's flow tiles draped over the ground.
  const trafficLayer = useRef<ReturnType<typeof Cesium.ImageryLayer.fromProviderAsync> | null>(null)
  useEffect(() => {
    if (!widget || widget.isDestroyed()) return
    if (trafficLayer.current) {
      widget.imageryLayers.remove(trafficLayer.current, true)
      trafficLayer.current = null
    }
    traffic3d.current?.destroy()
    traffic3d.current = null
    if (traffic) {
      traffic3d.current = new Traffic3D(widget, Cesium, {
        onStatus: s => {
          setTrafficStatus(s)
          onTrafficStatusRef.current?.(s)
        },
        onLive: on => {
          trafficLive.current = on
          applyRender()
        },
      })
      trafficLayer.current = Cesium.ImageryLayer.fromProviderAsync(Promise.resolve(new Cesium.UrlTemplateImageryProvider({ url: `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${encodeURIComponent(traffic)}`, minimumLevel: 3, maximumLevel: 18, credit: 'Traffic © TomTom' })), {})
      widget.imageryLayers.add(trafficLayer.current)
    }
    widget.scene.requestRender()
  }, [widget, traffic])
  useEffect(
    () => () => {
      traffic3d.current?.destroy()
      traffic3d.current = null
    },
    [],
  )

  // Fires from space, when the layer is on.
  useEffect(() => {
    const pt = parts.current
    if (!widget || !pt || widget.isDestroyed()) return
    pt.fires.load(fires ?? [], f => ({ lat: f.lat, lon: f.lon, color: f.frp >= 500 ? '#b91c1c' : f.frp >= 100 ? '#ef4444' : f.frp >= 20 ? '#fb923c' : '#fde047', size: f.frp >= 100 ? 6 : 4 }))
    pt.fires.setVisible(!!fires?.length)
    widget.scene.requestRender()
  }, [widget, fires])

  // Conflict events from the Intelligence panel.
  useEffect(() => {
    const pt = parts.current
    if (!widget || !pt || widget.isDestroyed()) return
    pt.intel.load(intel ?? [], e => ({ lat: e.lat, lon: e.lon, color: CATEGORY_COLOR[e.category], size: 4 + e.severity * 1.5 }))
    pt.intel.setVisible(!!intel?.length)
    widget.scene.requestRender()
  }, [widget, intel])

  // Continuous frames only while the camera rides something.
  useEffect(() => {
    if (!widget || widget.isDestroyed()) return
    applyRender()
    // applyRender reads refs that are current for this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget, follow, satRide, orbit])

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

  // ── Atlas drives the 3D view (map_3d): each answer is text the model can relay ──
  const flyTo = (lat: number, lon: number, zoom = 11) =>
    new Promise<void>(done => {
      if (!widget) return done()
      const wide = zoom < 5
      widget.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, wide ? lat : lat - Math.min(8, 30 / 2 ** zoom), Math.min(22_000_000, heightForZoom(zoom, lat))), orientation: { heading: 0, pitch: Cesium.Math.toRadians(wide ? -90 : -45), roll: 0 }, duration: 2.2, complete: done, cancel: done })
    })
  const camAt = () => {
    const c = widget!.camera.positionCartographic
    return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude), height: c.height }
  }
  const run3d = async (op: Map3dOp): Promise<string> => {
    const pt = parts.current
    if (!widget || !pt || widget.isDestroyed()) throw new Error('The 3D view is still starting; try again in a moment.')
    const where = op.label ?? (op.lat !== undefined ? `${op.lat.toFixed(2)}, ${op.lon!.toFixed(2)}` : '')
    switch (op.action) {
      case 'open': {
        if (op.lat !== undefined && op.lon !== undefined) await flyTo(op.lat, op.lon, op.zoom ?? 11)
        return `The 3D view is open${where ? ` over ${where}` : ''} (${tier ? TIER_LABEL[tier] : 'loading'}). Showing: ${RAIL.filter(r => layersRef.current[r.k]).map(r => r.label).join(', ')}.`
      }
      case 'layers': {
        setLayers(l => {
          const next = { ...l }
          for (const k of op.show) next[k] = true
          for (const k of op.hide) next[k] = false
          return next
        })
        if (op.show.includes('celestial')) {
          const c = camAt()
          await flyTo(Cesium.Math.clamp(c.lat, -30, 30), c.lon, 1)
        }
        return `3D layers: ${op.show.length ? `showing ${op.show.join(', ')}` : ''}${op.show.length && op.hide.length ? '; ' : ''}${op.hide.length ? `hid ${op.hide.join(', ')}` : ''}.${op.show.includes('cables') ? ' The cables load from TeleGeography’s map in a few seconds.' : ''}`
      }
      case 'fly_with': {
        const q = (op.query ?? '').toUpperCase().replace(/\s+/g, '')
        const airborne = () => flights.current.list.filter(f => f.altitude !== null && f.altitude > 0)
        const find = () => {
          const list = airborne()
          const c = camAt()
          return q && q !== 'NEAREST' ? (list.find(f => [f.callsign, f.registration, f.hex].some(x => x && x.toUpperCase().replace(/\s+/g, '') === q)) ?? list.find(f => f.callsign.toUpperCase().startsWith(q))) : [...list].sort((a, b) => kmBetween(c, a) - kmBetween(c, b))[0]
        }
        let target = find()
        if (!target && op.lat !== undefined && op.lon !== undefined) await flyTo(op.lat, op.lon, 8)
        // The view loads aircraft where it looks; give it a few seconds.
        for (let i = 0; i < 24 && !target; i++) {
          await new Promise(r => setTimeout(r, 500))
          target = find()
        }
        if (!target) throw new Error(airborne().length ? `No aircraft "${op.query}" is in the 3D view right now (${airborne().length} airborne loaded). Ask for "nearest", or open 3D where it flies.` : 'No aircraft are loaded in this view yet. Open 3D over a busy area (a city, a continent) and try again in a few seconds.')
        onSelectRef.current?.(null)
        setSatRide(null)
        setPicked(null)
        orbitRef.current = null
        setOrbit(false)
        setFollow({ hex: target.hex, mode: op.mode === 'cockpit' ? 'cockpit' : 'chase' })
        const kind = aircraftName(target.type) || target.type
        return `Flying with ${flightLabel(target)}${kind ? ` (${kind}${target.registration ? `, ${target.registration}` : ''})` : ''}${target.military ? ', a military aircraft' : ''}: ${Math.round(target.speed)} knots heading ${compass(target.track)}, ${op.mode === 'cockpit' ? 'from the cockpit' : 'chase view'}. Its route card shows where it is going when the callsign has a published route. Say "next contact" to jump to the nearest other aircraft.`
      }
      case 'next_contact': {
        if (!followRef.current) throw new Error('Not flying with an aircraft yet: use fly_with first.')
        const cur = flights.current.byHex.get(followRef.current.hex)
        if (!cur) throw new Error('The aircraft being followed has left the feed.')
        const order = flights.current.list.filter(f => f.altitude !== null && f.altitude > 0).map(f => ({ f, km: kmBetween(cur, f) })).sort((a, b) => a.km - b.km)
        const i = order.findIndex(o => o.f.hex === cur.hex)
        const next = order[(i + (op.direction === -1 ? -1 : 1) + order.length) % order.length]
        if (!next || next.f.hex === cur.hex) throw new Error('No other aircraft around it right now.')
        setFollow(fo => (fo ? { ...fo, hex: next.f.hex } : fo))
        return `Now with ${flightLabel(next.f)}${aircraftName(next.f.type) ? ` (${aircraftName(next.f.type)})` : ''}, ${Math.round(next.km)} km from the last one.`
      }
      case 'follow_sat': {
        if (!layersRef.current.sats) setLayers(l => ({ ...l, sats: true }))
        const q = (op.query ?? '').toLowerCase()
        const alias = q === 'iss' || q.includes('space station') ? 'iss (zarya)' : q === 'hubble' ? 'hst' : q
        const list = pt.sats.list
        const found = list.find(x => x.name.toLowerCase() === alias) ?? list.find(x => x.name.toLowerCase().includes(alias)) ?? list.find(x => x.norad === op.query)
        if (!found) throw new Error(`No satellite called "${op.query}" among the ${list.length} tracked (stations, brightest, GPS, Galileo, GLONASS, BeiDou, weather, geostationary).`)
        if (layersRef.current.hiddenSats.includes(found.group)) setLayers(l => ({ ...l, hiddenSats: l.hiddenSats.filter(g => g !== found.group) }))
        setFollow(null)
        orbitRef.current = null
        setOrbit(false)
        setSatPick(found.i)
        setSatRide({ i: found.i, mode: op.mode === 'eye' ? 'eye' : 'follow' })
        const f = pt.sats.facts(found)
        return `${op.mode === 'eye' ? 'Looking straight down from' : 'Following'} ${found.name}${f ? `: ${Math.round(f.altKm).toLocaleString()} km up, ${f.speedKms.toFixed(1)} km/s, one orbit every ${f.periodMin < 200 ? `${Math.round(f.periodMin)} minutes` : `${(f.periodMin / 60).toFixed(1)} hours`}, now over ${latLonLabel(f)}` : ''}. Its orbit ring is drawn.`
      }
      case 'camera': {
        if (!layersRef.current.cameras) setLayers(l => ({ ...l, cameras: true }))
        if (!pt.cams.loaded) {
          const list = await window.world.cameras()
          if (!pt.cams.loaded) (pt.cams.load(list), setCounts(x => ({ ...x, cameras: list.length })))
        }
        const list = pt.cams.list
        const q = (op.query ?? '').toLowerCase()
        const from = op.lat !== undefined && op.lon !== undefined ? { lat: op.lat, lon: op.lon } : camAt()
        let i = q && q !== 'nearest' ? list.findIndex(c => c.name.toLowerCase().includes(q)) : -1
        if (i < 0) {
          let best = Infinity
          list.forEach((c, k) => {
            const km = kmBetween(from, c)
            if (km < best) (best = km), (i = k)
          })
          if (i < 0 || best > 300) throw new Error(`No public camera within 300 km${where ? ` of ${where}` : ''}. Cameras come from official open feeds in the UK, US (California, Washington, Delaware), Canada (BC, Calgary, Toronto), Finland, Norway, Australia (NSW), New Zealand, Hong Kong and Singapore.`)
        }
        const cam = list[i]!
        setCamPick(i)
        return `Showing the ${cam.source} camera "${cam.name}" (${cam.country}${cam.heading !== undefined ? `, looking ${compass(cam.heading)}` : ''})${cam.video ? ' with live video' : ', its latest frame'}${cam.heading !== undefined ? '; its view cone and frame are in the scene, and the card can look through it' : ''}.`
      }
      case 'orbit': {
        if (op.direction === 0) {
          orbitRef.current = null
          setOrbit(false)
          return 'Stopped circling.'
        }
        const canvas = widget.scene.canvas
        const target = widget.camera.pickEllipsoid(new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2))
        setFollow(null)
        setSatRide(null)
        orbitRef.current = target ?? 'globe'
        setOrbit(true)
        return target ? 'Circling slowly around the middle of the view. A click or scroll stops it.' : 'Turning the globe slowly. A click or scroll stops it.'
      }
      case 'stop': {
        setFollow(null)
        setSatRide(null)
        orbitRef.current = null
        setOrbit(false)
        return 'Stopped; the camera stays where it is.'
      }
      case 'state': {
        const c = camAt()
        const fol = followRef.current ? flights.current.byHex.get(followRef.current.hex) : null
        const ride = satRideRef.current ? pt.sats.list[satRideRef.current.i] : null
        const parts2 = [
          `3D view (${tier ? TIER_LABEL[tier] : 'loading'}) looking at ${latLonLabel(c)} from ${c.height > 100_000 ? `${Math.round(c.height / 1000).toLocaleString()} km` : `${Math.round(c.height).toLocaleString()} m`} up.`,
          `Layers: ${RAIL.filter(r => layersRef.current[r.k]).map(r => `${r.label}${r.count(counts) ? ` ${r.count(counts)}` : ''}`).join(', ')}.`,
          fol ? `Flying with ${flightLabel(fol)}${route ? ` from ${route.origin.city || route.origin.name} to ${route.destination.city || route.destination.name}` : ''}.` : '',
          ride ? `Riding the satellite ${ride.name}.` : '',
          cam ? `Camera open: ${cam.name}.` : '',
          cable ? `Cable open: ${cable.name}.` : '',
          orbitRef.current ? 'Circling slowly.' : '',
        ]
        return parts2.filter(Boolean).join(' ')
      }
      case 'close':
        return 'Closing the 3D view.'
    }
  }
  const runRef = useRef(run3d)
  runRef.current = run3d
  useEffect(() => {
    if (!controlRef || !widget) return
    controlRef.current = { run: op => runRef.current(op) }
    return () => {
      controlRef.current = null
    }
  }, [controlRef, widget])

  // Escape steps back: stop riding, then close what is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (satRideRef.current) return setSatRide(null)
      if (followRef.current) return setFollow(null)
      setPicked(null)
      setSatPick(null)
      setCamPick(null)
      setRadioPick(null)
      setNewsPick(null)
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
    if (k === 'radio' && !on) setRadioPick(null)
    if (k === 'news' && !on) setNewsPick(null)
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
  const station = radioPick !== null ? parts.current?.radio.items[radioPick] : undefined
  const story = newsPick !== null ? parts.current?.news.items[newsPick] : undefined
  /** The radio tuner: the next station by distance from this one, and fly there. */
  const tune = (dir: 1 | -1) => {
    const list = parts.current?.radio.items
    if (!list?.length || !station || !widget) return
    const order = list.map((s, i) => ({ i, km: kmBetween(station, s) })).sort((a, b) => a.km - b.km)
    const pos = order.findIndex(o => o.i === radioPick)
    const next = order[(pos + dir + order.length) % order.length]!
    const s = list[next.i]!
    setRadioPick(next.i)
    const f = radioFeatures([s]).features[0]
    if (f) onSelectRef.current?.({ kind: 'radio', lngLat: f.geometry.coordinates as [number, number], props: f.properties })
    const c = widget.camera.positionCartographic
    widget.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, Math.max(200_000, Math.min(3_000_000, c.height))), duration: 1.4 })
  }
  const sat = satPick !== null ? parts.current?.sats.list[satPick] : undefined
  const satNow = sat ? parts.current?.sats.facts(sat) : null

  const startFollow = (hex: string, mode: Follow['mode']) => {
    setFollow({ hex, mode })
    setPicked(null)
    onSelectRef.current?.(null)
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
      {traffic && trafficStatus && <TrafficPill s={trafficStatus} />}
      {incHover && <IncidentCard i={incHover.i} style={{ left: Math.max(8, incHover.x - 140), top: incHover.y + 14 }} />}
      <div ref={box} className="absolute inset-0" style={{ filter: display ? MODE_FILTER[display.mode] : undefined }} />
      {display && <DisplayFx mode={display.mode} scope={display.scope} />}
      <Atmos dim={!!follow || !!satRide} />
      <AtlasLoader progress={load3d} label="Opening the 3D world" />
      {display?.hud && hudSource && !follow && <TacticalHud map={hudSource} mode={display.mode} counts={{ flights: counts.flights, ships: counts.ships, satellites: counts.sats, cameras: counts.cameras }} />}
      {hover && world && box.current && <HoverOverlay itemKey={hover.key} info={hoverInfo(hover.sel.kind, hover.sel.props, world, clock ?? Date.now())} p={{ x: hover.x, y: hover.y }} w={box.current.clientWidth} h={box.current.clientHeight} />}
      <div ref={credits} className="hidden" />
      {layers.celestial && widget && !follow && !satRide && <CelestialRing widget={widget} />}
      {/* Top bar: tier, counts, back to 2D. */}
      <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2">
        <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] ${panel}`}>
          <Box className="size-3.5 text-accent" aria-hidden /> 3D · {tier ? TIER_LABEL[tier] : 'loading…'}
        </span>
        {displayButton}
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

      {/* Data layers: what the globe shows, with satellite groups (on the right; the card opens on the left). */}
      {!follow && !satRide && (
        <div className={`absolute right-3 top-14 w-48 space-y-0.5 p-2 ${panel}`}>
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

      {/* A picked camera: its cone is in the scene and its feed in the card; look through it from here. */}
      {cam && !follow && !sat && cam.heading !== undefined && (
        <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2">
          <button type="button" onClick={viewFromCamera} className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-xs ${panel}`}>
            <Eye className="size-3.5 text-accent" aria-hidden /> View from the camera
          </button>
        </div>
      )}

      {/* A picked radio station: the card plays it; the tuner turns the dial to the next. */}
      {station && !follow && !sat && !cam && (
        <div className={`absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-2 py-1.5 ${panel}`}>
          <button type="button" onClick={() => tune(-1)} className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs hover:bg-white/10">
            <ChevronLeft className="size-3.5" aria-hidden /> Nearby
          </button>
          <span className={`flex items-center gap-1 text-[10px] text-fuchsia-300 ${mono}`}>
            <Radio className="size-3.5" aria-hidden /> Tuner
          </span>
          <button type="button" onClick={() => tune(1)} className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs hover:bg-white/10">
            Next <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      {/* A picked cable: what it links. */}
      {cable && !follow && !sat && !cam && !station && (
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
        {layers.radio ? ' · stations: Radio Browser' : ''}
      </p>
    </div>
  )
}
