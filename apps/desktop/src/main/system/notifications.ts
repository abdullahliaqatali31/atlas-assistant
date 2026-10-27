/**
 * Watches Windows notifications once the owner turns it on. Windows keeps
 * every toast (WhatsApp, Teams, Webex, Outlook, its own…) in a small SQLite
 * file in the owner's profile; when that file changes, a copy is read
 * (read-only, never the original) for toasts newer than the last one seen.
 * Nothing leaves the PC: the text goes to Atlas's runtime here, marked as
 * someone else's words.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { appName, parseToast, type NotificationsView, type PcNotification } from '../../shared/notifications.ts'

/** Each change is read at most this often (Windows writes the file in bursts). */
const SETTLE_MS = 500
/** A slow check too, in case a change was missed. */
const POLL_MS = 20_000
/** On turning on, toasts this recent are passed on as background (never spoken). */
const BACKLOG_MS = 3 * 60 * 60_000
const MAX_BATCH = 40

/** Windows FILETIME (100 ns since 1601) → ms since 1970, done in SQL so it stays a small number. */
const QUERY = `SELECT n."Order" AS o, h.PrimaryId AS app, n.Payload AS payload, (n.ArrivalTime / 10000 - 11644473600000) AS at
  FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId
  WHERE n.Type = 'toast' AND n."Order" > ? ORDER BY n."Order" DESC LIMIT ${MAX_BATCH}`

interface Row {
  o: number
  app: string
  payload: Uint8Array | string | null
  at: number
}

export class NotificationWatcher {
  private enabled: boolean
  private last = -1
  private seen = 0
  private lastAt: number | null = null
  private error: string | null = null
  private watcher: FSWatcher | null = null
  private poll: NodeJS.Timeout | null = null
  private settle: NodeJS.Timeout | null = null
  private readonly source: string

  constructor(
    private readonly deps: {
      /** Where the on/off choice is kept. */
      file: string
      /** A folder of Atlas's own for the copy it reads. */
      cacheDir: string
      /** New notifications; `fresh` is false for the background passed on when turned on. */
      onNew: (items: PcNotification[], fresh: boolean) => void
      onChange: () => void
      log: (level: 'info' | 'warn', message: string) => void
    },
  ) {
    this.source = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Notifications')
    try {
      this.enabled = (JSON.parse(readFileSync(deps.file, 'utf8')) as { enabled?: unknown }).enabled === true
    } catch {
      this.enabled = false
    }
    // After the app has finished wiring itself up (onChange may use things made after this).
    if (this.enabled) setTimeout(() => this.start(), 0)
  }

  view(): NotificationsView {
    return { enabled: this.enabled, seen: this.seen, lastAt: this.lastAt, error: this.error }
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return
    this.enabled = on
    try {
      writeFileSync(this.deps.file, JSON.stringify({ enabled: on }))
    } catch (e) {
      this.deps.log('warn', `Could not save the notifications setting: ${String(e)}`)
    }
    if (on) this.start()
    else this.stop()
    this.deps.onChange()
  }

  private start() {
    if (process.platform !== 'win32') {
      this.error = 'Windows only.'
      return
    }
    this.last = -1
    this.read()
    try {
      this.watcher = watch(this.source, () => this.soon())
      this.watcher.on('error', () => undefined)
    } catch (e) {
      this.deps.log('warn', `Cannot watch notifications: ${String(e)}`)
    }
    this.poll = setInterval(() => this.read(), POLL_MS)
    this.poll.unref()
  }

  private stop() {
    this.watcher?.close()
    this.watcher = null
    if (this.poll) clearInterval(this.poll)
    if (this.settle) clearTimeout(this.settle)
    this.poll = this.settle = null
  }

  private soon() {
    if (this.settle) return
    this.settle = setTimeout(() => {
      this.settle = null
      this.read()
    }, SETTLE_MS)
  }

  /** Copy Windows' list (with its journal) and read toasts newer than the last seen. */
  private read() {
    if (!this.enabled) return
    let db: DatabaseSync | null = null
    try {
      const src = join(this.source, 'wpndatabase.db')
      if (!existsSync(src)) throw new Error('Windows has no notification list here.')
      mkdirSync(this.deps.cacheDir, { recursive: true })
      const copy = join(this.deps.cacheDir, 'wpn.db')
      copyFileSync(src, copy)
      for (const ext of ['-wal', '-shm']) {
        if (existsSync(src + ext)) copyFileSync(src + ext, copy + ext)
        else if (existsSync(copy + ext)) writeFileSync(copy + ext, '')
      }
      db = new DatabaseSync(copy, { readOnly: true })
      const first = this.last < 0
      const rows = db.prepare(QUERY).all(first ? 0 : this.last) as unknown as Row[]
      if (this.error) {
        this.error = null
        this.deps.onChange()
      }
      if (!rows.length) {
        if (first) this.last = 0
        return
      }
      this.last = Math.max(this.last, ...rows.map(r => Number(r.o)))
      const now = Date.now()
      const items = rows
        .reverse()
        .filter(r => !first || now - Number(r.at) < BACKLOG_MS)
        .map((r): PcNotification | null => {
          const xml = typeof r.payload === 'string' ? r.payload : r.payload ? Buffer.from(r.payload).toString('utf8') : ''
          const { title, body } = parseToast(xml)
          return title || body ? { id: Number(r.o), app: appName(r.app), title, body, at: Number(r.at) } : null
        })
        .filter((x): x is PcNotification => x !== null)
      if (!items.length) return
      this.seen += first ? 0 : items.length
      this.lastAt = items[items.length - 1]!.at
      this.deps.onNew(items, !first)
      this.deps.onChange()
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      // A copy taken mid-write can be torn: the next change reads it again.
      if (why !== this.error) {
        this.error = why
        this.deps.log('warn', `Reading notifications failed: ${why}`)
        this.deps.onChange()
      }
    } finally {
      db?.close()
    }
  }
}
