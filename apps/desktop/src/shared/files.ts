/**
 * File management: folders the owner chose, what Atlas may do in each, and
 * a history of every change with undo. Main owns the folders and does the
 * work; the model's tools only send requests. Nothing is ever deleted
 * outright: removing goes to the Recycle Bin.
 */

/** "read": list, search and read. "organise": also move, rename, copy, make folders and recycle. */
export const FILE_ACCESS = ['read', 'organise'] as const
export type FileAccess = (typeof FILE_ACCESS)[number]

export interface FileFolderView {
  id: string
  path: string
  name: string
  access: FileAccess
  addedAt: number
}

/** One change inside a batch, enough to undo it. */
export type FileChange =
  | { kind: 'move'; from: string; to: string }
  | { kind: 'copy'; from: string; to: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'trash'; path: string }

export interface FileBatchView {
  id: string
  at: number
  /** "Moved 12 files into Images, Documents…", in plain words. */
  summary: string
  /** Who asked: the conversation, a taught task, or the owner in the Files page. */
  by: string
  changes: FileChange[]
  undoneAt: number | null
}

export interface FilesState {
  folders: FileFolderView[]
  history: FileBatchView[]
}

/** Requests from the model's tools, answered by main as text. */
export type FileOp =
  | { kind: 'folders' }
  | { kind: 'list'; path: string; recursive?: boolean | undefined; limit?: number | undefined }
  | { kind: 'search'; query: string; in?: string | undefined; ext?: string[] | undefined; days?: number | undefined; limit?: number | undefined }
  | { kind: 'read'; path: string }
  | { kind: 'move'; items: { from: string; to: string }[]; copy?: boolean | undefined; by?: string | undefined }
  | { kind: 'mkdir'; path: string; by?: string | undefined }
  | { kind: 'trash'; paths: string[]; by?: string | undefined }
  | { kind: 'organize'; folder: string; by: OrganizeBy; apply: boolean; requestedBy?: string | undefined }
  | { kind: 'undo'; batch?: string | undefined }
  | { kind: 'history'; limit?: number | undefined }

export const ORGANIZE_BY = ['type', 'month', 'year'] as const
export type OrganizeBy = (typeof ORGANIZE_BY)[number]

/** Channel names for `window.files`. */
export const FC = {
  state: 'files:state',
  pick: 'files:pick',
  remove: 'files:remove',
  setAccess: 'files:set-access',
  undo: 'files:undo',
  reveal: 'files:reveal',
  changed: 'files:changed',
} as const

export interface FilesBridge {
  state(): Promise<FilesState>
  /** Opens the folder picker; the chosen folders are added with read access. */
  pick(): Promise<FilesState>
  remove(id: string): Promise<FilesState>
  setAccess(id: string, access: FileAccess): Promise<FilesState>
  undo(batchId: string): Promise<FilesState>
  /** Shows a folder or file in Explorer. */
  reveal(path: string): Promise<void>
  onChanged(cb: (s: FilesState) => void): () => void
}

export const isFileAccess = (v: unknown): v is FileAccess => (FILE_ACCESS as readonly unknown[]).includes(v)
export const isOrganizeBy = (v: unknown): v is OrganizeBy => (ORGANIZE_BY as readonly unknown[]).includes(v)

/** Folder names used when organising by type; anything else goes to "Other". */
export const TYPE_FOLDERS: Record<string, readonly string[]> = {
  Images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tif', 'tiff', 'ico', 'avif'],
  Documents: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages', 'epub'],
  Spreadsheets: ['xls', 'xlsx', 'csv', 'ods', 'numbers'],
  Presentations: ['ppt', 'pptx', 'odp', 'key'],
  Videos: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'm4v'],
  Audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'],
  Archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
  Installers: ['exe', 'msi', 'msix', 'appx', 'dmg', 'apk'],
  Code: ['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'php', 'rb', 'html', 'css', 'json', 'xml', 'yml', 'yaml', 'sql', 'sh', 'ps1'],
  Fonts: ['ttf', 'otf', 'woff', 'woff2'],
  Design: ['psd', 'ai', 'fig', 'sketch', 'xd', 'indd'],
}

const EXT_TO_FOLDER = new Map(Object.entries(TYPE_FOLDERS).flatMap(([folder, exts]) => exts.map(e => [e, folder] as const)))

export const typeFolderOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf('.')
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : ''
  return EXT_TO_FOLDER.get(ext) ?? 'Other'
}


/** "a.pdf" → "a (2).pdf" for the n-th free name. */
export const numbered = (fileName: string, n: number): string => {
  const dot = fileName.lastIndexOf('.')
  return dot > 0 ? `${fileName.slice(0, dot)} (${n})${fileName.slice(dot)}` : `${fileName} (${n})`
}

/** Bytes as "1.2 MB". */
export const size = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
