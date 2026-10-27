/**
 * Settings › Appearance › Sound: how loud Atlas speaks, which speakers and
 * which microphone it uses, and a microphone test with a live meter that says
 * whether the level is right.
 */
import { Mic, Volume2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Select } from '../ui/Select.tsx'
import { nameOf } from '../ui/assistantName.ts'
import { acquireMic } from './mic.ts'
import { LOUDNESS, LOUDNESS_LABEL, setOutputSettings, useOutputSettings, voiceOut } from './output.ts'
import { onMac, os } from '../ui/host.ts'

/** A short two-note chime through the chain, at the chosen loudness. */
const testSound = () => {
  const { ctx, input } = voiceOut()
  if (ctx.state === 'suspended') void ctx.resume()
  const t = ctx.currentTime
  for (const [i, f] of [440, 660, 880].entries()) {
    const osc = new OscillatorNode(ctx, { type: 'sine', frequency: f })
    const g = new GainNode(ctx, { gain: 0 })
    g.gain.setValueAtTime(0, t + i * 0.18)
    g.gain.linearRampToValueAtTime(0.35, t + i * 0.18 + 0.02)
    g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.18 + 0.35)
    osc.connect(g).connect(input)
    osc.start(t + i * 0.18)
    osc.stop(t + i * 0.18 + 0.4)
  }
}

type Verdict = 'quiet' | 'good' | 'loud' | null

export function SoundSettings() {
  const s = useOutputSettings()
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const [verdict, setVerdict] = useState<Verdict>(null)
  const [error, setError] = useState('')
  const stopRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const list = () =>
      void navigator.mediaDevices.enumerateDevices().then(d => {
        setOutputs(d.filter(x => x.kind === 'audiooutput' && x.deviceId !== 'default' && x.deviceId !== 'communications'))
        setInputs(d.filter(x => x.kind === 'audioinput' && x.deviceId !== 'default' && x.deviceId !== 'communications'))
      })
    list()
    navigator.mediaDevices.addEventListener('devicechange', list)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', list)
      stopRef.current?.()
    }
  }, [])

  /** Six seconds of listening: the meter moves, and the loudest moments decide the verdict. */
  const testMic = async () => {
    if (testing) return
    setError('')
    setVerdict(null)
    setTesting(true)
    try {
      const mic = await acquireMic()
      let peak = 0
      const started = performance.now()
      const timer = window.setInterval(() => {
        const rms = mic.level()
        peak = Math.max(peak, rms)
        setLevel(Math.min(1, rms / 0.25))
        if (performance.now() - started > 6000) stop()
      }, 50)
      const stop = () => {
        clearInterval(timer)
        mic.release()
        stopRef.current = null
        setTesting(false)
        setLevel(0)
        setVerdict(peak < 0.05 ? 'quiet' : peak > 0.7 ? 'loud' : 'good')
      }
      stopRef.current = stop
    } catch {
      setTesting(false)
      setError(`The microphone could not be opened. Check that ${os().name} lets apps use it (${os().micSettings}).`)
    }
  }

  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Volume2 className="size-4 text-accent" aria-hidden /> Sound
      </h3>
      <div className="space-y-1.5">
        <p className="text-xs text-muted">How loud {nameOf()} speaks. Every reply is levelled to one loudness and kept clear on laptop speakers; a limiter stops it from crackling.</p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-border bg-surface p-0.5" role="radiogroup" aria-label="Loudness">
            {LOUDNESS.map(l => (
              <button key={l} type="button" role="radio" aria-checked={s.loudness === l} onClick={() => setOutputSettings({ loudness: l })} className={`rounded-full px-3 py-1 text-xs ${s.loudness === l ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'}`}>
                {LOUDNESS_LABEL[l]}
              </button>
            ))}
          </div>
          <button type="button" className="btn h-7 px-2.5 text-xs" onClick={testSound}>
            Test
          </button>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted">
          Speakers or headphones
          <Select label="Speakers or headphones" value={s.outputId || 'default'} onChange={v => setOutputSettings({ outputId: v === 'default' ? '' : v })} items={[{ value: 'default', label: 'Windows default' }, ...outputs.map((d, i) => ({ value: d.deviceId, label: label(d, i, 'Speaker') }))]} className="py-1 text-xs" />
        </label>
        <label className="space-y-1 text-xs text-muted">
          Microphone
          <Select label="Microphone" value={s.inputId || 'default'} onChange={v => setOutputSettings({ inputId: v === 'default' ? '' : v })} items={[{ value: 'default', label: 'Windows default' }, ...inputs.map((d, i) => ({ value: d.deviceId, label: label(d, i, 'Microphone') }))]} className="py-1 text-xs" />
        </label>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <button type="button" className="btn h-7 gap-1 px-2.5 text-xs" onClick={() => void testMic()} disabled={testing}>
            <Mic className="size-3.5" aria-hidden /> {testing ? 'Listening… say something' : 'Test microphone'}
          </button>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-strong" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={level}>
            <div className={`h-full rounded-full transition-[width] duration-75 ${level > 0.85 ? 'bg-warm' : 'bg-accent'}`} style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
        </div>
        {verdict === 'good' && <p className="text-xs text-ok">The level is good: {nameOf()} hears you clearly.</p>}
        {verdict === 'quiet' && (
          <p className="text-xs text-warm">Too quiet. Come closer, pick another microphone above, or raise its level: {onMac() ? "System Settings › Sound › Input › Input volume" : "Windows Settings › System › Sound › your microphone › Input volume"} (80–100%).</p>
        )}
        {verdict === 'loud' && <p className="text-xs text-warm">Very loud: it may distort. Lower the microphone's input volume a little in Windows Sound settings.</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </section>
  )
}
