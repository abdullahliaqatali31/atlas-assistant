import { describe, expect, it } from 'vitest'

import { displayLabel, parseWidgetOp, pickDisplay, placeWidget, spotOf, type DisplayInfo } from './widget.ts'

const laptop: DisplayInfo = { id: '\\\\.\\DISPLAY1', name: 'Generic PnP Monitor', primary: true, x: 0, y: 0, w: 1920, h: 1080, wx: 0, wy: 0, ww: 1920, wh: 1032, scale: 1.25 }
const dell: DisplayInfo = { id: '\\\\.\\DISPLAY2', name: 'DELL U2723QE', primary: false, x: 1920, y: 0, w: 2560, h: 1440, wx: 1920, wy: 0, ww: 2560, wh: 1400, scale: 1 }
const list = [dell, laptop]

describe('desktop widget placement', () => {
  it('sits in a corner of the work area, scaled for the display, never under the taskbar', () => {
    expect(placeWidget(laptop, 'bar', 'bottom-right')).toEqual({ x: 1920 - 575 - 20, y: 1032 - 185 - 20, w: 575, h: 185 })
    expect(placeWidget(dell, 'orb', 'top-left')).toEqual({ x: 1920 + 16, y: 16, w: 132, h: 132 })
    const g = placeWidget(dell, 'glass', 'center')
    expect(g.x + g.w / 2).toBeCloseTo(1920 + 1280, -1)
  })

  it('stays where the owner dropped it, as it grows, and never off the display', () => {
    const dropped = { x: 2600, y: 300, w: 460, h: 148 }
    const spot = spotOf(dell, dropped)
    expect(placeWidget(dell, 'bar', 'bottom-right', spot)).toEqual({ ...dropped, x: expect.closeTo(2600, -1), y: expect.closeTo(300, -1) })
    const chat = placeWidget(dell, 'chat', 'bottom-right', spot)
    expect(chat.x).toBeGreaterThanOrEqual(dell.wx)
    expect(chat.x + chat.w).toBeLessThanOrEqual(dell.wx + dell.ww)
    expect(chat.y + chat.h).toBeLessThanOrEqual(dell.wy + dell.wh)
    // Dragged past the edge: it comes back inside.
    const out = placeWidget(dell, 'bar', 'bottom-right', spotOf(dell, { x: 9000, y: -400, w: 460, h: 148 }))
    expect(out.x + out.w).toBeLessThanOrEqual(dell.wx + dell.ww)
    expect(out.y).toBeGreaterThanOrEqual(dell.wy)
  })

  it('stays inside a small display', () => {
    const tiny = { ...laptop, ww: 800, wh: 600, scale: 1 }
    const p = placeWidget(tiny, 'glass', 'center')
    expect(p.w).toBeLessThanOrEqual(800 - 32)
    expect(p.h).toBeLessThanOrEqual(600 - 32)
  })

  it('finds the display that was meant', () => {
    expect(pickDisplay(list, 'main', null, null)).toBe(laptop)
    expect(pickDisplay(list, 'new', laptop.id, dell.id)).toBe(dell)
    expect(pickDisplay(list, 'right', null, null)).toBe(dell)
    expect(pickDisplay(list, 'left', null, null)).toBe(laptop)
    expect(pickDisplay(list, 'other', laptop.id, null)).toBe(dell)
    expect(pickDisplay(list, '2', null, null)).toBe(dell)
    expect(pickDisplay(list, 'dell', null, null)).toBe(dell)
    expect(pickDisplay(list, 'nowhere', null, null)).toBeNull()
  })

  it('names displays the way people do', () => {
    expect(displayLabel(dell, [laptop, dell])).toBe('DELL U2723QE · 2560×1440')
    expect(displayLabel(laptop, [laptop, dell])).toBe('Display 1 (main) · 1920×1080')
  })

  it('accepts only well-formed requests', () => {
    expect(parseWidgetOp({ kind: 'move', display: 'new', corner: 'top-right' })).toEqual({ kind: 'move', display: 'new', corner: 'top-right' })
    expect(parseWidgetOp({ kind: 'mode', mode: 'huge' })).toBeNull()
    expect(parseWidgetOp({ kind: 'move', corner: 'middle' })).toEqual({ kind: 'move', display: undefined, corner: undefined })
  })
})
