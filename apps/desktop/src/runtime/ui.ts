/**
 * Atlas's own window, runtime side: one line in every turn's context saying
 * what the window shows, and two tools to look at and change it (page,
 * conversation, size, compact mode, keep on top). Changing its own window is
 * harmless, so it runs without asking, but only when the owner wants it.
 */
import { randomUUID } from 'node:crypto'

import type { Rule } from '@assistant/policy'
import type { RuntimeTool } from '@assistant/runtime'

import { MAP_LAYERS, MAP_STYLES, mapOpFromTool, MAX_PINS, MAX_STORY_ITEMS } from '../shared/map.ts'
import { describeUi, VIEWS, WINDOW_SIZES, type UiChange, type UiOp, type UiState } from '../shared/ui.ts'

const REQUEST_TIMEOUT_MS = 30_000

/** The World map tools only change the view, so they are observe-class and run without asking, even after reading news. */
export const MAP_TOOLS = ['map_view', 'map_layers', 'map_visible', 'map_find', 'map_focus', 'map_pins', 'map_back', 'map_story', 'map_tour'] as const

export const UI_RULES: Rule[] = [
  { id: 'default-ui_state', tool: 'ui_state', actionClass: 'observe', effect: 'allow' },
  { id: 'default-ui_control', tool: 'ui_control', actionClass: 'modify', effect: 'allow' },
  ...MAP_TOOLS.map((tool): Rule => ({ id: `default-${tool}`, tool, actionClass: 'observe', effect: 'allow' })),
]

const LAYER_LIST = MAP_LAYERS.join(', ')

export class HostUi {
  private snapshot: UiState | null = null
  private readonly pending = new Map<string, (r: { result?: string | undefined; error?: string | undefined }) => void>()

  constructor(
    private readonly deps: {
      post: (e: { type: 'ui'; requestId: string; op: UiOp }) => void
      /** Place name → coordinates, for "fly to Karachi". */
      geocode?: (name: string) => Promise<{ name: string; country: string | null; lat: number; lon: number } | null>
    },
  ) {}

  /** map_view with a place name: look it up first, then fly. */
  private async mapView(input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const place = typeof input.place === 'string' ? input.place.trim().slice(0, 80) : ''
    if (place && (typeof input.lat !== 'number' || typeof input.lon !== 'number')) {
      if (!this.deps.geocode) throw new Error('Place lookup is not available; give lat and lon.')
      const found = await this.deps.geocode(place)
      if (!found) throw new Error(`Could not find a place called "${place}". Try a nearby city or give lat and lon.`)
      input = { ...input, lat: found.lat, lon: found.lon, label: typeof input.label === 'string' ? input.label : [found.name, found.country].filter(Boolean).join(', ') }
    }
    return this.request({ kind: 'map', op: mapOpFromTool('map_view', input) }, signal)
  }

  /** map_story: items given by place name get coordinates first (one lookup per distinct place). */
  private async mapStory(input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const raw = Array.isArray(input.items) ? input.items.slice(0, MAX_STORY_ITEMS) : []
    const found = new Map<string, { lat: number; lon: number } | null>()
    const missing: string[] = []
    const items = []
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue
      const o = { ...(r as Record<string, unknown>) }
      const place = typeof o.place === 'string' ? o.place.trim() : ''
      if ((typeof o.lat !== 'number' || typeof o.lon !== 'number') && place && this.deps.geocode) {
        if (!found.has(place.toLowerCase())) {
          const g = await this.deps.geocode(place).catch(() => null)
          found.set(place.toLowerCase(), g ? { lat: g.lat, lon: g.lon } : null)
        }
        const g = found.get(place.toLowerCase())
        if (g) Object.assign(o, g)
        else missing.push(place)
      }
      items.push(o)
    }
    const result = await this.request({ kind: 'map', op: mapOpFromTool('map_story', { ...input, items }) }, signal)
    return missing.length ? `${result} Not placed (unknown places): ${missing.join(', ')}.` : result
  }

  private mapTools(): RuntimeTool[] {
    const tool = (name: (typeof MAP_TOOLS)[number], description: string, properties: Record<string, unknown>, isUntrusted: boolean): RuntimeTool => ({
      name,
      description,
      inputSchema: { type: 'object', properties, additionalProperties: false },
      actionClass: 'observe',
      isUntrusted,
      run: (input, signal) =>
        name === 'map_view' ? this.mapView(input, signal) : name === 'map_story' ? this.mapStory(input, signal) : this.request({ kind: 'map', op: mapOpFromTool(name, input) }, signal),
    })
    const layerArray = { type: 'array', items: { type: 'string', enum: [...MAP_LAYERS] } }
    return [
      tool(
        'map_view',
        'Move the World map (it opens the World page if needed): fly to a place name or lat/lon, set the zoom (2 world, 4 country, 6 region, 9 city, 13 streets), switch the style (satellite = real Earth, today = yesterday from space with clouds, relief, dark, light) or the globe. Use when the owner asks to see somewhere ("Karachi dikhao", "satellite view lagao", "globe pe le jao").',
        {
          place: { type: 'string', description: 'A city, country or landmark to fly to.' },
          lat: { type: 'number' },
          lon: { type: 'number' },
          zoom: { type: 'number' },
          label: { type: 'string', description: 'What to call it in your answer.' },
          style: { type: 'string', enum: [...MAP_STYLES] },
          globe: { type: 'boolean', description: 'true for the 3D globe, false for the flat map.' },
        },
        false,
      ),
      tool('map_layers', `Show or hide World map layers: ${LAYER_LIST}. Pins are the ones you drop with map_pins.`, { show: layerArray, hide: layerArray }, false),
      tool(
        'map_visible',
        'What the World map shows right now: where it is looking, the style, each layer’s count on screen and the nearest items, and what is selected. Use before describing the map ("kya dikh raha hai?"). Item names come from public feeds: untrusted.',
        {},
        true,
      ),
      tool(
        'map_find',
        'Search what is loaded on the World map by name: places, flights (callsign or registration), ships (name), cameras, quakes, natural events, pins. Flights load only around the map centre when zoomed in, ships only where the owner has an AISStream key. Returns matches with coordinates; untrusted text.',
        { query: { type: 'string' }, layers: layerArray },
        true,
      ),
      tool(
        'map_focus',
        'Focus the World map on one thing: fly there at a fitting zoom, open its card and show what is around it. query finds it by name on the map (as map_find), or give lat/lon. clear: true closes the card. For "focus on this", use what the owner just pointed at or what you last mentioned.',
        { query: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' }, zoom: { type: 'number' }, label: { type: 'string' }, clear: { type: 'boolean' } },
        true,
      ),
      tool(
        'map_pins',
        `Drop labelled pins on the World map (at most ${MAX_PINS}), e.g. the places in a story you are telling; the map frames them. clear: true removes your earlier pins first. Pins show only on screen; nothing is saved.`,
        {
          add: {
            type: 'array',
            items: { type: 'object', properties: { lat: { type: 'number' }, lon: { type: 'number' }, label: { type: 'string' }, note: { type: 'string' } }, required: ['lat', 'lon', 'label'] },
          },
          clear: { type: 'boolean' },
        },
        false,
      ),
      tool('map_back', 'Return the World map to the view before your last move ("wapas").', {}, false),
      tool(
        'map_story',
        `Put a news story on the World map ("aaj ki important news map pe dikhao"): read the news first (news tool, world_now), pick the items that matter most to the owner (usually 5 to 12, at most ${MAX_STORY_ITEMS}), most important first, and place each where it happens. Items get numbered markers sized by severity (0-10) and a News canvas lists them; links draw a line between related items, each with a short reason ("same conflict", "cause and effect", "same company"). Give lat/lon if you know them, otherwise a place name to look up. A new story replaces the old one; clear: true takes it off.`,
        {
          title: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short headline.' },
                summary: { type: 'string', description: 'One or two sentences in the owner’s language.' },
                place: { type: 'string' },
                lat: { type: 'number' },
                lon: { type: 'number' },
                severity: { type: 'number', description: '0-10' },
                source: { type: 'string' },
                url: { type: 'string', description: 'https link to the article.' },
              },
              required: ['label'],
            },
          },
          links: {
            type: 'array',
            items: { type: 'object', properties: { from: { type: 'integer', description: 'Item number, from 1.' }, to: { type: 'integer' }, reason: { type: 'string' } }, required: ['from', 'to'] },
          },
          clear: { type: 'boolean' },
        },
        false,
      ),
      tool(
        'map_tour',
        'Tour the story on the World map: fly to each numbered item in turn and open its card for a few seconds (stop it with action "stop"). Narrate each stop briefly in your reply if the owner wants it told.',
        { action: { type: 'string', enum: ['play', 'stop'] }, seconds_each: { type: 'number', description: '3-30, default 7.' } },
        false,
      ),
    ]
  }

  setSnapshot(s: UiState) {
    this.snapshot = s
  }

  contextLines(): string[] {
    return this.snapshot ? [`Your own window (the Atlas app): ${describeUi(this.snapshot)} You can change it with ui_control when the owner asks, and drive the World map with the map_* tools.`] : []
  }

  onResult(requestId: string, result?: string, error?: string) {
    this.pending.get(requestId)?.({ result, error })
    this.pending.delete(requestId)
  }

  private request(op: UiOp, signal?: AbortSignal): Promise<string> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('The window did not answer in time.'))
      }, REQUEST_TIMEOUT_MS)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new Error('Stopped.'))
      }, { once: true })
      this.pending.set(requestId, r => {
        clearTimeout(timer)
        if (r.error) reject(new Error(r.error))
        else resolve(r.result ?? '')
      })
      this.deps.post({ type: 'ui', requestId, op })
    })
  }

  tools(): RuntimeTool[] {
    return [
      ...this.mapTools(),
      {
        name: 'ui_state',
        description: 'What your own Atlas window shows right now: page, conversation open or hidden, compact mode, size and layout, kept on top or not.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        actionClass: 'observe',
        isUntrusted: false,
        run: (_i, signal) => this.request({ kind: 'state' }, signal),
      },
      {
        name: 'ui_control',
        description:
          'Change your own Atlas window when the owner asks ("compact ho jao", "news dikhao", "chat band karo", "bari window kar do", "upar rakho"), or after offering it and hearing yes. Do not rearrange it on your own. view: which page; chat: show or hide the conversation; size: compact (small chat-only window in the corner), normal, large, maximized or minimized; pinned: keep above other windows. Opening a page leaves compact mode.',
        inputSchema: {
          type: 'object',
          properties: {
            view: { type: 'string', enum: [...VIEWS] },
            chat: { type: 'boolean' },
            size: { type: 'string', enum: [...WINDOW_SIZES] },
            pinned: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        actionClass: 'modify',
        isUntrusted: false,
        run: (input, signal) => {
          const change: UiChange = {
            view: typeof input.view === 'string' ? (input.view as UiChange['view']) : undefined,
            chat: typeof input.chat === 'boolean' ? input.chat : undefined,
            size: typeof input.size === 'string' ? (input.size as UiChange['size']) : undefined,
            pinned: typeof input.pinned === 'boolean' ? input.pinned : undefined,
          }
          if (Object.values(change).every(v => v === undefined)) return Promise.reject(new Error('Say what to change: view, chat, size or pinned.'))
          return this.request({ kind: 'set', change }, signal)
        },
      },
    ]
  }
}
