import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { FileBatchView, FileFolderView } from '../../shared/files.ts'
import { FileOps } from './ops.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A throwaway "Downloads" with a few files, a read-only "Docs", a fake Recycle Bin and an outside folder. */
const setup = () => {
  const base = mkdtempSync(join(tmpdir(), 'atlas-files-'))
  dirs.push(base)
  const downloads = join(base, 'Downloads')
  const docs = join(base, 'Docs')
  const bin = join(base, 'bin')
  const outside = join(base, 'outside')
  for (const d of [downloads, docs, bin, outside]) mkdirSync(d)
  writeFileSync(join(downloads, 'photo.jpg'), 'jpg')
  writeFileSync(join(downloads, 'invoice-ahmed.pdf'), 'pdf')
  writeFileSync(join(downloads, 'setup.exe'), 'exe')
  writeFileSync(join(downloads, 'notes.txt'), 'buy milk')
  writeFileSync(join(downloads, 'big.zip.crdownload'), 'partial')
  writeFileSync(join(downloads, 'desktop.ini'), '[x]')
  writeFileSync(join(docs, 'plan.md'), '# plan')
  writeFileSync(join(outside, 'secret.txt'), 'nope')
  const folders: FileFolderView[] = [
    { id: 'd1', path: downloads, name: 'Downloads', access: 'organise', addedAt: 0 },
    { id: 'd2', path: docs, name: 'Docs', access: 'read', addedAt: 0 },
  ]
  let history: FileBatchView[] = []
  const ops = new FileOps({
    folders: () => folders,
    history: () => history,
    setHistory: h => {
      history = h
    },
    trash: async p => renameSync(p, join(bin, basename(p))),
  })
  return { ops, downloads, docs, bin, outside, base, history: () => history }
}

describe('FileOps', () => {
  it('resolves folder names and refuses paths outside the chosen folders', async () => {
    const { ops, downloads, outside } = setup()
    expect((await ops.resolvePath('Downloads/notes.txt', 'read')).path).toBe(join(downloads, 'notes.txt'))
    expect((await ops.resolvePath('downloads', 'read')).path).toBe(downloads)
    await expect(ops.resolvePath(join(outside, 'secret.txt'), 'read')).rejects.toThrow(/outside/)
    await expect(ops.resolvePath('Downloads/../outside/secret.txt', 'read')).rejects.toThrow(/outside/)
    await expect(ops.resolvePath('Docs/plan.md', 'organise')).rejects.toThrow(/read-only/)
    await expect(ops.resolvePath('Downloads/.git/config', 'read')).rejects.toThrow(/\.git/)
  })

  it('does not follow a junction out of a chosen folder', async () => {
    const { ops, downloads, outside } = setup()
    symlinkSync(outside, join(downloads, 'escape'), 'junction')
    await expect(ops.resolvePath('Downloads/escape/secret.txt', 'read')).rejects.toThrow(/leads outside/)
  })

  it('lists newest first and skips browser partials and desktop.ini', async () => {
    const { ops } = setup()
    const text = await ops.list('Downloads', false)
    expect(text).toContain('photo.jpg')
    expect(text).not.toContain('crdownload')
    expect(text).not.toContain('desktop.ini')
  })

  it('searches by words and type across folders, and reads only text', async () => {
    const { ops, downloads } = setup()
    expect(await ops.search({ kind: 'search', query: 'invoice', ext: ['pdf'] })).toContain('Downloads/invoice-ahmed.pdf')
    expect(await ops.search({ kind: 'search', query: '', ext: ['md'] })).toContain('Docs/plan.md')
    expect(await ops.read('Downloads/notes.txt')).toContain('buy milk')
    writeFileSync(join(downloads, 'bin.dat'), Buffer.from([1, 0, 2, 0]))
    expect(await ops.read('Downloads/bin.dat')).toMatch(/not a text file/)
  })

  it('moves into a new folder without overwriting, then undoes it all', async () => {
    const { ops, downloads, history } = setup()
    mkdirSync(join(downloads, 'Bills'))
    writeFileSync(join(downloads, 'Bills', 'invoice-ahmed.pdf'), 'older')
    const text = await ops.move([{ from: 'Downloads/invoice-ahmed.pdf', to: 'Downloads/Bills/' }, { from: 'Downloads/notes.txt', to: 'Downloads/Text/Notes/' }], false, 'test')
    expect(text).toContain('name was taken')
    expect(readFileSync(join(downloads, 'Bills', 'invoice-ahmed (2).pdf'), 'utf8')).toBe('pdf')
    expect(readFileSync(join(downloads, 'Bills', 'invoice-ahmed.pdf'), 'utf8')).toBe('older')
    expect(existsSync(join(downloads, 'Text', 'Notes', 'notes.txt'))).toBe(true)
    expect(history()[0]!.changes.filter(c => c.kind === 'mkdir')).toHaveLength(2)

    expect(await ops.undo()).toMatch(/Undid/)
    expect(existsSync(join(downloads, 'invoice-ahmed.pdf'))).toBe(true)
    expect(existsSync(join(downloads, 'notes.txt'))).toBe(true)
    expect(existsSync(join(downloads, 'Text'))).toBe(false)
    expect(readFileSync(join(downloads, 'Bills', 'invoice-ahmed.pdf'), 'utf8')).toBe('older')
    expect(await ops.undo()).toBe('Nothing to undo.')
  })

  it('renames, and refuses read-only folders and moving a chosen folder itself', async () => {
    const { ops, downloads } = setup()
    await ops.move([{ from: 'Downloads/photo.jpg', to: 'Downloads/Beach 2026.jpg' }], false, 'test')
    expect(existsSync(join(downloads, 'Beach 2026.jpg'))).toBe(true)
    expect(await ops.move([{ from: 'Docs/plan.md', to: 'Downloads/' }], false, 'test')).toMatch(/read-only/)
    expect(await ops.move([{ from: 'Downloads', to: 'Downloads/x/' }], false, 'test')).toMatch(/cannot be moved/)
  })

  it('plans before organising by type, then applies and undoes', async () => {
    const { ops, downloads } = setup()
    const plan = await ops.organize('Downloads', 'type', false, 'test')
    expect(plan).toMatch(/nothing moved yet/)
    expect(plan).toContain('Images/: 1')
    expect(readdirSync(downloads)).toContain('photo.jpg')

    await ops.organize('Downloads', 'type', true, 'test')
    expect(existsSync(join(downloads, 'Images', 'photo.jpg'))).toBe(true)
    expect(existsSync(join(downloads, 'Documents', 'invoice-ahmed.pdf'))).toBe(true)
    expect(existsSync(join(downloads, 'Installers', 'setup.exe'))).toBe(true)
    // Partial downloads and desktop.ini stay where they are.
    expect(existsSync(join(downloads, 'big.zip.crdownload'))).toBe(true)
    expect(existsSync(join(downloads, 'desktop.ini'))).toBe(true)

    await ops.undo()
    expect(readdirSync(downloads).sort()).toEqual(['big.zip.crdownload', 'desktop.ini', 'invoice-ahmed.pdf', 'notes.txt', 'photo.jpg', 'setup.exe'])
  })

  it('removes only to the Recycle Bin, never a chosen folder, and says so on undo', async () => {
    const { ops, downloads, bin, history } = setup()
    expect(await ops.trash(['Downloads/setup.exe', 'Downloads'], 'test')).toMatch(/Recycle Bin[\s\S]*cannot be removed/)
    expect(existsSync(join(bin, 'setup.exe'))).toBe(true)
    expect(existsSync(downloads)).toBe(true)
    expect(history()[0]!.summary).toMatch(/Recycle Bin/)
    expect(await ops.undo()).toMatch(/restore it from there/)
  })
})
