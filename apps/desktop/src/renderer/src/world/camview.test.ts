import { describe, expect, it } from 'vitest'

import { viewCone } from './camview.ts'

const close = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 6))

describe('camera view cone', () => {
  it('looks along its heading, level, with right and up square to it', () => {
    const north = viewCone(0, { tiltDeg: 0 })
    close(north.forward, [0, 1, 0])
    close(north.right, [1, 0, 0])
    close(north.up, [0, 0, 1])
    const east = viewCone(90, { tiltDeg: 0 })
    close(east.forward, [1, 0, 0])
    close(east.right, [0, -1, 0])
  })

  it('tilts down, and the screen sits at the range, 16:9 and 60° wide', () => {
    const c = viewCone(0, { tiltDeg: 10, range: 100 })
    expect(c.forward[2]).toBeLessThan(0)
    expect(Math.hypot(...c.centre)).toBeCloseTo(100)
    expect(c.width).toBeCloseTo(2 * 100 * Math.tan(Math.PI / 6))
    expect(c.width / c.height).toBeCloseTo(16 / 9)
    // The up vector leans back, still square to forward.
    expect(c.up[0] * c.forward[0] + c.up[1] * c.forward[1] + c.up[2] * c.forward[2]).toBeCloseTo(0)
  })

  it('orders the far corners clockwise from top-left as the camera sees them', () => {
    const c = viewCone(0, { tiltDeg: 0, range: 10 })
    const [tl, tr, br, bl] = c.corners
    expect(tl[0]).toBeLessThan(0)
    expect(tr[0]).toBeGreaterThan(0)
    expect(tl[2]).toBeGreaterThan(0)
    expect(br[2]).toBeLessThan(0)
    expect(bl[0]).toBeLessThan(0)
    expect(tl[1]).toBeCloseTo(10)
  })
})
