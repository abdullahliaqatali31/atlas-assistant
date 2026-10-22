/**
 * Satellite positions off the page's thread: SGP4 for the whole catalogue,
 * answered as one buffer of Earth-fixed x, y, z in metres (NaN where a
 * satellite is skipped or its orbit cannot be computed).
 */
import * as satellite from 'satellite.js'

export type SatWorkerIn = { kind: 'load'; elements: unknown[] } | { kind: 'move'; seq: number; at: number; skip: Uint8Array }
export interface SatWorkerOut {
  seq: number
  at: number
  pos: Float64Array
}

/** Element sets that could not be read stay null, so indexes match the page's list. */
let recs: (satellite.SatRec | null)[] = []

/** Earth-fixed positions of every satellite not skipped, at `at`. */
const propagateAll = (list: readonly (satellite.SatRec | null)[], at: Date, skip?: Uint8Array): Float64Array => {
  const pos = new Float64Array(list.length * 3).fill(Number.NaN)
  const gmst = satellite.gstime(at)
  for (let i = 0; i < list.length; i++) {
    const rec = list[i]
    if (!rec || skip?.[i]) continue
    const pv = satellite.propagate(rec, at)
    if (!pv || typeof pv.position !== 'object' || !pv.position) continue
    const ecf = satellite.eciToEcf(pv.position, gmst)
    pos[i * 3] = ecf.x * 1000
    pos[i * 3 + 1] = ecf.y * 1000
    pos[i * 3 + 2] = ecf.z * 1000
  }
  return pos
}

const scope = globalThis as unknown as { onmessage: ((e: MessageEvent<SatWorkerIn>) => void) | null; postMessage: (m: SatWorkerOut, transfer: Transferable[]) => void }
scope.onmessage = e => {
  const m = e.data
  if (m.kind === 'load') {
    recs = m.elements.map(s => {
      try {
        return satellite.json2satrec(s as satellite.OMMJsonObject)
      } catch {
        return null
      }
    })
    return
  }
  const pos = propagateAll(recs, new Date(m.at), m.skip)
  scope.postMessage({ seq: m.seq, at: m.at, pos }, [pos.buffer])
}
