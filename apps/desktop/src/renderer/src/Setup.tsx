import * as Label from '@radix-ui/react-label'
import { Check, Cloud } from 'lucide-react'
import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react'

import { VOICE_PROVIDER_INFO, VOICE_PROVIDERS, type RuntimeStatus, type SetupInput, type VoiceProviderChoice } from '../../shared/ipc.ts'
import { BrandIcon } from './ui/BrandIcon.tsx'
import { Select } from './ui/Select.tsx'

/** Which form field answers each `loadConfig` problem key. */
const FIELD_FOR: Record<string, keyof SetupInput> = {
  ANTHROPIC_API_KEY: 'llmKey',
  ELEVENLABS_API_KEY: 'voiceKey',
  ELEVENLABS_VOICE_ID: 'voiceId',
  AZURE_SPEECH_KEY: 'voiceKey',
  AZURE_SPEECH_REGION: 'azureRegion',
  AZURE_SPEECH_VOICE: 'voiceId',
}

/** Common Azure Speech regions; any other region can be typed. */
const AZURE_REGIONS = ['centralindia', 'southeastasia', 'uaenorth', 'eastus', 'westeurope', 'uksouth']

const PROVIDER_ICON: Record<VoiceProviderChoice, ReactNode> = {
  elevenlabs: <BrandIcon id="elevenlabs" size={34} />,
  // Microsoft's marks are not in the open icon set, so Azure gets a neutral cloud.
  azure: (
    <span className="inline-flex size-[34px] items-center justify-center rounded-xl border border-border bg-surface-strong text-accent">
      <Cloud className="size-[18px]" aria-hidden />
    </span>
  ),
}

export function Setup({ status, onSaved, onCancel }: { status: RuntimeStatus; onSaved: (s: RuntimeStatus) => void; onCancel?: () => void }) {
  const { setup, problems, warnings } = status
  const [form, setForm] = useState<SetupInput>({
    ownerName: setup.ownerName,
    voiceId: setup.voiceId,
    llmKey: '',
    voiceKey: '',
    voiceProvider: setup.voiceProvider,
    azureRegion: setup.azureRegion,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const provider: VoiceProviderChoice = form.voiceProvider ?? 'elevenlabs'
  const info = VOICE_PROVIDER_INFO[provider]
  // A stored key only counts for the provider it belongs to.
  const keyStored = setup.hasVoiceKey && setup.voiceProvider === provider

  const problemFor = (field: keyof SetupInput) => problems.find(p => FIELD_FOR[p.key] === field)?.message
  const otherProblems = problems.filter(p => !FIELD_FOR[p.key])
  const canSave =
    (form.llmKey || setup.hasLlmKey) && (form.voiceKey || keyStored) && form.voiceId.trim() !== '' && (!info.needsRegion || (form.azureRegion ?? '').trim() !== '')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError('')
    try {
      onSaved(await window.assistant.saveSetup({ ...form, azureRegion: info.needsRegion ? form.azureRegion : undefined }))
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Saving failed.')
    } finally {
      setSaving(false)
    }
  }

  const set = (field: keyof SetupInput) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [field]: e.target.value }))
  const pickProvider = (p: VoiceProviderChoice) =>
    setForm(f => ({
      ...f,
      voiceProvider: p,
      voiceKey: '',
      // Switching provider: offer that provider's suggested voice instead of an id that cannot work there.
      voiceId: p === setup.voiceProvider ? setup.voiceId : (VOICE_PROVIDER_INFO[p].suggestedVoices[0] ?? ''),
    }))

  return (
    <form onSubmit={submit} className="mx-auto flex h-full max-w-lg flex-col gap-5 overflow-y-auto p-6">
      <header>
        <h1 className="text-xl font-semibold">Set up your assistant</h1>
        <p className="mt-1 text-sm text-muted">
          Bring your own keys. An LLM provider and a voice provider are both required. Keys stay in your Windows credential store and never reach this window.
        </p>
      </header>

      <Field id="ownerName" label="Your name" value={form.ownerName} onChange={set('ownerName')} autoComplete="name" />

      <section className="space-y-3">
        <h2 className="hud-label">Brain</h2>
        <div className="flex items-center gap-3">
          <BrandIcon id="anthropic" size={34} title="Claude by Anthropic" />
          <div className="flex-1">
            <Field
              id="llmKey"
              label="Claude API key"
              type="password"
              value={form.llmKey}
              onChange={set('llmKey')}
              placeholder={setup.hasLlmKey ? 'Stored · leave blank to keep' : 'sk-ant-…'}
              problem={problemFor('llmKey')}
            />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="hud-label">Voice</h2>
        <div role="radiogroup" aria-label="Voice provider" className="grid grid-cols-2 gap-2">
          {VOICE_PROVIDERS.map(p => {
            const selected = p === provider
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => pickProvider(p)}
                className={`tile relative flex items-start gap-3 p-3 text-left transition-colors ${selected ? '!border-accent bg-accent-soft' : 'hover:bg-surface-strong'}`}
              >
                {PROVIDER_ICON[p]}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{VOICE_PROVIDER_INFO[p].label}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted">{VOICE_PROVIDER_INFO[p].note}</span>
                </span>
                {selected && <Check className="absolute right-2 top-2 size-4 text-accent" aria-hidden />}
              </button>
            )
          })}
        </div>

        <Field
          id="voiceKey"
          label={`${info.label} key`}
          type="password"
          value={form.voiceKey}
          onChange={set('voiceKey')}
          placeholder={keyStored ? 'Stored · leave blank to keep' : `Your ${info.label} key`}
          problem={problemFor('voiceKey')}
        />

        {info.needsRegion && (
          <div className="flex flex-col gap-1.5">
            <Label.Root htmlFor="azureRegion" className="text-sm font-medium">
              Azure region
            </Label.Root>
            <div className="flex gap-2">
              <input
                id="azureRegion"
                list="azure-regions"
                spellCheck={false}
                value={form.azureRegion ?? ''}
                onChange={set('azureRegion')}
                placeholder="e.g. centralindia"
                aria-invalid={Boolean(problemFor('azureRegion'))}
                className="field aria-invalid:border-danger"
              />
              <datalist id="azure-regions">
                {AZURE_REGIONS.map(r => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </div>
            <p className="text-[11px] text-muted">Shown on your Speech resource's “Keys and Endpoint” page in the Azure portal.</p>
            {problemFor('azureRegion') && <p className="text-xs text-danger">{problemFor('azureRegion')}</p>}
          </div>
        )}

        {info.suggestedVoices.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label.Root htmlFor="voiceId" className="text-sm font-medium">
              {info.voiceLabel}
            </Label.Root>
            <Select
              id="voiceId"
              value={form.voiceId}
              onChange={v => setForm(f => ({ ...f, voiceId: v }))}
              items={[
                ...info.suggestedVoices.map(v => ({ value: v, label: voiceLabel(v) })),
                ...(form.voiceId && !info.suggestedVoices.includes(form.voiceId) ? [{ value: form.voiceId, label: form.voiceId }] : []),
              ]}
            />
            {problemFor('voiceId') && <p className="text-xs text-danger">{problemFor('voiceId')}</p>}
          </div>
        ) : (
          <Field id="voiceId" label={info.voiceLabel} value={form.voiceId} onChange={set('voiceId')} problem={problemFor('voiceId')} />
        )}
      </section>

      {[...otherProblems.map(p => p.message), ...warnings].map(m => (
        <p key={m} className="text-sm text-muted">
          {m}
        </p>
      ))}
      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="mt-auto flex gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn h-9">
            Cancel
          </button>
        )}
        <button type="submit" disabled={!canSave || saving} className="btn btn-primary h-9 flex-1">
          {saving ? 'Saving…' : 'Save and test connection'}
        </button>
      </div>
    </form>
  )
}

/** "ur-PK-UzmaNeural" → "Uzma · Urdu (Pakistan)". */
const voiceLabel = (name: string) => {
  const m = /^([a-z]{2})-([A-Z]{2})-(\w+?)Neural$/.exec(name)
  if (!m) return name
  const lang = m[1] === 'ur' ? 'Urdu' : m[1] === 'en' ? 'English' : m[1]!
  return `${m[3]} · ${lang} (${m[2] === 'PK' ? 'Pakistan' : m[2]})`
}

function Field({
  id,
  label,
  problem,
  ...input
}: { id: string; label: string; problem?: string | undefined } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label.Root htmlFor={id} className="text-sm font-medium">
        {label}
      </Label.Root>
      <input id={id} spellCheck={false} aria-invalid={Boolean(problem)} className="field aria-invalid:border-danger" {...input} />
      {problem && <p className="text-xs text-danger">{problem}</p>}
    </div>
  )
}
