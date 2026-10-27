import { Bell, Feather, MonitorUp, Palette } from 'lucide-react'
import { useState } from 'react'
import { noticesOn, setNotices } from './shell/attention.ts'
import { WidgetCard } from './shell/WidgetCard.tsx'
import { ACCENTS, THEME_LABEL, THEMES, useAppearance, type Accent, type LiteChoice, type ThemeName } from './theme.ts'
import { nameOf } from './ui/assistantName.ts'
import { SoundSettings } from './voice/SoundSettings.tsx'
import { onMac, os } from './ui/host.ts'

const SWATCH: Record<Exclude<Accent, 'theme'>, string> = { cyan: '#22d3ee', blue: '#60a5fa', violet: '#a78bfa', emerald: '#34d399', amber: '#fbbf24', rose: '#fb7185' }
const PREVIEW: Record<Exclude<ThemeName, 'system'>, { bg: string; card: string; accent: string }> = {
  midnight: { bg: '#050a16', card: '#0f1a2e', accent: '#22d3ee' },
  graphite: { bg: '#0d0f12', card: '#1a1d22', accent: '#60a5fa' },
  aurora: { bg: '#070816', card: '#1a1438', accent: '#a78bfa' },
  daylight: { bg: '#f4f7fb', card: '#ffffff', accent: '#0891b2' },
}

/** Settings › Appearance: theme, accent and Lite mode, applied instantly and remembered on this computer. */
export function AppearanceSettings() {
  const [a, set] = useAppearance()
  return (
    <div className="mx-auto max-w-2xl space-y-5 p-3">
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 font-medium">
          <Palette className="size-4 text-accent" aria-hidden /> Theme
        </h3>
        <div className="grid grid-cols-2 gap-2 @md:grid-cols-3" role="radiogroup" aria-label="Theme">
          {THEMES.map(t => {
            const p = PREVIEW[t === 'system' ? 'midnight' : t]
            const selected = a.theme === t
            return (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => set({ theme: t })}
                className={`tile overflow-hidden text-left transition-colors ${selected ? 'border-accent ring-2 ring-accent/40' : 'hover:border-edge'}`}
              >
                <div className="flex h-14 items-end gap-1.5 p-2" style={{ background: t === 'system' ? `linear-gradient(90deg, ${PREVIEW.midnight.bg} 50%, ${PREVIEW.daylight.bg} 50%)` : p.bg }}>
                  <span className="h-7 w-10 rounded-md" style={{ background: p.card }} />
                  <span className="h-4 w-8 rounded-md" style={{ background: p.card }} />
                  <span className="ml-auto size-3 rounded-full" style={{ background: p.accent }} />
                </div>
                <p className="px-2 py-1.5 text-xs">{THEME_LABEL[t]}</p>
              </button>
            )
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">Accent colour</h3>
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map(c => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={a.accent === c}
              aria-label={c === 'theme' ? 'The theme’s own accent' : c}
              title={c === 'theme' ? 'The theme’s own accent' : c}
              onClick={() => set({ accent: c })}
              className={`grid size-8 place-items-center rounded-full border transition-transform ${a.accent === c ? 'scale-110 border-text' : 'border-border hover:scale-105'}`}
              style={{ background: c === 'theme' ? 'conic-gradient(#22d3ee, #a78bfa, #34d399, #fbbf24, #22d3ee)' : SWATCH[c] }}
            >
              {c === 'theme' && <span className="size-3 rounded-full bg-solid" />}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Feather className="size-4 text-accent" aria-hidden /> Lite mode
        </h3>
        <p className="text-xs text-muted">Turns off glass blur, drifting light and animations so Atlas stays light on modest computers. Automatic switches it on for 4 or fewer CPU threads, 4 GB or less memory, or when Windows asks for less motion or transparency.</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Lite mode">
          {(['auto', 'on', 'off'] as LiteChoice[]).map(l => (
            <button key={l} type="button" role="radio" aria-checked={a.lite === l} onClick={() => set({ lite: l })} className={`btn ${a.lite === l ? 'border-accent text-accent' : ''}`}>
              {l === 'auto' ? 'Automatic' : l === 'on' ? 'Always on' : 'Off'}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted">Now: {document.documentElement.dataset.lite === 'true' ? 'Lite (light on the machine)' : 'Full effects'}</p>
      </section>

      <SoundSettings />

      <section className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <MonitorUp className="size-4 text-accent" aria-hidden /> {nameOf()} on the desktop
        </h3>
        <p className="text-xs text-muted">
          {onMac()
            ? `On a Mac, ${nameOf()}'s menu-bar icon, its notices while no page is open and its shortcuts from anywhere come with the Mac helper, which is on its way. Until then ${nameOf()} lives in this page.`
            : `${nameOf()} keeps a small icon in the Windows tray: click it to open ${nameOf()} here, right-click it for modes, pausing and quitting. Its notices (reminders, approvals) come from there while no page is open, and Ctrl+Alt+Space talks from anywhere (Ctrl+Alt+/ shows every shortcut).`}
        </p>
      </section>

      <WidgetCard />

      <BrowserNotices />
    </div>
  )
}

/** Browser notices: they bring this tab back when Atlas speaks up or is asked for while the tab is out of sight. */
function BrowserNotices() {
  const supported = typeof Notification !== 'undefined'
  const [on, setOn] = useState(noticesOn)
  const [note, setNote] = useState('')
  if (!supported) return null
  const change = async (want: boolean) => {
    const ok = await setNotices(want)
    setOn(want && ok)
    setNote(want && !ok ? 'The browser blocked notices for this page: allow them from the lock icon beside the address.' : '')
  }
  return (
    <section className="space-y-2">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={on} onChange={e => void change(e.target.checked)} />
        <span>
          <span className="flex items-center gap-1.5 font-medium">
            <Bell className="size-4 text-accent" aria-hidden /> Notices from the browser
          </span>
          <span className="block text-xs text-muted">
            When this tab is behind other windows and {nameOf()} speaks up, or you ask for {nameOf()} from the tray or a shortcut, a notice shows; clicking it brings this tab back. No second tab is ever opened while one is open.
          </span>
          {note && <span className="mt-1 block text-xs text-warm">{note}</span>}
        </span>
      </label>
    </section>
  )
}
