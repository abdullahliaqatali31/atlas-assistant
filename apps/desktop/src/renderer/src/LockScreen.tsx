import { Mic, ShieldCheck, Square } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { CHALLENGE, type IdentityView, type VerifyResult } from '../../shared/identity.ts'
import { promptLanguageFor, type PromptLanguage } from '../../shared/personality.ts'
import { record, SentencePlayer, type Recording } from './audio.ts'
import { Orb } from './ui/Orb.tsx'

const TEXT: Record<PromptLanguage, { placeholder: string; check: string; wrong: (n: number) => string; lockedOut: (m: number) => string; notHeard: string; approved: string; say: string }> = {
  en: {
    placeholder: 'Security code',
    check: 'Confirm',
    wrong: n => `That's not it. ${n} ${n === 1 ? 'try' : 'tries'} left.`,
    lockedOut: m => `Too many wrong tries. Try again in ${m} min.`,
    notHeard: "I didn't catch that. Try again, or type it.",
    approved: 'Approved ✓',
    say: 'Say it',
  },
  'ur-Latn': {
    placeholder: 'Security code',
    check: 'Confirm',
    wrong: n => `Ye sahi nahi. ${n} koshish baqi.`,
    lockedOut: m => `Bohat ghalat koshishein. ${m} minute baad dobara karein.`,
    notHeard: 'Samajh nahi aaya. Dobara bolein ya likh dein.',
    approved: 'Approved ✓',
    say: 'Bolein',
  },
  'ur-Arab': {
    placeholder: 'سیکیورٹی کوڈ',
    check: 'تصدیق',
    wrong: n => `یہ درست نہیں۔ ${n} کوشش باقی۔`,
    lockedOut: m => `بہت غلط کوششیں۔ ${m} منٹ بعد دوبارہ کریں۔`,
    notHeard: 'سمجھ نہیں آیا۔ دوبارہ بولیں یا لکھ دیں۔',
    approved: 'منظور ✓',
    say: 'بولیں',
  },
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** Hands-free listens per ask: the first answer plus retries after "didn't catch that" or a wrong word. */
const AUTO_LISTENS = 3

/**
 * "Is that you?" Full-window gate while the owner check waits. Nothing
 * private is on screen; the code is compared in main and never echoed.
 * When main says the owner is there (`askNow`), it asks aloud and then
 * listens on its own: no click needed. Typing always works too.
 */
export function LockScreen({ view, ownerName, voice }: { view: IdentityView; ownerName: string; voice: boolean }) {
  const [language, setLanguage] = useState<PromptLanguage>('en')
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [level, setLevel] = useState(0)
  const [approved, setApproved] = useState(false)
  const [now, setNow] = useState(Date.now())
  const recording = useRef<Recording | null>(null)
  const playerRef = useRef<SentencePlayer | null>(null)
  const asked = useRef<number | null>(null)
  const autoLeft = useRef(0)
  const alive = useRef(true)
  const t = TEXT[language]
  const lockedOut = view.lockoutUntil !== null && view.lockoutUntil > now

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // The owner's language for the text, as soon as it is known.
  useEffect(() => {
    alive.current = true
    void window.personality.get().then(p => setLanguage(p ? promptLanguageFor(p.profile.language) : 'en'), () => undefined)
    return () => {
      alive.current = false
      recording.current?.stop(false)
      playerRef.current?.stop()
    }
  }, [])

  /** Speaks the fixed question and resolves once it has finished playing, so the microphone does not hear it. */
  const sayChallenge = async (lang: PromptLanguage) => {
    const player = (playerRef.current ??= new SentencePlayer(() => undefined))
    let done = false
    const off = window.assistant.onReply(e => {
      if (e.type === 'audio') void player.add(e.replyId, e.seq, e.data).catch(() => undefined)
      if (e.type === 'done') done = true
    })
    try {
      const r = await window.identity.speakChallenge(lang).catch(() => null)
      if (!r) return
      const started = Date.now()
      while (alive.current && (!done || player.isBusy) && Date.now() - started < 20_000) await sleep(150)
      await sleep(300)
    } finally {
      off()
    }
  }

  // Main says the owner is here (woke the laptop, unlocked Windows, opened Atlas): ask aloud, then listen.
  useEffect(() => {
    if (view.askNow === null || asked.current === view.askNow || !voice) return
    asked.current = view.askNow
    void (async () => {
      const p = await window.personality.get().catch(() => null)
      const lang = p ? promptLanguageFor(p.profile.language) : 'en'
      setLanguage(lang)
      await sayChallenge(lang)
      if (!alive.current || view.lockoutUntil !== null) return
      autoLeft.current = AUTO_LISTENS
      void talk(true)
    })()
  }, [view.askNow, voice])

  const show = (r: VerifyResult) => {
    if (r.ok) {
      setApproved(true)
      setMessage(t.approved)
      return
    }
    // Hands-free: listen again after a miss, while tries and the auto budget last.
    if (r.reason !== 'locked-out' && !r.lockoutUntil && autoLeft.current > 0) setTimeout(() => alive.current && void talk(true), 900)
    setCode('')
    if (r.reason === 'locked-out' || r.lockoutUntil) setMessage(t.lockedOut(Math.max(1, Math.ceil(((r.lockoutUntil ?? now) - Date.now()) / 60_000))))
    else if (r.reason === 'not-heard') setMessage(t.notHeard)
    else setMessage(t.wrong(r.attemptsLeft))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!code.trim() || busy || lockedOut) return
    setBusy(true)
    playerRef.current?.stop()
    try {
      show(await window.identity.verify(code))
    } catch {
      setMessage(t.notHeard)
    } finally {
      setBusy(false)
    }
  }

  /** `auto`: started by the assistant, not a click; spends one hands-free listen. */
  const talk = async (auto = false) => {
    if (recording.current) {
      if (!auto) recording.current.stop(true)
      return
    }
    if (auto) {
      if (autoLeft.current <= 0) return
      autoLeft.current--
    } else autoLeft.current = 0
    playerRef.current?.stop()
    setMessage('')
    try {
      recording.current = await record({
        onLevel: setLevel,
        onEnd: async result => {
          recording.current = null
          setListening(false)
          if (!result) {
            setMessage(t.notHeard)
            if (autoLeft.current > 0 && alive.current) setTimeout(() => alive.current && void talk(true), 600)
            return
          }
          setBusy(true)
          try {
            show(await window.identity.verifyVoice(result.audio, result.mime))
          } catch {
            setMessage(t.notHeard)
          } finally {
            setBusy(false)
          }
        },
      })
      setListening(true)
    } catch {
      setMessage('Microphone unavailable. Type the code instead.')
    }
  }

  return (
    <div className="flex h-full w-full items-center justify-center p-6" dir={language === 'ur-Arab' ? 'rtl' : undefined}>
      <section className="glass rise-in flex w-full max-w-md flex-col items-center rounded-3xl px-8 pb-8 pt-6 text-center" aria-labelledby="lock-title">
        <Orb state={approved ? 'speaking' : listening ? 'listening' : busy ? 'thinking' : 'idle'} level={level} size={170} />
        <h1 id="lock-title" className="mt-1 text-lg font-semibold">
          {CHALLENGE[language](ownerName)}
        </h1>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
          <ShieldCheck className="size-3.5" aria-hidden />
          Private briefings and actions wait until you confirm.
        </p>

        <form onSubmit={e => void submit(e)} className="mt-5 flex w-full gap-2">
          <input
            type="password"
            value={code}
            onChange={e => setCode(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            maxLength={120}
            disabled={busy || lockedOut || approved || listening}
            placeholder={t.placeholder}
            aria-label={t.placeholder}
            className="field flex-1 text-center tracking-widest"
          />
          {voice && (
            <button
              type="button"
              onClick={() => void talk()}
              disabled={busy || lockedOut || approved}
              className={`btn h-9 ${listening ? 'btn-danger' : 'text-accent'}`}
              aria-label={listening ? 'Stop and check' : t.say}
              title={t.say}
            >
              {listening ? <Square className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}
            </button>
          )}
          <button type="submit" disabled={!code.trim() || busy || lockedOut || approved} className="btn btn-primary h-9">
            {t.check}
          </button>
        </form>

        <p role="status" aria-live="polite" className={`mt-3 min-h-5 text-sm ${approved ? 'text-ok' : 'text-warm'}`}>
          {lockedOut && !message ? t.lockedOut(Math.max(1, Math.ceil((view.lockoutUntil! - now) / 60_000))) : message}
        </p>
      </section>
    </div>
  )
}
