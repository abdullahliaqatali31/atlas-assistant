import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, describe, expect, it, vi } from 'vitest'

import { claudeAppLink, markdownBlocks, parseSheets, safeName, vscodeLink } from '../../shared/pcactions.ts'
import type { MapEntry } from '../../shared/sysmap.ts'

// Not under AppData (Atlas refuses to write there, as tested below): a folder beside the repo's files, removed after.
const dir = mkdtempSync(join(process.cwd(), '.atlas-make-'))
const opened: string[] = []
vi.mock('electron', () => ({
  app: { getPath: (k: string) => join(dir, k) },
  shell: { openPath: async (p: string) => (opened.push(p), ''), openExternal: async (u: string) => void opened.push(u), showItemInFolder: (p: string) => void opened.push(p) },
}))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const entry = (kind: MapEntry['kind'], name: string, path: string | null, extra: Partial<MapEntry> = {}): MapEntry => ({ id: `${kind[0]}-${name}`, kind, name, path, wsl: null, appId: null, source: 'scan', usedAt: 0, ...extra })

describe('PC actions, the pure half', () => {
  it('reads the Markdown Atlas writes into document blocks', () => {
    expect(markdownBlocks('# Plan\n\nIntro line one\nline two\n\n- a\n- b\n\n1. x\n2. y\n\n| Item | Cost |\n|---|---|\n| Tea | 200 |')).toEqual([
      { type: 'heading', level: 1, text: 'Plan' },
      { type: 'paragraph', text: 'Intro line one line two' },
      { type: 'bullets', items: ['a', 'b'] },
      { type: 'numbered', items: ['x', 'y'] },
      { type: 'table', rows: [['Item', 'Cost'], ['Tea', '200']] },
    ])
  })

  it('checks sheets and names', () => {
    expect(parseSheets([])).toMatch(/at least one/)
    expect(parseSheets([{ name: 'a/b:c', columns: ['Item', 'Cost'], rows: [['Tea', 200, 'extra']], totals: true }])).toEqual([{ name: 'a b c', columns: ['Item', 'Cost'], rows: [['Tea', 200]], totals: true }])
    expect(safeName('  Q3: report?. ')).toBe('Q3 report')
  })

  it('builds links that need no shell', () => {
    expect(vscodeLink('C:\\Users\\A\\My Project', null)).toBe('vscode://file/C:/Users/A/My%20Project')
    expect(vscodeLink('/home/a/atlas', 'Ubuntu')).toBe('vscode://vscode-remote/wsl+Ubuntu/home/a/atlas')
    expect(claudeAppLink('C:\\p', 'fix the tests')).toBe('claude://code/new?folder=C%3A%5Cp&q=fix%20the%20tests')
  })
})

describe('PC actions, doing', async () => {
  const { PcActions } = await import('./actions.ts')
  const docs = join(dir, 'documents')
  mkdirSync(docs, { recursive: true })
  const map = { builtAt: 1, entries: [entry('project', 'atlas', '/home/a/atlas', { wsl: 'Ubuntu' }), entry('folder', 'Invoices', docs), entry('app', 'WhatsApp', null, { appId: 'W!App' })] }
  const pc = new PcActions({ map: () => map, foreground: async () => ({ title: 'index.ts - atlas [WSL: Ubuntu] - Visual Studio Code', process: 'Code' }) })

  it('makes folders, documents and sheets that open, never overwriting', async () => {
    expect(pc.folder('documents', 'Clients/2026')).toMatch(/Made the folder/)
    expect(existsSync(join(docs, 'Clients', '2026'))).toBe(true)
    const a = await pc.document('Invoices', 'Plan', '# Plan\n\n- **one**\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |', true)
    const b = await pc.document('Invoices', 'Plan', 'Again', false)
    expect(a).toContain('Plan.docx')
    expect(b).toContain('Plan (2).docx')
    const mammoth = await import('mammoth')
    const text = (await mammoth.extractRawText({ path: join(docs, 'Plan.docx') })).value
    expect(text).toContain('Plan')
    expect(text).toContain('one')
    const sheets = parseSheets([{ name: 'Costs', columns: ['Item', 'PKR'], rows: [['Tea', 200], ['Milk', 350]], totals: true }])
    if (typeof sheets === 'string') throw new Error(sheets)
    expect(await pc.sheet('documents', 'Budget', sheets, false)).toContain('Costs: 2 rows')
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(join(docs, 'Budget.xlsx'))
    expect(wb.getWorksheet('Costs')?.getCell('B4').value).toMatchObject({ formula: 'SUM(B2:B3)' })
    expect(opened).toContain(join(docs, 'Plan.docx'))
    // The Word and Excel libraries load slowly the first time, more so while the whole suite runs.
  }, 90_000)

  it('opens WSL projects in VS Code and the Claude app, and knows "this project"', async () => {
    expect(await pc.open('atlas', 'vscode', '')).toMatch(/VS Code \(Remote - WSL\)/)
    expect(opened.at(-1)).toBe('vscode://vscode-remote/wsl+Ubuntu/home/a/atlas')
    await pc.open('p-atlas', 'claude', '')
    expect(opened.at(-1)).toBe(`claude://code/new?folder=${encodeURIComponent('\\\\wsl.localhost\\Ubuntu\\home\\a\\atlas')}`)
    expect(await pc.foreground()).toContain('[p-atlas] "atlas" in WSL Ubuntu')
  })

  it('refuses Windows and program folders, and unknown places', async () => {
    expect(() => pc.folder('C:\\Windows', 'x')).toThrow(/does not touch/)
    expect(() => pc.folder('nowhere-at-all', 'x')).toThrow(/Could not tell where/)
    await expect(pc.open('C:\\Program Files\\App', 'default', '')).rejects.toThrow(/does not touch/)
  })
})
