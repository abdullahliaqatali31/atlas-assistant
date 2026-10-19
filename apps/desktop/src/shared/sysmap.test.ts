import { describe, expect, it } from 'vitest'

import { fromWslUnc, isProtectedPath, parseWorkspaceUri, searchMap, type MapEntry } from './sysmap.ts'

const HOME = 'C:\\Users\\Abdullah'
const e = (kind: MapEntry['kind'], name: string, path: string | null, extra: Partial<MapEntry> = {}): MapEntry => ({ id: `${kind}-${name}`, kind, name, path, wsl: null, appId: null, source: 'scan', usedAt: 0, ...extra })

const ENTRIES: MapEntry[] = [
  e('project', 'atlas', '/home/abdullah/atlas', { wsl: 'Ubuntu', source: 'vscode' }),
  e('project', 'New Voice Assistent', 'C:\\Users\\Abdullah\\OneDrive\\Desktop\\New Voice Assistent', { source: 'claude', usedAt: Date.now() }),
  e('project', 'growzen-web', 'C:\\Users\\Abdullah\\source\\growzen-web'),
  e('app', 'WhatsApp', null, { appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App', source: 'start-menu' }),
  e('app', 'Visual Studio Code', null, { appId: 'Microsoft.VisualStudioCode', source: 'start-menu' }),
  e('folder', 'Invoices', 'C:\\Users\\Abdullah\\Documents\\Invoices', { source: 'known-folder' }),
  e('folder', 'atlas notes', 'C:\\Users\\Abdullah\\Documents\\atlas notes', { source: 'known-folder' }),
]

describe('system map', () => {
  it('finds what the owner means, the way they say it', () => {
    expect(searchMap(ENTRIES, 'my WSL project atlas')[0]?.id).toBe('project-atlas')
    expect(searchMap(ENTRIES, 'WhatsApp kholo')[0]?.id).toBe('app-WhatsApp')
    expect(searchMap(ENTRIES, 'invoices wala folder')[0]?.id).toBe('folder-Invoices')
    expect(searchMap(ENTRIES, 'voice assistant project')[0]?.id).toBe('project-New Voice Assistent')
    // "atlas" alone: the project and the folder, kind narrows it.
    expect(searchMap(ENTRIES, 'atlas', 'folder').map(x => x.id)).toEqual(['folder-atlas notes'])
    expect(searchMap(ENTRIES, 'growzen')[0]?.id).toBe('project-growzen-web')
    expect(searchMap(ENTRIES, 'photoshop')).toEqual([])
  })

  it('reads VS Code workspaces, WSL ones too', () => {
    expect(parseWorkspaceUri('file:///c%3A/Users/Abdullah/source/growzen-web')).toEqual({ path: 'c:\\Users\\Abdullah\\source\\growzen-web', wsl: null })
    expect(parseWorkspaceUri('vscode-remote://wsl%2Bubuntu/home/abdullah/atlas')).toEqual({ path: '/home/abdullah/atlas', wsl: 'ubuntu' })
    expect(parseWorkspaceUri('vscode-remote://ssh-remote%2Bbox/home/x')).toBeNull()
    expect(fromWslUnc('\\\\wsl.localhost\\Ubuntu\\home\\abdullah\\atlas')).toEqual({ wsl: 'Ubuntu', path: '/home/abdullah/atlas' })
    expect(fromWslUnc('C:\\Users')).toBeNull()
  })

  it('never looks into Windows, programs, app data or other people', () => {
    for (const p of ['C:', 'C:\\Windows\\System32', 'C:\\Program Files\\App', 'C:\\ProgramData\\x', `${HOME}\\AppData\\Roaming\\Code`, 'C:\\Users\\Someone', 'C:\\Users\\Public\\Documents']) expect(isProtectedPath(p, HOME), p).toBe(true)
    for (const p of [`${HOME}\\Documents`, `${HOME}\\OneDrive\\Desktop\\New Voice Assistent`, 'D:\\Projects']) expect(isProtectedPath(p, HOME), p).toBe(false)
  })
})
