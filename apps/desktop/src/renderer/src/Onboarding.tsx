import { useEffect, useRef, useState, type FormEvent } from 'react'

import { extractName, parseName, type PersonalityProfile } from '@assistant/shared'

import {
  ASK_CHOICES,
  CHOICES,
  ONBOARDING_STEPS,
  promptLanguageFor,
  QUESTIONS,
  UI_TEXT,
  type OnboardingStep,
  type PromptLanguage,
} from '../../shared/personality.ts'
import { record, type Recording } from './audio.ts'

const cleanError = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback

type ChoiceStep = keyof typeof CHOICES
const isChoice = (s: OnboardingStep): s is ChoiceStep => s in CHOICES
const isIdentityStep = (s: OnboardingStep) => s === 'securityCode' || s === 'identityAsk'

export interface OnboardingProps {
  /** A voice provider is configured: questions are spoken and names can be said. */
  voice: boolean
  ownerName: string
  /** Show a line in the conversation; questions are also spoken. */
  say: (text: string, speak?: { step: OnboardingStep; language: PromptLanguage }) => void
  answer: (text: string) => void
  /** Stop any question still being spoken. */
  interrupt: () => void
  /** Profile saved and onboarding marked done: start the welcome reply. */
  onDone: () => void
}

/**
 * First-run onboarding as a short scripted conversation in the companion.
 * Every question can be skipped; the answers are saved once, as one profile
 * version, at the end. The words come from a fixed table, so nothing here
 * goes through the model until the welcome.
 */
export function Onboarding({ voice, ownerName, say, answer, interrupt, onDone }: OnboardingProps) {
  const [index, setIndex] = useState(0)
  const [language, setLanguage] = useState<PromptLanguage>('en')
  const [patch, setPatch] = useState<Partial<PersonalityProfile>>({})
  const [text, setText] = useState('')
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [showCode, setShowCode] = useState(false)
  /** A code already exists (onboarding re-run from Setup): the identity steps are skipped. */
  const [codeExists, setCodeExists] = useState<boolean | null>(null)
  const asked = useRef(-1)
  const recording = useRef<Recording | null>(null)
  const step = ONBOARDING_STEPS[index]

  // Ask each question once, in the language chosen so far.
  useEffect(() => {
    if (!step || asked.current === index || codeExists === null || (isIdentityStep(step) && codeExists)) return
    asked.current = index
    say(QUESTIONS[step][language], { step, language })
    setText('')
    setError('')
  }, [index, step, language, say])

  useEffect(() => () => recording.current?.stop(false), [])

  useEffect(() => {
    void window.identity.get().then(v => setCodeExists(v.configured), () => setCodeExists(false))
  }, [])

  // Identity steps are skipped when a code already exists; change it in Setup instead.
  useEffect(() => {
    if (step && isIdentityStep(step) && codeExists) {
      if (index + 1 >= ONBOARDING_STEPS.length) void finish(patch)
      else setIndex(index + 1)
    }
  })

  const finish = async (final: Partial<PersonalityProfile>) => {
    interrupt()
    recording.current?.stop(false)
    setSaving(true)
    setError('')
    try {
      if (Object.keys(final).length > 0) await window.personality.update(final, 'onboarding')
      await window.personality.setOnboarded(true)
      say(UI_TEXT.done[language])
      onDone()
    } catch (err) {
      setSaving(false)
      setError(cleanError(err, 'Saving failed. Try again.'))
    }
  }

  const advance = (next: Partial<PersonalityProfile>) => {
    setPatch(next)
    if (index + 1 >= ONBOARDING_STEPS.length) void finish(next)
    else setIndex(index + 1)
  }

  const choose = (value: PersonalityProfile[ChoiceStep], label: string) => {
    if (!step) return
    interrupt()
    answer(label)
    if (step === 'language') setLanguage(promptLanguageFor(value as PersonalityProfile['language']))
    advance({ ...patch, [step]: value })
  }

  const skip = () => {
    interrupt()
    answer(`(${UI_TEXT.skip[language]})`)
    // No code means nothing to ask for: skip "when should I ask" too.
    if (step === 'securityCode') {
      if (index + 2 >= ONBOARDING_STEPS.length) void finish(patch)
      else setIndex(index + 2)
      return
    }
    advance(patch)
  }

  /** The code goes straight to main to be hashed; the conversation only shows that it was saved. */
  const saveCode = async (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    interrupt()
    setSaving(true)
    setError('')
    try {
      await window.identity.setCode(text)
      setText('')
      setShowCode(false)
      answer(UI_TEXT.codeSaved[language])
      advance(patch)
    } catch (err) {
      setError(cleanError(err, 'The code could not be saved.'))
    } finally {
      setSaving(false)
    }
  }

  const chooseAsk = async (value: (typeof ASK_CHOICES)[number]['value'], label: string) => {
    interrupt()
    try {
      await window.identity.setAskWhen(value)
      answer(label)
      advance(patch)
    } catch (err) {
      setError(cleanError(err, 'Could not save that.'))
    }
  }

  const submitName = (e: FormEvent) => {
    e.preventDefault()
    if (!step || isChoice(step)) return
    const name = parseName(text)
    if (name === null) return setError('Use letters, numbers, spaces, dots, apostrophes or hyphens (up to 40).')
    if (!name) return skip()
    interrupt()
    answer(name)
    advance({ ...patch, [step]: name })
  }

  const talk = async () => {
    if (recording.current) return recording.current.stop(true)
    interrupt()
    setError('')
    try {
      recording.current = await record({
        onEnd: async result => {
          recording.current = null
          setListening(false)
          if (!result) return
          setTranscribing(true)
          try {
            const heard = await window.personality.transcribe(result.audio, result.mime)
            setText(extractName(heard) || text)
            if (!extractName(heard)) setError('I didn’t catch a name. Try again or type it.')
          } catch (err) {
            setError(cleanError(err, 'Could not transcribe.'))
          } finally {
            setTranscribing(false)
          }
        },
      })
      setListening(true)
    } catch {
      recording.current = null
      setError('Microphone unavailable. You can type instead.')
    }
  }

  if (!step) return null
  const t = (k: keyof typeof UI_TEXT) => UI_TEXT[k][language]
  const rtl = language === 'ur-Arab'

  return (
    <section className="border-t border-border p-3" aria-label="First-time setup" dir={rtl ? 'rtl' : undefined}>
      {error && <p className="mb-2 text-xs text-danger">{error}</p>}
      {step === 'securityCode' ? (
        <form onSubmit={e => void saveCode(e)} className="flex items-end gap-2">
          <input
            type={showCode ? 'text' : 'password'}
            value={text}
            onChange={e => setText(e.target.value)}
            maxLength={120}
            autoFocus
            autoComplete="new-password"
            spellCheck={false}
            disabled={saving}
            placeholder={UI_TEXT.codePlaceholder[language]}
            aria-label={QUESTIONS.securityCode[language]}
            className="field flex-1"
          />
          <button type="button" className="btn h-9" onClick={() => setShowCode(v => !v)} aria-pressed={showCode}>
            {showCode ? 'Hide' : 'Show'}
          </button>
          <button type="submit" disabled={saving || text.trim().length < 4} className="btn btn-primary h-9">
            {t('next')}
          </button>
        </form>
      ) : step === 'identityAsk' ? (
        <div className="flex flex-wrap gap-2">
          {ASK_CHOICES.map(c => (
            <button
              key={c.value}
              type="button"
              disabled={saving}
              onClick={() => void chooseAsk(c.value, c.label[language])}
              className="btn rounded-full border-accent/50 bg-accent-soft px-3.5 text-sm text-accent hover:!bg-accent hover:!text-accent-fg"
            >
              {c.label[language]}
            </button>
          ))}
        </div>
      ) : isChoice(step) ? (
        <div className="flex flex-wrap gap-2">
          {CHOICES[step].map(c => (
            <button
              key={String(c.value)}
              type="button"
              disabled={saving}
              onClick={() => choose(c.value, c.label[language])}
              className="btn rounded-full border-accent/50 bg-accent-soft px-3.5 text-sm text-accent hover:!bg-accent hover:!text-accent-fg"
            >
              {c.label[language]}
            </button>
          ))}
        </div>
      ) : (
        <form onSubmit={submitName} className="flex items-end gap-2">
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            maxLength={40}
            autoFocus
            disabled={saving || listening}
            placeholder={listening ? '…' : transcribing ? 'Transcribing…' : step === 'ownerNickname' && ownerName ? ownerName : t('typeOrTalk')}
            aria-label={QUESTIONS[step][language]}
            className="field flex-1"
          />
          {voice && (
            <button
              type="button"
              onClick={() => void talk()}
              disabled={saving || transcribing}
              aria-label={listening ? 'Stop listening' : 'Say it'}
              className={`btn h-9 ${listening ? 'btn-danger' : 'text-accent'}`}
            >
              {listening ? '■' : '🎤'}
            </button>
          )}
          <button type="submit" disabled={saving || !text.trim()} className="btn btn-primary h-9">
            {t('next')}
          </button>
        </form>
      )}
      <div className="mt-2 flex justify-between text-xs text-muted">
        <span>
          {index + 1} / {ONBOARDING_STEPS.length}
        </span>
        <span className="flex gap-3">
          <button type="button" disabled={saving} onClick={skip} className="hover:text-text">
            {t('skip')}
          </button>
          <button type="button" disabled={saving} onClick={() => void finish(patch)} className="hover:text-text">
            {t('skipAll')}
          </button>
        </span>
      </div>
    </section>
  )
}
