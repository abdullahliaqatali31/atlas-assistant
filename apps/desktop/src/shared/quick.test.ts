import { describe, expect, it } from 'vitest'

import { quickAnswer } from './quick.ts'

const now = new Date(2026, 9, 22, 15, 7).getTime()
const q = (text: string, urdu = true) => quickAnswer(text, { now, names: ['Lala', 'Atlas'], urdu })

describe('instant answers', () => {
  it('tells the time and the date, in Roman Urdu or English', () => {
    expect(q('Lala, kitne baje hain?')).toEqual({ reply: 'Abhi 3:07 PM baje hain.' })
    expect(q('what time is it', false)).toEqual({ reply: "It's 3:07 PM." })
    expect(q('aaj kya date hai')?.reply).toBe('Aaj Thursday, 22 October 2026 hai.')
  })

  it('stops, changes mode, pauses, and turns the voice up or down', () => {
    expect(q('bas')).toEqual({ reply: '', action: { kind: 'stop' } })
    expect(q('Atlas stop')?.action).toEqual({ kind: 'stop' })
    expect(q('focus mode on')?.action).toEqual({ kind: 'mode', mode: 'focus' })
    expect(q('quiet ho jao')?.action).toEqual({ kind: 'mode', mode: 'quiet' })
    expect(q('pause automation')?.action).toEqual({ kind: 'pause', on: true })
    expect(q('awaz tez karo')?.action).toEqual({ kind: 'volume', dir: 'up' })
    expect(q('aahista bolo')?.action).toEqual({ kind: 'volume', dir: 'down' })
  })

  it('leaves everything else to the model', () => {
    expect(q('kitne baje meeting hai Bilal ke saath?')).toBeNull()
    expect(q('stop the dev server for QuantX')).toBeNull()
    expect(q('what time does the bank close')).toBeNull()
    expect(q('bas, ab news sunao')).toBeNull()
  })
})

describe('instant pages and timers', () => {
  it('opens a page said plainly, in either language', () => {
    expect(q('world map dikhao')?.action).toEqual({ kind: 'open', view: 'world' })
    expect(q('mujhe map dikhao zara')?.action).toEqual({ kind: 'open', view: 'world' })
    expect(q('news wala page kholo')?.action).toEqual({ kind: 'open', view: 'news' })
    expect(q('open settings', false)).toEqual({ reply: 'Here is Settings.', action: { kind: 'open', view: 'setup' } })
    expect(q('browser open karo')?.action).toEqual({ kind: 'open', view: 'browser' })
  })

  it('sets a timer from a plain request', () => {
    expect(q('5 minute ka timer lagao')).toEqual({ reply: '5 minute ka timer laga diya.', action: { kind: 'timer', minutes: 5 } })
    expect(q('set a 10 minute timer', false)).toEqual({ reply: 'Timer set for 10 minutes.', action: { kind: 'timer', minutes: 10 } })
    expect(q('ek ghante ka timer')?.action).toEqual({ kind: 'timer', minutes: 60 })
    expect(q('timer 30 seconds')?.action).toEqual({ kind: 'timer', minutes: 0.5 })
  })

  it('leaves requests with more in them to the model', () => {
    expect(q('browser mein youtube kholo')).toBeNull()
    expect(q('map pe Karachi dikhao')).toBeNull()
    expect(q('world cup ka score dikhao')).toBeNull()
    expect(q('5 minute baad yaad dilana ke chai banani hai')).toBeNull()
  })
})
