/**
 * Telegram, the owner's second way in: their own bot (from @BotFather), long
 * polling (no server to open), one paired chat. Text and voice notes go to
 * Atlas as the owner's messages; the reply comes back as one message (with
 * the quick replies as buttons). Approvals arrive with Approve and Deny;
 * reminders, timers and Atlas speaking up arrive while no page shows Atlas
 * (or always, or never: the owner's choice). The token lives in Windows
 * Credential Manager; only its bot name is shown.
 */
import { randomInt } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

import type { ApprovalRequest, ReplyEvent } from '../shared/ipc.ts'
import { isBotToken, pairingCodeIn, parseTelegramNotify, splitMessage, TG, toTelegramHtml, type TelegramNotify, type TelegramView } from '../shared/telegram.ts'

const TOKEN_KEY = 'TELEGRAM_BOT_TOKEN'
const CODE_TTL_MS = 10 * 60_000
const POLL_S = 50
/** Strangers are told once an hour at most that this bot is private. */
const REFUSE_EVERY_MS = 60 * 60_000
const MAX_VOICE = 20 * 1024 * 1024

interface Stored {
  chatId: number | null
  name: string
  since: number
  notify: TelegramNotify
}

interface Secrets {
  get(name: string): string | undefined
  set(name: string, value: string): void
  delete(name: string): void
}

type Update = {
  update_id: number
  message?: { message_id: number; chat: { id: number; type: string }; from?: { first_name?: string; username?: string }; text?: string; voice?: { file_id: string; mime_type?: string; file_size?: number }; audio?: { file_id: string; mime_type?: string; file_size?: number } }
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } }
}

/** A reply on its way to the phone: its text so far, and the typing dots meanwhile. */
interface Pending {
  text: string
  typing: ReturnType<typeof setInterval>
  /** Quick replies that came before the answer was done. */
  options?: string[]
}

export class TelegramChannel {
  private stored: Stored
  private bot: string | null = null
  private running = false
  private abort: AbortController | null = null
  private offset = 0
  private error: string | null = null
  private code: { value: string; expires: number } | null = null
  private readonly refused = new Map<number, number>()
  private readonly pending = new Map<string, Pending>()
  /** Quick replies offered under an answer, by the message they hang on. */
  private readonly offered = new Map<number, string[]>()
  /** The phone message each recent reply became, for the quick replies that follow it. */
  private readonly sent = new Map<string, number>()

  constructor(
    private readonly deps: {
      file: string
      secrets: Secrets
      handle: <T>(channel: string, fn: (a: unknown, b: unknown) => T | Promise<T>) => void
      toRenderer: (channel: string, payload: unknown) => void
      requireOwner: () => void
      /** The owner's message to Atlas: its reply id, or why it cannot go now. */
      send: (text: string) => string
      sendVoice: (audio: Uint8Array, mime: string) => string
      stop: () => void
      answerApproval: (id: string, approved: boolean) => void
      /** A page in a browser shows Atlas right now. */
      pageOpen: () => boolean
      log: (level: 'info' | 'warn', message: string) => void
    },
  ) {
    this.stored = this.load()
  }

  private load(): Stored {
    try {
      const v = JSON.parse(readFileSync(this.deps.file, 'utf8')) as Partial<Stored>
      return { chatId: typeof v.chatId === 'number' ? v.chatId : null, name: typeof v.name === 'string' ? v.name : '', since: typeof v.since === 'number' ? v.since : 0, notify: parseTelegramNotify(v.notify) ?? 'away' }
    } catch {
      return { chatId: null, name: '', since: 0, notify: 'away' }
    }
  }

  private save() {
    try {
      writeFileSync(this.deps.file, JSON.stringify(this.stored, null, 2))
    } catch (e) {
      this.deps.log('warn', `Telegram settings not saved: ${(e as Error).message}`)
    }
  }

  view(): TelegramView {
    if (this.code && this.code.expires < Date.now()) this.code = null
    return {
      configured: Boolean(this.token()),
      bot: this.bot,
      running: this.running,
      paired: this.stored.chatId !== null ? { name: this.stored.name, since: this.stored.since } : null,
      code: this.code?.value ?? null,
      codeExpiresAt: this.code?.expires ?? null,
      notify: this.stored.notify,
      error: this.error,
    }
  }

  private publish() {
    this.deps.toRenderer(TG.changed, this.view())
  }

  private token() {
    return this.deps.secrets.get(TOKEN_KEY)
  }

  // ── Telegram's API ─────────────────────────────────────

  private async api<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal, token = this.token()): Promise<T> {
    if (!token) throw new Error('No Telegram bot token is saved.')
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(20_000),
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number }
    if (!json.ok) {
      const err = new Error(json.description ?? `Telegram answered ${res.status}.`) as Error & { code?: number }
      err.code = json.error_code ?? res.status
      throw err
    }
    return json.result as T
  }

  /** A message to the paired chat in Telegram's HTML; plain text if Telegram cannot read the HTML. */
  private async say(text: string, extra: Record<string, unknown> = {}): Promise<number | null> {
    const chat = this.stored.chatId
    if (chat === null || !text.trim()) return null
    let last: number | null = null
    const parts = splitMessage(text)
    for (const [i, part] of parts.entries()) {
      const markup = i === parts.length - 1 ? extra : {}
      try {
        last = (await this.api<{ message_id: number }>('sendMessage', { chat_id: chat, text: toTelegramHtml(part), parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...markup })).message_id
      } catch {
        last = (await this.api<{ message_id: number }>('sendMessage', { chat_id: chat, text: part, ...markup }).catch(() => null))?.message_id ?? null
      }
    }
    return last
  }

  // ── polling ────────────────────────────────────────────

  async start() {
    if (this.running || !this.token()) return
    try {
      const me = await this.api<{ username: string }>('getMe')
      this.bot = me.username
      this.error = null
    } catch (e) {
      this.error = `Telegram did not accept the token: ${(e as Error).message}`
      this.publish()
      return
    }
    this.running = true
    this.publish()
    void this.poll()
  }

  stop() {
    this.running = false
    this.abort?.abort()
    for (const p of this.pending.values()) clearInterval(p.typing)
    this.pending.clear()
  }

  private async poll() {
    let wait = 2_000
    while (this.running) {
      this.abort = new AbortController()
      try {
        const updates = await this.api<Update[]>('getUpdates', { offset: this.offset, timeout: POLL_S, allowed_updates: ['message', 'callback_query'] }, AbortSignal.any([this.abort.signal, AbortSignal.timeout((POLL_S + 15) * 1000)]))
        wait = 2_000
        if (this.error) {
          this.error = null
          this.publish()
        }
        for (const u of updates) {
          this.offset = u.update_id + 1
          await this.update(u).catch(e => this.deps.log('warn', `Telegram: ${(e as Error).message}`))
        }
      } catch (e) {
        if (!this.running) return
        const code = (e as { code?: number }).code
        if (code === 401 || code === 404) {
          // The token was revoked in BotFather: stop until a new one is saved.
          this.running = false
          this.error = 'Telegram refused the bot token (revoked?). Save a new one.'
          this.publish()
          return
        }
        if (code === 409) this.error = 'Another program is reading this bot (webhook or a second Atlas).'
        await new Promise(r => setTimeout(r, wait))
        wait = Math.min(60_000, wait * 2)
      }
    }
  }

  private async update(u: Update) {
    if (u.callback_query) return this.button(u.callback_query)
    const m = u.message
    if (!m || m.chat.type !== 'private') return
    const chat = m.chat.id
    const text = m.text?.trim() ?? ''

    if (this.stored.chatId === null || this.stored.chatId !== chat) {
      const code = pairingCodeIn(text)
      if (this.stored.chatId === null && this.code && code === this.code.value && this.code.expires > Date.now()) {
        this.code = null
        this.stored = { ...this.stored, chatId: chat, name: m.from?.username ? `@${m.from.username}` : (m.from?.first_name ?? 'Telegram'), since: Date.now() }
        this.save()
        this.publish()
        await this.say('Paired. This chat now reaches Atlas on your PC: write or send a voice note. /stop stops a reply.')
        return
      }
      const last = this.refused.get(chat) ?? 0
      if (Date.now() - last > REFUSE_EVERY_MS) {
        this.refused.set(chat, Date.now())
        await this.api('sendMessage', { chat_id: chat, text: 'This is a private assistant.' }).catch(() => undefined)
      }
      return
    }

    if (text === '/stop') return this.deps.stop()
    if (text === '/start' || text === '/help') {
      await this.say('Write to Atlas here, or send a voice note. /stop stops a reply.')
      return
    }
    const media = m.voice ?? m.audio
    if (media) {
      if ((media.file_size ?? 0) > MAX_VOICE) return void this.say('That recording is too long; keep voice notes under a few minutes.')
      const file = await this.api<{ file_path: string }>('getFile', { file_id: media.file_id })
      const res = await fetch(`https://api.telegram.org/file/bot${this.token()}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`Could not download the voice note (${res.status}).`)
      const audio = new Uint8Array(await res.arrayBuffer())
      return this.ask(() => this.deps.sendVoice(audio, media.mime_type || 'audio/ogg'))
    }
    if (text) return this.ask(() => this.deps.send(text))
  }

  /** Hands a message to Atlas and starts collecting the reply for the phone. */
  private ask(go: () => string) {
    let replyId: string
    try {
      replyId = go()
    } catch (e) {
      return void this.say((e as Error).message)
    }
    this.follow(replyId)
  }

  private follow(replyId: string) {
    const chat = this.stored.chatId
    const typing = setInterval(() => void this.api('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => undefined), 4_500)
    void this.api('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => undefined)
    this.pending.set(replyId, { text: '', typing })
    // Nothing should keep typing forever.
    setTimeout(() => this.finish(replyId), 10 * 60_000).unref?.()
  }

  private async finish(replyId: string, error?: string) {
    const p = this.pending.get(replyId)
    if (!p) return
    this.pending.delete(replyId)
    clearInterval(p.typing)
    const text = p.text.trim() || (error ? `(${error})` : '')
    if (!text) return
    const buttons = p.options?.length ? { reply_markup: { inline_keyboard: p.options.map((o, i) => [{ text: o.slice(0, 60), callback_data: `say:${i}` }]) } } : {}
    const id = await this.say(text, buttons)
    if (id === null) return
    if (p.options?.length) this.offered.set(id, p.options)
    this.sent.set(replyId, id)
    if (this.sent.size > 50) this.sent.delete(this.sent.keys().next().value!)
  }

  private async button(q: NonNullable<Update['callback_query']>) {
    const chat = q.message?.chat.id
    await this.api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => undefined)
    if (chat === undefined || chat !== this.stored.chatId || !q.data) return
    const [kind, a, b] = q.data.split(':')
    if (kind === 'ap' && a) {
      this.deps.answerApproval(a, b === '1')
      await this.api('editMessageReplyMarkup', { chat_id: chat, message_id: q.message!.message_id, reply_markup: { inline_keyboard: [[{ text: b === '1' ? '✅ Approved' : '❌ Denied', callback_data: 'x' }]] } }).catch(() => undefined)
    } else if (kind === 'say' && a !== undefined) {
      const option = this.offered.get(q.message!.message_id)?.[Number(a)]
      if (option) {
        await this.say(`› ${option}`)
        this.ask(() => this.deps.send(option))
      }
    }
  }

  // ── what Atlas sends ───────────────────────────────────

  /** Atlas's own notices go to the phone while no page shows Atlas (or always). */
  private wanted() {
    return this.running && this.stored.chatId !== null && (this.stored.notify === 'always' || (this.stored.notify === 'away' && !this.deps.pageOpen()))
  }

  onReply(e: ReplyEvent) {
    // Atlas speaking up on its own: follow that reply too, when the phone should hear it.
    if (e.type === 'initiative') {
      if (this.wanted() && !this.pending.has(e.replyId)) this.follow(e.replyId)
      return
    }
    // The quick replies come after the answer: they become buttons on the message it became.
    if (e.type === 'suggestions') {
      const early = this.pending.get(e.replyId)
      if (early) {
        if (!e.ended && e.options.length) early.options = e.options.slice(0, 4)
        return
      }
      const id = this.sent.get(e.replyId)
      if (id === undefined || e.ended || !e.options.length) return
      const options = e.options.slice(0, 4)
      this.offered.set(id, options)
      if (this.offered.size > 50) this.offered.delete(this.offered.keys().next().value!)
      void this.api('editMessageReplyMarkup', { chat_id: this.stored.chatId, message_id: id, reply_markup: { inline_keyboard: options.map((o, i) => [{ text: o.slice(0, 60), callback_data: `say:${i}` }]) } }).catch(() => undefined)
      return
    }
    const p = this.pending.get(e.replyId)
    if (!p) return
    if (e.type === 'chunk') p.text += e.text
    else if (e.type === 'done') void this.finish(e.replyId, e.error)
  }

  approval(req: ApprovalRequest) {
    if (!this.running || this.stored.chatId === null || this.stored.notify === 'off') return
    void this.say(`${req.question ?? `Atlas wants to use ${req.tool}.`}\n${req.reason}`, {
      reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: `ap:${req.id}:1` }, { text: 'Deny', callback_data: `ap:${req.id}:0` }]] },
    })
  }

  notice(title: string, text = '') {
    if (this.wanted()) void this.say(`**${title}**${text ? `\n${text}` : ''}`)
  }

  // ── settings ───────────────────────────────────────────

  register() {
    const { handle, requireOwner } = this.deps
    handle(TG.state, () => {
      requireOwner()
      return this.view()
    })
    handle(TG.setToken, async raw => {
      requireOwner()
      const token = typeof raw === 'string' ? raw.trim() : ''
      if (!isBotToken(token)) throw new Error('That does not look like a bot token (123456789:AA…), from @BotFather.')
      const me = await this.api<{ username: string }>('getMe', {}, undefined, token).catch((e: Error) => {
        throw new Error(`Telegram did not accept it: ${e.message}`)
      })
      this.stop()
      this.deps.secrets.set(TOKEN_KEY, token)
      this.bot = me.username
      this.offset = 0
      await this.start()
      return this.view()
    })
    handle(TG.removeToken, () => {
      requireOwner()
      this.stop()
      this.deps.secrets.delete(TOKEN_KEY)
      this.bot = null
      this.stored = { ...this.stored, chatId: null, name: '', since: 0 }
      this.save()
      this.publish()
      return this.view()
    })
    handle(TG.newCode, () => {
      requireOwner()
      if (!this.running) throw new Error('Save the bot token first.')
      this.code = { value: String(randomInt(0, 1_000_000)).padStart(6, '0'), expires: Date.now() + CODE_TTL_MS }
      this.publish()
      return this.view()
    })
    handle(TG.unpair, () => {
      requireOwner()
      this.stored = { ...this.stored, chatId: null, name: '', since: 0 }
      this.save()
      this.publish()
      return this.view()
    })
    handle(TG.setNotify, n => {
      requireOwner()
      const v = parseTelegramNotify(n)
      if (!v) throw new Error('Choose away, always or off.')
      this.stored = { ...this.stored, notify: v }
      this.save()
      this.publish()
      return this.view()
    })
  }
}
