import * as Label from '@radix-ui/react-label'
import { Check, Cloud } from 'lucide-react'
import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react'

import { VOICE_PROVIDER_INFO, VOICE_PROVIDERS, type RuntimeStatus, type SetupInput, type VoiceProviderChoice } from '../../shared/ipc.ts'
import { LLM_KEY_NAMES, LLM_PROVIDER_IDS, LLM_PROVIDERS, type LlmProviderId } from '@assistant/providers/llm-presets'

import { BrandIcon } from './ui/BrandIcon.tsx'
import { StartupToggle, UsageCard } from './UsageCard.tsx'
import { Select } from './ui/Select.tsx'

/** Which form field answers each `loadConfig` problem key. */
const FIELD_FOR: Record<string, keyof SetupInput> = {
  ...Object.fromEntries(LLM_KEY_NAMES.map(k => [k, 'llmKey' as const])),
  ASSISTANT_LLM_MODEL: 'llmModel',
  ASSISTANT_LLM_BASE_URL: 'llmBaseUrl',
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
    llmProvider: setup.llmProvider,
    llmModel: setup.llmModel,
    llmBaseUrl: setup.llmBaseUrl,
    llmBackgroundModel: setup.llmBackgroundModel,
  })
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const llm: LlmProviderId = form.llmProvider ?? 'anthropic'
  const llmInfo = LLM_PROVIDERS[llm]
  const llmKeyStored = setup.hasLlmKey && setup.llmProvider === llm
  const needsModel = !('defaultModel' in llmInfo)
  const loadModels = async () => {
    setLoadingModels(true)
    setModelsError('')
    try {
      setModels(await window.assistant.listModels(llm, form.llmKey, form.llmBaseUrl ?? ''))
    } catch (err) {
      setModelsError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not load models.')
    } finally {
      setLoadingModels(false)
    }
  }
  const pickLlm = (p: LlmProviderId) => {
    setModels([])
    setModelsError('')
    setForm(f => ({
      ...f,
      llmProvider: p,
      llmKey: '',
      // Switching provider: the old model names mean nothing there.
      llmModel: p === setup.llmProvider ? setup.llmModel : '',
      llmBackgroundModel: p === setup.llmProvider ? setup.llmBackgroundModel : '',
      llmBaseUrl: p === setup.llmProvider ? setup.llmBaseUrl : '',
    }))
  }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const provider: VoiceProviderChoice = form.voiceProvider ?? 'elevenlabs'
  const info = VOICE_PROVIDER_INFO[provider]
  // A stored key only counts for the provider it belongs to.
  const keyStored = setup.hasVoiceKey && setup.voiceProvider === provider

  const problemFor = (field: keyof SetupInput) => problems.find(p => FIELD_FOR[p.key] === field)?.message
  const otherProblems = problems.filter(p => !FIELD_FOR[p.key])
  const canSave =
    (llmInfo.keyName === null || form.llmKey || llmKeyStored) &&
    (!needsModel || (form.llmModel ?? '').trim() !== '') &&
    (llm !== 'custom' || (form.llmBaseUrl ?? '').trim() !== '') && (form.voiceKey || keyStored) && form.voiceId.trim() !== '' && (!info.needsRegion || (form.azureRegion ?? '').trim() !== '')

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
          Bring your own keys: any AI provider (Claude, OpenAI, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, or a free local model with Ollama) and a voice
          provider. Keys stay in your Windows credential store and never reach this window.
        </p>
      </header>

      <Field id="ownerName" label="Your name" value={form.ownerName} onChange={set('ownerName')} autoComplete="name" />

      <section className="space-y-3">
        <h2 className="hud-label">Brain</h2>
        <div className="flex flex-col gap-1.5">
          <Label.Root htmlFor="llmProvider" className="text-sm font-medium">
            AI provider
          </Label.Root>
          <Select id="llmProvider" value={llm} onChange={v => pickLlm(v as LlmProviderId)} items={LLM_PROVIDER_IDS.map(id => ({ value: id, label: LLM_PROVIDERS[id].label }))} />
          <p className="text-[11px] text-muted">
            {'note' in llmInfo ? `${llmInfo.note} ` : ''}
            {'keyUrl' in llmInfo && (
              <a href={llmInfo.keyUrl} target="_blank" rel="noreferrer" className="text-accent underline">
                {llmInfo.keyName ? 'Get a key' : 'Download'}
              </a>
            )}
          </p>
        </div>
        {llmInfo.keyName && (
          <Field
            id="llmKey"
            label={`${llmInfo.label} API key`}
            type="password"
            value={form.llmKey}
            onChange={set('llmKey')}
            placeholder={llmKeyStored ? 'Stored · leave blank to keep' : 'Paste your key'}
            problem={problemFor('llmKey')}
          />
        )}
        {(llm === 'custom' || llm === 'ollama') && (
          <Field
            id="llmBaseUrl"
            label="Server address"
            value={form.llmBaseUrl ?? ''}
            onChange={set('llmBaseUrl')}
            placeholder={llm === 'ollama' ? 'http://localhost:11434/v1' : 'https://your-server/v1'}
            problem={problemFor('llmBaseUrl')}
          />
        )}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Field
                id="llmModel"
                label="Model"
                list="llm-models"
                value={form.llmModel ?? ''}
                onChange={set('llmModel')}
                placeholder={'defaultModel' in llmInfo ? `${llmInfo.defaultModel} (default)` : 'Load the list or type a model name'}
                problem={problemFor('llmModel')}
              />
            </div>
            <button type="button" className="btn h-9" onClick={() => void loadModels()} disabled={loadingModels || Boolean(llmInfo.keyName && !form.llmKey && !llmKeyStored)}>
              {loadingModels ? 'Loading…' : models.length ? `${models.length} models` : 'Load models'}
            </button>
          </div>
          <datalist id="llm-models">
            {models.map(m => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {modelsError && <p className="text-xs text-danger">{modelsError}</p>}
        </div>
        <Field
          id="llmBackgroundModel"
          label="Background model (learning, its own questions)"
          list="llm-models"
          value={form.llmBackgroundModel ?? ''}
          onChange={set('llmBackgroundModel')}
          placeholder={'backgroundModel' in llmInfo ? `${llmInfo.backgroundModel} (cheaper default)` : 'Same as the main model, or pick a cheaper one'}
        />
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

      {status.phase === 'ready' && (
        <>
          <StartupToggle />
          <UsageCard />
        </>
      )}

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
