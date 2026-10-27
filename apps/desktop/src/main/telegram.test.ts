import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TG, type TelegramView } from '../shared/telegram.ts'
import { TelegramChannel } from './telegram.ts'

const TOKEN = '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1'

/** A fake Telegram: getUpdates hands out what the test queued (then waits), everything else is recorded. */
const fakeTelegram = () => {
  const sent: { method: string; body: Record<string, unknown> }[] = []
  const queue: unknown[][] = []
  let wake: (() => void) | null = null
  const push = (...updates: unknown[]) => {
    queue.push(updates)
    wake?.()
  }
  vi.stubGlobal('fetch', async (url: string, init: { body: string; signal?: AbortSignal }) => {
    const method = url.split('/').pop()!
    const body = JSON.parse(init.body) as Record<string, unknown>
    if (method === 'getMe') return Response.json({ ok: true, result: { username: 'atlas_test_bot' } })
    if (method === 'getUpdates') {
      if (!queue.length)
        await new Promise<void>((r, reject) => {
          wake = r
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      return Response.json({ ok: true, result: queue.shift() ?? [] })
    }
    sent.push({ method, body })
    return Response.json({ ok: true, result: { message_id: sent.length } })
  })
  return { sent, push }
}

let dir = ''
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'atlas-tg-'))))
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

const setup = () => {
  const tg = fakeTelegram()
  const secrets = new Map<string, string>()
  const asked: string[] = []
  const handlers = new Map<string, (a: unknown, b: unknown) => unknown>()
  const ch = new TelegramChannel({
    file: join(dir, 'telegram.json'),
    secrets: { get: k => secrets.get(k), set: (k, v) => void secrets.set(k, v), delete: k => void secrets.delete(k) },
    handle: (c, fn) => void handlers.set(c, fn as (a: unknown, b: unknown) => unknown),
    toRenderer: () => undefined,
    requireOwner: () => undefined,
    send: text => (asked.push(text), `r${asked.length}`),
    sendVoice: () => 'v1',
    stop: () => undefined,
    answerApproval: () => undefined,
    pageOpen: () => false,
    log: () => undefined,
  })
  ch.register()
  const call = (c: string, a?: unknown) => handlers.get(c)!(a, undefined) as Promise<TelegramView> | TelegramView
  const settle = () => new Promise(r => setTimeout(r, 30))
  const msg = (id: number, chat: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: chat, type: 'private' }, from: { username: 'owner' }, text } })
  return { ch, tg, asked, call, settle, msg }
}

describe('telegram channel', () => {
  it('pairs with the code, refuses strangers, and carries messages and replies', async () => {
    const { ch, tg, asked, call, settle, msg } = setup()
    const v = await call(TG.setToken, TOKEN)
    expect(v.bot).toBe('atlas_test_bot')
    const { code } = (await call(TG.newCode)) as TelegramView
    tg.push(msg(1, 555, 'hello'))
    await settle()
    expect(tg.sent.at(-1)?.body).toMatchObject({ chat_id: 555, text: 'This is a private assistant.' })
    expect(asked).toEqual([])

    tg.push(msg(2, 777, `/start ${code}`))
    await settle()
    expect(((await call(TG.state)) as TelegramView).paired?.name).toBe('@owner')

    tg.push(msg(3, 777, 'kal ka plan?'))
    await settle()
    expect(asked).toEqual(['kal ka plan?'])
    ch.onReply({ replyId: 'r1', type: 'chunk', text: 'Kal **10 baje** meeting hai.' })
    ch.onReply({ replyId: 'r1', type: 'done', stopped: false })
    await settle()
    const answer = tg.sent.filter(s => s.method === 'sendMessage').at(-1)!
    expect(answer.body).toMatchObject({ chat_id: 777, text: 'Kal <b>10 baje</b> meeting hai.', parse_mode: 'HTML' })

    // A stranger still gets nothing from Atlas.
    tg.push(msg(4, 555, 'kal ka plan?'))
    await settle()
    expect(asked).toHaveLength(1)
    ch.stop()
  })

  it('sends approvals with buttons, and notices only while no page is open', async () => {
    const { ch, tg, call, settle, msg } = setup()
    await call(TG.setToken, TOKEN)
    const { code } = (await call(TG.newCode)) as TelegramView
    tg.push(msg(1, 777, `/start ${code}`))
    await settle()
    ch.approval({ id: 'a1', tool: 'whatsapp_send', actionClass: 'external-send', input: '{}', reason: 'Sends a message', question: 'Bilal ko bhej doon?' })
    ch.notice('Reminder', 'Call the bank')
    await settle()
    const [approval, notice] = tg.sent.filter(s => s.method === 'sendMessage').slice(-2)
    expect(approval!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Approve', callback_data: 'ap:a1:1' }, { text: 'Deny', callback_data: 'ap:a1:0' }]] })
    expect(notice!.body.text).toBe('<b>Reminder</b>\nCall the bank')
    ch.stop()
  })
})
