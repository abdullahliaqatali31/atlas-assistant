import { ArrowUpRight, Brain, Check, Globe2, Loader2, Mic, X, Zap } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { LIVE_MODELS, LIVE_TIERS, LIVE_VOICES, type LiveTier, type LiveVoiceName } from '../../shared/livevoice.ts'
import type { RuntimeStatus } from '../../shared/ipc.ts'
import { POWER_PROVIDERS, TIER_LABEL, keyProblem, type PowerGroup, type PowerProvider, type PowerRow } from '../../shared/powerup.ts'

const GROUPS: { id: PowerGroup; title: string; icon: ReactNode; hint: string }[] = [
  { id: 'brain', title: 'Brain', icon: <Brain className="size-4" aria-hidden />, hint: 'One is enough. The one marked “in use” thinks for Atlas; pick it in Connection.' },
  { id: 'voice', title: 'Voice', icon: <Mic className="size-4" aria-hidden />, hint: 'How Atlas hears and speaks. Azure’s free tier is enough to start.' },
  { id: 'world', title: 'World map', icon: <Globe2 className="size-4" aria-hidden />, hint: 'Optional extras for the World map; everything else there needs no key.' },
]

const TIER_DOT: Record<PowerProvider['tier'], string> = { free: 'bg-ok', 'free-tier': 'bg-warm', metered: 'bg-danger' }

const clean = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.')

/**
 * Setup › Power up: every service Atlas can use, what it unlocks, what it
 * costs, a link straight to the page where the key is made (GET KEY) or
 * managed (MANAGE), and a test that makes one real call. Keys go into the
 * Windows credential store and never come back to this page.
 */
export function PowerUpPage() {
  const [rows, setRows] = useState<PowerRow[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void window.powerup.state().then(setRows, e => setError(clean(e)))
  }, [])
  const byId = new Map(rows?.map(r => [r.id, r]))
  const waiting = POWER_PROVIDERS.filter(p => p.group !== 'brain' && !byId.get(p.id)?.set).length
  const brainSet = POWER_PROVIDERS.some(p => p.group === 'brain' && byId.get(p.id)?.set)

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-3">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 font-medium">
          <Zap className="size-4 text-accent" aria-hidden /> Power up
          {rows && <span className="ml-auto text-xs font-normal text-muted">{waiting === 0 && brainSet ? 'Fully powered' : `${waiting} optional key${waiting === 1 ? '' : 's'} waiting`}</span>}
        </h2>
        <p className="text-xs text-muted">
          Each key turns something on. Atlas works with only a brain key; the rest add voice, ships and webcams. Keys are kept in the Windows credential store — this page only knows whether one is set.
          <span className="ml-1 inline-flex items-center gap-2">
            <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-ok" />free key</span>
            <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-warm" />free tier</span>
            <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-danger" />pay as you go</span>
          </span>
        </p>
      </header>
      {error && <p className="text-xs text-danger">{error}</p>}
      {!rows ? (
        <p className="text-sm text-muted">Checking keys…</p>
      ) : (
        GROUPS.map(g => (
          <section key={g.id} className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <span className="text-accent">{g.icon}</span> {g.title}
            </h3>
            <p className="text-[11px] text-muted">{g.hint}</p>
            {g.id === 'voice' && <LiveVoiceCard />}
            {POWER_PROVIDERS.filter(p => p.group === g.id).map(p => (
              <KeyRow key={p.id} p={p} row={byId.get(p.id)!} onRows={setRows} />
            ))}
          </section>
        ))
      )}
    </div>
  )
}

function KeyRow({ p, row, onRows }: { p: PowerProvider; row: PowerRow; onRows: (r: PowerRow[]) => void }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null)
  const [error, setError] = useState('')
  const act = async (kind: 'save' | 'test' | 'remove', fn: () => Promise<PowerRow[]>) => {
    setBusy(kind)
    setError('')
    try {
      onRows(await fn())
      if (kind === 'save') setDraft('')
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(null)
    }
  }
  const save = () => {
    const problem = keyProblem(draft)
    if (problem) return setError(problem)
    // Save, then prove it works.
    void act('save', async () => {
      await window.powerup.save(p.id, draft)
      return window.powerup.test(p.id)
    })
  }
  const link = row.set ? p.manageUrl : p.getUrl

  return (
    <div className={`tile space-y-2 p-3 transition-colors ${row.set && row.test?.ok !== false ? 'border-ok/40' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`size-2.5 shrink-0 rounded-full ${row.set ? (row.test?.ok === false ? 'bg-danger' : 'bg-ok shadow-[0_0_8px_var(--ok)]') : 'bg-border'}`} title={row.set ? 'Key set' : 'No key yet'} />
        <span className="font-mono text-[13px] font-semibold tracking-wider uppercase">{p.title}</span>
        <span className={`size-2 rounded-full ${TIER_DOT[p.tier]}`} title={TIER_LABEL[p.tier]} aria-label={TIER_LABEL[p.tier]} />
        {row.inUse && <span className="rounded border border-accent/50 px-1.5 font-mono text-[10px] uppercase tracking-wider text-accent">in use</span>}
        {row.external && <span className="rounded border border-border px-1.5 font-mono text-[10px] uppercase tracking-wider text-muted" title="Set in the environment, outside Atlas; change it there.">configured externally</span>}
        {link && (
          <a href={link} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-0.5 font-mono text-[11px] uppercase tracking-wider text-accent hover:underline">
            {row.set ? 'Manage' : 'Get key'} <ArrowUpRight className="size-3" aria-hidden />
          </a>
        )}
      </div>
      <p className="text-xs text-muted">
        {p.unlocks}
        {!row.set && <span className="block text-[11px]">Without it: {p.without}</span>}
      </p>
      {row.test && (
        <p className={`flex items-center gap-1 text-[11px] ${row.test.ok ? 'text-ok' : 'text-danger'}`}>
          {row.test.ok ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />} {row.test.message}
        </p>
      )}
      {!row.external && (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={e => {
            e.preventDefault()
            save()
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={row.set ? `${p.secret} saved — paste to replace` : `paste ${p.secret}`}
            className="field min-w-0 flex-1 py-1 font-mono text-xs"
            aria-label={`${p.title} key`}
          />
          <button type="submit" disabled={!draft.trim() || busy !== null} className="btn btn-primary h-8 px-3 text-xs">
            {busy === 'save' ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : 'Save'}
          </button>
          {row.set && (
            <>
              <button type="button" disabled={busy !== null} onClick={() => void act('test', () => window.powerup.test(p.id))} className="btn h-8 px-3 text-xs">
                {busy === 'test' ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : 'Test'}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => window.confirm(`Remove the ${p.title} key from this PC?${row.inUse ? ' Atlas uses it right now.' : ''}`) && void act('remove', () => window.powerup.remove(p.id))}
                className="h-8 px-2 text-[11px] text-muted hover:text-danger"
              >
                Remove
              </button>
            </>
          )}
        </form>
      )}
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  )
}

/**
 * Live voice: OpenAI Realtime answers by voice in well under a second, far
 * cheaper than a separate speech service. It is only the voice: everything
 * real still goes through Atlas's own brain and permissions.
 */
function LiveVoiceCard() {
  const [live, setLive] = useState<RuntimeStatus['speech']['live'] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void window.assistant.status().then(s => setLive(s.speech.live), () => undefined)
    return window.assistant.onStatus(s => setLive(s.speech.live))
  }, [])
  if (!live) return null
  const save = (patch: Partial<{ enabled: boolean; tier: LiveTier; voice: LiveVoiceName; capUsd: number }>) => {
    setError('')
    const next = { enabled: live.enabled, tier: live.tier, voice: live.voice as LiveVoiceName, capUsd: live.capUsd, ...patch }
    setLive({ ...live, ...next })
    void window.assistant.setLiveVoice(next).catch(e => setError(clean(e)))
  }
  const rates = LIVE_MODELS[live.tier].rates
  // A spoken minute is roughly 600 audio tokens each way.
  const perMinute = ((600 * rates.audioInput + 600 * rates.audioOutput) / 1_000_000).toFixed(2)

  return (
    <div className={`tile space-y-2 p-3 ${live.enabled && live.available ? 'border-accent/50 shadow-[0_0_16px_var(--accent-soft)]' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Zap className="size-4 text-accent" aria-hidden />
        <span className="font-mono text-[13px] font-semibold uppercase tracking-wider">Live voice</span>
        <span className="rounded border border-accent/50 px-1.5 font-mono text-[10px] uppercase tracking-wider text-accent">OpenAI Realtime</span>
        <label className="ml-auto flex items-center gap-2 text-xs">
          <input type="checkbox" checked={live.enabled} disabled={!live.available} onChange={e => save({ enabled: e.target.checked })} />
          {live.enabled ? 'On' : 'Off'}
        </label>
      </div>
      <p className="text-xs text-muted">
        Talk and get an answer in under a second, in a natural voice that follows your language. It is only the voice: questions and every action still go through Atlas’s brain and its permissions. About ${perMinute} a spoken minute on {live.tier === 'mini' ? 'Mini' : 'Standard'}; you set the most one conversation may cost.
      </p>
      {!live.available ? (
        <p className="text-[11px] text-warm">Needs an OpenAI key — add it under Brain › OpenAI below (it does not have to be your brain).</p>
      ) : (
        <div className="grid gap-2 @md:grid-cols-3">
          <label className="text-[11px] text-muted">
            Model
            <select className="field mt-0.5 w-full py-1 text-xs" value={live.tier} onChange={e => save({ tier: e.target.value as LiveTier })}>
              {LIVE_TIERS.map(t => (
                <option key={t} value={t}>
                  {LIVE_MODELS[t].label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-muted">
            Voice
            <select className="field mt-0.5 w-full py-1 text-xs capitalize" value={live.voice} onChange={e => save({ voice: e.target.value as LiveVoiceName })}>
              {LIVE_VOICES.map(v => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-muted">
            Most per conversation ($)
            <input type="number" min={0.25} max={50} step={0.25} className="field mt-0.5 w-full py-1 text-xs" value={live.capUsd} onChange={e => Number.isFinite(e.target.valueAsNumber) && save({ capUsd: e.target.valueAsNumber })} />
          </label>
        </div>
      )}
      {error && <p className="text-[11px] text-danger">{error}</p>}
    </div>
  )
}
