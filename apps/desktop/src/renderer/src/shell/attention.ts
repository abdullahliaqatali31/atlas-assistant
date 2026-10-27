/**
 * Bringing this tab back when Atlas needs the owner and the tab is behind
 * other windows: a page cannot raise its own tab, but a notice from the
 * browser can (clicking it focuses the tab), and the tab's title can blink.
 * Notices need the browser's permission, asked once from a click
 * (Settings › Appearance) and remembered by the browser.
 */
const KEY = 'atlas.notices'

/** The owner turned browser notices on (and the browser allows them). */
export const noticesOn = () => {
  try {
    return typeof Notification !== 'undefined' && Notification.permission === 'granted' && localStorage.getItem(KEY) !== 'off'
  } catch {
    return false
  }
}

/** Asks the browser (from a click) and remembers the owner's choice; true when notices can show. */
export const setNotices = async (on: boolean): Promise<boolean> => {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    // Remembered for this visit only.
  }
  if (!on || typeof Notification === 'undefined') return false
  if (Notification.permission === 'default') await Notification.requestPermission()
  return Notification.permission === 'granted'
}

const away = () => document.hidden || !document.hasFocus()

/** A notice that brings this tab forward when clicked; only while the tab is out of sight. */
export const pageNotice = (title: string, body: string, tag = 'atlas') => {
  if (!away() || !noticesOn()) return
  try {
    const n = new Notification(title, { body, tag, icon: '/favicon.ico' })
    n.onclick = () => {
      window.focus()
      n.close()
    }
  } catch {
    // Some browsers allow notices only from a service worker: the blinking title still shows.
  }
}

let blinking: number | null = null

/** The tab's title blinks until the owner comes back to it. */
const blinkTitle = (text: string) => {
  if (blinking !== null || !away()) return
  const original = document.title
  let on = false
  blinking = window.setInterval(() => {
    on = !on
    document.title = on ? text : original
  }, 900)
  const back = () => {
    if (away()) return
    if (blinking !== null) window.clearInterval(blinking)
    blinking = null
    document.title = original
    window.removeEventListener('focus', back)
    document.removeEventListener('visibilitychange', back)
  }
  window.addEventListener('focus', back)
  document.addEventListener('visibilitychange', back)
}

/** Someone asked to see Atlas (the tray, a shortcut, the atlas command) while this page is open. */
export const callAttention = (name: string) => {
  blinkTitle(`● ${name} is here`)
  pageNotice(name, `${name} is open here. Click to come back to it.`, 'atlas-here')
}

/** Atlas spoke up on its own while this tab is out of sight. */
export const speakUpNotice = (name: string, text: string) => {
  blinkTitle(`● ${name}: ${text.slice(0, 40)}`)
  pageNotice(name, text, 'atlas-speak-up')
}
