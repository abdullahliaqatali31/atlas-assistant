/**
 * Runtime host: runs inside an Electron utility process supervised by main.
 * Owns the Assistant, the SQLite memory store, the providers and the OS
 * credential store, so neither main's logs nor the renderer ever hold a key.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'

import { DEFAULT_PREFS } from '@assistant/initiative'
import { MemoryStore } from '@assistant/memory'
import { createLlm, isLlmProvider, listLlmModels, LLM_PROVIDERS, modelFor, type VoiceProvider } from '@assistant/providers'
import {
  Assistant,
  createVoice,
  isVoiceProvider,
  loadConfig,
  buildAgenda,
  conversationTools,
  CONVERSATION_RULES,
  learningTools,
  llmSummarizer,
  meterLlm,
  setBudget,
  setPrice,
  usageSummary,
  skillAgenda,
  skillTools,
  localTools,
  osCredentialStore,
  SECRET_NAMES,
  startOfLocalDay,
  VOICE_KEY_NAME,
  voiceProviderOf,
  withStoredSecrets,
  type RuntimeTool,
  type SecretName,
} from '@assistant/runtime'
import { systemClock, type InitiativeEvent } from '@assistant/shared'

import type { ChatModelChoice, HostEvent, HostRequest, InitiativeItem, RuntimePhase, SetupProblem } from '../shared/ipc.ts'
import type { ActivitySettings } from '../shared/activity.ts'
import { approvalQuestion, parseConsent } from '../shared/consent.ts'
import { HostActivity } from './activity.ts'
import { CODE_RULES, HostCode } from './code.ts'
import { DESKTOP_RULES, HostDesktop } from './desktop.ts'
import { FILE_RULES, HostFiles } from './files.ts'
import { HostUi, UI_RULES } from './ui.ts'
import { HostSystem, SYSTEM_RULES } from './system.ts'
import { IMPROVEMENT_RULES, Improvements } from './improvements.ts'
import { WORLD_RULES, WorldWatch } from './world.ts'
import { HostNews, NEWS_RULES } from './news.ts'
import { HostControls } from './controls.ts'
import { InitiativeService, parseQuietHours } from './initiative.ts'
import { once, runPersonalityOp, sttPin } from './personality.ts'
import { HostLearning } from './learning.ts'
import { runProjectsOp } from './projects.ts'
import { createSpeaker } from './speaker.ts'
import { brainView } from './brain.ts'
import { DailyFinder } from './discover.ts'
import { startWindowSampler } from './window-sampler.ts'

const port = process.parentPort
const store = osCredentialStore()

// Every line that leaves this process is scrubbed of key values.
let secrets: string[] = []
const redact = (s: string) => secrets.reduce((out, k) => out.split(k).join('[redacted]'), s)
const post = (e: HostEvent) => {
  if (e.type === 'log') port.postMessage({ ...e, message: redact(e.message) })
  else if (e.type === 'done' && e.error) port.postMessage({ ...e, error: redact(e.error) })
  else if (e.type === 'status') port.postMessage({ ...e, problems: e.problems.map(p => ({ ...p, message: redact(p.message) })) })
  else port.postMessage(e)
}
const log = (level: 'info' | 'warn' | 'error', message: string) => post({ type: 'log', level, message })
let keys = { llm: false, voice: false }
const status = (phase: RuntimePhase, problems: SetupProblem[] = [], warnings: string[] = []) =>
  post({ type: 'status', phase, problems, warnings, keys, voiceReady: voice !== null })
for (const level of ['log', 'info', 'warn', 'error'] as const) console[level] = (...args: unknown[]) => log(level === 'log' ? 'info' : level, args.map(String).join(' '))
process.on('uncaughtException', error => {
  log('error', `Uncaught: ${error.stack ?? error.message}`)
  process.exit(1)
})

let assistant: Assistant | null = null
let memory: MemoryStore | null = null
/** The owner's UTC offset, for "today". */
let dayOffsetMin = 0
/** Owner rules, pause, MCP servers and the open-app tool; rules arrive from main and are never written here. */
/** Code projects: snapshots from main, tools that ask main to act. */
const code = new HostCode({ post: e => post(e), now: () => systemClock.now() })
const files = new HostFiles({ post: e => post(e) })
const desktop = new HostDesktop({ post: e => post(e) })
/** The chat model chip's pick, kept across runtime restarts by main (re-sent on start). */
let chatChoice: ChatModelChoice = { kind: 'auto' }
let chatConfig: { llm: Parameters<typeof createLlm>[0]; env: Record<string, string | undefined> } | null = null
const applyChatModel = () => {
  if (!assistant || !chatConfig) return
  const c = chatChoice
  if (c.kind !== 'model') return assistant.setChatModel({ mode: c.kind })
  const keyName = LLM_PROVIDERS[c.provider].keyName
  const apiKey = keyName ? (store.get(keyName as SecretName) ?? chatConfig.env[keyName] ?? '') : ''
  if (keyName && !apiKey) {
    log('warn', `No key for ${c.provider}; the chat stays on its usual model.`)
    return assistant.setChatModel({ mode: 'auto' })
  }
  const same = c.provider === chatConfig.llm.provider
  const cfg = { ...chatConfig.llm, provider: c.provider, apiKey, model: c.model, baseUrl: same ? chatConfig.llm.baseUrl : undefined }
  assistant.setChatModel({ mode: 'main', llm: meterLlm(createLlm(cfg as never), { purpose: 'chat', memory: memory!, clock: systemClock, utcOffsetMin: dayOffsetMin, onRecord: () => schedulePush() }) })
}

const ui = new HostUi({ post: e => post(e), geocode: name => (world ? world.geocode(name) : Promise.reject(new Error('The assistant is not ready yet.'))) })
const system = new HostSystem({ request: (op, signal) => ui.ask({ kind: 'system', op }, signal), now: () => Date.now(), fullControl: () => controls.fullControl })
const news = new HostNews()
const controls = new HostControls({
  post: e => post(e),
  log: (level, message) => log(level, message),
  now: () => systemClock.now(),
  extensionToken: () => store.get('PLAYWRIGHT_MCP_EXTENSION_TOKEN'),
  extraRules: [...CODE_RULES, ...NEWS_RULES, ...FILE_RULES, ...DESKTOP_RULES, ...UI_RULES, ...SYSTEM_RULES, ...IMPROVEMENT_RULES, ...WORLD_RULES, ...CONVERSATION_RULES],
})
let voice: VoiceProvider | null = null
let speechEnabled = true
/**
 * Spoken Urdu and Hindi sound alike, so auto-detection often writes Urdu in
 * Devanagari. STT is pinned to the language the owner chose in onboarding or
 * Setup, else to their first non-English ASSISTANT_LANGUAGES entry.
 */
let sttLanguage: string | undefined
let configuredLanguages: string[] = []
let current: { replyId: string; abort: AbortController; say?: (text: string) => void } | null = null
/** Who Atlas asks, and in which language, when an action needs a yes. */
let asking = { name: '', urdu: false }
let initiative: InitiativeService | null = null
/** Opt-in window tracking; settings can arrive from main before the database exists. */
let activity: HostActivity | null = null
let learning: HostLearning | null = null
let world: WorldWatch | null = null
/** Today's find for the Home page. */
let finder: DailyFinder | null = null
/** When the owner last sent something; the agenda leaves them room after it. */
let lastOwnerTurnAt = 0
/** Sends the cost meter's totals to the window; set once the database is open. */
let pushUsage = () => {}
let pushTimer: ReturnType<typeof setTimeout> | null = null
/** At most one usage update every 2 seconds, however many calls finish. */
const schedulePush = () => {
  pushTimer ??= setTimeout(() => {
    pushTimer = null
    pushUsage()
  }, 2_000)
}
let activitySettings: ActivitySettings = { enabled: false, excludedApps: [] }
let ownerName = ''
/** How often due tasks and commitments are checked; also reconciles after sleep. */
const INITIATIVE_TICK_MS = 30_000

// ── approvals: the policy gate asks, the owner answers in the companion ──

const APPROVAL_TIMEOUT_MS = 2 * 60_000
const approvals = new Map<string, (approved: boolean) => void>()

/** Emergency stop: the reply, any in-flight tool (its signal aborts) and every pending approval. */
const stopAll = () => {
  current?.abort.abort()
  for (const settle of [...approvals.values()]) settle(false)
}

/** Unanswered, stopped or superseded requests count as a no. */
const askOwner = (tool: RuntimeTool, input: Record<string, unknown>, reason: string, signal?: AbortSignal) =>
  new Promise<boolean>(resolve => {
    const id = randomUUID()
    const settle = (approved: boolean) => {
      if (!approvals.delete(id)) return
      clearTimeout(timer)
      post({ type: 'approval-closed', id })
      resolve(approved)
    }
    const timer = setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS)
    signal?.addEventListener('abort', () => settle(false), { once: true })
    approvals.set(id, settle)
    const shown = JSON.stringify(input)
    const question = redact(approvalQuestion(tool.name, input, asking.name, asking.urdu))
    // Asked in the conversation itself (and aloud when the owner is talking): "haan" or "nahi" answers it.
    current?.say?.(`\n\n${question}`)
    post({
      type: 'approval',
      request: { id, tool: tool.name, actionClass: tool.actionClass, input: redact(shown.length > 400 ? `${shown.slice(0, 400)}…` : shown), reason, question },
    })
  })

const init = async (env: Record<string, string>, cwd: string, away?: 'lock' | 'suspend' | 'idle') => {
  const merged = withStoredSecrets(env, store)
  const provider = voiceProviderOf(merged)
  const voiceKeyName = isVoiceProvider(provider) ? VOICE_KEY_NAME[provider] : null
  const llmInfo = LLM_PROVIDERS[isLlmProvider(merged.ASSISTANT_LLM_PROVIDER) ? merged.ASSISTANT_LLM_PROVIDER : 'anthropic']
  // A local provider (Ollama) needs no key.
  keys = { llm: llmInfo.keyName === null || Boolean(merged[llmInfo.keyName]), voice: voiceKeyName !== null && Boolean(merged[voiceKeyName]) }
  secrets = SECRET_NAMES.map(n => merged[n]).filter((v): v is string => typeof v === 'string' && v.length >= 8)
  const { config, problems, warnings } = loadConfig(merged, cwd)
  if (!config) return status('setup', problems, warnings)
  asking = { name: config.owner.name, urdu: config.owner.languages.some(l => /^ur/i.test(l)) }

  status('checking', [], warnings)
  const llm = createLlm(config.llm)
  const candidate = config.voice ? createVoice(config.voice, config.owner.languages) : null
  const [llmCheck, voiceCheck] = await Promise.all([llm.healthCheck(), candidate ? candidate.healthCheck() : Promise.resolve({ ok: true as const })])
  const failed: SetupProblem[] = []
  if (!llmCheck.ok) failed.push({ key: 'ANTHROPIC_API_KEY', message: `Connection test failed: ${llmCheck.error}` })
  if (!voiceCheck.ok) failed.push({ key: voiceKeyName ?? 'ASSISTANT_VOICE_PROVIDER', message: `Connection test failed: ${voiceCheck.error}` })
  if (failed.length) return status('setup', failed, warnings)

  voice = candidate
  mkdirSync(config.dataDir, { recursive: true })
  dayOffsetMin = config.owner.utcOffsetMin
  memory = new MemoryStore(`${config.dataDir}/assistant.db`, systemClock)
  configuredLanguages = config.owner.languages
  ownerName = config.owner.name
  activity = new HostActivity({ memory, clock: systemClock, startSampler: startWindowSampler, log })
  activity.configure(activitySettings)
  sttLanguage = sttPin(memory, configuredLanguages)
  for (const t of memory.recoverInterrupted()) log('warn', `"${t.title}" was interrupted last time; it is waiting for verification.`)
  learning?.stop()
  world?.stop()
  world = new WorldWatch({ memory, now: () => systemClock.now(), localNews: place => news.mentions(place), publish: snapshot => post({ type: 'world', snapshot }), log: (level, message) => log(level, message) })
  world.start()
  const watch = world
  const improvements = new Improvements({ memory, clock: systemClock, writeBrief: (project, file, text) => code.writeBrief(project, file, text) })
  learning = new HostLearning({
    improvements,
    projects: () => code.projectNames(),
    memory,
    // Background learning runs on the cheaper background model, metered and within the monthly budget.
    llm: meterLlm(createLlm(config.llm, 'background'), { purpose: 'background', memory, clock: systemClock, utcOffsetMin: config.owner.utcOffsetMin, onRecord: () => schedulePush() }),
    clock: systemClock,
    utcOffsetMin: config.owner.utcOffsetMin,
    // Teach and Run now: the owner asked, so no attention policy; it appears in the conversation like any speak-up.
    speak: e =>
      void speakUp(e, { id: `agenda:${e.key}`, kind: e.kind === 'task' ? 'task' : 'question', title: e.title, channel: 'speak', reason: e.evidence, at: e.at, canMute: false, expectsAnswer: e.expectsAnswer }),
    post: e => post(e),
    busy: () => current !== null,
    log: (level, message) => log(level, message),
  })
  finder = new DailyFinder({
    llm: meterLlm(createLlm(config.llm, 'background'), { purpose: 'background', memory, clock: systemClock, utcOffsetMin: config.owner.utcOffsetMin, onRecord: () => schedulePush() }),
    memory,
    file: `${config.dataDir}/todays-find.json`,
    utcOffsetMin: config.owner.utcOffsetMin,
    now: () => systemClock.now(),
    log: (level, message) => log(level, message),
  })
  const usageMemory = memory
  const offset = config.owner.utcOffsetMin
  pushUsage = () => post({ type: 'usage', summary: usageSummary(usageMemory, systemClock.now(), offset) })
  chatConfig = { llm: config.llm, env: merged }
  assistant = new Assistant({
    // Every reply is metered (tokens and cost per day and model).
    llm: meterLlm(llm, { purpose: 'chat', memory, clock: systemClock, utcOffsetMin: offset, onRecord: () => schedulePush() }),
    // Short, simple messages go to a cheaper quick model (when it differs from the main one).
    ...(modelFor(config.llm, 'quick') !== modelFor(config.llm, 'chat')
      ? { quickLlm: meterLlm(createLlm(config.llm, 'quick'), { purpose: 'chat', memory, clock: systemClock, utcOffsetMin: offset, onRecord: () => schedulePush() }) }
      : {}),
    routing: config.llm.routing ?? 'auto',
    // Older parts of a long conversation become a short summary, written by the cheap background model.
    summarize: llmSummarizer(meterLlm(createLlm(config.llm, 'background'), { purpose: 'background', memory, clock: systemClock, utcOffsetMin: offset, onRecord: () => schedulePush() })),
    memory,
    // What Atlas learned and taught tasks, plus one line on its own window.
    learning: { observeOwner: text => learning?.observeOwner(text), contextLines: () => [...(learning?.contextLines() ?? []), ...ui.contextLines(), ...system.contextLines()] },
    clock: systemClock,
    owner: config.owner,
    prefs: { ...DEFAULT_PREFS, utcOffsetMin: config.owner.utcOffsetMin, quietHours: parseQuietHours(merged.ASSISTANT_QUIET_HOURS) },
    tools: [],
    rules: controls.rules,
    fullControl: () => controls.fullControl.on && !controls.paused,
    // While paused, nothing even asks.
    confirm: (tool, input, decision) => (controls.paused ? Promise.resolve(false) : askOwner(tool, input, decision.reason, current?.abort.signal)),
    onRecall: (ids, why) => post({ type: 'memory-used', ids, why }),
    onAction: n => post({ type: 'action', notice: { tool: n.tool, status: n.status, detail: n.detail === undefined ? undefined : redact(n.detail) } }),
    // Connected calendar/email (read-only connectors) and, when the owner opted in, window activity.
    briefingSources: () => [...controls.briefingSources(), ...(activity?.briefingSources() ?? []), code.briefingSource(), ...(world ? [world.briefingSource()] : [])],
  })
  // Local tools now; MCP servers start in the background and join when ready.
  // Answers to its own questions (project status, learning suggestions) go through these.
  // The model chip's pick may have arrived before the assistant existed.
  applyChatModel()
  void controls.attach(assistant, [...localTools(memory, systemClock), ...conversationTools(memory, { requestNew: () => assistant?.requestNewConversation(), currentId: () => assistant?.conversationId ?? '' }), ...learningTools(learning.learner), ...skillTools(memory, systemClock, config.owner.utcOffsetMin), ...code.tools(), ...files.tools(), ...desktop.tools(), ...ui.tools(), ...system.tools(), ...improvements.tools(), ...watch.tools(), news.tool(() => systemClock.now())], config.mcpConfigPath)
  const agendaMemory = memory
  const wrapUpMinute = parseClock(merged.ASSISTANT_WRAP_UP) ?? 18 * 60
  initiative = new InitiativeService(
    {
      assistant,
      memory,
      clock: systemClock,
      speak: speakUp,
      later: (items, notify) => post({ type: 'later', items, notify }),
      silence: () => current?.abort.abort(),
      isBusy: () => current !== null,
      lastOwnerTurnAt: () => lastOwnerTurnAt,
      // Taught skills due on their schedule come first; then questions, nudges and the wrap-up.
      agenda: now => {
        // VS Code minutes per project ride along on the agenda tick (every 30 s, sent at most every 10 min).
        code.measureMinutes(agendaMemory, startOfLocalDay(now, config.owner.utcOffsetMin))
        // Over the monthly budget: Atlas stops raising things on its own (replies to the owner still work).
        if (usageSummary(agendaMemory, now, config.owner.utcOffsetMin).overBudget) return []
        return [
          ...skillAgenda(agendaMemory, now, { utcOffsetMin: config.owner.utcOffsetMin }),
          ...buildAgenda(agendaMemory, now, { utcOffsetMin: config.owner.utcOffsetMin, wrapUpMinute }),
          ...code.agenda(now),
          ...improvements.agenda(now),
          ...watch.agenda(now),
        ].sort((a, b) => b.priority - a.priority)
      },
    },
    away,
  )
  status('ready', [], warnings)
  pushUsage()
  // On first run the onboarding and its welcome come before any briefing.
  if (memory.isOnboarded()) void initiative.start()
  setInterval(() => void initiative?.tick(), INITIATIVE_TICK_MS).unref()
}

/** Starts a new turn, cancelling whatever was still streaming, speaking or transcribing. */
const begin = (replyId: string) => {
  current?.abort.abort()
  const abort = new AbortController()
  current = { replyId, abort }
  return abort
}

/** `spoken`: the owner talked, so the reply is spoken too; a typed message gets a text reply only. */
const send = async (replyId: string, text: string, abort = begin(replyId), spoken = false) => {
  if (!assistant) return post({ type: 'done', replyId, stopped: false, error: 'The assistant is not ready yet.' })
  await stream(replyId, abort, assistant.reply(text, abort.signal), spoken)
}

/** The assistant speaks up on its own: same text and sentence TTS path as a reply, tagged with its item. */
const speakUp = async (event: InitiativeEvent, item: InitiativeItem) => {
  if (!assistant) return
  const replyId = randomUUID()
  const abort = begin(replyId)
  post({ type: 'initiative', replyId, item })
  await stream(replyId, abort, assistant.speakUp(event, abort.signal))
}

/**
 * Streams a reply as text, and as speech when `speak` is set: voice answers voice,
 * typing gets text, and the assistant's own speak-ups are spoken.
 */
const stream = async (replyId: string, abort: AbortController, chunks: AsyncIterable<string>, speak = true) => {
  if (!assistant) return
  // Quiet mode keeps replies on screen only.
  const speaker =
    speak && voice && speechEnabled && assistant.session.mode !== 'quiet'
      ? createSpeaker({
          tts: voice.tts,
          signal: abort.signal,
          onAudio: (seq, data) => post({ type: 'audio', replyId, seq, data }),
          onError: message => post({ type: 'speech-error', replyId, message: redact(message) }),
        })
      : null
  const say = (text: string) => {
    post({ type: 'chunk', replyId, text })
    speaker?.push(text)
  }
  if (current?.replyId === replyId) current.say = say
  try {
    for await (const chunk of chunks) {
      if (abort.signal.aborted) break
      say(chunk)
    }
    await speaker?.finish()
    post({ type: 'done', replyId, stopped: abort.signal.aborted })
  } catch (error) {
    if (abort.signal.aborted) post({ type: 'done', replyId, stopped: true })
    else post({ type: 'done', replyId, stopped: false, error: error instanceof Error ? error.message : 'The reply failed.' })
  } finally {
    if (current?.replyId === replyId) current = null
    // Anything the assistant held back while the owner was talking gets its turn now.
    if (!current) setTimeout(() => void initiative?.drain(), 0)
  }
}

/** A spoken message: transcribe it, show what was heard, then reply as if typed. */
/**
 * A short yes or no while Atlas is waiting on a question answers it ("chalo kar lo",
 * "nahi, main khud bata dunga"); the waiting reply carries on. Anything else is a new message.
 */
const answerPending = (replyId: string, text: string): boolean => {
  const pending = [...approvals.values()].pop()
  const answer = pending ? parseConsent(text) : null
  if (!pending || !answer) return false
  pending(answer === 'yes')
  post({ type: 'chunk', replyId, text: answer === 'yes' ? (asking.urdu ? 'Theek hai.' : 'Okay.') : asking.urdu ? 'Theek hai, nahi karta.' : 'Okay, I won’t.' })
  post({ type: 'done', replyId, stopped: false })
  return true
}

const sendVoice = async (replyId: string, audio: Uint8Array, mime: string) => {
  if (!voice) return post({ type: 'done', replyId, stopped: false, error: 'No voice provider is configured.' })
  // Atlas is waiting on a yes or no: hear the answer first, without cutting off the waiting reply.
  if (approvals.size) {
    let heard = ''
    try {
      heard = (await voice.stt.transcribe(new Blob([Uint8Array.from(audio)], { type: mime }), { languageHint: sttLanguage, signal: AbortSignal.timeout(20_000) })).text.trim()
    } catch {
      return post({ type: 'done', replyId, stopped: false, error: 'I didn’t catch that. Say haan or nahi, or use the buttons.' })
    }
    heard = heard.replace(/\([^)]*\)|\[[^\]]*\]/g, '').trim()
    if (!heard) return post({ type: 'done', replyId, stopped: false, error: 'I didn’t catch that. Say haan or nahi, or use the buttons.' })
    post({ type: 'heard', replyId, text: heard })
    if (answerPending(replyId, heard)) return
    return send(replyId, heard, begin(replyId), true)
  }
  const abort = begin(replyId)
  let heard: string
  try {
    heard = (await voice.stt.transcribe(new Blob([Uint8Array.from(audio)], { type: mime }), { languageHint: sttLanguage, signal: abort.signal })).text.trim()
  } catch (error) {
    if (current?.replyId === replyId) current = null
    if (abort.signal.aborted) return post({ type: 'done', replyId, stopped: true })
    return post({ type: 'done', replyId, stopped: false, error: `Could not transcribe: ${error instanceof Error ? error.message : String(error)}` })
  }
  // Scribe marks non-speech like "(music)" or "(silence)" in brackets.
  if (!heard.replace(/\([^)]*\)|\[[^\]]*\]/g, '').trim()) {
    if (current?.replyId === replyId) current = null
    return post({ type: 'done', replyId, stopped: false, error: 'I didn’t catch any speech. Try again a little closer to the mic.' })
  }
  post({ type: 'heard', replyId, text: heard })
  await send(replyId, heard, abort, true)
}

/** An onboarding answer said aloud: text only, no reply. */
const transcribeOnly = async (requestId: string, audio: Uint8Array, mime: string) => {
  if (!voice) return post({ type: 'transcript', requestId, error: 'No voice provider is configured.' })
  current?.abort.abort()
  try {
    const { text } = await voice.stt.transcribe(new Blob([Uint8Array.from(audio)], { type: mime }), { languageHint: sttLanguage, signal: AbortSignal.timeout(20_000) })
    post({ type: 'transcript', requestId, text: text.replace(/\([^)]*\)|\[[^\]]*\]/g, '').trim() })
  } catch (error) {
    post({ type: 'transcript', requestId, error: redact(`Could not transcribe: ${error instanceof Error ? error.message : String(error)}`) })
  }
}

port.on('message', ({ data }: { data: HostRequest }) => {
  switch (data.type) {
    case 'init':
      void init(data.env, data.cwd, data.away).catch(error => {
        log('error', `Runtime start failed: ${error instanceof Error ? error.message : String(error)}`)
        status('setup', [{ key: 'runtime', message: 'The runtime failed to start; see the log.' }])
      })
      break
    case 'store-secrets': {
      let error: string | undefined
      try {
        const llmKeyName = LLM_PROVIDERS[data.llmProvider].keyName
        if (data.llmKey && llmKeyName) store.set(llmKeyName as SecretName, data.llmKey)
        if (data.voiceKey) store.set(VOICE_KEY_NAME[data.voiceProvider], data.voiceKey)
      } catch {
        error = 'Could not write to the OS credential store.'
      }
      post({ type: 'secrets-stored', requestId: data.requestId, error })
      break
    }
    case 'set-budget':
      if (memory) {
        setBudget(memory, data.usd)
        pushUsage()
      }
      break
    case 'set-price':
      if (memory) {
        setPrice(memory, data.model, data.price)
        pushUsage()
      }
      break
    case 'list-models': {
      const keyName = LLM_PROVIDERS[data.provider].keyName
      const apiKey = data.apiKey || (keyName ? (store.get(keyName as SecretName) ?? process.env[keyName] ?? '') : '')
      void listLlmModels({ provider: data.provider, apiKey, baseUrl: data.baseUrl || undefined }, AbortSignal.timeout(20_000)).then(
        models => post({ type: 'models', requestId: data.requestId, models }),
        error => post({ type: 'models', requestId: data.requestId, error: redact(error instanceof Error ? error.message : String(error)) }),
      )
      break
    }
    case 'approval-answer':
      approvals.get(data.id)?.(data.approved)
      break
    case 'send':
      lastOwnerTurnAt = Date.now()
      if (answerPending(data.replyId, data.text)) break
      void send(data.replyId, data.text)
      break
    case 'voice':
      lastOwnerTurnAt = Date.now()
      void sendVoice(data.replyId, data.audio, data.mime)
      break
    case 'set-speech':
      speechEnabled = data.enabled
      break
    case 'stop':
      current?.abort.abort()
      break
    case 'interrupt':
      // Barge-in: aborting the token drops queued sentences and cancels the TTS request in flight.
      if (current) {
        const started = performance.now()
        current.abort.abort()
        log('info', `Barge-in: reply cancelled in ${(performance.now() - started).toFixed(1)} ms.`)
      }
      break
    case 'set-chat-model': {
      chatChoice = data.choice
      applyChatModel()
      break
    }
    case 'set-mode':
      // While locked or away the owner's choice waits until they are back.
      if (initiative) initiative.setOwnerMode(data.mode)
      else assistant?.setMode(data.mode)
      break
    case 'session':
      activity?.session(data.change)
      learning?.session(data.change)
      initiative?.session(data.change)
      break
    case 'set-activity':
      activitySettings = data.settings
      activity?.configure(data.settings)
      break
    case 'activity':
      post(activity ? activity.handle(data) : { type: 'activity', requestId: data.requestId, error: 'The assistant is not ready yet.' })
      break
    case 'learning':
      if (!learning) post({ type: 'learning', requestId: data.requestId, error: 'The assistant is not ready yet.' })
      else void learning.handle(data).then(post)
      break
    case 'brain': {
      if (!memory) {
        post({ type: 'brain', requestId: data.requestId, error: 'The assistant is not ready yet.' })
        break
      }
      if (data.op.kind === 'find') {
        const requestId = data.requestId
        if (!finder) post({ type: 'brain', requestId, find: null })
        else
          void finder.get(data.op.refresh === true).then(
            find => post({ type: 'brain', requestId, find }),
            (error: unknown) => {
              log('warn', `Today's find: ${error instanceof Error ? error.message : String(error)}`)
              post({ type: 'brain', requestId, error: "Couldn't find today's pick right now." })
            },
          )
        break
      }
      try {
        if (data.op.kind === 'forget') memory.forget(data.op.id)
        post({ type: 'brain', requestId: data.requestId, view: brainView(memory, ownerName) })
      } catch (error) {
        post({ type: 'brain', requestId: data.requestId, error: error instanceof Error ? error.message : String(error) })
      }
      break
    }
    case 'projects': {
      if (!memory) {
        post({ type: 'projects', requestId: data.requestId, error: 'The assistant is not ready yet.' })
        break
      }
      try {
        const { result, changed } = runProjectsOp(memory, systemClock, ownerName, data.op)
        post({ type: 'projects', requestId: data.requestId, result })
        if (changed) post({ type: 'project-changed', projectId: changed })
      } catch (error) {
        post({ type: 'projects', requestId: data.requestId, error: error instanceof Error ? error.message : String(error) })
      }
      break
    }
    case 'initiative-action':
      void initiative?.act(data.id, data.action)
      break
    case 'list-today': {
      // The current conversation, so the window continues it instead of starting blank.
      const lines = memory && assistant ? memory.conversationMessages(assistant.conversationId).map(m => ({ who: m.speaker, text: m.content, at: m.at })) : []
      post({ type: 'today', requestId: data.requestId, lines })
      break
    }
    case 'chats': {
      const { requestId, op } = data
      if (!memory || !assistant) {
        post({ type: 'chats-result', requestId, error: 'The assistant is not ready yet.' })
        break
      }
      const lines = (id: string) => memory!.conversationMessages(id).map(m => ({ who: m.speaker, text: m.content, at: m.at }))
      try {
        if (op.kind === 'list') {
          const current = assistant.conversationId
          post({ type: 'chats-result', requestId, result: memory.conversations(80).map(c => ({ id: c.id, title: c.title, startedAt: c.startedAt, lastAt: c.lastAt, messages: c.messages, current: c.id === current })) })
        } else if (op.kind === 'read') post({ type: 'chats-result', requestId, result: lines(op.id) })
        else if (op.kind === 'new') {
          assistant.newConversation()
          post({ type: 'chats-result', requestId, result: { id: assistant.conversationId } })
        } else {
          assistant.resumeConversation(op.id)
          post({ type: 'chats-result', requestId, result: lines(op.id) })
        }
      } catch (e) {
        post({ type: 'chats-result', requestId, error: e instanceof Error ? e.message : String(e) })
      }
      break
    }
    case 'backup-db': {
      let error: string | undefined
      try {
        if (!memory) throw new Error('The assistant is not ready yet.')
        memory.backupTo(data.path)
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      post({ type: 'backup-db', requestId: data.requestId, error })
      break
    }
    case 'list-tasks': {
      const tasks = (memory?.openTasks() ?? []).map(t => ({ id: t.id, title: t.title, status: t.status, dueAt: t.dueAt }))
      post({ type: 'tasks', requestId: data.requestId, tasks })
      break
    }
    case 'set-rules':
      controls.setRules(data.rules)
      break
    case 'set-apps':
      controls.setApps(data.apps)
      break
    case 'reload-mcp':
      void controls.reloadMcp()
      break
    case 'news-snapshot':
      news.set(data.headlines)
      break
    case 'code-snapshot':
      code.setSnapshot({ projects: data.projects, running: data.running })
      break
    case 'code-result':
      code.onResult(data.requestId, data.result, data.error)
      break
    case 'files-result':
      files.onResult(data.requestId, data.result, data.error)
      break
    case 'desktop-result':
      desktop.onResult(data.requestId, data.result, data.error)
      break
    case 'ui-result':
      ui.onResult(data.requestId, data.result, data.error)
      break
    case 'ui-snapshot':
      ui.setSnapshot(data.state)
      break
    case 'system-snapshot':
      system.setSnapshot(data.snapshot, data.changes)
      break
    case 'world-op': {
      const { requestId, op } = data
      if (!world) {
        post({ type: 'world-result', requestId, error: 'The assistant is not ready yet.' })
        break
      }
      void world.handleOp(op).then(
        () => post({ type: 'world-result', requestId }),
        error => post({ type: 'world-result', requestId, error: error instanceof Error ? error.message : String(error) }),
      )
      break
    }
    case 'open-app-result':
      controls.onOpenResult(data.requestId, data.error)
      break
    case 'set-full-control':
      controls.fullControl = { on: data.on, mode: data.mode, until: data.until }
      break
    case 'set-paused':
      controls.paused = data.paused
      if (data.paused) stopAll()
      break
    case 'stop-all':
      stopAll()
      break
    case 'list-actions':
      post({ type: 'actions', requestId: data.requestId, entries: (memory?.recentActions(100) ?? []).map(a => ({ ...a, evidence: a.evidence === null ? null : redact(a.evidence) })) })
      break
    case 'personality': {
      post(runPersonalityOp(memory, data.requestId, data.op))
      if (memory) sttLanguage = sttPin(memory, configuredLanguages)
      break
    }
    case 'speak-prompt': {
      // Onboarding questions use the same sentence TTS path, so Stop and quiet mode apply.
      if (!assistant) return post({ type: 'done', replyId: data.replyId, stopped: false })
      void stream(data.replyId, begin(data.replyId), once(data.text))
      break
    }
    case 'transcribe':
      void transcribeOnly(data.requestId, data.audio, data.mime)
      break
    case 'welcome': {
      if (!assistant) return post({ type: 'done', replyId: data.replyId, stopped: false, error: 'The assistant is not ready yet.' })
      const abort = begin(data.replyId)
      void stream(data.replyId, abort, assistant.welcome(abort.signal))
      break
    }
    case 'shutdown':
      current?.abort.abort()
      activity?.stop()
      void controls.stop().finally(() => {
        memory?.close()
        process.exit(0)
      })
  }
})

status('starting')

/** `ASSISTANT_WRAP_UP=18:30` → owner-local minutes; undefined when unset or invalid. */
function parseClock(v: string | undefined): number | undefined {
  const m = v?.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return undefined
  const h = Number(m[1])
  const min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : undefined
}
