/**
 * Live check of the system map on this PC (opt-in: ATLAS_LIVE=1). Builds the
 * real map from the owner's folders, editors, Claude Code and running WSL
 * distros into a temporary file and reports counts and time only.
 *   ATLAS_LIVE=1 pnpm vitest run apps/desktop/src/main/system/sysmap.live.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { searchMap } from '../../shared/sysmap.ts'

const live = !!process.env.ATLAS_LIVE

vi.mock('electron', () => ({
  app: {
    getPath: (k: string) => join(homedir(), { desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', pictures: 'Pictures', music: 'Music', videos: 'Videos' }[k] ?? k),
  },
}))

describe.skipIf(!live)('system map on this PC', () => {
  it('builds within the time budget and finds this project', async () => {
    const { SystemMapService } = await import('./sysmap.ts')
    const dir = mkdtempSync(join(tmpdir(), 'atlas-map-'))
    const logs: string[] = []
    const svc = new SystemMapService({
      file: join(dir, 'sysmap.json'),
      apps: async () => [{ name: 'WhatsApp', id: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' }],
      codeProjects: () => [],
      log: (_l, m) => logs.push(m),
      onChange: () => {},
    })
    const t0 = Date.now()
    svc.setEnabled(true)
    await new Promise(r => setTimeout(r, 50))
    await svc.build()
    const ms = Date.now() - t0
    const { counts } = svc.view()
    console.log(`map: ${counts.apps} apps, ${counts.projects} projects (${svc.map.entries.filter(e => e.wsl).length} in WSL), ${counts.folders} folders in ${Math.round(ms / 1000)} s`)
    expect(ms).toBeLessThan(60_000)
    expect(counts.projects).toBeGreaterThan(0)
    expect(searchMap(svc.map.entries, 'voice assistent project').length).toBeGreaterThan(0)
    svc.stop()
    rmSync(dir, { recursive: true, force: true })
  }, 120_000)
})
