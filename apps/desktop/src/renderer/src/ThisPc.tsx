import { Battery, BatteryCharging, Zap, Bluetooth, BluetoothOff, FolderX, Map as MapIcon, RefreshCw, Shield, Wifi, WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { FullControlMode, FullControlView } from '../../shared/control.ts'
import type { PcState } from '../../shared/system.ts'

const MODE_LABEL: Record<FullControlMode, string> = { session: 'Until I lock or leave', hour: 'For an hour', manual: 'Until I turn it off' }

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

/**
 * Controls › This PC: what Atlas can see of the PC right now (Wi-Fi,
 * Bluetooth, battery), and the system map that lets it find and open things
 * by name. Turning the map on and choosing what it never looks into are the
 * owner's alone.
 */
export function ThisPc({ run }: { run: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const [s, setS] = useState<PcState | null>(null)
  const [fc, setFc] = useState<FullControlView | null>(null)
  useEffect(() => {
    void window.pc.state().then(setS, () => undefined)
    void window.controls.state().then(c => setFc(c.fullControl), () => undefined)
    const off = window.controls.onState(c => setFc(c.fullControl))
    const offPc = window.pc.onChanged(setS)
    return () => {
      off()
      offPc()
    }
  }, [])
  const switchFc = async (on: boolean, mode?: FullControlMode) => {
    const next = await run(() => window.controls.setFullControl(on, mode))
    if (next) setFc(next.fullControl)
  }
  const act = async (fn: () => Promise<PcState>) => {
    const next = await run(fn)
    if (next) setS(next)
  }
  if (!s) return <p className="text-muted">Reading the PC…</p>
  const st = s.status
  const connected = st?.bluetooth.devices.filter(d => d.connected) ?? []

  return (
    <div className="space-y-3">
      <section className={`tile space-y-2 p-3 ${fc?.on ? 'border-warm/70 shadow-[0_0_18px_rgba(251,191,36,0.18)]' : ''}`}>
        <h3 className="flex items-center gap-2 font-medium">
          <Zap className={`size-4 ${fc?.on ? 'text-warm' : 'text-muted'}`} aria-hidden /> Full control
          <span className={`ml-auto text-xs font-normal ${fc?.on ? 'text-warm' : 'text-muted'}`}>
            {fc?.on ? `On · ${fc.mode ? MODE_LABEL[fc.mode].toLowerCase() : ''}${fc.until ? ` (until ${new Date(fc.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}` : 'Off · Atlas asks first'}
          </span>
        </h3>
        <p className="text-xs text-muted">
          Atlas does what you ask on this PC without asking first: opening and starting things, making folders, documents and sheets, moving and tidying files, using your apps, sending what you dictate. It still asks before deleting anything for good, anything with passwords or payments, and before sending anything or pressing Send / Delete / Pay right after it read a web page, an email or a message (so outside text can never steer it). Turns off when you lock the PC, it sleeps, the owner check closes, or you press Stop all. You can also say “full control on karo” (Atlas asks you once) or “full control band karo”.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(['session', 'hour', 'manual'] as FullControlMode[]).map(m => (
            <button key={m} type="button" onClick={() => void switchFc(true, m)} className={`btn h-8 px-3 text-xs ${fc?.on && fc.mode === m ? 'border-warm text-warm' : ''}`} aria-pressed={fc?.on && fc.mode === m}>
              {MODE_LABEL[m]}
            </button>
          ))}
          <button type="button" onClick={() => void switchFc(false)} className={`btn h-8 px-3 text-xs ${!fc?.on ? 'border-accent text-accent' : ''}`} aria-pressed={!fc?.on}>
            Off (ask first)
          </button>
        </div>
      </section>

      <section className="tile space-y-2 p-3">
        <h3 className="flex items-center gap-2 font-medium">
          Right now
          <span className="ml-auto text-[11px] font-normal text-muted">{st ? `read ${ago(st.at)}` : 'reading…'}</span>
          <button type="button" className="icon-btn size-7" onClick={() => void act(() => window.pc.rebuild())} title="Read again" aria-label="Read again">
            <RefreshCw className="size-3.5" aria-hidden />
          </button>
        </h3>
        {st ? (
          <ul className="space-y-1.5 text-sm">
            <li className="flex items-start gap-2">
              {st.wifi.connected ? <Wifi className="mt-0.5 size-4 text-accent" aria-hidden /> : <WifiOff className="mt-0.5 size-4 text-muted" aria-hidden />}
              <span>
                {st.wifi.connected ? (
                  <>
                    Wi-Fi <b>{st.wifi.name ?? 'connected'}</b>
                    {st.wifi.signal !== null && ` · ${st.wifi.signal}%`}
                    {st.wifi.band && ` · ${st.wifi.band}`}
                    {st.wifi.internet !== 'internet' && <span className="text-warm"> · no internet</span>}
                  </>
                ) : st.wifi.on ? (
                  'Wi-Fi on, not connected'
                ) : (
                  'Wi-Fi off'
                )}
                {st.wifi.locationBlocked && (
                  <span className="block text-[11px] text-muted">Signal strength is hidden while Windows location services are off (Settings › Privacy › Location).</span>
                )}
              </span>
            </li>
            <li className="flex items-start gap-2">
              {st.bluetooth.on ? <Bluetooth className="mt-0.5 size-4 text-accent" aria-hidden /> : <BluetoothOff className="mt-0.5 size-4 text-muted" aria-hidden />}
              <span>
                {!st.bluetooth.on ? 'Bluetooth off' : connected.length ? connected.map(d => `${d.name} (${d.kind})`).join(', ') : 'Bluetooth on, nothing connected'}
                {st.bluetooth.on && <span className="block text-[11px] text-muted">{st.bluetooth.devices.length} paired</span>}
              </span>
            </li>
            {st.battery && (
              <li className="flex items-center gap-2">
                {st.battery.charging ? <BatteryCharging className="size-4 text-ok" aria-hidden /> : <Battery className={`size-4 ${st.battery.percent <= 20 ? 'text-danger' : 'text-accent'}`} aria-hidden />}
                {st.battery.percent}%{st.battery.charging ? ', charging' : ''}
              </li>
            )}
            {st.vpn && (
              <li className="flex items-center gap-2">
                <Shield className="size-4 text-accent" aria-hidden /> VPN: {st.vpn}
              </li>
            )}
          </ul>
        ) : (
          <p className="text-xs text-muted">Not read yet.</p>
        )}
        {s.changes.length > 0 && (
          <div className="border-t border-border pt-2">
            <p className="hud-label mb-1">Recent</p>
            <ul className="space-y-0.5 text-xs text-muted">
              {[...s.changes]
                .reverse()
                .slice(0, 6)
                .map(c => (
                  <li key={`${c.at}-${c.text}`}>
                    {c.text} · {ago(c.at)}
                  </li>
                ))}
            </ul>
          </div>
        )}
      </section>

      <section className="tile space-y-2 p-3">
        <h3 className="flex items-center gap-2 font-medium">
          <MapIcon className="size-4 text-accent" aria-hidden /> System map
          <label className="ml-auto flex items-center gap-2 text-xs font-normal">
            <input type="checkbox" checked={s.map.enabled} onChange={e => void act(() => window.pc.setMap(e.target.checked))} />
            {s.map.enabled ? 'On' : 'Off'}
          </label>
        </h3>
        <p className="text-xs text-muted">
          Lets Atlas find things by name: “open my WSL project in VS Code”, “WhatsApp kholo”, “invoices wala folder”. It lists your apps, your code projects (Windows and WSL, from VS Code, Cursor, Claude Code and git folders) and your own folders two levels down. Names and places only, never what is inside files; Windows, Program Files and AppData are never looked at. Kept on this PC, rebuilt daily.
        </p>
        {s.map.enabled && (
          <>
            <p className="text-sm">
              {s.map.building ? (
                <span className="thinking-dot text-accent">Building the map…</span>
              ) : s.map.builtAt ? (
                <>
                  <b>{s.map.counts.apps}</b> apps · <b>{s.map.counts.projects}</b> projects · <b>{s.map.counts.folders}</b> folders
                  <span className="text-xs text-muted"> · built {ago(s.map.builtAt)}</span>
                </>
              ) : (
                'Not built yet.'
              )}
              {!s.map.building && (
                <button type="button" className="btn ml-2 h-7 gap-1 px-2 text-xs" onClick={() => void act(() => window.pc.rebuild())}>
                  <RefreshCw className="size-3" aria-hidden /> Rebuild
                </button>
              )}
            </p>
            <div>
              <p className="hud-label mb-1">Never look into</p>
              {s.map.excluded.length === 0 && <p className="text-xs text-muted">Nothing excluded.</p>}
              <ul className="space-y-0.5">
                {s.map.excluded.map(p => (
                  <li key={p} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-mono" title={p}>
                      {p}
                    </span>
                    <button type="button" className="text-muted hover:text-danger" onClick={() => void act(() => window.pc.removeExcluded(p))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn mt-1.5 h-7 gap-1 px-2 text-xs" onClick={() => void act(() => window.pc.addExcluded())}>
                <FolderX className="size-3.5" aria-hidden /> Add a folder to skip
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
