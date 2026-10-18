/** The top-most map item under a point: shared by click (Inspector) and hover (card). */
import type { Map as MapLibre, PointLike } from 'maplibre-gl'

import type { PointGeometry } from './geo.ts'
import { PICKABLE, type LayerId } from './layers.ts'

export interface Picked {
  kind: LayerId
  lngLat: [number, number]
  props: Record<string, string | number>
  /** Stable while the pointer stays on the same item. */
  key: string
}

export const pickAt = (m: MapLibre, point: { x: number; y: number }, r = 6): Picked | null => {
  const live = PICKABLE.filter(p => m.getLayer(p.layer) && m.getLayoutProperty(p.layer, 'visibility') !== 'none')
  if (!live.length) return null
  const box: [PointLike, PointLike] = [
    [point.x - r, point.y - r],
    [point.x + r, point.y + r],
  ]
  const order = (id: string) => PICKABLE.findIndex(p => p.layer === id)
  const hit = m.queryRenderedFeatures(box, { layers: live.map(p => p.layer) }).sort((a, b) => order(a.layer.id) - order(b.layer.id))[0]
  if (!hit) return null
  const kind = PICKABLE.find(p => p.layer === hit.layer.id)!.kind
  const props = hit.properties as Record<string, string | number>
  const lngLat = (hit.geometry as unknown as PointGeometry).coordinates as [number, number]
  return { kind, lngLat, props, key: `${kind}:${props.id ?? props.title ?? lngLat.join(',')}` }
}
