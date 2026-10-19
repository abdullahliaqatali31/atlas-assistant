/**
 * Opening and making things on the PC: the pure half (what a request means,
 * where things go, how a document is laid out). Main does the doing.
 */

export const OPEN_WITH = ['default', 'explorer', 'vscode', 'claude', 'claude-code', 'terminal'] as const
export type OpenWith = (typeof OPEN_WITH)[number]

/** One block of a document, from the Markdown Atlas writes. */
export type DocBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'numbered'; items: string[] }
  | { type: 'table'; rows: string[][] }

/** Markdown (headings, paragraphs, - lists, 1. lists, | tables |) → document blocks. */
export const markdownBlocks = (md: string): DocBlock[] => {
  const out: DocBlock[] = []
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ type: 'paragraph', text: para.join(' ').trim() })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd()
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      out.push({ type: 'heading', level: h[1]!.length as 1 | 2 | 3, text: h[2]!.trim() })
      continue
    }
    if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      flush()
      const numbered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && (numbered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/).test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
      i--
      out.push(numbered ? { type: 'numbered', items } : { type: 'bullets', items })
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush()
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        const cells = lines[i++]!.trim().slice(1, -1).split('|').map(c => c.trim())
        // The |---|---| line under the header.
        if (!cells.every(c => /^:?-{2,}:?$/.test(c))) rows.push(cells)
      }
      i--
      if (rows.length) out.push({ type: 'table', rows })
      continue
    }
    if (!line.trim()) flush()
    else para.push(line.trim())
  }
  flush()
  return out
}

/** **bold** runs inside a line, for the document writer. */
export const boldRuns = (text: string): { text: string; bold: boolean }[] =>
  text
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map(t => (t.startsWith('**') && t.endsWith('**') ? { text: t.slice(2, -2), bold: true } : { text: t, bold: false }))

export interface SheetSpec {
  name: string
  columns: string[]
  rows: (string | number | null)[][]
  /** Add a total row for the numeric columns. */
  totals: boolean
}

/** The model's sheets, checked and trimmed: names Excel accepts, rows as long as the columns. */
export const parseSheets = (raw: unknown): SheetSpec[] | string => {
  if (!Array.isArray(raw) || !raw.length) return 'Give at least one sheet: {name, columns, rows}.'
  const out: SheetSpec[] = []
  const used = new Set<string>()
  for (const s of raw.slice(0, 20)) {
    const o = s as Record<string, unknown>
    const columns = Array.isArray(o?.columns) ? o.columns.map(c => String(c ?? '').slice(0, 80)).slice(0, 50) : []
    if (!columns.length) return 'Each sheet needs columns.'
    const rows = (Array.isArray(o.rows) ? o.rows : []).slice(0, 5000).map(r => (Array.isArray(r) ? r : []).slice(0, columns.length).map(v => (typeof v === 'number' && Number.isFinite(v) ? v : v === null || v === undefined ? null : String(v).slice(0, 1000))))
    let name = String(o.name ?? `Sheet${out.length + 1}`).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || `Sheet${out.length + 1}`
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${out.length + 1}`
    used.add(name.toLowerCase())
    out.push({ name, columns, rows, totals: o.totals === true })
  }
  return out
}

/** A file or folder name Windows accepts. */
export const safeName = (name: string, fallback = 'Untitled') =>
  name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120) || fallback

/** "C:\…\Report" + ".docx", unless it already ends so. */
export const withExt = (path: string, ext: string) => (path.toLowerCase().endsWith(ext) ? path : `${path}${ext}`)

/** Links that open things without a shell: VS Code (WSL too) and the Claude app. */
export const vscodeLink = (path: string, wsl: string | null) =>
  wsl ? `vscode://vscode-remote/wsl+${encodeURIComponent(wsl)}${path.split('/').map(encodeURIComponent).join('/')}` : `vscode://file/${path.replace(/\\/g, '/').split('/').map((p, i) => (i === 0 && /^[a-zA-Z]:$/.test(p) ? p : encodeURIComponent(p))).join('/')}`

export const claudeAppLink = (path: string, prompt = '') => `claude://code/new?folder=${encodeURIComponent(path)}${prompt ? `&q=${encodeURIComponent(prompt)}` : ''}`
export const claudeCliLink = (path: string, prompt = '') => `claude-cli://open?cwd=${encodeURIComponent(path)}${prompt ? `&q=${encodeURIComponent(prompt)}` : ''}`

/** A WSL path as Windows sees it (for Explorer and the Claude app). */
export const wslUnc = (distro: string, path: string) => `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`
