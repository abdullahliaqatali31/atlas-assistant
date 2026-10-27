/**
 * Atlas on Telegram: the owner's own bot (made with @BotFather) as a second
 * way in. Text and voice notes go to Atlas like typing in the page; replies,
 * reminders, timers and approvals come back. Only the one chat paired with a
 * code is answered.
 */

export const TG = {
  state: 'telegram:state',
  changed: 'telegram:changed',
  setToken: 'telegram:set-token',
  removeToken: 'telegram:remove-token',
  newCode: 'telegram:new-code',
  unpair: 'telegram:unpair',
  setNotify: 'telegram:set-notify',
} as const

/** When Atlas's own notices go to the phone: only while no page shows Atlas, always, or never. */
export const TG_NOTIFY = ['away', 'always', 'off'] as const
export type TelegramNotify = (typeof TG_NOTIFY)[number]

export interface TelegramView {
  /** A bot token is saved (its value never comes back). */
  configured: boolean
  /** The bot's @username, once Telegram confirmed the token. */
  bot: string | null
  running: boolean
  /** The paired chat, if any. */
  paired: { name: string; since: number } | null
  /** Send "/start <code>" to the bot to pair (10 minutes). */
  code: string | null
  codeExpiresAt: number | null
  notify: TelegramNotify
  error: string | null
}

export interface TelegramBridge {
  state(): Promise<TelegramView>
  setToken(token: string): Promise<TelegramView>
  removeToken(): Promise<TelegramView>
  newCode(): Promise<TelegramView>
  unpair(): Promise<TelegramView>
  setNotify(n: TelegramNotify): Promise<TelegramView>
  onChanged(cb: (v: TelegramView) => void): () => void
}

/** "123456789:AA…" as BotFather gives it. */
export const isBotToken = (v: unknown): v is string => typeof v === 'string' && /^\d{5,12}:[\w-]{30,60}$/.test(v.trim())

/** Telegram's limit per message is 4096 characters; long replies go in parts, split at paragraph or line ends. */
export const splitMessage = (text: string, max = 4000): string[] => {
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max)
    if (cut < max / 2) cut = max
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Atlas's Markdown in Telegram's small HTML: bold, italics, code, code
 * blocks and links; headings become bold lines, list markers stay as text.
 * Everything else is escaped, so a reply can never break the message.
 */
export const toTelegramHtml = (md: string): string => {
  const blocks: string[] = []
  // Code blocks first, so nothing inside them is touched.
  let s = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre>`)
    return `\u0000${blocks.length - 1}\u0000`
  })
  s = escapeHtml(s)
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => `<code>${c}</code>`)
  s = s.replace(/^#{1,6}\s+(.+)$/gm, (_m, h: string) => `<b>${h}</b>`)
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`)
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)] ?? '')
}

/** "/start 123456" (or the bare code) → the code, else null. */
export const pairingCodeIn = (text: string): string | null => {
  const m = /^(?:\/start\s+)?(\d{6})$/.exec(text.trim())
  return m ? m[1]! : null
}

export const parseTelegramNotify = (v: unknown): TelegramNotify | null => (TG_NOTIFY.includes(v as TelegramNotify) ? (v as TelegramNotify) : null)
