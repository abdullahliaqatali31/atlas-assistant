/**
 * Where moving things have been: each refresh adds a point per aircraft
 * (or ship), so a picked one can show the path it flew while Atlas
 * watched. Short and bounded: the last 40 points, nothing older than 30
 * minutes, at most 6000 tracks.
 */
const MAX_POINTS = 40
const MAX_AGE_MS = 30 * 60_000
const MAX_TRACKS = 6000

export class Trails {
  private readonly tracks = new Map<string, { at: number; p: [number, number] }[]>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Adds the current position of each item; repeats of the same spot are skipped. */
  add(items: readonly { id: string; lon: number; lat: number }[]) {
    const t = this.now()
    for (const it of items) {
      const list = this.tracks.get(it.id) ?? []
      const last = list.at(-1)
      if (!last || last.p[0] !== it.lon || last.p[1] !== it.lat) list.push({ at: t, p: [it.lon, it.lat] })
      while (list.length > MAX_POINTS || (list[0] && t - list[0].at > MAX_AGE_MS)) list.shift()
      this.tracks.delete(it.id)
      this.tracks.set(it.id, list)
    }
    // Oldest-touched tracks go first when there are too many.
    while (this.tracks.size > MAX_TRACKS) this.tracks.delete(this.tracks.keys().next().value!)
  }

  /** The path, oldest first, with longitudes kept continuous across the date line. */
  path(id: string): [number, number][] {
    const out: [number, number][] = []
    for (const { p } of this.tracks.get(id) ?? []) {
      const prev = out.at(-1)
      let lon = p[0]
      if (prev) {
        while (lon - prev[0] > 180) lon -= 360
        while (lon - prev[0] < -180) lon += 360
      }
      out.push([lon, p[1]])
    }
    return out
  }
}
