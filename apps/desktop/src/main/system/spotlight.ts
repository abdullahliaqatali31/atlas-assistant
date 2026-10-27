/**
 * Whole-Mac search through Spotlight (mdfind): every word must match the
 * file name or the text inside, newest first. The Windows counterpart is the
 * Windows Search index in probe.ps1; both answer the same shape.
 */
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** The kinds the search tool knows, as Spotlight content types. */
const KIND_TYPES: Record<string, string[]> = {
  document: ['public.composite-content', 'public.text', 'com.adobe.pdf', 'public.spreadsheet', 'public.presentation'],
  picture: ['public.image'],
  video: ['public.movie'],
  music: ['public.audio'],
  folder: ['public.folder'],
  program: ['com.apple.application-bundle'],
  email: ['com.apple.mail.emlx'],
}

/** Same rule as on Windows: letters, digits and a few marks, so nothing odd reaches the query. */
const WORD = /^[\p{L}\p{N}._-]{1,40}$/u

/** The mdfind query for these words, kind and earliest change (YYYY-MM-DD); null when no word is usable. */
export const spotlightQuery = (words: string[], kind: string | null, since: string | null): string | null => {
  const ok = words.filter(w => WORD.test(w))
  if (!ok.length) return null
  const parts = ok.map(w => `(kMDItemFSName == "*${w}*"cd || kMDItemTextContent == "${w}*"cd)`)
  const types = kind ? KIND_TYPES[kind] : undefined
  if (types) parts.push(`(${types.map(t => `kMDItemContentTypeTree == "${t}"`).join(' || ')})`)
  if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) parts.push(`kMDItemFSContentChangeDate >= $time.iso(${since}T00:00:00Z)`)
  return parts.join(' && ')
}

const KIND_OF_EXT: [RegExp, string][] = [
  [/^\.(pdf|docx?|pages|rtf|txt|md|odt|xlsx?|numbers|csv|pptx?|key)$/i, 'document'],
  [/^\.(jpe?g|png|heic|gif|webp|tiff?|bmp|raw|svg)$/i, 'picture'],
  [/^\.(mov|mp4|m4v|avi|mkv|webm)$/i, 'video'],
  [/^\.(mp3|m4a|wav|aiff?|flac|aac|ogg)$/i, 'music'],
  [/^\.app$/i, 'program'],
  [/^\.emlx$/i, 'email'],
]

export const searchMac = async (words: string[], kind: string | null, since: string | null): Promise<{ path: string; name: string; modified: string; size: number; kind: string }[]> => {
  const query = spotlightQuery(words, kind, since)
  if (!query) return []
  const { stdout } = await run('mdfind', [query], { maxBuffer: 8 << 20, timeout: 30_000 })
  const out: { path: string; name: string; modified: string; size: number; kind: string; at: number }[] = []
  for (const path of stdout.split('\n').filter(Boolean).slice(0, 400)) {
    try {
      const st = statSync(path)
      const ext = extname(path)
      out.push({ path, name: basename(path), modified: st.mtime.toISOString(), size: st.isDirectory() ? 0 : st.size, kind: st.isDirectory() && ext.toLowerCase() !== '.app' ? 'folder' : (KIND_OF_EXT.find(([re]) => re.test(ext))?.[1] ?? 'file'), at: st.mtimeMs })
    } catch {
      // Gone since Spotlight saw it.
    }
  }
  return out
    .sort((a, b) => b.at - a.at)
    .slice(0, 80)
    .map(({ at: _at, ...r }) => r)
}
