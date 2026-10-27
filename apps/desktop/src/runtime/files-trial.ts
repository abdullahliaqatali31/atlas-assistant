/**
 * Live trial of file management: your real LLM key, a throwaway database and
 * throwaway folders (nothing of yours is touched). Asks what is in Downloads,
 * organises it after a yes, undoes it, recycles one file, then teaches a file
 * task and runs it later in a new conversation. Results are checked on disk.
 *   pnpm trial:files
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { DEFAULT_PREFS } from '@assistant/initiative'
import { MemoryStore } from '@assistant/memory'
import { createLlm } from '@assistant/providers'
import { Assistant, DEFAULT_RULES, loadConfig, localTools, osCredentialStore, skillContextLines, skillTools, withStoredSecrets } from '@assistant/runtime'
import { fixedClock } from '@assistant/shared'

import type { FileBatchView, FileFolderView } from '../shared/files.ts'
import { FileOps } from '../main/files/ops.ts'
import { Document, Packer, Paragraph } from 'docx'

import { approvalQuestion } from '../shared/consent.ts'
import { FILE_RULES, HostFiles } from './files.ts'

try {
  process.loadEnvFile('.env')
} catch {
  // Optional.
}
const { config, problems } = loadConfig({ ...withStoredSecrets(process.env, osCredentialStore()), ASSISTANT_DEV_SKIP_VOICE: '1' }, process.cwd())
if (!config) {
  console.error('Needs an LLM key:', problems.map(p => p.key).join(', '))
  process.exit(1)
}
const OFFSET = 300

const dir = mkdtempSync(join(tmpdir(), 'pa-files-trial-'))
const downloads = join(dir, 'Downloads')
const bin = join(dir, 'RecycleBin')
mkdirSync(downloads)
mkdirSync(bin)
for (const f of ['beach.jpg', 'screenshot 2026-10-17.png', 'invoice ahmed october.pdf', 'quote sana.docx', 'zoom-installer.exe', 'vlc-setup.msi', 'notes.txt'])
  writeFileSync(join(downloads, f), f)

const folders: FileFolderView[] = [{ id: 'f1', path: downloads, name: 'Downloads', access: 'organise', addedAt: 0 }]
let history: FileBatchView[] = []
const ops = new FileOps({
  folders: () => folders,
  history: () => history,
  setHistory: h => {
    history = h
  },
  trash: async p => renameSync(p, join(bin, basename(p))),
})
const files = new HostFiles({ post: e => void ops.handle(e.op).then(r => files.onResult(e.requestId, r), err => files.onResult(e.requestId, undefined, String(err?.message ?? err))) })

const clock = fixedClock(Date.parse('2026-10-19T10:00:00+05:00'))
const memory = new MemoryStore(join(dir, 'a.db'), clock)
memory.setOnboarded(true)
const llm = createLlm(config.llm)
const rules = () => [...DEFAULT_RULES, ...FILE_RULES]
const line = (s = '') => console.log(s)
let confirmed: string[] = []
/** The owner's answer to the next question ("chalo kar lo" or "nahi"). */
let answer = true
const questions: string[] = []
const newAssistant = () =>
  new Assistant({
    llm,
    memory,
    clock,
    owner: config.owner,
    prefs: { ...DEFAULT_PREFS, utcOffsetMin: OFFSET },
    tools: [...localTools(memory, clock), ...skillTools(memory, clock, OFFSET), ...files.tools()],
    rules,
    learning: { observeOwner: () => [], contextLines: () => skillContextLines(memory, OFFSET) },
    // Stands in for the owner: yes to every confirmation, remembered for the checks.
    confirm: async (tool, input) => {
      confirmed.push(tool.name)
      questions.push(approvalQuestion(tool.name, input, config.owner.name, true))
      return answer
    },
    onAction: n => n.status !== 'running' && line(`      · ${n.tool}: ${n.status}`),
  })
const say = async (a: Assistant, text: string) => {
  line(`  You: ${text}`)
  let out = ''
  for await (const c of a.reply(text)) out += c
  line(`  Atlas: ${out.replace(/\s+/g, ' ').trim()}`)
  return out
}
let failed = 0
const check = (ok: boolean, what: string) => {
  line(`  ${ok ? '✓' : '✗'} ${what}`)
  if (!ok) failed++
}
const has = (...p: string[]) => existsSync(join(downloads, ...p))

try {
  line('━━ 1. What is in Downloads ━━')
  const a = newAssistant()
  const listed = await say(a, 'Downloads mein kya kya pada hai?')
  check(/invoice/i.test(listed) && /installer|exe|msi|setup/i.test(listed), 'named the real files')

  line('\n━━ 2. Organise by type, after a yes ━━')
  await say(a, 'Downloads ko type ke hisab se organise kar do')
  if (!has('Images', 'beach.jpg')) await say(a, 'Haan theek hai, kar do')
  check(has('Images', 'beach.jpg') && has('Documents', 'invoice ahmed october.pdf') && has('Installers', 'zoom-installer.exe'), 'files are in Images, Documents and Installers')

  line('\n━━ 3. Undo ━━')
  await say(a, 'Nahi, wapas pehle jaisa kar do')
  check(has('beach.jpg') && has('zoom-installer.exe') && !has('Images'), 'everything back where it was')

  line('\n━━ 4. Remove one file (Recycle Bin, asks first) ━━')
  confirmed = []
  await say(a, 'notes.txt delete kar do')
  check(!has('notes.txt') && existsSync(join(bin, 'notes.txt')), 'notes.txt is in the Recycle Bin, not deleted')
  check(confirmed.includes('files_trash'), 'asked before removing')

  line('\n━━ 5. Teach a file task ━━')
  const teacher = newAssistant()
  await say(teacher, 'Ek naya task seekho, naam "downloads safai": jab main kahoon downloads safai karo, to Downloads mein jitni installer files hain (.exe aur .msi) unko Downloads/Installers folder mein daal do aur batao kitni move hui. Abhi chalane ki zaroorat nahi.')
  for (let i = 0; i < 3 && memory.skills().length === 0; i++) await say(teacher, 'Haan isi tarah save kar lo.')
  check(memory.skills().length === 1, `skill saved${memory.skills()[0] ? `: "${memory.skills()[0]!.name}"` : ''}`)

  line('\n━━ 6. Later, new files arrived; in a new conversation ━━')
  writeFileSync(join(downloads, 'chrome-setup.exe'), 'x')
  writeFileSync(join(downloads, 'node-v24.msi'), 'x')
  const ran = await say(newAssistant(), 'downloads safai karo')
  const installers = existsSync(join(downloads, 'Installers')) ? readdirSync(join(downloads, 'Installers')) : []
  check(['zoom-installer.exe', 'vlc-setup.msi', 'chrome-setup.exe', 'node-v24.msi'].every(f => installers.includes(f)), `all 4 installers moved (${installers.join(', ') || 'none'})`)
  check(has('beach.jpg') && has('quote sana.docx'), 'other files left alone')
  check(/\b4\b|four|char|chaar/i.test(ran), 'reported how many moved')

  line('\n━━ 7. Reading a document asks first; "nahi" means it is not read ━━')
  const doc = new Document({ sections: [{ children: [new Paragraph('Client brief'), new Paragraph('Secret launch code word: PISTACHIO. Deadline 12 November.')] }] })
  writeFileSync(join(downloads, 'client brief.docx'), await Packer.toBuffer(doc))
  confirmed = []
  questions.length = 0
  answer = false
  const reader = newAssistant()
  const declined = await say(reader, 'Downloads mein client brief.docx hai, us mein kya likha hai?')
  line(`  (Atlas asked: ${questions[0] ?? 'nothing'})`)
  check(confirmed.filter(t => t === 'files_read').length === 1, 'asked once before reading')
  check(questions[0] === `${config.owner.name ? `${config.owner.name}, ` : ''}kya main “client brief.docx” parh loon?`, 'asked in plain words with the file name')
  check(!/pistachio|12 november/i.test(declined), 'did not read it after "nahi"')

  line('\n━━ 8. "Chalo kar lo": reads and reviews it ━━')
  confirmed = []
  answer = true
  const reviewed = await say(reader, 'Achha chalo kar lo, parh lo')
  check(confirmed.includes('files_read'), 'asked again and read it after the yes')
  check(/pistachio/i.test(reviewed) && /12 nov/i.test(reviewed), 'reviewed the real content')

  line(`\n${failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`}`)
  process.exitCode = failed ? 1 : 0
} finally {
  memory.close()
  rmSync(dir, { recursive: true, force: true })
}
