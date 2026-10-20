import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { Ear, Mic, Square, SquarePen, Volume2, VolumeX } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import { MODES, type ActionNotice, type ApprovalRequest, type InitiativeItem, type RuntimeStatus, type TaskView, type UiMode } from '../../shared/ipc.ts'
import type { OnboardingStep, PersonalityView, PromptLanguage } from '../../shared/personality.ts'
import { record, SentencePlayer, watchForSpeech, type Recording } from './audio.ts'
import { wakeRequest, type WakeView } from '../../shared/wake.ts'
import { InitiativeControls, LaterList } from './Initiative.tsx'
import { VoiceMode, type VoicePhase } from './VoiceMode.tsx'
import { chime, toWav, WakeListener } from './wake/listener.ts'
import type { Presence } from './Jarvis.tsx'
import type { PresenceCommand } from '../../shared/presence.ts'
import { ChatList } from './ChatList.tsx'
import { ChatMenu } from './ChatMenu.tsx'
import { ModelChip } from './ModelChip.tsx'
import { useLiveVoice } from './voice/useLiveVoice.ts'
import { chatViewVars, readChatView, saveChatView, type ChatView } from './chatview.ts'
import { Onboarding } from './Onboarding.tsx'
import { Markdown } from './ui/Markdown.tsx'
import { ASK_EVENT, MIC_EVENT, publishLive, STOP_EVENT } from './shell/live.ts'

interface Line {
  id: string
  who: 'owner' | 'assistant'
  text: string
  note?: string
  actions?: ActionNotice[]
  /** Set when the assistant spoke up on its own. */
  item?: InitiativeItem
  /** From earlier today (loaded from memory when the window opened). */
  earlier?: boolean
}

const PHASE_TEXT: Record<RuntimeStatus['phase'], string> = {
  starting: 'Starting',
  setup: 'Setup needed',
  checking: 'Checking providers',
  ready: 'Ready',
  restarting: 'Restarting',
  stopped: 'Stopped',
}

const cleanError = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback

/** A voice conversation ends after this long with nobody speaking. */
const IDLE_MS = 30_000
/** Saying one of these ends the conversation after the assistant's reply. */
const END_PHRASE = /^\s*(bas|bas karo|bas kro|stop|that'?s all|that is all|thank you|thanks|shukriya|ok bye|bye|goodbye|khuda hafiz|allah hafiz|chup|chup karo|khamosh|shut up|be quiet|enough|kuch nahi|nothing else|bas theek hai)\b[\s.!,]*$/i

const MIC_HELP = 'Microphone unavailable. Allow it in Windows Settings › Privacy & security › Microphone. You can still type.'

/** Floating companion: type or talk, streamed text and speech out, mode switch and stop. */
export function Companion({
  status,
  onOpenSetup,
  onOpenControls,
  onPresence,
}: {
  status: RuntimeStatus
  onOpenSetup: () => void
  onOpenControls?: () => void
  /** What the assistant is doing right now, for the Jarvis panel's orb. */
  onPresence?: (p: Presence) => void
}) {
  const [lines, setLines] = useState<Line[]>([])
  /** The chat list over the conversation, and starting a fresh chat. */
  const [chatsOpen, setChatsOpen] = useState(false)
  const startNewChat = () => void window.assistant.newChat().then(() => setLines([]), () => undefined)
  const [draft, setDraft] = useState('')
  const [chatView, setChatView] = useState<ChatView>(readChatView)
  const changeView = (v: ChatView) => {
    setChatView(v)
    saveChatView(v)
  }
  const [replyId, setReplyId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<TaskView[] | null>(null)
  const [showLater, setShowLater] = useState(false)
  const [error, setError] = useState('')
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [level, setLevel] = useState(0)
  const replyRef = useRef<string | null>(null)
  const recordingRef = useRef<Recording | null>(null)
  const playerRef = useRef<SentencePlayer | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  /** Short replies Atlas offered after its last answer. */
  const [suggest, setSuggest] = useState<{ replyId: string; options: string[] } | null>(null)
  const ready = status.phase === 'ready'
  const voice = status.speech.available

  playerRef.current ??= new SentencePlayer(setSpeaking)
  const player = playerRef.current
  const stopSpeech = useCallback(() => playerRef.current?.stop(), [])
  const [wake, setWake] = useState<WakeView | null>(null)

  const patchLine = (id: string, patch: (l: Line) => Line) => setLines(ls => ls.map(l => (l.id === id ? patch(l) : l)))

  useEffect(() => {
    const off = window.assistant.onReply(e => {
      // The assistant speaks up on its own: this reply is now the current one.
      if (e.type === 'initiative') {
        stopSpeech()
        replyRef.current = e.replyId
        setReplyId(e.replyId)
        setLines(ls => [...ls, { id: e.replyId, who: 'assistant', text: '', item: e.item }])
        // It asked something: open a voice conversation, so after it speaks it listens for the answer.
        if (e.item.expectsAnswer && twoWayRef.current && !conversationRef.current) {
          convStartRef.current = linesRef.current.length
          conversationRef.current = true
          setConversation(true)
        }
        return
      }
      // Quick replies for a finished answer: buttons under it while it is the last thing said.
      if (e.type === 'suggestions') {
        const last = linesRef.current.at(-1)?.id === e.replyId
        if (last && e.options.length) setSuggest({ replyId: e.replyId, options: e.options })
        // The topic is done: a voice conversation stops listening (now, or once the reply has been spoken).
        if (last && e.ended && conversationRef.current) {
          if (recordingRef.current) endConversationRef.current()
          else endAfterReplyRef.current = true
        }
        return
      }
      // An onboarding question being read aloud: only its audio matters.
      if (e.replyId === promptRef.current) {
        if (e.type === 'audio' && !recordingRef.current) void player.add(e.replyId, e.seq, e.data).catch(() => undefined)
        if (e.type === 'done') promptRef.current = null
        return
      }
      if (e.replyId !== replyRef.current) return
      switch (e.type) {
        case 'heard':
          setTranscribing(false)
          if (conversationRef.current && END_PHRASE.test(e.text)) endAfterReplyRef.current = true
          patchLine(`o-${e.replyId}`, l => ({ ...l, text: e.text }))
          break
        case 'chunk':
          patchLine(e.replyId, l => ({ ...l, text: l.text + e.text }))
          break
        case 'audio':
          // Never talk over the owner while the mic is open.
          if (recordingRef.current) break
          void player.add(e.replyId, e.seq, e.data).catch(() => patchLine(e.replyId, l => ({ ...l, note: 'Could not play the voice reply.' })))
          break
        case 'speech-error':
          patchLine(e.replyId, l => ({ ...l, note: voiceProblem(e.message) }))
          break
        case 'done': {
          setTranscribing(false)
          // Speech-to-text failures get the same plain wording as voice reply failures.
          const note = e.error ? (/transcribe|STT/i.test(e.error) ? voiceProblem(e.error).replace('Voice reply skipped', 'Couldn’t hear you') : e.error) : e.stopped ? 'stopped' : undefined
          if (note) patchLine(e.replyId, l => ({ ...l, note }))
          // A voice message that failed before transcription keeps a neutral label instead of "…".
          if (e.error) patchLine(`o-${e.replyId}`, l => (l.text === '🎤 …' ? { ...l, text: '🎤 voice message' } : l))
          // Nothing heard is not a failure: in a conversation it simply listens again.
          const nothingHeard = Boolean(e.error && /catch any speech/i.test(e.error))
          // A voice turn that failed would fail again: end the conversation instead of looping.
          if (e.error && !nothingHeard && conversationRef.current) {
            endAfterReplyRef.current = false
            conversationRef.current = false
            setConversation(false)
            setError(note ?? 'Voice stopped.')
          }
          replyRef.current = null
          setReplyId(null)
        }
      }
    })
    // Tool progress belongs to the reply that triggered it.
    const offAction = window.assistant.onAction(n => {
      const id = replyRef.current
      if (!id) return
      patchLine(id, l => {
        const actions = [...(l.actions ?? [])]
        const i = actions.findLastIndex(a => a.tool === n.tool && a.status === 'running')
        if (n.status !== 'running' && i >= 0) actions[i] = n
        else actions.push(n)
        return { ...l, actions }
      })
    })
    // Lock or sleep: stop talking and listening at once.
    const offSilence = window.assistant.onSilence(() => {
      recordingRef.current?.stop(false)
      stopSpeech()
    })
    // Listening now: main flushes anything it held while this window was loading.
    void window.assistant.ready()
    return () => {
      off()
      offAction()
      offSilence()
      recordingRef.current?.stop(false)
      stopSpeech()
    }
  }, [player, stopSpeech])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [lines, suggest])


  /** Stop talking and streaming: used by Stop, Esc, and whenever the owner starts a new turn. */
  const interrupt = useCallback(() => {
    stopSpeech()
    if (replyRef.current) void window.assistant.stop()
  }, [stopSpeech])

  /** A reply is starting; null ownerText for one the owner did not type or say (the welcome). */
  const begin = (id: string, ownerText: string | null) => {
    replyRef.current = id
    setReplyId(id)
    setLines(ls => [...ls, ...(ownerText === null ? [] : [{ id: `o-${id}`, who: 'owner' as const, text: ownerText }]), { id, who: 'assistant', text: '' }])
  }

  // ── first-run onboarding: scripted questions in this conversation ──
  const [personality, setPersonality] = useState<PersonalityView | null>(null)
  // Live voice (OpenAI Realtime): the voice is live, Atlas stays the mind (ask_atlas runs as an ordinary message).
  const statusRef = useRef(status)
  statusRef.current = status
  const live = useLiveVoice({
    assistantName: personality?.profile.assistantName ?? 'Atlas',
    show: (id, text) => begin(id, text),
    approvals: () => statusRef.current.approvals,
  })
  const liveRef = useRef(live)
  liveRef.current = live
  const liveOnRef = useRef(false)
  liveOnRef.current = status.speech.live.enabled && status.speech.live.available
  /** Talking works with a classic voice provider or with Live voice. */
  const canTalk = voice || liveOnRef.current
  const promptRef = useRef<string | null>(null)
  const onboarding = ready && personality !== null && !personality.onboarded
  useEffect(() => {
    if (!ready) return
    void window.personality.get().then(v => v && setPersonality(v), () => undefined)
    return window.personality.onChanged(setPersonality)
  }, [ready])

  const say = useCallback(
    (text: string, speak?: { step: OnboardingStep; language: PromptLanguage }) => {
      setLines(ls => [...ls, { id: `ob-${ls.length}-${Date.now()}`, who: 'assistant', text }])
      if (!speak || !status.speech.enabled) return
      void window.personality.speakPrompt(speak.step, speak.language).then(r => {
        if (r) promptRef.current = r.replyId
      }, () => undefined)
    },
    [status.speech.enabled],
  )
  const answer = useCallback((text: string) => setLines(ls => [...ls, { id: `oa-${ls.length}-${Date.now()}`, who: 'owner', text }]), [])
  const stopPrompt = useCallback(() => {
    if (!promptRef.current) return
    stopSpeech()
    void window.assistant.stop()
  }, [stopSpeech])
  const welcome = () => {
    void window.personality.welcome().then(
      r => begin(r.replyId, null),
      err => setError(cleanError(err, 'The assistant could not say hello.')),
    )
  }

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    await sendText(draft.trim())
  }

  /** Typed text from this box or the floating Ask bar: one path, one thread. */
  const sendText = async (text: string) => {
    if (!text || !ready) return
    setSuggest(null)
    // Typing ends a voice conversation: the reply stays on screen.
    endConversation()
    interrupt()
    setDraft('')
    setError('')
    try {
      begin((await window.assistant.send(text)).replyId, text)
    } catch (err) {
      setDraft(text)
      setError(cleanError(err, 'Sending failed.'))
    }
  }

  const startListening = useCallback(async () => {
    if (!ready || !voice || onboarding || recordingRef.current) return
    // Barge-in: talking over a spoken reply cuts its audio in main at once, then stops the reply.
    if (replyRef.current || speaking) void window.assistant.interrupt().catch(() => undefined)
    interrupt()
    setError('')
    const inConversation = conversationRef.current
    if (inConversation) setIdleUntil(Date.now() + IDLE_MS)
    try {
      recordingRef.current = await record({
        onLevel: setLevel,
        // In a conversation it waits up to 30 s for the owner to speak; then the conversation ends.
        noSpeechMs: inConversation ? IDLE_MS : undefined,
        onEnd: async (result, reason) => {
          recordingRef.current = null
          setListening(false)
          if (!result) {
            if (reason === 'no-speech' && conversationRef.current) endConversationRef.current()
            else if (reason === 'no-speech') setError('I didn’t hear anything. Tap the mic and speak.')
            return
          }
          setTranscribing(true)
          try {
            begin((await window.assistant.sendVoice(result.audio, result.mime)).replyId, '🎤 …')
          } catch (err) {
            setTranscribing(false)
            setError(cleanError(err, 'Sending your voice failed.'))
          }
        },
      })
      setListening(true)
    } catch {
      recordingRef.current = null
      setError(MIC_HELP)
    }
  }, [ready, voice, onboarding, interrupt, speaking])

  // The floating Ask bar asks through here, so its messages land in this same thread.
  const askRef = useRef(sendText)
  askRef.current = sendText
  const micRef = useRef<() => void>(() => undefined)
  micRef.current = () => (recordingRef.current ? recordingRef.current.stop(true) : void startListening())
  useEffect(() => {
    const onAsk = (e: Event) => void askRef.current(String((e as CustomEvent<string>).detail ?? '').trim())
    const onMic = () => micRef.current()
    window.addEventListener(ASK_EVENT, onAsk)
    window.addEventListener(MIC_EVENT, onMic)
    return () => {
      window.removeEventListener(ASK_EVENT, onAsk)
      window.removeEventListener(MIC_EVENT, onMic)
    }
  }, [])

  // The latest reply and what the voice is doing, for the Ask bar's bubble.
  useEffect(() => {
    const last = [...lines].reverse().find(l => l.who === 'assistant')
    publishLive({ replyId: last?.id ?? null, text: last?.text ?? '', replying: replyId !== null, listening, transcribing, speaking, level, error })
  }, [lines, replyId, listening, transcribing, speaking, level, error])

  // ── voice conversation: keeps listening and answering until 30 s of silence ──
  const [conversation, setConversation] = useState(false)
  const conversationRef = useRef(false)
  const [idleUntil, setIdleUntil] = useState(0)
  const endAfterReplyRef = useRef(false)
  /** Index of the first line of this conversation: captions show only what was said in it. */
  const convStartRef = useRef(0)
  /** Speaking up can turn into a voice conversation only when replies are spoken aloud. */
  const twoWayRef = useRef(false)
  twoWayRef.current = voice && status.speech.enabled && status.mode !== 'quiet' && !onboarding
  const linesRef = useRef(lines)
  linesRef.current = lines
  const speakingRef = useRef(false)
  speakingRef.current = speaking
  const startListeningRef = useRef(startListening)
  startListeningRef.current = startListening

  const endConversation = useCallback(() => {
    if (!conversationRef.current) return
    conversationRef.current = false
    endAfterReplyRef.current = false
    setConversation(false)
    setIdleUntil(0)
    recordingRef.current?.stop(false)
  }, [])
  const endConversationRef = useRef(endConversation)
  endConversationRef.current = endConversation

  const beginConversation = useCallback(() => {
    // Live voice on: one live call instead of the listen–transcribe–speak loop.
    if (liveOnRef.current) {
      if (ready && !onboarding && !liveRef.current.active) void liveRef.current.start()
      return
    }
    if (!ready || !voice || onboarding) return
    conversationRef.current = true
    endAfterReplyRef.current = false
    convStartRef.current = linesRef.current.length
    setConversation(true)
    setError('')
    if (!recordingRef.current) void startListeningRef.current()
  }, [ready, voice, onboarding])

  // After each reply has been spoken, listen again by itself. A short grace
  // period lets the next sentence start playing before it counts as finished.
  useEffect(() => {
    if (!conversation || listening || transcribing || replyId !== null || speaking) return
    if (endAfterReplyRef.current) return endConversation()
    const t = setTimeout(() => {
      if (conversationRef.current && !recordingRef.current && !replyRef.current && !speakingRef.current) void startListeningRef.current()
    }, 700)
    return () => clearTimeout(t)
  }, [conversation, listening, transcribing, replyId, speaking, endConversation])

  // Barge-in: talking over the assistant stops it and hands the turn back to the owner.
  useEffect(() => {
    if (!conversation || !speaking) return
    let stop: (() => void) | null = null
    let cancelled = false
    void watchForSpeech(() => {
      void window.assistant.interrupt().catch(() => undefined)
      interrupt()
      void startListeningRef.current()
    }).then(
      s => (cancelled ? s() : (stop = s)),
      () => undefined,
    )
    return () => {
      cancelled = true
      stop?.()
    }
  }, [conversation, speaking, interrupt])

  // The mic button starts a conversation, or ends one.
  const toggleMic = () => (liveRef.current.active ? liveRef.current.stop() : conversationRef.current ? endConversation() : beginConversation())

  // ── wake word: say the assistant's name to start talking ──
  const [ownerLocked, setOwnerLocked] = useState(false)
  const [wakeError, setWakeError] = useState('')
  const wakeRef = useRef<WakeListener | null>(null)
  const wakeViewRef = useRef<WakeView | null>(null)
  wakeViewRef.current = wake
  useEffect(() => {
    void window.wake.get().then(setWake, () => undefined)
    void window.identity.get().then(v => setOwnerLocked(v.locked), () => undefined)
    const offWake = window.wake.onChanged(setWake)
    const offId = window.identity.onChanged(v => setOwnerLocked(v.locked))
    return () => {
      offWake()
      offId()
    }
  }, [])
  // Today's conversation so far, so the window continues the day instead of starting blank.
  const loadedDay = useRef(false)
  useEffect(() => {
    if (!ready || ownerLocked || loadedDay.current) return
    loadedDay.current = true
    void window.assistant.listToday().then(
      day => {
        if (day.length === 0) return
        setLines(ls => [...day.map((d, i): Line => ({ id: 'day-' + i, who: d.who, text: d.text, earlier: true })), ...ls])
      },
      () => (loadedDay.current = false),
    )
  }, [ready, ownerLocked])

  const nameOn = Boolean(wake?.enabled && wake.model.status === 'ready' && wake.aliases.length > 0)
  const wakeActive = Boolean(nameOn || wake?.clap || wake?.whistle) && ready && voice && !onboarding && !ownerLocked && status.mode !== 'quiet'
  useEffect(() => {
    if (!wakeActive) return
    const l = new WakeListener({
      settings: () => {
        const w = wakeViewRef.current
        return {
          aliases: w?.aliases ?? [],
          sensitivity: w?.sensitivity ?? 'normal',
          name: Boolean(w?.enabled && w.model.status === 'ready' && w.aliases.length > 0),
          clap: Boolean(w?.clap),
          whistle: Boolean(w?.whistle),
        }
      },
      onError: m => setWakeError(`Wake word paused: ${m}`),
      onWake: trigger => {
        chime()
        if (!conversationRef.current) convStartRef.current = linesRef.current.length
        conversationRef.current = true
        setConversation(true)
        if (trigger.kind !== 'name') return void startListeningRef.current()
        const { match, audio } = trigger
        // A request said in the same breath ("Atlas, open my email") goes with the burst. The name
        // alone, a repeated name or a stray word or two (often the model mishearing the name) means
        // "listen for it now".
        const w = wakeViewRef.current
        if (wakeRequest(match, w?.aliases ?? [], w?.sensitivity ?? 'normal')) {
          setError('')
          void window.assistant
            .sendVoice(toWav(audio), 'audio/wav')
            .then(r => begin(r.replyId, '🎤 …'), err => setError(cleanError(err, 'Sending your voice failed.')))
        } else void startListeningRef.current()
      },
    })
    wakeRef.current = l
    setWakeError('')
    l.start().catch(err => setWakeError(`Wake word unavailable: ${cleanError(err, 'microphone or model error')}`))
    return () => {
      l.stop()
      wakeRef.current = null
    }
  }, [wakeActive])
  // Never listen for the name over its own voice, or while already listening.
  useEffect(() => {
    wakeRef.current?.pause(conversation || listening || speaking || transcribing || replyId !== null)
  }, [conversation, listening, speaking, transcribing, replyId, wakeActive])

  // Ctrl+Space talks from anywhere in the window; Esc cancels listening or stops the reply.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault()
        toggleMic()
      } else if (e.key === 'Escape') {
        if (liveRef.current.active) liveRef.current.stop()
        else if (conversationRef.current) {
          endConversation()
          interrupt()
        } else if (recordingRef.current) recordingRef.current.stop(false)
        else interrupt()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) void send(e)
  }

  const toggleSpeech = () => {
    if (status.speech.enabled) stopSpeech()
    void window.assistant.setSpeech(!status.speech.enabled)
  }

  const toggleTasks = async () => setTasks(tasks ? null : await window.assistant.listTasks())
  const approval = status.approvals[0]
  const busy = replyId !== null || speaking
  const voicePhase: VoicePhase = speaking ? 'speaking' : transcribing ? 'transcribing' : replyId ? 'thinking' : 'listening'
  /** Captions for voice mode: the owner's last words and the reply that follows them. */
  const captions = (() => {
    const current = conversation ? lines.slice(convStartRef.current) : lines
    const lastOwner = current.findLastIndex(l => l.who === 'owner')
    const owner = lastOwner >= 0 ? current[lastOwner]!.text : ''
    const reply = current.slice(lastOwner + 1).findLast(l => l.who === 'assistant')
    return { you: owner === '🎤 …' ? '' : owner, assistant: reply?.text ?? '' }
  })()
  const state = listening ? 'Listening' : transcribing ? 'Transcribing' : speaking ? 'Speaking' : replyId ? 'Thinking' : PHASE_TEXT[status.phase]
  const presence: Presence['state'] = live.active ? (live.phase === 'speaking' ? 'speaking' : live.phase === 'listening' ? 'listening' : 'thinking') : listening ? 'listening' : speaking ? 'speaking' : replyId || transcribing ? 'thinking' : 'idle'
  useEffect(() => onPresence?.({ state: presence, level: listening ? level : 0 }), [onPresence, presence, level, listening])

  // The desktop widget mirrors this: what Atlas is doing and its newest words. Sent on each change (not on a
  // timer: a minimised window's timers slow to once a minute), the mic level at most about four times a second.
  const lastReply = lines.findLast(l => l.who === 'assistant')?.text ?? ''
  const widgetCaption = presence === 'idle' || presence === 'listening' ? '' : lastReply
  const widgetLevel = Math.round((listening ? level : 0) * 10)
  const widgetSent = useRef({ key: '', at: 0, shape: '' })
  useEffect(() => {
    const shape = `${presence}|${widgetCaption}`
    const key = `${shape}|${widgetLevel}`
    const last = widgetSent.current
    if (key === last.key) return
    // Only the level moved, and very recently: skip this one.
    if (shape === last.shape && Date.now() - last.at < 240) return
    widgetSent.current = { key, at: Date.now(), shape }
    void window.presenceHost.update({ activity: presence, caption: widgetCaption, level: widgetLevel / 10 }).catch(() => undefined)
  }, [presence, widgetCaption, widgetLevel])

  // The widget's Stop and Talk act here, where the microphone and the speech are.
  const widgetAsks = useRef<(c: PresenceCommand) => void>(() => undefined)
  widgetAsks.current = c => {
    // A quick reply pressed on the widget: send it as if typed here.
    if (typeof c === 'object') {
      void sendText(c.say)
      return
    }
    if (liveRef.current.active) {
      if (c === 'stop') liveRef.current.phase === 'speaking' ? liveRef.current.cancel() : liveRef.current.stop()
      return
    }
    if (c === 'talk') {
      if (!conversationRef.current) beginConversation()
      return
    }
    if (conversationRef.current && (speaking || replyId)) {
      void window.assistant.interrupt().catch(() => undefined)
      interrupt()
      void startListeningRef.current()
    } else if (conversationRef.current) endConversation()
    else interrupt()
  }
  useEffect(() => window.presenceHost.onCommand(c => widgetAsks.current(c)), [])
  useEffect(() => {
    const stop = () => widgetAsks.current('stop')
    window.addEventListener(STOP_EVENT, stop)
    return () => window.removeEventListener(STOP_EVENT, stop)
  }, [])

  return (
    // A container: the header adapts to the panel width (side panel, drawer or compact window), not the screen.
    <div className="@container relative flex min-h-0 flex-1 flex-col" style={chatViewVars(chatView)}>
      {chatsOpen && (
        <ChatList
          onClose={() => setChatsOpen(false)}
          onResumed={day => setLines(day.map((d, i): Line => ({ id: 'chat-' + i + '-' + d.at, who: d.who, text: d.text, earlier: true })))}
        />
      )}
      {/* Two tiers, so nothing is clipped at drawer width: who and what now, then the mode. */}
      <header className="border-b border-border px-3 pb-2 pt-1.5 @[420px]:px-4">
        <div className="flex h-9 items-center gap-1.5">
          <span
            className={`size-2 shrink-0 rounded-full ${listening ? 'bg-danger' : ready ? 'bg-accent' : 'bg-muted'} ${replyId || speaking || listening ? 'thinking-dot' : ''}`}
            aria-hidden
          />
          {wakeActive && (
            <span
              className="flex min-w-0 shrink items-center gap-1 truncate rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 text-[11px] text-accent"
              title="Listening for wake triggers on this computer"
            >
              <Ear className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{[nameOn ? wake?.aliases[0] : null, wake?.clap ? '👏👏' : null, wake?.whistle ? 'seeti' : null].filter(Boolean).join(' · ')}</span>
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-muted" role="status">
            {state}
          </span>
          {(replyId !== null || speaking) && (
            <button type="button" onClick={interrupt} className="btn h-7 shrink-0 gap-1 rounded-full border-warm/60 px-2.5 text-xs text-warm" title="Stop the reply (Esc)">
              <Square className="size-3 fill-current" aria-hidden /> Stop
            </button>
          )}
          {voice && (
            <button
              type="button"
              onClick={toggleSpeech}
              aria-pressed={status.speech.enabled}
              aria-label={status.speech.enabled ? 'Mute spoken replies' : 'Speak replies aloud'}
              title={status.mode === 'quiet' ? 'Quiet mode keeps replies on screen' : status.speech.enabled ? 'Spoken replies on: when you talk, and when I speak up. Typed messages get text.' : 'Spoken replies off'}
              className="icon-btn shrink-0"
            >
              {status.speech.enabled ? <SpeakerIcon /> : <MutedIcon />}
            </button>
          )}
          <button type="button" onClick={startNewChat} className="icon-btn shrink-0" aria-label="New chat" title="New chat: start fresh (this one stays in Earlier chats)" disabled={ownerLocked || replyId !== null}>
            <SquarePen className="size-4" aria-hidden />
          </button>
          <ModelChip disabled={ownerLocked} />
          <ChatMenu view={chatView} onView={changeView} onChats={() => setChatsOpen(true)} onControls={onOpenControls} onSetup={onOpenSetup} locked={ownerLocked} />
        </div>
        <ToggleGroup.Root
          type="single"
          value={status.mode}
          onValueChange={v => v && void window.assistant.setMode(v as UiMode)}
          aria-label="Mode"
          className="grid grid-cols-4 rounded-xl border border-border bg-bg p-0.5"
        >
          {MODES.map(m => (
            <ToggleGroup.Item
              key={m}
              value={m}
              className="rounded-lg py-1 text-center text-xs capitalize text-muted transition-colors hover:text-text data-[state=on]:bg-accent-soft data-[state=on]:text-accent"
            >
              {m}
            </ToggleGroup.Item>
          ))}
        </ToggleGroup.Root>
      </header>

      {live.active && (
        <div className="min-h-0 flex-1">
          <VoiceMode
            phase={live.phase === 'connecting' ? 'thinking' : live.phase}
            level={live.level}
            you={live.heard}
            assistant={live.said}
            idleUntil={0}
            name={personality?.profile.assistantName ?? ''}
            note={`Live voice · ${status.speech.live.tier === 'mini' ? 'Mini' : 'Standard'} · ~${live.cost.toFixed(live.cost < 0.1 ? 3 : 2)} of ${status.speech.live.capUsd.toFixed(2)}${live.phase === 'connecting' ? ' · connecting…' : ''}`}
            onEnd={live.stop}
            onKeyboard={live.stop}
            onStop={live.cancel}
          />
        </div>
      )}
      {conversation && !live.active && (
        <div className="min-h-0 flex-1">
          <VoiceMode
            phase={voicePhase}
            level={listening ? level : 0}
            you={captions.you}
            assistant={captions.assistant}
            idleUntil={listening ? idleUntil : 0}
            name={personality?.profile.assistantName ?? ''}
            onEnd={endConversation}
            onKeyboard={endConversation}
            onStop={() => {
              void window.assistant.interrupt().catch(() => undefined)
              interrupt()
              void startListeningRef.current()
            }}
          />
        </div>
      )}
      <main className={`flex flex-1 flex-col gap-[var(--chat-gap)] overflow-y-auto px-3 py-3 @[480px]:px-4 ${conversation || live.active ? 'hidden' : ''}`} aria-live="polite">
        {lines.length === 0 && (
          <p className="pt-16 text-center text-sm text-muted">
            {!ready ? `${PHASE_TEXT[status.phase]}…` : voice ? 'Type, or tap the mic (Ctrl+Space) and talk.' : 'Type to start talking.'}
          </p>
        )}
        {lines[0]?.earlier && <p className="hud-label text-center">Earlier today</p>}
        {lines.map((l, i) => (
          <div key={l.id} className={`rise-in ${l.who === 'owner' ? 'flex flex-wrap justify-end' : ''} ${l.earlier ? 'opacity-70' : ''}`}>
            {!l.earlier && lines[i - 1]?.earlier && <p className="hud-label mb-2 w-full basis-full text-center">Now</p>}
            <div
              className={`text-[length:var(--chat-text)] leading-relaxed ${
                l.who === 'owner'
                  ? chatView.style === 'minimal'
                    ? 'max-w-[var(--chat-max)] rounded-xl bg-accent-soft px-[var(--chat-pad-x)] py-[var(--chat-pad-y)] text-text'
                    : 'max-w-[var(--chat-max)] rounded-2xl rounded-br-md bg-linear-to-br from-cyan-300 to-sky-500 px-[var(--chat-pad-x)] py-[var(--chat-pad-y)] text-slate-950 shadow-[0_0_18px_rgba(34,211,238,0.2)]'
                  : chatView.style === 'minimal'
                    ? 'max-w-full border-l-2 border-accent/50 py-0.5 pl-3'
                    : 'tile max-w-[var(--chat-max)] rounded-2xl rounded-bl-md px-[var(--chat-pad-x)] py-[var(--chat-pad-y)]'
              }`}
            >
              {l.actions?.map((a, i) => (
                <span key={i} className="mb-1 flex items-center gap-1.5 font-mono text-[11px] text-muted">
                  <span className={`size-1.5 rounded-full ${a.status === 'done' ? 'bg-ok' : a.status === 'running' ? 'thinking-dot bg-accent' : 'bg-danger'}`} aria-hidden />
                  {a.tool}: {a.status}
                  {a.detail && a.status !== 'done' ? ` (${a.detail})` : ''}
                </span>
              ))}
              {l.text ? l.who === 'assistant' ? <Markdown text={l.text} /> : <span dir="auto" className="whitespace-pre-wrap">{l.text}</span> : l.id === replyId ? <span className="thinking-dot text-muted">…</span> : ''}
              {l.note && <span className="mt-1 block text-xs text-muted">{l.note}</span>}
              {l.item && <InitiativeControls item={l.item} speaking={l.id === replyId || (speaking && l === lines.at(-1))} onStop={interrupt} />}
            </div>
          </div>
        ))}
        {suggest && lines.at(-1)?.id === suggest.replyId && !replyId && (
          <div className="rise-in flex flex-wrap gap-1.5 pl-1" role="group" aria-label="Quick replies">
            {suggest.options.map(o => (
              <button
                key={o}
                type="button"
                dir="auto"
                onClick={() => void sendText(o)}
                className="rounded-full border border-accent/40 bg-accent-soft px-3 py-1 text-xs text-accent transition-colors hover:border-accent hover:bg-accent hover:text-accent-fg"
              >
                {o}
              </button>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </main>

      {approval && <ApprovalCard key={approval.id} request={approval} />}

      {tasks && (
        <section className="max-h-40 overflow-y-auto border-t border-border px-5 py-2 text-sm">
          {tasks.length === 0 ? (
            <p className="text-muted">No open tasks.</p>
          ) : (
            <ul className="space-y-1">
              {tasks.map(t => (
                <li key={t.id} className="flex justify-between gap-2">
                  <span>{t.title}</span>
                  <span className="text-xs text-muted">{t.dueAt ? new Date(t.dueAt).toLocaleString() : t.status}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {showLater && (
        <section className="max-h-48 overflow-y-auto border-t border-border px-5 py-2 text-sm" aria-label="Held back for later">
          <LaterList items={status.later} />
        </section>
      )}

      {conversation ? null : onboarding ? (
        <Onboarding voice={voice} ownerName={status.setup.ownerName} say={say} answer={answer} interrupt={stopPrompt} onDone={welcome} />
      ) : (
      <form onSubmit={send} className="border-t border-border p-3">
        {error && <p className="mb-2 text-xs text-danger">{error}</p>}
        {wakeError && !error && <p className="mb-2 text-xs text-warm">{wakeError}</p>}
        <div className="flex items-end gap-2">
          <button type="button" onClick={() => void toggleTasks()} className="btn h-9" aria-pressed={Boolean(tasks)}>
            Tasks
          </button>
          {(status.later.length > 0 || showLater) && (
            <button
              type="button"
              onClick={() => setShowLater(v => !v)}
              className="btn h-9"
              aria-pressed={showLater}
              title="Things I held back (quiet mode, focus, quiet hours, budget)"
            >
              Later{status.later.length ? ` (${status.later.length})` : ''}
            </button>
          )}
          {listening ? (
            <button
              type="button"
              onClick={toggleMic}
              className="flex h-9 flex-1 items-center gap-2 rounded-[0.625rem] border border-warm/60 bg-warm/10 px-3 text-left text-sm text-warm"
              aria-label="Listening; tap to send now, Esc to cancel"
            >
              <span className="flex h-4 items-end gap-0.5" aria-hidden>
                {[0.6, 1, 0.8].map((k, i) => (
                  <span key={i} className="w-1 rounded-sm bg-warm" style={{ height: `${Math.max(15, Math.min(100, level * 100 * k * 1.6))}%` }} />
                ))}
              </span>
              Listening… tap to send, Esc to cancel
            </button>
          ) : (
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={onKey}
              rows={1}
              maxLength={8000}
              placeholder={!ready ? 'Waiting for the runtime…' : transcribing ? 'Transcribing…' : 'Message…'}
              aria-label="Message"
              className="field max-h-32 min-h-9 flex-1 resize-none py-1.5"
            />
          )}
          {canTalk && !draft.trim() && (
            <button
              type="button"
              onClick={toggleMic}
              disabled={!ready || transcribing}
              aria-label={listening ? 'Send what you said' : 'Talk (Ctrl+Space)'}
              title="Talk (Ctrl+Space)"
              className={`btn h-9 ${listening ? 'btn-danger' : 'text-accent'}`}
            >
              <MicIcon />
            </button>
          )}
          {busy && !listening ? (
            <button type="button" onClick={interrupt} className="btn btn-danger h-9">
              Stop
            </button>
          ) : (
            (draft.trim() || !canTalk) && (
              <button type="submit" disabled={!ready || !draft.trim()} className="btn btn-primary h-9">
                Send
              </button>
            )
          )}
        </div>
      </form>
      )}
    </div>
  )
}

/** Short, actionable wording for the common voice provider failures. */
const voiceProblem = (message: string) => {
  if (/\b401\b|quota|credits|character/i.test(message)) return 'Voice reply skipped: your voice provider credits (or key) ran out. Text still works; add credits or a new key in Setup › Connection.'
  if (/\b402\b|paid_plan/i.test(message)) return 'Voice reply skipped: this voice needs a paid ElevenLabs plan. Pick a premade voice in Setup.'
  if (/\b429\b/.test(message)) return 'Voice reply skipped: ElevenLabs is rate limiting. Try again shortly.'
  return 'Voice reply skipped: ElevenLabs could not be reached.'
}

const MicIcon = () => <Mic className="size-4" aria-hidden />
const SpeakerIcon = () => <Volume2 className="size-4" aria-hidden />
const MutedIcon = () => <VolumeX className="size-4" aria-hidden />

/** The policy gate asked before running a tool; nothing runs until the owner answers. */
function ApprovalCard({ request }: { request: ApprovalRequest }) {
  const [busy, setBusy] = useState(false)
  const answer = async (approved: boolean) => {
    setBusy(true)
    try {
      await window.assistant.answerApproval(request.id, approved)
    } catch {
      // Already answered, expired or the runtime restarted: the status update removes the card.
      setBusy(false)
    }
  }
  return (
    <section role="alertdialog" aria-labelledby={`ap-${request.id}`} className="rise-in mx-3 mb-2 rounded-2xl border border-warm/50 bg-warm/10 p-3 text-sm shadow-[0_0_30px_rgba(251,191,36,0.15)]">
      <p id={`ap-${request.id}`} className="font-medium" dir="auto">
        {request.question ?? (
          <>
            Allow <span className="font-mono">{request.tool}</span>?
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-muted">
        {request.actionClass} · {request.reason}
      </p>
      <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg p-2 text-xs">{request.input}</pre>
      <div className="mt-3 flex justify-end gap-2">
        <span className="mr-auto self-center text-[11px] text-muted">Or just say or type haan / nahi</span>
        <button type="button" disabled={busy} onClick={() => void answer(false)} className="btn">
          Decline
        </button>
        <button type="button" disabled={busy} onClick={() => void answer(true)} className="btn btn-primary">
          Allow once
        </button>
      </div>
    </section>
  )
}
