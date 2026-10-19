import { describe, expect, it } from 'vitest'

import { growFrom, parsePresenceUpdate, parseWidgetSize, startBounds, widgetVisible } from './presence.ts'

const AREA = { x: 0, y: 0, width: 1920, height: 1040 }

describe('desktop widget', () => {
  it('starts in the bottom-right corner, above the taskbar', () => {
    expect(startBounds(AREA, { width: 64, height: 64 })).toEqual({ x: 1832, y: 952, width: 64, height: 64 })
  })

  it('grows away from the edge it sits near, and never off screen', () => {
    const corner = startBounds(AREA, { width: 64, height: 64 })
    // Bottom-right: a pill grows up and to the left; its right and bottom edges stay put.
    const pill = growFrom(corner, { width: 348, height: 64 }, AREA)
    expect(pill.x + pill.width).toBe(corner.x + corner.width)
    expect(pill.y + pill.height).toBe(corner.y + corner.height)
    const card = growFrom(pill, { width: 368, height: 220 }, AREA)
    expect(card.y + card.height).toBe(corner.y + corner.height)
    // Top-left: grows right and down.
    const tl = growFrom({ x: 30, y: 30, width: 64, height: 64 }, { width: 348, height: 64 }, AREA)
    expect(tl).toMatchObject({ x: 30, y: 30 })
    // Dragged half off the edge: pulled back inside.
    const off = growFrom({ x: 1900, y: 1000, width: 64, height: 64 }, { width: 368, height: 300 }, AREA)
    expect(off.x + off.width).toBeLessThanOrEqual(1920)
    expect(off.y + off.height).toBeLessThanOrEqual(1040)
  })

  it('shows when the setting and the main window say so', () => {
    expect(widgetVisible('off', false)).toBe(false)
    expect(widgetVisible('background', true)).toBe(false)
    expect(widgetVisible('background', false)).toBe(true)
    expect(widgetVisible('always', true)).toBe(true)
  })

  it('accepts only sane updates and sizes from the pages', () => {
    expect(parsePresenceUpdate({ activity: 'speaking', caption: 'x'.repeat(2000), level: 4 })).toMatchObject({ activity: 'speaking', level: 1 })
    expect(parsePresenceUpdate({ activity: 'speaking', caption: 'x'.repeat(2000) })?.caption).toHaveLength(600)
    expect(parsePresenceUpdate({ activity: 'shouting' })).toBeNull()
    expect(parsePresenceUpdate(null)).toBeNull()
    expect(parseWidgetSize(5000, 2)).toEqual({ width: 440, height: 48 })
    expect(parseWidgetSize('64', 64)).toBeNull()
    expect(parseWidgetSize(Number.NaN, 64)).toBeNull()
  })
})
