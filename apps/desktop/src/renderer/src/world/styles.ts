/**
 * Basemap styles for the World map. Everything here is keyless and licensed
 * for an open-source app (docs/WORLD_ATLAS_PLAN.md §5): OpenFreeMap vector
 * tiles, EOX Sentinel-2 cloudless 2016 (CC BY 4.0), NASA GIBS daily imagery
 * and the AWS terrain tiles. Pure functions, so styles are testable without a map.
 */
import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl'

export type StyleId = 'satellite' | 'today' | 'dark' | 'light' | 'relief'

export const DEFAULT_STYLE: StyleId = 'satellite'

export const STYLES: { id: StyleId; label: string; hint: string }[] = [
  { id: 'satellite', label: 'Satellite', hint: 'The real Earth from space, with place names' },
  { id: 'today', label: 'Today from space', hint: 'Yesterday’s true-colour view (NASA), clouds and all' },
  { id: 'relief', label: 'Relief', hint: 'Mountains and valleys shaded' },
  { id: 'dark', label: 'Dark', hint: 'Streets and borders, dark' },
  { id: 'light', label: 'Light', hint: 'Streets and borders, light' },
]

export const isStyleId = (v: unknown): v is StyleId => STYLES.some(s => s.id === v)

export const BASE_URL = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/positron',
}

const OSM_CREDIT = 'OpenFreeMap © OpenMapTiles © OpenStreetMap contributors'

const EOX: SourceSpecification = {
  type: 'raster',
  // "s2cloudless" without a year is the 2016 layer, the one under CC BY 4.0 (later years are non-commercial).
  tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg'],
  tileSize: 256,
  maxzoom: 14,
  attribution: 'Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0',
}

const gibs = (day: string): SourceSpecification => ({
  type: 'raster',
  tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${day}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`],
  tileSize: 256,
  maxzoom: 9,
  attribution: `NASA EOSDIS GIBS, VIIRS NOAA-20 true colour, ${day}`,
})

const TERRAIN: SourceSpecification = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium',
  tileSize: 256,
  maxzoom: 14,
  attribution: 'Terrain: Mapzen terrain tiles on AWS Open Data (SRTM, GMTED2010, ETOPO1 and others)',
}

/** Yesterday in UTC: today's daily mosaic is still being filled in. */
export const gibsDay = (now: number) => new Date(now - 86_400_000).toISOString().slice(0, 10)

/**
 * Place names, borders and road names from a vector style, to lay over
 * imagery: light text on a dark halo, so names read over desert and sea alike.
 */
export const labelLayers = (base: StyleSpecification): LayerSpecification[] =>
  base.layers
    .filter(l => l.type === 'symbol' || /^boundary/.test(l.id))
    .map((l): LayerSpecification => {
      if (l.type === 'line') return { ...l, paint: { ...l.paint, 'line-color': 'rgba(255,255,255,0.55)' } }
      if (l.type === 'symbol') return { ...l, paint: { ...l.paint, 'text-color': '#f1f5f9', 'text-halo-color': 'rgba(2,6,12,0.85)', 'text-halo-width': 1.4 } }
      return l
    })

/** Imagery at the bottom, the base style's labels and borders on top. */
const overImagery = (base: StyleSpecification, id: string, raster: SourceSpecification): StyleSpecification => ({
  ...base,
  sources: { ...base.sources, [id]: raster },
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#05080f' } }, { id, type: 'raster', source: id, paint: { 'raster-fade-duration': 200 } }, ...labelLayers(base)],
})

/** Shaded relief slipped under the first label of a vector style. */
const withHillshade = (base: StyleSpecification): StyleSpecification => {
  const firstLabel = base.layers.findIndex(l => l.type === 'symbol')
  const at = firstLabel < 0 ? base.layers.length : firstLabel
  const shade: LayerSpecification = {
    id: 'hillshade',
    type: 'hillshade',
    source: 'terrain',
    paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#ffffff' },
  }
  return { ...base, sources: { ...base.sources, terrain: TERRAIN }, layers: [...base.layers.slice(0, at), shade, ...base.layers.slice(at)] }
}

export interface StyleInput {
  id: StyleId
  /** The OpenFreeMap styles, fetched once. */
  bases: { dark: StyleSpecification; light: StyleSpecification }
  /** The app theme decides which vector style sits under the relief. */
  theme: 'dark' | 'light'
  globe: boolean
  now: number
}

export const composeStyle = ({ id, bases, theme, globe, now }: StyleInput): StyleSpecification => {
  const style =
    id === 'satellite'
      ? overImagery(bases.dark, 'imagery', EOX)
      : id === 'today'
        ? overImagery(bases.dark, 'imagery', gibs(gibsDay(now)))
        : id === 'relief'
          ? withHillshade(theme === 'light' ? bases.light : bases.dark)
          : id === 'light'
            ? bases.light
            : bases.dark
  return {
    ...style,
    projection: { type: globe ? 'globe' : 'mercator' },
    // A thin atmosphere around the globe when zoomed out, gone once close to the ground.
    ...(globe ? { sky: { 'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0] } } : {}),
  }
}

/** Credits for the style on screen, for the attribution line. */
export const styleCredit = (id: StyleId) =>
  id === 'satellite'
    ? `Imagery: Sentinel-2 cloudless 2016 by EOX (CC BY 4.0) · Labels: ${OSM_CREDIT}`
    : id === 'today'
      ? `Imagery: NASA EOSDIS GIBS · Labels: ${OSM_CREDIT}`
      : id === 'relief'
        ? `Relief: Mapzen terrain tiles (AWS Open Data) · ${OSM_CREDIT}`
        : OSM_CREDIT

export interface CreditPart {
  text: string
  href?: string
}

/** Live layers name their source in the credit line only while they are on. */
const LAYER_CREDIT: Record<string, CreditPart> = {
  flights: { text: 'Flights adsb.lol', href: 'https://adsb.lol' },
  ships: { text: 'Ships AISStream', href: 'https://aisstream.io' },
  satellites: { text: 'CelesTrak', href: 'https://celestrak.org' },
  quakes: { text: 'USGS' },
  events: { text: 'NASA EONET' },
  disasters: { text: 'GDACS', href: 'https://www.gdacs.org' },
  news: { text: 'Places GeoNames', href: 'https://www.geonames.org' },
}

/**
 * The map's own small credit line: imagery, base map (OpenStreetMap's
 * licence asks for a visible credit with a link), then the live layers on.
 */
export const creditLine = (id: StyleId, layersOn: readonly string[], extra: readonly CreditPart[] = []): CreditPart[] => [
  ...(id === 'satellite'
    ? [{ text: 'Imagery © EOX Sentinel-2 cloudless 2016', href: 'https://s2maps.eu' }]
    : id === 'today'
      ? [{ text: 'Imagery NASA GIBS', href: 'https://www.earthdata.nasa.gov/gibs' }]
      : id === 'relief'
        ? [{ text: 'Relief Mapzen/AWS' }]
        : []),
  { text: 'OpenFreeMap', href: 'https://openfreemap.org' },
  { text: '© OpenMapTiles', href: 'https://www.openmaptiles.org' },
  { text: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' },
  ...layersOn.flatMap(l => (LAYER_CREDIT[l] ? [LAYER_CREDIT[l]] : [])),
  ...extra,
]

/**
 * Switching styles replaces every source and layer; this carries the map's
 * own data layers (flights, ships, places…) into the new style, on top.
 */
export const carryOverlays = (prev: StyleSpecification | undefined, next: StyleSpecification, ownSources: ReadonlySet<string>): StyleSpecification => {
  if (!prev) return next
  const sources = { ...next.sources }
  for (const [id, src] of Object.entries(prev.sources)) if (ownSources.has(id)) sources[id] = src
  const own = prev.layers.filter(l => 'source' in l && typeof l.source === 'string' && ownSources.has(l.source))
  return { ...next, sources, layers: [...next.layers.filter(l => !own.some(o => o.id === l.id)), ...own] }
}

/** The remembered style and projection; satellite and flat when nothing is saved. */
export const readMapPrefs = (): { style: StyleId; globe: boolean } => {
  try {
    const raw = JSON.parse(localStorage.getItem('world.map') ?? '{}') as { style?: unknown; globe?: unknown }
    return { style: isStyleId(raw.style) ? raw.style : DEFAULT_STYLE, globe: raw.globe === true }
  } catch {
    return { style: DEFAULT_STYLE, globe: false }
  }
}

export const saveMapPrefs = (p: { style: StyleId; globe: boolean }) => {
  try {
    localStorage.setItem('world.map', JSON.stringify(p))
  } catch {
    // A convenience only.
  }
}
