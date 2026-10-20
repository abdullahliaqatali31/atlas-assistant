/**
 * Windows notifications Atlas may see once the owner turns it on: the toasts
 * apps show (WhatsApp, Teams, Webex, Outlook, Windows itself…), read on this
 * PC from Windows' own notification list. Their text is someone else's words,
 * so it is always treated as untrusted.
 */

export interface PcNotification {
  /** Windows' own number for it (rises with each new one). */
  id: number
  /** A friendly app name ("WhatsApp"). */
  app: string
  /** The first line: for chat apps, who wrote (or the group). */
  title: string
  /** The rest of the text. */
  body: string
  at: number
}

export interface NotificationsView {
  enabled: boolean
  /** Seen since the app started. */
  seen: number
  lastAt: number | null
  /** Why reading failed, if it did. */
  error: string | null
}

const KNOWN: [RegExp, string][] = [
  [/whatsapp/i, 'WhatsApp'],
  [/msteams|teams/i, 'Teams'],
  [/webex|cisco/i, 'Webex'],
  [/outlook|microsoft\.office\.outlook|windowscommunicationsapps/i, 'Outlook'],
  [/slack/i, 'Slack'],
  [/telegram/i, 'Telegram'],
  [/signal/i, 'Signal'],
  [/discord/i, 'Discord'],
  [/zoom/i, 'Zoom'],
  [/skype/i, 'Skype'],
  [/messenger|facebook/i, 'Messenger'],
  [/instagram/i, 'Instagram'],
  [/yourphone|phonelink/i, 'Phone Link'],
  [/chrome/i, 'Chrome'],
  [/msedge|microsoftedge/i, 'Edge'],
  [/securitycenter|defender/i, 'Windows Security'],
  [/immersivecontrolpanel|windows\.systemtoast|windowsupdate/i, 'Windows'],
  [/skydrive|onedrive/i, 'OneDrive'],
  [/todos/i, 'Microsoft To Do'],
  [/claude/i, 'Claude'],
  [/openai|chatgpt|codex/i, 'ChatGPT'],
]

/** "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App" → "WhatsApp"; unknown ids give their readable middle part. */
export const appName = (appId: string): string => {
  for (const [re, name] of KNOWN) if (re.test(appId)) return name
  const core = appId.split('!')[0]!.split('_')[0]!
  const parts = core.split('.').filter(p => p && !/^[0-9A-F]{6,}$/i.test(p) && !/^(com|org|net|microsoft|windows)$/i.test(p))
  return (parts[parts.length - 1] ?? core).replace(/([a-z])([A-Z])/g, '$1 $2').slice(0, 40) || 'An app'
}

/** Apps where a notification is a person writing to the owner. */
export const MESSAGING_APPS: ReadonlySet<string> = new Set(['WhatsApp', 'Teams', 'Webex', 'Slack', 'Telegram', 'Signal', 'Discord', 'Messenger', 'Instagram', 'Skype', 'Phone Link', 'Outlook'])

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    }
    return ENTITIES[e.toLowerCase()] ?? ''
  })

/** A toast's XML → its first line and the rest (attribution lines, like "via WhatsApp", left out). */
export const parseToast = (xml: string): { title: string; body: string } => {
  const lines: string[] = []
  for (const m of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    if (/placement\s*=\s*["']attribution["']/i.test(m[1] ?? '')) continue
    const t = decode((m[2] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
    if (t) lines.push(t)
  }
  return { title: (lines[0] ?? '').slice(0, 120), body: lines.slice(1).join(' · ').slice(0, 600) }
}

/** People whose messages should reach the owner at once, going by what Atlas remembers of them. */
const IMPORTANT = /\b(client|customer|boss|manager|lead|ceo|cto|founder|investor|wife|husband|mother|mom|mum|father|dad|family|brother|sister|doctor|urgent|important|vip)\b/i

/** Whether a memory about this sender marks them as someone who matters (a client, family…). */
export const isImportantSender = (sender: string, memories: readonly string[]): boolean => {
  const name = sender.trim().toLowerCase()
  if (name.length < 2) return false
  return memories.some(m => m.toLowerCase().includes(name) && IMPORTANT.test(m))
}
