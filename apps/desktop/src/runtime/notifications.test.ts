import type { InitiativeEvent } from '@assistant/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HostNotifications } from './notifications.ts'

const n = (id: number, app: string, title: string, body: string) => ({ id, app, title, body, at: 1_000 + id })

describe('notifications for Atlas', () => {
  afterEach(() => vi.useRealTimers())

  it('raises one event per chat sender, never for background or non-chat apps', async () => {
    vi.useFakeTimers()
    const raised: InitiativeEvent[] = []
    const h = new HostNotifications({ now: () => 2_000, raise: e => void raised.push(e), recall: name => (name === 'Bilal' ? ['Bilal is a client.'] : []) })
    h.add([n(1, 'WhatsApp', 'Old', 'from before')], false)
    h.add([n(2, 'WhatsApp', 'Bilal', 'Salam'), n(3, 'WhatsApp', 'Bilal', 'Call me'), n(4, 'Windows', 'Update', 'Restart'), n(5, 'Teams', 'Sara', 'Standup?')], true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(raised).toHaveLength(2)
    const bilal = raised.find(e => e.type === 'message.arrived' && e.from === 'Bilal')
    expect(bilal).toMatchObject({ isUrgent: true, preview: '(2 messages) Salam / Call me' })
    expect(raised.find(e => e.type === 'message.arrived' && e.from === 'Sara')).toMatchObject({ isUrgent: false })
    // The context line carries counts only, never the words.
    expect(h.contextLines().join(' ')).not.toContain('Salam')
    expect(await h.tool().run({ app: 'whatsapp' }, undefined as never)).toContain('Bilal: Call me')
  })
})
