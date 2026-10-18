import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'

import { Select } from './ui/Select.tsx'
import { BrandIcon } from './ui/BrandIcon.tsx'
import { WindowTracking } from './WindowTracking.tsx'
import {
  ACTION_CLASSES,
  ALWAYS_ASK,
  CATALOGUE,
  OPEN_APP_TOOL,
  type ActionClass,
  type ActivityEntry,
  type ControlState,
  BROWSER_LABEL,
  BROWSER_WARNING,
  BROWSER_VERSION_PAGE,
  type BrowserId,
  type BrowserSetting,
  type RuleInput,
  type RuleView,
  type ServerView,
} from '../../shared/control.ts'

export type ControlsTab = 'connections' | 'permissions' | 'activity'

const TABS: { id: ControlsTab; label: string }[] = [
  { id: 'connections', label: 'Connections' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'activity', label: 'Activity' },
]

const cleanError = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong.'

/** The owner's control room: what the assistant may reach, what it may do without asking, and what it did. */
export function Controls({ state, initialTab = 'connections', onBack }: { state: ControlState; initialTab?: ControlsTab; onBack?: (() => void) | undefined }) {
  const [tab, setTab] = useState<ControlsTab>(initialTab)
  const [error, setError] = useState('')

  /** Runs a control call and shows main's refusal, if any, in plain words. */
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError('')
    try {
      return await fn()
    } catch (err) {
      setError(cleanError(err))
      return undefined
    }
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-border px-3 py-1.5">
        {onBack && (
          <button type="button" onClick={onBack} className="rounded-md px-1 text-sm text-muted hover:text-text" aria-label="Back to the companion">
            ←
          </button>
        )}
        <nav className="flex gap-1 rounded-xl border border-border bg-bg p-0.5" aria-label="Controls">
          {TABS.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setError('')
                setTab(t.id)
              }}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${tab === t.id ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-strong hover:text-text'}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <StopButton state={state} run={run} />
      </header>
      {error && (
        <p role="alert" className="border-b border-border px-4 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      <main className="flex-1 overflow-y-auto px-3 py-3 text-sm">
        {tab === 'connections' && <Connections state={state} run={run} />}
        {tab === 'permissions' && <Permissions state={state} run={run} />}
        {tab === 'activity' && <Activity state={state} />}
      </main>
    </div>
  )
}

type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>

function StopButton({ state, run }: { state: ControlState; run: Run }) {
  return state.paused ? (
    <button type="button" onClick={() => void run(() => window.controls.setPaused(false))} className="btn ml-auto text-accent">
      Resume
    </button>
  ) : (
    <button
      type="button"
      onClick={() => void run(() => window.controls.stopAll())}
      title={state.hotkey ? `Stop all automation (${hotkeyLabel(state.hotkey)})` : 'Stop all automation'}
      className="btn btn-danger ml-auto"
    >
      Stop all
    </button>
  )
}

export const hotkeyLabel = (accelerator: string) => accelerator.replace('CommandOrControl', 'Ctrl').replaceAll('+', ' + ')

/** Shown above the companion while automation is stopped. */
export function PausedBanner({ state }: { state: ControlState }) {
  if (!state.paused) return null
  return (
    <div role="status" className="flex items-center gap-2 border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs">
      <span className="size-2 rounded-full bg-danger" aria-hidden />
      <span className="flex-1">
        Automation stopped. No tool runs until you resume{state.hotkey ? ` (${hotkeyLabel(state.hotkey)})` : ''}.
      </span>
      <button type="button" onClick={() => void window.controls.setPaused(false)} className="btn">
        Resume
      </button>
    </div>
  )
}

// ── Connections ─────────────────────────────────────────────

const STATE_TEXT: Record<ServerView['state'], string> = { off: 'Off', starting: 'Starting…', running: 'Running', failed: 'Failed' }
const STATE_TONE: Record<ServerView['state'], string> = { off: 'text-muted', starting: 'text-muted thinking-dot', running: 'text-accent', failed: 'text-danger' }

function Connections({ state, run }: { state: ControlState; run: Run }) {
  const planned = CATALOGUE.filter(c => !c.available)
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Every connection starts off. Turning one on or off restarts only the connections, not the conversation.</p>
      {state.servers.map(s => (
        <ServerCard key={s.name} server={s} state={state} run={run} />
      ))}
      <WindowTracking />
      {planned.map(c => (
        <section key={c.id} className="flex items-center gap-3 rounded-[0.875rem] border border-dashed border-border p-3">
          <span className="opacity-80">
            <BrandIcon id={c.id} size={36} title={c.label} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-medium">
              {c.label} <span className="hud-label ml-1 text-warm">Coming soon</span>
            </h3>
            <p className="mt-0.5 text-xs text-muted">{c.description}</p>
          </div>
        </section>
      ))}

      <section className="tile p-3">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 font-medium">Applications</h3>
          <button type="button" onClick={() => void run(() => window.controls.addApp())} className="btn">
            Add application…
          </button>
        </div>
        <p className="mt-1 text-xs text-muted">The assistant may ask to open these, and only these. You approve each time.</p>
        {state.apps.length === 0 ? (
          <p className="mt-2 text-xs text-muted">None yet.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {state.apps.map(a => (
              <li key={a.id} className="flex items-center gap-2 text-xs">
                <span className="font-medium">{a.name}</span>
                <span className="min-w-0 flex-1 truncate text-muted" title={a.path}>
                  {a.path}
                </span>
                <RemoveButton label={`Remove ${a.name}`} onClick={() => void run(() => window.controls.removeApp(a.id))} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/** Separate automation browser, or the owner's own Chrome, Edge, Comet or Brave through the Playwright Extension. */
function BrowserChoice({ setting, state, run }: { setting: BrowserSetting; state: ControlState; run: Run }) {
  const [profile, setProfile] = useState(setting.kind === 'mine' ? setting.profile : '')
  const [token, setToken] = useState('')
  const mine = setting.kind === 'mine' ? setting : null
  const set = (next: BrowserSetting) => void run(() => window.controls.setBrowser(next))
  const installed = state.browsers
  const name = mine ? BROWSER_LABEL[mine.browser] : ''
  const saveToken = () => {
    void run(() => window.controls.setExtensionToken(token))
    setToken('')
  }
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border bg-bg p-2.5 text-xs">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Which browser">
        <button type="button" role="radio" aria-checked={!mine} className={`btn ${!mine ? 'btn-primary' : ''}`} onClick={() => set({ kind: 'separate' })}>
          Separate browser
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={Boolean(mine)}
          disabled={installed.length === 0}
          className={`btn ${mine ? 'btn-primary' : ''}`}
          onClick={() => set({ kind: 'mine', browser: mine?.browser ?? installed[0]!.id, profile })}
        >
          My browser (with my sign-ins)
        </button>
      </div>
      {mine ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span>Browser</span>
            <div className="w-44">
              <Select
                label="Your browser"
                value={mine.browser}
                onChange={v => set({ kind: 'mine', browser: v as BrowserId, profile })}
                items={installed.map(b => ({ value: b.id, label: b.label }))}
                className="py-1 text-xs"
              />
            </div>
            <span>Profile</span>
            <input
              value={profile}
              onChange={e => setProfile(e.target.value)}
              onBlur={() => profile !== mine.profile && set({ kind: 'mine', browser: mine.browser, profile })}
              placeholder="last used (e.g. Profile 1)"
              className="field w-44 py-1 text-xs"
              aria-label="Browser profile folder name"
            />
          </div>
          {BROWSER_WARNING[mine.browser] && <p className="text-warm">{BROWSER_WARNING[mine.browser]}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <span>Connection token</span>
            <input
              type="password"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder={state.extensionToken ? 'Saved · paste a new one to replace' : 'Paste from the extension page (optional)'}
              autoComplete="off"
              className="field min-w-0 flex-1 py-1 text-xs"
              aria-label="Playwright Extension connection token"
            />
            <button type="button" className="btn" disabled={!token.trim()} onClick={saveToken}>
              Save
            </button>
            {state.extensionToken && (
              <button type="button" className="btn text-muted" onClick={() => void run(() => window.controls.setExtensionToken(''))}>
                Remove
              </button>
            )}
          </div>
          <p className="text-muted">
            Uses your running {name} with the Playwright Extension installed: your sign-ins, your tabs. Without a token, the extension asks you to allow each new
            connection and pick a tab. With the token (from the extension’s page, “Set this environment variable…”), it connects straight away; the token is kept in
            Windows Credential Manager, never in a settings file. Every action still asks you unless you allow that site in Permissions; sending, paying and deleting
            always ask. The profile name is the last part of “Profile Path” on {BROWSER_VERSION_PAGE[mine.browser]}.
          </p>
        </>
      ) : (
        <p className="text-muted">A fresh, empty browser each time: no sign-ins, nothing remembered. Safest for searching and reading public sites.</p>
      )}
    </div>
  )
}

function ServerCard({ server: s, state, run }: { server: ServerView; state: ControlState; run: Run }) {
  const entry = CATALOGUE.find(c => c.id === s.catalog)
  const needsFolder = s.catalog === 'filesystem' && s.folders.length === 0
  return (
    <section className="tile rise-in p-3" aria-labelledby={`srv-${s.name}`}>
      <div className="flex items-center gap-3">
        <BrandIcon id={s.catalog ?? s.name} size={36} title={s.label} />
        <h3 id={`srv-${s.name}`} className="flex-1 font-medium">
          {s.label}
        </h3>
        <span className={`text-xs ${STATE_TONE[s.state]}`}>
          {STATE_TEXT[s.state]}
          {s.state === 'running' ? ` · ${s.tools.length} tools` : ''}
        </span>
        <Switch
          checked={s.enabled}
          disabled={needsFolder && !s.enabled}
          label={`${s.enabled ? 'Turn off' : 'Turn on'} ${s.label}`}
          onChange={on => void run(() => window.controls.setServer(s.name, on))}
        />
      </div>
      <p className="mt-1 text-xs text-muted">
        {s.readOnly && <span className="hud-label mr-1.5 rounded-md border border-ok/40 px-1.5 py-px text-ok">Read-only</span>}
        {entry?.description ?? s.command}
      </p>
      {s.state === 'failed' && s.error && <p className="mt-2 break-words text-xs text-danger">Why: {s.error}</p>}

      {(entry?.setup || entry?.needsCredentialsFile) && (
        <div className="mt-2 rounded-lg border border-border bg-bg p-2.5 text-xs">
          {entry.setup && <p className="text-muted">{entry.setup}</p>}
          {entry.needsCredentialsFile && (
            <div className="mt-2 flex items-center gap-2">
              <span className={`min-w-0 flex-1 truncate font-mono ${s.credentialsFile ? '' : 'text-warm'}`} title={s.credentialsFile ?? undefined}>
                {s.credentialsFile ?? 'No OAuth client file chosen yet'}
              </span>
              <button type="button" onClick={() => void run(() => window.controls.pickCredentials(s.name))} className="btn shrink-0">
                {s.credentialsFile ? 'Change…' : 'Choose file…'}
              </button>
            </div>
          )}
        </div>
      )}

      {s.catalog === 'playwright' && s.browser && <BrowserChoice setting={s.browser} state={state} run={run} />}

      {s.catalog === 'filesystem' && (
        <div className="mt-2 space-y-1">
          {s.folders.map(f => (
            <div key={f} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono" title={f}>
                {f}
              </span>
              <RemoveButton label={`Remove ${f}`} onClick={() => void run(() => window.controls.removeFolder(f))} />
            </div>
          ))}
          <button type="button" onClick={() => void run(() => window.controls.addFolder())} className="btn">
            {s.folders.length ? 'Add folder…' : 'Choose folders…'}
          </button>
        </div>
      )}

      <label className="mt-2 flex items-start gap-2 text-xs text-muted">
        <input type="checkbox" checked={s.trusted} onChange={e => void run(() => window.controls.setTrusted(s.name, e.target.checked))} className="mt-0.5" />
        <span>Trust this connection’s own labels (read-only, destructive…) to classify its tools. Off: every tool counts as external-send and asks.</span>
      </label>

      {s.tools.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted">Tools and how they are classified</summary>
          <ul className="mt-1 space-y-0.5">
            {s.tools.map(t => (
              <li key={t.name} className="flex justify-between gap-2">
                <span className="truncate font-mono">{t.name.slice(s.name.length + 2)}</span>
                <span className="text-muted">{t.actionClass}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={disabled ? 'Choose a folder first' : label}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${checked ? 'border-transparent bg-accent shadow-[0_0_12px_rgba(34,211,238,0.45)]' : 'border-border bg-surface-strong'}`}
    >
      <span className={`absolute top-0.5 size-4 rounded-full bg-white transition-all ${checked ? 'left-4.5' : 'left-0.5'}`} />
    </button>
  )
}

const RemoveButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" onClick={onClick} aria-label={label} title={label} className="rounded px-1 text-muted hover:text-danger">
    ×
  </button>
)

// ── Permissions ─────────────────────────────────────────────

const EXPIRY: { label: string; hours: number | undefined }[] = [
  { label: 'Until I remove it', hours: undefined },
  { label: '1 hour', hours: 1 },
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
]

const EFFECT_TONE: Record<RuleView['effect'], string> = { allow: 'bg-accent text-accent-fg', ask: 'border border-border', deny: 'bg-danger text-white' }

const describeTool = (tool: string) => (tool === '*' ? 'any tool' : tool.endsWith('__*') ? `all ${tool.slice(0, -3)} tools` : tool)

function Permissions({ state, run }: { state: ControlState; run: Run }) {
  const [rules, setRules] = useState<RuleView[] | null>(null)
  useEffect(() => {
    void window.controls.rules().then(setRules)
  }, [state.tools])

  const owner = rules?.filter(r => r.source === 'owner') ?? []
  const builtIn = rules?.filter(r => r.source === 'built-in') ?? []

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Standing rules let routine work run without asking. Only you can change them here; the assistant cannot. Destructive, credential and payment actions always ask.
      </p>
      <RuleForm state={state} onAdd={async input => {
          const next = await run(() => window.controls.addRule(input))
          if (next) setRules(next)
          return Boolean(next)
        }} />
      <section>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Your rules</h3>
        {owner.length === 0 ? <p className="text-xs text-muted">None yet. Without a rule, the assistant asks first.</p> : <RuleList rules={owner} onRemove={async id => {
              const next = await run(() => window.controls.removeRule(id))
              if (next) setRules(next)
            }} />}
      </section>
      <section>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Built in</h3>
        {builtIn.length === 0 ? <p className="text-xs text-muted">Shown once the runtime is ready.</p> : <RuleList rules={builtIn} />}
      </section>
    </div>
  )
}

function RuleList({ rules, onRemove }: { rules: RuleView[]; onRemove?: (id: string) => void }) {
  return (
    <ul className="space-y-1.5">
      {rules.map(r => (
        <li key={r.id} className="flex items-start gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs">
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${EFFECT_TONE[r.effect]}`}>{r.effect}</span>
          <span className="min-w-0 flex-1">
            <span className="font-medium">{r.actionClass}</span> via <span className="font-mono">{describeTool(r.tool)}</span>
            {r.scopePrefix && (
              <span className="block truncate text-muted" title={r.scopePrefix}>
                in {r.scopePrefix}
              </span>
            )}
            {r.expiresAt !== undefined && <span className="block text-muted">until {new Date(r.expiresAt).toLocaleString()}</span>}
          </span>
          {onRemove && <RemoveButton label="Remove rule" onClick={() => onRemove(r.id)} />}
        </li>
      ))}
    </ul>
  )
}

function RuleForm({ state, onAdd }: { state: ControlState; onAdd: (input: RuleInput) => Promise<boolean> }) {
  const servers = state.servers.filter(s => s.enabled || s.tools.length)
  const [tool, setTool] = useState('')
  const [actionClass, setActionClass] = useState<ActionClass>('observe')
  const [effect, setEffect] = useState<RuleInput['effect']>('allow')
  const [scope, setScope] = useState('')
  const [expiry, setExpiry] = useState(0)

  // Picking one tool suggests the class it actually has, so the rule matches.
  const pickTool = (name: string) => {
    setTool(name)
    const known = state.tools.find(t => t.name === name)
    if (known) setActionClass(known.actionClass)
  }

  const blocked = useMemo(() => {
    if (effect !== 'allow') return ''
    if (ALWAYS_ASK.includes(actionClass)) return `${actionClass} actions always ask.`
    if (tool === OPEN_APP_TOOL) return 'Opening applications always asks.'
    return ''
  }, [effect, actionClass, tool])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!tool || blocked) return
    const ok = await onAdd({ tool, actionClass, effect, scopePrefix: scope.trim() || undefined, expiresInHours: EXPIRY[expiry]?.hours })
    if (ok) setScope('')
  }

  const field = 'field py-1 text-xs'
  return (
    <form onSubmit={e => void submit(e)} className="tile space-y-2 p-3">
      <h3 className="font-medium">Add a rule</h3>
      <div className="grid grid-cols-[4.5rem_1fr] items-center gap-x-2 gap-y-1.5 text-xs">
        <Label htmlFor="rule-effect">Effect</Label>
        <Select id="rule-effect" value={effect} onChange={v => setEffect(v as RuleInput['effect'])} className="py-1 text-xs" items={[
          { value: 'allow', label: 'Allow without asking' },
          { value: 'ask', label: 'Always ask' },
          { value: 'deny', label: 'Never allow' },
        ]} />
        <Label htmlFor="rule-tool">Tool</Label>
        <Select
          id="rule-tool"
          value={tool}
          onChange={pickTool}
          className="py-1 text-xs"
          items={[
            ...(servers.length > 0 ? [{ label: 'Whole connection', options: servers.map(s => ({ value: `${s.name}__*`, label: `All ${s.label} tools` })) }] : []),
            { label: 'One tool', options: state.tools.map(t => ({ value: t.name, label: `${t.name} (${t.actionClass})` })) },
          ]}
        />
        <Label htmlFor="rule-class">Action</Label>
        <Select id="rule-class" value={actionClass} onChange={v => setActionClass(v as ActionClass)} className="py-1 text-xs" items={ACTION_CLASSES.map(c => ({ value: c, label: c }))} />
        <Label htmlFor="rule-scope">Only in</Label>
        <div className="flex gap-1">
          <input
            id="rule-scope"
            value={scope}
            onChange={e => setScope(e.target.value)}
            placeholder="Folder or site (optional)"
            maxLength={500}
            className={field}
          />
          <button
            type="button"
            onClick={() => void window.controls.pickScopeFolder().then(p => p && setScope(p))}
            className="btn shrink-0"
          >
            Folder…
          </button>
        </div>
        <Label htmlFor="rule-expiry">Expires</Label>
        <Select id="rule-expiry" value={String(expiry)} onChange={v => setExpiry(Number(v))} className="py-1 text-xs" items={EXPIRY.map((x, i) => ({ value: String(i), label: x.label }))} />
      </div>
      {blocked && <p className="text-xs text-danger">{blocked}</p>}
      <p className="text-[11px] text-muted">
        Rules match a tool’s class exactly: an untrusted connection’s tools are all external-send. A folder or site limit only matches calls aimed at one path or page inside it.
      </p>
      <div className="flex justify-end">
        <button type="submit" disabled={!tool || Boolean(blocked)} className="btn btn-primary">
          Add rule
        </button>
      </div>
    </form>
  )
}

const Label = ({ htmlFor, children }: { htmlFor: string; children: ReactNode }) => (
  <label htmlFor={htmlFor} className="text-muted">
    {children}
  </label>
)

// ── Activity ────────────────────────────────────────────────

const RESULT_TONE: Record<string, string> = { done: 'text-accent', failed: 'text-danger', denied: 'text-danger', declined: 'text-muted' }

function Activity({ state }: { state: ControlState }) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null)
  const refresh = useCallback(() => void window.controls.activity().then(setEntries), [])

  // A finished action leaves the running list, so its row is in the log by then.
  useEffect(refresh, [refresh, state.running.length])

  return (
    <div className="space-y-4">
      <section>
        <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Running now</h3>
        {state.running.length === 0 ? (
          <p className="text-xs text-muted">Nothing is running.</p>
        ) : (
          <ul className="space-y-1">
            {state.running.map((r, i) => (
              <li key={`${r.tool}-${r.since}-${i}`} className="rounded-lg border border-accent bg-surface px-2 py-1.5 text-xs">
                <span className="thinking-dot mr-1 inline-block size-1.5 rounded-full bg-accent align-middle" aria-hidden />
                <span className="font-mono">{r.tool}</span>
                <span className="text-muted"> · since {new Date(r.since).toLocaleTimeString()}</span>
                {r.detail && <span className="mt-0.5 block truncate font-mono text-muted">{r.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <div className="mb-1 flex items-center">
          <h3 className="flex-1 text-xs font-medium uppercase tracking-wide text-muted">Recent</h3>
          <button type="button" onClick={refresh} className="text-xs text-muted hover:text-text">
            Refresh
          </button>
        </div>
        {entries === null ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-xs text-muted">No actions yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {entries.map(e => (
              <li key={e.id} className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs">
                <div className="flex gap-2">
                  <span className="font-mono">{e.tool}</span>
                  <span className={`ml-auto ${RESULT_TONE[e.result ?? ''] ?? 'text-muted'}`}>{e.result ?? 'logged'}</span>
                </div>
                <div className="text-muted">
                  {new Date(e.at).toLocaleString()} · {e.decision === 'allow' ? `allowed by ${e.ruleId ?? 'rule'}` : e.decision === 'ask' ? 'asked you' : e.decision}
                </div>
                <div className="truncate font-mono text-muted" title={e.summary}>
                  {e.summary}
                </div>
                {e.evidence && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-muted">{e.result === 'done' ? 'Evidence' : 'Reason'}</summary>
                    {/* Tool output is untrusted text: shown, never interpreted. */}
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg p-2">{e.evidence}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
