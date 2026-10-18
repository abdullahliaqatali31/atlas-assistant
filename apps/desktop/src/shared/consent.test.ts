import { evaluate } from '@assistant/policy'
import { DEFAULT_RULES } from '@assistant/runtime'
import { describe, expect, it } from 'vitest'

import { DESKTOP_RULES } from '../runtime/desktop.ts'
import { FILE_RULES } from '../runtime/files.ts'
import { approvalQuestion, parseConsent } from './consent.ts'

describe('asking in conversation', () => {
  it('reads short Roman Urdu, Urdu and English answers', () => {
    for (const yes of ['chalo kr lo', 'Chalo kar lo', 'haan kar lo na', 'ji', 'ok', 'theek hai parh lo', 'yes go ahead', 'ہاں کر لو', 'bilkul']) expect(parseConsent(yes), yes).toBe('yes')
    for (const no of ['nahi', 'nhi me khud hi tumhen bta dun ga', 'nahi main khud bata dunga', 'no', 'mat karo', 'rehne do', 'نہیں', 'abhi nahi']) expect(parseConsent(no), no).toBe('no')
    for (const other of ['kya haal hai?', 'Ahmed ka number kya hai', '', 'aaj ki khabrein sunao aur phir mujhe batao ke kal ka plan kya hai aur meeting kab hai please']) expect(parseConsent(other), other).toBeNull()
  })

  it('asks in the owner’s words before reading or downloading', () => {
    expect(approvalQuestion('files_read', { path: 'Downloads/Things to do on app.docx' }, 'Abdullah', true)).toBe('Abdullah, kya main “Things to do on app.docx” parh loon?')
    expect(approvalQuestion('whatsapp_download', { chat: 'Manager', file: 'Things to do' }, 'Abdullah', true)).toContain('download karke parh loon?')
    expect(approvalQuestion('files_read', { path: 'C:\\a\\b.pdf' }, '', false)).toBe('may I read “b.pdf”?')
  })

  it('asks before every file read and WhatsApp download, but not to list files', () => {
    const rules = [...DEFAULT_RULES, ...FILE_RULES, ...DESKTOP_RULES]
    const now = Date.now()
    expect(evaluate({ tool: 'files_read', actionClass: 'observe' }, rules, now).effect).toBe('ask')
    expect(evaluate({ tool: 'whatsapp_download', actionClass: 'modify' }, rules, now).effect).toBe('ask')
    expect(evaluate({ tool: 'files_list', actionClass: 'observe' }, rules, now).effect).toBe('allow')
    expect(evaluate({ tool: 'files_search', actionClass: 'observe' }, rules, now).effect).toBe('allow')
  })
})
