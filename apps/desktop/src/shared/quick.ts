/**
 * Things answered at once, without the model: the time, the date, stop,
 * modes, pausing automation, louder or quieter. Exact short phrases only
 * (English and Roman Urdu); anything longer or unclear goes to the model as
 * usual. Instant, free and works offline.
 */
import type { UiMode } from './ipc.ts'
import type { View } from './ui.ts'

export type QuickAction =
  | { kind: 'stop' }
  | { kind: 'mode'; mode: UiMode }
  | { kind: 'pause'; on: boolean }
  | { kind: 'volume'; dir: 'up' | 'down' }
  | { kind: 'open'; view: View }
  | { kind: 'timer'; minutes: number }

export interface QuickAnswer {
  /** What Atlas says; empty for a silent action (stop). */
  reply: string
  action?: QuickAction
}

const norm = (text: string, names: string[]) => {
  let t = text
    .toLowerCase()
    .replace(/[“”"'’.,!?؟]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // "Atlas, what time is it" / "zara kitne baje hain": the name in front is just a call.
  for (const n of names) if (n && t.startsWith(`${n.toLowerCase()} `)) t = t.slice(n.length + 1).trim()
  return t.replace(/\s+(please|plz|jaldi|zara|na|yaar)$/, '').trim()
}

const TIME = /^(what( s| is)? (the )?time( is it)?( now)?|time( kya)?( hai| hua)?( please)?|kitne baje (hain|hai|hue|ho gaye)|kya time (hai|hua|ho gaya)|abhi kya time hai|time batao)$/
const DATE = /^(what( s| is)? (the |today s )?date( today)?|what day is (it|today)|aaj (kya|ki|kaun si) (date|tareekh|tarikh)( hai)?|aaj kaun ?sa din hai|aaj kya din hai|date batao)$/
const STOP = /^(stop|stop it|stop talking|bas|bas karo|ruk jao|ruko|chup|chup karo|chup ho jao|be quiet|shut up|enough|cancel)$/
const PAUSE = /^((pause|stop) (all )?automation|sab (automation )?(band|rok) (karo|do)|automation (band|rok) (karo|do))$/
const RESUME = /^(resume|continue) automation|automation (shuru|chalu|wapas) (karo|kar do)$/
const LOUDER = /^(louder|speak louder|volume up|awaz (tez|unchi|bari|zyada|ooncha) karo|zor se bolo|thora (zor|tez) se bolo)$/
const QUIETER = /^(quieter|speak softer|volume down|awaz (kam|halki|dheemi|neeche) karo|aahista bolo|dheere bolo)$/
const MODE = /^(?:switch to |go to |turn on )?(quiet|focus|companion|work) mode(?: on| karo| kar do| lagao)?$|^(quiet|focus|companion|work) (?:ho jao|pe jao|par jao)$/

/** Page names as people say them → the page. */
const PAGES: [RegExp, View, string][] = [
  [/^(?:the )?(?:world )?map$|^world$|^duniya(?: ka naqsha)?$|^naqsha$/, 'world', 'the World map'],
  [/^(?:the )?news$|^khabrein$|^khabron$/, 'news', 'the news'],
  [/^(?:the |your )?browser$/, 'browser', 'my browser'],
  [/^(?:the )?(?:home|brain|mind)(?: page)?$/, 'home', 'home'],
  [/^(?:the )?settings$|^setup$/, 'setup', 'Settings'],
  [/^(?:my )?(?:today|tasks|to ?do(?: list)?)$/, 'today', 'today'],
  [/^(?:my )?(?:profiles|browsing habits)$/, 'habits', 'your profiles'],
  [/^(?:the )?(?:learning|skills)$/, 'learning', 'Learning'],
  [/^(?:my )?files$/, 'files', 'your files'],
  [/^(?:my )?(?:code|projects|code projects)$/, 'projects', 'your projects'],
  [/^(?:the )?alerts$/, 'alerts', 'the alerts'],
]
const OPEN_EN = /^(?:open|show|show me|go to|take me to)\s+(.+?)(?:\s+page)?$/
const OPEN_UR = /^(?:mujhe\s+)?(.+?)(?:\s+(?:wala|ka))?(?:\s+page)?\s+(?:kholo|khol do|dikhao|dikha do|open karo|open kar do|pe jao|par jao|mein jao)$/
const NUM: Record<string, number> = { ek: 1, one: 1, do: 2, two: 2, teen: 3, three: 3, char: 4, chaar: 4, four: 4, paanch: 5, panch: 5, five: 5, das: 10, ten: 10, pandrah: 15, fifteen: 15, bees: 20, twenty: 20, tees: 30, thirty: 30, aadha: 0.5, half: 0.5 }
const TIMER = /^(?:set (?:a |an )?)?(\d+(?:\.\d+)?|[a-z]+) (minute|minutes|min|mins|minat|ghanta|ghante|hour|hours|second|seconds|sec|secs) (?:ka |ki |for )?timer(?: (?:lagao|laga do|set karo|set kar do|chalao|start karo))?$|^timer (?:for |of )?(\d+(?:\.\d+)?|[a-z]+) (minute|minutes|min|mins|hour|hours|second|seconds)$/

const pad = (n: number) => String(n).padStart(2, '0')

export const quickAnswer = (text: string, opts: { now: number; names: string[]; urdu: boolean }): QuickAnswer | null => {
  if (text.length > 80) return null
  const t = norm(text, opts.names)
  if (!t) return null
  const d = new Date(opts.now)
  if (TIME.test(t)) {
    const h = d.getHours()
    const clock = `${((h + 11) % 12) + 1}:${pad(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`
    return { reply: opts.urdu ? `Abhi ${clock} baje hain.` : `It's ${clock}.` }
  }
  if (DATE.test(t)) {
    const day = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    return { reply: opts.urdu ? `Aaj ${day} hai.` : `Today is ${day}.` }
  }
  if (STOP.test(t)) return { reply: '', action: { kind: 'stop' } }
  if (PAUSE.test(t)) return { reply: opts.urdu ? 'Theek hai, sab automation ruk gayi.' : 'Done: all automation is paused.', action: { kind: 'pause', on: true } }
  if (RESUME.test(t)) return { reply: opts.urdu ? 'Automation phir se chalu.' : 'Automation is back on.', action: { kind: 'pause', on: false } }
  if (LOUDER.test(t)) return { reply: opts.urdu ? 'Theek hai, ab zor se.' : 'Louder now.', action: { kind: 'volume', dir: 'up' } }
  if (QUIETER.test(t)) return { reply: opts.urdu ? 'Theek hai, ab aahista.' : 'Softer now.', action: { kind: 'volume', dir: 'down' } }
  const open = OPEN_EN.exec(t) ?? OPEN_UR.exec(t)
  if (open) {
    const page = PAGES.find(([re]) => re.test(open[1]!.trim()))
    if (page) return { reply: opts.urdu ? `Lo, ${page[2]}.` : `Here is ${page[2]}.`, action: { kind: 'open', view: page[1] } }
  }
  const tm = TIMER.exec(t)
  if (tm) {
    const n = tm[1] ?? tm[3]!
    const unit = tm[2] ?? tm[4]!
    const count = /^\d/.test(n) ? Number(n) : NUM[n]
    if (count !== undefined && count > 0) {
      const minutes = /^(ghant|hour)/.test(unit) ? count * 60 : /^sec/.test(unit) ? count / 60 : count
      if (minutes > 0 && minutes <= 24 * 60) {
        const said = minutes >= 60 ? `${minutes / 60} ${opts.urdu ? 'ghante' : minutes === 60 ? 'hour' : 'hours'}` : minutes < 1 ? `${Math.round(minutes * 60)} ${opts.urdu ? 'second' : 'seconds'}` : `${minutes} ${opts.urdu ? 'minute' : minutes === 1 ? 'minute' : 'minutes'}`
        return { reply: opts.urdu ? `${said} ka timer laga diya.` : `Timer set for ${said}.`, action: { kind: 'timer', minutes } }
      }
    }
  }
  const m = MODE.exec(t)
  if (m) {
    const mode = (m[1] ?? m[2]) as UiMode
    const said: Record<string, string> = {
      quiet: opts.urdu ? 'Quiet mode: main sirf likh kar bataunga.' : 'Quiet mode: I will only write, not speak.',
      focus: opts.urdu ? 'Focus mode: sirf zaroori cheezein.' : 'Focus mode: only what matters.',
      companion: opts.urdu ? 'Companion mode, main yahin hoon.' : 'Companion mode: I am here.',
      work: opts.urdu ? 'Work mode on.' : 'Work mode on.',
    }
    return { reply: said[mode] ?? 'Done.', action: { kind: 'mode', mode } }
  }
  return null
}
