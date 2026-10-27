import { evaluate } from '@assistant/policy'
import { describe, expect, it } from 'vitest'

import type { UiOp } from '../shared/ui.ts'
import { HostUi, MAP_TOOLS, UI_RULES } from './ui.ts'

/** A HostUi whose window answers every op at once with what it was asked. */
const setup = (geocode?: ConstructorParameters<typeof HostUi>[0]['geocode']) => {
  const posted: UiOp[] = []
  const ui: HostUi = new HostUi({
    post: e => {
      posted.push(e.op)
      queueMicrotask(() => ui.onResult(e.requestId, 'ok'))
    },
    geocode,
  })
  const tool = (name: string) => ui.tools().find(t => t.name === name)!
  return { ui, posted, tool }
}

describe('map tools', () => {
  it('looks a place name up, then flies there with a readable label', async () => {
    const { posted, tool } = setup(async name => (name === 'Karachi' ? { name: 'Karachi', country: 'Pakistan', lat: 24.86, lon: 67.0 } : null))
    await tool('map_view').run({ place: 'Karachi', zoom: 9, style: 'satellite' })
    expect(posted).toEqual([{ kind: 'map', op: { kind: 'view', lat: 24.86, lon: 67.0, zoom: 9, label: 'Karachi, Pakistan', style: 'satellite', globe: undefined } }])
  })

  it('says so when a place cannot be found, without moving the map', async () => {
    const { posted, tool } = setup(async () => null)
    await expect(tool('map_view').run({ place: 'Atlantis' })).rejects.toThrow('Could not find a place called "Atlantis"')
    expect(posted).toEqual([])
  })

  it('passes searches and pins straight to the map', async () => {
    const { posted, tool } = setup()
    await tool('map_find').run({ query: 'PIA301', layers: ['flights'] })
    await tool('map_pins').run({ add: [{ lat: 26.5, lon: 56.3, label: 'Hormuz' }], clear: true })
    expect(posted.map(o => (o.kind === 'map' ? o.op.kind : o.kind))).toEqual(['find', 'pins'])
  })

  it('places story items by name, looking each place up once, and says which it could not place', async () => {
    const looked: string[] = []
    const { posted, tool } = setup(async name => {
      looked.push(name)
      return name === 'Gaza' ? { name: 'Gaza', country: null, lat: 31.5, lon: 34.47 } : null
    })
    const out = await tool('map_story').run({
      title: 'Middle East',
      items: [
        { label: 'Aid convoy reaches Gaza', place: 'Gaza' },
        { label: 'Second Gaza report', place: 'gaza' },
        { label: 'Talks in Doha', place: 'Doha', lat: 25.29, lon: 51.53 },
        { label: 'Somewhere odd', place: 'Atlantis' },
      ],
    })
    expect(looked).toEqual(['Gaza', 'Atlantis'])
    const op = posted[0]
    expect(op?.kind === 'map' && op.op.kind === 'story' && op.op.story?.items.map(i => i.label)).toEqual(['Aid convoy reaches Gaza', 'Second Gaza report', 'Talks in Doha'])
    expect(out).toContain('Not placed (unknown places): Atlantis')
  })

  it('lets every map tool run without asking, even after untrusted content', () => {
    for (const name of MAP_TOOLS) {
      const d = evaluate({ tool: name, actionClass: 'observe', fromUntrustedSource: true }, UI_RULES, 0)
      expect(d.effect, name).toBe('allow')
    }
  })

  it('marks results that carry feed text as untrusted', () => {
    const { tool } = setup()
    expect(['map_visible', 'map_find', 'map_focus'].every(n => tool(n).isUntrusted)).toBe(true)
    expect(tool('map_view').isUntrusted).toBe(false)
  })
})

describe('timer tools', () => {
  it('sends timers to the gateway and refuses half-asked ones before bothering it', async () => {
    const { posted, tool } = setup()
    await tool('timer_set').run({ label: 'Tea', in_minutes: 10 })
    await tool('timer_set').run({ label: 'Standup', at: '09:00', repeat: 'weekdays' })
    await tool('timers_list').run({})
    await tool('timer_cancel').run({ number: 1 })
    expect(posted).toEqual([
      { kind: 'timer', op: { kind: 'set', label: 'Tea', inMinutes: 10, at: undefined, repeat: null } },
      { kind: 'timer', op: { kind: 'set', label: 'Standup', inMinutes: undefined, at: '09:00', repeat: 'weekdays' } },
      { kind: 'timer', op: { kind: 'list' } },
      { kind: 'timer', op: { kind: 'cancel', n: 1 } },
    ])
    await expect(tool('timer_set').run({ label: 'x' })).rejects.toThrow(/Say when/)
    expect(posted).toHaveLength(4)
  })

  it('runs without asking: the owner asked for the timer', () => {
    for (const name of ['timer_set', 'timers_list', 'timer_cancel']) expect(evaluate({ tool: name, actionClass: name === 'timers_list' ? 'observe' : 'modify', fromUntrustedSource: false }, UI_RULES, 0).effect).toBe('allow')
  })
})
