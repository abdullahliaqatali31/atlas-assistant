/**
 * Settings › Security › Voice ID: download the voice model, read five phrases
 * to enrol, check "who am I?", add family, and choose whether only the
 * owner's voice wakes Atlas. Only voice prints are kept, encrypted.
 */
import { AudioLines, Mic, Trash2, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ENROL_PHRASES, PHRASES, samplesToBytes, type SpeakerResult, type SpeakerView } from '../../../shared/speaker.ts'
import { record } from '../audio.ts'
import { nameOf } from '../ui/assistantName.ts'
import { toPcm16k } from './voiceId.ts'

const clean = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.')

/** One utterance from the shared mic, ended by a pause, as 16 kHz samples. */
const recordOnce = () =>
  new Promise<Float32Array | null>((resolve, reject) => {
    void record({
      silenceMs: 1100,
      noSpeechMs: 8000,
      maxMs: 15_000,
      onEnd: result => (result ? toPcm16k(result.audio).then(resolve, reject) : resolve(null)),
    }).catch(reject)
  })

const VERDICT: Record<SpeakerResult['verdict'], string> = {
  owner: 'You (the owner)',
  known: 'Someone you added',
  guest: 'Not you',
  unsure: 'Not sure',
}

export function VoiceIdCard() {
  const [view, setView] = useState<SpeakerView | null>(null)
  const [ownerName, setOwnerName] = useState('')
  const [enrolling, setEnrolling] = useState<{ name: string; owner: boolean; phrases: Float32Array[] } | null>(null)
  const [recording, setRecording] = useState(false)
  const [newName, setNewName] = useState('')
  const [check, setCheck] = useState<SpeakerResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.speaker.state().then(setView, e => setError(clean(e)))
    void window.assistant.status().then(st => setOwnerName(st.setup.ownerName), () => undefined)
    return window.speaker.onChanged(setView)
  }, [])

  const run = async (fn: () => Promise<SpeakerView>) => {
    setError('')
    try {
      setView(await fn())
    } catch (e) {
      setError(clean(e))
    }
  }

  const nextPhrase = async () => {
    if (!enrolling) return
    setError('')
    setRecording(true)
    try {
      const pcm = await recordOnce()
      if (!pcm || pcm.length < 16_000 * 1.2) return setError('I didn’t hear enough. Read the whole sentence, a little closer to the mic.')
      const phrases = [...enrolling.phrases, pcm]
      if (phrases.length < ENROL_PHRASES) return setEnrolling({ ...enrolling, phrases })
      await run(() => window.speaker.enrol(enrolling.name, enrolling.owner, phrases.map(samplesToBytes)))
      setEnrolling(null)
    } catch (e) {
      setError(clean(e))
    } finally {
      setRecording(false)
    }
  }

  const whoAmI = async () => {
    setError('')
    setCheck(null)
    setRecording(true)
    try {
      const pcm = await recordOnce()
      if (!pcm) return setError('I didn’t hear anything.')
      setCheck(await window.speaker.identify(samplesToBytes(pcm)))
    } catch (e) {
      setError(clean(e))
    } finally {
      setRecording(false)
    }
  }

  if (!view) return null
  const owner = view.people.find(p => p.owner)
  const m = view.model
  return (
    <section className="tile space-y-3 p-4">
      <header className="flex items-center gap-2.5">
        <span className="inline-flex size-9 items-center justify-center rounded-xl border border-border bg-surface-strong text-accent">
          <AudioLines className="size-[18px]" />
        </span>
        <h2 className="font-medium">Voice ID</h2>
        {owner && view.enabled && <span className="ml-auto rounded-full border border-ok/50 bg-ok/10 px-2 py-0.5 text-[11px] text-ok">on</span>}
      </header>
      <p className="text-xs text-muted">
        {nameOf()} knows who is speaking: personal answers for you, general help for anyone else. Only a voice print is kept (encrypted, on this PC), never recordings. It is never a lock:
        sending, paying and deleting still ask you, because voices can be imitated.
      </p>

      {m.status !== 'ready' ? (
        <div className="space-y-1.5">
          <button type="button" className="btn btn-primary" disabled={m.status === 'downloading'} onClick={() => void run(() => window.speaker.download())}>
            {m.status === 'downloading' ? `Downloading… ${Math.round(m.progress * 100)}%` : `Download the voice model (${Math.round(m.bytes / 1_000_000)} MB, once)`}
          </button>
          {m.error && <p className="text-xs text-danger">{m.error}</p>}
        </div>
      ) : enrolling ? (
        <div className="space-y-2 rounded-xl border border-accent/40 bg-accent/10 p-3">
          <p className="text-xs text-muted">
            {enrolling.owner ? 'Your voice' : enrolling.name}: phrase {enrolling.phrases.length + 1} of {ENROL_PHRASES}. Read it in your normal voice, then pause.
          </p>
          <p className="text-sm font-medium">“{PHRASES[enrolling.phrases.length % PHRASES.length]}”</p>
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary" disabled={recording} onClick={() => void nextPhrase()}>
              <Mic className="size-3.5" aria-hidden /> {recording ? 'Listening…' : 'Record'}
            </button>
            <button type="button" className="btn" onClick={() => setEnrolling(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {!owner ? (
            <button type="button" className="btn btn-primary" onClick={() => setEnrolling({ name: ownerName || 'Owner', owner: true, phrases: [] })}>
              <Mic className="size-3.5" aria-hidden /> Set up my voice (about 30 seconds)
            </button>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn" disabled={recording} onClick={() => void whoAmI()}>
                <Mic className="size-3.5" aria-hidden /> {recording ? 'Listening… say something' : 'Who am I?'}
              </button>
              <button type="button" className="btn" onClick={() => setEnrolling({ name: ownerName || 'Owner', owner: true, phrases: [] })}>
                Record my voice again
              </button>
            </div>
          )}
          {check && (
            <p className="text-xs">
              {VERDICT[check.verdict]}
              {check.name ? ` · ${check.name}` : ''} <span className="text-muted">(match {Math.round(check.score * 100)}%)</span>
            </p>
          )}

          {view.people.length > 0 && (
            <ul className="space-y-1">
              {view.people.map(p => (
                <li key={p.name} className="flex items-center gap-2 text-sm">
                  <span className="flex-1">
                    {p.name} {p.owner && <span className="text-xs text-muted">(you)</span>}
                  </span>
                  <button type="button" className="text-muted hover:text-danger" title="Forget this voice" aria-label={`Forget ${p.name}'s voice`} onClick={() => void run(() => window.speaker.forget(p.name))}>
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {owner && (
            <form
              className="flex gap-2"
              onSubmit={e => {
                e.preventDefault()
                if (newName.trim()) setEnrolling({ name: newName.trim(), owner: false, phrases: [] })
                setNewName('')
              }}
            >
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Add family or a regular: their name" className="field" aria-label="Name" />
              <button type="submit" className="btn shrink-0" disabled={!newName.trim()}>
                <UserPlus className="size-3.5" aria-hidden /> Add
              </button>
            </form>
          )}

          {owner && (
            <div className="space-y-1.5 pt-1 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={view.enabled} onChange={e => void run(() => window.speaker.setOptions({ enabled: e.target.checked }))} /> Tell {nameOf()} who is speaking
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={view.wakeOnlyOwner} disabled={!view.enabled} onChange={e => void run(() => window.speaker.setOptions({ wakeOnlyOwner: e.target.checked }))} /> Only my voice wakes{' '}
                {nameOf()} (a TV or a visitor does not)
              </label>
              <button type="button" className="btn text-xs text-danger" onClick={() => void run(() => window.speaker.forget(null))}>
                Forget every voice
              </button>
            </div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </section>
  )
}
