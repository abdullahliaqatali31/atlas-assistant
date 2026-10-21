/**
 * Doing things on the PC for Atlas: open a folder, file or project (Explorer,
 * its own app, VS Code with WSL, the Claude app's Code section, Claude Code,
 * a terminal), start an app, make a folder, a Word document or an Excel
 * sheet. Links and argument lists only, never a shell command line. Never
 * writes over a file, never into Windows, Program Files or AppData.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize } from 'node:path'

import { app, shell } from '../host/index.ts'

import { boldRuns, claudeAppLink, claudeCliLink, markdownBlocks, safeName, vscodeLink, withExt, wslUnc, type DocBlock, type OpenWith, type SheetSpec } from '../../shared/pcactions.ts'
import { openInVsCode } from './vscode.ts'
import { fromWslUnc, isProtectedPath, searchMap, type MapEntry, type SystemMap } from '../../shared/sysmap.ts'

const KNOWN = ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'] as const

const launch = (file: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: false }, err => {
      // explorer.exe exits with 1 even when it opened the app.
      if (err && !/explorer\.exe$/i.test(file)) reject(err)
    })
    child.on('spawn', () => resolve())
    child.on('error', reject)
  })

/** "Report.docx" → "Report (2).docx" until the name is free. */
const freeName = (path: string) => {
  if (!existsSync(path)) return path
  const ext = extname(path)
  const base = path.slice(0, path.length - ext.length)
  for (let i = 2; i < 1000; i++) if (!existsSync(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`
  throw new Error('Too many files with that name there.')
}

export class PcActions {
  constructor(
    private readonly deps: {
      map: () => SystemMap
      foreground: () => Promise<{ title: string; process: string }>
    },
  ) {}

  private entry(idOrName: string, kind?: MapEntry['kind']): MapEntry | null {
    const entries = this.deps.map().entries
    return entries.find(e => e.id === idOrName && (!kind || e.kind === kind)) ?? searchMap(entries, idOrName, kind ?? null, 1)[0] ?? null
  }

  private guard(path: string) {
    if (isProtectedPath(path, homedir())) throw new Error('That is a Windows, program or app-data folder; Atlas does not touch those.')
  }

  /** A place to put things: a map folder or project, Desktop/Documents/…, or a full path. */
  private place(where: string): string {
    const w = where.trim()
    const known = KNOWN.find(k => k === w.toLowerCase())
    let dir: string | null = known ? app.getPath(known) : w.toLowerCase() === 'onedrive' && process.env.OneDrive ? process.env.OneDrive : w.toLowerCase() === 'home' ? homedir() : null
    if (!dir && isAbsolute(w)) dir = normalize(w)
    if (!dir) {
      const e = this.entry(w)
      if (e && e.path && !e.wsl && (e.kind === 'folder' || e.kind === 'project')) dir = e.path
    }
    if (!dir) throw new Error(`Could not tell where "${where}" is. Use a folder from system_find, Desktop, Documents, Downloads, or a full path.`)
    this.guard(dir)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`There is no folder at ${dir}.`)
    return dir
  }

  /** A target to open: a map id, a name in the map, a full path, or a \\wsl.localhost path. */
  private target(t: string): { path: string; wsl: string | null; isDir: boolean; name: string } {
    const raw = t.trim()
    const unc = fromWslUnc(raw)
    if (unc) return { path: unc.path, wsl: unc.wsl, isDir: true, name: basename(unc.path) }
    if (isAbsolute(raw) && /^[a-zA-Z]:\\|^\\\\/.test(raw)) {
      const p = normalize(raw)
      this.guard(p)
      if (!existsSync(p)) throw new Error(`Nothing at ${p}.`)
      return { path: p, wsl: null, isDir: statSync(p).isDirectory(), name: basename(p) }
    }
    const e = this.entry(raw)
    if (!e || !e.path) throw new Error(`Could not find "${t}" on this PC. Try system_find first.`)
    if (!e.wsl) this.guard(e.path)
    return { path: e.path, wsl: e.wsl, isDir: e.wsl ? true : existsSync(e.path) && statSync(e.path).isDirectory(), name: e.name }
  }

  async open(target: string, withApp: OpenWith, prompt: string): Promise<string> {
    const t = this.target(target)
    const where = t.wsl ? `${t.name} (WSL ${t.wsl})` : t.name
    switch (withApp) {
      case 'vscode':
        // Its own window: a project already open in VS Code stays open.
        await openInVsCode(t.path, t.wsl)
        return `Opened ${where} in VS Code${t.wsl ? ' (Remote - WSL)' : ''}, in its own window (projects already open stay open).`
      case 'claude':
        if (!t.isDir) throw new Error('The Claude app opens folders; give the project folder.')
        await shell.openExternal(claudeAppLink(t.wsl ? wslUnc(t.wsl, t.path) : t.path, prompt))
        return `Opened ${where} in the Claude app's Code section${prompt ? ' with your request' : ''}. The app may ask once to trust the folder.`
      case 'claude-code':
        if (t.wsl) {
          await launch('wt.exe', ['wsl.exe', '-d', t.wsl, '--cd', t.path, '--', 'bash', '-lic', 'claude'])
          return `Started Claude Code in ${where} in Windows Terminal.`
        }
        if (!t.isDir) throw new Error('Claude Code starts in a folder; give the project folder.')
        await shell.openExternal(claudeCliLink(t.path, prompt))
        return `Started Claude Code in ${where} in a terminal.`
      case 'terminal':
        if (t.wsl) await launch('wt.exe', ['wsl.exe', '-d', t.wsl, '--cd', t.path])
        else await launch('wt.exe', ['-d', t.isDir ? t.path : dirname(t.path)])
        return `Opened a terminal in ${where}.`
      case 'explorer':
        if (t.wsl) await shell.openPath(wslUnc(t.wsl, t.path))
        else if (t.isDir) await shell.openPath(t.path)
        else shell.showItemInFolder(t.path)
        return `Showed ${where} in File Explorer.`
      default: {
        const err = await shell.openPath(t.wsl ? wslUnc(t.wsl, t.path) : t.path)
        if (err) throw new Error(err)
        return `Opened ${where}.`
      }
    }
  }

  async launch(target: string): Promise<string> {
    const e = this.entry(target, 'app')
    if (!e?.appId) throw new Error(`No app called "${target}" on this PC.`)
    if (/personal assistant|\batlas\b/i.test(e.name)) throw new Error('That is Atlas itself.')
    await launch('explorer.exe', [`shell:AppsFolder\\${e.appId}`])
    return `Started ${e.name}.`
  }

  /** "this project": the window in front, and the map project its title names. */
  async foreground(): Promise<string> {
    const fg = await this.deps.foreground()
    const title = fg.title.slice(0, 200)
    const wsl = /\[WSL: ([^\]]+)\]/.exec(title)?.[1] ?? null
    const projects = this.deps.map().entries.filter(e => e.kind === 'project')
    const match = projects
      .filter(p => title.toLowerCase().includes(p.name.toLowerCase()) && (!wsl || p.wsl?.toLowerCase() === wsl.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0]
    return [`In front: ${fg.process || 'unknown program'} — "${title}"${wsl ? ` (WSL ${wsl})` : ''}.`, match ? `That is the project [${match.id}] "${match.name}"${match.wsl ? ` in WSL ${match.wsl}: ${match.path}` : `: ${match.path}`}.` : 'No project in the system map matches that window.'].join(' ')
  }

  folder(where: string, name: string): string {
    const base = this.place(where)
    const parts = name.split(/[\\/]+/).map(p => safeName(p)).filter(Boolean)
    if (!parts.length) throw new Error('Give the folder a name.')
    const path = join(base, ...parts)
    this.guard(path)
    if (existsSync(path)) return `${path} is already there.`
    mkdirSync(path, { recursive: true })
    return `Made the folder ${path}.`
  }

  async document(where: string, name: string, markdown: string, open: boolean): Promise<string> {
    const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } = await import('docx')
    const path = freeName(withExt(join(this.place(where), safeName(name, 'Document')), '.docx'))
    const runs = (text: string) => boldRuns(text).map(r => new TextRun({ text: r.text, bold: r.bold }))
    const level = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const
    const children = markdownBlocks(markdown).flatMap((b: DocBlock) => {
      switch (b.type) {
        case 'heading':
          return [new Paragraph({ heading: level[b.level], children: runs(b.text) })]
        case 'paragraph':
          return [new Paragraph({ children: runs(b.text), spacing: { after: 120 } })]
        case 'bullets':
          return b.items.map(t => new Paragraph({ bullet: { level: 0 }, children: runs(t) }))
        case 'numbered':
          return b.items.map((t, i) => new Paragraph({ children: [new TextRun(`${i + 1}. `), ...runs(t)] }))
        case 'table':
          return [
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: b.rows.map((r, ri) => new TableRow({ tableHeader: ri === 0, children: r.map(c => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c, bold: ri === 0 })] })] })) })),
            }),
            new Paragraph({ text: '' }),
          ]
      }
    })
    const doc = new Document({ creator: 'Atlas', title: basename(path, '.docx'), sections: [{ children }] })
    writeFileSync(path, await Packer.toBuffer(doc))
    if (open) await shell.openPath(path)
    return `Made ${path}${open ? ' and opened it' : ''}.`
  }

  async sheet(where: string, name: string, sheets: SheetSpec[], open: boolean): Promise<string> {
    const ExcelJS = (await import('exceljs')).default
    const path = freeName(withExt(join(this.place(where), safeName(name, 'Sheet')), '.xlsx'))
    const wb = new ExcelJS.Workbook()
    wb.creator = 'Atlas'
    for (const s of sheets) {
      const ws = wb.addWorksheet(s.name, { views: [{ state: 'frozen', ySplit: 1 }] })
      ws.addRow(s.columns).font = { bold: true }
      for (const r of s.rows) ws.addRow(r)
      if (s.totals && s.rows.length) {
        const numeric = s.columns.map((_, ci) => s.rows.some(r => typeof r[ci] === 'number'))
        const total = ws.addRow(s.columns.map((_, ci) => (ci === 0 && !numeric[0] ? 'Total' : numeric[ci] ? { formula: `SUM(${ws.getColumn(ci + 1).letter}2:${ws.getColumn(ci + 1).letter}${s.rows.length + 1})` } : null)))
        total.font = { bold: true }
      }
      ws.columns.forEach((c, i) => {
        const longest = Math.max(String(s.columns[i] ?? '').length, ...s.rows.slice(0, 200).map(r => String(r[i] ?? '').length))
        c.width = Math.min(60, Math.max(10, longest + 2))
      })
    }
    await wb.xlsx.writeFile(path)
    if (open) await shell.openPath(path)
    return `Made ${path} (${sheets.map(s => `${s.name}: ${s.rows.length} rows`).join(', ')})${open ? ' and opened it' : ''}.`
  }
}
