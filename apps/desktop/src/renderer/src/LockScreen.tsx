import { Fingerprint, Loader2, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import { CHALLENGE, type IdentityView, type VerifyResult } from '../../shared/identity.ts'
import { promptLanguageFor, type PromptLanguage } from '../../shared/personality.ts'
import { Orb } from './ui/Orb.tsx'

const TEXT: Record<PromptLanguage, { placeholder: string; check: string; wrong: (n: number) => string; lockedOut: (m: number) => string; failed: string; approved: string; hello: string; helloWait: string; helloNo: string }> = {
  en: {
    placeholder: 'Security code',
    check: 'Confirm',
    wrong: n => `That's not it. ${n} ${n === 1 ? 'try' : 'tries'} left.`,
    lockedOut: m => `Too many wrong tries. Try again in ${m} min.`,
    failed: 'That did not work. Type the code instead.',
    approved: 'Approved ✓',
    hello: 'Use Windows Hello',
    helloWait: 'Look at the camera or touch the fingerprint sensor…',
    helloNo: 'Windows Hello did not confirm it. Try again or type the code.',
  },
  'ur-Latn': {
    placeholder: 'Security code',
    check: 'Confirm',
    wrong: n => `Ye sahi nahi. ${n} koshish baqi.`,
    lockedOut: m => `Bohat ghalat koshishein. ${m} minute baad dobara karein.`,
    failed: 'Nahi hua. Code likh dein.',
    approved: 'Approved ✓',
    hello: 'Windows Hello se',
    helloWait: 'Camera ki taraf dekhein ya fingerprint sensor chhuen…',
    helloNo: 'Windows Hello ne confirm nahi kiya. Dobara karein ya code likhein.',
  },
  'ur-Arab': {
    placeholder: 'سیکیورٹی کوڈ',
    check: 'تصدیق',
    wrong: n => `یہ درست نہیں۔ ${n} کوشش باقی۔`,
    lockedOut: m => `بہت غلط کوششیں۔ ${m} منٹ بعد دوبارہ کریں۔`,
    failed: 'نہیں ہوا۔ کوڈ لکھ دیں۔',
    approved: 'منظور ✓',
    hello: 'ونڈوز ہیلو سے',
    helloWait: 'کیمرے کی طرف دیکھیں یا فنگر پرنٹ سینسر چھوئیں…',
    helloNo: 'ونڈوز ہیلو نے تصدیق نہیں کی۔ دوبارہ کریں یا کوڈ لکھیں۔',
  },
}

/**
 * "Is that you?" Full-window gate while the owner check waits. Nothing
 * private is on screen. The owner types the code (compared in main, never
 * echoed), or confirms with Windows Hello (face, fingerprint or PIN) when
 * they turned it on: it starts by itself as soon as they are at the PC.
 * Nothing is asked aloud and the microphone is not used.
 */
export function LockScreen({ view, ownerName }: { view: IdentityView; ownerName: string; voice?: boolean }) {
  const [language, setLanguage] = useState<PromptLanguage>('en')
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [helloBusy, setHelloBusy] = useState(false)
  const [approved, setApproved] = useState(false)
  const [now, setNow] = useState(Date.now())
  const asked = useRef<number | null>(null)
  const t = TEXT[language]
  const lockedOut = view.lockoutUntil !== null && view.lockoutUntil > now
  const helloOn = view.hello && view.helloAvailable

  // The clock ticks only while a lockout counts down, and not while the window is hidden.
  useEffect(() => {
    const until = view.lockoutUntil
    if (until === null || until <= Date.now()) return
    setNow(Date.now())
    const tick = () => {
      if (document.hidden) return
      setNow(Date.now())
      if (Date.now() > until) clearInterval(timer)
    }
    const timer = setInterval(tick, 1000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [view.lockoutUntil])

  // The owner's language for the text, as soon as it is known.
  useEffect(() => {
    void window.personality.get().then(p => setLanguage(p ? promptLanguageFor(p.profile.language) : 'en'), () => undefined)
  }, [])

  const useHello = async () => {
    if (helloBusy) return
    setHelloBusy(true)
    setMessage(t.helloWait)
    try {
      const r = await window.identity.hello()
      if (r.ok) {
        setApproved(true)
        setMessage(t.approved)
      } else setMessage(r.result === 'Canceled' ? '' : t.helloNo)
    } catch {
      setMessage(t.failed)
    } finally {
      setHelloBusy(false)
    }
  }

  // The owner is at the PC (woke it, unlocked Windows, opened Atlas): Windows Hello asks by itself.
  useEffect(() => {
    if (view.askNow === null || asked.current === view.askNow || !helloOn || lockedOut) return
    asked.current = view.askNow
    void useHello()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per ask
  }, [view.askNow, helloOn])

  const show = (r: VerifyResult) => {
    if (r.ok) {
      setApproved(true)
      setMessage(t.approved)
      return
    }
    setCode('')
    if (r.reason === 'locked-out' || r.lockoutUntil) setMessage(t.lockedOut(Math.max(1, Math.ceil(((r.lockoutUntil ?? now) - Date.now()) / 60_000))))
    else setMessage(t.wrong(r.attemptsLeft))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!code.trim() || busy || lockedOut) return
    setBusy(true)
    try {
      show(await window.identity.verify(code))
    } catch {
      setMessage(t.failed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full w-full items-center justify-center p-6" dir={language === 'ur-Arab' ? 'rtl' : undefined}>
      <section className="glass rise-in flex w-full max-w-md flex-col items-center rounded-3xl px-8 pb-8 pt-6 text-center" aria-labelledby="lock-title">
        <Orb state={approved ? 'speaking' : busy || helloBusy ? 'thinking' : 'idle'} level={0} size={170} />
        <h1 id="lock-title" className="mt-1 text-lg font-semibold">
          {CHALLENGE[language](ownerName)}
        </h1>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
          <ShieldCheck className="size-3.5" aria-hidden />
          Private briefings and actions wait until you confirm.
        </p>

        {helloOn && (
          <button type="button" onClick={() => void useHello()} disabled={helloBusy || approved || lockedOut} className="btn btn-primary mt-5 h-11 w-full gap-2 text-sm">
            {helloBusy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Fingerprint className="size-5" aria-hidden />}
            {t.hello}
          </button>
        )}

        <form onSubmit={e => void submit(e)} className={`${helloOn ? 'mt-3' : 'mt-5'} flex w-full gap-2`}>
          <input
            type="password"
            value={code}
            onChange={e => setCode(e.target.value)}
            autoFocus={!helloOn}
            autoComplete="off"
            spellCheck={false}
            maxLength={120}
            disabled={busy || lockedOut || approved}
            placeholder={t.placeholder}
            aria-label={t.placeholder}
            className="field flex-1 text-center tracking-widest"
          />
          <button type="submit" disabled={!code.trim() || busy || lockedOut || approved} className={`btn h-9 ${helloOn ? '' : 'btn-primary'}`}>
            {t.check}
          </button>
        </form>

        <p role="status" aria-live="polite" className={`mt-3 min-h-5 text-sm ${approved ? 'text-ok' : helloBusy ? 'text-accent' : 'text-warm'}`}>
          {lockedOut && !message ? t.lockedOut(Math.max(1, Math.ceil((view.lockoutUntil! - now) / 60_000))) : message}
        </p>
      </section>
    </div>
  )
}
