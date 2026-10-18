import { describe, expect, it } from 'vitest'

import { buildAlerts, DAY_MS, type AlertSources } from './alerts.ts'

const now = 1_800_000_000_000
const base: AlertSources = { now, approvals: [], later: [], world: null, activity: [], code: null, controls: null, tasks: null }
const place = { id: 'p1', name: 'Islamabad', country: 'Pakistan', lat: 33.7, lon: 73.1, timezone: null }

describe('alerts timeline', () => {
  it('puts what still needs the owner first, then the newest', () => {
    const items = buildAlerts({
      ...base,
      approvals: [{ id: 'a1', tool: 'files_read', actionClass: 'observe', input: '{}', reason: 'Reads a file', question: 'Kya main ye file parh loon?' }],
      later: [{ id: 'l1', kind: 'reminder', title: 'Call the bank', channel: 'queue', reason: 'You were busy', at: now - 60_000, canMute: true }],
      activity: [{ id: 'x1', tool: 'whatsapp_read', summary: 'Raheel', decision: 'allow', ruleId: null, result: 'failed', evidence: null, at: now - 120_000 }],
    })
    expect(items.map(i => i.kind)).toEqual(['question', 'notice', 'failure'])
    expect(items[0]).toMatchObject({ open: true, approvalId: 'a1', title: 'Kya main ye file parh loon?' })
    expect(items[2]!.title).toBe('whatsapp read failed')
  })

  it('keeps only the last 24 hours, but always shows bad air now', () => {
    const items = buildAlerts({
      ...base,
      world: {
        places: [
          {
            place,
            weather: null,
            air: { aqi: 180, pm25: 90, pm10: 120, level: 'Unhealthy' },
            news: [],
            nearby: [
              { kind: 'quake', id: 'q-new', title: 'M5.1 · Hindu Kush', km: 240, time: now - 3_600_000 },
              { kind: 'quake', id: 'q-old', title: 'M4.6 · old', km: 300, time: now - DAY_MS - 1 },
            ],
          },
        ],
        quakes: [],
        events: [],
        updatedAt: now - 1000,
        problems: [],
      },
    })
    expect(items.map(i => i.id)).toEqual(['air:p1', 'near:q-new:p1'])
    expect(items[0]!.title).toContain('AQI 180')
    expect(items[1]!.detail).toBe('240 km from Islamabad')
  })

  it('lists overdue tasks from today and failed connections as open', () => {
    const items = buildAlerts({
      ...base,
      tasks: [
        { id: 't1', title: 'Send invoice', status: 'open', dueAt: now - 7_200_000 },
        { id: 't2', title: 'Later', status: 'open', dueAt: now + 7_200_000 },
      ],
      controls: { servers: [{ name: 'gmail', label: 'Gmail', enabled: true, state: 'failed', error: 'Sign-in expired' }] } as unknown as AlertSources['controls'],
    })
    expect(items.map(i => i.id).sort()).toEqual(['srv:gmail', 'task:t1'])
    expect(items.every(i => i.open)).toBe(true)
  })
})

describe('readable tool input', () => {
  it('turns JSON into words and drops long ids', async () => {
    const { readableInput } = await import('./alerts.ts')
    expect(readableInput('{"chat":"Raheel Ahmed Saudi","count":10}')).toBe('chat Raheel Ahmed Saudi · count 10')
    expect(readableInput('{"proposal_id":"15c030b5-5e4d-41b2-b4fa-f531d0b9d7a2","accept":false}')).toBe('accept false')
    expect(readableInput('plain text')).toBe('plain text')
  })
})
