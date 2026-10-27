/**
 * Opening Atlas's page in the browser profile the owner actually uses for
 * it, not just the default one: the Chromium profile (Chrome, Edge, Brave,
 * Comet) whose history visited Atlas most recently. Its history file is
 * copied first (the browser keeps the original open), and the answer is
 * kept for ten minutes. With no such profile, the system's default browser.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { findBrowser } from '../controls.ts'
import { chromiumProfiles } from '../system/habits.ts'
import type { BrowserId } from '../../shared/control.ts'

/** The browsers whose program Atlas can start with a chosen profile. */
const LAUNCHABLE: Record<string, BrowserId> = { chrome: 'chrome', edge: 'msedge', brave: 'brave', comet: 'comet' }

export interface AtlasProfile {
  exe: string
  /** The profile folder ("Default", "Profile 2"). */
  dir: string
  browser: string
}

let kept: { at: number; port: number | string; value: AtlasProfile | null } | null = null

/** The profile that last had Atlas open (http://localhost:<port> or 127.0.0.1, or a brain elsewhere by its address), or null. */
export const atlasProfile = (port: number | string, scratch: string): AtlasProfile | null => {
  const patterns = typeof port === 'number' ? [`http://localhost:${port}/%`, `http://127.0.0.1:${port}/%`] : [`${port}/%`, `${port}/%`]
  if (kept && kept.port === port && Date.now() - kept.at < 10 * 60_000) return kept.value
  let best: { t: number; value: AtlasProfile } | null = null
  mkdirSync(scratch, { recursive: true })
  for (const p of chromiumProfiles()) {
    const id = LAUNCHABLE[p.browserId]
    const exe = id ? findBrowser(id) : undefined
    if (!exe) continue
    const copy = join(scratch, `opener-${p.browserId}-${p.dir.replace(/[^\w-]+/g, '_')}.db`)
    try {
      copyFileSync(p.history, copy)
      const db = new DatabaseSync(copy, { readOnly: true })
      try {
        // Chrome counts microseconds since 1601: read as milliseconds, the number fits.
        const row = db.prepare(`SELECT MAX(last_visit_time) / 1000 AS t FROM urls WHERE url LIKE ? OR url LIKE ?`).get(patterns[0]!, patterns[1]!) as { t: number | null } | undefined
        const t = Number(row?.t ?? 0)
        if (t > 0 && (!best || t > best.t)) best = { t, value: { exe, dir: p.dir, browser: p.browser } }
      } finally {
        db.close()
      }
    } catch {
      // A profile that cannot be read right now: skip it.
    } finally {
      rmSync(copy, { force: true })
    }
  }
  kept = { at: Date.now(), port, value: best?.value ?? null }
  return kept.value
}

/** Opens the address in that profile (a new tab in its window); false when there is none to use. */
export const openInProfile = (url: string, profile: AtlasProfile | null): boolean => {
  if (!profile || process.platform !== 'win32') return false
  try {
    spawn(profile.exe, [`--profile-directory=${profile.dir}`, url], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    return true
  } catch {
    return false
  }
}
