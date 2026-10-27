/**
 * Which 3D model an aircraft gets in the 3D World view, from its ICAO type
 * code. Models are CC BY 4.0 (credits in public/models/README.md); all share
 * one convention (metres, Y-up, nose toward −X), so heading = track + 180°.
 */

export const MODEL_HEADING_OFFSET = 180

export type ModelId = 'airplane' | 'b789' | 'atr72' | 'c172' | 'citation2' | 'bell206' | 'mq9' | 'jet' | 'ship'

const WIDE = /^(B74|B77|B78|A33|A34|A35|A38|B76|IL96|MD11|A30)/
const TURBOPROP = /^(AT[4-7]|DH8|DHC|SF34|JS4|E120|C208|B190|PC12|SW4|L410|D228|AN2|BE20|BE9)/
const PISTON = /^(C1[5-9]\d|C2\d\d|P28|PA\d|SR2|DA4|DA2|BE3|M20|C150|C152|C172|C182|R44|TB\d|RV\d)/
const BIZJET = /^(C25|C5[0-9]|C6[0-9]|C68|C700|CL3|CL6|GLF|GL[5-7]|LJ|E55P|E50P|PC24|FA[0-9]|F2TH|F900|H25B|HDJT|PRM1|G280)/
const HELI = /^(H\d|B0[6-7]|B4[0-9]|EC\d|AS\d|R22|R44|R66|A1[0-9]|S76|S92|AW\d|BK17|MI\d|UH|AH6|H60|B212|B412|B429)/
const DRONE = /^(Q9|MQ9|Q4|RQ4|MQ1|HRON|GLHK)/

export const modelFor = (type: string, military: boolean): ModelId => {
  const t = type.toUpperCase()
  if (DRONE.test(t)) return 'mq9'
  if (HELI.test(t)) return 'bell206'
  if (military) return 'jet'
  if (WIDE.test(t)) return 'b789'
  if (TURBOPROP.test(t)) return 'atr72'
  if (PISTON.test(t)) return 'c172'
  if (BIZJET.test(t)) return 'citation2'
  return 'airplane'
}

/** Camera height for a 2D zoom level at a latitude (so the 3D view opens where the map was). */
export const heightForZoom = (zoom: number, lat: number) => Math.max(300, (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom * 1.6)

/** A heading tape: the compass points around a heading, every 10°, for the cockpit HUD. */
export const headingTape = (heading: number, span = 60): { deg: number; label: string; offset: number }[] => {
  const out: { deg: number; label: string; offset: number }[] = []
  const start = Math.ceil((heading - span / 2) / 10) * 10
  for (let d = start; d <= heading + span / 2; d += 10) {
    const deg = ((d % 360) + 360) % 360
    const label = deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : deg === 270 ? 'W' : String(deg / 10).padStart(2, '0')
    out.push({ deg, label, offset: (d - heading) / span })
  }
  return out
}
