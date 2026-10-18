/**
 * The always-on news layer: every feed headline that names a place, put
 * there (shared/newsgeo.ts), sized and coloured by how heavy it is.
 * Headlines placed only at country level are spread a little around the
 * capital so they do not sit on one dot.
 */
import type { Headline } from '../../../shared/news.ts'
import { newsSeverity, placeHeadline } from '../../../shared/newsgeo.ts'
import type { FC } from './geo.ts'
import { severityColor } from './mapops.ts'

/** A stable small offset from the headline id, in degrees. */
const jitter = (id: string, spread: number): [number, number] => {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0
  const a = ((h >>> 0) % 360) * (Math.PI / 180)
  const r = (((h >>> 9) % 1000) / 1000) * spread
  return [Math.cos(a) * r, Math.sin(a) * r]
}

export const newsFeatures = (headlines: readonly Headline[]): FC => {
  const features: FC['features'] = []
  for (const h of headlines) {
    const p = placeHeadline(h.title, h.summary)
    if (!p) continue
    const [dx, dy] = p.precision === 'country' ? jitter(h.id, 0.6) : p.precision === 'region' ? jitter(h.id, 0.25) : jitter(h.id, 0.04)
    const severity = newsSeverity(h.title, h.summary)
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon + dx, Math.max(-85, Math.min(85, p.lat + dy))] },
      properties: {
        id: h.id,
        title: h.title,
        source: h.source,
        category: h.category,
        place: p.place,
        precision: p.precision,
        severity,
        color: severityColor(severity),
        ...(h.summary ? { summary: h.summary } : {}),
        ...(h.link.startsWith('https://') ? { url: h.link } : {}),
        ...(h.image ? { image: h.image } : {}),
        ...(h.publishedAt ? { time: h.publishedAt } : {}),
      },
    })
  }
  return { type: 'FeatureCollection', features }
}
